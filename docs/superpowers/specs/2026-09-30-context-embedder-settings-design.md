# Admin-configurable embedder per context — Design

**Date:** 2026-09-30
**Status:** Drafted (pending user review)
**Branch:** `feat/context-embedder-settings` (worktree `../backend-context-embedder`, off `develop` cdbdeca).
A frontend worktree on the same branch name is created when implementation starts.
**Related:**
- `src/exulu/entities/config.ts` — the code-default / DB-override / effective-value pattern this mirrors
- `src/exulu/context.ts` — `ExuluContextEmbedder`, `createChunksTable`, `embeddings.generate`
- `src/exulu/litellm/parse-embedding-models.ts` — the catalogue of selectable models
- `src/graphql/available-queues.ts` — the registered-queue list this reuses
- `docs/superpowers/specs/2026-09-29-transcripts-redesign-design.md` — the feature that exposed the gap

## Summary

A context's embedding model is declared in code today and cannot be changed without a deploy. One built-in
context — `transcriptions` — declares none at all, which is how this surfaced: **"Ask about this
transcript", shipped in the Transcripts redesign, does not work.** `vectorSearch` throws
`"Embedder is not set for this context."` (`vector-search.ts:155`), and the two retrieval paths fail
differently — the agentic pipeline catches per context and contributes `[]` (`search.ts:186`), so the
agent silently answers with no knowledge, while the session-items tool has no catch and surfaces a tool
error. No chunks table exists for the context either, because creation is gated on `context.embedder`
at boot (`init-exulu-db.ts:342`).

This spec makes the embedder **an admin setting on every context**: the in-code `embedder` becomes a
default, an admin selection overrides it, and changing it orchestrates the destructive rebuild the
storage layer requires. Transcripts is then fixed the same way any other context is — by configuring it.

**Reuse first.** The override mechanism is the entity-model pattern, already proven. The model list comes
from `parseEmbeddingModels()`. The queue list comes from `exuluApp.get().queues()` via
`resolveAvailableQueues`. Regeneration reuses the existing `GENERATE_CHUNKS` / bulk `generate-embeddings`
path. The UI extends `StageEmbedder`, which already renders the embedder and its jobs. **No new tables.**

## Decisions (from brainstorming, 2026-09-30)

| Topic | Decision |
|---|---|
| Scope | A **platform** feature on every `ExuluContext`, not a transcripts feature. Transcripts is one consumer. |
| Storage | `platform_configurations`, key `context_embedder:<contextId>`, mirroring `entity_extraction_model:<contextId>`. |
| Runtime application | **Hydrate `context.embedder`**, do not resolve per read. See §2 — 30 read sites across 8 files, several synchronous by construction. |
| Changing the embedder | **Orchestrated.** One confirmed action deletes chunks, rebuilds the table when dimensions differ, persists, and queues regeneration. Rejected: warn-then-let-them-run (leaves a context with a new embedder and incompatible vectors indefinitely) and block-until-drained (safe but clunky). |
| The rebuild window | **Accept it; do not change retrieval.** Progress shows in the pipeline tab. A user asking an agent mid-rebuild gets an answer that silently omits that context. Accepted knowingly: the window is short, rare, and admin-initiated. |
| A context with no effective embedder | **Blocking setup state.** Renders as "Not configured" with the picker as its primary action, and retrieval fails with an actionable message instead of a raw throw or a silent `[]`. |
| Why those two differ | A *permanent misconfiguration* nobody knows about must be loud. A *transient rebuild* the admin just triggered need not be. |
| UI ownership | `/data/[ctx]`'s pipeline tab owns the control; any other surface (Transcript settings, later) renders the **same** promoted component, never a copy. |
| Queue | The override may carry an optional queue name validated against the registered queues. Absent → inline. See §6. |

## 1. Storage and resolution

`src/exulu/embedder-settings.ts`, shaped after `src/exulu/entities/config.ts`:

```ts
export type EmbedderSource = "database" | "code";

export interface ContextEmbedderInfo {
  /** The model embedding will actually use, or null when the context has none. */
  effectiveModel: string | null;
  /** Where the effective model came from; null when there is none. */
  source: EmbedderSource | null;
  /** The UI-configured override in platform_configurations. */
  databaseModel: string | null;
  /** `context.embedder.model` declared in code, if any. */
  codeModel: string | null;
  /** Optional queue name stored with the override; null = inline. */
  databaseQueue: string | null;
  /** Dimensionality of the effective model, or null when unresolvable. */
  dimensionality: number | null;
}

const embedderKey = (contextId: string) => `context_embedder:${contextId}`;

export const getEmbedderSetting = async (contextId: string): Promise<{ model: string; queue: string | null } | null>;
export const setEmbedderSetting = async (contextId: string, model: string, queue: string | null): Promise<void>;
export const clearEmbedderSetting = async (contextId: string): Promise<void>;
export const resolveContextEmbedder = async (context: ExuluContext): Promise<ContextEmbedderInfo>;
```

`config_value` stores `{ "model": "...", "queue": null }` as JSON. The reader tolerates pg returning the
column already parsed or as raw text, exactly as `getEntityModelSetting` and `budget-service` do — that
tolerance exists because it was needed, so copy it rather than rediscover it.

Reads never throw: a failure logs and returns null, so a database hiccup degrades a context to its code
default rather than taking the app down.

## 2. How the setting reaches running code

**The constraint.** `context.embedder` has 30 read sites across 8 files. Several cannot become async: the
knex `createTable` callback (`context.ts:1312`) is synchronous by construction, GraphQL schema generation
reads it while building the schema at boot (`schemas/index.ts`), and the bullmq validators
(`validators/bullmq.ts`) run outside any async context. Converting all 30 — and adding a database read to
`vectorSearch`, which runs on every query — is a restructuring of core infrastructure with no upside.

**The approach.** `context.embedder` remains the single synchronous source of truth. A new module hydrates
it:

```ts
/** Assigns each context's effective embedder onto the instance. */
export const hydrateContextEmbedders = async (contexts: ExuluContext[]): Promise<void>;
```

Called in three places:

1. **At boot**, in `initExuluDb` after the core-schema loop that creates/migrates the core tables
   (`init-exulu-db.ts:160`) and **before** `contextDatabases(contexts)` (`:356`). That window is exact
   and not arbitrary: `platform_configurations` must already exist to be read, and `contextDatabases`
   must already see the hydrated value or a context whose embedder exists only as an override never
   gets its chunks table created. On a first-ever boot the table is empty and every context simply
   keeps its code default.
2. **On a 30-second TTL**, refreshed from the async entry points that already await
   (`ExuluContext.search`, `embeddings.generate.one`). The interval matches the LiteLLM catalogue cache.
3. **Immediately in-process** when the change mutation runs, so the acting replica is correct at once.

**Why the TTL is load-bearing, not a nicety.** Without it, a second replica keeps the old model after an
admin changes it. That is not a stale-read inconvenience: it would embed queries at the old
dimensionality against a column the first replica just rebuilt at a new one — a hard pgvector error on
every search until restart. Thirty seconds bounds that window.

Hydration only ever *sets* `embedder` from an override or leaves the code default in place. It never
clears a code-declared embedder except when an explicit "clear" override says so (§3).

## 3. Changing the embedder

One mutation, `contextSetEmbedder(context: ID!, model: String, queue: String)`, admin-gated. Passing
`model: null` clears the override.

**Validation, before anything is touched.** `getEmbeddingModelInfo(model)` must return a numeric
`dimensionality`; it throws an actionable message naming the model and the required
`config.litellm.yaml` shape, which we surface verbatim. A queue name, when given, must appear in
`exuluApp.get().queues()`. Nothing is deleted until both pass.

**Then one of three paths.** The deciding input is the **actual** dimensionality of the existing
`embedding` column, read from the database (`information_schema` / `pg_attribute` typmod for the chunks
table), not inferred from the previously-configured model — that model may since have been removed from
`config.litellm.yaml`, in which case `getEmbeddingModelInfo` would throw and we would be unable to
classify a change we are perfectly able to perform. When the column's dimensionality cannot be
determined, treat it as **different** and take the full-rebuild path: rebuilding when we did not need to
costs time, while skipping a needed rebuild leaves a column that rejects every insert.

| Case | Steps |
|---|---|
| No embedder → set one | create the chunks table (`createChunksTable`), persist the override, hydrate, queue regeneration for every item |
| Change, **same** dimensions | delete all rows from the chunks table, persist, hydrate, queue regeneration |
| Change, **different** dimensions | drop the chunks table (taking its HNSW index with it), recreate it at the new `vector(n)`, persist, hydrate, queue regeneration |

Regeneration is **always** required, even at identical dimensions: vectors from a different model occupy a
different space and are not comparable. Only the *table surgery* is dimension-dependent.

**Ordering and failure.** DDL and deletion are fast and run synchronously inside the mutation; regeneration
is queued and reported through the existing jobs UI. Persist the override **after** the DDL succeeds — if
the rebuild fails the setting is unchanged, so the context keeps working on its old embedder rather than
being left pointing at a model whose column does not exist. The reverse order is the one dangerous
ordering here.

**Clearing.** Reverting to the code default is the same operation with the code model as the target. Where
there is no code default — `transcriptions` — clearing leaves the context unsearchable and drops its
chunks table, so it takes the same destructive confirmation and the same warning text.

## 4. The unconfigured state

Today a context with no embedder fails three different ways: a raw throw from `vectorSearch`, a silent `[]`
from the agentic pipeline, and an unhandled tool error from the session-items tool. All three become one
behaviour:

- `vectorSearch` throws a typed `ContextEmbedderNotConfiguredError` naming the context and the remedy.
- `searchContexts` keeps catching it — it must, or one misconfigured context breaks every multi-context
  search — but **logs it distinctly** rather than folding it in with transport failures, and reports the
  context as unconfigured in the tool's result so an answer can say knowledge was unavailable rather than
  implying none exists.
- The session-items retrieval tool gains the `try/catch` it currently lacks
  (`session-items-retrieval-tool.ts`), returning the same actionable message instead of a raw throw.

The UI renders such a context as **Not configured**, with the picker as its primary action.

Note this is deliberately *not* how a rebuild behaves: mid-rebuild the context is configured and simply
empty, and retrieval stays silent (per the brainstorming decision). The difference is that a
misconfiguration persists until someone acts, while a rebuild resolves itself.

## 5. GraphQL and UI

**Backend.** Per-context, generated alongside the existing entity-model pair
(`schemas/index.ts:425`, `${tableNameSingular}SetEntityModel`), so the naming matches what is already
there:
- `${tableNameSingular}EmbedderInfo: ContextEmbedderInfo` — the resolved view plus `dimensionality` and
  the current chunk count, so the dialog can state how much will be deleted.
- `${tableNameSingular}SetEmbedder(model: String, queue: String): ContextEmbedderInfo`
- `availableEmbeddingModels: [EmbeddingModelOption!]!` — `{ model, dimensionality, maxChunkSize, maxBatchSize }`
  straight from `parseEmbeddingModels()`.

**Frontend.** `StageEmbedder` gains a Change action and the Not-configured state, and moves to
`components/widgets/` so a second surface renders the same component rather than a copy. The Transcripts
redesign's own run produced the evidence for that rule: two independently-built access surfaces were
already drifting, and a promoted component was the fix twice.

The change dialog states, before confirmation: the model and its dimensionality; whether the table is
rebuilt or only emptied; **how many chunks will be deleted and how many items must be re-embedded**; and
that search over this context returns nothing until regeneration finishes.

## 6. The queue question

`ExuluContextEmbedder.queue` is a `Promise<ExuluQueueConfig>` — a live object, not storable. With no
queue, `embeddings.generate.one` embeds **inline** (`context.ts:1041-1042`: `if (queue?.queue.name)`,
else inline). For `transcriptions`, which has no code embedder at all, a UI-set model would therefore
embed inline **inside `finalize`** — making a three-hour meeting's save visibly slow.

**Resolution.** The override stores an optional queue *name*. At hydration the name is resolved against
`exuluApp.get().queues()` into the live `ExuluQueueConfig` and attached as `embedder.queue`. Precedence:

1. the queue named in the override, when it resolves;
2. otherwise the code embedder's queue, if the context declares one;
3. otherwise none — inline.

The picker offers the registered queues via the existing `resolveAvailableQueues` helper (the same list
the routine editor uses, so an offered value cannot fail lookup at run time), and warns that leaving it
unset means embedding runs inline and will slow saves on large items.

A stored queue name that no longer resolves degrades to inline with a warning log rather than failing the
save — a renamed queue must not make a context unwritable.

## 7. Error handling

- **Model not in the catalogue** → the mutation fails before any destructive step, surfacing
  `getEmbeddingModelInfo`'s message (which already names the exact YAML to add).
- **DDL fails mid-rebuild** → the override is not persisted (§3 ordering), so the context stays on its
  previous embedder. The chunks table may be missing if the drop succeeded and the create failed; the
  Not-configured state (§4) then describes it accurately and the admin can retry.
- **Regeneration job fails** → surfaces in the existing jobs panel; chunks are partially populated and
  search returns partial results. Retry is the existing per-job retry.
- **Two admins change the same context concurrently** → last write wins on the setting; the destructive
  steps are idempotent (delete-all, drop-if-exists, create). Not worth locking for an action this rare.
- **Setting read fails** → logged, treated as "no override", context falls back to its code default.

## 8. Testing

Backend (jest), on the pure and near-pure pieces:
- `embedder-settings`: the four-field resolution across every combination of code default and override;
  the pg-returns-parsed-or-text tolerance; read failure degrading to the code default.
- Queue precedence (§6): override name → code queue → inline, including an unresolvable stored name.
- The change orchestration's **case selection** — no embedder / same dims / different dims — driven by
  dimensionality, with the destructive steps injected so the decision is testable without a database.
- Ordering: a failing DDL must leave the persisted setting untouched.
- `ContextEmbedderNotConfiguredError` surfacing from `vectorSearch` and being caught, distinctly logged,
  by `searchContexts`.

Frontend (vitest, node-only — no component tests in this repo): the dialog's summary derivation (which
case, counts, warnings) as a pure function. The UI itself is verified by hand.

**Manual verification required** (no CI can cover it): configure `transcriptions` on a live deployment,
confirm the chunks table appears and regeneration runs, then confirm "Ask about this transcript" returns
grounded answers in **both** retrieval paths — an agent with Transcriptions in its knowledge config, and
an agent without it, where the transcript is attached as a session item.

## 9. Out of scope

Per-context chunking configuration; embedding-model *routing* (one model per context stays the rule);
re-embedding on a schedule; a shadow-table zero-downtime rebuild (considered and rejected in brainstorming
— it roughly doubles storage and adds swap/rollback machinery to a rare admin action); changing
`ExuluContextEmbedder`'s shape for consumers of `@exulu/backend` (the code default keeps working exactly
as it does today); and the Transcript settings page itself, which is stage 3 of the Transcripts redesign
and will render this component when it is built.

**Known consequence, accepted:** during a rebuild, an agent asked about that context answers without it
and says nothing about the omission.
