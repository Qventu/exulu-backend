/**
 * Classification of a UIMessage file part into "image" (passed to the model as an
 * image) or "document" (text is extracted first).
 *
 * Persisted file parts do not always carry a `filename`: the image conversion in
 * generate-stream historically re-emitted image parts as `{ type, mediaType, url }`
 * and that shape was saved with the session. The next turn then crashed on
 * `filename.toLowerCase()`. Classification therefore leans on `mediaType` first and
 * derives a name from the URL path when no filename is present.
 */

export type FilePartLike = {
  type: "file";
  mediaType?: string;
  url?: string;
  filename?: string;
};

export type FilePartClassification =
  | { kind: "image"; mediaType: string; filename: string | undefined }
  | { kind: "document"; filename: string };

const IMAGE_EXTENSION_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  // Windows bitmaps arrive as email logos / signature images and camera exports.
  // Left out, they were routed to OfficeParser and replaced by an error text.
  ".bmp": "image/bmp",
  ".dib": "image/bmp",
};

/** Non-standard aliases seen in the wild → their registered media type. */
const MEDIA_TYPE_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/x-ms-bmp": "image/bmp",
  "image/x-bmp": "image/bmp",
  "image/x-windows-bmp": "image/bmp",
};

export function fileNameFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split("?")[0] ?? "";
  }
  const last = path.split("/").pop() ?? "";
  try {
    return decodeURIComponent(last) || undefined;
  } catch {
    return last || undefined;
  }
}

export function classifyFilePart(part: FilePartLike): FilePartClassification {
  const filename = part.filename ?? fileNameFromUrl(part.url);
  const lowerName = (filename ?? "").toLowerCase();
  const extension = Object.keys(IMAGE_EXTENSION_MIME).find((ext) => lowerName.endsWith(ext));

  const declared = typeof part.mediaType === "string" ? part.mediaType.trim().toLowerCase() : "";
  const declaredIsImage = declared.startsWith("image/");

  if (declaredIsImage || extension) {
    const mediaType = declaredIsImage
      ? (MEDIA_TYPE_ALIASES[declared] ?? declared)
      : IMAGE_EXTENSION_MIME[extension!]!;
    return { kind: "image", mediaType, filename };
  }

  return { kind: "document", filename: filename ?? "attachment" };
}
