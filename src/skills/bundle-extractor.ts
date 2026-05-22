import JSZip from "jszip";
import { uploadFile } from "../uppy/index.ts";
import type { ExuluConfig } from "../exulu/app/index.ts";

/**
 * Maximum total uncompressed size of a skill bundle. Skill bundles are
 * documents + small scripts; 50 MB is far above any legitimate case and
 * provides a clear ceiling against accidental huge uploads and zip-bomb
 * compression-ratio attacks.
 */
const MAX_TOTAL_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

/**
 * Maximum number of entries in a skill bundle. Real skills tend to have <50
 * files; 500 is generous head-room without leaving the door open to e.g. a
 * node_modules directory accidentally getting zipped up.
 */
const MAX_ENTRY_COUNT = 500;

export interface ExtractBundleOptions {
  bytes: Buffer;
  skillId: string;
  /** When true, `bytes` is a zip archive; when false, `bytes` IS the SKILL.md content. */
  isZip: boolean;
  config: ExuluConfig;
}

export interface ExtractBundleResult {
  filesCount: number;
}

/**
 * Thrown when an uploaded bundle violates a validation rule (missing SKILL.md,
 * unsafe path, size cap, etc.). The route handler maps these to HTTP 400.
 */
export class BundleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleValidationError";
  }
}

function isUnsafePath(path: string): boolean {
  if (!path) return true;
  if (path.startsWith("/")) return true;
  // Reject any ".." segment. Splitting on "/" avoids matching ".." inside
  // legitimate filenames like "version..backup.md".
  return path.split("/").some((segment) => segment === "..");
}

/**
 * Filter out OS-specific metadata files that get silently added by archive
 * utilities. These should never end up in the skill prefix:
 *   - `__MACOSX/*` — macOS Archive Utility resource forks. If we leave these
 *     in, wrapper-folder detection sees two top-level segments
 *     (`<skillname>/` and `__MACOSX/`) and skips the strip, breaking the
 *     "SKILL.md at root" check.
 *   - `.DS_Store` — macOS Finder folder metadata, can appear at any depth.
 *   - `Thumbs.db` / `desktop.ini` — Windows Explorer equivalents.
 */
function isOsJunkPath(path: string): boolean {
  if (path.startsWith("__MACOSX/")) return true;
  const basename = path.split("/").pop() ?? "";
  return (
    basename === ".DS_Store" ||
    basename === "Thumbs.db" ||
    basename === "desktop.ini"
  );
}

/**
 * Extract a skill bundle (zip or single SKILL.md) and upload its contents to
 * `skills/<skillId>/v1/...` in S3. Returns the number of files written.
 *
 * The route handler calls this after fetching the staging payload from S3 and
 * is the single place where path safety and size/count caps are enforced. The
 * function performs no DB writes — the caller is responsible for updating the
 * skill row's s3folder/current_version/history once extraction succeeds.
 *
 * Throws BundleValidationError for any validation failure. Throws other errors
 * for S3 upload or zip parsing infrastructure failures.
 */
export async function extractBundleToS3(
  opts: ExtractBundleOptions,
): Promise<ExtractBundleResult> {
  const { bytes, skillId, isZip, config } = opts;

  // Single SKILL.md case — straight upload at the canonical path.
  if (!isZip) {
    await uploadFile(
      bytes,
      `skills/${skillId}/v1/SKILL.md`,
      config,
      { contentType: "text/markdown" },
      undefined,
      undefined,
      true, // global=true so the key isn't user-prefixed (skill files are shared)
    );
    return { filesCount: 1 };
  }

  // Zip case.
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err: any) {
    throw new BundleValidationError(
      `Could not parse zip file: ${err?.message ?? "unknown error"}`,
    );
  }

  // Walk: collect non-directory, non-junk entries. OS metadata files
  // (__MACOSX/*, .DS_Store, Thumbs.db, desktop.ini) get filtered out here
  // so they don't pollute wrapper detection or S3.
  const entries: { path: string; entry: JSZip.JSZipObject }[] = [];
  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;
    if (isOsJunkPath(relativePath)) return;
    entries.push({ path: relativePath, entry });
  });

  if (entries.length === 0) {
    throw new BundleValidationError("Bundle is empty (no files inside the zip).");
  }

  if (entries.length > MAX_ENTRY_COUNT) {
    throw new BundleValidationError(
      `Bundle has ${entries.length} entries, exceeding the limit of ${MAX_ENTRY_COUNT}.`,
    );
  }

  // Path safety check across the whole archive before we touch S3.
  for (const { path } of entries) {
    if (isUnsafePath(path)) {
      throw new BundleValidationError(
        `Bundle contains an unsafe path: ${path}`,
      );
    }
  }

  // Detect a single top-level wrapper folder. Anthropic skill zips usually
  // come wrapped in a folder named after the skill (e.g. docx/SKILL.md);
  // stripping it lets us treat the inner layout as the skill root.
  let prefixToStrip = "";
  const firstSegments = new Set<string>();
  for (const { path } of entries) {
    const head = path.split("/")[0];
    if (head) firstSegments.add(head);
  }
  if (firstSegments.size === 1) {
    const single = [...firstSegments][0]!;
    const allWrapped = entries.every((e) => e.path.startsWith(single + "/"));
    if (allWrapped) prefixToStrip = single + "/";
  }

  const stripped = (path: string) =>
    prefixToStrip && path.startsWith(prefixToStrip)
      ? path.slice(prefixToStrip.length)
      : path;

  // Required: a SKILL.md at the (post-strip) root.
  const hasSkillMd = entries.some((e) => stripped(e.path) === "SKILL.md");
  if (!hasSkillMd) {
    throw new BundleValidationError(
      "Bundle must contain a SKILL.md file at the root.",
    );
  }

  // Pre-decompress + size-check ALL entries before any S3 write. Buffering
  // up to 50 MB in memory is acceptable and avoids the alternative of
  // leaving partial files in the skill prefix when a later entry trips the
  // size cap.
  type PreparedEntry = { relPath: string; content: Buffer };
  const prepared: PreparedEntry[] = [];
  let totalBytes = 0;

  for (const { path, entry } of entries) {
    const content = await entry.async("nodebuffer");
    totalBytes += content.byteLength;

    if (totalBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new BundleValidationError(
        `Bundle uncompressed size exceeds ${MAX_TOTAL_UNCOMPRESSED_BYTES} bytes (50 MB). ` +
          `Reached ${totalBytes} bytes at "${path}".`,
      );
    }

    const relPath = stripped(path);
    if (!relPath) continue; // wrapper folder root marker; nothing to upload
    prepared.push({ relPath, content });
  }

  // Upload pass. Sequential — skill bundles are small enough that
  // parallelism isn't worth the extra failure-handling complexity.
  let filesCount = 0;
  for (const { relPath, content } of prepared) {
    const s3Key = `skills/${skillId}/v1/${relPath}`;
    await uploadFile(
      content,
      s3Key,
      config,
      {},
      undefined,
      undefined,
      true, // global=true — see SKILL.md case above
    );
    filesCount += 1;
  }

  return { filesCount };
}
