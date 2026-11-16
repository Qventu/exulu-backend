import { sanitizeFilename } from "./session-files.ts";

/** A project holds at most this many files; promote refuses to go past it. */
export const MAX_PROJECT_FILES = 200;
/** At most this many keys may be promoted in one request. */
export const MAX_PROMOTE_KEYS = 20;
/** Sandbox-visible directory / filename scope marker for project files. */
export const PROJECT_DIR = "project";

const generalPrefix = (s3prefix?: string | null) =>
  s3prefix ? `${s3prefix.replace(/\/+$/, "")}/` : "";

/**
 * Project files live under `[<s3prefix>/]projects/<projectId>/files/`, outside any user
 * prefix: a project is shared, so its files must not hang off one member's `user_<id>/`.
 * `projectPrefix` is what the list helper takes (it prepends the general prefix itself),
 * `fullProjectPrefix` is what S3 returns in object keys. Mirrors buildSessionPrefixes.
 */
export function projectFilePrefix(
  projectId: string,
  s3prefix?: string | null,
): { projectPrefix: string; fullProjectPrefix: string } {
  const projectPrefix = `projects/${projectId}/files/`;
  return { projectPrefix, fullProjectPrefix: `${generalPrefix(s3prefix)}${projectPrefix}` };
}

/** True for any key under `[<s3prefix>/]projects/`. */
export function isProjectKey(key: string, s3prefix?: string | null): boolean {
  return key.replace(/^\/+/, "").startsWith(`${generalPrefix(s3prefix)}projects/`);
}

/**
 * A filename the agent passes is either a session file ("a.pdf") or, with the
 * `project/` prefix, a project file. Project files are flat, like session files.
 */
export function parseProjectFilename(
  filename: string,
): { scope: "project"; name: string } | { scope: "session"; name: string } | { error: string } {
  const marker = `${PROJECT_DIR}/`;
  if (!filename.startsWith(marker)) return { scope: "session", name: filename };
  const rest = filename.slice(marker.length);
  if (!rest) return { error: "Project filename is empty." };
  if (rest.includes("..")) return { error: "Project filename must not contain '..'." };
  if (rest.includes("/") || rest.includes("\\")) {
    return { error: "Project files are flat; subdirectories are not allowed." };
  }
  const name = sanitizeFilename(rest);
  if (!name) return { error: "Project filename is not valid." };
  return { scope: "project", name };
}

export type PromotePlan = {
  accepted: { sourceKey: string; name: string; destKey: string }[];
  rejected: { key: string; reason: string }[];
  clashes: string[];
};

/**
 * Plan copying session files into a project. Checks per key, each standalone:
 * batch size, shape, traversal, ownership (must sit under the session prefix),
 * filename, collision inside the batch, collision with an existing project file
 * (reported in `clashes` unless `overwrite`), and finally the project file cap.
 */
export function planPromote(args: {
  keys: string[];
  fullSessionPrefix: string;
  fullProjectPrefix: string;
  existingNames: string[];
  overwrite: boolean;
}): PromotePlan {
  const { keys, fullSessionPrefix, fullProjectPrefix, existingNames, overwrite } = args;

  if (keys.length > MAX_PROMOTE_KEYS) {
    return {
      accepted: [],
      rejected: keys.map((key) => ({
        key: String(key),
        reason: `Batch exceeds the ${MAX_PROMOTE_KEYS}-key promote limit.`,
      })),
      clashes: [],
    };
  }

  const accepted: PromotePlan["accepted"] = [];
  const rejected: PromotePlan["rejected"] = [];
  const clashes: string[] = [];
  const existing = new Set(existingNames);
  // name -> accepted entry, or null once resolved as a batch collision
  const owners = new Map<string, PromotePlan["accepted"][number] | null>();

  for (const raw of keys) {
    if (typeof raw !== "string" || !raw.trim()) {
      rejected.push({ key: String(raw), reason: "Key must be a non-empty string." });
      continue;
    }
    const key = raw.replace(/^\/+/, "");
    if (key.includes("..")) {
      rejected.push({ key: raw, reason: "Key contains a path traversal segment." });
      continue;
    }
    if (!key.startsWith(fullSessionPrefix)) {
      rejected.push({ key: raw, reason: "Key is not a file of this session." });
      continue;
    }
    const name = sanitizeFilename(key.slice(fullSessionPrefix.length));
    if (!name) {
      rejected.push({ key: raw, reason: "Could not derive a safe filename." });
      continue;
    }

    if (owners.has(name)) {
      const first = owners.get(name);
      if (first) {
        const idx = accepted.indexOf(first);
        if (idx !== -1) accepted.splice(idx, 1);
        rejected.push({ key: first.sourceKey, reason: "Filename collides with another key in this batch." });
        owners.set(name, null);
      }
      rejected.push({ key: raw, reason: "Filename collides with another key in this batch." });
      continue;
    }

    if (existing.has(name) && !overwrite) {
      clashes.push(name);
      owners.set(name, null);
      continue;
    }

    const entry = { sourceKey: key, name, destKey: `${fullProjectPrefix}${name}` };
    accepted.push(entry);
    owners.set(name, entry);
  }

  // Overwritten names do not grow the project, so only count genuinely new ones.
  const newCount = accepted.filter((a) => !existing.has(a.name)).length;
  if (existing.size + newCount > MAX_PROJECT_FILES) {
    for (const a of accepted) {
      rejected.push({
        key: a.sourceKey,
        reason: `A project holds at most ${MAX_PROJECT_FILES} files.`,
      });
    }
    return { accepted: [], rejected, clashes };
  }

  return { accepted, rejected, clashes };
}
