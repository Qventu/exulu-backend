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
