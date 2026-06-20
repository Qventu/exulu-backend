# Knowledge Management V2 — Implementation Plan

**Source design:** `Desktop/Projects/exulu/design_handoff_knowledge_management/` (README.md + `screens/v2.jsx` + `screens/dashboard.jsx` + HTML prototypes)
**Written:** 2026-06-16
**Scope decisions (confirmed with product):**
1. **Enrich in place** — keep the global sidebar + in-page Items/Pipeline tabs from work item 2.11; add the new surfaces as content. NOT the spec's full per-context left rail.
2. **Dedicated item detail page** at `/data/[ctx]/items/[itemId]` — supersedes the wide Sheet built earlier in this session (`db9f2ba`).
3. **Pipeline-health stats first** — defer the retrieval/upsert analytics chart + donut to a later phase.

---

## 0. Reconciliation — what already exists vs. what's new

**Critical context:** the codebase already shipped a knowledge redesign (work item **2.11**, spec `design/pages/knowledge.md`). The designer's handoff references the *old* `app/(application)/data/[[...query]]` catch-all route and appears unaware of 2.11. So this is **extend/enrich**, not rebuild. The current structure is already close to the spec's "two honest modes" philosophy.

| Spec surface | Already exists (2.11)? | Gap to close |
|---|---|---|
| Two modes (Content/Pipeline) | ✅ In-page Tabs (`workspace-shell.tsx`) | Spec wants them in a rail; we keep tabs (decision 1) |
| Items list (table, selection, bulk, pagination, search) | ✅ `items-table.tsx` | Minor polish only |
| Filter sheet + live preview | ✅ `bulk-filter-dialog.tsx` + `items-filter-preview.tsx` | Live count missing in the plain "Filters" (list) mode — only bulk-op modes show it |
| Item detail | ✅ but as a **Sheet** (`item-panel.tsx`) | **Convert to dedicated page** (decision 2) |
| Pipeline stages (sources/processor/embedder) | ✅ `stage-*.tsx` + `stage-card.tsx` | Add a unified **Pipeline Health** overview above them |
| Queue | ✅ `QueuePanel` primitive (per-stage collapsible) | Add a **job-detail drawer**, failure-first |
| **Home + Favourites** | ❌ `/data` is just a context-library list | **NEW** |
| **Pipeline Health overview** | ❌ pipeline tab is 3 stage cards + activity | **NEW** |
| **Update Progress** (save→process→embed) | ❌ only a toast | **NEW** |
| **KB dashboard** (items/chunks/stuck stats) | ❌ (`usage-panel.tsx` was deleted) | **NEW** |
| Admin retrieval analytics | ❌ | Deferred (decision 3) |

**Reusable primitives already in `components/primitives/`:** `list-detail` (supports `detailMode="page"`), `queue-panel`, `entity-combobox`, `status-dot`, `copy-button`, `copy-field`, `stat-card`, `chart-card`, `attention-list`, `filter-panel`, `detail-section`, `empty-state`, `page-shell`, `page-header`, `toolbar`, `relative-time`, `overflow-menu`, `confirm-dialog`, `favorite-toggle` (exists, used by projects/prompts — not yet by knowledge). **`score-cell` does not exist** (it's eval-local).

---

## 1. Frontend phases

Phases are ordered by **dependency-readiness**, not the user's stated priority — because the #1 priority (Home + Favourites) has the hardest backend dependency (two MISSING endpoints), while the dedicated item page (priority #2) has zero backend dependency and supersedes a Sheet we should retire sooner rather than later. Each phase notes its backend needs and whether it can ship honest-degraded.

### Phase F1 — Item detail page (priority #2) · NO backend dependency

Convert the item Sheet to a dedicated route. **Reuses ~all of `item-panel.tsx`'s body** — the sections already exist; this is mostly a routing + layout reshape.

- **New route:** `app/(application)/data/[ctx]/items/[itemId]/page.tsx` (server shell — guard, fetch context + item server-side, hand to client wrapper). Mirror the `prompts/[id]` + `agents/edit/[id]` server-shell pattern (no `getTranslations` server-side — i18n in the client wrapper).
- **Layout per spec screen 6 ("Item detail"):**
  - **PageHeader:** item name + `ok`/state pill ("Embedded"); subline = `itm_…` (mono, click-to-copy via `CopyButton`) + `ext {externalId}`. Actions: overflow ⋯ + primary **Edit**.
  - **Pipeline status line** (the "did it work?" answer): a single row `✓ Ingested · ✓ Processed · ✓ Embedded · ✓ Retrievable` with state-colored checks, right-aligned mono `{n} chunks · {time}`. Derive each check from item fields: `last_processed_at`, `embeddings_updated_at`, `chunks_count > 0`. Hairline divider below.
  - **Fields** (label/value rows, ~130px label column) rendered **by field type** — reuse the existing `ItemFormFields` type renderers. Read-only values get click-to-copy (the description/tags copy coverage just shipped in `fbe13f1`).
  - **Progressive disclosure** as a row of chevron links at the bottom (collapsed by default): **Calculated fields**, **Access control (RBAC)**, **Embeddings (chunk table)** — reuse `item-calculated-section.tsx`, `item-access-section.tsx`, `item-embeddings-section.tsx` as-is.
- **Edit mode (spec screen 7):** reuse the existing `item-panel` edit lifecycle (`draft`/`editing`/zod). "Unsaved changes" pill in the header; Cancel + primary **Save changes**. Expand-to-fullscreen for markdown/code/json already exists (`expand-editor-dialog.tsx`).
- **Routing:** the `?item=` searchparam flow on the Items tab changes from "open Sheet" to "navigate to `/data/[ctx]/items/[itemId]`". Keep the legacy redirect `/data/:ctx/:item → ?item=:item` working, OR add a new redirect `?item=:item → items/:item`. Retire the Sheet wiring in `items-tab.tsx` (`detailPresentation="sheet"` + `ItemPanel` in `ListDetail`); switch `ListDetail` to `detailMode="page"` with `detailHref={(i) => /data/${ctx}/items/${i.id}}`, OR drop ListDetail entirely on the items tab and make rows plain links.
- **Supersedes:** commit `db9f2ba` (wide Sheet). Note in the commit that this is the intended end-state.

**Effort:** ~2-3 days. **Backend:** none.

### Phase F2 — Update Progress (priority #3) · 1 verification, else NO backend dependency

The most novel surface. After saving an item update (or triggering process/embed), show the pipeline working.

- **New route or in-page state:** `/data/[ctx]/items/[itemId]/progress` (or a state on the detail page after Save). Spec screen 8.
- **Two variants, chosen by context config:**
  - **Variant A (queued)** — when `context.processor?.queue` / `context.embedder` route through BullMQ. Steps: Saved (done) → Processor (running, job id + attempt + % meter) → Embedder (queued). Footer: "Polling queues every 5s · Open queue →".
  - **Variant B (synchronous)** — when no queues configured. Steps: Saved → Processing (inline) → Embedding (inline, % meter). Footer: "Live · ~Ns remaining".
- **Conditional steps:** render the Processor step only if `context.processor` exists; the Embedder step only if `context.embedder` exists. Both are already on `GET_CONTEXT_BY_ID` (backend confirmed: `Context.processor`, `Context.embedder`).
- **Step component:** vertical timeline — 34px circle nodes connected by a vertical rule. States: done (filled + check), running (ring + spinner, gated behind `prefers-reduced-motion` + % meter), queued (hollow + dimmed). This is a **new shared primitive** worth extracting: `components/primitives/step-timeline.tsx` (agents/workflows/onboarding could reuse it).
- **Data wiring:** poll `job_results` (durable, `job_resultsPagination` filterable by `label`/`state`, backend confirmed) and/or live `jobs(queue, statuses)` for the specific jobs spawned by the save. **VERIFY (KB-6):** that `UPDATE_ITEM` / `PROCESS_ITEM` / `GENERATE_CHUNKS` return the spawned job id(s) so we can track the right jobs. If they don't, we fall back to "most recent jobs for this item's context" (looser but workable). Until verified, build the UI against the job-results poll and honest-degrade the per-job linkage.

**Effort:** ~3-4 days (the step timeline + polling state machine). **Backend:** KB-6 verification (likely already returns job ids); no schema change if jobs are linkable.

### Phase F3 — Pipeline Health overview + KB dashboard (priority #4) · minor backend aggregates

Two related surfaces.

**(a) Per-context Pipeline Health** (spec screen 2) — a new landing for the Pipeline tab (or a new sub-view above the stage cards):
- **The flow:** 4 nodes (Sources → Processor → Embedder → Searchable) connected by `→` arrows, each with: kind eyebrow, a big tabular number, a unit caption, a `dot + status` row.
  - Sources: connected count + total items (`<ctx>_itemsStatistics` count). Status from recent source `job_results`.
  - Processor: processed count. Status `fail` if stuck items exist.
  - Embedder: total chunks (see KB-4) · status from live embed jobs.
  - Searchable: % retrievable = `(items with chunks_count > 0) / total items`.
- **Alert banner** (the one contained surface): "N items are stuck at the processor — ingested but never embedded" + Inspect / Retry all. **Stuck items query EXISTS** (`chunks_count: {lte: 0}` — backend special-cases null+0).
- **Stats row (3):** Failed jobs (from queue), Stale > 30 days (`embeddings_updated_at: {lte: <30d-ago>}` — EXISTS), Retrievals · 24h (deferred — needs tracking; show "—" honest-degraded for now or drop until the analytics phase).
- **Recent activity:** borderless table from `job_resultsPagination` sorted by `createdAt DESC`.

**(b) KB dashboard** — the `/data` landing for admins (or a section on the context library): per-context and aggregate stats — total items, total chunks, items with 0/null chunks, stale items, failed jobs. Built from `StatCard` primitives. The spec's admin analytics (retrievals-vs-upserts chart + by-source donut) is **deferred** (decision 3) — leave a placeholder/"coming soon" or simply omit until the analytics phase.

- **Schema-gating flip:** the current `KNOWLEDGE_CONTEXT_AGGREGATES_SUPPORTED = false` / `KNOWLEDGE_CONTEXT_HEALTH_SUPPORTED = false` flags (in `app/(application)/data/queries.ts`) flip to `true` once **KB-3** lands. Until then, honest-degrade: render the health dots/counts as "—" or compute per-context counts lazily on the context-detail page only (never fan out N+1 across the library list — the spec forbids it and so does the existing gating).

**Effort:** ~3-4 days. **Backend:** KB-3 (context aggregates) + KB-4 (chunk SUM) to be non-degraded. Ships degraded without them.

### Phase F4 — Queue drawer (priority #5) · 1 backend addition (retry)

The current `QueuePanel` (reused from evals) is solid for the table + pause/resume/drain. The spec adds a **right job-detail drawer**, failure-first.

- **Drawer** (spec screen 10): opens on row click. Header: job name (mono) + `job_…` + attempts pill. Sections: **Failure** (red mono stack trace in a contained surface), **Inputs** (JSON), **Attempts** (per-attempt list). Footer: primary **Retry job** + delete.
- Could extend the existing `QueuePanel` with an optional `renderDetail` slot, or wrap it in a `ListDetail` (panel/sheet) — the latter reuses our just-built ListDetail sheet plumbing.
- **State tabs** (Active/Waiting/Failed/Stuck/Completed with live mono counts) already exist in `QueuePanel`. Keep.
- **Retry** is the one gap: the spec's retry "creates a new job with the same inputs (option to delete original)." Backend has pause/resume/drain/delete but **no generic `retryJob`** (KB-5). The evals/stages currently re-trigger via domain mutations (`PROCESS_ITEM`, `GENERATE_CHUNKS`). Options: (a) add KB-5 `retryJob` for a generic path, or (b) keep the domain-specific re-trigger per queue (works today, no backend change). Recommend (b) for now, (a) as a follow-up.

**Effort:** ~2-3 days. **Backend:** KB-5 optional (domain re-trigger works without it).

### Phase F5 — Home landing + Favourites (priority #1) · 2 backend dependencies (HARD)

The user's #1 priority but the heaviest backend lift — both data sources are MISSING today.

- **Home landing** (spec screen 1 / dashboard.jsx `RecentItems`): "Welcome back, {name}", with:
  - **Favourites** section — favourited items pinned on top. **Needs KB-1** (`favourite_items` and/or `favourite_contexts` columns on `users`). Pattern mirrors the existing `favourite_projects` (JSON array on users, read via `userById`, written via `usersUpdateOne` — same shape we just fixed in `9334414`). The `favorite-toggle.tsx` primitive already exists.
  - **Latest across your sources** — recent items across ALL contexts, polled 10s. **Needs KB-2** (cross-context recent-items resolver — each context is a separate dynamic table, so there's no union query today).
- **HomeRow** component: `[star toggle] [name + "source · external-id"] [state dot + "{n} ch"] [relative time]`. Star is an optimistic toggle.
- **Honest-degradation path** if backend lags: ship the Home shell with the Favourites section showing an empty/"pin items to see them here" state, and the Latest section degraded to per-context recent (the existing `activity-list.tsx` pattern fans out a couple of contexts) or hidden. But the section is only genuinely useful once KB-1 + KB-2 land.

**Effort:** ~2-3 days frontend, **gated on KB-1 + KB-2**. Recommend starting the backend tickets early (Phase B, below) so this can land without a stall.

### Cross-cutting (all phases)
- **Live polling** (5s queue, 10s recent) via the existing Apollo `pollInterval` pattern; pulsing `StatusDot` for liveness.
- **Toasts** on every async action (already the norm).
- **ConfirmDialog** on all destructive/expensive ops (already the norm).
- **Click-to-copy** on every id/key — make it discoverable (whole mono value clickable), not hover-only. `CopyButton`/`CopyField` exist.
- **Filter live count in list mode:** wire the `items-filter-preview` match count into the plain "Filters" (filter-list) mode, not just bulk-op modes (small fix).
- **i18n:** all new copy under the `knowledge.*` namespace, en + de.

---

## 2. Backend work (KB-prefix — specific to this redesign)

These are separate from the BE-1..13 tickets in `2026-06-redesign-backend-plan.md`. None blocks the frontend from starting; F1/F2/F4 ship with zero or one small backend item. F3 ships degraded without KB-3/KB-4. F5 is genuinely gated on KB-1/KB-2.

| Ticket | What | Verdict today | Blocks | Effort |
|---|---|---|---|---|
| **KB-1** | `favourite_contexts` + `favourite_items` JSON columns on `users` (mirror `favourite_projects`, core-schema.ts:347-353). Auto-exposed via GraphQL; read `userById`, write `usersUpdateOne`. | MISSING | F5 Favourites | ~½ day |
| **KB-2** | Cross-context recent-items resolver — UNION-ALL across registered `<ctx>_items` tables (or a view), sorted by `updatedAt DESC`, scoped to contexts the user can read. Returns `{id, name, context, external_id, chunks_count, updatedAt, state}`. | MISSING | F5 "Latest across sources" | ~2-3 days (the hardest backend item) |
| **KB-3** | Context aggregates on the `Context` type: `item_count`, `chunk_total`, `stuck_count` (chunks_count≤0), `stale_count`, health enum. Compute in the `contexts`/`contextById` resolver (currently registry-only, schemas/index.ts:1443-1525). Avoids the forbidden N+1 from the library list. | PARTIAL (no aggregates on Context) | F3 dashboard + library health dots (un-degrade) | ~1-2 days |
| **KB-4** | Chunk SUM per context — `SUM(chunks_count)` over the item table. Either fold into KB-3's `chunk_total`, or add a SUM path to `<ctx>_itemsStatistics` (today Statistics only COUNTs, except the tracking-table SUM path resolvers/index.ts:312). | PARTIAL | F3 "total chunks" stat | ~½ day (with KB-3) |
| **KB-5** | Generic `retryJob(queue, jobId, deleteOriginal)` mutation — creates a new job with the same inputs. Today only delete/pause/resume/drain exist. Optional: stages re-trigger via domain mutations already. | MISSING | F4 generic retry (optional) | ~1 day |
| **KB-6** | **Verify** `UPDATE_ITEM` / `PROCESS_ITEM` / `GENERATE_CHUNKS` return spawned job id(s) so Update Progress can track the right jobs. If not, add them to the mutation return shape. | UNKNOWN — verify | F2 per-job linkage (else honest-degrade) | ~½ day verify |
| **KB-7** (deferred) | `context` column on `job_results` (per-context activity grouping) + date-grouping on `trackingStatistics` (retrieval-vs-upsert time-series). | PARTIAL | Deferred analytics phase | ~2 days when scheduled |

**Already exposed (no work needed):** per-item `chunks_count` (filter/sort), stuck items (`chunks_count: {lte:0}` — special null+0 handling), stale items (`embeddings_updated_at`/`last_processed_at` date filters), queue stats (`queue`/`jobs` + pause/resume/drain/delete), pipeline stage config (`contextById` sources/processor/embedder + `embedder_settings`), per-stage recent runs (`job_resultsPagination`).

---

## 3. Recommended sequencing

**Frontend-led, backend in parallel.** Kick off KB-1 + KB-2 (the only hard gates) at the same time as frontend F1, so F5 isn't stalled when its turn comes.

```
Week 1   FE: F1 item detail page (no backend dep)        | BE: KB-1 favourites cols (½d) + start KB-2 recent resolver
Week 2   FE: F2 update progress (verify KB-6)            | BE: KB-2 cont. + KB-3 context aggregates
Week 3   FE: F3 pipeline health + dashboard              | BE: KB-3/KB-4 land → flip the gating flags
Week 4   FE: F4 queue drawer                             | BE: KB-5 retryJob (optional) + KB-6 verify
Week 5   FE: F5 Home + Favourites (KB-1/KB-2 ready)      | BE: KB-7 deferred analytics groundwork (optional)
Later    Deferred: retrieval/upsert analytics (chart + donut) once KB-7 date-series lands
```

This puts the highest-value, zero-dependency work first (item page, supersedes the Sheet), keeps the backend busy on the two hard gates from day one, and lands the user's #1 priority (Home/Favourites) only once its data actually exists — rather than shipping a fake-data Home.

---

## 4. Per-phase page specs

The redesign convention is a `design/pages/*.md` spec per surface that build agents consume. When each phase is picked up, author the spec from this plan + the matching `screens/v2.jsx` artboard:
- F1 → extend `design/pages/knowledge.md` (item detail section) or new `knowledge-item-detail.md`
- F2 → new `design/pages/knowledge-update-progress.md`
- F3 → new `design/pages/knowledge-pipeline-health.md`
- F4 → extend the queue section
- F5 → new `design/pages/knowledge-home.md`

Each should restate the honest-degradation behavior for its backend dependency so the build ships even if the backend ticket lags.

---

Generated 2026-06-16 from the designer handoff + live frontend/backend investigation. Decisions 1-3 confirmed with product.
