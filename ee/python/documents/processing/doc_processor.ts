import * as fs from 'fs';
import * as path from 'path';
import { generateText, Output } from 'ai';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import pLimit from 'p-limit';
import { randomUUID } from 'crypto';
import { withRetry } from '@SRC/utils/with-retry';
import * as mammoth from 'mammoth';
import TurndownService from 'turndown';
import WordExtractor from 'word-extractor';
import { parseOfficeAsync } from "officeparser";
import { checkLicense } from '@EE/entitlements';
import { executePythonScript } from '@SRC/utils/python-executor';
import { setupPythonEnvironment, validatePythonEnvironment } from '@SRC/utils/python-setup';
import { LiteParse } from '@llamaindex/liteparse';
import { Mistral } from '@mistralai/mistralai';
import { ExuluVariables } from '@SRC/index';

type DocumentProcessorConfig = {
  vlm?: {
    model: LanguageModel;
    concurrency: number;
  },
  processor: {
    name: "docling" | "liteparse" | "mistral" | "officeparser"
  }
  debugging?: {
    deleteTempFiles?: boolean;
  }
}

type ProcessedPage = {
  page: number;
  content: string;
  headings?: any;
  image?: string;
  vlm_corrected_text?: string;
  vlm_validated?: boolean;
}
type ProcessedDocument = ProcessedPage[];

type ProcessorOutput = {
  markdown: string,
  json: ProcessedDocument
}

interface VLMValidationResult {
  needs_correction: boolean;
  corrected_text?: string;
  confidence: 'high' | 'medium' | 'low';
  current_page_table?: {
    headers: string[];
    is_continuation: boolean; // true if this table appears to be missing headers
  }
  reasoning: string;
}

async function processDocx(file: Buffer): Promise<ProcessorOutput> {
  const html = await mammoth.convertToHtml({ buffer: file });
  const turndownService = new TurndownService();
  let markdown = turndownService.turndown(html.value);

  // Filter out data:image/ base64 encoded images
  markdown = markdown.replace(/!\[.*?\]\(data:image\/[^)]+\)/g, '');

  // Todo figure out a way to preserver pages
  return {
    json: [{
      page: 1,
      content: markdown,
      headings: [],
    }],
    markdown: markdown,
  };
}

async function processWord(file: Buffer): Promise<ProcessorOutput> {
  const extractor = new WordExtractor();
  const extracted = await extractor.extract(file);
  let content = extracted.getBody();

  // Filter out data:image/ base64 encoded images
  content = content.replace(/!\[.*?\]\(data:image\/[^)]+\)/g, '');

  // Todo figure out a way to preserver pages
  return {
    json: [{
      page: 1,
      content: content,
      headings: [],
    }],
    markdown: content,
  }
}

/**
 * Normalizes markdown content by removing excessive whitespace,
 * especially in table formatting.
 */
function normalizeMarkdownContent(content: string): string {
  const lines = content.split('\n');
  const normalizedLines: string[] = [];

  for (const line of lines) {
    // Check if this is a table row (contains |)
    if (line.includes('|')) {
      // Split by | and strip whitespace from each cell
      const parts = line.split('|');
      const cleanedParts = parts.map(part => part.trim());
      // Rejoin with single space padding
      const normalizedLine = cleanedParts.join(' | ');
      normalizedLines.push(normalizedLine);
    } else {
      // For non-table lines, just strip trailing whitespace
      normalizedLines.push(line.trimEnd());
    }
  }

  return normalizedLines.join('\n');
}

/**
 * Reconstructs markdown headings in corrected text based on the headings hierarchy
 */
function reconstructHeadings(
  correctedText: string,
  headingsHierarchy: any
): string {
  if (!headingsHierarchy || typeof headingsHierarchy !== 'object') {
    return correctedText;
  }

  let result = correctedText;

  // Recursive function to extract all headings with their levels
  function extractHeadingsWithLevels(
    hierarchy: any,
    level: number = 2
  ): Array<{ text: string; level: number }> {
    const headings: Array<{ text: string; level: number }> = [];

    for (const [key, value] of Object.entries(hierarchy)) {
      headings.push({ text: key, level });

      if (value && typeof value === 'object') {
        headings.push(...extractHeadingsWithLevels(value, level + 1));
      }
    }

    return headings;
  }

  const headings = extractHeadingsWithLevels(headingsHierarchy);

  // For each heading, find it in the corrected text and add markdown markers
  for (const { text, level } of headings) {
    const markdownPrefix = '#'.repeat(level);
    const escapedText = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Look for the heading text at the start of a line without markdown markers
    const regex = new RegExp(
      `^(${escapedText})$`,
      'gm'
    );

    result = result.replace(regex, `${markdownPrefix} $1`);
  }

  return result;
}

/**
 * Validates and potentially corrects all chunks from a page using VLM
 */
async function validatePageWithVLM(
  page: ProcessedPage,
  imagePath: string,
  model: LanguageModel
): Promise<VLMValidationResult> {
  // Read the image as base64
  const imageBuffer = await fs.promises.readFile(imagePath);
  const imageBase64 = imageBuffer.toString('base64');
  const mimeType = 'image/png';

  const prompt = `You are a document validation assistant. Your task is to analyze a page image and correct the output of an OCR/parsing pipeline. The content may include tables, technical diagrams, schematics, and structured text.

---
## CURRENT OCR OUTPUT

${page.content}
---

## YOUR TASK

Compare the page image to the OCR output above. Identify errors, omissions, and formatting issues, then return a structured validation result (see OUTPUT FORMAT below).

---
## VALIDATION CHECKLIST

Work through these checks in order:

### 1. Text Accuracy
- Verify all text is correctly transcribed.
- For minor character-level OCR errors (e.g. "ö" vs "ü", "rn" vs "m"), **prefer the original OCR output** unless you are certain of an error. Do not silently "fix" characters based on guesswork.

### 2. Heading Levels
- Verify that headings use correct Markdown levels (#, ##, ###, ####, #####, ######).
- Determine heading level using the following priority:
  1. **Hierarchical numbering** (strongest signal): e.g. "1" → #, "2.1" → ##, "2.1.1" → ###, "2.1.2.5" → ####
  2. Font size (larger = higher level)
  3. Indentation
  4. Bold/emphasis styling

### 3. Tables

**First, decide whether the table should be Markdown or plain text:**
- Use **Markdown table format** if the table has a consistent, clear header structure and uniform column layout throughout.
- Use **plain text structured description** if the table:
  - Lacks a clear header row
  - Uses mixed or irregular column structures across rows
  - Functions more like a certificate, form, or label layout

**If using Markdown format**, follow these rules strictly:
- Every table must have: header row → separator row → data rows
- Use simple separators only: \`| --- | --- |\` (NOT \`|---|---|\` or long dashes)
- Example:
  \`\`\`
  | Column 1 | Column 2 |
  | --- | --- |
  | Data 1   | Data 2   |
  \`\`\`
- Important: do not use the | character as part of the data inside a cell, this would break the table, if a cell contains a | character, use a capital I.

**Symbol translation rules for table cells:**
- Black/filled dot → \`+\` (active); White/empty dot → \`-\` (inactive)  
  *(e.g. Rufe-LED columns)*
- Green or black checkmark → \`+\` (active); Red or black cross → \`-\` (inactive)

### 4. Multi-Page Table Continuity
- If this page contains a table with a header row that runs to the bottom of the page (suggesting it may continue on the next page), extract the header row and include it in the \`current_page_table.headers\` field.
- If this page contains a table WITHOUT a header row (suggesting it's a continuation from a previous page), set \`current_page_table.is_continuation\` to true and try to identify what the headers might be based on the data structure. Include your best guess for headers in \`current_page_table.headers\`.

### 5. Technical Diagrams & Schematics
If the page contains a flow-chart, schematic, technical drawing or control board layout that is **absent or poorly described** in the OCR output do the following:
- Open a <diagram> tag with the following content:
  <diagram>
    <description>
      Add a detailed description of the diagram here.
    </description>
    <mermaid>
      Add a mermaid diagram schema here that in detail describes the diagram.
    </mermaid>
  </diagram>

### 6. Captions, Icons & Symbols
- Verify that image captions, labels, icons, and checkmarks are present and correctly transcribed.

### 7. Only populate \`corrected_text\` when \`needs_correction\` is true. If the OCR output is accurate, return \`needs_correction: false\` and \`corrected_content: null\`.
`;

  const result = await generateText({
    model: model,
    output: Output.object({
      schema: z.object({
        needs_correction: z.boolean(),
        corrected_text: z.string().nullable(),
        current_page_table: z.object({
          headers: z.array(z.string()),
          is_continuation: z.boolean(),
        }).nullable(),
        confidence: z.enum(['high', 'medium', 'low']),
        reasoning: z.string(),
      }),
    }),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image',
            image: `data:${mimeType};base64,${imageBase64}`,
          },
        ],
      },
    ],
  });

  // The structured output is in result.output
  const parsedOutput = result.output as {
    needs_correction: boolean;
    corrected_text: string | null;
    confidence: 'high' | 'medium' | 'low';
    current_page_table?: {
      headers: string[];
      is_continuation: boolean;
    } | null;
    reasoning: string;
  };

  const validation: VLMValidationResult = {
    needs_correction: parsedOutput.needs_correction,
    corrected_text: parsedOutput.corrected_text || undefined,
    confidence: parsedOutput.confidence,
    current_page_table: parsedOutput.current_page_table || undefined,
    reasoning: parsedOutput.reasoning,
  };

  return validation;
}

/**
 * Reconstructs table headers across pages sequentially after parallel VLM processing
 */
function reconstructTableHeaders(
  document: ProcessedDocument,
  validationResults: Map<number, VLMValidationResult>,
  verbose: boolean = false
): void {
  let lastTableHeaders: string[] | undefined = undefined;

  for (const page of document) {
    const validation = validationResults.get(page.page);
    if (!validation) continue;

    const tableInfo = validation.current_page_table;

    // If this page has a table
    if (tableInfo && tableInfo.headers.length > 0) {
      // If it's a continuation and we have previous headers, reconstruct
      if (tableInfo.is_continuation && lastTableHeaders) {
        if (verbose) {
          console.log(`[EXULU] Page ${page.page}: Reconstructing table headers from previous page`);
          console.log(`[EXULU] Previous headers: ${lastTableHeaders.join(' | ')}`);
        }

        // Get the content to modify (corrected or original)
        const contentToModify = page.vlm_corrected_text || page.content;

        // Find the first table in the content and add headers
        const lines = contentToModify.split('\n');
        const firstTableLineIndex = lines.findIndex(line => line.trim().startsWith('|'));

        if (firstTableLineIndex !== -1) {
          // Create header row and separator
          const headerRow = `| ${lastTableHeaders.join(' | ')} |`;
          const separatorRow = `| ${lastTableHeaders.map(() => '---').join(' | ')} |`;

          // Insert headers before the first table row
          lines.splice(firstTableLineIndex, 0, headerRow, separatorRow);

          // Update the content
          const reconstructedContent = lines.join('\n');
          if (page.vlm_corrected_text) {
            page.vlm_corrected_text = reconstructedContent;
          } else {
            page.content = reconstructedContent;
          }

          if (verbose) {
            console.log(`[EXULU] Page ${page.page}: Added table headers successfully`);
          }
        }

        // Update lastTableHeaders if this table also has headers (it might continue further)
        if (!tableInfo.is_continuation) {
          lastTableHeaders = tableInfo.headers;
        }
      } else {
        // This is a new table with headers, store them for next page
        lastTableHeaders = tableInfo.headers;
        if (verbose) {
          console.log(`[EXULU] Page ${page.page}: Storing table headers for potential continuation`);
          console.log(`[EXULU] Headers: ${lastTableHeaders.join(' | ')}`);
        }
      }
    } else {
      // No table on this page, reset the tracking
      lastTableHeaders = undefined;
    }
  }
}

/**
 * Identifies pages that need VLM validation and validates them in parallel
 */
async function validateWithVLM(
  document: ProcessedDocument,
  model: LanguageModel,
  verbose: boolean = false,
  concurrency: number = 10
): Promise<ProcessedDocument> {
  console.log(`[EXULU] Starting VLM validation for docling output, ${document.length} pages...`);
  console.log(`[EXULU] Concurrency limit: ${concurrency}`);

  // Create a concurrency limiter
  const limit = pLimit(concurrency);

  // Store validation results for post-processing
  const validationResults = new Map<number, VLMValidationResult>();

  // Track metrics
  let validatedCount = 0;
  let correctedCount = 0;

  // Create parallel validation tasks for all pages
  const validationTasks = document.map(page =>
    limit(async () => {
      // Yield control to the event loop to prevent stalling
      // This is critical for BullMQ to renew job locks during long-running operations
      await new Promise(resolve => setImmediate(resolve));

      const imagePath = page.image;

      if (!page.content) {
        console.warn(`[EXULU] Page ${page.page}: No content found, skipping validation`);
        return;
      }

      if (!imagePath) {
        console.warn(`[EXULU] Page ${page.page}: No image found, skipping validation`);
        return;
      }

      // Check if page.content has a .jpeg, .jpg, .png, .gif, .webp image
      const hasImage = page.content.match(/\.(jpeg|jpg|png|gif|webp)/i);
      // Check if the content has multiple occurences of |
      const hasTable = (page.content.match(/\|/g)?.length || 0) > 1;

      if (!hasImage && !hasTable) {
        if (verbose) {
          console.log(`[EXULU] Page ${page.page}: No image or table found, SKIPPING VLM validation`);
        }
        return;
      }

      // Validate the page
      let validation: VLMValidationResult;
      try {
        validation = await withRetry(async () => {
          return await validatePageWithVLM(page, imagePath, model);
        }, 3);

        // Store validation result for post-processing
        validationResults.set(page.page, validation);

        if (verbose && validation.current_page_table) {
          console.log(`[EXULU] Page ${page.page} table info:`, {
            headers: validation.current_page_table.headers,
            is_continuation: validation.current_page_table.is_continuation
          });
        }
      } catch (error) {
        console.error(`[EXULU] Error validating page ${page.page} with VLM more than 3 times, skipping:`, error);
        // Throw so the job fails
        throw error;
      }

      // Apply corrections to the page
      if (validation.needs_correction && validation.corrected_text) {
        page.vlm_validated = true;

        // Normalize markdown content to remove excessive whitespace
        const normalizedText = normalizeMarkdownContent(validation.corrected_text);

        // Reconstruct headings in the corrected text using the headings hierarchy
        const correctedWithHeadings = reconstructHeadings(
          normalizedText,
          page.headings
        );

        page.vlm_corrected_text = correctedWithHeadings;
        correctedCount++;

        if (verbose) {
          console.log(
            `[EXULU] Page ${page.page}: Corrected (${validation.confidence} confidence)`
          );
          console.log(`[EXULU] Reason: ${validation.reasoning}`);
        }
      } else {
        if (verbose) {
          console.log(
            `[EXULU] Page ${page.page}: No correction needed (${validation.confidence} confidence)`
          );
        }
      }

      validatedCount++;
    })
  );

  // Wait for all parallel validations to complete
  await Promise.all(validationTasks);

  console.log(`[EXULU] VLM validation complete (parallel processing):`);
  console.log(`[EXULU] Validated: ${validatedCount} pages`);
  console.log(`[EXULU] Corrected: ${correctedCount} pages`);

  // Post-process: Reconstruct table headers sequentially
  console.log(`[EXULU] Starting sequential table header reconstruction...`);
  reconstructTableHeaders(document, validationResults, verbose);
  console.log(`[EXULU] Table header reconstruction complete`);

  return document;
}

type ProcessingPaths = {
  json: string,
  markdown: string,
  images: string,
  source: string,
}

async function processDocument(
  filePath: string,
  fileType: string,
  buffer: Buffer,
  tempDir: string,
  config?: DocumentProcessorConfig,
  verbose: boolean = false,
): Promise<{
  content: {
    markdown: string,
    json: ProcessedDocument
  }, files: {
    markdown: string,
    json: string
  }
}> {

  console.log('Starting document processing...');
  console.log(`${fileType}: ${filePath}`);
  /* 
  tempDir/
    uuid/
      docling.json
      images/
  */
  const paths: ProcessingPaths = {
    json: path.join(tempDir, `processed.json`),
    markdown: path.join(tempDir, `markdown.md`),
    images: path.join(tempDir, 'images'),
    source: filePath,
  }

  const stripped = filePath.split('.').pop()?.trim();
  let result: ProcessorOutput;
  switch (stripped) {
    case 'txt':
    case 'md':
      let content = buffer.toString();

      // Filter out data:image/ base64 encoded images
      content = content.replace(/!\[.*?\]\(data:image\/[^)]+\)/g, '');

      result = {
        markdown: content,
        json: [{
          page: 1,
          content: content,
          headings: [],
        }],
      };
      break;
    case 'pdf':
      result = await processPdf(buffer, paths, config, verbose);
      break;
    case 'docx':
      result = await processDocx(buffer);
      break;
    case 'doc':
      result = await processWord(buffer);
      break;

    // Todo other file types with docx and officeparser
    default:
      throw new Error(`[EXULU] Unsupported file type: ${fileType}`);
  }
  return {
    content: result,
    files: {
      markdown: paths.markdown,
      json: paths.json,
    }
  };
}

const getMistralApiKey = async () => {
  if (process.env.MISTRAL_API_KEY) {
    return process.env.MISTRAL_API_KEY;
  } else {
    return await ExuluVariables.get("MISTRAL_API_KEY");
  }
}

async function processPdf(
  buffer: Buffer,
  paths: ProcessingPaths,
  config?: DocumentProcessorConfig,
  verbose: boolean = false,
): Promise<ProcessorOutput> {
  try {
    let json: ProcessedDocument = [];
    // Call the PDF processor script
    if (config?.processor.name === "docling") {

      // Validate Python environment and setup if needed
      console.log(`[EXULU] Validating Python environment...`);
      const validation = await validatePythonEnvironment(undefined, true);

      if (!validation.valid) {
        console.log(`[EXULU] Python environment not ready, setting up automatically...`);
        console.log(`[EXULU] Reason: ${validation.message}`);

        const setupResult = await setupPythonEnvironment({
          verbose: true,
          force: false, // Only setup if not already done
        });

        if (!setupResult.success) {
          throw new Error(`Failed to setup Python environment: ${setupResult.message}\n\n${setupResult.output || ''}`);
        }

        console.log(`[EXULU] Python environment setup completed successfully`);
      } else {
        console.log(`[EXULU] Python environment is valid`);
      }

      console.log(`[EXULU] Processing document with document_to_markdown.py`);

      const result = await executePythonScript({
        scriptPath: 'ee/python/documents/processing/document_to_markdown.py',
        args: [
          paths.source,
          '-o', paths.json,
          '--images-dir', paths.images
        ],
        timeout: 30 * 60 * 1000, // 30 minutes for large documents
      });

      // Log processing info from stderr
      if (result.stderr) {
        console.log('Processing info:', result.stderr.trim());
      }

      if (!result.success) {
        throw new Error(`Document processing failed: ${result.stderr}`);
      }

      // Read the generated JSON file
      const jsonContent = await fs.promises.readFile(paths.json, 'utf-8');
      json = JSON.parse(jsonContent);

    } else if (config?.processor.name === "officeparser") {
      const text = await parseOfficeAsync(buffer, {
        outputErrorToConsole: false,
        newlineDelimiter: "\n",
      });
      json = [{
        page: 1,
        content: text,
        headings: [],
      }];

    } else if (config?.processor.name === "mistral") {

      const MISTRAL_API_KEY = await getMistralApiKey();
      if (MISTRAL_API_KEY) {
        throw new Error('[EXULU] MISTRAL_API_KEY is not set, please set it in the environment variable via process.env or via an Exulu variable named "MISTRAL_API_KEY".');
      }

      // Wait a randomn time between 1 and 5 seconds to prevent rate limiting
      await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 4000) + 1000));

      const base64Pdf = buffer.toString('base64');
      const client = new Mistral({ apiKey: MISTRAL_API_KEY });

      const ocrResponse = await withRetry(async () => {
        type MistralOCRResponse = Awaited<ReturnType<typeof client.ocr.process>>;
        const ocrResponse: MistralOCRResponse = await client.ocr.process({
          document: {
            type: "document_url",
            documentUrl: "data:application/pdf;base64," + base64Pdf
          },
          model: "mistral-ocr-latest",
          includeImageBase64: false
        });
        return ocrResponse;
      }, 10);

      const parser = new LiteParse();
      const screenshots = await parser.screenshot(paths.source, undefined);

      // Save the screenshots in the temp image directory
      await fs.promises.mkdir(paths.images, { recursive: true });
      for (const screenshot of screenshots) {
        await fs.promises.writeFile(path.join(
          paths.images, `${screenshot.pageNum}.png`),
          screenshot.imageBuffer
        );
        screenshot.imagePath = path.join(paths.images, `${screenshot.pageNum}.png`);
      }

      json = ocrResponse.pages.map(page => ({
        page: page.index + 1,
        content: page.markdown,
        image: screenshots.find(s => s.pageNum === page.index + 1)?.imagePath,
        headings: [],
      }));

      fs.writeFileSync(paths.json, JSON.stringify(json, null, 2));

    } else if (config?.processor.name === "liteparse") {

      const parser = new LiteParse();
      const result = await parser.parse(paths.source);
      const screenshots = await parser.screenshot(paths.source, undefined);

      console.log(`[EXULU] Liteparse screenshots: ${JSON.stringify(screenshots)}`);

      // Save the screenshots in the temp image directory
      await fs.promises.mkdir(paths.images, { recursive: true });
      for (const screenshot of screenshots) {
        await fs.promises.writeFile(path.join(paths.images, `${screenshot.pageNum}.png`), screenshot.imageBuffer);
        screenshot.imagePath = path.join(paths.images, `${screenshot.pageNum}.png`);
      }

      json = result.pages.map(page => ({
        page: page.pageNum,
        content: page.text,
        image: screenshots.find(s => s.pageNum === page.pageNum)?.imagePath,
      }));

      fs.writeFileSync(paths.json, JSON.stringify(json, null, 2));
    }

    console.log(`[EXULU] \n✓ Document processing completed successfully`);
    console.log(`[EXULU] Total pages: ${json.length}`);
    console.log(`[EXULU] Output file: ${paths.json}`);

    if (config?.vlm?.model) {
      console.error('[EXULU] VLM validation is only supported when docling is enabled, skipping validation.');
    }

    // Apply VLM validation if enabled
    if (config?.vlm?.model && json.length > 0) {

      json = await validateWithVLM(
        json,
        config.vlm.model,
        verbose,
        config.vlm.concurrency
      );

      console.log('[EXULU] \n📊 Processing Summary:');
      console.log(`[EXULU] Total pages: ${json.length}`);

      const validatedPages = json.filter(p => p.vlm_validated);
      const correctedPages = json.filter(p => p.vlm_corrected_text);

      console.log(`[EXULU] VLM validated pages: ${validatedPages.length}`);
      console.log(`[EXULU] VLM corrected pages: ${correctedPages.length}`);

      // Show examples of corrections
      if (correctedPages.length > 0) {
        console.log('\n🔧 Example Corrections:');
        correctedPages.slice(0, 2).forEach((page) => {
          console.log(`[EXULU] \n  Page ${page.page} (Page ${page.page}):`);
          console.log(`[EXULU]    Original: ${page.content.substring(0, 150)}...`);
          console.log(`[EXULU]    Corrected: ${page.vlm_corrected_text!.substring(0, 150)}...`);
        });
      }

      // Save the validated result back to the JSON file
      await fs.promises.writeFile(
        paths.json,
        JSON.stringify(json, null, 2),
        'utf-8'
      );
    }

    // Memory-efficient: Build markdown incrementally and write to file
    // instead of creating a massive string in memory first
    const markdownStream = fs.createWriteStream(paths.markdown, { encoding: 'utf-8' });

    for (let i = 0; i < json.length; i++) {
      const p = json[i];
      if (!p) continue;
      const content = p.vlm_corrected_text ?? p.content;
      markdownStream.write(content);

      // Add separator between pages (but not after the last page)
      if (i < json.length - 1) {
        markdownStream.write('\n\n\n<!-- END_OF_PAGE -->\n\n\n');
      }
    }

    // Close the stream and wait for it to finish
    await new Promise<void>((resolve, reject) => {
      markdownStream.end(() => resolve());
      markdownStream.on('error', reject);
    });

    console.log(`[EXULU] Validated output saved to: ${paths.json}`);
    console.log(`[EXULU] Validated markdown saved to: ${paths.markdown}`);

    // Read markdown back for return (still needed for compatibility)
    // but at least we've written it efficiently
    const markdown = await fs.promises.readFile(paths.markdown, 'utf-8');

    // Memory optimization: Create minimal return objects
    const processedJson = json.map(e => {
      const finalContent = e.vlm_corrected_text ?? e.content;
      return {
        page: e.page,
        content: finalContent,
      };
    });

    // Clear references to large objects to help natural GC
    // V8 will collect these on its next GC cycle
    json.length = 0;
    json = [];

    // Log memory usage for monitoring
    const memUsage = process.memoryUsage();
    console.log(`[EXULU] Memory after document processing: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`);

    return {
      markdown: markdown,
      json: processedJson,
    };

  } catch (error) {
    console.error('[EXULU] Error processing document:', error);
    throw error;
  }
}

const loadFile = async (
  file: string | Buffer,
  name: string,
  tempDir: string
): Promise<{ filePath: string, fileType: string, buffer: Buffer }> => {
  // if Buffer provided, store to temp file
  let filePath = file as string;
  let fileType = name?.split('.').pop();
  if (!fileType) {
    throw new Error('[EXULU] File name does not include extension, extension is required for document processing.');
  }
  // Can be any file type
  const UUID = randomUUID();
  let buffer: Buffer;
  if (Buffer.isBuffer(file)) {
    filePath = path.join(tempDir, `${UUID}.${fileType}`);
    await fs.promises.writeFile(filePath, file);
    buffer = file;
  } else {
    // Check if external url or local file path
    filePath = filePath.trim();
    if (filePath.startsWith('http')) {
      // Download the file from the url
      const response = await fetch(filePath);
      const array: ArrayBuffer = await response.arrayBuffer();
      // save file to temp file
      const tempFilePath = path.join(tempDir, `${UUID}.${fileType}`);
      await fs.promises.writeFile(tempFilePath, Buffer.from(array));
      buffer = Buffer.from(array);
      filePath = tempFilePath;
    } else {
      // Read the file from the local path
      buffer = await fs.promises.readFile(file);
    }
  }

  return { filePath, fileType, buffer: buffer };
}

// Example usage
export async function documentProcessor({
  file,
  name,
  config
}: {
  file: string | Buffer;
  name: string;
  config?: DocumentProcessorConfig;
}): Promise<ProcessedDocument | undefined> {

  const license = checkLicense()

  if (!license["advanced-document-processing"]) {
    throw new Error("Advanced document processing is an enterprise feature, please add a valid Exulu enterprise license key to use it.")
  }

  // Temp dir at the root of the project
  const uuid = randomUUID()
  const tempDir = path.join(process.cwd(), 'temp', uuid);
  // Track files to delete locally per job to avoid race conditions in parallel execution
  const localFilesAndFoldersToDelete: string[] = [tempDir];
  console.log(`[EXULU] Temporary directory for processing document ${name}: ${tempDir}`);

  // Create the temporary directory
  await fs.promises.mkdir(tempDir, { recursive: true });

  // Create a .txt file in the temp directory with the current timestamp
  // this can be used to clean up lost temp files that are not deleted by
  // the job after a certain amount of time.
  const timestamp = new Date().toISOString();
  await fs.promises.writeFile(path.join(tempDir, 'created_at.txt'), timestamp);

  try {
    const {
      filePath,
      fileType,
      buffer
    } = await loadFile(file, name, tempDir);

    let supportedTypes: string[] = [];
    switch (config?.processor.name) {
      case "docling":
        supportedTypes = ['pdf', 'docx', 'doc', 'txt', 'md'];
        break;
      case "officeparser":
        supportedTypes = [];
        break;
      case "liteparse":
        supportedTypes = ['pdf', 'doc', 'docx', 'docm', 'odt', 'rtf', 'ppt', 'pptx', 'pptm', 'odp', 'xls', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv'];
        break;
      case "mistral":
        supportedTypes = ['pdf', 'docx', 'doc', 'txt', 'md'];
        break;
    }

    if (!supportedTypes.includes(fileType)) {
      throw new Error(`[EXULU] Unsupported file type: ${fileType} for Exulu document processor, the ${config?.processor.name} processor only supports the following file types: ${supportedTypes.join(', ')}.`);
    }

    // Process document with VLM validation enabled
    const { content } = await processDocument(
      filePath,
      fileType,
      buffer,
      tempDir,
      config,
      true
    );

    return content.json;


  } catch (error) {
    console.error('Error during chunking:', error);
    throw error;

  } finally {
    if (config?.debugging?.deleteTempFiles !== false) {
      // Delete the temp directory using the local array to avoid race conditions
      for (const file of localFilesAndFoldersToDelete) {
        try {
          await fs.promises.rm(file, { recursive: true });
          console.log(`[EXULU] Deleted file or folder: ${file}`);
        } catch (error) {
          console.error(`[EXULU] Error deleting file or folder: ${file}`, error);
          console.log(`[EXULU] File or folder still exists: ${file}`);
        }
      }
    }
  }
}