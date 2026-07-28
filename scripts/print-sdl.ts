// Emits the core GraphQL SDL for documentation purposes.
//
// Usage:
//   npx tsx scripts/print-sdl.ts /path/to/out/schema.graphql
//
// Notes:
// - Writes the SDL to the given file instead of stdout because module
//   side effects (createSDL and friends) log to stdout.
// - Mirrors the exact table list routes.ts passes to createSDL(). Tables
//   gated by checkLicense() are only present when EXULU_ENTERPRISE_LICENSE
//   is set (any value starting with "EXULU_EE_"); missing tables are
//   reported on stderr so docs generation can flag an incomplete schema.
// - Contexts, providers, tools and evals are deployment-specific, so they
//   are passed as empty arrays: the emitted SDL is the core schema every
//   deployment shares. QueueEnum falls back to NO_QUEUES for the same
//   reason (no queues are registered in this process).
import { writeFileSync } from "node:fs";
import { printSchema } from "graphql";
import { createSDL } from "@SRC/graphql/schemas/index.ts";
import { coreSchemas } from "@SRC/postgres/core-schema.ts";
import type { ExuluConfig } from "@SRC/exulu/app/index.ts";
import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";

const out = process.argv[2];
if (!out) throw new Error("usage: tsx scripts/print-sdl.ts <outfile>");

const schemas = coreSchemas.get();

// Keep in sync with the list createExpressRoutes passes to createSDL()
// in src/exulu/routes.ts.
const TABLE_FACTORIES = [
  "usersSchema",
  "skillsSchema",
  "rolesSchema",
  "agentsSchema",
  "feedbackSchema",
  "projectsSchema",
  "jobResultsSchema",
  "promptLibrarySchema",
  "contextPresetsSchema",
  "teamsSchema",
  "entityTypeSettingsSchema",
  "promptFavoritesSchema",
  "evalRunsSchema",
  "platformConfigurationsSchema",
  "evalSetsSchema",
  "testCasesSchema",
  "agentSessionsSchema",
  "agentMessagesSchema",
  "modelsSchema",
  "variablesSchema",
  "workflowTemplatesSchema",
  "statisticsSchema",
  "rbacSchema",
  "transcriptionJobsSchema",
] as const;

const missing = TABLE_FACTORIES.filter((name) => typeof schemas[name] !== "function");
if (missing.length > 0) {
  console.error(
    `[print-sdl] WARNING: ${missing.length} license-gated table(s) missing ` +
      `(set EXULU_ENTERPRISE_LICENSE to include them): ${missing.join(", ")}`,
  );
}

const tables: ExuluTableDefinition[] = TABLE_FACTORIES.filter(
  (name) => typeof schemas[name] === "function",
).map((name) => schemas[name]());

const schema = createSDL(
  tables,
  [], // contexts — dynamic per deployment, documented as patterns
  [], // tools — dynamic per deployment
  {} as ExuluConfig, // config — only threaded into resolvers, not the SDL shape
  [], // evals — dynamic per deployment
);

writeFileSync(out, printSchema(schema));
console.error(`[print-sdl] SDL written to ${out} (${tables.length}/${TABLE_FACTORIES.length} core tables)`);
