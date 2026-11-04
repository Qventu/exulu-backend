/**
 * Session files (side-panel uploads, email attachments, sandbox artifacts) are stored
 * under `[<s3prefix>/]user_<owner>/sessions/<session>/`. The OWNER is the session's
 * user, not whoever is currently talking: a routine session is created by the run-as
 * identity and later reviewed by a human, and a shared session may be continued by a
 * colleague. Every reader and writer must derive the prefix the same way, otherwise the
 * files exist in S3 but are invisible to the tools ("Er erkennt die Anhänge nicht").
 */

export type SessionOwnerSource = { user?: number | string | null } | null | undefined;

export function resolveSessionFileOwner(
  session: SessionOwnerSource,
  fallbackUserId: number | string,
): number | string {
  const owner = session?.user;
  return owner === null || owner === undefined || owner === "" ? fallbackUserId : owner;
}

export function sessionFilePrefix(
  ownerId: number | string,
  sessionId: string,
  s3prefix: string | undefined,
): string {
  const general = s3prefix ? `${s3prefix.replace(/\/+$/, "")}/` : "";
  return `${general}user_${ownerId}/sessions/${sessionId}/`;
}

/**
 * Sanitize a user-supplied filename. Reject anything that escapes the
 * intended directory; mostly defensive — a session-file write normally gets
 * here either via a presigned PUT whose key we already control (the
 * filename then arrives only as a label) or via the adopt route's own
 * `deriveFilename` output, but both still land here before touching disk/S3.
 */
export function sanitizeFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  if (trimmed.includes("..")) return "";
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) return "";
  // Replace path separators in the basename — uploads are flat per session,
  // no subdir creation through this route.
  return trimmed.replace(/[\\/]/g, "_");
}
