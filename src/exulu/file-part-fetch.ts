import { parseStoredFileUrl, type StoreIdentity } from "./stored-file-url";
import { MAX_ADOPT_UPLOAD_BYTES } from "./session-file-adopt";

/**
 * Loads the bytes of a document file part from a user message.
 *
 * The part URL is user input (guest chats reach this unauthenticated), and the body
 * ends up in the prompt, so the server must never act as a generic fetch proxy: only
 * `data:` URLs (decoded locally) and URLs on the configured S3 host/bucket are loaded.
 * Anything else — a foreign host, another bucket, an internal address, another
 * scheme — is refused without a request being made.
 */

/** Same ceiling as an upload: nothing bigger can legitimately be attached. */
export const MAX_FILE_PART_BYTES = MAX_ADOPT_UPLOAD_BYTES;
export const FILE_PART_FETCH_TIMEOUT_MS = 30_000;

export type FilePartBytes = { ok: true; bytes: Buffer } | { ok: false; error: string };

export type LoadFilePartOptions = {
  /** The configured store; undefined when file uploads are not configured. */
  store?: StoreIdentity;
  /** The URL to fetch for a stored file: the re-signed one when allowed, else the original. */
  fetchUrl?: string;
  maxBytes?: number;
  timeoutMs?: number;
};

const mb = (bytes: number) => `${Math.floor(bytes / (1024 * 1024))}MB`;

export function decodeDataUrl(url: string): Buffer | undefined {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0) return undefined;
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  if (meta.split(";").includes("base64")) return Buffer.from(payload, "base64");
  try {
    return Buffer.from(decodeURIComponent(payload), "utf8");
  } catch {
    return Buffer.from(payload, "utf8");
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer | undefined> {
  const declared = Number(response.headers?.get?.("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) return undefined;
  if (!response.body) {
    const whole = Buffer.from(await response.arrayBuffer());
    return whole.length > maxBytes ? undefined : whole;
  }
  // Stream and stop as soon as the cap is crossed: a missing or lying
  // content-length must not let a body grow unbounded in memory.
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function loadFilePartBytes(
  partUrl: string | undefined,
  filename: string,
  opts: LoadFilePartOptions,
): Promise<FilePartBytes> {
  const maxBytes = opts.maxBytes ?? MAX_FILE_PART_BYTES;
  const tooLarge = `[Error: Could not load file ${filename}: the file is larger than the ${mb(maxBytes)} attachment limit.]`;

  if (typeof partUrl === "string" && partUrl.startsWith("data:")) {
    const bytes = decodeDataUrl(partUrl);
    if (!bytes) return { ok: false, error: `[Error: Could not load file ${filename}]` };
    if (bytes.length > maxBytes) return { ok: false, error: tooLarge };
    return { ok: true, bytes };
  }

  // Only the workspace's own storage. The fetched URL may be a re-signed one, but the
  // decision is made on the URL the client sent: re-signing never changes host/bucket.
  if (!opts.store || !parseStoredFileUrl(partUrl, opts.store)) {
    console.warn(`[EXULU] refusing to fetch file part "${filename}" from outside the configured storage`);
    return {
      ok: false,
      error: `[Error: Could not load file ${filename}: only files from this workspace's storage can be attached.]`,
    };
  }
  const target = opts.fetchUrl ?? partUrl!;
  if (!parseStoredFileUrl(target, opts.store)) {
    return {
      ok: false,
      error: `[Error: Could not load file ${filename}: only files from this workspace's storage can be attached.]`,
    };
  }

  let response: Response;
  try {
    response = await fetch(target, {
      // A redirect could point anywhere (internal addresses included); storage never needs one.
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? FILE_PART_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "the download timed out" : "the download failed";
    console.error(`[EXULU] Failed to fetch file ${filename}:`, error);
    return { ok: false, error: `[Error: Could not load file ${filename}: ${reason}.]` };
  }
  if (response.status >= 300 && response.status < 400) {
    return { ok: false, error: `[Error: Could not load file ${filename}: redirects are not followed.]` };
  }
  if (!response.ok) {
    console.error(`[EXULU] Failed to fetch file: ${filename}, status: ${response.status} `);
    return { ok: false, error: `[Error: Could not load file ${filename}]` };
  }
  try {
    const bytes = await readCapped(response, maxBytes);
    if (!bytes) return { ok: false, error: tooLarge };
    return { ok: true, bytes };
  } catch (error) {
    console.error(`[EXULU] Failed to read file ${filename}:`, error);
    return { ok: false, error: `[Error: Could not load file ${filename}: the download failed.]` };
  }
}
