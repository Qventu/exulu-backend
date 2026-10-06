// Fits a context's 3D projection and backfills chunk coordinates (spec 3c-1 §3).
// Usage: npx tsx scripts/fit-context-projection.ts --context <id> [--all]
//        [--sample 20000] [--components 50] [--dry-run]
// Every flag that takes a value accepts --flag=value as well as --flag value.
//
// Contexts are declared by the consuming application, so this script works from
// the database: --context names one, --all fits every base that has a chunks table.
import { postgresClient } from "../src/postgres/client";
import { fitContextProjection, listFittableContexts, residualScope } from "../src/exulu/projection/fit";
import { COMPONENTS, FIT_SAMPLE } from "../src/exulu/projection/constants";

const arg = (name: string): string | undefined => {
  // `--flag=value` first: it was silently unrecognised, so `--sample=5000` fitted
  // the 20000-vector default while looking like it had been asked for 5000.
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(`--${name}=`.length);
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

/** A flag's value must be a value, not the next flag (`--context --dry-run`). */
const value = (name: string): string | undefined => {
  const raw = arg(name);
  if (raw !== undefined && raw.startsWith("--")) {
    throw new Error(`--${name} needs a value, got the flag "${raw}"`);
  }
  return raw;
};

const positiveInt = (name: string, fallback: number): number => {
  const raw = value(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
};

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const all = process.argv.includes("--all");
  const only = value("context");
  if (!only && !all) throw new Error("Pass --context <id> or --all");
  const sample = positiveInt("sample", FIT_SAMPLE);
  const components = positiveInt("components", COMPONENTS);

  const { db } = await postgresClient();
  const targets = all ? await listFittableContexts(db) : [only!];
  if (targets.length === 0) throw new Error("No context with a chunks table was found");

  let failed = 0;
  for (const contextId of targets) {
    // Per context: one unfittable base (a stray table, a mid-run schema change)
    // must not abandon the contexts still to come, or undo the ones already done.
    try {
      const result = await fitContextProjection({
        db, contextId, sample, components, dryRun, log: (line) => console.log(`[EXULU] ${line}`),
      });
      console.log(
        result.fitted
          ? `[EXULU] ${contextId}: fitted ${result.components} components on ${result.sampleSize} vectors, residual ${result.residual.toFixed(3)} ${residualScope(result.heldOut)}, ${result.written} chunks written, ${result.topics} regions named${dryRun ? " (dry run)" : ""}`
          : `[EXULU] ${contextId}: skipped — ${result.reason}`,
      );
    } catch (error) {
      failed += 1;
      console.error(`[EXULU] ${contextId}: failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await db.destroy();
  if (failed > 0) {
    console.error(`[EXULU] ${failed} of ${targets.length} context(s) failed`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
