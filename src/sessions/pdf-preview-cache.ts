import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { getS3ObjectBytes } from "../uppy/index.ts";
import type { ExuluConfig } from "../exulu/app/index.ts";

const execAsync = promisify(exec);

const CACHE_ROOT = "/tmp/exulu-pdf-cache";
const CACHE_IN = join(CACHE_ROOT, "_in");
const CACHE_OUT = join(CACHE_ROOT, "_out");

/**
 * In-flight coalescing: two simultaneous requests for the same source ETag
 * share a single LibreOffice invocation. Without this, hitting the preview
 * route twice (e.g. two open tabs) would spawn two `soffice` processes
 * fighting over the same temp files.
 */
const inFlight = new Map<string, Promise<Buffer>>();

export class PreviewRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewRenderError";
  }
}

/**
 * Strip surrounding double-quotes (S3 wraps ETags in them) and replace any
 * non-filename-safe characters. Multipart-upload ETags contain a hyphen +
 * suffix, which is filename-safe; this is defensive against weird formats.
 */
function sanitizeEtag(raw: string): string {
  return raw.replace(/^"|"$/g, "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

export interface GetPdfPreviewOptions {
  sourceKey: string;
  etag: string;
  config: ExuluConfig;
}

/**
 * Return the rendered-PDF bytes for an Office binary (.docx/.xlsx/.pptx/etc.)
 * stored in S3. Cached on disk under the source object's ETag — re-uploading
 * the file (new ETag) invalidates automatically; repeat previews of the same
 * version are instant.
 *
 * The route handler is responsible for verifying the caller may read the
 * source key before delegating here.
 */
export async function getPdfPreviewBytes(
  opts: GetPdfPreviewOptions,
): Promise<Buffer> {
  const { sourceKey, etag, config } = opts;
  const safeEtag = sanitizeEtag(etag);
  if (!safeEtag) {
    throw new PreviewRenderError(`Invalid ETag for ${sourceKey}`);
  }

  const cachedPath = join(CACHE_ROOT, `${safeEtag}.pdf`);

  if (existsSync(cachedPath)) {
    return readFile(cachedPath);
  }

  const existing = inFlight.get(safeEtag);
  if (existing) return existing;

  const promise = (async () => {
    try {
      await mkdir(CACHE_IN, { recursive: true });
      await mkdir(CACHE_OUT, { recursive: true });

      // Preserve the source extension; LibreOffice picks its converter based
      // on the input filename.
      const ext = (extname(sourceKey) || ".docx").toLowerCase();
      const inputPath = join(CACHE_IN, `${safeEtag}${ext}`);
      const outputPath = join(CACHE_OUT, `${safeEtag}.pdf`);

      try {
        const bytes = await getS3ObjectBytes(sourceKey, config);
        await writeFile(inputPath, bytes);

        try {
          // --headless avoids any UI; --outdir controls where the PDF lands.
          // LibreOffice picks the output basename from the input basename,
          // so we use safeEtag as the input base and expect <safeEtag>.pdf.
          await execAsync(
            `soffice --headless --convert-to pdf "${inputPath}" --outdir "${CACHE_OUT}"`,
            { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
          );
        } catch (err: any) {
          throw new PreviewRenderError(
            `LibreOffice conversion failed for ${sourceKey} (etag ${etag}): ${err?.stderr ?? err?.message ?? "unknown error"}`,
          );
        }

        if (!existsSync(outputPath)) {
          throw new PreviewRenderError(
            `LibreOffice produced no output for ${sourceKey} (etag ${etag})`,
          );
        }

        // Move into the cache under the canonical name. Using rename (atomic
        // on the same filesystem) avoids a partial-write read race.
        await rename(outputPath, cachedPath);

        return await readFile(cachedPath);
      } finally {
        // Best-effort cleanup of the input temp file. The output is already
        // moved or never existed.
        await rm(inputPath, { force: true });
      }
    } finally {
      inFlight.delete(safeEtag);
    }
  })();

  inFlight.set(safeEtag, promise);
  return promise;
}
