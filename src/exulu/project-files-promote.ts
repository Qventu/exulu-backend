import { planAdoptSizeCheck, MAX_ADOPT_UPLOAD_BYTES } from "./session-file-adopt.ts";
import { planPromote, projectFilePrefix } from "./project-files.ts";

export const COPY_FAILED_REASON = "Copying the file into the project failed.";

export type PromoteS3 = {
  /** Names (not keys) of the files currently in the project folder. */
  listProjectNames: (projectPrefix: string) => Promise<string[]>;
  /** Size in bytes, null when the object is missing. */
  sizeOf: (key: string) => Promise<number | null>;
  copy: (sourceKey: string, destKey: string) => Promise<void>;
};

export type PromoteResult = {
  promoted: { key: string; name: string; sourceKey: string }[];
  rejected: { key: string; reason: string }[];
  clashes: string[];
};

/**
 * Copy session files into a project folder. Free of req/res so the HTTP route and
 * the agent's save_to_project tool share one set of rules. Nothing is copied when
 * any name clashes (unless `overwrite`) or when a source is missing / over the
 * 50 MB total cap: the caller asks the user first, then retries.
 */
export async function promoteSessionFiles(args: {
  projectId: string;
  s3prefix?: string | null;
  keys: string[];
  fullSessionPrefix: string;
  overwrite: boolean;
  s3: PromoteS3;
}): Promise<PromoteResult> {
  const { projectPrefix, fullProjectPrefix } = projectFilePrefix(args.projectId, args.s3prefix);
  const existingNames = await args.s3.listProjectNames(projectPrefix);
  const plan = planPromote({
    keys: args.keys,
    fullSessionPrefix: args.fullSessionPrefix,
    fullProjectPrefix,
    existingNames,
    overwrite: args.overwrite,
  });
  const rejected = [...plan.rejected];

  if (plan.clashes.length > 0 || plan.accepted.length === 0) {
    return { promoted: [], rejected, clashes: plan.clashes };
  }

  // Per-file existence plus the whole batch against one budget: adopt caps each
  // file at 50 MB, promote caps the sum, as it can reach 20 files.
  const sizes: { key: string; size: number | null }[] = [];
  for (const a of plan.accepted) sizes.push({ key: a.sourceKey, size: await args.s3.sizeOf(a.sourceKey) });
  const perFile = planAdoptSizeCheck(
    plan.accepted.map((a, i) => ({
      entry: { key: a.sourceKey, source: a.sourceKey, filename: a.name },
      size: sizes[i]!.size,
    })),
    MAX_ADOPT_UPLOAD_BYTES,
  );
  const total = sizes.reduce((sum, s) => sum + (s.size ?? 0), 0);
  if (!perFile.proceed || total > MAX_ADOPT_UPLOAD_BYTES) {
    const reasons = !perFile.proceed ? perFile.rejected : [];
    const byKey = new Map(reasons.map((r) => [r.key, r.reason]));
    for (const a of plan.accepted) {
      rejected.push({
        key: a.sourceKey,
        reason: byKey.get(a.sourceKey) ?? "The batch exceeds the 50MB total limit.",
      });
    }
    return { promoted: [], rejected, clashes: [] };
  }

  // Per copy, not per batch: a failure midway must not lose track of what already
  // landed in the project, or the caller would report a clean failure for a half-done batch.
  const promoted: PromoteResult["promoted"] = [];
  for (const a of plan.accepted) {
    try {
      await args.s3.copy(a.sourceKey, a.destKey);
      promoted.push({ key: a.destKey, name: a.name, sourceKey: a.sourceKey });
    } catch (err) {
      console.error("[PROJECT-FILES] copy failed", a.sourceKey, err);
      rejected.push({ key: a.sourceKey, reason: COPY_FAILED_REASON });
    }
  }
  return { promoted, rejected, clashes: [] };
}

export type MoveS3 = PromoteS3 & {
  /** Delete one object by its full key. */
  remove: (key: string) => Promise<void>;
};

export type MoveResult = {
  /** Names now in the project whose session original is gone. */
  moved: string[];
  /** Names that stayed in the session, with why. Never a file that is in neither place. */
  notMoved: { name: string; reason: string }[];
  /** Copied, but the session original could not be deleted: the file exists in BOTH places. */
  originalsKept: string[];
  /** Copied, and the original deliberately kept because an earlier message refers to its key. */
  keptForHistory: string[];
};

/**
 * Move session files into a project: promote (copy) each batch, then delete the session
 * original of each file whose copy succeeded, and only of those (decided by SOURCE key, so a
 * name that sanitisation changes is not lost). Every input file ends up in exactly one of
 * moved / notMoved / originalsKept / keptForHistory; in no case in neither place. `batches`
 * come from planMove (at most 20 keys / 50 MB each); a batch that fails as a whole (a thrown S3
 * error) leaves all its files in the session. Keys in `keepOriginalKeys` are copied but never deleted.
 */
export async function moveSessionFiles(args: {
  projectId: string;
  s3prefix?: string | null;
  fullSessionPrefix: string;
  batches: { key: string; name: string }[][];
  s3: MoveS3;
  keepOriginalKeys?: Set<string>;
}): Promise<MoveResult> {
  const result: MoveResult = { moved: [], notMoved: [], originalsKept: [], keptForHistory: [] };
  for (const batch of args.batches) {
    let outcome: PromoteResult;
    try {
      outcome = await promoteSessionFiles({
        projectId: args.projectId,
        s3prefix: args.s3prefix,
        keys: batch.map((f) => f.key),
        fullSessionPrefix: args.fullSessionPrefix,
        overwrite: false,
        s3: args.s3,
      });
    } catch (err) {
      console.error("[PROJECT-FILES] move batch failed", err);
      for (const f of batch) result.notMoved.push({ name: f.name, reason: COPY_FAILED_REASON });
      continue;
    }
    const copied = new Set(outcome.promoted.map((p) => p.sourceKey));
    const rejectedBy = new Map(outcome.rejected.map((r) => [r.key, r.reason]));
    for (const f of batch) {
      if (!copied.has(f.key.replace(/^\/+/, ""))) {
        result.notMoved.push({
          name: f.name,
          reason: rejectedBy.get(f.key) ?? "A file with this name is already in the project.",
        });
        continue;
      }
      if (args.keepOriginalKeys?.has(f.key)) {
        result.keptForHistory.push(f.name);
        continue;
      }
      try {
        await args.s3.remove(f.key);
        result.moved.push(f.name);
      } catch (err) {
        console.error("[PROJECT-FILES] could not delete session original after copy", f.key, err);
        result.originalsKept.push(f.name);
      }
    }
  }
  return result;
}
