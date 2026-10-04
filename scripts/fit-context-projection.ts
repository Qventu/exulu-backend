// Fits a context's 3D projection and backfills chunk coordinates (spec 3c-1 §3).
// Usage: npx tsx scripts/fit-context-projection.ts --context <id> [--all]
//        [--sample 20000] [--components 50] [--dry-run]
//
// Contexts are declared by the consuming application, so this script works from
// the database: --context names one, --all fits every base that has a chunks table.
import { postgresClient } from "../src/postgres/client";
import { fitContextProjection, listFittableContexts } from "../src/exulu/projection/fit";
import { COMPONENTS, FIT_SAMPLE } from "../src/exulu/projection/constants";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const all = process.argv.includes("--all");
  const only = arg("context");
  if (!only && !all) throw new Error("Pass --context <id> or --all");
  const sample = Number(arg("sample") ?? FIT_SAMPLE);
  const components = Number(arg("components") ?? COMPONENTS);

  const { db } = await postgresClient();
  const targets = all ? await listFittableContexts(db) : [only!];
  if (targets.length === 0) throw new Error("No context with a chunks table was found");

  for (const contextId of targets) {
    const result = await fitContextProjection({
      db, contextId, sample, components, dryRun, log: (line) => console.log(`[EXULU] ${line}`),
    });
    console.log(
      result.fitted
        ? `[EXULU] ${contextId}: fitted ${result.components} components on ${result.sampleSize} vectors, residual ${result.residual.toFixed(3)}, ${result.written} chunks written${dryRun ? " (dry run)" : ""}`
        : `[EXULU] ${contextId}: skipped — ${result.reason}`,
    );
  }
  await db.destroy();
}

main().catch((e) => { console.error(e); process.exit(1); });
