import { planAdoptSizeCheck, MAX_ADOPT_UPLOAD_BYTES } from "./session-file-adopt.ts";
import { planPromote, projectFilePrefix } from "./project-files.ts";

export type PromoteS3 = {
  /** Names (not keys) of the files currently in the project folder. */
  listProjectNames: (projectPrefix: string) => Promise<string[]>;
  /** Size in bytes, null when the object is missing. */
  sizeOf: (key: string) => Promise<number | null>;
  copy: (sourceKey: string, destKey: string) => Promise<void>;
};

export type PromoteResult = {
  promoted: { key: string; name: string }[];
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
      promoted.push({ key: a.destKey, name: a.name });
    } catch (err) {
      console.error("[PROJECT-FILES] copy failed", a.sourceKey, err);
      rejected.push({ key: a.sourceKey, reason: "Copying the file into the project failed." });
    }
  }
  return { promoted, rejected, clashes: [] };
}
