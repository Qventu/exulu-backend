// Regenerates api-reference/graphql/schema.graphql from the backend checkout.
//
// Usage:
//   npm run sdl
//   BACKEND_REPO=/path/to/backend node scripts/emit-graphql-sdl.mjs
//
// Requires bun (the backend runtime): the backend imports CJS packages with
// named-import syntax that Node's ESM loader rejects, and bun resolves the
// backend's tsconfig path aliases (@SRC, @EE, @EXULU_TYPES) natively.
//
// EXULU_ENTERPRISE_LICENSE is set for the child process so license-gated
// tables (roles, teams, feedback, evals, workflow templates, job results)
// are included — the reference documents the complete core schema.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSchema } from "graphql";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = process.env.BACKEND_REPO ?? join(ROOT, "..", "backend");
const OUT = join(ROOT, "api-reference", "graphql", "schema.graphql");

if (!existsSync(join(BACKEND, "scripts", "print-sdl.ts"))) {
  throw new Error(`backend checkout with scripts/print-sdl.ts not found at ${BACKEND}`);
}

execFileSync("bun", ["scripts/print-sdl.ts", OUT], {
  cwd: BACKEND,
  stdio: "inherit",
  env: {
    ...process.env,
    // Any value with the EXULU_EE_ prefix enables the license-gated tables;
    // print-sdl.ts never talks to external services.
    EXULU_ENTERPRISE_LICENSE: process.env.EXULU_ENTERPRISE_LICENSE || "EXULU_EE_DOCS_SDL",
  },
});

// Sanity: the emitted SDL must parse and contain the full core surface.
const schema = buildSchema(readFileSync(OUT, "utf8"));
const typeCount = Object.keys(schema.getTypeMap()).filter((t) => !t.startsWith("__")).length;
if (typeCount <= 100) {
  throw new Error(`schema.graphql looks incomplete — only ${typeCount} named types`);
}
console.log(`schema.graphql OK — ${typeCount} named types`);
