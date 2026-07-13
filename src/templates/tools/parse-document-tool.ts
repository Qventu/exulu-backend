import { z } from "zod";
import { extname } from "node:path";
import { parseOfficeAsync } from "officeparser";
import { ExuluTool } from "@SRC/exulu/tool";
import { getPresignedUrl } from "@SRC/uppy";
import type { ExuluConfig } from "@SRC/exulu/app";
import type { User } from "@EXULU_TYPES/models/user";
import { pdfToText } from "./document-render-helpers";

const DEFAULT_LIMIT = 250;
const MAX_CONTENT_CHARS = 16_000;
/** Under this many non-whitespace chars per page on average, the PDF is
 * effectively scanned — its text layer is useless and OCR-class processing
 * (knowledge base with a processor) or view_document_page is the way in. */
const MIN_CHARS_PER_PAGE = 20;

// No .csv here — CSV is plain text; read_session_file already covers it.
const OFFICE_EXTENSIONS = new Set([
  ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".odt", ".ods", ".odp", ".rtf",
]);

const pagesPattern = /^(\d+)(?:-(\d+))?$/;

export const createParseDocumentTool = ({
  sessionID,
  user,
  exuluConfig,
}: {
  sessionID?: string;
  user?: User;
  exuluConfig?: ExuluConfig;
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

    const uploads = exuluConfig.fileUploads!;
    const generalPrefix = uploads.s3prefix ? `${uploads.s3prefix.replace(/\/$/, "")}/` : "";
    const key = `${generalPrefix}user_${user?.id ?? "api"}/sessions/${sessionID}/${safeName}`;
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
        }
        fullText = pageTexts
          .map((text, i) => ({ page: i + 1, text }))
          .filter(({ page }) => page >= range[0] && page <= range[1])
          .map(({ page, text }) => `--- page ${page} ---\n${text.trim()}`)
          .join("\n");
      } else {
        const extracted = await parseOfficeAsync(bytes, {
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
      pages: z.string().optional().describe('PDF page or range to extract, e.g. "2" or "1-5" (default: all pages)'),
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
