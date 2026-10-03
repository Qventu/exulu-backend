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
/**
 * The rows whose ciphertext is worth touching: an explicit grant and nothing
 * else. Decryption is the expensive, failure-prone half of loading variables,
 * and §1 of the design says filter first — so an ungranted row's value is never
 * decrypted at all.
 */
export const selectRowsToDecrypt = (rows: Variable[]): Variable[] =>
    rows.filter((row) => Boolean(row?.name) && row.allow_skill_access === true);

/**
 * The withheld NAMES — never values — derived from the UNFILTERED row list.
 *
 * Deriving from the full list rather than from the decrypted subset is what
 * makes a failed decrypt visible: such a row is absent from `granted`, so it
 * is reported as withheld, which is what an operator needs to diagnose a
 * broken skill. Derived from the same list, a row with a bad name shape
 * (leading `_`, embedded `=`) is reported too.
 */
export const deriveWithheldNames = (
    rows: Variable[],
    granted: Record<string, string>,
): string[] => [
    ...new Set(
        rows
            .filter((row) => Boolean(row?.name))
            .map((row) => row.name)
            .filter((name) => !(name in granted)),
    ),
].sort();

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
