import { z } from "zod";
import { extname } from "node:path";
import { parseOfficeAsync } from "officeparser";
import { ExuluTool } from "@SRC/exulu/tool";
import { getPresignedUrl } from "@SRC/uppy";
import type { ExuluConfig } from "@SRC/exulu/app";
import type { User } from "@EXULU_TYPES/models/user";
import { convertLegacyOfficeToModern, isLegacyOfficeFormat, pdfToText } from "./document-render-helpers";
import { sessionFilePrefix } from "@SRC/exulu/session-files";

const DEFAULT_LIMIT = 250;
const MAX_CONTENT_CHARS = 16_000;
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

const pagesPattern = /^(\d+)(?:-(\d+))?$/;

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
}: {
  sessionID?: string;
  user?: User;
  exuluConfig?: ExuluConfig;
  /** Session owner — files are namespaced by owner, not by the current speaker. */
  ownerId?: number | string;
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
    const safeName = String(filename ?? "").trim();
    if (!safeName || safeName.includes("..") || safeName.includes("/") || safeName.includes("\\")) {
      return {
        error: "Invalid filename — pass the bare file name exactly as listed in the session files (no paths).",
      };
    }
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
    const key = `${sessionFilePrefix(ownerId ?? user?.id ?? "api", sessionID, uploads.s3prefix)}${safeName}`;
    try {
      const url = await getPresignedUrl(uploads.s3Bucket!, key, exuluConfig);
      const res = await fetch(url);
      if (!res.ok) {
        return { error: `Could not read session file "${safeName}" (status ${res.status}). Check the exact file name.` };
      }
      const bytes = Buffer.from(await res.arrayBuffer());

      let fullText: string;
      let totalPages: number | undefined;
      if (ext === ".pdf") {
        const raw = await pdfToText(bytes);
        const pageTexts = raw.replace(/\f$/, "").split("\f");
        totalPages = pageTexts.length;
        const nonWhitespace = raw.replace(/\s/g, "").length;
        if (looksLikeGarbledTextLayer(raw)) {
          return {
            error:
              `"${safeName}" has a text layer that is unreadable (its font encoding maps glyphs to the wrong ` +
              "characters, so words and especially numbers come out wrong or vanish). Do not use extracted " +
              "text from this file. Use view_document_page to read the pages visually, or suggest the user add " +
              "the document to a knowledge base with a document processor for full OCR.",
          };
        }
        if (nonWhitespace < totalPages * MIN_CHARS_PER_PAGE) {
          return {
            error:
              `"${safeName}" has no extractable text layer (likely a scan or image-based PDF). ` +
              "Use view_document_page to look at pages visually, or suggest the user add the document " +
              "to a knowledge base with a document processor for full OCR.",
          };
        }
        let range: [number, number] = [1, totalPages];
        if (pages) {
          const m = pagesPattern.exec(pages.trim());
          if (!m) return { error: `Invalid pages "${pages}" — use "3" or "2-5".` };
          range = [Number(m[1]), Number(m[2] ?? m[1])];
          if (range[0] < 1 || range[0] > range[1]) {
            return { error: `Invalid pages "${pages}" — start must be at least 1 and not greater than the end.` };
          }
          if (range[0] > totalPages) {
            return { error: `Page range starts at ${range[0]} but "${safeName}" has only ${totalPages} page${totalPages === 1 ? "" : "s"}.` };
          }
        }
        fullText = pageTexts
          .map((text, i) => ({ page: i + 1, text }))
          .filter(({ page }) => page >= range[0] && page <= range[1])
          .map(({ page, text }) => `--- page ${page} ---\n${text.trim()}`)
          .join("\n");
      } else {
        // officeparser only reads the modern XML formats; .doc/.xls/.ppt/.rtf
        // need converting first even though OFFICE_EXTENSIONS accepts them.
        const officeBytes = isLegacyOfficeFormat(ext)
          ? await convertLegacyOfficeToModern(bytes, ext)
          : bytes;
        const extracted = await parseOfficeAsync(officeBytes, {
          outputErrorToConsole: false,
          newlineDelimiter: "\n",
        });
        fullText = String(extracted);
      }

      const lines = fullText.split("\n");
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
      return { error: `Failed to parse "${safeName}": ${err instanceof Error ? err.message : "unknown error"}` };
    }
  };

  return ExuluTool.internal({
    id: "parse_document",
    name: "parse_document",
    needsApproval: false,
    description:
      "Extract the text of an uploaded PDF or Office document from this session's files, with " +
      '"--- page N ---" markers for PDFs so you can locate content by page. Free and fast (no OCR): ' +
      "works only on documents with a real text layer. To SEE a page or an image inside a document, " +
      "use view_document_page.",
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
