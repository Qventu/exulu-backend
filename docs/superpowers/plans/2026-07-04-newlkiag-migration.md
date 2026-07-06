# newlkiag Migration to Library Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Newton agent off newlkiag's local `knowledge_search` tool onto the exulu library's `agentic_context_search` pipeline via config, validate side-by-side, then delete the local implementation and every module it orphans (spec §5).

**Architecture:** A tested pure config module (`src/migration/newton-pipeline-config.ts`) encodes ALL of Newton's client-specific behavior as the pipeline tool's 11 config entries (kb profiles, the five routing rules, the abbreviation glossary, product/norm identifier sets, rewrite rules, German style hint, tuning). A dev-run DB script swaps the agent's tool list; a comparison script runs representative queries through both implementations for the validation gate; only after the gate passes does the deletion task remove `src/tools/knowledge_search/` plus the orphaned support graph — leaving `src/harness/`, `getZendeskTicket`, `src/utils/with-retry.ts`, and `src/utils/s3-path-info.ts` untouched.

**Tech Stack:** TypeScript (tsx), `@exulu/backend` (pipeline release), vitest, knex via `postgresClient`, zod.

**Spec:** `docs/superpowers/specs/2026-07-03-agentic-retrieval-pipeline-design.md` §5 (in exulu/backend). Plans 1 (backend, merged) and 2 (frontend wizard, merged) precede this.

## Global Constraints

- Target repo: `/Users/daniel.claessen/Desktop/Projects/newlkiag` (execution in a worktree of THAT repo; paths below relative to its root unless absolute).
- **Prerequisite:** `@exulu/backend` is SYMLINKED to the local exulu/backend repo (develop ≥ `68fa73c` — the pipeline merge). Task 1 smoke-verifies `ExuluDefaultTools.agentic.retrieval.create.pipeline` resolves through the symlink; if it doesn't, build the backend first (`npm run build` in /Users/daniel.claessen/Desktop/Projects/exulu/backend — the package entry points at `dist/`). Before any DEPLOY, the symlink must be replaced by a published release containing the pipeline.
- **Context ids (exact):** `tech_doc_context`, `vorschriften_context`, `software_documentation_context`, `custom_documents_context`, `zendesk_context`, `new_servicedb_context`; memory: `newton_memory_context` (the agent's `memory` — it gets NO kb profile; the platform excludes it from the tool's contexts).
- **Untouchable:** `src/harness/**` (incl. the `NEWTON_USE_AGENTIC_RETRIEVAL` flag path in `exulu.ts` and the `/agentic-retrieval` + citation/feedback endpoints in `server.ts`), `getZendeskTicket`, `src/utils/with-retry.ts` (used by `src/harness/feedback-agent.ts`), `src/utils/s3-path-info.ts` (used by `src/contexts/contexts.ts`), `src/integrations/**`.
- **Deletion set (Task 6, only after the Task 5 gate):** `src/tools/knowledge_search/` (whole dir incl. tests); in `src/tools/index.ts` the `knowledgeSearchOld` tool, its local `splitChunksIntoGroups`, `parsePreselectedItems`, `AVAILABLE_SOURCES`, and all their now-unused imports (keep `getZendeskTicket` + its imports); `src/tools/techdoc.ts`, `src/tools/zendesk.ts`, `src/tools/new-services-db.ts`, `src/tools/newton-memory.ts`, `src/tools/exulu-search.ts`; `src/utils/rag-config.ts`, `src/utils/prefilter.ts`, `src/utils/reranker.ts`, `src/utils/retrieval-recall.ts`, `src/utils/multi-query-search.ts`, `src/utils/query-expansion.ts`; `src/types/rag.ts`, `src/types/retrieval.ts`; the `/knowledge-search` endpoint in `server.ts` (+ its then-unused imports: `knowledgeSearch`, `searchNewtonMemory`, `RAG_CONFIGURATION`); `scripts/compare-retrieval.ts` + `scripts/retrieval-queries.json` (validation served; git history preserves them).
- Value conventions on saved config entries: booleans `"true"`/`"false"` strings; strings raw; json values `JSON.stringify`'d strings — identical to what the exulu frontend wizard writes.
- Accepted parity deltas (spec §5.3 "small deltas in generalized edges are acceptable, missing documents are not"): (a) the error-code COMPOSITION pattern (`S2 CMP Input` → `S2-FEHL.CMP-INPUT` variants) is not expressible as literal find/replace rewrites — HyDE + glossary augmentation compensate; (b) German suffix-stemming in the fuzzy prefilter was generalized away; (c) query augmentation runs only when memory recall finds relevant chunks (reference parity of the library tool).
- Tests: vitest (`npm test`). Record the baseline suite state in Task 1 before any change; criterion thereafter: no NEW failures.
- Commit format (commitlint-enforced in this repo): header `[FEATURE|FIX|CHANGE|DOC|TASK] subject`, and the body is MANDATORY — pass the Co-Authored-By trailer as a second `-m`. Conventional-commit style (`feat:`) is REJECTED by the hook.
- Commit after every task with trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File Structure

```
src/migration/newton-pipeline-config.ts        pure: the full pipeline config + 11-entry serialization
src/migration/newton-pipeline-config.test.ts
src/migration/apply-to-agent.ts                pure: rewrite an agent's tools array (swap knowledge_search → agentic_context_search)
src/migration/apply-to-agent.test.ts
scripts/migrate-newton-agent.ts                dev-run CLI: apply to the DB (--dry-run)
scripts/compare-retrieval.ts                   dev-run CLI: side-by-side old vs new per query (deleted again in Task 6)
scripts/retrieval-queries.json                 representative query set (deleted again in Task 6)
Modified (Task 6): src/tools/index.ts, server.ts, exulu.ts (only if imports break), package.json (Task 1)
Deleted (Task 6): per the Deletion set above
```

---

### Task 1: Verify the symlinked package + record baseline

**Files:**
- Create: `.superpowers/sdd/baseline.md` (recorded baseline — scratch, not committed). No package.json change — `@exulu/backend` is already symlinked to the local repo.

**Interfaces:**
- Produces: a verified `@exulu/backend` exposing `ExuluDefaultTools.agentic.retrieval.create.pipeline` and `postgresClient` through the symlink; a recorded vitest/tsc baseline.

- [ ] **Step 1: Verify the symlink and smoke-verify the export**

```bash
ls -la node_modules/@exulu/backend | head -2   # confirm it is a symlink to the local repo
npx tsx -e "import { ExuluDefaultTools } from '@exulu/backend'; console.log(typeof ExuluDefaultTools.agentic.retrieval.create.pipeline)"
```
Expected: `function`. If it prints `undefined` or the import fails: the backend `dist/` is stale — run `npm run build` in `/Users/daniel.claessen/Desktop/Projects/exulu/backend` and retry. Still failing → STOP, report BLOCKED.

- [ ] **Step 2: Record the baseline**

Run: `npm test 2>&1 | tail -5` and `npx tsc --noEmit 2>&1 | grep -c "error TS"` — record both outputs (test counts and error count) in `.superpowers/sdd/baseline.md`. Any failure caused by the new package version (the old tool must keep compiling — `ExuluTool`, `ExuluReranker`, `ExuluContext` are still exported) must be fixed or reported BLOCKED before proceeding.

- [ ] **Step 3: No commit** (nothing tracked changed; proceed to Task 2).

---

### Task 2: Newton pipeline config module (the parity artifact)

**Files:**
- Create: `src/migration/newton-pipeline-config.ts`
- Test: `src/migration/newton-pipeline-config.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 3 and 4):

```ts
export const NEWTON_KNOWLEDGE_BASES: Record<string, unknown>;
export const NEWTON_ROUTING: { rules: Array<{ id: string; label: string; description: string; main: string[]; fallback: string[] }> };
export const NEWTON_VOCABULARY: { glossary: { term: string; meaning: string }[]; identifiers: unknown[]; rewrites: { find: string; replace: string }[]; styleHint: string };
export const NEWTON_MEMORY: { enabled: boolean; override: boolean; filePrioritization: boolean; queryAugmentation: boolean };
export const NEWTON_TUNING: Record<string, number>;
export type ConfigEntry = { name: string; variable: string; type: "string" | "boolean" | "json" };
export function buildNewtonPipelineEntries(): ConfigEntry[]; // exactly 11, ready to store on the agent
```

Content — transcribed from the deleted-to-be sources; every value below is normative:

`NEWTON_KNOWLEDGE_BASES` (overrides only where the old `RAG_CONFIGURATION` differed from the pipeline's kind presets — techdoc limit 100/expand 7 = documents preset, no override; zendesk was limit 10 ≠ conversations preset 20; newservicedb was limit 10 ≠ records preset 20):

```ts
export const NEWTON_KNOWLEDGE_BASES = {
  tech_doc_context: { enabled: true, kind: "documents", instructions: "Technical manuals and datasheets for NEW LIFT controllers. Check here first for technical questions about products, error codes, parameters, and installation.", overrides: {} },
  vorschriften_context: { enabled: true, kind: "documents", instructions: "Norms, standards, directives and regulations (DIN, EN, ISO, VDI, EU directives).", overrides: {} },
  software_documentation_context: { enabled: true, kind: "documents", instructions: "Software release notes, updates and change documentation.", overrides: {} },
  custom_documents_context: { enabled: true, kind: "documents", instructions: "Manually uploaded documents; broad backup source.", overrides: {} },
  zendesk_context: { enabled: true, kind: "conversations", instructions: "Support tickets and customer correspondence.", overrides: { limit: 10 } },
  new_servicedb_context: { enabled: true, kind: "records", instructions: "Service database records.", overrides: { limit: 10 } },
};
```

`NEWTON_ROUTING` — the five rules, descriptions verbatim from the old `requestCategories`, main/fallback verbatim from the old `contextsForCategory`:

```ts
export const NEWTON_ROUTING = {
  rules: [
    { id: "technical", label: "Technical", description: "The question is related to a specific product, system or part, asks for things like dimensions, error codes, specifications, etc.", main: ["tech_doc_context"], fallback: ["new_servicedb_context", "zendesk_context", "custom_documents_context"] },
    { id: "service", label: "Service", description: "The user specifically asks for a Ticket, or a correspondence with a client", main: ["zendesk_context", "new_servicedb_context"], fallback: ["custom_documents_context"] },
    { id: "software", label: "Software", description: "The user specifically asks for software updates or changes", main: ["software_documentation_context"], fallback: ["new_servicedb_context", "zendesk_context", "tech_doc_context", "vorschriften_context", "custom_documents_context"] },
    { id: "regulatory", label: "Regulatory", description: "The user specifically asks for a regulation, standard, or legal requirement", main: ["vorschriften_context", "zendesk_context", "new_servicedb_context"], fallback: ["tech_doc_context", "software_documentation_context", "custom_documents_context"] },
    { id: "market", label: "Market", description: "The user asks for market information such as market share, market trends, market size, etc.", main: ["tech_doc_context", "vorschriften_context", "software_documentation_context", "zendesk_context", "new_servicedb_context", "custom_documents_context"], fallback: ["custom_documents_context"] },
  ],
};
```

`NEWTON_VOCABULARY` — glossary transcribed VERBATIM from the old `ABBREVIATION_GLOSSARY` (`src/tools/knowledge_search/memory.ts:169-232`; the implementer MUST copy term/meaning pairs from that file, one entry per glossary line — 55 entries: ABS, ADM, AKM, ASM, ASV, AUX, AWE, AWM, "CBM / CBM2", CMM, DMS, DMT, "DOOR-Relais", EAZ, ECO, EVAC, "FK / FKT", FPA, FPE, FPM, FSM, FSM-CAN, FST, GB, GND, GST, HEM, HHT, HSG, KO, KU, L, LBG, LCS, LED, LON, LSU, MRL, "MSB-RC / MSB2", NBM, PE, RIO, "S1 / Safebox", SAM, SBR, SG, SHK, SK, TCH, TDF, UCM, UGW, ve, MIPA, LS — e.g. `{ term: "FST", meaning: "Feldbussteuerung (das zentrale Steuerungssystem)" }`); plus:

```ts
  identifiers: [
    { name: "Product names", description: "NEW LIFT product and controller names such as FST, ECO, CBM-2. Return both stem and full form (FST-3 → FST and FST-3).", examples: ["FST", "FST-2XT", "ECO", "CBM-2", "PAM", "EAZ"], strategy: "fuzzy", contexts: ["tech_doc_context"] },
    { name: "Norms and standards", description: "Norms, standards, directives or regulations — e.g. \"DIN 8100\", \"DIN EN ISO 8100-1-2\", \"EN 81-20\", \"VDI 4707\", \"2014/33/EU\".", examples: ["DIN 8100", "EN 81-20", "VDI 4707", "2014/33/EU", "ISO 8100-1"], strategy: "exact", contexts: ["vorschriften_context"] },
  ],
  rewrites: [
    { find: "umgehung", replace: "bypass" },
    { find: "fehlt", replace: "FEHL" },
    { find: "fehler", replace: "FEHL" },
    { find: "störung", replace: "FEHL" },
    { find: "eingang", replace: "INPUT" },
    { find: "ausgang", replace: "OUTPUT" },
    { find: "input", replace: "INPUT" },
    { find: "output", replace: "OUTPUT" },
  ],
  styleHint: "Deutsche technische Handbücher für Aufzugssteuerungen (NEW LIFT): Menüpfade, Parameter, Klemmen, Register, Bit-Belegungen, Funktionsnamen und Fehlercodes (z.B. S2-FEHL.CMP-INPUT).",
```

`NEWTON_MEMORY = { enabled: true, override: true, filePrioritization: true, queryAugmentation: true }` (all four features were live in the old tool).

`NEWTON_TUNING = { topK: 5, fallbackThreshold: 0.95, pinBoost: 0.15, identifierBoost: 0.15, pageWindow: 1, maxQueriesPerContext: 5 }` (the old constants; identical to the pipeline defaults — emitted explicitly so the agent's config is self-documenting).

`buildNewtonPipelineEntries()` returns exactly these 11 entries in order: `instructions` ("", string), `reranker` ("cohere/rerank-v4.0-pro", string — the LiteLLM model_name from `config.litellm.yaml`, same value the old `cohereReranker` hardcoded), `managed_context` ("false", boolean), `require_preselected_contexts` ("false", boolean), `logging` ("false", boolean), `utility_model` ("", string), then the five json entries (`knowledge_bases`, `routing`, `vocabulary`, `memory`, `tuning`) with `JSON.stringify` of the constants above.

- [ ] **Step 1: Write the failing test**

```ts
// src/migration/newton-pipeline-config.test.ts
import { describe, it, expect } from "vitest";
import {
  buildNewtonPipelineEntries, NEWTON_ROUTING, NEWTON_VOCABULARY, NEWTON_KNOWLEDGE_BASES,
} from "./newton-pipeline-config";

describe("buildNewtonPipelineEntries", () => {
  it("emits exactly the 11 pipeline options with platform value conventions", () => {
    const entries = buildNewtonPipelineEntries();
    expect(entries.map((e) => e.name)).toEqual([
      "instructions", "reranker", "managed_context", "require_preselected_contexts",
      "logging", "utility_model", "knowledge_bases", "routing", "vocabulary", "memory", "tuning",
    ]);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName["reranker"]).toEqual({ name: "reranker", variable: "cohere/rerank-v4.0-pro", type: "string" });
    expect(byName["managed_context"]).toEqual({ name: "managed_context", variable: "false", type: "boolean" });
    for (const json of ["knowledge_bases", "routing", "vocabulary", "memory", "tuning"]) {
      expect(byName[json].type).toBe("json");
      expect(() => JSON.parse(byName[json].variable)).not.toThrow();
    }
  });

  it("routing rules replicate the old contextsForCategory map exactly", () => {
    const byId = Object.fromEntries(NEWTON_ROUTING.rules.map((r) => [r.id, r]));
    expect(NEWTON_ROUTING.rules).toHaveLength(5);
    expect(byId["technical"].main).toEqual(["tech_doc_context"]);
    expect(byId["technical"].fallback).toEqual(["new_servicedb_context", "zendesk_context", "custom_documents_context"]);
    expect(byId["service"].main).toEqual(["zendesk_context", "new_servicedb_context"]);
    expect(byId["regulatory"].main).toEqual(["vorschriften_context", "zendesk_context", "new_servicedb_context"]);
    expect(byId["software"].fallback).toHaveLength(5);
    expect(byId["market"].main).toHaveLength(6);
  });

  it("vocabulary carries the full glossary, both identifier sets, and the rewrite rules", () => {
    expect(NEWTON_VOCABULARY.glossary.length).toBeGreaterThanOrEqual(50);
    expect(NEWTON_VOCABULARY.glossary.find((g) => g.term === "FST")?.meaning).toContain("Feldbussteuerung");
    expect(NEWTON_VOCABULARY.glossary.find((g) => g.term === "UCM")?.meaning).toContain("Unintended Car Movement");
    expect(NEWTON_VOCABULARY.identifiers.map((i: any) => i.strategy).sort()).toEqual(["exact", "fuzzy"]);
    expect(NEWTON_VOCABULARY.rewrites).toContainEqual({ find: "störung", replace: "FEHL" });
    expect(NEWTON_VOCABULARY.styleHint).toContain("Aufzugssteuerungen");
  });

  it("kb profiles cover all six searchable contexts (memory context excluded) with the old limits preserved", () => {
    expect(Object.keys(NEWTON_KNOWLEDGE_BASES).sort()).toEqual([
      "custom_documents_context", "new_servicedb_context", "software_documentation_context",
      "tech_doc_context", "vorschriften_context", "zendesk_context",
    ]);
    expect((NEWTON_KNOWLEDGE_BASES as any).zendesk_context.overrides.limit).toBe(10);
    expect((NEWTON_KNOWLEDGE_BASES as any).zendesk_context.kind).toBe("conversations");
    expect((NEWTON_KNOWLEDGE_BASES as any).new_servicedb_context.kind).toBe("records");
    expect((NEWTON_KNOWLEDGE_BASES as any).tech_doc_context.overrides).toEqual({});
    expect(NEWTON_KNOWLEDGE_BASES).not.toHaveProperty("newton_memory_context");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/migration/newton-pipeline-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** per the normative content above (glossary transcribed verbatim from `src/tools/knowledge_search/memory.ts:169-232`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/migration/newton-pipeline-config.test.ts` — PASS (4 tests). Then `npm test` — no new failures vs baseline.

- [ ] **Step 5: Commit**

```bash
git add src/migration/
git commit -m "[FEATURE] newton pipeline config translating knowledge_search behavior" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Agent tool-list rewrite (pure transform + CLI)

**Files:**
- Create: `src/migration/apply-to-agent.ts`
- Create: `scripts/migrate-newton-agent.ts`
- Test: `src/migration/apply-to-agent.test.ts`

**Interfaces:**
- Consumes: `buildNewtonPipelineEntries`, `ConfigEntry` (Task 2).
- Produces:

```ts
// src/migration/apply-to-agent.ts
export type SavedAgentTool = { id: string; type?: string; name?: string; description?: string; config?: unknown[] };
/** Returns the rewritten tools array, or null when the agent has no knowledge_search entry
 *  and no agentic_context_search entry to update (nothing to do). Idempotent. */
export function applyPipelineToolToAgent(tools: SavedAgentTool[]): SavedAgentTool[] | null;
```

Behavior: remove any entry with `id === "knowledge_search"`; upsert the entry `{ id: "agentic_context_search", type: "context", name: "Context Search", config: buildNewtonPipelineEntries() }` (replace config wholesale if the entry already exists); return null when the input contains neither (already migrated with config present and no knowledge_search → compare the existing agentic entry's config to the built entries; identical → null). All other entries pass through untouched, order preserved (agentic entry appended at the end when new, kept in place when updated).

CLI (`scripts/migrate-newton-agent.ts`): mirrors the exulu backend migration-script pattern — load agents via `postgresClient` from `@exulu/backend`, `JSON.parse` string `tools`, run the transform, `--dry-run` flag, per-agent summary log, `JSON.stringify` on write, exit codes. Usage comment: `npx tsx scripts/migrate-newton-agent.ts [--dry-run]` — run against the SAME database the newlkiag deployment uses (env-driven, like every other script in this repo).

- [ ] **Step 1: Write the failing test**

```ts
// src/migration/apply-to-agent.test.ts
import { describe, it, expect } from "vitest";
import { applyPipelineToolToAgent } from "./apply-to-agent";
import { buildNewtonPipelineEntries } from "./newton-pipeline-config";

describe("applyPipelineToolToAgent", () => {
  it("swaps knowledge_search for a fully configured agentic_context_search", () => {
    const result = applyPipelineToolToAgent([
      { id: "knowledge_search", type: "context", name: "Knowledge_context_search", config: [] },
      { id: "get_zendesk_ticket", type: "function", name: "Get_zendesk_ticket", config: [] },
    ])!;
    expect(result.map((t) => t.id)).toEqual(["get_zendesk_ticket", "agentic_context_search"]);
    const agentic = result.find((t) => t.id === "agentic_context_search")!;
    expect(agentic.config).toEqual(buildNewtonPipelineEntries());
    expect(agentic.type).toBe("context");
  });

  it("updates an existing agentic entry's config in place", () => {
    const result = applyPipelineToolToAgent([
      { id: "agentic_context_search", type: "context", name: "Context Search", config: [{ name: "stale", variable: "x", type: "string" }] },
      { id: "other", type: "function", config: [] },
    ])!;
    expect(result.map((t) => t.id)).toEqual(["agentic_context_search", "other"]);
    expect(result[0].config).toEqual(buildNewtonPipelineEntries());
  });

  it("is idempotent: returns null when already migrated with identical config", () => {
    const migrated = applyPipelineToolToAgent([
      { id: "knowledge_search", type: "context", config: [] },
    ])!;
    expect(applyPipelineToolToAgent(migrated)).toBeNull();
  });

  it("returns null for agents without either tool", () => {
    expect(applyPipelineToolToAgent([{ id: "other", type: "function", config: [] }])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/migration/apply-to-agent.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement the transform, then the CLI**

```ts
// scripts/migrate-newton-agent.ts
// One-off migration: moves any agent using the local knowledge_search tool onto the
// exulu library pipeline tool (agentic_context_search) with the full Newton config.
// Usage: npx tsx scripts/migrate-newton-agent.ts [--dry-run]
import { postgresClient } from "@exulu/backend";
import { applyPipelineToolToAgent, type SavedAgentTool } from "../src/migration/apply-to-agent";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const { db } = await postgresClient();
  const agents = await db.from("agents").select(["id", "name", "tools"]);
  let migrated = 0;
  for (const agent of agents) {
    const tools: SavedAgentTool[] = typeof agent.tools === "string" ? JSON.parse(agent.tools) : agent.tools;
    if (!Array.isArray(tools)) continue;
    const next = applyPipelineToolToAgent(tools);
    if (!next) continue;
    migrated++;
    console.log(`${dryRun ? "[dry-run] would migrate" : "migrating"} agent ${agent.id} (${agent.name})`);
    if (!dryRun) await db.from("agents").where({ id: agent.id }).update({ tools: JSON.stringify(next) });
  }
  console.log(`${dryRun ? "[dry-run] " : ""}done — ${migrated} agent(s) ${dryRun ? "would be" : ""} migrated.`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/migration/apply-to-agent.test.ts` — PASS (4 tests). `npm test` — no new failures.

- [ ] **Step 5: Commit**

```bash
git add src/migration/ scripts/migrate-newton-agent.ts
git commit -m "[FEATURE] agent tool-list rewrite script for the pipeline tool" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Side-by-side comparison harness

**Files:**
- Create: `scripts/compare-retrieval.ts`
- Create: `scripts/retrieval-queries.json`

**Interfaces:**
- Consumes: local `knowledgeSearch` (`src/tools/knowledge_search`), `searchNewtonMemory` (`src/tools/newton-memory`), `RAG_CONFIGURATION`; library `ExuluDefaultTools.agentic.retrieval.create.pipeline`; `buildNewtonPipelineEntries` (Task 2); `contexts` (`@EXULU_CONTEXTS`); `ExuluDefaultProviders`.
- Produces: a CLI printing, per query, both implementations' retrieved item sets and an overlap summary. Temporary tooling — deleted in Task 6.

- [ ] **Step 1: Create the query set**

```json
[
  { "originalQuestion": "Was bedeutet der Fehler S2 CMP Input beim FST-2XT?", "relevantKeywords": ["S2", "CMP", "Input", "FST-2XT"], "importantKeyword": "FST-2XT", "expects": "technical" },
  { "originalQuestion": "Wie sperre ich die Türseite A beim FST-2XT?", "relevantKeywords": ["Tür", "sperren", "FST-2XT"], "importantKeyword": "FST-2XT", "expects": "technical" },
  { "originalQuestion": "Was fordert die EN 81-20 zur Türüberbrückung?", "relevantKeywords": ["EN 81-20", "Türüberbrückung"], "importantKeyword": "EN 81-20", "expects": "regulatory" },
  { "originalQuestion": "Gibt es ein Ticket zu Problemen mit der Aussenrufquittierung?", "relevantKeywords": ["Ticket", "Aussenrufquittierung"], "importantKeyword": "Aussenrufquittierung", "expects": "service" },
  { "originalQuestion": "Im Handbuch hb_PAM-E4 auf Seite 38, was steht dort zur Verdrahtung?", "relevantKeywords": ["hb_PAM-E4", "Seite 38", "Verdrahtung"], "importantKeyword": "PAM-E4", "expects": "doc+page pin" },
  { "originalQuestion": "Welche Software-Änderungen gab es zuletzt für die ECO Steuerung?", "relevantKeywords": ["Software", "Änderungen", "ECO"], "importantKeyword": "ECO", "expects": "software" },
  { "originalQuestion": "Was bedeutet UCM und wie wird es überwacht?", "relevantKeywords": ["UCM", "Überwachung"], "importantKeyword": "UCM", "expects": "glossary-assisted" },
  { "originalQuestion": "Wie groß ist der Marktanteil von NEW LIFT bei Homeliften?", "relevantKeywords": ["Marktanteil", "Homelift"], "importantKeyword": "Homelift", "expects": "market" }
]
```

- [ ] **Step 2: Implement the comparison CLI**

```ts
// scripts/compare-retrieval.ts
// TEMPORARY side-by-side validation (spec §5.3): runs each query through the local
// knowledge_search tool AND the library pipeline tool, prints retrieved item overlap.
// Requires the full dev env (DB, LiteLLM w/ COHERE_API_KEY, ANTHROPIC_API_KEY).
// Usage: npx tsx scripts/compare-retrieval.ts [--query <index>]
import { readFileSync } from "fs";
import { ExuluDefaultProviders, ExuluDefaultTools } from "@exulu/backend";
import { contexts as ctxObj } from "@EXULU_CONTEXTS";
import { knowledgeSearch } from "../src/tools/knowledge_search";
import { searchNewtonMemory } from "../src/tools/newton-memory";
import { RAG_CONFIGURATION } from "../src/utils/rag-config";
import { buildNewtonPipelineEntries } from "../src/migration/newton-pipeline-config";
import { exulu } from "../exulu";

type QuerySpec = { originalQuestion: string; relevantKeywords: string[]; importantKeyword: string; expects: string };

const drain = async (gen: AsyncGenerator<any>) => { let last: any; for await (const y of gen) last = y; return last; };
const parseOut = (last: any) => (typeof last?.result === "string" ? JSON.parse(last.result) : (last?.result ?? last));
const itemsOf = (out: any): Map<string, string> => {
  const m = new Map<string, string>();
  const collect = (chunks: any[]) => chunks?.forEach((c) => c?.item_id && m.set(c.item_id, c.item_name ?? c.item_id));
  collect(out?.chunks ?? []);
  out?.steps?.forEach((s: any) => collect(s?.chunks ?? []));
  return m;
};

async function main() {
  await exulu(); // boots the app so contexts/DB are initialized
  const queries: QuerySpec[] = JSON.parse(readFileSync("scripts/retrieval-queries.json", "utf8"));
  const only = process.argv.indexOf("--query");
  const selected = only !== -1 ? [queries[Number(process.argv[only + 1])]] : queries;

  const user = { id: 1, email: "compare@local", super_admin: true, role: { id: "test" } } as any;
  const model = ExuluDefaultProviders.anthropic.sonnet45.config!.model!.create({ apiKey: process.env.ANTHROPIC_API_KEY });
  const memoryCtx = (ctxObj as any).newtonMemory;
  const searchable = Object.values(ctxObj).filter((c: any) => c?.id && c.id !== memoryCtx.id) as any[];

  const toolVariablesConfig = Object.fromEntries(buildNewtonPipelineEntries().map((e) => [e.name, e.variable]));
  const pipelineTool = ExuluDefaultTools.agentic.retrieval.create.pipeline({
    contexts: searchable, memoryContext: memoryCtx, user, role: user.role.id, model,
    preselected: [], memoryItems: [],
  });
  if (!pipelineTool) throw new Error("pipeline tool not created — check the agentic-retrieval license");

  for (const q of selected) {
    console.log(`\n=== [${q.expects}] ${q.originalQuestion}`);
    const memory = await searchNewtonMemory({
      originalQuestion: q.originalQuestion, relevantKeywords: q.relevantKeywords, importantKeyword: q.importantKeyword,
      user, role: user.role.id, context: memoryCtx, configuration: RAG_CONFIGURATION,
    } as any);

    const oldOut = parseOut(await drain((knowledgeSearch as any).tool.execute(
      { ...q, model, memory, user, role: user.role.id, sessionItems: [] },
      { toolCallId: "cmp_old_" + Date.now(), messages: [] },
    )));
    const newOut = parseOut(await drain((pipelineTool as any).tool.execute(
      { userQuery: q.originalQuestion, relevantKeywords: q.relevantKeywords, importantKeyword: q.importantKeyword, toolVariablesConfig },
      { toolCallId: "cmp_new_" + Date.now(), messages: [] },
    )));

    const oldItems = itemsOf(oldOut), newItems = itemsOf(newOut);
    const shared = [...oldItems.keys()].filter((id) => newItems.has(id));
    console.log(`old: ${oldItems.size} items | new: ${newItems.size} items | shared: ${shared.length}`);
    console.log(`  old-only: ${[...oldItems.entries()].filter(([id]) => !newItems.has(id)).map(([, n]) => n).join(", ") || "—"}`);
    console.log(`  new-only: ${[...newItems.entries()].filter(([id]) => !oldItems.has(id)).map(([, n]) => n).join(", ") || "—"}`);
  }
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 3: Static verification**

Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` — at the Task 1 baseline. `npm test` — no new failures. (Executing the script needs the dev stack — that is Task 5.)

- [ ] **Step 4: Commit**

```bash
git add scripts/compare-retrieval.ts scripts/retrieval-queries.json
git commit -m "[FEATURE] temporary side-by-side retrieval comparison harness" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: VALIDATION GATE (requires the newlkiag dev stack — human/ops involvement)

**Files:** none committed; results recorded in `.superpowers/sdd/validation-results.md` (scratch).

This task cannot run without the environment (Postgres with real content, LiteLLM proxy with `COHERE_API_KEY` + vertex creds, `ANTHROPIC_API_KEY`, `EXULU_USE_LITELLM=true`). If the environment is not available in the execution session, STOP after documenting exactly what to run — do NOT proceed to Task 6.

- [ ] **Step 1: Dry-run the agent migration**

Run: `npx tsx scripts/migrate-newton-agent.ts --dry-run`
Expected: exactly the Newton agent listed (any additional agents using knowledge_search are expected and fine — record them).

- [ ] **Step 2: Run the comparison**

Run: `npx tsx scripts/compare-retrieval.ts 2>&1 | tee .superpowers/sdd/validation-results.md`

Acceptance criteria (spec §5.3):
- Doc-targeted queries (indexes 0, 1, 4): every document the OLD implementation retrieved appears in the NEW implementation's set (missing documents = FAIL). Extra new-only items are acceptable.
- Norm query (2): the pinned norm document present in both.
- Doc+page query (4): the referenced manual pinned in the new output (check the steps text for the pin message).
- Ticket/service/market/software/glossary queries (3, 5, 6, 7): topical overlap ≥ 1 shared item OR a justified difference recorded (e.g. better routing). Judgment call — record reasoning per query.
- No errors/exceptions from the new tool on any query.

- [ ] **Step 3: Apply the migration + chat smoke test**

Run: `npx tsx scripts/migrate-newton-agent.ts` (no dry-run). Then in the platform chat UI against the Newton agent: ask query 0 and query 4; verify sources render (the chat reads top-level `result.chunks`) and the answers cite the expected manuals. Also verify the agent-editor Knowledge section shows the migrated config in the wizard's summary card.

- [ ] **Step 4: Record the gate decision**

Append PASS/FAIL per criterion to `.superpowers/sdd/validation-results.md`. On any FAIL: fix config in `newton-pipeline-config.ts` (re-run Task 3's script) or escalate a pipeline bug to the exulu backend — do NOT proceed to Task 6 until all criteria pass.

---

### Task 6: Delete the local implementation (only after Task 5 passes)

**Files:**
- Delete: everything in the Global Constraints "Deletion set".
- Modify: `src/tools/index.ts`, `server.ts`.

- [ ] **Step 1: Prune `src/tools/index.ts`**

Remove: the `knowledgeSearchOld` tool (the whole `export const knowledgeSearchOld = new ExuluTool({...})` block), the module-local `splitChunksIntoGroups`, `parsePreselectedItems`, `AVAILABLE_SOURCES`, the `import knowledgeSearch from "./knowledge_search/index";` line, and every import that only served the removed code (`cohereReranker`/`SearchResultTypeWithRerankScore`, `searchZendesk`, `searchTechDoc`, `RAG_CONFIGURATION`, `SearchResultType`, `searchNewServicedb`, `searchNewtonMemoryByKeywords`, `AgenticRetrievalOutput`, `withRetry`, `keywordBasedPrefiltering`/`exactTokenPrefiltering`, `normalizeFileName`, `MODEL_DISAMBIGUATION_BOOST`/`extractModelTokens`/`itemMatchesModelToken`, and `contexts`/`z`/`generateText`/`Output`/`stepCountIs`/`ExuluItem` IF no longer used by `getZendeskTicket` — check each). Keep `getZendeskTicket` (and its `fetchTicket` import) fully intact. The file ends with:

```ts
const tools = [
    getZendeskTicket
]

export default tools;
```

- [ ] **Step 2: Prune `server.ts`**

Delete the entire `server.post("/knowledge-search", ...)` handler and the now-unused imports: `knowledgeSearch`, `searchNewtonMemory`, `RAG_CONFIGURATION`. Keep `/agentic-retrieval` and all harness routes untouched.

- [ ] **Step 3: Delete the files**

```bash
git rm -r src/tools/knowledge_search
git rm src/tools/techdoc.ts src/tools/zendesk.ts src/tools/new-services-db.ts src/tools/newton-memory.ts src/tools/exulu-search.ts
git rm src/utils/rag-config.ts src/utils/prefilter.ts src/utils/reranker.ts src/utils/retrieval-recall.ts src/utils/multi-query-search.ts src/utils/query-expansion.ts
git rm src/types/rag.ts src/types/retrieval.ts
git rm scripts/compare-retrieval.ts scripts/retrieval-queries.json
```

- [ ] **Step 4: Verify nothing references the deleted modules**

```bash
grep -rn "knowledge_search\|knowledgeSearch\|rag-config\|utils/prefilter\|utils/reranker\|retrieval-recall\|multi-query-search\|query-expansion\|tools/techdoc\|tools/zendesk\b\|new-services-db\|newton-memory\|exulu-search\|types/rag\|types/retrieval" src server.ts exulu.ts worker.ts scripts --include="*.ts" 2>/dev/null
```
Expected: matches ONLY inside `src/harness/` (its own independent implementation may mention "knowledge_search" as its drop-in toolId — that is fine and untouchable) and none elsewhere. Investigate anything else before proceeding. Note: `exulu.ts`'s `tools.filter((t) => t.id !== "knowledge_search")` line under the harness flag stays — it is now a no-op guard and belongs to the untouchable harness wiring.

- [ ] **Step 5: Full verification**

Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` (at baseline), `npm test 2>&1 | tail -5` (deleted suites gone; remaining suites — harness etc. — no new failures vs baseline), `npm run build 2>&1 | tail -3` (tsup build succeeds).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "[CHANGE] retire local knowledge_search in favor of the exulu pipeline tool" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Final sweep

- [ ] **Step 1: Re-run everything**

`npm test`, `npx tsc --noEmit`, `npm run build` — all at/better than baseline. Re-run the Step-4 grep from Task 6 — still clean.

- [ ] **Step 2: Deployment notes**

Write `docs/pipeline-migration.md` (in newlkiag) — 15 lines max: the agent now uses the platform tool `agentic_context_search`; config is edited in the agent editor's Knowledge section (wizard); `scripts/migrate-newton-agent.ts` is idempotent and safe to re-run per environment (staging/prod); the `NEWTON_USE_AGENTIC_RETRIEVAL` harness flag is unchanged and still swaps in the harness when set; `@exulu/backend` is currently symlinked to the local repo — replace with a published release containing the pipeline before deploy.

- [ ] **Step 3: Commit**

```bash
git add docs/pipeline-migration.md
git commit -m "[DOC] pipeline migration runbook" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Plan Self-Review Notes

- Spec §5 coverage: §5.1 dependency+enable (Tasks 1, 3), §5.2 config translation (Task 2 — kb kinds, five routing rules, glossary, identifiers fuzzy/exact, rewrites, styleHint, memory all-on, tuning), §5.3 validate-before-delete (Tasks 4-5 with the missing-documents-FAIL criterion), §5.4 deletion with per-module usage checks (Task 6; usage graph pre-verified: `with-retry` kept for harness/feedback-agent, `s3-path-info` kept for contexts, harness + getZendeskTicket untouched).
- Environment-gated steps are isolated in Task 5 with an explicit STOP instruction — Tasks 1-4 and 6-7 are executable without the stack, but 6 is sequenced strictly after the gate.
- Type consistency: `ConfigEntry`/`buildNewtonPipelineEntries` (Task 2) consumed by Tasks 3-4; `applyPipelineToolToAgent`/`SavedAgentTool` (Task 3) consumed by its CLI; comparison script consumes only pre-existing exports plus Task 2.
- Known judgment point flagged for the executor: Task 6 Step 1's "IF no longer used by getZendeskTicket" import checks require reading the getZendeskTicket block — its usage of `z`, `generateText`, `fetchTicket` etc. must be verified rather than assumed.
