import { createHash } from "crypto";
import { extname } from "node:path";

/**
 * Content-addressed store for extracted document text. Layout:
 *   text:    [<s3prefix>/]derived/content/<sha256 of source bytes>/<fingerprint id>.md
 *   pointer: [<s3prefix>/]derived/pointers/<sha256 of "<bucket>/<full key>">.json
 * Only the backend touches these keys; the generic /s3/* routes refuse them.
 */
export const DERIVED_ROOT = "derived";

/** Bump when extraction output changes in a way the settings do not show. */
const EXTRACTOR_VERSION = 1;

const generalPrefix = (s3prefix?: string | null) => {
  const trimmed = (s3prefix ?? "").replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : "";
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** True for any key under `[<s3prefix>/]derived/`. */
export function isDerivedKey(key: string, s3prefix?: string | null): boolean {
  return key.replace(/^\/+/, "").startsWith(`${generalPrefix(s3prefix)}${DERIVED_ROOT}/`);
}

export function contentKey(sha256Hex: string, fingerprintId: string, s3prefix?: string | null): string {
  return `${generalPrefix(s3prefix)}${DERIVED_ROOT}/content/${sha256Hex}/${fingerprintId}.md`;
}

export function pointerKey(bucket: string, fullKey: string, s3prefix?: string | null): string {
  return `${generalPrefix(s3prefix)}${DERIVED_ROOT}/pointers/${sha256(`${bucket}/${fullKey}`)}.json`;
}

/**
 * Identifies the extraction that would run for `filename`, so a cached text is
 * reused only while the same engine, OCR model and VLM setting apply. The
 * instance has one document processor (attachments.documentProcessor), used for
 * every file type; without one, PDFs are read as text layer ("pdftotext") and
 * everything else by officeparser. VLM concurrency does not change the output.
 */
export function extractorFingerprint(args: { filename: string; exuluConfig: any }): { id: string; label: string } {
  const processorConfig = args.exuluConfig?.attachments?.documentProcessor;
  let label: string;
  if (processorConfig?.processor) {
    const { name, model } = processorConfig.processor;
    const ocrModel = model?.trim() || (name === "mistral" ? "mistral-ocr" : "-");
    const vlm = processorConfig.vlm?.model ? `vlm:${processorConfig.vlm.model}` : "vlm:off";
    // The same bytes named .doc vs .docx take different processor paths, and the chunk size
    // changes where OCR splits a PDF, so both belong in the fingerprint.
    const extension = extname(args.filename).toLowerCase() || "-";
    const chunk = processorConfig.processor.maxPagesPerChunk ?? 25;
    label = `document-processor/${name}/${ocrModel}/${vlm}/${extension}/chunk:${chunk}@${EXTRACTOR_VERSION}`;
  } else if (args.filename.toLowerCase().endsWith(".pdf")) {
    label = `pdftotext@${EXTRACTOR_VERSION}`;
  } else {
    label = `officeparser@${EXTRACTOR_VERSION}`;
  }
  return { id: sha256(label).slice(0, 16), label };
}

/** Days a cached text stays valid. 0 disables the cache. */
export function documentCacheDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EXULU_DOCUMENT_CACHE_DAYS;
  if (raw === undefined || raw.trim() === "") return 365;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 365;
}

/** Page cap for reading a document into the store. */
export function documentMaxPages(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EXULU_DOCUMENT_MAX_PAGES;
  if (raw === undefined || raw.trim() === "") return 300;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 300;
}
