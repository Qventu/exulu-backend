import { ExuluTokenizer } from "../tokenizer.ts";
import { checkLicense } from "../entitlements";

type CurrentHeaders = {
    h1?: {
        text?: string
        current: boolean
    };
    h2?: {
        text?: string
        current: boolean
    };
    h3?: {
        text?: string
        current: boolean
    };
    h4?: {
        text?: string
        current: boolean
    };
    h5?: {
        text?: string
        current: boolean
    };
    h6?: {
        text?: string
        current: boolean
    };
}

/**
 * Header information extracted from text
 */
interface ExtractedHeaderInfo {
    level: number; // 1-6 for h1-h6
    text: string;
    position: number;
}

const extractPageTag = (text: string): number | undefined => {
    let match: RegExpExecArray | null;
    let lastPageNumber: number | undefined = undefined;

    // Format 1: <!-- PAGE_BREAK_123 --> (converted from <page_break> tags)
    const pageBreakCommentRegex = /<!--\s*PAGE_BREAK_(\d+)\s*-->/gi;
    while ((match = pageBreakCommentRegex.exec(text)) !== null) {
        lastPageNumber = parseInt(match[1]!);
    }
    if (lastPageNumber !== undefined) {
        return lastPageNumber;
    }

    // Format 2: <page_break page=123> (original format, if still present)
    const pageTagRegex = /<page_break page=(\d+)>/gi;
    if ((match = pageTagRegex.exec(text)) !== null) {
        return parseInt(match[1]!);
    }

    return undefined;
}

const extractHeaders = (text: string): ExtractedHeaderInfo[] => {
    const headers: ExtractedHeaderInfo[] = [];

    // Match HTML headers: <h1>...</h1>, <h2>...</h2>, etc.
    const htmlHeaderRegex = /<h([1-6])[^>]*>(.*?)<\/h\1>/gi;
    let match: RegExpExecArray | null;

    while ((match = htmlHeaderRegex.exec(text)) !== null) {
        headers.push({
            level: parseInt(match[1]!),
            text: match[2]!.trim(),
            position: match.index,
        });
    }

    // Match Markdown headers: #, ##, ###, etc.
    const markdownHeaderRegex = /^(#{1,6})\s+(.+)$/gm;

    while ((match = markdownHeaderRegex.exec(text)) !== null) {
        headers.push({
            level: match[1]!.length,
            text: match[2]!.trim(),
            position: match.index,
        });
    }

    // Sort by position
    return headers.sort((a, b) => a.position - b.position);
}

export class MarkdownChunker {
    private readonly _CHARS_PER_TOKEN: number = 6.5;

    constructor() {
        const license = checkLicense()
        if (!license["advanced-markdown-chunker"]) {
            console.warn(`[EXULU] You are not licensed to use the advanced markdown chunker.`);
        }
    }

    /**
     * Converts markdown tables to LLM-friendly numbered list format.
     * Example:
     * | First name | Last name | Age |
     * | -------- | -------- | -------- |
     * | John     | Doe      | 30      |
     * | Jane     | Smith    | 25      |
     *
     * Becomes:
     * 1. First name: John, Last name: Doe, Age: 30
     * 2. First name: Jane, Last name: Smith, Age: 25
     *
     * Handles malformed tables gracefully by validating structure and skipping invalid tables.
     */
    public convertTablesToText(text: string): string {
        /**
         * Helper to count pipe-separated cells in a row
         */
        const countCells = (row: string): number => {
            return row.split('|').filter(c => c.trim().length > 0).length;
        };

        /**
         * Helper to check if a table is valid (all rows have consistent cell counts)
         */
        const isValidTable = (headerRow: string, dataRows: string): boolean => {
            const headerCellCount = countCells(headerRow);
            if (headerCellCount === 0) return false;

            const rows = dataRows.trim().split(/\n/).filter(r => r.trim().length > 0 && r.includes('|'));

            // Allow some flexibility - rows can have fewer cells but not more
            for (const row of rows) {
                const cellCount = countCells(row);
                if (cellCount === 0 || cellCount > headerCellCount + 1) {
                    return false;
                }
            }

            return true;
        };
        let lastHeaders: string[] | null = null;
        let rowCounter = 0;

        /**
         * Heuristic to detect if a row looks like data rather than headers.
         * Returns true if the first cell looks like a row number or data value.
         */
        const looksLikeDataRow = (row: string): boolean => {
            const cells = row.split('|').map(c => c.trim()).filter(c => c.length > 0);
            if (cells.length === 0) return false;

            const firstCell = cells[0];
            if (!firstCell) return false;
            // Check if first cell is a number, code (like P1, P2), or starts with a number
            return /^\d+$/.test(firstCell) || /^[A-Z]?\d+/.test(firstCell);
        };

        // First pass: Find tables with separators (new tables with headers)
        const tableWithSeparatorRegex = /^(\|?.+\|.+\|?)\s*\n(\|?[\s:|-]+\|[\s:|-]+\|?)\s*\n((?:\|?.+\|.+\|?(?:\s*\n|$))+)/gm;

        // Second pass: Find table continuations (tables without separator rows)
        const tableContinuationRegex = /^(\|?.+\|.+\|?)(?:\s*\n(?!\|?[\s:|-]+\|[\s:|-]+\|?))((?:\n\|?.+\|.+\|?)+)/gm;

        // Track positions of all tables to handle them in order
        const tableMatches: Array<{
            start: number;
            end: number;
            match: string;
            hasHeaderRow: boolean;
            headerRow?: string;
            separatorRow?: string;
            dataRows: string;
        }> = [];

        // Find all tables with separators
        let match;
        while ((match = tableWithSeparatorRegex.exec(text)) !== null) {
            tableMatches.push({
                start: match.index,
                end: match.index + match[0].length,
                match: match[0],
                hasHeaderRow: true,
                headerRow: match[1],
                separatorRow: match[2],
                dataRows: match[3]
            });
        }

        // Find all table continuations (without separator)
        tableContinuationRegex.lastIndex = 0;
        while ((match = tableContinuationRegex.exec(text)) !== null) {
            // Check if this position is already covered by a table with separator
            const isAlreadyCovered = tableMatches.some(
                tm => match!.index >= tm.start && match!.index < tm.end
            );

            if (!isAlreadyCovered) {
                tableMatches.push({
                    start: match.index,
                    end: match.index + match[0].length,
                    match: match[0],
                    hasHeaderRow: false,
                    dataRows: match[1] + match[2]
                });
            }
        }

        // Sort by position
        tableMatches.sort((a, b) => a.start - b.start);

        // Process tables in order and build result
        let result = text;
        let offset = 0;

        tableMatches.forEach((tableMatch) => {
            let headers: string[];
            let rows: string[];
            let convertedText: string;

            if (tableMatch.hasHeaderRow) {
                // Validate table structure before processing
                if (!isValidTable(tableMatch.headerRow!, tableMatch.dataRows!)) {
                    // Skip this malformed table - leave it as original markdown
                    return;
                }

                // Check if the "header row" actually looks like data
                const possibleHeaderRow = tableMatch.headerRow!;

                if (looksLikeDataRow(possibleHeaderRow) && lastHeaders) {
                    // This is actually a continuation table with a separator
                    // Treat the "header row" as a data row
                    headers = lastHeaders;

                    rows = (possibleHeaderRow + '\n' + tableMatch.dataRows)
                        .trim()
                        .split(/\n/)
                        .map((row: string) => row.trim())
                        .filter((row: string) => row.length > 0 && row.includes('|'));
                } else {
                    // New table with real headers
                    headers = possibleHeaderRow
                        .split('|')
                        .map((h: string) => h.trim().replace(/^:+|:+$/g, ''))
                        .filter((h: string) => h.length > 0);

                    lastHeaders = headers;
                    rowCounter = 0;

                    rows = tableMatch.dataRows
                        .trim()
                        .split(/\n/)
                        .map((row: string) => row.trim())
                        .filter((row: string) => row.length > 0 && row.includes('|'));
                }
            } else {
                // Continuation table - use last headers
                if (!lastHeaders) {
                    return; // Skip if we don't have headers from a previous table
                }

                headers = lastHeaders;

                rows = tableMatch.dataRows
                    .trim()
                    .split(/\n/)
                    .map((row: string) => row.trim())
                    .filter((row: string) => row.length > 0 && row.includes('|'));
            }

            if (headers.length === 0 || rows.length === 0) {
                return;
            }

            const convertedRows: string[] = [];

            rows.forEach((row: string) => {
                const cells = row
                    .split('|')
                    .map((c: string) => c.trim())
                    .filter((c: string) => c.length > 0);

                if (cells.length === 0) {
                    return;
                }

                rowCounter++;

                // Create "Header: Value" pairs
                const pairs: string[] = [];
                for (let i = 0; i < Math.min(headers.length, cells.length); i++) {
                    pairs.push(`${headers[i]}: ${cells[i]}`);
                }

                // Add as numbered list item with continuous numbering
                convertedRows.push(`${rowCounter}. ${pairs.join(', ')}`);
            });

            convertedText = '\n' + convertedRows.join('\n') + '\n\n';

            // Replace in result
            const adjustedStart = tableMatch.start + offset;
            const adjustedEnd = tableMatch.end + offset;
            result = result.substring(0, adjustedStart) + convertedText + result.substring(adjustedEnd);
            offset += convertedText.length - (tableMatch.end - tableMatch.start);
        });

        return result;
    }

    /**
     * Checks if a position in the text falls within a <diagram> tag.
     * Returns the adjusted position (before the diagram) if inside a diagram, otherwise returns the original position.
     */
    private adjustForDiagramTags(text: string, position: number): number {
        // Find all diagram tags in the text
        const diagramRegex = /<diagram>[\s\S]*?<\/diagram>/gi;
        let match: RegExpExecArray | null;

        while ((match = diagramRegex.exec(text)) !== null) {
            const diagramStart = match.index;
            const diagramEnd = match.index + match[0].length;

            // If the position falls within a diagram tag, return the position before the diagram
            if (position > diagramStart && position < diagramEnd) {
                return diagramStart;
            }
        }

        return position;
    }

    /**
     * Find the nearest logical breakpoint working backwards from the end of the text.
     * Logical breakpoints are prioritized as follows:
     * 1. Before markdown headers (##) or HTML headers (<h1>-<h6>)
     * 2. Paragraph breaks (double newlines)
     * 3. Single newlines after list items or content
     * 4. End of sentences (. ! ? followed by space)
     * 5. Any whitespace
     *
     * Only considers breakpoints in the last 50% of the text to avoid creating very small chunks.
     * Returns the position of the breakpoint, or null if none found
     * IMPORTANT: Never splits content within <diagram> tags
     */
    private findLogicalBreakpoint(text: string): number | null {
        if (text.length === 0) return null;

        // Only look for breakpoints in the latter half to avoid tiny chunks
        const minPosition = Math.floor(text.length * 0.5);

        // Priority 1: Find the LAST header in the text (highest priority)
        let lastHeaderPosition = -1;

        // Check for markdown headers: \n## Header or \n### Header
        const markdownHeaderRegex = /\n(#{1,6})\s+/g;
        let match: RegExpExecArray | null;
        while ((match = markdownHeaderRegex.exec(text)) !== null) {
            if (match.index >= minPosition) {
                lastHeaderPosition = Math.max(lastHeaderPosition, match.index);
            }
        }

        // Check for HTML headers: \n<h1> through \n<h6>
        const htmlHeaderRegex = /\n<h[1-6][^>]*>/g;
        while ((match = htmlHeaderRegex.exec(text)) !== null) {
            if (match.index >= minPosition) {
                lastHeaderPosition = Math.max(lastHeaderPosition, match.index);
            }
        }

        if (lastHeaderPosition > 0) {
            // Ensure we don't break inside a diagram tag
            return this.adjustForDiagramTags(text, lastHeaderPosition);
        }

        // Priority 2: Look for paragraph breaks (double newlines) in the latter half
        let lastParagraphBreak = -1;
        let searchPos = text.length;
        while (searchPos > minPosition) {
            const pos = text.lastIndexOf('\n\n', searchPos - 1);
            if (pos >= minPosition) {
                lastParagraphBreak = pos;
                break;
            }
            searchPos = pos;
        }

        if (lastParagraphBreak > 0) {
            // Ensure we don't break inside a diagram tag
            const adjusted = this.adjustForDiagramTags(text, lastParagraphBreak + 2);
            return adjusted;
        }

        // Priority 3: Look for single newlines in the latter half
        const newlineIndex = text.lastIndexOf('\n');
        if (newlineIndex >= minPosition) {
            // Ensure we don't break inside a diagram tag
            return this.adjustForDiagramTags(text, newlineIndex + 1);
        }

        // Priority 4: Look for end of sentence (. ! ? followed by space or newline)
        const sentenceEndRegex = /[.!?](?:\s|$)/g;
        let lastSentenceEnd = -1;

        while ((match = sentenceEndRegex.exec(text)) !== null) {
            if (match.index >= minPosition) {
                lastSentenceEnd = match.index + match[0].length;
            }
        }

        if (lastSentenceEnd > 0) {
            // Ensure we don't break inside a diagram tag
            return this.adjustForDiagramTags(text, lastSentenceEnd);
        }

        // Priority 5: Look for any whitespace in the latter half
        let lastSpace = text.length;
        while (lastSpace > minPosition) {
            const pos = text.lastIndexOf(' ', lastSpace - 1);
            if (pos >= minPosition) {
                // Ensure we don't break inside a diagram tag
                return this.adjustForDiagramTags(text, pos + 1);
            }
            lastSpace = pos;
        }

        // No logical breakpoint found in acceptable range
        return null;
    }

    private headers(text: string, current: CurrentHeaders): CurrentHeaders {

        const extractedHeaders = extractHeaders(text);

        // Find the LAST occurrence of each header level in this text
        const h1 = extractedHeaders.reverse().find((h) => h.level === 1);
        const h2 = extractedHeaders.find((h) => h.level === 2);
        const h3 = extractedHeaders.find((h) => h.level === 3);
        const h4 = extractedHeaders.find((h) => h.level === 4);
        const h5 = extractedHeaders.find((h) => h.level === 5);
        const h6 = extractedHeaders.find((h) => h.level === 6);
        extractedHeaders.reverse(); // Restore original order

        // Build the new header state
        // Start with the current state and update with any new headers found
        const newHeaders: CurrentHeaders = { ...current };

        if (newHeaders.h1) {
            newHeaders.h1.current = false
        }
        if (newHeaders.h2) {
            newHeaders.h2.current = false
        }
        if (newHeaders.h3) {
            newHeaders.h3.current = false
        }
        if (newHeaders.h4) {
            newHeaders.h4.current = false
        }
        if (newHeaders.h5) {
            newHeaders.h5.current = false
        }
        if (newHeaders.h6) {
            newHeaders.h6.current = false
        }
        // Update h1 if found, mark as current
        if (h1) {
            newHeaders.h1 = { text: h1.text, current: true };
            // When a new h1 is found, clear all lower levels
            newHeaders.h2 = undefined;
            newHeaders.h3 = undefined;
            newHeaders.h4 = undefined;
            newHeaders.h5 = undefined;
            newHeaders.h6 = undefined;
        }

        // Update h2 if found
        if (h2) {
            newHeaders.h2 = { text: h2.text, current: true };
            // Clear lower levels when h2 is found
            newHeaders.h3 = undefined;
            newHeaders.h4 = undefined;
            newHeaders.h5 = undefined;
            newHeaders.h6 = undefined;
        }

        // Update h3 if found
        if (h3) {
            newHeaders.h3 = { text: h3.text, current: true };
            newHeaders.h4 = undefined;
            newHeaders.h5 = undefined;
            newHeaders.h6 = undefined;
        }

        // Update h4 if found
        if (h4) {
            newHeaders.h4 = { text: h4.text, current: true };
            newHeaders.h5 = undefined;
            newHeaders.h6 = undefined;
        }

        // Update h5 if found
        if (h5) {
            newHeaders.h5 = { text: h5.text, current: true };
            newHeaders.h6 = undefined;
        }

        // Update h6 if found
        if (h6) {
            newHeaders.h6 = { text: h6.text, current: true };
        }

        return newHeaders;
    }

    public async chunk(text: string, chunkSize: number, prefix?: string, config?: {
        pageBreakTags?: boolean;
    }): Promise<{
        text: string;
        page: number;
    }[]> {
        // Handle page break tags by converting them to comments
        // We'll handle table continuations separately
        text = text.replace(/<page_break page=(\d+)>/gi, (match, pageNum) => {
            return `\n<!-- PAGE_BREAK_${pageNum} -->\n`;
        });

        // Merge continuation tables that appear after page breaks
        // A continuation table is one that starts immediately after a page break
        // with a row that has empty first cells (indicating it's continuing a previous row)
        text = text.replace(/(\|[^\n]+\|)\n+<!--\s*PAGE_BREAK_\d+\s*-->\n+(\|\s*\|\s*\|\s*\|[^\n]+\|)/g, (match, lastRow, contRow) => {
            // Merge the rows by removing page break and joining the content
            return lastRow + ' ' + contRow;
        });

        // First we identify any tables in the markdown
        // and convert them to LLM friendly text format.
        text = this.convertTablesToText(text);

        const tokenizer = new ExuluTokenizer();
        await tokenizer.create("gpt-5");

        if (prefix) {
            const prefixTokens = await tokenizer.countTokens(prefix);
            chunkSize -= prefixTokens;

            if (chunkSize <= 0) {
                throw new Error("Chunk size is too small to contain the prefix.");
            }
        }

        // Starting from the first character, extract a part of the content between the starting index
        // 0 and the index at the estimated end of the chunk (character). Then find the nearest logical
        // breakpoint near the end of the slice (i.e. a heading or a paragraph break). If no logical
        // breakpoint is found just use the slice.
        let currentPosition = 0;
        let targetPosition = chunkSize * this._CHARS_PER_TOKEN;
        let headers: CurrentHeaders = {};
        // todo first clean excesive whitespace
        let contentLeft = text.length;
        let currentPage = 1;
        let chunks: {
            text: string;
            page: number
            index: number
            tokens: number
        }[] = [];

        let iterations = 0;
        while (contentLeft > 5) {
            iterations++;
            // todo roadmap allow for chunk overlaps
            let currentSlice = text.slice(currentPosition, targetPosition);

            // we check if the new slice directly starts with a header
            headers = this.headers(currentSlice.slice(0, 50), headers);

            // Build header prefix with proper markdown formatting
            // We only include headers that are not already in the current slice
            const headerPrefixParts: string[] = [];
            if (headers.h1 && !headers.h1.current) {
                headerPrefixParts.push(`# ${headers.h1.text}`);
            }
            if (headers.h2 && !headers.h2.current) {
                headerPrefixParts.push(`## ${headers.h2.text}`);
            }
            if (headers.h3 && !headers.h3.current) {
                headerPrefixParts.push(`### ${headers.h3.text}`);
            }
            if (headers.h4 && !headers.h4.current) {
                headerPrefixParts.push(`#### ${headers.h4.text}`);
            }
            if (headers.h5 && !headers.h5.current) {
                headerPrefixParts.push(`##### ${headers.h5.text}`);
            }
            if (headers.h6 && !headers.h6.current) {
                headerPrefixParts.push(`###### ${headers.h6.text}`);
            }
            const headerPrefixText = headerPrefixParts.join("\n")

            const headerTokens = await tokenizer.countTokens(headerPrefixText);
            const adjustedChunkSize = chunkSize - headerTokens;
            if (adjustedChunkSize <= 0) {
                throw new Error("Chunk size is too small to contain the header prefixes.");
            }
            // Check token count, if more than the chunk size, we need to shorten
            // the slice.
            const tokens = tokenizer.encode(currentSlice);
            if (tokens.length > adjustedChunkSize) {
                // Decode only the tokens that fit within the adjusted chunk size
                const decoded = await tokenizer.decode(tokens.slice(0, adjustedChunkSize));
                if (decoded && decoded.length > 0) {
                    // Update the slice to only include the decoded content
                    currentSlice = decoded;
                    targetPosition = currentPosition + decoded.length;
                }
            }

            // Check if the current slice ends in the middle of a diagram tag
            // If so, we need to adjust to include the entire diagram or exclude it entirely
            const diagramCheck = /<diagram>/gi;
            const diagramCloseCheck = /<\/diagram>/gi;
            let openDiagramsInSlice = 0;

            while (diagramCheck.exec(currentSlice) !== null) {
                openDiagramsInSlice++;
            }

            let closeDiagramsInSlice = 0;
            while (diagramCloseCheck.exec(currentSlice) !== null) {
                closeDiagramsInSlice++;
            }

            // If we have more opening tags than closing tags, we're cutting a diagram in half
            if (openDiagramsInSlice > closeDiagramsInSlice) {
                // Find the last opening diagram tag in the slice
                const lastDiagramOpenIndex = currentSlice.lastIndexOf('<diagram>');
                if (lastDiagramOpenIndex !== -1) {
                    // Try to extend the slice to include the closing tag
                    const remainingText = text.slice(currentPosition + lastDiagramOpenIndex);
                    const closingTagMatch = /<\/diagram>/i.exec(remainingText);

                    if (closingTagMatch) {
                        const closingTagPosition = lastDiagramOpenIndex + closingTagMatch.index + closingTagMatch[0].length;

                        // Check if including the full diagram would still be reasonable
                        // If the diagram is massive, we'll exclude it from this chunk instead
                        const extendedSlice = text.slice(currentPosition, currentPosition + closingTagPosition);
                        const extendedTokens = tokenizer.encode(extendedSlice);

                        if (extendedTokens.length <= adjustedChunkSize * 1.5) {
                            // Include the full diagram in this chunk
                            currentSlice = extendedSlice;
                            targetPosition = currentPosition + closingTagPosition;
                        } else {
                            // Diagram is too large, exclude it from this chunk
                            currentSlice = currentSlice.slice(0, lastDiagramOpenIndex);
                            targetPosition = currentPosition + lastDiagramOpenIndex;
                        }
                    } else {
                        // Closing tag not found, exclude the opening tag from this chunk
                        currentSlice = currentSlice.slice(0, lastDiagramOpenIndex);
                        targetPosition = currentPosition + lastDiagramOpenIndex;
                    }
                }
            }

            // Working backwards from the target position find the nearest logical
            // breakpoint near the end of the slice (i.e. a heading or a paragraph break).
            const breakpointPosition = this.findLogicalBreakpoint(currentSlice);
            if (breakpointPosition !== null) {
                // Adjust the current slice to the breakpoint position
                // and adjust the target position to the breakpoint position
                currentSlice = currentSlice.slice(0, breakpointPosition);
                targetPosition = currentPosition + breakpointPosition;
            }

            // Only add non-empty chunks
            if (currentSlice.length > 0) {
                // Prepend header context if there are headers not already in the current slice
                let finalText = currentSlice;
                if (headerPrefixText.length > 0) {
                    finalText = headerPrefixText + '\n\n' + currentSlice;
                }

                if (currentPage && config?.pageBreakTags) {
                    finalText = `<!-- Current page: ${currentPage} -->\n\n` + finalText;
                }

                if (prefix) {
                    finalText = prefix + '\n\n' + finalText;
                }

                chunks.push({
                    text: finalText,
                    page: currentPage,
                    index: iterations,
                    tokens: await tokenizer.countTokens(finalText)
                });
            }

            currentPage = extractPageTag(currentSlice) || currentPage;

            // On purpose we only get the headers after the first
            // iteration, as current headers are already in the slice.
            headers = this.headers(currentSlice, headers);

            // Wrap up, update the current position and target position
            // for the next iteration of the while loop.
            contentLeft -= currentSlice.length;
            currentPosition = targetPosition;
            targetPosition = currentPosition + (chunkSize * this._CHARS_PER_TOKEN);
            // Safety check to prevent infinite loops
            if (currentSlice.length === 0) {
                currentPosition++;
                targetPosition = currentPosition + (chunkSize * this._CHARS_PER_TOKEN);
                contentLeft = text.length - currentPosition;
            }
        }

        // Go through each chunk, and if adjacent chunks have less than
        // the chunkSize, merge them. Use a greedy approach to merge as many
        // consecutive chunks as possible.
        const mergedChunks: typeof chunks = [];
        let i = 0;

        while (i < chunks.length) {
            let currentChunk = chunks[i]!;
            let combinedText = currentChunk.text;
            let combinedTokens = currentChunk.tokens;
            let chunksConsumed = 1;

            // Keep looking ahead and merging as long as we can fit more chunks
            while (i + chunksConsumed < chunks.length) {
                const nextChunk = chunks[i + chunksConsumed]!;
                const potentialTokens = combinedTokens + nextChunk.tokens;

                // If adding the next chunk would exceed the limit, stop merging
                if (potentialTokens > chunkSize) {
                    break;
                }

                // Merge the next chunk
                combinedText += nextChunk.text;
                combinedTokens = potentialTokens;
                chunksConsumed++;
            }

            // Add the merged chunk (or original chunk if no merging occurred)
            mergedChunks.push({
                text: combinedText,
                page: currentChunk.page, // Use the page number of the first chunk
                index: currentChunk.index,
                tokens: combinedTokens
            });

            // Move past all consumed chunks
            i += chunksConsumed;
        }

        return mergedChunks;

    }
}