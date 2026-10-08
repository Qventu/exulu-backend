import bcrypt from "bcryptjs";
import type { Knex } from "knex";

export type ShareAuthMode = "public" | "password" | "regular";

export type CreateShareInput = {
  s3key?: string;
  name?: string;
  auth_mode?: string;
  password?: string;
  expires_at?: string | null;
  content_type?: string | null;
};

/** Strip a leading bucket segment so we always store/serve the bare object key. */
export const normalizeS3Key = (key: string, bucket: string): string => {
  const segments = key
    .split("/")
    .filter((s, i) => !(i === 0 && s === "")) // tolerate a leading slash
    .map((s) => decodeURIComponent(s));
  if (segments[0] === bucket) segments.shift();
  return segments.join("/");
};

export const isHtmlKey = (key: string): boolean => /\.html?$/i.test(key);

/** Basename, minus the `<id>_EXULU_` upload prefix used by the file picker. */
export const deriveFilename = (key: string): string => {
  const base = key.split("/").pop() ?? key;
  return base.split("_EXULU_").pop() ?? base;
};

export const slugifyShareName = (input: string): string =>
  deriveFilename(input)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const isExpired = (
  expiresAt: string | Date | null | undefined,
  now: Date,
): boolean => {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= now.getTime();
};

export const validateCreateInput = (
  input: CreateShareInput,
  now: Date,
): { ok: true } | { ok: false; message: string } => {
  // The security boundary of the viewer-identity capability. An agent creating
  // a share uses the caller's own token and is indistinguishable from the user
  // here, so this route must never be a path to the capability. Reject rather
  // than drop, so no caller believes it took effect.
  if ("grant_viewer_identity" in (input as Record<string, unknown>)) {
    return {
      ok: false,
      message:
        "grant_viewer_identity cannot be set when creating a share. " +
        "A platform administrator must grant it explicitly.",
    };
  }
  if (!input.s3key) return { ok: false, message: "s3key is required." };
  if (!input.name) return { ok: false, message: "name is required." };
  const mode = input.auth_mode;
  if (mode !== "public" && mode !== "password" && mode !== "regular") {
    return { ok: false, message: "auth_mode must be public, password, or regular." };
  }
  if (mode === "password" && !input.password) {
    return { ok: false, message: "A password is required for password mode." };
  }
  if (input.expires_at && Number.isNaN(new Date(input.expires_at).getTime())) {
    return { ok: false, message: "expires_at is not a valid date." };
  }
  if (input.expires_at && isExpired(input.expires_at, now)) {
    return { ok: false, message: "expires_at must be in the future." };
  }
  return { ok: true };
};

export const hashSharePassword = (password: string): Promise<string> =>
  bcrypt.hash(password, 10);

export const verifySharePassword = (
  password: string,
  hash: string,
): Promise<boolean> => bcrypt.compare(password, hash);

export const contentHeadersFor = (
  key: string,
  contentType: string | null,
  filename: string,
): { contentType: string; disposition?: string } => {
  if (isHtmlKey(key)) return { contentType: "text/html; charset=utf-8" };
  return {
    contentType: contentType || "application/octet-stream",
    disposition: `attachment; filename="${filename.replace(/"/g, "")}"`,
  };
};

export type PublicMeta = {
  auth_mode: string;
  expires_at: string | Date | null;
  filename: string;
  content_type: string | null;
  is_html: boolean;
  grant_viewer_identity: boolean;
};

/**
 * The unauthenticated `meta` payload. Only low-sensitivity fields: never the
 * password hash, never bytes.
 *
 * `grant_viewer_identity` is deliberately public. It tells an anonymous caller
 * which artifacts are identity-granting, which reveals no credential and does
 * not help obtain one — a grant still requires a logged-in session with RBAC
 * read access on the row.
 *
 * The `=== true` comparison is load-bearing: a null column, a missing column,
 * and a truthy non-boolean must all read as not-granted.
 */
export const publicMetaFor = (row: {
  auth_mode: string;
  expires_at?: string | Date | null;
  s3key: string;
  content_type?: string | null;
  grant_viewer_identity?: boolean | null;
}): PublicMeta => ({
  auth_mode: row.auth_mode,
  expires_at: row.expires_at ?? null,
  filename: deriveFilename(row.s3key),
  content_type: row.content_type ?? null,
  is_html: isHtmlKey(row.s3key),
  grant_viewer_identity: row.grant_viewer_identity === true,
});

/**
 * Granting viewer identity is equivalent to "this artifact may act as any of
 * its viewers" — the credential is the viewer's session token and is not scope
 * reduced. So it is a super-admin act, not a creator act: the creator may be
 * acting on an agent's behalf.
 */
export const authorizeIdentityGrant = (
  user: { super_admin?: boolean } | undefined,
): { ok: true } | { ok: false; code: number; message: string } => {
  if (!user) {
    return { ok: false, code: 401, message: "Authentication required." };
  }
  if (user.super_admin !== true) {
    return {
      ok: false,
      code: 403,
      message: "Only platform administrators can grant viewer identity.",
    };
  }
  return { ok: true };
};

/**
 * Strict boolean parse. A coerced `"false"` would silently enable the
 * capability, so anything that is not a real boolean is an error.
 */
export const parseIdentityGrantBody = (
  body: unknown,
): { ok: true; value: boolean } | { ok: false; message: string } => {
  const raw = (body as Record<string, unknown> | null | undefined)
    ?.grant_viewer_identity;
  if (typeof raw !== "boolean") {
    return { ok: false, message: "grant_viewer_identity must be a boolean." };
  }
  return { ok: true, value: raw };
};

export const getSharedArtifactByName = (db: Knex, name: string) =>
  db("shared_artifacts").where({ name }).first();
