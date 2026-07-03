# Agentic Retrieval Pipeline — Design

**Date:** 2026-07-03
**Status:** Approved design, pending implementation plan
**Replaces:** `ee/agentic-retrieval/v3` (tool id `agentic_context_search`)
**Source of truth for behavior:** `newlkiag/src/tools/knowledge_search` (the client's 4-phase retrieval pipeline). The newlkiag `src/harness` implementation (broad sweep, inner-agent loop) is explicitly **out of scope**.

## 1. Context & goals

The newlkiag client project built a `knowledge_search` tool on top of the exulu library that outperforms the library's own `agentic-retrieval/v3`: a deterministic 4-phase pipeline (memory + routing → main/fallback search → rerank → memory override) with ~7–9 small LLM calls per query. Its logic is generic; its configuration (context ids, category routing, German elevator vocabulary, thresholds) is hardcoded.

Goals:

1. Port that pipeline into the exulu backend as the new engine behind the existing tool id `agentic_context_search`, replacing the v3 step-loop implementation entirely.
2. Abstract every client-specific element into `ExuluTool` config options, at **core parity**: contexts + per-context treatment, routing categories, glossary/domain vocabulary, memory features, and key thresholds are configurable; highly bespoke edges (German stemming, error-code rewrite logic) are generalized into simpler equivalents with acceptable behavior deltas.
3. Ship a guided, non-technical configuration UI (wizard + summary card) in the frontend agent editor, replacing the current flat config renderer for this tool.
4. Migrate newlkiag onto the new library tool and delete its local implementation — the proof that the abstraction covers the client case.

### Decisions taken (with the user)

| Decision | Choice |
|---|---|
| Engine | Pipeline only — port the newlkiag 4-phase pipeline; drop v3's agentic step-loop, bash sandbox, and dynamic tools |
| Tool identity | Same id `agentic_context_search`, replaced in place; no `.v3` export alias |
| Parity bar | Core parity, generic edges |
| Config representation | New `json` config option type + bespoke guided UI for this tool |
| UI shape | First-run wizard + summary card with per-area edit entry points |
| Saved-config migration | Standalone one-off script a dev runs manually (NOT in `init-db.ts`) |
| Scope | exulu backend + exulu frontend + newlkiag migration |

## 2. Backend architecture

### 2.1 Location & identity

- New directory `ee/agentic-retrieval/pipeline/`; `ee/agentic-retrieval/v3/` is deleted in the same change.
- Factory `createAgenticRetrievalTool()` keeps: id `agentic_context_search`, name `Context Search`, `type: "context"` (via `ExuluTool.internal`), `needsApproval: false`, and the EE license gate `checkLicense()["agentic-retrieval"]`.
- Package export: `ExuluDefaultTools.agentic.retrieval.create.pipeline`. The old `create.v3` export is removed (no alias).
- Internal call sites keep working with the renamed factory: `src/utils/enabled-tools.ts`, `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts` (live instantiation with contexts/model at message time), `src/graphql/schemas/index.ts` (tools query), `src/graphql/utilities/sanitize-and-hydrate-fields.ts`.

### 2.2 Tool input schema (LLM-facing)

```ts
z.object({
  userQuery: z.string(),          // the original, unaltered user question
  relevantKeywords: z.array(z.string()),
  importantKeyword: z.string(),
  confirmedContextIds: z.array(z.string()).optional(), // for the require_preselected_contexts flow
})
```

newlkiag's `external_ids` input is dropped — document references are auto-detected (stage 2).

### 2.3 Pipeline stages

**Stage 0 — scope & gates.** Parse preselected session items (`"<contextId>/<itemId>"`, `null` item list = whole context). Apply the `managed_context` and `require_preselected_contexts` short-circuits with their current user-facing messages (the chat frontend depends on these). The "requested KBs outside preselection" guard yields an explanatory message instead of throwing.

**Stage 1 — understand (parallel LLM micro-calls).**

- *Routing:*
  - Explicit-KB detection (enum over enabled context ids/names).
  - Document/page-reference detection; filename hints are resolved against `documents`-kind contexts with a generic fuzzy name matcher (Fuse.js, language-neutral normalization instead of German stemming) → pinned item ids + requested page.
  - Classification against configured routing rules (plain-language descriptions → main + fallback context lists). No rules configured → one implicit rule: all enabled contexts are main, no fallback.
  - Precedence: explicit KB request > preselected items > classification.
- *Memory* (only when the agent has a memory context and `memory.enabled`):
  - Framework-injected memory chunks + deterministic keyword recall over the memory context (generalized keyword-variant derivation, language-neutral).
  - LLM relevance check (generous), then three independent sub-features:
    - **Override gate** (strict; requires `overrides === true` + high confidence + authoritative chunks),
    - **File prioritization** → pins against `documents`-kind contexts,
    - **Query augmentation** fed by the configured glossary.
  - Relevant memory chunks are emitted as a citable step with synthetic `rerank_score: 1`.

**Stage 2 — search (main + speculative fallback in parallel).** Per-context treatment driven by the configured `kind` preset:

- `documents`: multi-query (literal + HyDE + rewrites, capped) with RRF fusion (k=60), expand ±7, limit 100.
- `conversations`: fuzzy keyword prefilter over item name + content, then single hybrid search, expand ±5, limit 20.
- `records`: single hybrid search on keyword-joined query, expand ±2, limit 20.

Preset values are defaults; per-context `overrides` win, and cutoffs/expand fall back to the context's own `configuration` where set. Configured **identifier vocabularies** (fuzzy or exact-token strategies) pin matching items; user-mentioned files REPLACE pins, memory pins UNION with them (newlkiag semantics). HyDE uses a generic prompt built from context descriptions + vocabulary + detected query language, with the optional `styleHint` persona override. Fallback search is skipped when a literal doc+page lookup is satisfied.

**Stage 3 — rerank & select.** Group chunks per item with gap-splitting (10-chunk group max) → rerank via `resolveReranker` (LiteLLM) → pin boost + identifier-token boost (digit+letter tokens) → top-K → page-window filter. Fallback results are reranked (no boosts) and merged only when the best genuine main score < `fallbackThreshold`. **No reranker configured → hybrid-score ordering** (the library must not hard-require Cohere).

**Stage 4 — memory override step.** When the gate fired, emit the override directive step (generalized wording, no client examples) with the authoritative chunks attached.

### 2.4 Output contract & models

Same streamed cumulative `AgenticRetrievalOutput` (`{steps, reasoning, chunks, usage, totalTokens}`) both current implementations use — the chat UI keeps working unchanged. All micro-calls run on the agent's model by default, each wrapped in `withRetry(3)`; the `utility_model` config routes them to a cheaper model.

### 2.5 Deleted with v3

Step-loop (`agent-loop.ts`), strategies, classifier + context sampler (including its cross-user cache leak), bash sandbox + `save_search_results`, dynamic per-item tools, the session-tools registry **and its consumer hook** (`getSessionTools` in `convert-exulu-tools-to-ai-sdk-tools.ts`), and trajectory disk-logging (replaced by the simple `logging` debug toggle).

## 3. Config schema

The `config: []` declaration becomes **static** — no more per-context `${contextId}_|_key` generation.

### 3.1 Platform extension: `json` config type

- `src/exulu/tool.ts`: config type union becomes `"boolean" | "string" | "number" | "variable" | "json"`.
- `hydrateVariables` (`convert-exulu-tools-to-ai-sdk-tools.ts`): `json` values are `JSON.parse`d into objects; parse failure → declared default + warning log.
- Frontend generic renderer (`tool-config-fields.tsx`): `json` options on tools without bespoke UI render as a raw JSON textarea.

### 3.2 Options

Flat (existing semantics kept): `instructions` (string), `reranker` (string, LiteLLM reranker id), `managed_context` (boolean), `require_preselected_contexts` (boolean), `logging` (boolean).

New flat: `utility_model` (string, default `""` = agent's model).

New `json` options (all shapes validated by zod on read, shared between backend and the frontend wizard):

```jsonc
// knowledge_bases — per-context profiles; absent context = { enabled: true, kind: "documents" }
{ "<contextId>": {
    "enabled": true,
    "kind": "documents" | "conversations" | "records",
    "instructions": "",
    "overrides": { "limit": 100, "expand": 7, "multiQuery": true, "hyde": true }
} }
// overrides.expand is a single number applied symmetrically ({before: n, after: n})

// routing — empty/absent rules = search all enabled contexts, no fallback
{ "rules": [ { "id": "technical", "label": "Technical questions",
    "description": "Questions about products, error codes, installation…",
    "main": ["ctx_a"], "fallback": ["ctx_b"] } ] }

// vocabulary
{ "glossary": [ { "term": "FST", "meaning": "Feldbussteuerung…" } ],
  "identifiers": [ { "name": "Product names", "examples": ["FST", "ECO"],
      "strategy": "fuzzy" | "exact", "contexts": ["ctx_a"] } ],
  "rewrites": [ { "find": "…", "replace": "…" } ],
  "styleHint": "" }

// memory
{ "enabled": true, "override": false, "filePrioritization": false, "queryAugmentation": true }

// tuning (newlkiag's current values as defaults)
{ "topK": 5, "fallbackThreshold": 0.95, "pinBoost": 0.15,
  "identifierBoost": 0.15, "pageWindow": 1, "maxQueriesPerContext": 5 }
```

### 3.3 Saved-config migration (standalone script)

A one-off dev-run script (`scripts/migrate-agentic-retrieval-config.ts`, run via `npx tsx`), NOT wired into `init-db.ts`:

- Scans `agents.tools` JSON for id `agentic_context_search` with old-format keys.
- Maps verbatim: `instructions`, `reranker`, `managed_context`, `require_preselected_contexts`, `logging`.
- Folds per-context keys into the `knowledge_bases` json value: `${ctx}_|_enabled` → `enabled`, `${ctx}_|_instructions` → `instructions`, `${ctx}_|_max_results` → `overrides.limit`, `${ctx}_|_expand_chunks` → `overrides.expand`.
- Drops dead keys: `${ctx}_|_priority`, `${ctx}_|_max_steps`, `reasoning_model`, `search_model`.
- Idempotent (skips agents already in the new format); prints a per-agent summary; `--dry-run` flag.

## 4. Frontend: wizard + summary card

**Placement:** the tool keeps its dedicated card in the agent editor's Knowledge section (still excluded from the generic Tools list). The card becomes a **summary card**: enable switch, plain-language digest ("4 knowledge bases · 3 routing rules · Memory on · Reranker: Cohere"), and per-area edit buttons that deep-link into wizard steps.

**Wizard:** a wide right-side Sheet (~`sm:max-w-2xl`), hand-rolled `useState<Step>` steps (house pattern), progress indicator, Back/Continue, jump-to-step. Opens automatically on first enable. All copy in plain language via next-intl, with a one-line explanation and a concrete example under every control.

Steps:

1. **Knowledge bases** — multi-select of contexts (TagSelector-style chips over `refs.contexts`); per selected context a card with name + description, a "What's in it?" kind select (`Documents & manuals` / `Conversations & tickets` / `Structured records`, each explained in one sentence), and an optional "When should the assistant look here?" text field.
2. **Routing** (skippable) — rule list: label, plain-language description, primary sources, backup sources. Always-visible note: *no rules = every enabled source is searched*.
3. **Domain vocabulary** (skippable) — glossary rows (term → meaning); identifier sets (name, example chips, matching style as `Names & titles (approximate)` vs `Codes & standards (exact)`, applies-to sources); "Describe your documents" textarea (feeds HyDE); rewrite rules under an Advanced collapsible.
4. **Memory** — the four toggles with explanations; if the agent has no memory context, an explainer + pointer to the memory picker instead of dead toggles.
5. **Retrieval behavior** — reranker (`RerankerSelector`), utility model, top-K, fallback-confidence slider ("when the first search looks weak, also check backup sources"). Advanced collapsible: boosts, page window, `managed_context`, `require_preselected_contexts`, `logging`.
6. **Review** — human-readable recap, Finish.

**Data flow — no new API.** The wizard parses saved config values through the shared zod schemas (`config-schema.ts`) into typed form state; Finish serializes back into the `{name, variable, type}[]` config array via `editor.setTools` staged state. Persistence stays the page-level SaveBar → `UpdateAgentEditor` mutation. Closing mid-wizard keeps already-applied staged values and warns about unapplied step edits.

**Code layout:** `app/(application)/agents/edit/[id]/components/knowledge-search/` — `summary-card.tsx`, `wizard.tsx`, `steps/*.tsx`, `config-schema.ts`.

## 5. newlkiag migration

1. Bump `@exulu/backend`; enable `agentic_context_search` on the Newton agent (replacing `knowledge_search` in its tool list).
2. Translate the hardcoded behavior into config:
   - `knowledge_bases`: techDoc / vorschriften / softwareDocumentation / manualDocuments → `documents`; zendesk → `conversations`; newServicedb → `records`; agent memory stays `newton_memory_context`.
   - `routing`: the five categories (technical / service / software / regulatory / market) with their existing main/fallback lists.
   - `vocabulary`: the ~50-entry abbreviation glossary; product-name identifiers (fuzzy: FST, ECO, CBM-2 → techDoc); norm identifiers (exact: DIN 8100, EN 81-20 → vorschriften); rewrite rules derived from `normalizeQuerySimple`; German style hint for HyDE.
   - `memory`: all four features on. `tuning`: defaults (they match current values).
3. **Validate before deleting:** run a fixed set of representative queries through both the old local tool and the configured library tool (their `POST /knowledge-search` endpoint pattern) and compare retrieved items/chunks. Small deltas in generalized edges are acceptable; missing documents are not.
4. Delete `src/tools/knowledge_search/` and now-orphaned support modules (each checked for other usages first; `getZendeskTicket` and `src/harness` stay untouched); remove `knowledgeSearch` from the tools export; update or remove the `server.ts` test endpoint.

## 6. Error handling

One rule: **a degraded pipeline still retrieves.** Every LLM micro-call: `withRetry(3)`, then skip the feature it powers rather than failing the run — classification fails → all enabled contexts main; explicit-KB / doc-page detection fails → feature skipped; memory phase fails → no memory step; identifier extraction fails → no pins; HyDE fails → literal query only; rerank fails (or no reranker) → hybrid-score ordering. Config JSON failing its zod parse → declared defaults + warning log. Gates (`managed_context`, `require_preselected_contexts`, preselection-subset guard) yield user-facing messages, never throw.

## 7. Testing

- **Backend (Jest, colocated `*.test.ts`):** port newlkiag's five suites (routing, memory, rerank, prefilter, search dispatch) into `ee/agentic-retrieval/pipeline/`, generalized to config-driven fixtures with all exulu/LLM deps mocked. New suites: config parsing/defaults, degradation paths (each micro-call failing must not fail the run), and the migration script over sample old-format agent rows.
- **Frontend:** unit tests for `config-schema.ts` round-trips (parse → edit → serialize, bad-JSON fallback). Wizard verified by type-checks + a manual UAT pass.

## 8. Out of scope

- The newlkiag `src/harness` implementation (broad sweep, inner-agent loop, eval harness, feedback agent) — explicitly not being ported.
- Answer synthesis / citation formatting (stays the outer agent's job, as today).
- A generic wizard framework for other tools' config (the `json` textarea fallback is the extent of the generic change).
- v3's session dynamic tools (`get_more_content_from_*`) — removed without replacement; chunk `expand` covers adjacent-content needs.
