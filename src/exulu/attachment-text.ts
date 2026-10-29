import { parseOfficeAsync } from "officeparser";
import type { ExuluConfig } from "./app";
import { pdfPageCount } from "@SRC/templates/tools/document-render-helpers";
import type { DocumentProcessorConfig, ProcessedDocument } from "@EE/python/documents/processing/doc_processor.ts";

/**
 * Text extraction for documents the model receives inline: chat uploads,
 * routine mail attachments (processFilePartsInMessages) and parse_document.
 *
 * officeparser only reads a PDF's text layer. ALGI's inquiries are often
 * scans, or text PDFs with a photographed nameplate on the page, and both
 * came through empty (2026-10-29). When the instance configures
 * `attachments.documentProcessor`, the same OCR + VLM engine the knowledge
 * bases use (ExuluDocumentProcessor: vertex-ocr / mistral / liteparse plus a
 * VLM page-validation pass) extracts the pages instead; officeparser stays
 * the fallback when no processor is configured, the licence is missing, the
 * type is unsupported, or the processor fails.
 */
export type ExtractedPage = { page: number; text: string };

export type ExtractedDocument = {
  pages: ExtractedPage[];
  /** All pages joined; page markers only when there is more than one page. */
  text: string;
  engine: "document-processor" | "officeparser";
  /**
   * Set when the PDF exceeds the attachment page cap: nothing was read, and
   * `text` holds the notice the model (and so the user) sees instead.
   */
  tooLong?: { pageCount: number; maxPages: number };
};

/**
 * Page cap for PDFs that go through the OCR + VLM processor inline, i.e.
 * while a chat request waits (ALGI, 2026-10-29: a 100-page manual would
 * block the answer for minutes). EXULU_ATTACHMENT_MAX_PAGES, default 50.
 * Longer documents are refused with a clear notice — never partially read.
 */
export const DEFAULT_ATTACHMENT_MAX_PAGES = 50;

export function attachmentMaxPages(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EXULU_ATTACHMENT_MAX_PAGES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_ATTACHMENT_MAX_PAGES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(`[EXULU] EXULU_ATTACHMENT_MAX_PAGES=${JSON.stringify(raw)} is not a positive integer; using ${DEFAULT_ATTACHMENT_MAX_PAGES}.`);
    return DEFAULT_ATTACHMENT_MAX_PAGES;
  }
  return parsed;
}

export function tooLongNotice(filename: string, pageCount: number, maxPages: number): string {
  return (
    `[Document too long: "${filename}" has ${pageCount} pages, the limit for attachments is ${maxPages} pages ` +
    `(EXULU_ATTACHMENT_MAX_PAGES). The document was NOT read. Tell the user plainly that the document is too long ` +
    `and ask for a shorter document or an excerpt with the relevant pages.]`
  );
}

export type ExtractDocumentInput = {
  bytes: Buffer;
  /** File name with extension — the processor derives the type from it. */
  filename: string;
  exuluConfig?: ExuluConfig;
  /** Cost attribution forwarded to LiteLLM (user / agent / routine tags). */
  attribution?: DocumentProcessorConfig["attribution"];
  /** Test seams. */
  process?: DocumentProcess;
  officeParse?: (bytes: Buffer) => Promise<string>;
  countPages?: (bytes: Buffer) => Promise<number>;
};

type DocumentProcess = (input: {
  file: string | Buffer;
  name: string;
  config?: DocumentProcessorConfig;
}) => Promise<ProcessedDocument | undefined>;

/**
 * Loaded on first use only: the processor module pulls in OCR, VLM and the
 * python helpers, which no caller needs unless a processor is configured.
 */
const loadDocumentProcessor = async (): Promise<DocumentProcess> => {
  const mod = await import("@EE/python/documents/processing/doc_processor.ts");
  return mod.documentProcessor;
};

export function pagesToText(pages: ExtractedPage[]): string {
  if (pages.length <= 1) return (pages[0]?.text ?? "").trim();
  return pages.map(({ page, text }) => `--- page ${page} ---\n${text.trim()}`).join("\n");
}

function pagesFromProcessor(result: ProcessedDocument | undefined): ExtractedPage[] {
  return (result ?? []).map((p) => ({
    page: p.page,
    // The VLM pass rewrites a page when OCR garbled it; prefer that text.
    text: (p.vlm_corrected_text ?? p.content ?? "").trim(),
  }));
}

const defaultOfficeParse = async (bytes: Buffer): Promise<string> =>
  String(await parseOfficeAsync(bytes, { outputErrorToConsole: false, newlineDelimiter: "\n" }));

export async function extractDocument(input: ExtractDocumentInput): Promise<ExtractedDocument> {
  const config = input.exuluConfig?.attachments?.documentProcessor;
  if (config) {
    if (input.filename.toLowerCase().endsWith(".pdf")) {
      const maxPages = attachmentMaxPages();
      let pageCount: number | undefined;
      try {
        pageCount = await (input.countPages ?? pdfPageCount)(input.bytes);
      } catch (error) {
        // Unreadable PDF: let the processor report it; the cap only bounds time.
        console.warn(`[EXULU] Could not count pages of ${input.filename}:`, error instanceof Error ? error.message : String(error));
      }
      if (pageCount !== undefined && pageCount > maxPages) {
        console.warn(`[EXULU] ${input.filename} has ${pageCount} pages, over the attachment cap of ${maxPages}; not read.`);
        return {
          pages: [],
          text: tooLongNotice(input.filename, pageCount, maxPages),
          engine: "document-processor",
          tooLong: { pageCount, maxPages },
        };
      }
    }
    try {
      const process = input.process ?? (await loadDocumentProcessor());
      const result = await process({
        file: input.bytes,
        name: input.filename,
        config: { ...config, attribution: { ...config.attribution, ...input.attribution } },
      });
      const pages = pagesFromProcessor(result);
      if (pages.some((p) => p.text.length > 0)) {
        return { pages, text: pagesToText(pages), engine: "document-processor" };
      }
      console.warn(`[EXULU] Document processor returned no text for ${input.filename}; falling back to officeparser.`);
    } catch (error) {
      console.warn(
        `[EXULU] Document processor failed for ${input.filename}; falling back to officeparser:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const text = (await (input.officeParse ?? defaultOfficeParse)(input.bytes)).trim();
  return { pages: [{ page: 1, text }], text, engine: "officeparser" };
}

const PROCESSOR_NAMES = new Set(["liteparse", "mistral", "officeparser"]);

/**
 * Boot-time check for `attachments.documentProcessor` (called from
 * ExuluApp.create). The feature is opt-in and must be explicit: an OCR
 * engine, the OCR model for the "mistral" engine, a VLM model when a VLM
 * pass is wanted, and the enterprise licence. Anything incomplete is an
 * error at start-up, never a silent fall-back to the text layer at run time.
 * Returns the problems found; empty when the config is absent or valid.
 */
export function validateAttachmentsConfig(
  config: ExuluConfig | undefined,
  license: { "advanced-document-processing": boolean },
): string[] {
  const processorConfig = config?.attachments?.documentProcessor;
  if (!processorConfig) return [];
  const problems: string[] = [];
  const name = processorConfig.processor?.name;
  if (!name || !PROCESSOR_NAMES.has(name)) {
    problems.push(`attachments.documentProcessor.processor.name must be one of ${[...PROCESSOR_NAMES].join(", ")} (got ${JSON.stringify(name)})`);
  }
  if (name === "mistral" && !processorConfig.processor.model?.trim()) {
    problems.push('attachments.documentProcessor.processor.model (the OCR model_name from config.litellm.yaml, e.g. "vertex-ocr") is required for the "mistral" engine');
  }
  if (processorConfig.vlm !== undefined) {
    if (!processorConfig.vlm.model?.trim()) {
      problems.push('attachments.documentProcessor.vlm.model (a LiteLLM model_name, e.g. "vertex-gemini-2.5-flash") is required when vlm is set');
    }
    if (!(Number.isInteger(processorConfig.vlm.concurrency) && processorConfig.vlm.concurrency > 0)) {
      problems.push("attachments.documentProcessor.vlm.concurrency must be a positive integer");
    }
  }
  if (!license["advanced-document-processing"]) {
    problems.push("attachments.documentProcessor needs the enterprise licence (advanced-document-processing); set EXULU_ENTERPRISE_LICENSE or remove the attachments config");
  }
  const rawMax = process.env.EXULU_ATTACHMENT_MAX_PAGES;
  if (rawMax !== undefined && rawMax.trim() !== "" && !(Number.isInteger(Number(rawMax)) && Number(rawMax) > 0)) {
    problems.push(`EXULU_ATTACHMENT_MAX_PAGES must be a positive integer (got ${JSON.stringify(rawMax)}; default ${DEFAULT_ATTACHMENT_MAX_PAGES})`);
  }
  return problems;
}
