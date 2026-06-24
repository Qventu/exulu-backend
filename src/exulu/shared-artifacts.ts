import bcrypt from "bcryptjs";

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
  if (!input.s3key) return { ok: false, message: "s3key is required." };
  if (!input.name) return { ok: false, message: "name is required." };
  const mode = input.auth_mode;
  if (mode !== "public" && mode !== "password" && mode !== "regular") {
    return { ok: false, message: "auth_mode must be public, password, or regular." };
  }
  if (mode === "password" && !input.password) {
    return { ok: false, message: "A password is required for password mode." };
  }
  if (input.expires_at && new Date(input.expires_at).getTime() <= now.getTime()) {
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
