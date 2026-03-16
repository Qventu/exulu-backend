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

type DocumentProcessorConfig = {
  vlm?: {
    model: LanguageModel;
    concurrency: number;
  },
  docling?: boolean,
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

  const prompt = `You are validating OCR/document parsing output for a page that might contain tables and images.

Here is the current OCR/parsed content for this page:

---
${page.content}
---

Please analyze the page image and validate it:

1. Check if the extracted markdown text accurately represents the content from the page, including:
   - Table data (rows, columns, headers, values)
   - Technical diagrams, schematics, control boards
   - Icons, checkmarks, symbols
   - Image captions and labels

2. If the page has significant errors or omissions, provide a corrected version for the page.

3. Return a validation result for the page.

IMPORTANT OUTPUT FORMAT REQUIREMENTS:
- You MUST output all tables in proper Markdown table format using pipes (|) and dashes (---)
- Use simple separator rows: | --- | --- | (NOT long dashes like ----------------------)
- Every table must have: header row, separator row, and data rows
- Example format:
  | Column 1 | Column 2 |
  | --- | --- |
  | Data 1 | Data 2 |
- If the extracted content already has tables, preserve their structure but fix any errors you find in the actual data
- Do NOT output tables as plain text or in any other format
- Preserve all markdown formatting (headings with ##, lists, etc.)

Specific notes and guidelines:
- Some pages might contain a table with a column that show black and white dots (for Example Rufe-LEDs). You should translate this into + for black (meaning active) and - for white (meaning inactive).
- Some tables might use green or black checkmarks and red or black crosses. You should translate this into + for checkmarks (meaning active) and - for a cross (meaning inactive).
- IMPORTANT: Only provide corrections if you find actual errors in the content. If the extracted text is accurate, set needs_correction to false.

`;

  const result = await generateText({
    model: model,
    output: Output.object({
      schema: z.object({
        needs_correction: z.boolean(),
        corrected_text: z.string().nullable(),
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
    reasoning: string;
  };

  const validation: VLMValidationResult = {
    needs_correction: parsedOutput.needs_correction,
    corrected_text: parsedOutput.corrected_text || undefined,
    confidence: parsedOutput.confidence,
    reasoning: parsedOutput.reasoning,
  };

  return validation;
}

/**
 * Identifies pages that need VLM validation and validates them
 */
async function validateWithVLM(
  document: ProcessedDocument,
  model: LanguageModel,
  verbose: boolean = false,
  concurrency: number = 10
): Promise<ProcessedDocument> {
  console.log(`[EXULU] Starting VLM validation for docling output, ${document.length} pages...`);
  console.log(
    `[EXULU] Concurrency limit: ${concurrency}`
  );

  // Validate each page that needs it
  let validatedCount = 0;
  let correctedCount = 0;

  // Create a limit function for concurrency control
  const limit = pLimit(concurrency);

  // Create validation tasks for all pages
  const validationTasks = document.map((page) =>
    limit(async () => {

      const imagePath = page.image;

      if (!imagePath) {
        console.log(`[EXULU] Page ${page.page}: No image found, skipping validation`);
        return;
      }

      // Validate the page
      let validation: VLMValidationResult;
      try {
        validation = await withRetry(async () => {
          return await validatePageWithVLM(page, imagePath, model);
        }, 3);
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

  // Wait for all validation tasks to complete
  await Promise.all(validationTasks);

  console.log(`[EXULU] VLM validation complete:`);
  console.log(`[EXULU] Validated: ${validatedCount} chunks`);
  console.log(`[EXULU] Corrected: ${correctedCount} chunks`);

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
    case 'pdf':
      result = await processPdf(buffer, paths, config, verbose);
      break;
    case 'docx':
      result = await processDocx(buffer);
      break;
    case 'doc':
      result = await processWord(buffer);
      break;
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

async function processPdf(
  buffer: Buffer,
  paths: ProcessingPaths,
  config?: DocumentProcessorConfig,
  verbose: boolean = false,
): Promise<ProcessorOutput> {
  try {
    let json: ProcessedDocument;
    // Call the PDF processor script
    if (config?.docling) {

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
    } else {
      const text = await parseOfficeAsync(buffer, {
        outputErrorToConsole: false,
        newlineDelimiter: "\n",
      });
      json = [{
        page: 1,
        content: text,
        headings: [],
      }];
    }

    console.log(`[EXULU] \n✓ Document processing completed successfully`);
    console.log(`[EXULU] Total pages: ${json.length}`);
    console.log(`[EXULU] Output file: ${paths.json}`);

    if (!config?.docling && config?.vlm?.model) {
      console.error('[EXULU] VLM validation is only supported when docling is enabled, skipping validation.');
    }

    // Apply VLM validation if enabled
    if (config?.docling && config?.vlm?.model) {

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

    const markdown = json.map(p => {
      if (p.vlm_corrected_text) {
        return p.vlm_corrected_text;
      } else {
        return p.content;
      }
    }).join('\n\n\n<!-- END_OF_PAGE -->\n\n\n');

    await fs.promises.writeFile(
      paths.markdown,
      markdown,
      'utf-8'
    );

    console.log(`[EXULU] Validated output saved to: ${paths.json}`);
    console.log(`[EXULU] Validated markdown saved to: ${paths.markdown}`);

    return {
      markdown: markdown,
      json: json.map(e => {
        const finalContent = e.vlm_corrected_text || e.content;
        return {
          page: e.page,
          content: finalContent,
        };
      }),
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
  let buffer: Buffer;
  if (Buffer.isBuffer(file)) {
    const UUID = randomUUID();
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
      buffer = Buffer.from(array);
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
  console.log(`[EXULU] Temporary directory for processing document ${name}: ${tempDir}`);

  // Create the temporary directory
  await fs.promises.mkdir(tempDir, { recursive: true });

  try {
    const {
      filePath,
      fileType,
      buffer
    } = await loadFile(file, name, tempDir);

    const supportedTypes = ['pdf', 'docx', 'doc', 'txt', 'md'];
    if (!supportedTypes.includes(fileType)) {
      throw new Error(`[EXULU] Unsupported file type: ${fileType} for Exulu document processor.`);
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
    return undefined;
  } finally {
    // Delete the temp directory
    // todo disabled for debugging
    await fs.promises.rm(tempDir, { recursive: true });
  }
}