import type { Variable } from "@EXULU_TYPES/models/variable";

/**
 * Select the subset of configured `variables` rows that an administrator has
 * explicitly granted to the skill sandbox, keyed by name -> decrypted value.
 *
 * Pure and side-effect free so it can be unit tested without pulling in
 * create-sandbox.ts's import graph (S3, postgres, sandbox-runtime). Callers
 * are responsible for decrypting `row.value` before calling this — rows here
 * are expected to already carry plaintext values.
 *
 * `allow_skill_access !== true` excludes anything but an explicit true,
 * including a legacy `null` from rows written before this column existed.
 *
 * Names starting with `_` or containing `=` stay excluded regardless of the
 * grant — those shapes corrupt POSIX env parsing or shadow shell internals.
 */
export const selectGrantedVariables = (rows: Variable[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const row of rows) {
        if (!row?.name) continue;
        if (row.allow_skill_access !== true) continue;
        if (row.name.startsWith("_")) continue;
        if (row.name.includes("=")) continue;
        if (typeof row.value !== "string") continue;
        out[row.name] = row.value;
    }
    return out;
};
