import { normalizeS3Key, deriveFilename } from "./shared-artifacts.ts";
import { sanitizeFilename } from "./session-files.ts";

/** The caller identity `planAdoptKeys` judges ownership against. */
export type AdoptPlanUser = {
  id: number;
  super_admin?: boolean | null;
  type?: string | null;
};

/**
 * `key` is the raw string the caller sent, unchanged. `source` is the
 * canonical, bucket-and-leading-slash-stripped key actually used for the
 * S3 copy. Both are kept so every later consumer — the route's size-check
 * rejections included — can report the one identity (`key`) the caller
 * will recognise from what they sent, while the S3 operation still uses
 * the one value (`source`) that was actually judged for ownership.
 */
export type AdoptAccepted = { source: string; filename: string; key: string };
export type AdoptRejected = { key: string; reason: string };
export type AdoptPlan = { accepted: AdoptAccepted[]; rejected: AdoptRejected[] };

/**
 * Hard cap on how many keys a single adopt request may name. Nothing else
 * bounds batch size, and each accepted key is later downloaded whole into
 * this process's memory to mirror it into the sandbox (see
 * `downloadKeyIntoSandbox`) — an uncapped batch at the per-file size limit
 * is an uncapped amount of concurrent-request memory. Chosen generously
 * above any realistic "attach a few documents" use, not as a tight budget.
 */
export const MAX_ADOPT_KEYS = 20;

/**
 * Server-side mirror of the frontend's `MAX_UPLOAD_BYTES`
 * (frontend/app/(application)/chat/components/session-files/utils.ts).
 * An adopt path copies S3-to-S3 and never passes through the presigned-PUT
 * upload flow that constant otherwise guards, so this re-enforces it here.
 */
export const MAX_ADOPT_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Judge adopt ownership. Deliberately NOT `ownsObjectKey` from
 * shared-artifacts.ts, even though its rule is otherwise exactly what's
 * needed: that helper's first line is `if (user.super_admin === true)
 * return true`, which is correct for its one existing caller (a human
 * admin re-pointing a share through the admin settings UI) but wrong here.
 * The actor on this path is code running inside a sandboxed,
 * third-party-authored artifact iframe, carrying the *viewer's* JWT — if
 * the viewer happens to be a super admin, the bypass would let that iframe
 * name any key in the bucket and have it copied into a session for the
 * agent to read out. A classic confused deputy. This is a narrower,
 * adopt-only rule with no admin branch at all; `ownsObjectKey` itself is
 * untouched and stays correct for its existing caller.
 */
const ownsAdoptKey = (
  key: string,
  user: AdoptPlanUser,
  s3prefix: string | null | undefined,
): boolean => {
  const prefix = (s3prefix ?? "").replace(/\/+$/, "");
  const stripped = prefix && key.startsWith(`${prefix}/`) ? key.slice(prefix.length + 1) : key;
  const owner = user.type === "api" ? "api" : String(user.id);
  return stripped.startsWith(`user_${owner}/`);
};

/**
 * Decide which caller-supplied S3 keys may be copied into a session's file
 * prefix. This is the actual security boundary for the adopt endpoint: an
 * artifact running arbitrary front-end code hands us keys it got back from
 * its own upload calls, and this function is the only thing standing
 * between "the caller's own upload" and "any object in the bucket."
 *
 * Deliberately pure and S3-free (no network, no config object) so every
 * rejection rule can be unit tested directly. Each key is judged
 * independently; the route decides what to do with a mixed result (see its
 * all-or-nothing comment) — except a batch over `MAX_ADOPT_KEYS` or a
 * collision between two keys' derived filenames, both of which reject the
 * entire batch right here, for the same all-or-nothing reason the route
 * applies to everything else.
 *
 * Order of checks, each one as a standalone allow/deny, never combined:
 *  1. batch size — reject everything if the batch exceeds `MAX_ADOPT_KEYS`
 *  2. shape — must be a non-empty string
 *  3. normalize — strip a leading bucket segment and leading slashes
 *     (`normalizeS3Key`, then an explicit `replace`); this one resulting
 *     string is used for every later check AND as `source`/`accepted[].key`
 *     bookkeeping below, never re-derived
 *  4. well-formed — `normalizeS3Key` decodes each segment and throws on a
 *     malformed escape (e.g. a literal "%" in a filename); caught and
 *     rejected rather than left to crash the request
 *  5. traversal — reject any normalized key containing ".."
 *  6. ownership — `ownsAdoptKey` decides; this is an ALLOWLIST (only the
 *     caller's own `user_<id>/` or `user_api/` prefix, never a super-admin
 *     bypass), not a denylist of known-bad prefixes like `global/`.
 *  7. filename collision — two keys that derive the same stored filename
 *     would silently overwrite one another; both are rejected instead.
 */
export const planAdoptKeys = (
  keys: unknown,
  user: AdoptPlanUser,
  s3prefix: string | null | undefined,
  bucket: string,
): AdoptPlan => {
  if (!Array.isArray(keys)) {
    // Nothing to iterate; the route treats an empty accepted set as "adopt
    // nothing" rather than inventing a rejection for a malformed body.
    return { accepted: [], rejected: [] };
  }

  if (keys.length > MAX_ADOPT_KEYS) {
    return {
      accepted: [],
      rejected: keys.map((k) => ({
        key: typeof k === "string" ? k : String(k),
        reason: `Batch exceeds the ${MAX_ADOPT_KEYS}-key adopt limit.`,
      })),
    };
  }

  const accepted: AdoptAccepted[] = [];
  const rejected: AdoptRejected[] = [];
  // Tracks which accepted entry currently owns a derived filename, so a
  // second key deriving the same name can be rejected (and the first one
  // demoted out of `accepted`) instead of silently overwriting it at copy
  // time. `null` means "already resolved as a collision" — keeps a third
  // or later collider from re-reporting the first key again.
  const filenameOwners = new Map<string, AdoptAccepted | null>();

  for (const raw of keys) {
    if (typeof raw !== "string" || !raw.trim()) {
      rejected.push({
        key: typeof raw === "string" ? raw : String(raw),
        reason: "Key must be a non-empty string.",
      });
      continue;
    }

    let normalized: string;
    try {
      normalized = normalizeS3Key(raw, bucket).replace(/^\/+/, "");
    } catch {
      // normalizeS3Key decodeURIComponent-decodes each segment; a stray
      // "%" with no valid escape after it throws URIError. One malformed
      // key must not 500 the whole request.
      rejected.push({ key: raw, reason: "Key is not a valid S3 key." });
      continue;
    }

    if (normalized.includes("..")) {
      rejected.push({ key: raw, reason: "Key contains a path traversal segment." });
      continue;
    }

    if (!ownsAdoptKey(normalized, user, s3prefix)) {
      rejected.push({ key: raw, reason: "You do not own this object." });
      continue;
    }

    const filename = sanitizeFilename(deriveFilename(normalized));
    if (!filename) {
      rejected.push({ key: raw, reason: "Could not derive a safe filename." });
      continue;
    }

    if (filenameOwners.has(filename)) {
      const existing = filenameOwners.get(filename);
      if (existing) {
        const idx = accepted.indexOf(existing);
        if (idx !== -1) accepted.splice(idx, 1);
        rejected.push({ key: existing.key, reason: "Filename collides with another key in this batch." });
        filenameOwners.set(filename, null);
      }
      rejected.push({ key: raw, reason: "Filename collides with another key in this batch." });
      continue;
    }

    const entry: AdoptAccepted = { source: normalized, filename, key: raw };
    accepted.push(entry);
    filenameOwners.set(filename, entry);
  }

  return { accepted, rejected };
};

export type AdoptSizeCheck = { entry: AdoptAccepted; size: number | null };
export type AdoptSizeDecision =
  | { proceed: true }
  | { proceed: false; rejected: AdoptRejected[] };

/**
 * The all-or-nothing assembly decision for the size-check pass: given each
 * accepted entry paired with its live HeadObject size (null if the HEAD
 * failed), decide whether to proceed with the whole batch or refuse all of
 * it. Pulled out as its own pure function — rather than inlined in the
 * route — so this invariant is directly testable; the route itself has no
 * supertest seam in this codebase to verify it any other way. Mirrors
 * `planAdoptKeys`'s all-or-nothing contract exactly: one oversized or
 * missing source zeroes out the whole batch, and every rejection reports
 * `entry.key` (the raw string the caller sent), the same identity
 * `planAdoptKeys`'s own rejections use — not `entry.source`, which can
 * differ from what the caller sent (e.g. a bucket-prefixed key).
 */
export const planAdoptSizeCheck = (
  checks: AdoptSizeCheck[],
  maxBytes: number,
): AdoptSizeDecision => {
  const rejected: AdoptRejected[] = [];
  for (const { entry, size } of checks) {
    if (size === null) {
      rejected.push({ key: entry.key, reason: "Source object not found." });
    } else if (size > maxBytes) {
      rejected.push({
        key: entry.key,
        reason: `File exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MB upload limit.`,
      });
    }
  }
  if (rejected.length > 0) return { proceed: false, rejected };
  return { proceed: true };
};
