/**
 * Persisted file parts carry presigned S3/MinIO URLs that expire after a day. A session
 * continued later (an approval click, a follow-up, a routine step) hands those URLs to the
 * model, which can no longer download the files. The object key is still in the URL path,
 * so the URL can be re-signed on load.
 */

export type StoredFileLocation = { bucket: string; key: string };

export type StoreIdentity = {
  /** Custom S3-compatible endpoint (path-style URLs). Undefined for AWS virtual-host URLs. */
  endpoint?: string;
  bucket?: string;
};

const stripTrailingSlash = (s: string) => s.replace(/\/+$/, "");
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function decodeKey(rawPath: string): string {
  const key = rawPath.replace(/^\/+/, "");
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

/**
 * Returns the bucket/key of a stored file URL when it points at the configured store,
 * otherwise undefined (data: URLs, foreign hosts, other buckets).
 */
export function parseStoredFileUrl(
  url: string | undefined,
  store: StoreIdentity,
): StoredFileLocation | undefined {
  if (!url || !store.bucket) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (store.endpoint) {
    let endpoint: URL;
    try {
      endpoint = new URL(store.endpoint);
    } catch {
      return undefined;
    }
    // Same protocol as the configured endpoint: an http: URL to an https: store is
    // not something the store hands out.
    if (parsed.protocol !== endpoint.protocol || parsed.host !== endpoint.host) return undefined;
    const base = stripTrailingSlash(endpoint.pathname);
    const prefix = `${base}/${store.bucket}/`;
    if (!parsed.pathname.startsWith(prefix)) return undefined;
    const key = decodeKey(parsed.pathname.slice(prefix.length));
    return key ? { bucket: store.bucket, key } : undefined;
  }

  // AWS: https only, and the host anchored exactly (a bucket called "<bucket>.s3x"
  // or a look-alike domain must not match).
  if (parsed.protocol !== "https:") return undefined;
  const region = "([.-][a-z0-9-]+)?";
  // Virtual-host style: <bucket>.s3[.<region>|-<region>].amazonaws.com/<key>
  if (new RegExp(`^${escapeRegExp(store.bucket)}\\.s3${region}\\.amazonaws\\.com$`).test(parsed.host)) {
    const key = decodeKey(parsed.pathname);
    return key ? { bucket: store.bucket, key } : undefined;
  }
  // Path style: s3[.<region>].amazonaws.com/<bucket>/<key> — what the SDK emits for
  // dotted bucket names.
  if (new RegExp(`^s3${region}\\.amazonaws\\.com$`).test(parsed.host)) {
    const prefix = `/${store.bucket}/`;
    if (!parsed.pathname.startsWith(prefix)) return undefined;
    const key = decodeKey(parsed.pathname.slice(prefix.length));
    return key ? { bucket: store.bucket, key } : undefined;
  }
  return undefined;
}

/**
 * Whether a stored file key may be re-signed for this turn. A fresh presigned URL is a
 * read capability, and the key comes straight out of a user-message URL that anyone can
 * hand-write, so only keys the session may already read qualify: the session OWNER's
 * `user_<id>/` prefix (a shared session still shows the owner's uploads), the SPEAKER's
 * `user_<id>/` prefix (`user_api/` for an API speaker — where its uploads land, see
 * uppy signOnServer), and `global/`. Never project files (`projects/…`) nor another
 * user's files: they are read through routes that check access. `key` is the object key
 * WITHOUT bucket; when a general prefix is configured, the key must carry it.
 */
export function mayResignStoredFileKey(
  key: string,
  ctx: {
    s3prefix?: string | null;
    ownerId?: number | string | null;
    speaker?: { id?: number | string | null; type?: string | null } | null;
  },
): boolean {
  if (key.split("/").includes("..")) return false;
  let rest = key.replace(/^\/+/, "");
  const general = (ctx.s3prefix ?? "").replace(/\/+$/, "");
  if (general) {
    if (!rest.startsWith(`${general}/`)) return false;
    rest = rest.slice(general.length + 1);
  }
  const allowed = ["global/"];
  if (ctx.ownerId != null && ctx.ownerId !== "") allowed.push(`user_${ctx.ownerId}/`);
  if (ctx.speaker?.type === "api") allowed.push("user_api/");
  else if (ctx.speaker?.id != null && ctx.speaker.id !== "") allowed.push(`user_${ctx.speaker.id}/`);
  return allowed.some((p) => rest.startsWith(p));
}

/**
 * Re-signs `url` when it belongs to the configured store AND `mayResign` accepts its key
 * (see mayResignStoredFileKey); returns the original URL for anything else or when
 * signing fails (best effort — the old URL may still be valid).
 */
export async function resolveFreshFileUrl(
  url: string | undefined,
  opts: StoreIdentity & {
    sign: (bucket: string, key: string) => Promise<string>;
    mayResign: (key: string) => boolean;
  },
): Promise<string | undefined> {
  const location = parseStoredFileUrl(url, opts);
  if (!location) return url;
  if (!opts.mayResign(location.key)) {
    console.warn(`[EXULU] not re-signing stored file URL outside the session's own files: "${location.key}"`);
    return url;
  }
  try {
    return await opts.sign(location.bucket, location.key);
  } catch (err) {
    console.warn(`[EXULU] could not re-sign stored file URL for key "${location.key}":`, err);
    return url;
  }
}
