# Agentic Retrieval Pipeline (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `ee/agentic-retrieval/v3` (step-loop engine) with a config-driven port of newlkiag's 4-phase retrieval pipeline under the same tool id `agentic_context_search`, plus a new `json` config option type and a standalone saved-config migration script.

**Architecture:** A deterministic pipeline (memory + routing in parallel → main/fallback search in parallel → rerank/select → memory-override step) built from small modules in `ee/agentic-retrieval/pipeline/`. All client-specific behavior from newlkiag (context roles, category routing, glossary, identifier vocabularies, thresholds) moves into five `json`-typed tool config options parsed by zod with hard defaults. Every LLM micro-call degrades gracefully: on failure the feature it powers is skipped, retrieval still returns results.

**Tech Stack:** TypeScript (Node), zod, Vercel `ai` SDK (`generateText` + `Output.object`), fuse.js (new dep), knex/Postgres via existing `ExuluContext.search`, LiteLLM reranker via existing `resolveReranker`, Jest (ts-jest).

**Spec:** `docs/superpowers/specs/2026-07-03-agentic-retrieval-pipeline-design.md`. This is plan 1 of 3 (backend). Frontend wizard and newlkiag migration are separate plans.

## Global Constraints

- Tool identity is UNCHANGED: id `agentic_context_search`, name `Context Search`, `type: "context"` via `ExuluTool.internal`, `needsApproval: false`, EE gate `checkLicense()["agentic-retrieval"]`.
- Package export becomes `ExuluDefaultTools.agentic.retrieval.create.pipeline`. NO `.v3` alias. The `ExuluTrajectoryRegistry` export is removed.
- Port source of truth (readable on this machine): `/Users/daniel.claessen/Desktop/Projects/newlkiag/src/`. Referred to below as `NEWLKIAG`.
- Path aliases: `@SRC/*` → `src/*`, `@EE/*` → `ee/*`, `@EXULU_TYPES/*` → `types/*` (tsconfig + jest.config.cjs both map them).
- Degradation rule (spec §6): a failed LLM micro-call or missing reranker must never fail the run — skip the feature, log a warning, keep retrieving. Gates yield user-facing messages; never `throw` for user-input problems.
- Output contract: streamed cumulative `{ result: JSON.stringify(AgenticRetrievalOutput) }` yields, where `AgenticRetrievalOutput = { steps, reasoning, chunks: [], usage: [], totalTokens: 0 }` and retrieved passages live in `steps[].chunks` (same as both current implementations).
- Tuning defaults (spec §3.2): topK 5, fallbackThreshold 0.95, pinBoost 0.15, identifierBoost 0.15, pageWindow 1, maxQueriesPerContext 5. RRF k = 60 (constant). Chunk-group max = 10 (constant). Fuzzy prefilter cutoff = 2.5 (constant, `DEFAULT_PREFILTER_CUTOFF`).
- Kind presets (spec §3.2): documents `{limit 100, expand 7, multiQuery true, hyde true}`, conversations `{limit 20, expand 5, multiQuery false, hyde false, keyword prefilter}`, records `{limit 20, expand 2, multiQuery false, hyde false}`.
- Per-setting precedence: `knowledge_bases[ctx].overrides` > `ctx.configuration` (expand/cutoffs/maxRetrievalResults) > kind preset.
- Tests: Jest, colocated `*.test.ts`, run with `npx jest <path> --silent`. Mock the `ai` module and Exulu contexts; no DB access in tests.
- Commit after every task with the trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File Structure

```
ee/agentic-retrieval/pipeline/
  config.ts        zod schemas + defaults for the 5 json options, flat coercion, KIND_PRESETS, effectiveKbSettings()
  types.ts         PhaseStep, phase results, RerankState/Result, AgenticRetrievalOutput, ChunkWithScore
  text-utils.ts    normalizeFileName, normalizeText, stripSeparators, deriveKeywordVariants, extractIdentifierTokens, itemMatchesIdentifierToken, applyRewrites
  prefilter.ts     item cache, fuzzyPrefilter (Fuse), exactTokenPrefilter, resolveIdentifierPins (LLM, config-driven)
  hyde.ts          generateHydePassage (generic prompt + styleHint), promise cache
  multi-query.ts   singleSearch, multiQuerySearch, RRF merge
  routing.ts       runRoutingPhase (explicit-KB, doc/page detection, rule classification)
  memory.ts        runMemoryPhase (keyword recall, relevance, override, file pins, augmentation)
  search.ts        searchContexts / searchOneContext (kind dispatch, pin semantics)
  rerank.ts        grouping, rerank, boosts, page filter, no-reranker fallback
  index.ts         createAgenticRetrievalTool factory: config declaration, gates, orchestration
  *.test.ts        one per module
scripts/migrate-agentic-retrieval-config.ts   standalone dev-run migration (+ .test.ts next to it in scripts/)
```

Modified: `src/exulu/tool.ts`, `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`, `src/utils/enabled-tools.ts`, `src/graphql/utilities/sanitize-and-hydrate-fields.ts`, `src/graphql/schemas/index.ts`, `src/index.ts`, `jest.config.cjs`, `package.json`.
Deleted: `ee/agentic-retrieval/v3/` (entire directory).

---

### Task 1: `json` config option type in the platform

**Files:**
- Modify: `src/exulu/tool.ts:44-49` and `:69-74` (config type union, both occurrences)
- Modify: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts:82-130` (`hydrateVariables` — add json branch, export the function)
- Test: `src/templates/tools/hydrate-variables.test.ts`

**Interfaces:**
- Consumes: existing `hydrateVariables(tool: ExuluAgentToolConfig)` (currently module-private).
- Produces: config options may declare `type: "json"`; after hydration `toolConfig.value` is the parsed object (or `undefined` when empty/unparseable — consumers fall back to their declared defaults). `hydrateVariables` becomes a named export.

- [ ] **Step 1: Write the failing test**

```ts
// src/templates/tools/hydrate-variables.test.ts
import { hydrateVariables } from "./convert-exulu-tools-to-ai-sdk-tools";

// hydrateVariables only touches the DB for type:"variable"; json/boolean/number/string
// never reach postgres. Mock the client so importing the module never connects.
jest.mock("@SRC/postgres/client", () => ({
  postgresClient: async () => ({ db: jest.fn() }),
}));

const toolWith = (config: any[]) => ({ id: "t", type: "function", name: "t", config }) as any;

describe("hydrateVariables json type", () => {
  it("parses a valid json string into an object value", async () => {
    const tool = toolWith([{ name: "routing", type: "json", variable: '{"rules":[{"id":"a"}]}' }]);
    const result = await hydrateVariables(tool);
    expect(result.config[0].value).toEqual({ rules: [{ id: "a" }] });
  });

  it("leaves value undefined on unparseable json (consumer falls back to defaults)", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const tool = toolWith([{ name: "routing", type: "json", variable: "{not json" }]);
    const result = await hydrateVariables(tool);
    expect(result.config[0].value).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("passes through an already-parsed object value", async () => {
    const tool = toolWith([{ name: "memory", type: "json", variable: { enabled: true } }]);
    const result = await hydrateVariables(tool);
    expect(result.config[0].value).toEqual({ enabled: true });
  });

  it("keeps boolean coercion behavior unchanged", async () => {
    const tool = toolWith([{ name: "flag", type: "boolean", variable: "true" }]);
    const result = await hydrateVariables(tool);
    expect(result.config[0].value).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/templates/tools/hydrate-variables.test.ts --silent`
Expected: FAIL — `hydrateVariables` is not exported.

- [ ] **Step 3: Implement**

In `src/exulu/tool.ts`, change BOTH config type declarations (class field at line 44-49 and constructor param at line 69-74) from
`type: "boolean" | "string" | "number" | "variable";` to
`type: "boolean" | "string" | "number" | "variable" | "json";`
and widen both `default?: string | boolean | number;` to `default?: string | boolean | number | object;`.

In `convert-exulu-tools-to-ai-sdk-tools.ts`, change `const hydrateVariables = async (…)` to `export const hydrateVariables = async (…)` and insert a json branch after the `string` branch (line 99-102):

```ts
    } else if (type === "json") {
      if (typeof toolConfig.variable === "object") {
        toolConfig.value = toolConfig.variable;
        return toolConfig;
      }
      try {
        toolConfig.value = JSON.parse(toolConfig.variable.toString());
      } catch (err) {
        console.warn(
          `[EXULU] Config option "${toolConfig.name}" holds invalid JSON — falling back to the tool's declared default.`,
          err,
        );
        toolConfig.value = undefined;
      }
      return toolConfig;
    }
```

Also update `types/models/exulu-agent-tool-config.ts` and `types/models/agent.ts:36-46`: add `"json"` to their config `type` unions (both files declare the union literally).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/templates/tools/hydrate-variables.test.ts --silent`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exulu/tool.ts src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts src/templates/tools/hydrate-variables.test.ts types/models/exulu-agent-tool-config.ts types/models/agent.ts
git commit -m "feat(tools): add json config option type with hydration parsing"
```

---

### Task 2: Pipeline config schemas (`config.ts`) + jest `ee/` roots

**Files:**
- Create: `ee/agentic-retrieval/pipeline/config.ts`
- Modify: `jest.config.cjs` (line `roots: ["<rootDir>/src"]` → `roots: ["<rootDir>/src", "<rootDir>/ee"]`)
- Test: `ee/agentic-retrieval/pipeline/config.test.ts`

**Interfaces:**
- Produces (exact, later tasks depend on these names):

```ts
export type KbKind = "documents" | "conversations" | "records";
export type KbProfile = { enabled: boolean; kind: KbKind; instructions: string;
  overrides: { limit?: number; expand?: number; multiQuery?: boolean; hyde?: boolean } };
export type RoutingRule = { id: string; label: string; description: string; main: string[]; fallback: string[] };
export type IdentifierSet = { name: string; description: string; examples: string[];
  strategy: "fuzzy" | "exact"; contexts: string[] };
export type PipelineConfig = {
  instructions: string; reranker: string; managedContext: boolean;
  requirePreselectedContexts: boolean; logging: boolean; utilityModel: string;
  knowledgeBases: Record<string, KbProfile>;
  routing: { rules: RoutingRule[] };
  vocabulary: { glossary: { term: string; meaning: string }[]; identifiers: IdentifierSet[];
    rewrites: { find: string; replace: string }[]; styleHint: string };
  memory: { enabled: boolean; override: boolean; filePrioritization: boolean; queryAugmentation: boolean };
  tuning: { topK: number; fallbackThreshold: number; pinBoost: number; identifierBoost: number;
    pageWindow: number; maxQueriesPerContext: number };
};
export function parsePipelineConfig(raw?: Record<string, unknown>): PipelineConfig;
export type EffectiveKbSettings = { kind: KbKind; instructions: string; limit: number;
  expand: { before: number; after: number } | undefined;
  cutoffs: { cosineDistance?: number; tsvector?: number; hybrid?: number } | undefined;
  multiQuery: boolean; hyde: boolean; keywordPrefilter: boolean };
export function effectiveKbSettings(profile: KbProfile | undefined, ctx: { configuration?: any }): EffectiveKbSettings;
export const KIND_PRESETS: Record<KbKind, { limit: number; expand: number; multiQuery: boolean; hyde: boolean; keywordPrefilter: boolean }>;
export const DEFAULT_PREFILTER_CUTOFF = 2.5;
```

- [ ] **Step 1: Write the failing test**

```ts
// ee/agentic-retrieval/pipeline/config.test.ts
import { parsePipelineConfig, effectiveKbSettings, KIND_PRESETS } from "./config";

describe("parsePipelineConfig", () => {
  it("returns full defaults for an empty/missing config", () => {
    const cfg = parsePipelineConfig(undefined);
    expect(cfg.tuning).toEqual({ topK: 5, fallbackThreshold: 0.95, pinBoost: 0.15,
      identifierBoost: 0.15, pageWindow: 1, maxQueriesPerContext: 5 });
    expect(cfg.memory).toEqual({ enabled: true, override: false, filePrioritization: false, queryAugmentation: true });
    expect(cfg.routing.rules).toEqual([]);
    expect(cfg.knowledgeBases).toEqual({});
    expect(cfg.managedContext).toBe(false);
    expect(cfg.reranker).toBe("none");
  });

  it("accepts parsed objects and JSON strings for json options", () => {
    const cfg = parsePipelineConfig({
      routing: { rules: [{ id: "tech", label: "T", description: "d", main: ["a"], fallback: [] }] },
      tuning: '{"topK": 8}',
      managed_context: "true",
    });
    expect(cfg.routing.rules[0].id).toBe("tech");
    expect(cfg.tuning.topK).toBe(8);
    expect(cfg.tuning.fallbackThreshold).toBe(0.95); // partial json keeps other defaults
    expect(cfg.managedContext).toBe(true);
  });

  it("falls back to defaults on malformed json values", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = parsePipelineConfig({ vocabulary: "{oops", memory: 42 });
    expect(cfg.vocabulary.glossary).toEqual([]);
    expect(cfg.memory.enabled).toBe(true);
    warn.mockRestore();
  });
});

describe("effectiveKbSettings", () => {
  it("applies kind presets", () => {
    const s = effectiveKbSettings({ enabled: true, kind: "documents", instructions: "", overrides: {} }, {});
    expect(s).toMatchObject({ limit: 100, expand: { before: 7, after: 7 }, multiQuery: true, hyde: true });
    expect(KIND_PRESETS.conversations.keywordPrefilter).toBe(true);
  });

  it("precedence: overrides > context.configuration > preset", () => {
    const ctx = { configuration: { expand: { before: 3, after: 3 }, cutoffs: { hybrid: 1.1 }, maxRetrievalResults: 40 } };
    const s = effectiveKbSettings({ enabled: true, kind: "documents", instructions: "", overrides: { limit: 60 } }, ctx);
    expect(s.limit).toBe(60);                       // override wins
    expect(s.expand).toEqual({ before: 3, after: 3 }); // context config beats preset
    expect(s.cutoffs).toEqual({ hybrid: 1.1 });
  });

  it("defaults a missing profile to enabled documents", () => {
    const s = effectiveKbSettings(undefined, {});
    expect(s.kind).toBe("documents");
  });
});
```

- [ ] **Step 2: Update `jest.config.cjs` roots, run test to verify it fails**

Change `roots: ["<rootDir>/src"],` to `roots: ["<rootDir>/src", "<rootDir>/ee"],`.
Run: `npx jest ee/agentic-retrieval/pipeline/config.test.ts --silent`
Expected: FAIL — cannot find module `./config`.

- [ ] **Step 3: Implement `config.ts`**

```ts
// ee/agentic-retrieval/pipeline/config.ts
import { z } from "zod";

export const KB_KINDS = ["documents", "conversations", "records"] as const;
export type KbKind = (typeof KB_KINDS)[number];

export const DEFAULT_PREFILTER_CUTOFF = 2.5;
export const RRF_K = 60;
export const CHUNK_GROUP_MAX = 10;

const kbProfileSchema = z.object({
  enabled: z.boolean().default(true),
  kind: z.enum(KB_KINDS).default("documents"),
  instructions: z.string().default(""),
  overrides: z
    .object({
      limit: z.number().int().positive().optional(),
      expand: z.number().int().min(0).optional(),
      multiQuery: z.boolean().optional(),
      hyde: z.boolean().optional(),
    })
    .default({}),
});
const knowledgeBasesSchema = z.record(z.string(), kbProfileSchema);

const routingRuleSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  main: z.array(z.string()),
  fallback: z.array(z.string()).default([]),
});
const routingSchema = z.object({ rules: z.array(routingRuleSchema).default([]) });

const identifierSetSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  examples: z.array(z.string()).default([]),
  strategy: z.enum(["fuzzy", "exact"]),
  contexts: z.array(z.string()).default([]),
});
const vocabularySchema = z.object({
  glossary: z.array(z.object({ term: z.string(), meaning: z.string() })).default([]),
  identifiers: z.array(identifierSetSchema).default([]),
  rewrites: z.array(z.object({ find: z.string(), replace: z.string() })).default([]),
  styleHint: z.string().default(""),
});
const memorySchema = z.object({
  enabled: z.boolean().default(true),
  override: z.boolean().default(false),
  filePrioritization: z.boolean().default(false),
  queryAugmentation: z.boolean().default(true),
});
const tuningSchema = z.object({
  topK: z.number().int().positive().default(5),
  fallbackThreshold: z.number().min(0).max(1).default(0.95),
  pinBoost: z.number().min(0).max(1).default(0.15),
  identifierBoost: z.number().min(0).max(1).default(0.15),
  pageWindow: z.number().int().min(0).default(1),
  maxQueriesPerContext: z.number().int().positive().default(5),
});

export type KbProfile = z.infer<typeof kbProfileSchema>;
export type RoutingRule = z.infer<typeof routingRuleSchema>;
export type IdentifierSet = z.infer<typeof identifierSetSchema>;

export type PipelineConfig = {
  instructions: string;
  reranker: string;
  managedContext: boolean;
  requirePreselectedContexts: boolean;
  logging: boolean;
  utilityModel: string;
  knowledgeBases: Record<string, KbProfile>;
  routing: z.infer<typeof routingSchema>;
  vocabulary: z.infer<typeof vocabularySchema>;
  memory: z.infer<typeof memorySchema>;
  tuning: z.infer<typeof tuningSchema>;
};

const boolVal = (v: unknown): boolean => v === true || v === "true" || v === 1;
const strVal = (v: unknown, fallback: string): string =>
  typeof v === "string" && v.length > 0 ? v : fallback;

/** Parse one json-typed option: accepts an object (already hydrated), a JSON string,
 * or anything else (→ schema default). Schema failures fall back to defaults with a warning. */
function jsonVal<S extends z.ZodTypeAny>(name: string, schema: S, v: unknown): z.infer<S> {
  let candidate: unknown = v;
  if (typeof v === "string" && v.trim().length > 0) {
    try {
      candidate = JSON.parse(v);
    } catch (err) {
      console.warn(`[EXULU pipeline] config "${name}" is not valid JSON — using defaults.`, err);
      candidate = undefined;
    }
  } else if (typeof v !== "object" || v === null) {
    candidate = undefined;
  }
  if (candidate !== undefined) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    console.warn(`[EXULU pipeline] config "${name}" failed validation — using defaults.`, parsed.error.message);
  }
  return schema.parse(defaultFor(name));
}

function defaultFor(name: string): unknown {
  switch (name) {
    case "knowledge_bases": return {};
    case "routing": return { rules: [] };
    case "vocabulary": return { glossary: [], identifiers: [], rewrites: [], styleHint: "" };
    case "memory": return {};
    case "tuning": return {};
    default: return {};
  }
}

export function parsePipelineConfig(raw?: Record<string, unknown>): PipelineConfig {
  const r = raw ?? {};
  return {
    instructions: strVal(r["instructions"], ""),
    reranker: strVal(r["reranker"], "none"),
    managedContext: boolVal(r["managed_context"]),
    requirePreselectedContexts: boolVal(r["require_preselected_contexts"]),
    logging: boolVal(r["logging"]),
    utilityModel: strVal(r["utility_model"], ""),
    knowledgeBases: jsonVal("knowledge_bases", knowledgeBasesSchema, r["knowledge_bases"]),
    routing: jsonVal("routing", routingSchema, r["routing"]),
    vocabulary: jsonVal("vocabulary", vocabularySchema, r["vocabulary"]),
    memory: jsonVal("memory", memorySchema, r["memory"]),
    tuning: jsonVal("tuning", tuningSchema, r["tuning"]),
  };
}

export const KIND_PRESETS: Record<
  KbKind,
  { limit: number; expand: number; multiQuery: boolean; hyde: boolean; keywordPrefilter: boolean }
> = {
  documents: { limit: 100, expand: 7, multiQuery: true, hyde: true, keywordPrefilter: false },
  conversations: { limit: 20, expand: 5, multiQuery: false, hyde: false, keywordPrefilter: true },
  records: { limit: 20, expand: 2, multiQuery: false, hyde: false, keywordPrefilter: false },
};

export type EffectiveKbSettings = {
  kind: KbKind;
  instructions: string;
  limit: number;
  expand: { before: number; after: number } | undefined;
  cutoffs: { cosineDistance?: number; tsvector?: number; hybrid?: number } | undefined;
  multiQuery: boolean;
  hyde: boolean;
  keywordPrefilter: boolean;
};

/** Precedence per setting: profile.overrides > ctx.configuration > kind preset. */
export function effectiveKbSettings(
  profile: KbProfile | undefined,
  ctx: { configuration?: { expand?: { before?: number; after?: number }; cutoffs?: any; maxRetrievalResults?: number } },
): EffectiveKbSettings {
  const kind: KbKind = profile?.kind ?? "documents";
  const preset = KIND_PRESETS[kind];
  const o = profile?.overrides ?? {};
  const conf = ctx.configuration ?? {};
  const expandN = o.expand ?? undefined;
  const expand = expandN !== undefined
    ? expandN === 0 ? undefined : { before: expandN, after: expandN }
    : conf.expand && (conf.expand.before || conf.expand.after)
      ? { before: conf.expand.before ?? 0, after: conf.expand.after ?? 0 }
      : { before: preset.expand, after: preset.expand };
  return {
    kind,
    instructions: profile?.instructions ?? "",
    limit: o.limit ?? conf.maxRetrievalResults ?? preset.limit,
    expand,
    cutoffs: conf.cutoffs ?? undefined,
    multiQuery: o.multiQuery ?? preset.multiQuery,
    hyde: o.hyde ?? preset.hyde,
    keywordPrefilter: preset.keywordPrefilter,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest ee/agentic-retrieval/pipeline/config.test.ts --silent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ee/agentic-retrieval/pipeline/config.ts ee/agentic-retrieval/pipeline/config.test.ts jest.config.cjs
git commit -m "feat(retrieval): pipeline config schemas with zod defaults; run jest over ee/"
```

---

### Task 3: Pipeline types + text utilities

**Files:**
- Create: `ee/agentic-retrieval/pipeline/types.ts`
- Create: `ee/agentic-retrieval/pipeline/text-utils.ts`
- Test: `ee/agentic-retrieval/pipeline/text-utils.test.ts`

**Interfaces:**
- Produces `types.ts` (exact — every later task imports from here):

```ts
import type { VectorSearchChunkResult } from "@SRC/graphql/resolvers/vector-search";

export type Chunk = VectorSearchChunkResult;
export type ChunkWithScore = Chunk & { rerank_score?: number; context?: { id: string; name: string } };

export type PhaseStep = {
  text: string;
  chunks?: ChunkWithScore[];
  toolCalls?: Array<{ name: string; id: string; input: unknown }>;
};

export type RoutingPhaseResult = {
  mainContexts: string[];
  fallbackContexts: string[];
  userPinnedItemIdsByContext: Map<string, Set<string>>;
  userRequestedPage: number | null;
  hasExplicitDocAndPage: boolean;
  steps: PhaseStep[];
};

export type MemoryPhaseResult = {
  memoryChunksForAnswer: ChunkWithScore[];
  memoryOverride: { active: boolean; chunks: ChunkWithScore[]; reason: string };
  memoryPinnedItemIds: Set<string>;
  updatedQuestion: string;
  updatedKeywords: string[];
  updatedImportantKeyword: string;
  steps: PhaseStep[];
};

export type SearchContextsResult = { chunks: Chunk[] };

export type RerankState = {
  pinnedItemIds: Set<string>;
  userPinnedItemIds: Set<string>;
  userRequestedPage: number | null;
  keywords: string[];
  importantKeyword: string;
};
export type RerankResult = {
  limited_results: ChunkWithScore[];
  sorted_reranked_results: ChunkWithScore[];
  rerank_score_max_genuine: number;
};

export type RetrievalStep = {
  stepNumber: number;
  text: string;
  toolCalls: Array<{ name: string; id: string; input: unknown }>;
  chunks: ChunkWithScore[];
  tokens: number;
};
export type AgenticRetrievalOutput = {
  steps: RetrievalStep[];
  reasoning: { text: string; tools: unknown[] }[];
  chunks: ChunkWithScore[];
  usage: unknown[];
  totalTokens: number;
};
```

- Produces `text-utils.ts`: `normalizeFileName(fileName: string): string`, `normalizeText(text: string): string`, `stripSeparators(s: string): string`, `deriveKeywordVariants(keyword: string): string[]`, `extractIdentifierTokens(parts: Array<string | undefined>): string[]`, `itemMatchesIdentifierToken(itemName: string | undefined, tokens: string[]): boolean`, `applyRewrites(question: string, rewrites: { find: string; replace: string }[]): string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// ee/agentic-retrieval/pipeline/text-utils.test.ts
import {
  normalizeFileName, deriveKeywordVariants, extractIdentifierTokens,
  itemMatchesIdentifierToken, applyRewrites, stripSeparators,
} from "./text-utils";

describe("text-utils", () => {
  it("normalizeFileName strips the bucket segment, separators, and extension", () => {
    expect(normalizeFileName("/bucket/folder/hb_PAM-E4_2023.de.pdf")).toBe("folder hbpame42023 de pdf");
  });

  it("deriveKeywordVariants yields lowercased, separator- and digit-stripped forms ≥4 chars", () => {
    expect(deriveKeywordVariants("FST-2XT").sort()).toEqual(["fst-2xt", "fst2xt"].sort());
    expect(deriveKeywordVariants("MISCEL6")).toEqual(expect.arrayContaining(["miscel6", "miscel"]));
    expect(deriveKeywordVariants("ab")).toEqual([]); // too short
  });

  it("extractIdentifierTokens keeps ≥4-char tokens containing a digit and a letter", () => {
    expect(extractIdentifierTokens(["FST-2XT", "sperren", "S2", undefined])).toEqual(["fst2xt"]);
  });

  it("itemMatchesIdentifierToken matches separator-insensitively against the filename", () => {
    expect(itemMatchesIdentifierToken("hb_FST-2XT_manual.pdf", ["fst2xt"])).toBe(true);
    expect(itemMatchesIdentifierToken("hb_FST2_manual.pdf", ["fst2xt"])).toBe(false);
  });

  it("applyRewrites returns one variant per matching rule, none when nothing matches", () => {
    const rules = [{ find: "bypass", replace: "override" }, { find: "zzz", replace: "yyy" }];
    expect(applyRewrites("how to bypass the door", rules)).toEqual(["how to override the door"]);
    expect(applyRewrites("hello", rules)).toEqual([]);
  });

  it("stripSeparators lowers and removes separators", () => {
    expect(stripSeparators("FST-2 XT.a")).toBe("fst2xta");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest ee/agentic-retrieval/pipeline/text-utils.test.ts --silent`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `types.ts` exactly as in the Interfaces block above.

Create `text-utils.ts`: copy `normalizeFileName` and `normalizeText` verbatim from `NEWLKIAG/src/utils/s3-path-info.ts:1-34` (drop `s3PathInfo`). Copy `deriveKeywordVariants` from `NEWLKIAG/src/tools/newton-memory.ts:45-54` verbatim. Copy `extractModelTokens` / `itemMatchesModelToken` from `NEWLKIAG/src/utils/retrieval-recall.ts:20-40`, renamed `extractIdentifierTokens` / `itemMatchesIdentifierToken` (logic unchanged; `itemMatchesIdentifierToken` inlines `normalizeFileName` from this module). Add:

```ts
export const stripSeparators = (s: string): string => s.toLowerCase().replace(/[-_\.\s]/g, "");

/** Apply configured find→replace rules (case-insensitive, all occurrences).
 * Returns one rewritten query per rule that changed the input; deduped. */
export function applyRewrites(
  question: string,
  rewrites: { find: string; replace: string }[],
): string[] {
  const out = new Set<string>();
  for (const rule of rewrites) {
    if (!rule.find) continue;
    const escaped = rule.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rewritten = question.replace(new RegExp(escaped, "gi"), rule.replace);
    if (rewritten !== question) out.add(rewritten);
  }
  return [...out];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest ee/agentic-retrieval/pipeline/text-utils.test.ts --silent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ee/agentic-retrieval/pipeline/types.ts ee/agentic-retrieval/pipeline/text-utils.ts ee/agentic-retrieval/pipeline/text-utils.test.ts
git commit -m "feat(retrieval): pipeline types and language-neutral text utilities"
```

---

### Task 4: Prefilter module (fuzzy + exact matchers, config-driven identifier pins)

**Files:**
- Modify: `package.json` (add `fuse.js`)
- Create: `ee/agentic-retrieval/pipeline/prefilter.ts`
- Test: `ee/agentic-retrieval/pipeline/prefilter.test.ts`

**Interfaces:**
- Consumes: `stripSeparators`, `normalizeFileName` (Task 3), `DEFAULT_PREFILTER_CUTOFF`, `IdentifierSet` (Task 2), `withRetry` from `@SRC/utils/with-retry`.
- Produces:

```ts
export type PrefilteredResult = { key: string; name: string; id: string };
export function clearPrefilterCaches(): void; // test hook
export async function fuzzyPrefilter(opts: {
  cacheKey: string;
  relevantKeywords: string[];
  importantKeyword?: string;
  context: { id: string; getItems: (o: any) => Promise<any[]> };
  fields: string[];
  normalize: (item: any) => string | undefined;
  cutoff?: number;           // default DEFAULT_PREFILTER_CUTOFF
  limit?: number;            // default 30
}): Promise<PrefilteredResult[]>;
export async function exactTokenPrefilter(opts: {
  cacheKey: string;
  tokens: string[];
  context: { id: string; getItems: (o: any) => Promise<any[]> };
  fields: string[];
  normalize: (item: any) => string | undefined;
  minTokenLength?: number;   // default 3
  limit?: number;            // default 30
}): Promise<PrefilteredResult[]>;
export async function resolveIdentifierPins(opts: {
  question: string;
  identifierSets: IdentifierSet[];
  contextsById: Map<string, any>;         // ExuluContext-like
  kbKindById: Map<string, KbKind>;
  model: any;                              // LanguageModel
}): Promise<{
  pinsByContext: Map<string, Set<string>>;       // narrow-only (fuzzy) + boost (exact) pins per context
  exactPinsByContext: Map<string, Set<string>>;  // subset from strategy:"exact" sets (rerank-boosted)
  steps: PhaseStep[];
}>;
```

- [ ] **Step 1: Install fuse.js and write the failing test**

Run: `npm install fuse.js`

```ts
// ee/agentic-retrieval/pipeline/prefilter.test.ts
import { fuzzyPrefilter, exactTokenPrefilter, resolveIdentifierPins, clearPrefilterCaches } from "./prefilter";

jest.mock("ai", () => ({ generateText: jest.fn() }));
import { generateText } from "ai";

const items = [
  { id: "1", name: "FST-2XT Manual", external_id: "/b/hb_FST-2XT_manual.pdf" },
  { id: "2", name: "ECO Guide", external_id: "/b/eco_guide.pdf" },
  { id: "3", name: "ISO 8100-1", external_id: "/b/din_en_iso_8100-1.pdf" },
];
const ctx = (id: string) => ({ id, getItems: jest.fn(async () => items) });

beforeEach(() => {
  clearPrefilterCaches();
  (generateText as jest.Mock).mockReset();
});

describe("exactTokenPrefilter", () => {
  it("matches exact separator-stripped substrings only", async () => {
    const r = await exactTokenPrefilter({
      cacheKey: "t1", tokens: ["8100-1"], context: ctx("c"), fields: ["name", "id", "external_id"],
      normalize: (i) => i.external_id,
    });
    expect(r.map((x) => x.id)).toEqual(["3"]);
  });
  it("ignores tokens shorter than minTokenLength", async () => {
    const r = await exactTokenPrefilter({
      cacheKey: "t2", tokens: ["81"], context: ctx("c"), fields: ["name"], normalize: (i) => i.external_id,
    });
    expect(r).toEqual([]);
  });
});

describe("fuzzyPrefilter", () => {
  it("finds items whose normalized name matches the keywords", async () => {
    const r = await fuzzyPrefilter({
      cacheKey: "t3", relevantKeywords: ["FST-2XT"], context: ctx("c"),
      fields: ["name", "id", "external_id"], normalize: (i) => i.external_id,
    });
    expect(r.map((x) => x.id)).toContain("1");
    expect(r.map((x) => x.id)).not.toContain("2");
  });
});

describe("resolveIdentifierPins", () => {
  it("runs one extraction call per identifier set and routes pins to the set's contexts", async () => {
    (generateText as jest.Mock).mockResolvedValue({
      output: { hasMatches: true, matches: ["FST-2XT", "FST"] },
    });
    const c = ctx("docs");
    const r = await resolveIdentifierPins({
      question: "Wie sperre ich die Tür beim FST-2XT?",
      identifierSets: [{ name: "Product names", description: "", examples: ["FST"], strategy: "fuzzy", contexts: ["docs"] }],
      contextsById: new Map([["docs", c]]),
      kbKindById: new Map([["docs", "documents"]]),
      model: {},
    });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect([...(r.pinsByContext.get("docs") ?? [])]).toContain("1");
    expect(r.exactPinsByContext.get("docs")).toBeUndefined(); // fuzzy sets don't boost
  });

  it("degrades to no pins when extraction fails", async () => {
    (generateText as jest.Mock).mockRejectedValue(new Error("llm down"));
    const r = await resolveIdentifierPins({
      question: "q",
      identifierSets: [{ name: "Norms", description: "", examples: ["ISO 8100"], strategy: "exact", contexts: ["docs"] }],
      contextsById: new Map([["docs", ctx("docs")]]),
      kbKindById: new Map([["docs", "documents"]]),
      model: {},
    });
    expect(r.pinsByContext.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest ee/agentic-retrieval/pipeline/prefilter.test.ts --silent`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `prefilter.ts`**

Port from `NEWLKIAG/src/utils/prefilter.ts` with these exact changes, then add `resolveIdentifierPins` (new):

1. `ensureItemsCache` (lines 22-66): port as-is, but key the cache map by the `cacheKey` param; fix the stale-TTL bug (`five_minutes_ago` is computed once at module load in the original) by checking `Date.now() - cache.tsp.getTime() > 5 * 60 * 1000`; drop the `fs` import (unused) and the `console.log` noise (keep one debug log). Add `export function clearPrefilterCaches() { itemCaches = {}; }`.
2. `exactTokenPrefiltering` (lines 76-116): port as `exactTokenPrefilter` with the `cacheKey` param renamed from `name`; logic unchanged.
3. `keywordBasedPrefiltering` (lines 118-362): port as `fuzzyPrefilter` with these changes: (a) `configuration: PrefilterConfiguration` param becomes `cutoff?: number` defaulting to `DEFAULT_PREFILTER_CUTOFF`; (b) **remove the German stemming blocks** — delete every `keywordStem`/`importantStem` computation (`.replace(/ung$/...)` chains at lines 210-224, 239-251, 265-280) and their stem-match checks, keeping the exact and separator-flexible matching; (c) keep the Fuse options, match-ratio penalties (×1.5/×3/×10), title boost (0.6^n), and important-keyword boosts (×0.5, ×0.4) verbatim; (d) reduce logging to one summary `console.log`.
4. Add the config-driven extraction (new code):

```ts
import { generateText, Output } from "ai";
import { z } from "zod";
import { withRetry } from "@SRC/utils/with-retry";
import { normalizeFileName } from "./text-utils";
import { DEFAULT_PREFILTER_CUTOFF, type IdentifierSet, type KbKind } from "./config";
import type { PhaseStep } from "./types";

const FUZZY_EXTRACTION_PROMPT = (set: IdentifierSet) => `
You are checking whether the user's question references any "${set.name}".
${set.description ? set.description + "\n" : ""}Examples of such identifiers: ${set.examples.join(", ")}.
If the question references one, return it BOTH as its stem and its full version.
For example, for "${set.examples[0] ?? "ABC-1"}-3" return "${set.examples[0] ?? "ABC-1"}" and "${set.examples[0] ?? "ABC-1"}-3".
If the question references none, return an empty array and hasMatches set to false.`;

const EXACT_EXTRACTION_PROMPT = (set: IdentifierSet) => `
You are checking whether the user's question references any "${set.name}".
${set.description ? set.description + "\n" : ""}Examples: ${set.examples.join(", ")}.
If it does, return hasMatches true and matches: a list of search tokens used to find the
matching document by its file name. Include BOTH the full identifier and useful partial
forms — the bare number on its own, and each individual part when a multi-part identifier
is referenced (e.g. "ISO 8100-1-2" must yield "8100-1" AND "8100-2").
Do NOT include generic single words on their own.
If the question references none, return hasMatches false and an empty array.`;

export async function resolveIdentifierPins({ question, identifierSets, contextsById, kbKindById, model }: {
  question: string;
  identifierSets: IdentifierSet[];
  contextsById: Map<string, any>;
  kbKindById: Map<string, KbKind>;
  model: any;
}): Promise<{ pinsByContext: Map<string, Set<string>>; exactPinsByContext: Map<string, Set<string>>; steps: PhaseStep[] }> {
  const pinsByContext = new Map<string, Set<string>>();
  const exactPinsByContext = new Map<string, Set<string>>();
  const steps: PhaseStep[] = [];

  await Promise.all(identifierSets.map(async (set) => {
    if (!set.contexts.length) return;
    try {
      const { output } = await withRetry(() => generateText({
        model,
        temperature: 0,
        system: set.strategy === "exact" ? EXACT_EXTRACTION_PROMPT(set) : FUZZY_EXTRACTION_PROMPT(set),
        messages: [{ role: "user", content: question }],
        output: Output.object({
          schema: z.object({ hasMatches: z.boolean(), matches: z.array(z.string()).optional() }),
        }),
        maxOutputTokens: 300,
      }), 3);
      if (!output?.hasMatches || !output.matches?.length) return;
      steps.push({ text: `Detected ${set.name} in the question: ${output.matches.join(", ")}` });

      await Promise.all(set.contexts.map(async (ctxId) => {
        const ctx = contextsById.get(ctxId);
        if (!ctx) return;
        const common = {
          cacheKey: `identifier:${ctxId}`,
          context: ctx,
          fields: ["name", "id", "external_id"],
          normalize: (item: any) => (item.external_id ? normalizeFileName(item.external_id) : item.name),
        };
        const matched = set.strategy === "exact"
          ? await exactTokenPrefilter({ ...common, tokens: output.matches! })
          : await fuzzyPrefilter({ ...common, relevantKeywords: output.matches!, cutoff: DEFAULT_PREFILTER_CUTOFF });
        if (!matched.length) return;
        const target = pinsByContext.get(ctxId) ?? new Set<string>();
        for (const m of matched) target.add(m.id);
        pinsByContext.set(ctxId, target);
        if (set.strategy === "exact") {
          const boost = exactPinsByContext.get(ctxId) ?? new Set<string>();
          for (const m of matched) boost.add(m.id);
          exactPinsByContext.set(ctxId, boost);
        }
        steps.push({ text: `Limiting "${ctxId}" to ${matched.length} matching file(s): ${matched.map((m) => m.name).join(", ")}` });
      }));
    } catch (err) {
      console.warn(`[EXULU pipeline] identifier extraction for "${set.name}" failed — skipping.`, err);
    }
  }));

  return { pinsByContext, exactPinsByContext, steps };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest ee/agentic-retrieval/pipeline/prefilter.test.ts --silent`
Expected: PASS. Also port any still-applicable cases from `NEWLKIAG/src/tools/knowledge_search/prefilter.test.ts` and `NEWLKIAG/src/utils/` tests if present (drop German-stemming assertions).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json ee/agentic-retrieval/pipeline/prefilter.ts ee/agentic-retrieval/pipeline/prefilter.test.ts
git commit -m "feat(retrieval): fuzzy/exact prefilters and config-driven identifier pins"
```

---

### Task 5: HyDE + multi-query search

**Files:**
- Create: `ee/agentic-retrieval/pipeline/hyde.ts`
- Create: `ee/agentic-retrieval/pipeline/multi-query.ts`
- Test: `ee/agentic-retrieval/pipeline/hyde.test.ts`, `ee/agentic-retrieval/pipeline/multi-query.test.ts`

**Interfaces:**
- Produces:

```ts
// hyde.ts
export function generateHydePassage(opts: {
  originalQuestion: string; relevantKeywords: string[]; importantKeyword?: string;
  styleHint: string;        // vocabulary.styleHint, may be ""
  model: any;
}): Promise<string | null>;
export function clearHydeCache(): void;

// multi-query.ts
export type SearchCallConfig = {
  method: "hybridSearch" | "tsvector" | "cosineDistance";
  cutoffs?: { hybrid?: number; cosineDistance?: number; tsvector?: number };
  expand?: { before: number; after: number };
  limit: number;
};
export async function singleSearch(opts: {
  query: string; config: SearchCallConfig; user: any; role: any;
  pinnedItemIds: string[]; context: any;
}): Promise<Chunk[]>;
export async function multiQuerySearch(opts: {
  queries: string[]; config: SearchCallConfig; user: any; role: any;
  pinnedItemIds: string[]; context: any;
}): Promise<Chunk[]>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// ee/agentic-retrieval/pipeline/hyde.test.ts
import { generateHydePassage, clearHydeCache } from "./hyde";

jest.mock("ai", () => ({ generateText: jest.fn() }));
import { generateText } from "ai";

beforeEach(() => { clearHydeCache(); (generateText as jest.Mock).mockReset(); });

describe("generateHydePassage", () => {
  it("returns the generated passage and includes the styleHint in the prompt", async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: "A passage." });
    const p = await generateHydePassage({
      originalQuestion: "How do I lock door A?", relevantKeywords: ["door"],
      importantKeyword: "FST-2XT", styleHint: "German elevator manuals", model: {},
    });
    expect(p).toBe("A passage.");
    const prompt = (generateText as jest.Mock).mock.calls[0][0].prompt as string;
    expect(prompt).toContain("German elevator manuals");
    expect(prompt).toContain("FST-2XT");
    expect(prompt).toContain("same language as the question");
  });

  it("memoizes per question (one LLM call for two invocations)", async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: "A passage." });
    const opts = { originalQuestion: "q", relevantKeywords: [], styleHint: "", model: {} };
    await generateHydePassage(opts);
    await generateHydePassage(opts);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("returns null on failure without caching the failure", async () => {
    (generateText as jest.Mock).mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce({ text: "ok" });
    const opts = { originalQuestion: "q2", relevantKeywords: [], styleHint: "", model: {} };
    expect(await generateHydePassage(opts)).toBeNull();
    expect(await generateHydePassage(opts)).toBe("ok");
  });

  it("returns null when no model is provided", async () => {
    expect(await generateHydePassage({ originalQuestion: "q", relevantKeywords: [], styleHint: "", model: undefined })).toBeNull();
  });
});
```

```ts
// ee/agentic-retrieval/pipeline/multi-query.test.ts
import { multiQuerySearch, singleSearch } from "./multi-query";

const chunk = (id: string, score = 1) => ({
  chunk_id: id, chunk_content: id, chunk_index: 1, item_id: "i" + id, item_name: "n" + id,
  chunk_hybrid_score: score,
});

describe("multiQuerySearch", () => {
  it("merges result sets with RRF; chunks in multiple sets rank first", async () => {
    const ctx = {
      search: jest.fn()
        .mockResolvedValueOnce({ chunks: [chunk("a"), chunk("b")] })
        .mockResolvedValueOnce({ chunks: [chunk("c"), chunk("a")] }),
    };
    const merged = await multiQuerySearch({
      queries: ["q1", "q2"], config: { method: "hybridSearch", limit: 10 },
      user: {}, role: "r", pinnedItemIds: [], context: ctx,
    });
    expect(merged[0].chunk_id).toBe("a"); // appears in both sets → highest RRF
    expect(merged).toHaveLength(3);
    expect(ctx.search).toHaveBeenCalledTimes(2);
  });

  it("passes pinned item ids as an id filter", async () => {
    const ctx = { search: jest.fn().mockResolvedValue({ chunks: [] }) };
    await singleSearch({
      query: "q", config: { method: "hybridSearch", limit: 5 }, user: {}, role: "r",
      pinnedItemIds: ["x"], context: ctx,
    });
    expect(ctx.search.mock.calls[0][0].itemFilters).toEqual([{ id: { in: ["x"] } }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest ee/agentic-retrieval/pipeline/hyde.test.ts ee/agentic-retrieval/pipeline/multi-query.test.ts --silent`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`hyde.ts`: port the cache mechanics (promise cache, FIFO cap 200, failure eviction, no-model → null) verbatim from `NEWLKIAG/src/utils/retrieval-recall.ts:48-106`, include `styleHint` in the cache key, and replace the German prompt (lines 122-136) with:

```ts
const prompt = `You are a technical writer producing content in the style of this organization's knowledge base.${
  styleHint ? `\nThe documents look like this: ${styleHint}` : ""}
Write a SHORT hypothetical passage (3-6 sentences) that answers the question below the way the
original document would state it — using the domain's typical terminology (menu paths, parameters,
codes, section names). Write in the same language as the question.

IMPORTANT:
- Refer exactly to the mentioned product/model: "${modelHint}". Mention this exact designation and NO other variant.
- Invent plausible, domain-appropriate terms and structure; factual accuracy is not required — the text is only a search anchor.
- Output ONLY the passage, no preamble, no markdown.

Question: "${originalQuestion}"
Relevant keywords: ${relevantKeywords.join(", ")}`;
```

where `modelHint = importantKeyword || extractIdentifierTokens([importantKeyword, ...relevantKeywords, originalQuestion])[0] || ""` (import from `./text-utils`). Keep `temperature: 0.3, maxOutputTokens: 500`. When `modelHint` is empty, omit the first IMPORTANT bullet.

`multi-query.ts`: port from `NEWLKIAG/src/utils/multi-query-search.ts` and `NEWLKIAG/src/tools/exulu-search.ts` with these changes: (a) collapse both `searchWithQuery` and `exuluSearch` into ONE `singleSearch` that takes a single `SearchCallConfig` (the configs-array loop existed for a fallback-config feature that was never populated with more than one entry — YAGNI); (b) `prefiltered` param renamed `pinnedItemIds`; drop the `external_ids` param (input removed per spec §2.2); (c) `itemFilters` = `pinnedItemIds.length > 0 ? [{ id: { in: pinnedItemIds } }] : []`; (d) keep `sort: { field: "createdAt", direction: "desc" }, trigger: "tool", page: 1` and the cutoffs/expand passthrough; (e) wrap each `context.search` call in try/catch returning `[]` with a `console.warn`; (f) port `mergeResultsWithRRF` verbatim (k = `RRF_K` from config.ts, appearance boost `*(1+0.2*(n-1))` on hybrid score, fallback `rrfScore*10`); drop `mergeResultsWithAveraging` (dead code); (g) reduce logging to one summary line.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest ee/agentic-retrieval/pipeline/hyde.test.ts ee/agentic-retrieval/pipeline/multi-query.test.ts --silent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ee/agentic-retrieval/pipeline/hyde.ts ee/agentic-retrieval/pipeline/multi-query.ts ee/agentic-retrieval/pipeline/hyde.test.ts ee/agentic-retrieval/pipeline/multi-query.test.ts
git commit -m "feat(retrieval): generic HyDE and multi-query RRF search"
```

---

### Task 6: Routing phase

**Files:**
- Create: `ee/agentic-retrieval/pipeline/routing.ts`
- Test: `ee/agentic-retrieval/pipeline/routing.test.ts`

**Interfaces:**
- Consumes: `fuzzyPrefilter` (Task 4), `normalizeFileName` (Task 3), `RoutingRule` (Task 2), `RoutingPhaseResult`/`PhaseStep` (Task 3), `withRetry`.
- Produces:

```ts
export async function runRoutingPhase(opts: {
  question: string;
  enabledContexts: Array<{ id: string; name: string; description?: string }>;
  documentContexts: any[];             // enabled contexts whose kind === "documents" (full ExuluContext for prefilter)
  routingRules: RoutingRule[];
  preselectedItems: Map<string, string[] | null>;
  extraInstructions?: string;   // config `instructions` + admin instructions; appended to the classification system prompt
  model: any;
}): Promise<RoutingPhaseResult>;
```

Behavior (generalized from `NEWLKIAG/src/tools/knowledge_search/routing.ts`):
1. In parallel: doc/page-reference detection AND explicit-KB detection (schemas identical to the originals at routing.ts:122-164, but the KB enum is `enabledContexts.map(c => c.id)` and the system prompt lists `- <id>: <name> — <description>` per context). The doc/page prompt is the original at routing.ts:47-61 with the German examples replaced by neutral ones: filenames like `"manual_v4.2.de.pdf"`, `"HB_PAM-E4"`, `"installation guide model X3"`; page refs `"page 38"`, `"p. 38"`, `"Seite 38"`; note that generic product names alone are handled elsewhere.
2. Filename hints resolve in parallel against EVERY `documentContexts` entry via `fuzzyPrefilter({ cacheKey: "routing:"+ctx.id, relevantKeywords: hints, context: ctx, fields: ["name","id","external_id"], normalize: (i) => i.external_id ? normalizeFileName(i.external_id) : i.name })` → `userPinnedItemIdsByContext: Map<ctxId, Set<itemId>>` (only non-empty matches inserted). Steps report pinned names or "no matching file found".
3. `userRequestedPage` and `hasExplicitDocAndPage` (any user pin + page ≠ null) exactly as the original (routing.ts:203-212).
4. Context selection precedence (original routing.ts:214-266): explicit KBs → `mainContexts = explicit, fallbackContexts = []`; else preselected keys → main = those keys; else if `routingRules.length > 0` → third LLM call classifying into `z.enum(rules.map(r => r.id))` with system prompt `rules.map(r => "- " + r.id + " (" + r.label + "): " + r.description)` returning `{ ruleId, reason }` → main/fallback from the matched rule, both filtered to enabled context ids; else (no rules) → implicit rule: `main = enabledContexts.map(c => c.id)`, `fallback = []`.
5. Every LLM call: `withRetry(…, 3)`, `temperature: 0`, `maxOutputTokens` 300/200/200 as the originals. If doc/page detection fails → treat as "no hints" (step notes the skip). If explicit-KB detection fails → treat as "none requested". If classification fails → implicit all-main rule (step notes the degradation).

- [ ] **Step 1: Write the failing test**

```ts
// ee/agentic-retrieval/pipeline/routing.test.ts
import { runRoutingPhase } from "./routing";

jest.mock("ai", () => ({ generateText: jest.fn(), Output: { object: (x: any) => x } }));
jest.mock("./prefilter", () => ({ fuzzyPrefilter: jest.fn(async () => []) }));
import { generateText } from "ai";
import { fuzzyPrefilter } from "./prefilter";

const enabled = [
  { id: "docs", name: "Docs", description: "manuals" },
  { id: "tickets", name: "Tickets", description: "support" },
];
const noHints = { output: { hasFilenameHint: false, filenameHints: [], hasPageHint: false, pageNumber: null } };
const noExplicit = { output: { explicitlyRequestedKnowledgeBases: [] } };

beforeEach(() => { (generateText as jest.Mock).mockReset(); (fuzzyPrefilter as jest.Mock).mockClear(); });

describe("runRoutingPhase", () => {
  it("explicit KB request wins and yields no fallback", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce(noHints)
      .mockResolvedValueOnce({ output: { explicitlyRequestedKnowledgeBases: ["tickets"] } });
    const r = await runRoutingPhase({
      question: "search tickets for X", enabledContexts: enabled, documentContexts: [],
      routingRules: [{ id: "t", label: "T", description: "d", main: ["docs"], fallback: ["tickets"] }],
      preselectedItems: new Map(), model: {},
    });
    expect(r.mainContexts).toEqual(["tickets"]);
    expect(r.fallbackContexts).toEqual([]);
    expect(generateText).toHaveBeenCalledTimes(2); // no classification call
  });

  it("classifies against configured rules when nothing is explicit", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce(noHints)
      .mockResolvedValueOnce(noExplicit)
      .mockResolvedValueOnce({ output: { ruleId: "t", reason: "because" } });
    const r = await runRoutingPhase({
      question: "how do I fix the door?", enabledContexts: enabled, documentContexts: [],
      routingRules: [{ id: "t", label: "T", description: "d", main: ["docs"], fallback: ["tickets"] }],
      preselectedItems: new Map(), model: {},
    });
    expect(r.mainContexts).toEqual(["docs"]);
    expect(r.fallbackContexts).toEqual(["tickets"]);
  });

  it("with no rules everything enabled becomes main", async () => {
    (generateText as jest.Mock).mockResolvedValueOnce(noHints).mockResolvedValueOnce(noExplicit);
    const r = await runRoutingPhase({
      question: "q", enabledContexts: enabled, documentContexts: [], routingRules: [],
      preselectedItems: new Map(), model: {},
    });
    expect(r.mainContexts).toEqual(["docs", "tickets"]);
    expect(r.fallbackContexts).toEqual([]);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("resolves filename hints against document contexts and reports the page", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ output: { hasFilenameHint: true, filenameHints: ["manual X3"], hasPageHint: true, pageNumber: 12 } })
      .mockResolvedValueOnce(noExplicit);
    (fuzzyPrefilter as jest.Mock).mockResolvedValue([{ id: "42", name: "Manual X3", key: "k" }]);
    const docCtx = { id: "docs" };
    const r = await runRoutingPhase({
      question: "in manual X3 on page 12", enabledContexts: enabled, documentContexts: [docCtx],
      routingRules: [], preselectedItems: new Map(), model: {},
    });
    expect([...r.userPinnedItemIdsByContext.get("docs")!]).toEqual(["42"]);
    expect(r.userRequestedPage).toBe(12);
    expect(r.hasExplicitDocAndPage).toBe(true);
  });

  it("degrades to all-main when the classifier throws", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce(noHints)
      .mockResolvedValueOnce(noExplicit)
      .mockRejectedValue(new Error("down")); // withRetry exhausts on classification
    const r = await runRoutingPhase({
      question: "q", enabledContexts: enabled, documentContexts: [],
      routingRules: [{ id: "t", label: "T", description: "d", main: ["docs"], fallback: [] }],
      preselectedItems: new Map(), model: {},
    });
    expect(r.mainContexts).toEqual(["docs", "tickets"]);
  }, 30000); // withRetry backs off 2s+4s before exhausting
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest ee/agentic-retrieval/pipeline/routing.test.ts --silent`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `routing.ts`**

Port `NEWLKIAG/src/tools/knowledge_search/routing.ts` applying the generalization in the Interfaces block. Concrete transformation map:
- `AVAILABLE_SOURCES` / `@EXULU_CONTEXTS` imports → gone; use `opts.enabledContexts`.
- `PROMPT_CHECK_FOR_EXPLICITLY_REQUESTED_KNOWLEDGE_BASES` → build from `enabledContexts` (`- ${c.id}: ${c.name}${c.description ? " — " + c.description : ""}`); zod enum from their ids (guard: if `enabledContexts.length === 0` skip the call and return the implicit result immediately).
- `requestCategories` + `contextsForCategory` + `PROMPT_CLASSIFY_REQUEST` → replaced by `routingRules` (schema `{ ruleId: z.enum(ruleIds), reason: z.string() }`); when `extraInstructions` is non-empty, append it to the classification system prompt inside an `<instructions>` block; after classification `main = rule.main.filter(id => enabledIds.has(id))`, `fallback = rule.fallback.filter(id => enabledIds.has(id) && !main.includes(id))`. Unknown `ruleId` → implicit all-main.
- techdoc/vorschriften hint resolution (routing.ts:171-201) → loop over `documentContexts` with `Promise.all`, producing `userPinnedItemIdsByContext`.
- Every `generateText` stays inside `withRetry(…, 3)`; wrap each of the three call sites in try/catch implementing the degradations listed above; `import { withRetry } from "@SRC/utils/with-retry";` (backend's version takes `(fn, maxRetries)` only — drop the extra label/context args the newlkiag version accepted).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest ee/agentic-retrieval/pipeline/routing.test.ts --silent`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ee/agentic-retrieval/pipeline/routing.ts ee/agentic-retrieval/pipeline/routing.test.ts
git commit -m "feat(retrieval): config-driven routing phase (explicit KB, doc/page pins, rule classification)"
```

---

### Task 7: Memory phase

**Files:**
- Create: `ee/agentic-retrieval/pipeline/memory.ts`
- Test: `ee/agentic-retrieval/pipeline/memory.test.ts`

**Interfaces:**
- Consumes: `singleSearch` (Task 5), `fuzzyPrefilter` (Task 4), `deriveKeywordVariants`/`stripSeparators`/`normalizeFileName` (Task 3), `PipelineConfig["memory"]` + glossary type (Task 2), `MemoryPhaseResult` (Task 3).
- Produces:

```ts
export async function runMemoryPhase(opts: {
  memoryChunks: Chunk[];                    // framework-injected pre-search of the agent memory context
  memoryContext?: any;                      // ExuluContext of agent.memory — undefined disables keyword recall
  question: string;
  keywords: string[];
  importantKeyword: string;
  user: any; role: any; model: any;
  memoryConfig: { enabled: boolean; override: boolean; filePrioritization: boolean; queryAugmentation: boolean };
  glossary: { term: string; meaning: string }[];
  documentContexts: any[];                  // enabled documents-kind contexts (for file-prioritization pins)
}): Promise<MemoryPhaseResult>;
export function clearMemoryItemCache(): void;
```

Behavior — port `NEWLKIAG/src/tools/knowledge_search/memory.ts` + the recall part of `NEWLKIAG/src/tools/newton-memory.ts:91-169` with these transformations:
- If `!memoryConfig.enabled` OR (`memoryChunks.length === 0` AND `!memoryContext`): return the neutral result `{ memoryChunksForAnswer: [], memoryOverride: { active: false, chunks: [], reason: "" }, memoryPinnedItemIds: new Set(), updatedQuestion: question, updatedKeywords: keywords, updatedImportantKeyword: importantKeyword, steps: [] }`.
- Keyword recall (`searchNewtonMemoryByKeywords` → local `recallMemoryByKeywords`): same variant derivation/scoring/top-25; 5-min item cache keyed by `memoryContext.id` (module map + `clearMemoryItemCache()`); `singleSearch` with `config: { method: "hybridSearch", cutoffs: undefined, limit: 50 }` and `pinnedItemIds: topMatches.map(s => s.id)`. try/catch → degrade to injected chunks only.
- Relevance check: port the prompt (memory.ts:60-73) and call (75-100) as-is (already client-neutral). On failure (withRetry exhausted): treat ALL retrieved memory chunks as relevant? NO — treat none as relevant and push a step noting memory was skipped (strict: a broken check must not flood the answer with memory).
- Synthetic score/citable shaping (memory.ts:103-118): port verbatim (`rerank_score: 1`, `context: { name: "memory", id: "memory" }`).
- The three parallel sub-calls (memory.ts:259-339) each gated by config: override (`memoryConfig.override`), file prioritization (`memoryConfig.filePrioritization`), query augmentation (`memoryConfig.queryAugmentation`). A disabled feature resolves to its neutral `.catch(...)` default without an LLM call. Prompts: override check ported verbatim (client-neutral); file-prioritization prompt ported verbatim minus the `"MISCEL_SECRETS"` example (use `"PROJECT_NOTES"`); query augmentation prompt ported with `ABBREVIATION_GLOSSARY` replaced by the configured glossary rendered as `glossary.map(g => `${g.term} : ${g.meaning}`).join("\n")` inside a neutral framing (`"The organization's documents use the following abbreviations/terms:"`) — when the glossary is empty and there are no relevant memory chunks with content, skip the augmentation call entirely.
- Override gate constants: `MEMORY_OVERRIDE_MIN_CONFIDENCE = "high"` and the triple condition (memory.ts:341-350) verbatim.
- File prioritization resolves hints against EVERY `documentContexts` entry via `fuzzyPrefilter` (union into `memoryPinnedItemIds`), not just one hardcoded context.
- Augmentation merge semantics (memory.ts:369-380) verbatim: keywords union lowercased/trimmed, `updatedImportantKeyword` preserved as the original.

- [ ] **Step 1: Write the failing test**

```ts
// ee/agentic-retrieval/pipeline/memory.test.ts
import { runMemoryPhase, clearMemoryItemCache } from "./memory";

jest.mock("ai", () => ({ generateText: jest.fn(), Output: { object: (x: any) => x } }));
jest.mock("./multi-query", () => ({ singleSearch: jest.fn(async () => []) }));
jest.mock("./prefilter", () => ({ fuzzyPrefilter: jest.fn(async () => []) }));
import { generateText } from "ai";
import { fuzzyPrefilter } from "./prefilter";

const memChunk = (id: string, content: string) => ({
  chunk_id: id, chunk_content: content, chunk_index: 1, item_id: "m" + id, item_name: "Memory " + id,
}) as any;
const baseOpts = {
  question: "How do I bypass the door contact on the FST-2XT?",
  keywords: ["door"], importantKeyword: "FST-2XT", user: {}, role: "r", model: {},
  glossary: [{ term: "FST", meaning: "field bus controller" }],
  documentContexts: [],
};
const allOn = { enabled: true, override: true, filePrioritization: true, queryAugmentation: true };

beforeEach(() => { clearMemoryItemCache(); (generateText as jest.Mock).mockReset(); });

describe("runMemoryPhase", () => {
  it("returns a neutral result when memory is disabled", async () => {
    const r = await runMemoryPhase({ ...baseOpts, memoryChunks: [memChunk("1", "x")], memoryContext: undefined,
      memoryConfig: { ...allOn, enabled: false } });
    expect(r.memoryChunksForAnswer).toEqual([]);
    expect(r.updatedQuestion).toBe(baseOpts.question);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("marks relevant chunks citable with synthetic score 1 and memory context", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ output: { relevantChunkIds: ["1"] } })       // relevance
      .mockResolvedValueOnce({ output: { overrides: false, confidence: "low", authoritativeChunkIds: [], reason: "" } })
      .mockResolvedValueOnce({ output: { shouldPrioritizeFiles: false, fileNameHints: [] } })
      .mockResolvedValueOnce({ output: { updatedUserQuestion: baseOpts.question, updatedRelevantKeywords: [], updatedImportantKeyword: "FST-2XT" } });
    const r = await runMemoryPhase({ ...baseOpts, memoryChunks: [memChunk("1", "hint"), memChunk("2", "other")],
      memoryContext: undefined, memoryConfig: allOn });
    expect(r.memoryChunksForAnswer).toHaveLength(1);
    expect(r.memoryChunksForAnswer[0]).toMatchObject({ chunk_id: "1", rerank_score: 1, context: { id: "memory" } });
  });

  it("activates the override only with overrides=true AND high confidence AND chunks", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ output: { relevantChunkIds: ["1"] } })
      .mockResolvedValueOnce({ output: { overrides: true, confidence: "medium", authoritativeChunkIds: ["1"], reason: "r" } })
      .mockResolvedValueOnce({ output: { shouldPrioritizeFiles: false } })
      .mockResolvedValueOnce({ output: { updatedUserQuestion: baseOpts.question, updatedRelevantKeywords: [], updatedImportantKeyword: "FST-2XT" } });
    const r = await runMemoryPhase({ ...baseOpts, memoryChunks: [memChunk("1", "x")], memoryContext: undefined, memoryConfig: allOn });
    expect(r.memoryOverride.active).toBe(false); // medium confidence blocks it
  });

  it("skips override/file/augmentation LLM calls when those features are off", async () => {
    (generateText as jest.Mock).mockResolvedValueOnce({ output: { relevantChunkIds: ["1"] } });
    const r = await runMemoryPhase({ ...baseOpts, memoryChunks: [memChunk("1", "x")], memoryContext: undefined,
      memoryConfig: { enabled: true, override: false, filePrioritization: false, queryAugmentation: false } });
    expect(generateText).toHaveBeenCalledTimes(1); // relevance only
    expect(r.memoryOverride.active).toBe(false);
  });

  it("augmentation merges keywords but preserves the original important keyword", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ output: { relevantChunkIds: ["1"] } })
      .mockResolvedValueOnce({ output: { updatedUserQuestion: "expanded q", updatedRelevantKeywords: ["Feldbussteuerung"], updatedImportantKeyword: "SOMETHING-ELSE" } });
    const r = await runMemoryPhase({ ...baseOpts, memoryChunks: [memChunk("1", "x")], memoryContext: undefined,
      memoryConfig: { enabled: true, override: false, filePrioritization: false, queryAugmentation: true } });
    expect(r.updatedQuestion).toBe("expanded q");
    expect(r.updatedKeywords).toEqual(expect.arrayContaining(["door", "feldbussteuerung"]));
    expect(r.updatedImportantKeyword).toBe("FST-2XT");
  });

  it("resolves file-prioritization pins across all document contexts", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ output: { relevantChunkIds: ["1"] } })
      .mockResolvedValueOnce({ output: { shouldPrioritizeFiles: true, fileNameHints: ["PROJECT_NOTES"] } });
    (fuzzyPrefilter as jest.Mock).mockResolvedValue([{ id: "d1", name: "Project Notes", key: "k" }]);
    const r = await runMemoryPhase({ ...baseOpts, memoryChunks: [memChunk("1", "always check PROJECT_NOTES")],
      memoryContext: undefined, documentContexts: [{ id: "docs" }],
      memoryConfig: { enabled: true, override: false, filePrioritization: true, queryAugmentation: false } });
    expect([...r.memoryPinnedItemIds]).toEqual(["d1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest ee/agentic-retrieval/pipeline/memory.test.ts --silent`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `memory.ts`** per the Behavior block in Interfaces (port + transformations listed there; import `withRetry` from `@SRC/utils/with-retry` and drop the label/context args).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest ee/agentic-retrieval/pipeline/memory.test.ts --silent`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add ee/agentic-retrieval/pipeline/memory.ts ee/agentic-retrieval/pipeline/memory.test.ts
git commit -m "feat(retrieval): config-gated memory phase with recall, override, pins, augmentation"
```

---

### Task 8: Search dispatch (kind presets, pin semantics)

**Files:**
- Create: `ee/agentic-retrieval/pipeline/search.ts`
- Test: `ee/agentic-retrieval/pipeline/search.test.ts`

**Interfaces:**
- Consumes: `multiQuerySearch`/`singleSearch` (Task 5), `generateHydePassage` (Task 5), `fuzzyPrefilter` (Task 4), `applyRewrites` (Task 3), `effectiveKbSettings` (Task 2), types (Task 3).
- Produces:

```ts
export async function searchContexts(opts: {
  contextIds: string[];
  contextsById: Map<string, any>;
  kbProfiles: Record<string, KbProfile>;
  question: string; keywords: string[]; importantKeyword: string;
  user: any; role: any; model: any;
  preselectedItems: Map<string, string[] | null>;
  identifierPinsByContext: Map<string, Set<string>>;   // from resolveIdentifierPins
  memoryPinnedItemIds: Set<string>;                     // from memory phase (documents kind only)
  userPinnedItemIdsByContext: Map<string, Set<string>>; // from routing phase
  rewrites: { find: string; replace: string }[];
  styleHint: string;
  maxQueries: number;
  skipPrefilter: boolean;                                // true for the speculative fallback pass
}): Promise<{ chunks: Chunk[] }>;
```

Pin semantics per context (generalizing `NEWLKIAG/src/tools/knowledge_search/search.ts:26-163`) — compute the effective `pinnedItemIds: string[]` for the search call:
1. Start with `preselectedItems.get(ctxId) ?? []` (a `null` value = whole context = no filter = `[]`).
2. Only when there is NO preselection for this context and `!skipPrefilter`:
   a. start from identifier pins for this context (`identifierPinsByContext`),
   b. `documents` kind only: UNION with `memoryPinnedItemIds`,
   c. user pins for this context REPLACE everything (authoritative).
3. Query construction by kind:
   - `documents` with `multiQuery`: `queries = dedupe([question, hydePassage?, ...applyRewrites(question, rewrites)]).slice(0, maxQueries)` (HyDE first after the question so the slice never drops it), then `multiQuerySearch`; without `multiQuery` (override) → `singleSearch(question)`.
   - `conversations`: when `keywordPrefilter` and no pins yet → `fuzzyPrefilter` over items with `normalize: (i) => [i.name, i.description].filter(Boolean).join(": ")` and `fields: ["name","id","external_id","description"]`, results becoming the pins; then `singleSearch` with `query = keywords.length ? keywords.join(" ") + " " + importantKeyword : question`.
   - `records`: `singleSearch` with the same keyword-joined query.
4. `SearchCallConfig` from `effectiveKbSettings(profile, ctx)` (`method: "hybridSearch"`, limit/expand/cutoffs from settings). A context missing from `contextsById` contributes `[]`.
5. All contexts run in `Promise.all`; result = flat chunk list. Per-context try/catch → `[]` + warn.

- [ ] **Step 1: Write the failing test**

```ts
// ee/agentic-retrieval/pipeline/search.test.ts
import { searchContexts } from "./search";

jest.mock("./multi-query", () => ({ multiQuerySearch: jest.fn(async () => []), singleSearch: jest.fn(async () => []) }));
jest.mock("./hyde", () => ({ generateHydePassage: jest.fn(async () => "HYDE PASSAGE") }));
jest.mock("./prefilter", () => ({ fuzzyPrefilter: jest.fn(async () => [{ id: "p1", name: "n", key: "k" }]) }));
import { multiQuerySearch, singleSearch } from "./multi-query";
import { fuzzyPrefilter } from "./prefilter";

const contextsById = new Map<string, any>([
  ["docs", { id: "docs", configuration: {} }],
  ["tickets", { id: "tickets", configuration: {} }],
]);
const base = {
  contextsById,
  kbProfiles: {
    docs: { enabled: true, kind: "documents", instructions: "", overrides: {} },
    tickets: { enabled: true, kind: "conversations", instructions: "", overrides: {} },
  } as any,
  question: "how to fix door error E42", keywords: ["door", "E42"], importantKeyword: "E42",
  user: {}, role: "r", model: {},
  preselectedItems: new Map(), identifierPinsByContext: new Map(), memoryPinnedItemIds: new Set<string>(),
  userPinnedItemIdsByContext: new Map(), rewrites: [{ find: "fix", replace: "repair" }],
  styleHint: "", maxQueries: 5, skipPrefilter: false,
};

beforeEach(() => {
  (multiQuerySearch as jest.Mock).mockClear();
  (singleSearch as jest.Mock).mockClear();
  (fuzzyPrefilter as jest.Mock).mockClear();
});

describe("searchContexts", () => {
  it("documents kind uses multi-query with question + HyDE + rewrites", async () => {
    await searchContexts({ ...base, contextIds: ["docs"] });
    const call = (multiQuerySearch as jest.Mock).mock.calls[0][0];
    expect(call.queries[0]).toBe(base.question);
    expect(call.queries).toContain("HYDE PASSAGE");
    expect(call.queries).toContain("how to repair door error E42");
    expect(call.config.limit).toBe(100);
  });

  it("conversations kind prefilters by keywords then single-searches with joined keywords", async () => {
    await searchContexts({ ...base, contextIds: ["tickets"] });
    expect(fuzzyPrefilter).toHaveBeenCalled();
    const call = (singleSearch as jest.Mock).mock.calls[0][0];
    expect(call.query).toBe("door E42 E42");
    expect(call.pinnedItemIds).toEqual(["p1"]);
    expect(call.config.limit).toBe(20);
  });

  it("user pins REPLACE identifier+memory pins; memory pins UNION with identifier pins", async () => {
    await searchContexts({
      ...base, contextIds: ["docs"],
      identifierPinsByContext: new Map([["docs", new Set(["i1"])]]),
      memoryPinnedItemIds: new Set(["m1"]),
    });
    expect(new Set((multiQuerySearch as jest.Mock).mock.calls[0][0].pinnedItemIds)).toEqual(new Set(["i1", "m1"]));

    (multiQuerySearch as jest.Mock).mockClear();
    await searchContexts({
      ...base, contextIds: ["docs"],
      identifierPinsByContext: new Map([["docs", new Set(["i1"])]]),
      memoryPinnedItemIds: new Set(["m1"]),
      userPinnedItemIdsByContext: new Map([["docs", new Set(["u1"])]]),
    });
    expect((multiQuerySearch as jest.Mock).mock.calls[0][0].pinnedItemIds).toEqual(["u1"]);
  });

  it("preselected items win over everything and skip prefilters", async () => {
    await searchContexts({
      ...base, contextIds: ["docs"],
      preselectedItems: new Map([["docs", ["s1", "s2"]]]),
      identifierPinsByContext: new Map([["docs", new Set(["i1"])]]),
    });
    expect((multiQuerySearch as jest.Mock).mock.calls[0][0].pinnedItemIds).toEqual(["s1", "s2"]);
  });

  it("skipPrefilter (fallback pass) suppresses identifier/memory pins", async () => {
    await searchContexts({
      ...base, contextIds: ["docs"], skipPrefilter: true,
      identifierPinsByContext: new Map([["docs", new Set(["i1"])]]),
      memoryPinnedItemIds: new Set(["m1"]),
    });
    expect((multiQuerySearch as jest.Mock).mock.calls[0][0].pinnedItemIds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest ee/agentic-retrieval/pipeline/search.test.ts --silent`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `search.ts`** per the pin-semantics spec in Interfaces. `dedupe` = `[...new Set(arr)]`. HyDE is only generated when `settings.hyde` is true (one call — memoized in hyde.ts — even across several documents contexts).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest ee/agentic-retrieval/pipeline/search.test.ts --silent`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ee/agentic-retrieval/pipeline/search.ts ee/agentic-retrieval/pipeline/search.test.ts
git commit -m "feat(retrieval): kind-preset search dispatch with pin semantics"
```

---

### Task 9: Rerank & select

**Files:**
- Create: `ee/agentic-retrieval/pipeline/rerank.ts`
- Test: `ee/agentic-retrieval/pipeline/rerank.test.ts`

**Interfaces:**
- Consumes: `ResolvedReranker` type from `@SRC/exulu/resolve-reranker` (its `.rerank(query, chunks)` returns reordered chunks with `rerank_score`, `[]` on internal error), `extractIdentifierTokens`/`itemMatchesIdentifierToken` (Task 3), `CHUNK_GROUP_MAX` (Task 2), types (Task 3).
- Produces:

```ts
export function splitChunksIntoGroups(chunks: Chunk[]): Chunk[][];
export async function rerankResults(opts: {
  chunks: Chunk[];
  query: string;
  state: RerankState;
  reranker?: ResolvedReranker;      // undefined → hybrid-score fallback ordering
  tuning: { topK: number; pinBoost: number; identifierBoost: number; pageWindow: number };
}): Promise<RerankResult>;
```

Port `NEWLKIAG/src/tools/knowledge_search/rerank.ts` with: constants replaced by `tuning` params (`MEMORY_PIN_BOOST` → `pinBoost`, `PAGE_WINDOW` → `pageWindow`, top-5 → `topK`, `MODEL_DISAMBIGUATION_BOOST` → `identifierBoost`); `cohereReranker` → the injected `reranker.rerank(query, buildRerankObjects(chunks))`; group max 10 → `CHUNK_GROUP_MAX`. `buildRerankObjects` ported verbatim. New fallback behavior:
- `reranker === undefined` → score groups by `max(chunk_hybrid_score)` normalized: sort groups desc by hybrid score, DO NOT set `rerank_score`, set `rerank_score_max_genuine = 0` (the orchestrator special-cases the no-reranker fallback gate — see Task 10).
- `reranker.rerank` returns `[]` for non-empty input (its internal error path) → same fallback ordering, warn.
- Empty input → `{ limited_results: [], sorted_reranked_results: [], rerank_score_max_genuine: 0 }`.

- [ ] **Step 1: Write the failing test**

```ts
// ee/agentic-retrieval/pipeline/rerank.test.ts
import { splitChunksIntoGroups, rerankResults } from "./rerank";

const chunk = (id: string, itemId: string, index: number, extra: any = {}) => ({
  chunk_id: id, item_id: itemId, item_name: "item " + itemId, chunk_index: index,
  chunk_content: "c" + id, chunk_hybrid_score: 1, ...extra,
}) as any;
const state = (over: Partial<any> = {}) => ({
  pinnedItemIds: new Set<string>(), userPinnedItemIds: new Set<string>(),
  userRequestedPage: null, keywords: [], importantKeyword: "", ...over,
});
const tuning = { topK: 5, pinBoost: 0.15, identifierBoost: 0.15, pageWindow: 1 };

describe("splitChunksIntoGroups", () => {
  it("splits at index gaps and at 10 chunks", () => {
    const run = Array.from({ length: 12 }, (_, i) => chunk("a" + i, "A", i + 1));
    expect(splitChunksIntoGroups(run).map((g) => g.length)).toEqual([10, 2]);
    const gap = [chunk("b1", "B", 1), chunk("b2", "B", 5)];
    expect(splitChunksIntoGroups(gap)).toHaveLength(2);
  });
});

describe("rerankResults", () => {
  it("reranks, applies pin boost, limits to topK, reports genuine max before boosts", async () => {
    const chunks = Array.from({ length: 8 }, (_, i) => chunk("c" + i, "I" + i, 1));
    const reranker = { model: "m", rerank: jest.fn(async (_q: string, items: any[]) =>
      items.map((it, i) => ({ ...it, rerank_score: 0.8 - i * 0.05 }))) } as any;
    const r = await rerankResults({ chunks, query: "q", state: state({ pinnedItemIds: new Set(["I7"]) }), reranker, tuning });
    expect(r.rerank_score_max_genuine).toBeCloseTo(0.8);
    expect(r.limited_results.length).toBeGreaterThanOrEqual(5);
    const pinned = r.sorted_reranked_results.find((c: any) => c.item_id === "I7");
    expect(pinned!.rerank_score).toBeCloseTo(0.8 - 7 * 0.05 + 0.15);
  });

  it("boosts items whose name matches an identifier token", async () => {
    const chunks = [chunk("c1", "A", 1), chunk("c2", "B", 1)];
    chunks[1].item_name = "hb_FST-2XT_manual";
    const reranker = { model: "m", rerank: jest.fn(async (_q: string, items: any[]) =>
      items.map((it) => ({ ...it, rerank_score: 0.5 }))) } as any;
    const r = await rerankResults({ chunks, query: "q", state: state({ importantKeyword: "FST-2XT" }), reranker, tuning });
    expect(r.sorted_reranked_results[0].item_name).toBe("hb_FST-2XT_manual");
  });

  it("filters to the requested page window when a page was asked for", async () => {
    const chunks = [
      chunk("c1", "A", 1, { chunk_metadata: { page: 12 } }),
      chunk("c2", "A", 2, { chunk_metadata: { page: 40 } }),
    ];
    const reranker = { model: "m", rerank: jest.fn(async (_q: string, items: any[]) =>
      items.map((it) => ({ ...it, rerank_score: 0.5 }))) } as any;
    const r = await rerankResults({ chunks, query: "q", state: state({ userRequestedPage: 12 }), reranker, tuning });
    expect(r.limited_results).toHaveLength(1);
    expect((r.limited_results[0] as any).chunk_metadata.page).toBe(12);
  });

  it("without a reranker falls back to hybrid-score ordering with genuine max 0", async () => {
    const chunks = [chunk("c1", "A", 1, { chunk_hybrid_score: 0.2 }), chunk("c2", "B", 1, { chunk_hybrid_score: 0.9 })];
    const r = await rerankResults({ chunks, query: "q", state: state(), reranker: undefined, tuning });
    expect(r.sorted_reranked_results[0].chunk_id).toBe("c2");
    expect(r.rerank_score_max_genuine).toBe(0);
  });

  it("treats an empty rerank response for non-empty input as the fallback ordering", async () => {
    const chunks = [chunk("c1", "A", 1)];
    const reranker = { model: "m", rerank: jest.fn(async () => []) } as any;
    const r = await rerankResults({ chunks, query: "q", state: state(), reranker, tuning });
    expect(r.sorted_reranked_results).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest ee/agentic-retrieval/pipeline/rerank.test.ts --silent`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `rerank.ts`** per the port instructions in Interfaces.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest ee/agentic-retrieval/pipeline/rerank.test.ts --silent`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add ee/agentic-retrieval/pipeline/rerank.ts ee/agentic-retrieval/pipeline/rerank.test.ts
git commit -m "feat(retrieval): tunable rerank with pin/identifier boosts and no-reranker fallback"
```

---

### Task 10: Tool factory + orchestrator (`pipeline/index.ts`)

**Files:**
- Create: `ee/agentic-retrieval/pipeline/index.ts`
- Test: `ee/agentic-retrieval/pipeline/index.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–9; `ExuluTool` (`@SRC/exulu/tool`), `checkLicense` (`@EE/entitlements`), `resolveReranker` (`@SRC/exulu/resolve-reranker`), `resolveModel` (`@SRC/exulu/resolve-model`), `exuluApp` (`@SRC/exulu/app/singleton`).
- Produces (call sites in Task 11 depend on this exact signature):

```ts
export function parsePreselectedItems(globalIds: string[]): Map<string, string[] | null>;
export function createAgenticRetrievalTool(opts: {
  contexts: ExuluContext[];
  memoryContext?: ExuluContext;      // NEW — agent.memory context for the memory phase
  user?: User;
  role?: string;
  model?: LanguageModel;
  instructions?: string;             // admin instructions (kept from v3 signature)
  preselected?: string[];
  memoryItems?: VectorSearchChunkResult[];
}): ExuluTool | undefined;
```

- [ ] **Step 1: Write the failing test**

```ts
// ee/agentic-retrieval/pipeline/index.test.ts
import { createAgenticRetrievalTool, parsePreselectedItems } from "./index";

jest.mock("@EE/entitlements", () => ({ checkLicense: () => ({ "agentic-retrieval": true }) }));
jest.mock("@SRC/exulu/resolve-reranker", () => ({ resolveReranker: jest.fn(async () => ({ model: "m", rerank: async (_q: any, c: any) => c })) }));
jest.mock("@SRC/exulu/resolve-model", () => ({ resolveModel: jest.fn() }));
jest.mock("@SRC/exulu/app/singleton", () => ({ exuluApp: { get: () => ({ providers: [] }) } }));
jest.mock("./routing", () => ({ runRoutingPhase: jest.fn(async () => ({
  mainContexts: ["docs"], fallbackContexts: [], userPinnedItemIdsByContext: new Map(),
  userRequestedPage: null, hasExplicitDocAndPage: false, steps: [{ text: "routed" }] })) }));
jest.mock("./memory", () => ({ runMemoryPhase: jest.fn(async () => ({
  memoryChunksForAnswer: [], memoryOverride: { active: false, chunks: [], reason: "" },
  memoryPinnedItemIds: new Set(), updatedQuestion: "q", updatedKeywords: ["k"],
  updatedImportantKeyword: "k", steps: [] })) }));
jest.mock("./prefilter", () => ({ resolveIdentifierPins: jest.fn(async () => ({
  pinsByContext: new Map(), exactPinsByContext: new Map(), steps: [] })) }));
jest.mock("./search", () => ({ searchContexts: jest.fn(async () => ({ chunks: [] })) }));
jest.mock("./rerank", () => ({ rerankResults: jest.fn(async () => ({
  limited_results: [], sorted_reranked_results: [], rerank_score_max_genuine: 1 })) }));

const drain = async (gen: AsyncGenerator<any>) => {
  const out: any[] = [];
  for await (const v of gen) out.push(v);
  return out;
};
const ctx = (id: string) => ({ id, name: id, description: "", configuration: {} }) as any;
const makeTool = (config?: Record<string, unknown>, extra: any = {}) => {
  const tool = createAgenticRetrievalTool({ contexts: [ctx("docs"), ctx("tickets")], model: {} as any, ...extra })!;
  const exec = (tool.tool as any).execute as (i: any, o?: any) => AsyncGenerator<any>;
  return (inputs: any) => exec({ toolVariablesConfig: config ?? {}, ...inputs });
};
const inputs = { userQuery: "q", relevantKeywords: ["k"], importantKeyword: "k" };

describe("createAgenticRetrievalTool", () => {
  it("declares the static config surface (no per-context keys)", () => {
    const tool = createAgenticRetrievalTool({ contexts: [ctx("docs")], model: {} as any })!;
    const names = tool.config.map((c) => c.name).sort();
    expect(names).toEqual([
      "instructions", "knowledge_bases", "logging", "managed_context", "memory",
      "require_preselected_contexts", "reranker", "routing", "tuning", "utility_model", "vocabulary",
    ].sort());
    expect(tool.config.filter((c) => c.type === "json").map((c) => c.name).sort())
      .toEqual(["knowledge_bases", "memory", "routing", "tuning", "vocabulary"].sort());
    expect(tool.id).toBe("agentic_context_search");
  });

  it("short-circuits managed_context without preselected items", async () => {
    const run = makeTool({ managed_context: true });
    const out = await drain(run(inputs));
    expect(out[out.length - 1].result).toContain("preselect");
  });

  it("yields a message (not a throw) when requested KBs fall outside the preselection", async () => {
    const { runRoutingPhase } = jest.requireMock("./routing");
    runRoutingPhase.mockResolvedValueOnce({
      mainContexts: ["tickets"], fallbackContexts: [], userPinnedItemIdsByContext: new Map(),
      userRequestedPage: null, hasExplicitDocAndPage: false, steps: [] });
    const run = makeTool({}, { preselected: ["docs/item1"] });
    const out = await drain(run(inputs));
    expect(out[out.length - 1].result).toContain("not part of the preselected");
  });

  it("streams cumulative AgenticRetrievalOutput snapshots and runs the full pipeline", async () => {
    const run = makeTool({});
    const out = await drain(run(inputs));
    expect(out.length).toBeGreaterThanOrEqual(2);
    const last = JSON.parse(out[out.length - 1].result);
    expect(last).toMatchObject({ steps: expect.any(Array), reasoning: expect.any(Array), chunks: [] });
    expect(last.steps.map((s: any) => s.text)).toContain("routed");
  });

  it("filters contexts by knowledge_bases enabled=false", async () => {
    const { searchContexts } = jest.requireMock("./search");
    const { runRoutingPhase } = jest.requireMock("./routing");
    const run = makeTool({ knowledge_bases: { tickets: { enabled: false } } });
    await drain(run(inputs));
    const routingCall = runRoutingPhase.mock.calls[runRoutingPhase.mock.calls.length - 1][0];
    expect(routingCall.enabledContexts.map((c: any) => c.id)).toEqual(["docs"]);
    expect(searchContexts).toHaveBeenCalled();
  });
});

describe("parsePreselectedItems", () => {
  it("parses ctx/item pairs and whole-context entries (null wins)", () => {
    const m = parsePreselectedItems(["a/1", "a/2", "b", "b/3"]);
    expect(m.get("a")).toEqual(["1", "2"]);
    expect(m.get("b")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest ee/agentic-retrieval/pipeline/index.test.ts --silent`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `index.ts`**

Structure (assembled from v3's preamble `ee/agentic-retrieval/v3/index.ts:190-471` and newlkiag's orchestrator `NEWLKIAG/src/tools/knowledge_search/index.ts:50-216`):

1. `parsePreselectedItems` — copy `parseGlobalItemIds` verbatim from `ee/agentic-retrieval/v3/tools.ts:57-76` (renamed).
2. Factory guard: license check identical to v3 (`index.ts:207-211`).
3. `ExuluTool.internal({...})` with the v3 identity block (`index.ts:215-221`) but description: `` `Intelligent knowledge search across the available knowledge bases: ${contexts.map((c) => c.name || c.id).join(", ")}. Routes the question to the right sources, searches them with query expansion, and returns reranked passages.` ``
4. Static `config` array — flat options `instructions`, `reranker`, `managed_context`, `require_preselected_contexts`, `logging` with the v3 descriptions (`index.ts:222-264`, minus `reasoning_model`/`search_model`), plus:

```ts
{ name: "utility_model", description: "Optional model id used for the pipeline's internal micro-calls (classification, memory checks, query expansion). Empty = the agent's own model.", type: "string", default: "" },
{ name: "knowledge_bases", description: "Per-knowledge-base profiles: enabled, kind (documents | conversations | records), instructions, and per-KB overrides (limit, expand, multiQuery, hyde). JSON object keyed by context id.", type: "json", default: "{}" },
{ name: "routing", description: "Routing rules: plain-language categories mapping to main and fallback knowledge bases. Empty = search all enabled knowledge bases.", type: "json", default: '{"rules":[]}' },
{ name: "vocabulary", description: "Domain vocabulary: glossary (term/meaning), identifier sets (product names, standards) used to pin matching files, query rewrite rules, and a styleHint describing the documents (feeds query expansion).", type: "json", default: '{"glossary":[],"identifiers":[],"rewrites":[],"styleHint":""}' },
{ name: "memory", description: "Memory features (requires the agent to have a memory context): relevance-checked recall, authoritative override, file prioritization, query augmentation.", type: "json", default: '{"enabled":true,"override":false,"filePrioritization":false,"queryAugmentation":true}' },
{ name: "tuning", description: "Retrieval tuning: topK, fallbackThreshold, pinBoost, identifierBoost, pageWindow, maxQueriesPerContext.", type: "json", default: '{"topK":5,"fallbackThreshold":0.95,"pinBoost":0.15,"identifierBoost":0.15,"pageWindow":1,"maxQueriesPerContext":5}' },
```

5. `inputSchema` per spec §2.2 (`userQuery`, `relevantKeywords`, `importantKeyword`, `confirmedContextIds?` — reuse the v3 descriptions, fixing the "When presen" typo).
6. `execute` generator:
   - `const cfg = parsePipelineConfig(toolVariablesConfig);`
   - Gates in order (all as `yield { result: … }; return;`): missing model (v3 `index.ts:351-354`); `cfg.managedContext && !preselected?.length` (v3 message verbatim, `index.ts:406-410`); `cfg.requirePreselectedContexts && !confirmedContextIds?.length && !preselected?.length` (v3 message verbatim, `index.ts:412-416`).
   - `enabledContexts` = contexts where `cfg.knowledgeBases[ctx.id]?.enabled !== false`; if that leaves zero, restore all (v3 semantics, `index.ts:371-377`). Then apply `confirmedContextIds` filter (v3 `index.ts:418-422`).
   - Resolve reranker best-effort (v3 `index.ts:381-400` verbatim against `cfg.reranker`).
   - Resolve utility model best-effort: `cfg.utilityModel` non-empty → `resolveModel({ modelId: cfg.utilityModel, user, providers: exuluApp.get().providers, rbacBypass: true })` in try/catch → `utilityModel = resolved.languageModel ?? model`; used for ALL pipeline micro-calls (routing/memory/prefilter/hyde receive `utilityModel`, the value defaulting to `model`).
   - `preselectedItems = parsePreselectedItems(preselected ?? [])`.
   - Derived maps: `contextsById`, `kbKindById` (via `effectiveKbSettings(cfg.knowledgeBases[id], ctx).kind`), `documentContexts` (enabled + kind documents).
   - Phase 1 (parallel `Promise.all`): `runMemoryPhase({ memoryChunks: memoryItems ?? [], memoryContext, question: userQuery, keywords: relevantKeywords, importantKeyword, user, role, model: utilityModel, memoryConfig: cfg.memory, glossary: cfg.vocabulary.glossary, documentContexts })` and `runRoutingPhase({ question: userQuery, enabledContexts, documentContexts, routingRules: cfg.routing.rules, preselectedItems, extraInstructions: [cfg.instructions, adminInstructions].filter(Boolean).join("\n"), model: utilityModel })` (this is where the `instructions` config option is consumed). Push both phases' steps into the output (newlkiag `index.ts:71-78` pattern: `stepNumber: 1`, reasoning mirror) and yield.
   - Preselection guard (newlkiag `index.ts:80-85`) but yield-not-throw: when `preselectedItems.size > 0` and some `mainContexts` aren't preselected keys → `yield { result: "The user has requested to search in knowledge bases that are not part of the preselected knowledge bases: " + missing.join(", ") }; return;`
   - Identifier pins once up front: `resolveIdentifierPins({ question: memResult.updatedQuestion, identifierSets: cfg.vocabulary.identifiers, contextsById, kbKindById, model: utilityModel })`; append its steps.
   - Phase 2 (newlkiag `index.ts:97-131`): main + speculative fallback `searchContexts` in parallel with the updated question/keywords, pins, `rewrites: cfg.vocabulary.rewrites`, `styleHint: cfg.vocabulary.styleHint`, `maxQueries: cfg.tuning.maxQueriesPerContext`; fallback pass `skipPrefilter: true`, skipped when `fallbackContexts.length === 0 || hasExplicitDocAndPage`.
   - `pinnedItemIds` for rerank = union of `memoryPinnedItemIds`, all `exactPinsByContext` values, all `userPinnedItemIdsByContext` values. `userPinnedItemIds` = union of user pins only (newlkiag `index.ts:133-139`).
   - Phase 3 (newlkiag `index.ts:149-198`): rerank main (steps + yield, incl. score summary step), literal-lookup short-circuit verbatim, fallback gate: `if (!literalLookupSatisfied && fallbackContexts.length > 0 && (reranker ? mainRerank.rerank_score_max_genuine < cfg.tuning.fallbackThreshold : mainRerank.limited_results.length < cfg.tuning.topK))` — the second arm is the no-reranker fallback rule (spec §2.3 / Task 9); fallback rerank with `pinnedItemIds: new Set()`.
   - Phase 4 (newlkiag `index.ts:200-213`): override directive with generalized wording — replace `(e.g. "Das Handbuch nennt …")` with `(e.g. "The manual states …")`; rest verbatim.
   - All verbose `console.log`s gated on `cfg.logging`; warnings always on.
   - Final `return { result: JSON.stringify(result) };` where `result` is the last cumulative output (do NOT return a separate `{status:"done"}` — the framework wrapper keeps the last yield, and Task 10's test asserts the last payload is the full output).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest ee/agentic-retrieval/pipeline/index.test.ts --silent`
Expected: PASS (6 tests). Then run the whole pipeline suite: `npx jest ee/agentic-retrieval/pipeline --silent` — all green.

- [ ] **Step 5: Commit**

```bash
git add ee/agentic-retrieval/pipeline/index.ts ee/agentic-retrieval/pipeline/index.test.ts
git commit -m "feat(retrieval): pipeline tool factory with static config and gated orchestration"
```

---

### Task 11: Wire call sites, delete v3, remove session-tools hook

**Files:**
- Modify: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts:14-15, 231-258, 274-282, 336`
- Modify: `src/utils/enabled-tools.ts:1, 23-33`
- Modify: `src/graphql/utilities/sanitize-and-hydrate-fields.ts:4, 148-165`
- Modify: `src/graphql/schemas/index.ts:27, 1923-1932`
- Modify: `src/index.ts:11, 71, 76-84`
- Delete: `ee/agentic-retrieval/v3/` (whole directory)
- Test: existing suites (`npx jest --silent`) + `npx tsc --noEmit`

**Interfaces:**
- Consumes: `createAgenticRetrievalTool` (Task 10 signature).
- Produces: package export `ExuluDefaultTools.agentic.retrieval.create.pipeline`; `ExuluTrajectoryRegistry` export removed; no references to `@EE/agentic-retrieval/v3` remain anywhere.

- [ ] **Step 1: Rewire each call site**

All four factory call sites: change the import to `import { createAgenticRetrievalTool } from "@EE/agentic-retrieval/pipeline/index";` and the call name accordingly.

`convert-exulu-tools-to-ai-sdk-tools.ts` — additionally:
- Delete line 15 (`getSessionTools` import) and the `sessionDynamicTools` block (lines 274-282) and its `...sessionDynamicTools,` spread (line 336).
- In the live instantiation (lines 233-240), pass the memory context instead of silently dropping it:

```ts
    const agenticSearchTool = createAgenticRetrievalTool({
      contexts: contexts.filter((context) => context.id !== agent?.memory), // memory is searched by the memory phase, not as a KB
      memoryContext: agent?.memory ? contexts.find((c) => c.id === agent.memory) : undefined,
      user: user,
      role: user?.role?.id,
      model: model,
      preselected: sessionItems,
      memoryItems: memoryItems,
    });
```

`enabled-tools.ts:24-32` and `sanitize-and-hydrate-fields.ts:149-154` and `graphql/schemas/index.ts:1924-1929`: rename the call; keep their existing arguments (`contexts: allContexts` / `[]` / `contexts`, `model: undefined`).

`src/index.ts`: delete line 11 (`ExuluTrajectoryRegistry` export); change line 71 to import `createAgenticRetrievalTool` from `@EE/agentic-retrieval/pipeline/index.ts`; change the export object to:

```ts
export const ExuluDefaultTools = {
  agentic: {
    retrieval: {
      create: {
        pipeline: createAgenticRetrievalTool
      }
    },
  },
}
```

- [ ] **Step 2: Delete v3 and verify no references remain**

```bash
git rm -r ee/agentic-retrieval/v3
grep -rn "agentic-retrieval/v3\|createAgenticRetrievalToolV3\|getSessionTools\|trajectoryRegistry" src ee types --include="*.ts"
```
Expected: grep returns nothing.

- [ ] **Step 3: Type-check and run the full test suite**

Run: `npx tsc --noEmit && npx jest --silent`
Expected: both clean. Fix any residual import fallout (e.g. modules importing v3 types) by pointing them at `@EE/agentic-retrieval/pipeline/types` — do not re-add v3 files.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(retrieval)!: replace v3 step-loop with pipeline engine; drop session dynamic tools and trajectory registry"
```

---

### Task 12: Saved-config migration script

**Files:**
- Create: `scripts/migrate-agentic-retrieval-config.ts`
- Test: `src/utils/migrate-agentic-retrieval-config.test.ts` (jest roots don't cover `scripts/`; the pure transform lives in `src/utils/` so it's testable and the script stays a thin CLI)
- Create: `src/utils/migrate-agentic-retrieval-config.ts` (the pure transform)

**Interfaces:**
- Produces:

```ts
// src/utils/migrate-agentic-retrieval-config.ts
export type SavedToolConfigEntry = { name: string; variable: any; type: string };
export type SavedTool = { id: string; type?: string; name?: string; description?: string; config: SavedToolConfigEntry[] };
/** Returns the migrated tool, or null when the tool is already in the new format / not the retrieval tool. */
export function migrateAgenticToolConfig(tool: SavedTool): SavedTool | null;
```

Mapping (spec §3.3): keep `instructions`, `reranker`, `managed_context`, `require_preselected_contexts`, `logging` verbatim (type unchanged). Fold `${ctx}_|_enabled` → `knowledgeBases[ctx].enabled` (coercing `"true"/"false"` strings), `${ctx}_|_instructions` → `.instructions`, `${ctx}_|_max_results` → `.overrides.limit` (numeric > 0 only), `${ctx}_|_expand_chunks` → `.overrides.expand` (numeric > 0 only). Drop `${ctx}_|_priority`, `${ctx}_|_max_steps`, `reasoning_model`, `search_model`. Emit the five new json entries (`knowledge_bases` from the folded map — only contexts that had at least one non-default old value; `routing`/`vocabulary`/`memory`/`tuning` as `""` so declared defaults apply). Detection: a tool is old-format iff `id === "agentic_context_search"` AND (some config name contains `"_|_"` OR some name is `reasoning_model`/`search_model`) — otherwise return null.

- [ ] **Step 1: Write the failing test**

```ts
// src/utils/migrate-agentic-retrieval-config.test.ts
import { migrateAgenticToolConfig } from "./migrate-agentic-retrieval-config";

const oldTool = {
  id: "agentic_context_search",
  config: [
    { name: "instructions", variable: "be careful", type: "string" },
    { name: "managed_context", variable: "true", type: "boolean" },
    { name: "reasoning_model", variable: "gpt", type: "string" },
    { name: "ctxA_|_enabled", variable: "false", type: "boolean" },
    { name: "ctxA_|_instructions", variable: "check here first", type: "string" },
    { name: "ctxA_|_max_results", variable: "50", type: "number" },
    { name: "ctxA_|_expand_chunks", variable: "3", type: "number" },
    { name: "ctxA_|_priority", variable: "2", type: "number" },
    { name: "ctxB_|_enabled", variable: "true", type: "boolean" },
  ],
};

describe("migrateAgenticToolConfig", () => {
  it("folds per-context keys into knowledge_bases and drops dead keys", () => {
    const migrated = migrateAgenticToolConfig(oldTool as any)!;
    const byName = Object.fromEntries(migrated.config.map((c) => [c.name, c]));
    expect(byName["instructions"].variable).toBe("be careful");
    expect(byName["managed_context"].variable).toBe("true");
    expect(byName["reasoning_model"]).toBeUndefined();
    expect(byName["ctxA_|_enabled"]).toBeUndefined();
    const kbs = JSON.parse(byName["knowledge_bases"].variable);
    expect(kbs.ctxA).toEqual({ enabled: false, instructions: "check here first", overrides: { limit: 50, expand: 3 } });
    expect(kbs.ctxB).toBeUndefined(); // enabled=true with no other values is the default — omitted
    expect(byName["knowledge_bases"].type).toBe("json");
    expect(byName["routing"].variable).toBe("");
  });

  it("returns null for already-migrated tools and for other tools", () => {
    expect(migrateAgenticToolConfig({ id: "agentic_context_search",
      config: [{ name: "knowledge_bases", variable: "{}", type: "json" }] } as any)).toBeNull();
    expect(migrateAgenticToolConfig({ id: "other_tool", config: [{ name: "a_|_b", variable: "x", type: "string" }] } as any)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/utils/migrate-agentic-retrieval-config.test.ts --silent`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the transform and the CLI script**

Implement `src/utils/migrate-agentic-retrieval-config.ts` per the mapping above. Then the thin CLI:

```ts
// scripts/migrate-agentic-retrieval-config.ts
// One-off migration: rewrites agents.tools JSON from the v3 agentic-retrieval
// config format (flat ${ctx}_|_* keys) to the pipeline format (json options).
// Usage: npx tsx scripts/migrate-agentic-retrieval-config.ts [--dry-run]
import { postgresClient } from "../src/postgres/client";
import { migrateAgenticToolConfig, type SavedTool } from "../src/utils/migrate-agentic-retrieval-config";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const { db } = await postgresClient();
  const agents = await db.from("agents").select(["id", "name", "tools"]);
  let migrated = 0;
  for (const agent of agents) {
    const tools: SavedTool[] = typeof agent.tools === "string" ? JSON.parse(agent.tools) : agent.tools;
    if (!Array.isArray(tools)) continue;
    let changed = false;
    const next = tools.map((tool) => {
      const m = migrateAgenticToolConfig(tool);
      if (m) changed = true;
      return m ?? tool;
    });
    if (!changed) continue;
    migrated++;
    console.log(`${dryRun ? "[dry-run] would migrate" : "migrating"} agent ${agent.id} (${agent.name})`);
    if (!dryRun) await db.from("agents").where({ id: agent.id }).update({ tools: JSON.stringify(next) });
  }
  console.log(`${dryRun ? "[dry-run] " : ""}done — ${migrated} agent(s) ${dryRun ? "would be" : ""} migrated.`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 4: Run test + dry-run smoke check**

Run: `npx jest src/utils/migrate-agentic-retrieval-config.test.ts --silent`
Expected: PASS. (The CLI itself needs a live DB; verifying the transform unit-wise is sufficient here — the dry-run flag exists for the operator.)

- [ ] **Step 5: Full suite, then commit**

Run: `npx tsc --noEmit && npx jest --silent`
Expected: clean.

```bash
git add scripts/migrate-agentic-retrieval-config.ts src/utils/migrate-agentic-retrieval-config.ts src/utils/migrate-agentic-retrieval-config.test.ts
git commit -m "feat(retrieval): standalone dev-run migration for saved v3 tool configs"
```

---

## Plan Self-Review Notes

- Spec coverage: §2.1 identity/exports (Tasks 10, 11), §2.2 input schema (Task 10), §2.3 stages (Tasks 6-10), §2.4 output/models (Tasks 10), §2.5 deletions (Task 11), §3.1 json type (Task 1), §3.2 options (Tasks 2, 10), §3.3 migration script (Task 12), §6 error handling (degradation baked into Tasks 4-10 tests), §7 backend testing (every task). §4 (frontend) and §5 (newlkiag) are plans 2 and 3.
- The no-reranker fallback gate (`limited_results.length < topK`) refines spec §2.3's "no reranker → hybrid-score ordering" for the fallback-trigger decision; recorded in Task 10 step 3.
- Type names used across tasks were cross-checked: `PipelineConfig`/`KbProfile`/`IdentifierSet`/`EffectiveKbSettings` (Task 2), `Chunk`/`ChunkWithScore`/`PhaseStep`/phase results (Task 3), function names consumed downstream (`fuzzyPrefilter`, `exactTokenPrefilter`, `resolveIdentifierPins`, `singleSearch`, `multiQuerySearch`, `generateHydePassage`, `runRoutingPhase`, `runMemoryPhase`, `searchContexts`, `rerankResults`, `parsePreselectedItems`, `createAgenticRetrievalTool`, `migrateAgenticToolConfig`).
