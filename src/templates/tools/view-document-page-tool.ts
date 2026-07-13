import { z } from "zod";
import { extname } from "node:path";
import { ExuluTool } from "@SRC/exulu/tool";
import { getS3ObjectBytes, getS3ObjectEtag } from "@SRC/uppy";
import { getPdfPreviewBytes } from "@SRC/sessions/pdf-preview-cache";
import { findLiteLLMModel } from "@SRC/exulu/litellm/catalog";
import { stashToolImage } from "@SRC/exulu/tool-image-attachments";
import type { ExuluConfig } from "@SRC/exulu/app";
import type { User } from "@EXULU_TYPES/models/user";
import { renderPdfPageToPng } from "./document-render-helpers";

/** ≈5MB after base64 — the common provider per-image limit. */
const MAX_IMAGE_BYTES = 3_750_000;
const SCALE_PRIMARY = 1568;
const SCALE_FALLBACK = 1024;

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const OFFICE_EXTENSIONS = new Set([
  ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".odt", ".ods", ".odp", ".rtf",
]);

export const createViewDocumentPageTool = ({
  sessionID,
  user,
  exuluConfig,
}: {
  sessionID?: string;
  user?: User;
  exuluConfig?: ExuluConfig;
}): ExuluTool | undefined => {
  if (!sessionID || !exuluConfig?.fileUploads?.s3Bucket) return undefined;

  const viewDocumentPageExecute = async (
    // The conversion wrapper spreads runtime context into inputs — `model` is
    // the AI SDK LanguageModel instance for this run (string or { modelId }).
    { filename, page, model }: { filename: string; page?: number; model?: unknown },
    options?: { toolCallId?: string },
  ) => {
    const safeName = String(filename ?? "").trim();
    if (!safeName || safeName.includes("..") || safeName.includes("/") || safeName.includes("\\")) {
      return {
        error: "Invalid filename — pass the bare file name exactly as listed in the session files (no paths).",
      };
    }
    const ext = extname(safeName).toLowerCase();
    const isImage = ext in IMAGE_MEDIA_TYPES;
    const isPdf = ext === ".pdf";
    const isOffice = OFFICE_EXTENSIONS.has(ext);
    if (!isImage && !isPdf && !isOffice) {
      return { error: `Unsupported extension "${ext}" — view_document_page handles PDF, Office, and image files.` };
    }

    // Vision gate: authoritative in LiteLLM mode; in catalog mode (or when the
    // proxy is unreachable) the lookup fails and we attempt optimistically —
    // a non-vision provider then errors visibly rather than silently.
    const modelId = typeof model === "string" ? model : (model as { modelId?: string } | undefined)?.modelId;
    if (modelId) {
      try {
        const entry = await findLiteLLMModel(modelId);
        if (entry && entry.supports_vision === false) {
          return {
            error:
              `The current model "${modelId}" does not support images, so this page cannot be shown to you. ` +
              "Use parse_document for the text, or tell the user a vision-capable model is required.",
          };
        }
      } catch {
        // catalog unavailable — proceed
      }
    }

    const uploads = exuluConfig.fileUploads!;
    const generalPrefix = uploads.s3prefix ? `${uploads.s3prefix.replace(/\/$/, "")}/` : "";
    const key = `${generalPrefix}user_${user?.id ?? "api"}/sessions/${sessionID}/${safeName}`;
    const pageNumber = page ?? 1;

    try {
      let imageBytes: Buffer;
      let mediaType = "image/png";

      if (isImage) {
        imageBytes = await getS3ObjectBytes(key, exuluConfig);
        mediaType = IMAGE_MEDIA_TYPES[ext]!;
        if (imageBytes.length > MAX_IMAGE_BYTES) {
          return {
            error:
              `"${safeName}" is too large to attach (${imageBytes.length} bytes, max ${MAX_IMAGE_BYTES}). ` +
              "Ask the user for a smaller version of the image.",
          };
        }
      } else {
        let pdfBytes: Buffer;
        if (isPdf) {
          pdfBytes = await getS3ObjectBytes(key, exuluConfig);
        } else {
          const etag = await getS3ObjectEtag(key, exuluConfig);
          if (!etag) {
            return { error: `Could not read session file "${safeName}". Check the exact file name.` };
          }
          pdfBytes = await getPdfPreviewBytes({ sourceKey: key, etag, config: exuluConfig });
        }
        let rendered = await renderPdfPageToPng(pdfBytes, pageNumber, SCALE_PRIMARY);
        if (rendered && rendered.length > MAX_IMAGE_BYTES) {
          rendered = await renderPdfPageToPng(pdfBytes, pageNumber, SCALE_FALLBACK);
        }
        if (!rendered) {
          return { error: `Could not render page ${pageNumber} of "${safeName}" — the document may have fewer pages.` };
        }
        if (rendered.length > MAX_IMAGE_BYTES) {
          return { error: `Page ${pageNumber} of "${safeName}" is too complex to attach within the image size limit.` };
        }
        imageBytes = rendered;
      }

      if (!options?.toolCallId) {
        return { error: "Internal error: missing toolCallId — the image cannot be attached." };
      }
      stashToolImage(options.toolCallId, {
        data: imageBytes.toString("base64"),
        mediaType,
        label: isImage ? safeName : `${safeName} page ${pageNumber}`,
      });
      return {
        attached: true,
        filename: safeName,
        page: pageNumber,
        note: "The rendered image follows this tool result as an attached user message — analyze it there.",
      };
    } catch (err) {
      return { error: `Failed to render "${safeName}": ${err instanceof Error ? err.message : "unknown error"}` };
    }
  };

  return ExuluTool.internal({
    id: "view_document_page",
    name: "view_document_page",
    needsApproval: false,
    description:
      "LOOK at a page of an uploaded PDF/Office document, or at an uploaded image, from this session's " +
      "files. The rendered image is attached as a user message directly after this tool result so you " +
      "can visually analyze photos, charts, scans, and layouts. Use parse_document first to find which " +
      "page you need. Requires a vision-capable model.",
    inputSchema: z.object({
      filename: z.string().describe('Exact session file name, e.g. "report.pdf" or "screenshot.png"'),
      page: z.number().int().min(1).optional().describe("Page number to render (default 1; ignored for image files)"),
    }),
    type: "function",
    category: "session",
    config: [],
    // Same execute-shape cast as read_session_file / parse_document.
    execute: viewDocumentPageExecute as never,
  });
};
