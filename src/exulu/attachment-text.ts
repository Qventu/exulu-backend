import { parseOfficeAsync } from "officeparser";
import type { ExuluConfig } from "./app";
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
};

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
