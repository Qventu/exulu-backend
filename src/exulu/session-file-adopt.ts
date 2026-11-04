import { normalizeS3Key, ownsObjectKey, deriveFilename } from "./shared-artifacts.ts";
import { sanitizeFilename } from "./session-files.ts";

/** The caller identity `planAdoptKeys` judges ownership against. Matches
 * `ownsObjectKey`'s parameter shape — see that function for the rule. */
export type AdoptPlanUser = {
  id: number;
  super_admin?: boolean | null;
  type?: string | null;
};

export type AdoptAccepted = { source: string; filename: string };
export type AdoptRejected = { key: string; reason: string };
export type AdoptPlan = { accepted: AdoptAccepted[]; rejected: AdoptRejected[] };

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
 * all-or-nothing comment).
 *
 * Order of checks, each one as a standalone allow/deny, never combined:
 *  1. shape — must be a non-empty string
 *  2. normalize — strip a leading bucket segment (`normalizeS3Key`)
 *  3. traversal — reject any normalized key containing ".."
 *  4. ownership — `ownsObjectKey` decides; this is an ALLOWLIST (only the
 *     caller's own `user_<id>/` or `user_api/` prefix, or super admin), not
 *     a denylist of known-bad prefixes like `global/`.
 */
export const planAdoptKeys = (
  keys: unknown,
  user: AdoptPlanUser,
  s3prefix: string | null | undefined,
  bucket: string,
): AdoptPlan => {
  const accepted: AdoptAccepted[] = [];
  const rejected: AdoptRejected[] = [];

  if (!Array.isArray(keys)) {
    // Nothing to iterate; the route treats an empty accepted set as "adopt
    // nothing" rather than inventing a rejection for a malformed body.
    return { accepted, rejected };
  }

  for (const raw of keys) {
    if (typeof raw !== "string" || !raw.trim()) {
      rejected.push({
        key: typeof raw === "string" ? raw : String(raw),
        reason: "Key must be a non-empty string.",
      });
      continue;
    }

    const normalized = normalizeS3Key(raw, bucket);

    if (normalized.includes("..")) {
      rejected.push({ key: raw, reason: "Key contains a path traversal segment." });
      continue;
    }

    if (!ownsObjectKey(normalized, user, s3prefix)) {
      rejected.push({ key: raw, reason: "You do not own this object." });
      continue;
    }

    const filename = sanitizeFilename(deriveFilename(normalized));
    if (!filename) {
      rejected.push({ key: raw, reason: "Could not derive a safe filename." });
      continue;
    }

    accepted.push({ source: normalized, filename });
  }

  return { accepted, rejected };
};
