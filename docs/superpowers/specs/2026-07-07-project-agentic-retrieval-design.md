# Project Retrieval via the Agentic Pipeline — Design

**Date:** 2026-07-07
**Status:** Approved design, pending implementation plan
**Replaces:** `src/templates/tools/project-retrieval-tool.ts` (tool id `context_search_in_knowledge_items_added_to_project_<projectId>`)
**Builds on:** `docs/superpowers/specs/2026-07-03-agentic-retrieval-pipeline-design.md` (the pipeline this feature rides on)

## 1. Context & goals

When a chat session has a project attached (`agent_sessions.project`), the backend injects a per-project retrieval tool over `projects.project_items` (global ids `<contextId>/<itemId>`, plus a second bare-`<contextId>` shape meaning "entire context"). Today that tool is a basic per-context `hybridSearch` (limit 10, no rerank, no expansion) predating the agentic retrieval pipeline.

Goals:

1. Replace the legacy project tool with the agentic retrieval pipeline (`ee/agentic-retrieval/pipeline`), in both integration modes:
   - **Agent without `agentic_context_search`:** auto-inject a pipeline instance scoped to the project, configured with sensible presets — no admin setup required.
   - **Agent with `agentic_context_search`:** the project becomes an **additional source** inside the one configured pipeline — never a second tool, never a restriction of the agent's existing scope.
2. Respect the project data model: a project references items across any number of ExuluContexts; items and whole contexts mix freely in `project_items`.
3. Fix the adjacent defects the migration exposes (see §7).

### Decisions taken (with the user)

| Decision | Choice |
|---|---|
| Non-EE installs | **EE-only.** The legacy tool is deleted; without an `agentic-retrieval` license there is no project retrieval. Accepted regression. |
| Additional-source mechanism | New `projectScope` factory option with union/pin semantics (§3). Rejected: reusing `preselected` (restrictive — would clamp a configured agent to project scope) and a second scoped tool instance (two pipelines per message, model must pick one). |
| Citation gate | Fix in scope: compute `includesContextSearchTool` **after** convert (§7.1). |
| Project instructions | In scope: `projects.custom_instructions` feeds the pipeline's existing `instructions` option (§7.2). |
| Kind heuristic | In scope: the built-in `transcriptions` context defaults to `conversations` kind in synthesized profiles (§7.3). |
| disabledTools | In scope: convert learns about `disabledTools` so convert-injected tools can be disabled from the capability sheet (§7.4). |
| Data migration | None. No DB changes, no saved-config migration (the new config option defaults on). |

## 2. Current state (verified at backend `develop` e13410d)

- Legacy factory: `src/templates/tools/project-retrieval-tool.ts:9` — fetches project row (no access check; the run route's session gate at `routes.ts:710` is the real gate), bails on empty `project_items`, groups gids by context, one `hybridSearch` per context with `itemFilters: [{id: {in: itemIds}}]`, limit 10. `needsApproval` unset → defaults **true**.
- Three injection sites: `convert-exulu-tools-to-ai-sdk-tools.ts:206-217` (chat/sync execution), `openai-gateway.ts:443-461` (gateway; resolves project **by name** with access control, no session items), `sanitize-and-hydrate-fields.ts:244-255` (display hydration for `agentById(id, project:)`; capability sheet consumes only `{id, name}`).
- The pipeline already parses the exact `project_items` gid format — including bare-context entries — via `parsePreselectedItems` (`pipeline/index.ts:34-53`), and applies per-context item filters in `searchContexts` (`search.ts:76-82` → `multi-query.ts:33-34`).
- **Preselection is restrictive by design**: preselected contexts become the only `mainContexts` with `fallback=[]` and routing rules bypassed (`routing.ts:249-257`); the subset guard (`index.ts:374-378`) hard-stops outside them; `managed_context` / `require_preselected_contexts` gates (`index.ts:239-251`) are satisfied by any preselection. Correct for scoping, wrong for adding.
- Known legacy defects: bare-context entries degenerate to `id IN ('')` (silently empty); one embedder-less context rejects the whole `Promise.all`; the citation-prompt gate runs before convert injects the tool; capability-sheet disable toggles don't reach convert-injected tools; `custom_instructions` never reaches the model; sessions are never stored in `project_items` (the legacy tool description's "conversations" is dead copy — real transcripts enter as `transcriptions`-context items via `transcription/service.ts:400-425`).

## 3. Backend design

### 3.1 Factory API

`createAgenticRetrievalTool` (`ee/agentic-retrieval/pipeline/index.ts`) gains one option:

```ts
projectScope?: {
  id: string;                    // project uuid
  name: string;
  description?: string;
  customInstructions?: string;   // projects.custom_instructions
  items: string[];               // raw project_items gids (both shapes, unvalidated)
  kbProfileDefaults?: Record<string, KbProfile>;  // synthesized per-context defaults; stored config wins
}
```

`preselected` (session items) keeps its exact current semantics — session preselection and project scope are independent inputs and must not be merged.

### 3.2 Case 1 — auto-inject (agent lacks the tool)

In `convert-exulu-tools-to-ai-sdk-tools.ts`, when `project` is set, the license check passes, a model is available, and `currentTools.findIndex(id === "agentic_context_search") === -1`:

- Load the project row once (name, description, `project_items`, `custom_instructions`); skip entirely when `project_items` is empty (legacy parity).
- Push a pipeline instance with:
  - `contexts`: only the contexts referenced by `project_items` (resolved from the full registry convert already receives; unknown/orphaned context ids drop silently),
  - `preselected`: the project gids — **restriction is correct in this case** (legacy semantics: search only project knowledge). Bare-context entries become whole-context scope via `parsePreselectedItems`, fixing the legacy bug.
  - `instructions`: `custom_instructions` (§7.2), `memoryContext`/`memoryItems` as the normal branch passes them,
  - `projectScope.kbProfileDefaults` synthesized per §7.3.
  - Tool description mentions the project by name so the model knows when to call it.
- No stored config exists → `toolVariablesConfig` is `{}` → `parsePipelineConfig` yields pure zod defaults (documents kind, topK 5, no reranker required, no routing rules). Max steps resolves to `DEFAULT_MAX_STEPS` (10). This *is* the "sensible preset" — no synthesized config JSON beyond `kbProfileDefaults`.
- Case 1 passes **both** `preselected` (project gids — hard scope) and `projectScope` (identity, instructions, profile defaults, items). The §3.3 always-main append and `scopedItemsByContext` scoping are structural no-ops under preselection (routing already pins everything to the preselected contexts), but the rerank pin set remains meaningful: itemized project entries (e.g. `docs/item1`) are boosted by `pinBoost` over bare-context entries even when both are preselected — a specific item id is a stronger relevance signal than a whole-context scope. One code path, two cases.
- Session items, when also present, merge into `preselected` exactly as `parsePreselectedItems` already resolves collisions (full-context wins over item lists).

### 3.3 Case 2 — additional source (agent has the tool)

When the agent has `agentic_context_search`, convert passes `projectScope` into the existing instance (`convert:257-267`). Inside `execute`, after config parsing:

- `projectItemsByContext = parsePreselectedItems(projectScope.items)`.
- Per referenced context:
  - **Context already enabled** (present in `enabledContexts`): project item ids join the pin sets (`pinnedItemIds` union in `RerankState`, and per-context pin candidates in `searchContexts`) — a rerank **boost** via the existing `pinBoost` machinery, never a filter. The agent's scope does not narrow.
  - **Context not enabled** (explicitly `enabled: false` in `knowledge_bases`): the context is added as an **item-scoped source** — searched with a hard filter to the project's item ids for that context (bare-context entry → full context). Scoping travels in a new `scopedItemsByContext: Map<string, string[] | null>` parameter through `searchContexts`, parallel to (not through) `preselectedItems`; scoped-added contexts also join `contextsById` (`index.ts:313`). No extra context resolution is needed: convert already receives the full context registry (routes passes all registered contexts wholesale), so every valid project context is present in the instance's `contexts` array.
- **Routing:** project-referenced contexts are appended to `mainContexts` after classification (dedup) — attaching a project to a chat is an explicit relevance signal, so they are always-main regardless of rules. The subset guard and the `managed_context` / `require_preselected_contexts` gates remain keyed to **session** preselection only; `projectScope` must never satisfy them.
- **Profiles:** a project-added context without a stored `knowledge_bases` profile uses `kbProfileDefaults` (§7.3), else kind preset `documents`. The kind heuristic in `buildProjectKbProfileDefaults` applies to ANY context referenced by the project that lacks a stored profile, including contexts that are already enabled in the agent's `knowledge_bases` — for example, a `transcriptions` context already enabled as `documents`-kind gets overridden to `conversations`-kind. This is deliberate: unprofiled transcription contexts would otherwise be searched with document-optimized parameters (full expand, multi-query, HyDE) rather than the conversation-tuned preset (keyword prefilter, no HyDE). Accepted as an improvement.
- **Config switch:** new flat option `project_search` (boolean, default `true`, option 13) — when false, project search is disabled for this agent. The gate is enforced at execute time via `cfg.projectSearch` (`parsePipelineConfig`); convert always passes `projectScope` into the factory, but inside `execute`, `resolvedProject` is computed only when `cfg.projectSearch` is true. Residue when off: the tool-description suffix (project name) and the project row load in convert remain — both are benign (description is static; the row load is the source for `projectScope` itself).
- Chunk attribution: existing `tagContext` labeling is sufficient; no synthetic `project:` context id (the chat UI resolves citations by real context).

### 3.4 The other two injection sites

- **Gateway** (`openai-gateway.ts:443-461`): same two cases, `preselected` remains undefined (no session), project row already access-checked there. The existing project name/description system-prompt injection at `:515` stays.
- **Display hydration** (`sanitize-and-hydrate-fields.ts:244-255`): the legacy unshift is removed. When `args.project` is set, the agent lacks the tool, and the license check passes, unshift a hydrated pipeline entry (`{id: "agentic_context_search", name: "Context Search", …}` via the existing branch at `:148`) so the capability sheet shows the search capability. When the agent already has the tool, no extra entry (no duplicate ids). Unlicensed → nothing. The frontend contract is `{id, name}` only.

### 3.5 Deletions

- `src/templates/tools/project-retrieval-tool.ts` and its imports/call sites in `convert-exulu-tools-to-ai-sdk-tools.ts` and `sanitize-and-hydrate-fields.ts`.
- The near-identical `session-items-retrieval-tool.ts` is **out of scope** (already double-wired with `preselected`; retire in a follow-up the same way).
- `ExuluTool.execute`'s `project` param (`tool.ts:202`) stays — public package surface; no in-repo caller, external use (newlkiag) unverified.

## 4. Frontend design

- `config-schema.ts`: add `project_search` (boolean, default true) → serializer emits **13** entries; update the round-trip test (asserts 12) and the stale header comment.
- Wizard **Behavior** step: one switch — "Search attached project items" with a one-line explanation ("When a chat belongs to a project, the assistant automatically searches the items pinned to that project."), copy via `agents.editor.knowledge.*` in `messages/en.json`.
- No Sources-step change: projects attach per-chat, not per-agent; they are not a configurable KB row.
- No change to the chat capability sheet (it renders whatever `{id, name}` hydration provides).

## 5. Behavior deltas (deliberate)

| Delta | Consequence |
|---|---|
| EE-only | Non-EE installs lose project retrieval entirely (user-accepted). |
| Approval prompt disappears | Legacy tool defaulted `needsApproval: true`; the pipeline tool is `false`. Stale `pre-approved-tool-calls-<sessionId>` localStorage keys for the old per-project tool name become dead entries — harmless. |
| Bare-context entries start working | "Entire context" project entries silently returned nothing; now they search the whole context. Users may notice more results. |
| Cost/latency on Case-1 chats | ~7–9 LLM micro-calls per retrieval instead of one search per context. That is the point of the migration, but it is a real delta for agents that never had agentic retrieval. |
| `custom_instructions` becomes live | Previously stored-but-dead; now influences retrieval routing. Only active when `project_search` is on; gated at execute time via `resolvedProject`. |
| Kind heuristic applies broadly | `buildProjectKbProfileDefaults` overrides the kind for any context lacking a stored profile — including already-enabled contexts (e.g. a transcriptions context defaulting to `documents` kind gets `conversations` instead). Accepted: avoids document-tuned parameters on conversational content. |
| Per-project tool id disappears | Anything keying on `context_search_in_knowledge_items_added_to_project_<id>` (approvals, statistics labels) sees the standard `agentic_context_search` / `Context Search` instead. |

## 6. Error handling

Pipeline rule unchanged: **a degraded pipeline still retrieves.**

- Project row missing / `project_items` empty / all gids orphaned → no injection (Case 1) or empty `projectScope` ignored (Case 2); never an error.
- Orphaned item gids inside a valid context → empty search results (RBAC and `archived` filtering already handle this inside `vectorSearch`).
- Unknown context prefix → that gid drops with a warn log (legacy threw).
- Embedder-less project context → existing per-context catch (`search.ts:172-176`) yields `[]`.
- `project_search` config parse failure → default `true` (existing `boolVal` semantics).

## 7. Adjacent fixes (in scope)

1. **Citation gate:** `includesContextSearchTool` is computed from `currentTools` before convert injects tools (`provider.ts` sync 455-460 / stream 1014-1019 vs convert at 545/634/1148). Move the determination after the convert call (derive from the returned tool record), so Case-1 chats get citation-format instructions.
2. **Project instructions:** convert passes `custom_instructions` via `projectScope.customInstructions` → factory `instructions` (joined into routing `extraInstructions`, `index.ts:325-327`). Retrieval-level only; the `req.body.customInstructions` system-prompt transport stays untouched.
3. **Kind heuristic:** synthesized `kbProfileDefaults` map the built-in `transcriptions` context to `kind: "conversations"`; every other context defaults to `documents`. Stored `knowledge_bases` profiles always win.
4. **disabledTools:** thread the run request's `disabledTools` into convert; convert skips injecting any tool (project instance today, memory/session tools by the same check) whose id is disabled. Fixes the existing capability-sheet no-op for convert-injected tools.

## 8. Testing

- **Pipeline (Jest, colocated):** `projectScope` union semantics — enabled context → pins not filters; disabled/absent context → item-scoped source; bare-context entry → whole context; gates (`managed_context`, `require_preselected_contexts`, subset guard) unaffected by `projectScope`; routing always-main append; orphaned gids and unknown contexts degrade to empty, never throw; `kbProfileDefaults` precedence (stored profile > default > kind preset).
- **Convert:** Case-1 push conditions (project + license + model + `findIndex === -1`); Case-2 opt pass-through; `project_search: false` disables both; `disabledTools` respected; unlicensed → no project tool at all; empty `project_items` → no injection.
- **Provider:** citation gate evaluates post-convert (Case-1 chat gets citation instructions).
- **Frontend:** `config-schema` round-trip with 13 entries; `project_search` default-on parity.
- **Manual UAT:** project chat with agentic-off agent, agentic-on agent with overlapping and non-overlapping contexts, entire-context project entry, gateway path.

## 9. Out of scope

- Session-items tool unification/retirement (follow-up; same pattern).
- Relational `project_items` (stays a jsonb array; orphans tolerated).
- Server-side cap on `project_items` (frontend-only 15 stays; transcription auto-attach keeps ignoring it).
- `context_presets.preset_items` consistency.
- System-prompt injection of `custom_instructions` (only the retrieval-level wiring ships).
- Any non-EE fallback.
