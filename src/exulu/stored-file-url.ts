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
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;

  if (store.endpoint) {
    let endpoint: URL;
    try {
      endpoint = new URL(store.endpoint);
    } catch {
      return undefined;
    }
    if (parsed.host !== endpoint.host) return undefined;
    const base = stripTrailingSlash(endpoint.pathname);
    const prefix = `${base}/${store.bucket}/`;
    if (!parsed.pathname.startsWith(prefix)) return undefined;
    const key = decodeKey(parsed.pathname.slice(prefix.length));
    return key ? { bucket: store.bucket, key } : undefined;
  }

  // AWS virtual-host style: <bucket>.s3[.<region>].amazonaws.com/<key>
  if (!parsed.host.startsWith(`${store.bucket}.s3`) || !parsed.host.endsWith(".amazonaws.com")) {
    return undefined;
  }
  const key = decodeKey(parsed.pathname);
  return key ? { bucket: store.bucket, key } : undefined;
}

/**
 * Re-signs `url` when it belongs to the configured store; returns the original URL
 * for anything else or when signing fails (best effort — the old URL may still be valid).
 */
export async function resolveFreshFileUrl(
  url: string | undefined,
  opts: StoreIdentity & { sign: (bucket: string, key: string) => Promise<string> },
): Promise<string | undefined> {
  const location = parseStoredFileUrl(url, opts);
  if (!location) return url;
  try {
    return await opts.sign(location.bucket, location.key);
  } catch (err) {
    console.warn(`[EXULU] could not re-sign stored file URL for key "${location.key}":`, err);
    return url;
  }
}
