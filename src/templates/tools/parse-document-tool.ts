import { z } from "zod";
import { extname } from "node:path";
import { parseOfficeAsync } from "officeparser";
import { ExuluTool } from "@SRC/exulu/tool";
import { isS3NotFound } from "@SRC/uppy";
import type { ExuluConfig } from "@SRC/exulu/app";
import type { User } from "@EXULU_TYPES/models/user";
import { convertLegacyOfficeToModern, isLegacyOfficeFormat, pdfToText } from "./document-render-helpers";
import { resolveFileKey } from "./resolve-file-key";
import { extractDocument } from "@SRC/exulu/attachment-text";
import type { ProgressFn } from "@SRC/exulu/document-cache/progress";
import { createStoreIo, readThroughDocument, type Extracted, type StoreIo } from "@SRC/exulu/document-cache/store";
import { documentCacheDays, documentMaxPages, extractorFingerprint } from "@SRC/exulu/document-cache/keys";

const DEFAULT_LIMIT = 250;
const MAX_CONTENT_CHARS = 16_000;

/**
 * This tool's display name — exported so the sanitized key it maps to (used
 * by claim-check's finish-metadata to detect that a turn read evidence the
 * check will never see) breaks loudly on a rename instead of silently
 * turning that detection off.
 */
export const PARSE_DOCUMENT_TOOL_NAME = "parse_document";
/** Under this many non-whitespace chars per page on average, the PDF is
 * effectively scanned — its text layer is useless and OCR-class processing
 * (knowledge base with a processor) or view_document_page is the way in. */
const MIN_CHARS_PER_PAGE = 20;

/**
 * Some PDFs carry a text layer whose font subset has no usable ToUnicode map: every
 * glyph extracts offset by a constant ("Technische Daten" → "7HFKQLVFKH 'DWHQ"), and
 * digits fall below 0x20 and vanish. Such text passes the empty-layer check but is worse
 * than nothing, because the model silently guesses the numbers. Flag it when control
 * characters (other than whitespace) make up a noticeable share of the text.
 */
export function looksLikeGarbledTextLayer(text: string): boolean {
  let control = 0;
  let visible = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code === 9 || code === 10 || code === 12 || code === 13 || code === 32) continue;
    visible++;
    if (code < 32 || code === 127) control++;
  }
  if (visible < 40) return false;
  return control / visible > 0.01;
}

// No .csv here — CSV is plain text; read_session_file already covers it.
const OFFICE_EXTENSIONS = new Set([
  ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".odt", ".ods", ".odp", ".rtf",
]);

/** A result the model must see as a tool error; never stored, never retried as a failure. */
class ExtractionRefusal extends Error {}

/**
 * Keeps the pages in `range` of a text with `--- page N ---` markers, exactly as the
 * extraction would have joined them. Text without markers is returned whole.
 */
export function selectPages(fullText: string, range: [number, number]): string {
  const parts = fullText.split(/^(?=--- page \d+ ---$)/m);
  if (parts.length < 2 && !/^--- page \d+ ---$/m.test(fullText)) return fullText;
  const kept: string[] = [];
  parts.forEach((part, i) => {
    const m = /^--- page (\d+) ---$/m.exec(part);
    if (!m) return;
    const page = Number(m[1]);
    if (page < range[0] || page > range[1]) return;
    // Every part but the last still carries the "\n" that joined it to the next page.
    kept.push(i < parts.length - 1 ? part.replace(/\n$/, "") : part);
  });
  return kept.join("\n");
}

const pagesPattern = /^(\d+)(?:-(\d+))?$/;

/** "3" or "2-5" → [start, end] within totalPages, or a tool error. */
function resolvePageRange(
  pages: string | undefined,
  totalPages: number,
  safeName: string,
): [number, number] | { error: string } {
  if (!pages) return [1, totalPages];
  const m = pagesPattern.exec(pages.trim());
  if (!m) return { error: `Invalid pages "${pages}" — use "3" or "2-5".` };
  const range: [number, number] = [Number(m[1]), Number(m[2] ?? m[1])];
  if (range[0] < 1 || range[0] > range[1]) {
    return { error: `Invalid pages "${pages}" — start must be at least 1 and not greater than the end.` };
  }
  if (range[0] > totalPages) {
    return { error: `Page range starts at ${range[0]} but "${safeName}" has only ${totalPages} page${totalPages === 1 ? "" : "s"}.` };
  }
  return range;
}

const BINARY_DOCUMENT_EXTENSION_PATTERN = new RegExp(
  `([^\\s"'\`]+\\.(?:pdf|${[...OFFICE_EXTENSIONS].map((ext) => ext.slice(1)).join("|")}))\\b`,
  "i",
);

/**
 * bash/grep/cat against PDF or Office files can't find text inside them — the bytes
 * are compressed or otherwise non-plain-text, so a search silently returns nothing
 * (or binary garbage) and the agent has no signal to explain why. Real incident,
 * 2026-09-14 (job 40a1f12d): ALFREDO_2 grepped a PDF ~25 times in a row for the same
 * term before giving up, ballooning the turn to 1.4M tokens and failing
 * CONTEXT_COMPACTION_REQUIRED — even though it had already extracted the same PDF's
 * text via parse_document earlier in the same turn. Returns a hint to redirect the
 * agent to parse_document, or undefined when the command looks unrelated (no binary
 * document referenced, or the command already produced real, readable output).
 */
export function binaryDocumentBashHint(command: string, stdout: string, stderr: string): string | undefined {
  const match = command.match(BINARY_DOCUMENT_EXTENSION_PATTERN);
  if (!match) return undefined;
  const silent = !stdout.trim() && !stderr.trim();
  if (!silent && !looksLikeGarbledTextLayer(stdout)) return undefined;
  const [, file] = match;
  return (
    `Note: "${file}" is a binary document — grep/cat/text tools cannot read the text inside it, so a silent or ` +
    "garbled result does not mean the content isn't there. Use parse_document to extract its text first, then " +
    "search or read within that extracted text instead of the original file."
  );
}

export const createParseDocumentTool = ({
  sessionID,
  user,
  exuluConfig,
  ownerId,
  projectId,
}: {
  sessionID?: string;
  user?: User;
  exuluConfig?: ExuluConfig;
  /** Session owner — files are namespaced by owner, not by the current speaker. */
  ownerId?: number | string;
  /** The access-checked project id (never the raw session.project); null/undefined = no project files. */
  projectId?: string | null;
}): ExuluTool | undefined => {
  if (!sessionID || !exuluConfig?.fileUploads?.s3Bucket) return undefined;

  const parseDocumentExecute = async ({
    filename,
    pages,
    offset,
    limit,
  }: {
    filename: string;
    pages?: string;
    offset?: number;
    limit?: number;
  }) => {
    const resolvedKey = resolveFileKey({
      filename,
      ownerId: ownerId ?? user?.id ?? "api",
      sessionId: sessionID,
      projectId: projectId ?? null,
      s3prefix: exuluConfig.fileUploads!.s3prefix,
    });
    if ("error" in resolvedKey) return { error: resolvedKey.error };
    const key = resolvedKey.key;
    const safeName = String(filename).trim();
    const ext = extname(safeName).toLowerCase();
    if (ext !== ".pdf" && !OFFICE_EXTENSIONS.has(ext)) {
      return {
        error: `Unsupported extension "${ext}" — parse_document handles PDF and Office formats. For plain-text files use read_session_file.`,
      };
    }

    if (pages && ext !== ".pdf") {
      return { error: `The pages option is only supported for PDF files — "${ext}" documents are extracted whole.` };
    }

    const uploads = exuluConfig.fileUploads!;
    try {
      const baseIo = createStoreIo(exuluConfig);
      const io: StoreIo = {
        ...baseIo,
        getBytes: async (sourceKey) => {
          try {
            return await baseIo.getBytes(sourceKey);
          } catch (err) {
            if (isS3NotFound(err)) {
              throw new ExtractionRefusal(
                `Could not read session file "${safeName}" (status 404). Check the exact file name.`,
              );
            }
            throw err;
          }
        },
      };

      /** The whole document as marked text: processor path, then pdftotext / Office. */
      const extractFull = async (bytes: Buffer, onProgress?: ProgressFn): Promise<Extracted> => {
        // An instance with attachments.documentProcessor (OCR + VLM, the engine
        // the knowledge bases use) reads scans and images inside pages too; the
        // text-layer paths below stay as the fallback.
        let processorFellBack = false;
        if (exuluConfig.attachments?.documentProcessor) {
          const extracted = await extractDocument({
            bytes,
            filename: safeName,
            exuluConfig,
            attribution: { user },
            maxPages: documentMaxPages(),
            tolerateVisionFailures: true,
            onProgress,
          });
          if (extracted.tooLong) {
            throw new ExtractionRefusal(extracted.text);
          }
          if (extracted.engine === "document-processor") {
            const multiPage = extracted.pages.length > 1;
            const body = extracted.pages
              .map(({ page, text }) => (multiPage ? `--- page ${page} ---\n${text.trim()}` : text.trim()))
              .join("\n");
            const degraded = extracted.degradedPages ?? [];
            // A result with unverified pages is returned but never stored: a later
            // read must get the chance to verify them.
            return {
              totalPages: extracted.pages.length,
              storable: degraded.length === 0,
              text:
                degraded.length === 0
                  ? body
                  : `${body}\n[Note: figures and tables on page(s) ${degraded.join(", ")} could not be verified; the text for those pages is OCR only.]`,
            };
          }
          // The processor gave nothing usable: what follows is the text-layer fallback,
          // which must not stand in for the processor's output in the store.
          processorFellBack = extracted.engine === "officeparser";
        }

        if (ext === ".pdf") {
          const raw = await pdfToText(bytes);
          const pageTexts = raw.replace(/\f$/, "").split("\f");
          const pageCount = pageTexts.length;
          const nonWhitespace = raw.replace(/\s/g, "").length;
          if (looksLikeGarbledTextLayer(raw)) {
            throw new ExtractionRefusal(
              `"${safeName}" has a text layer that is unreadable (its font encoding maps glyphs to the wrong ` +
                "characters, so words and especially numbers come out wrong or vanish). Do not use extracted " +
                "text from this file. Use view_document_page to read the pages visually, or suggest the user add " +
                "the document to a knowledge base with a document processor for full OCR.",
            );
          }
          if (nonWhitespace < pageCount * MIN_CHARS_PER_PAGE) {
            throw new ExtractionRefusal(
              `"${safeName}" has no extractable text layer (likely a scan or image-based PDF). ` +
                "Use view_document_page to look at pages visually, or suggest the user add the document " +
                "to a knowledge base with a document processor for full OCR.",
            );
          }
          return {
            totalPages: pageCount,
            storable: !processorFellBack,
            text: pageTexts.map((text, i) => `--- page ${i + 1} ---\n${text.trim()}`).join("\n"),
          };
        }

        // officeparser only reads the modern XML formats; .doc/.xls/.ppt/.rtf
        // need converting first even though OFFICE_EXTENSIONS accepts them.
        const officeBytes = isLegacyOfficeFormat(ext) ? await convertLegacyOfficeToModern(bytes, ext) : bytes;
        const parsed = await parseOfficeAsync(officeBytes, {
          outputErrorToConsole: false,
          newlineDelimiter: "\n",
        });
        return { text: String(parsed), storable: !processorFellBack };
      };

      const stored = await readThroughDocument({
        io,
        bucket: uploads.s3Bucket!,
        sourceKey: key,
        s3prefix: uploads.s3prefix,
        fingerprint: extractorFingerprint({ filename: safeName, exuluConfig }),
        cacheDays: documentCacheDays(),
        extract: extractFull,
      });

      let fullText = stored.text;
      // Single-page processor output carries no markers, so a stored copy has no page count.
      const totalPages = stored.totalPages ?? (ext === ".pdf" ? 1 : undefined);
      if (ext === ".pdf" && totalPages !== undefined) {
        const range = resolvePageRange(pages, totalPages, safeName);
        if (!Array.isArray(range)) return range;
        if (pages) fullText = selectPages(fullText, range);
      }

      const lines = (fullText ?? "").split("\n");
      const start = (offset ?? 1) - 1;
      const requested = limit ?? DEFAULT_LIMIT;
      const sliced = lines.slice(start, start + requested);
      let content = sliced.join("\n");
      let linesReturned = sliced.length;
      if (content.length > MAX_CONTENT_CHARS) {
        content = content.slice(0, MAX_CONTENT_CHARS);
        linesReturned = Math.max(1, content.split("\n").length - 1);
        content = content + "\n[slice truncated — request fewer lines]";
      }
      return {
        content,
        ...(totalPages !== undefined ? { totalPages } : {}),
        totalLines: lines.length,
        offset: start + 1,
        linesReturned,
      };
    } catch (err) {
      if (err instanceof ExtractionRefusal) return { error: err.message };
      return { error: `Failed to parse "${safeName}": ${err instanceof Error ? err.message : "unknown error"}` };
    }
  };

  return ExuluTool.internal({
    id: "parse_document",
    name: PARSE_DOCUMENT_TOOL_NAME,
    needsApproval: false,
    description:
      "Extract the text of an uploaded PDF or Office document from this session's files, with " +
      '"--- page N ---" markers for PDFs so you can locate content by page. Results are ' +
      "stored and reused, so reading the same document again is fast, but the first read of a long document " +
      "can take minutes. To SEE a page or an image inside a document, " +
      "use view_document_page." +
      " Files of the session's project are addressed as `project/<name>` and are read-only.",
    inputSchema: z.object({
      filename: z.string().describe('Exact session file name, e.g. "report.pdf"'),
      pages: z.string().optional().describe('PDF page or range to extract, e.g. "2" or "1-5" (default: all pages) (PDF only)'),
      offset: z.number().int().min(1).optional().describe("1-based first output line to read (default 1)"),
      limit: z.number().int().min(1).max(1000).optional().describe(`Number of lines to read (default ${DEFAULT_LIMIT})`),
    }),
    type: "function",
    category: "session",
    config: [],
    // Same shape mismatch as read_session_file / memory-tool: internal utility
    // tools return richer objects than ExuluTool's retrieval-flavored execute
    // type; the AI SDK passes the object through verbatim.
    execute: parseDocumentExecute as never,
  });
};
