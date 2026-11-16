export type FileOrigin = "agent" | "user";

/** S3 user-metadata key (sent as x-amz-meta-exulu-origin) marking files an agent wrote. */
export const ORIGIN_METADATA_KEY = "exulu-origin";

/** Anything not explicitly marked "agent" counts as a user file (legacy objects have no marker). */
export function originFromMetadata(metadata: Record<string, string> | undefined): FileOrigin {
  return metadata?.[ORIGIN_METADATA_KEY] === "agent" ? "agent" : "user";
}

/**
 * Resolves the origin of listed files via HeadObject, memoised per key+lastModified:
 * an overwrite changes lastModified and so invalidates the entry. A failing head is
 * "user" (and not cached, so a transient error does not stick).
 */
export function createOriginResolver(
  head: (key: string) => Promise<Record<string, string> | undefined>,
): (file: { key: string; lastModified: string | Date }) => Promise<FileOrigin> {
  const cache = new Map<string, FileOrigin>();
  return async (file) => {
    const stamp =
      file.lastModified instanceof Date ? file.lastModified.toISOString() : String(file.lastModified);
    const id = `${file.key}\u0000${stamp}`;
    const hit = cache.get(id);
    if (hit) return hit;
    try {
      const origin = originFromMetadata(await head(file.key));
      cache.set(id, origin);
      return origin;
    } catch {
      return "user";
    }
  };
}
