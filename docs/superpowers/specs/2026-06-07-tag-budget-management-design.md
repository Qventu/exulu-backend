# Tag-Based Budget Management

**Date:** 2026-06-07
**Status:** Designed
**Scope:** Backend (`exulu/backend`) + Frontend (`exulu/frontend`)

## Problem

Every LLM request the platform makes is already tagged per entity — `buildTags` in
`src/exulu/tags.ts` emits `user_id_*`, `role_id_*`, `team_id_*`, `project_id_*`,
`agent_id_*` (and `*_name_*` variants), and these tags are attached to every LiteLLM
call via `createTaggedFetch` (request body `metadata.tags`) and the `x-litellm-tags`
header on the `/litellm/:project/v1/*` passthrough.

LiteLLM can enforce spend budgets per tag, but nothing in Exulu ever **creates** those
tag budgets. So admins have no way to cap how much a given user / role / team / project /
agent can spend, and there is no convenient way to apply a default "$X per user per month"
across the platform. End users also have no visibility into how much budget they have left.

## Goal

1. Let a super admin **create, view, update, and delete** budgets for any entity
   (user, role, team, project, agent) through a single unified UI.
2. Let a super admin define a **global per-user budget** (e.g. $20/month) that is
   automatically provisioned for every user.
3. Give admins a great status experience: **animated budget bars**, a **basic
   burn-rate prognosis** that highlights entities on track to exceed their budget, and
   **multi-select** to apply an individual budget to many entities at once.
4. Optionally **show the user their own budget in chat**, controlled by an admin setting,
   delivered through the existing user context (no extra client round-trip).

## Non-goals

- **No new Exulu table for per-entity budgets.** LiteLLM is the source of truth for
  per-entity budgets (live spend + limits). Only platform-level settings are stored in
  Exulu (`platform_configurations`).
- **No budgets on `*_name_*` tags.** Budgets attach to stable `*_id_*` tags only; name
  tags stay report-only (names change, ids do not).
- **No role-based access.** Budget management is super-admin only; no new role permission
  field.
- **No reconcile/backfill job.** The global per-user default is applied lazily. Changing
  the default later does not retro-update already-created budgets (noted as a future
  option).
- **No global defaults for non-user entity types.** "Global default" applies to users
  only; role/team/project/agent budgets are always set explicitly.

## Decisions

| Topic | Decision |
|---|---|
| Budget tag dimension | `*_id_*` tags only (stable across renames) |
| Source of truth (per-entity) | LiteLLM `/tag/*` admin API — no Exulu mirror table |
| Source of truth (platform settings) | `platform_configurations`, key `budget_settings` (json) |
| Authorization (management) | super_admin only — page + every mutation endpoint |
| Authorization (self-view) | caller's own user id only; backend resolves the tag |
| Global per-user provisioning | Lazy, on request, with an in-memory provisioning cache |
| Backend ↔ LiteLLM | New `src/exulu/litellm/admin-client.ts` wrapping `/tag/new`, `/tag/update`, `/tag/info`, `/tag/delete` using `LITELLM_HOST/PORT` + `LITELLM_MASTER_KEY` |
| Tag derivation | New `budgetTagFor(entityType, id)` in `tags.ts`, reusing `sanitizeTagValue` |
| Budget API style | REST (budgets aren't an Exulu DB model), matching `frontend/util/api.ts` |
| End-user budget delivery | Enriched into the user context (`serverSideAuthCheck`) as `user.budget`, with a short read cache |
| Frontend route | `/budgets` under `(application)`, nav gated `user.super_admin` |

## Architecture

### Source of truth

```
Per-entity budgets   → LiteLLM tag store (live)   via /tag/{new,update,info,delete}
Platform settings    → platform_configurations row, config_key = "budget_settings"
                       config_value (json) = {
                         global_user_budget: {
                           enabled: boolean,
                           max_budget: number,
                           budget_duration: string   // "1d" | "7d" | "30d"
                         },
                         show_user_budget_in_chat: boolean
                       }
```

### Backend — LiteLLM admin client

New module `src/exulu/litellm/admin-client.ts`. Thin typed wrappers over the LiteLLM tag
admin API, the single place that knows how to talk to it:

- `tagNew({ name, max_budget, budget_duration })`
- `tagUpdate({ name, max_budget, budget_duration })`
- `tagInfo(names: string[]) → Record<name, TagInfo | null>`
- `tagDelete(name)`

Uses existing `LITELLM_HOST` / `LITELLM_PORT` and `LITELLM_MASTER_KEY` (Bearer). All
errors surface as typed failures so callers can log-and-continue where appropriate.

`TagInfo` shape (subset of LiteLLM `/tag/info`): `{ name, spend, max_budget,
budget_duration, budget_reset_at }`.

### Backend — canonical tag derivation

Add to `src/exulu/tags.ts`:

```ts
budgetTagFor(entityType: "user"|"role"|"team"|"project"|"agent", id: string|number): string
// → `${entityType}_id_${sanitizeTagValue(id)}`   e.g. "user_id_123", "project_id_<uuid>"
```

Reuses the existing `sanitizeTagValue`, so tag naming is single-sourced. The frontend
sends `{ entityType, entityId }`; the backend derives the tag. The frontend never
replicates sanitization.

### Backend — REST endpoints

All under super-admin authorization (same gate as `/configuration`):

| Method & path | Purpose |
|---|---|
| `GET /admin/budgets/:entityType` | Batch: derive the id-tag for every entity of that type, `tagInfo(names[])`, return `{ entityId → TagInfo \| null }` map. Powers the overview table. |
| `GET /admin/budgets/:entityType/:entityId` | Single entity budget (`tagInfo`). |
| `PUT /admin/budgets/:entityType/:entityId` | Upsert one: `tagInfo` to decide, then `tagNew` or `tagUpdate`. Body `{ max_budget, budget_duration }`. |
| `PUT /admin/budgets/:entityType/bulk` | Apply the **same value as an individual budget** to each `entityIds[]` (loops upsert server-side). Body `{ entityIds, max_budget, budget_duration }`. Returns per-entity success/failure. Powers multi-select. |
| `DELETE /admin/budgets/:entityType/:entityId` | `tagDelete`. |
| `GET /admin/budgets/settings` | Read `budget_settings` (global default + show-in-chat). |
| `PUT /admin/budgets/settings` | Write `budget_settings`. |

Self-view endpoint (authenticated user, **not** super-admin; scoped to caller's own id):

| Method & path | Purpose |
|---|---|
| `GET /me/budget` | Returns the caller's `user_id_<id>` budget view **only if** `show_user_budget_in_chat` is enabled and a budget exists; else `null`. Backed by the short read cache. Used server-to-server by `serverSideAuthCheck` to enrich the user context (not fetched from the client). |

### Backend — lazy global-default provisioning

New `ensureUserBudget(userId)`:

1. **Provisioning cache** (module-level `Map<tag, expiry>`, ~1h TTL) — return early if
   recently ensured.
2. Read `budget_settings.global_user_budget`; if `enabled` is false, cache-skip.
3. `tagInfo(["user_id_<id>"])` — if a `max_budget` already exists (explicit admin budget
   **or** a prior auto-provision), cache and skip. **Never overwrites an existing budget.**
4. Otherwise `tagNew` with the global default; cache.

Called in the two existing tag-building paths, awaited before the LLM call:

- `src/exulu/resolve-model.ts` (AI-SDK provider path)
- the `/litellm/:project/v1/*` passthrough in `src/exulu/routes.ts`

Failures are caught and logged — provisioning must never block a completion.

### Backend — end-user read view

`getUserBudgetView(userId)`:

- Returns `{ spend, max_budget, budget_duration, budget_reset_at } | null`.
- Returns `null` unless `show_user_budget_in_chat` is enabled and the user has a budget.
- Backed by a **short read cache** (module-level, ~30s TTL, keyed by user tag) so repeated
  page loads (each re-runs `serverSideAuthCheck`) don't hammer LiteLLM.

> Two distinct caches: the **provisioning** cache in `ensureUserBudget` (~1h, "have we
> created this budget?") and the **read** cache in `getUserBudgetView` (~30s, "what is the
> current spend?").

### Backend — user type

Add `budget?: UserBudgetView` to `types/models/user.ts` (optional; populated only for the
self-view path). No Postgres column — it is live LiteLLM data attached at context time.

### Frontend — `/budgets` admin page

Modeled on the `teams` / `roles` pages (Next.js, shadcn, Apollo for entity lists,
`util/api.ts` for the new REST calls). Nav entry added in `main-nav.tsx`, gated
`user.super_admin`.

**Global default card (top):**
- Enable toggle + monthly amount + duration select → `PUT /admin/budgets/settings`.
- `show_user_budget_in_chat` toggle (independent of whether the default is enabled).

**Overview table per entity type** (via batch `GET /admin/budgets/:entityType`):
- Entity-type tabs/selector (user / role / team / project / agent); entity lists come from
  the existing GraphQL list queries.
- Each row renders an **animated `BudgetBar`** (CSS `width` transition on load and on
  change; color-coded green → amber → red by % used) with a **projection marker** overlay.
- Rows whose prognosis is `overPace` get a highlight (amber/red badge; marker pushed past
  the 100% line). Tooltip shows current spend / limit / reset date and
  `projected ≈ $X by reset`.
- Checkboxes for **multi-select** → "Set budget for N selected" opens `BudgetEditor` in
  bulk mode → `PUT …/bulk`; result toast reports how many succeeded.

**Single edit:** row click → `BudgetEditor` (single mode: set / update / delete) showing
the live bar + prognosis for that entity.

**Budget fields:** `max_budget` (USD), `budget_duration` (select: `1d` / `7d` / `30d`,
default `30d`).

### Frontend — basic prognosis

Computed client-side from `spend`, `max_budget`, `budget_duration`, `budget_reset_at`
(shared `useBudgetProjection` helper):

```
windowDays  = parseDuration(budget_duration)        // "30d" → 30
windowStart = budget_reset_at - windowDays
daysElapsed = max(now - windowStart, fractionOfADay) // avoid divide-by-zero
projected   = spend / daysElapsed * windowDays
overPace    = projected > max_budget
```

### Frontend — reusable components

- `BudgetBar` — animated, color-coded fill + projection marker + tooltip. Used in the
  admin overview, the `BudgetEditor`, and chat.
- `BudgetEditor` — single & bulk modes.
- `useBudgetProjection` — prognosis math.

### Frontend — end-user budget in chat

`serverSideAuthCheck()` (`frontend/lib/server-side-auth-check.ts`) calls `GET /me/budget`
server-to-server and attaches the result as `user.budget` on the object it returns. This
flows through the existing `UserContext` provider, so `chat.tsx` reads `user.budget` from
`useContext(UserContext)` — **no extra client round-trip**. Add `budget?` to the frontend
`UserWithRole` type (`frontend/types/models/user.ts`).

When `user.budget` is present, chat renders the compact `BudgetBar` (used / left, color
coding, prognosis tooltip). Hidden entirely when absent (setting off or no budget). It
refreshes on navigation; the 30s read cache keeps it cheap.

## Data flow summaries

**Admin sets a budget on a project**
```
/budgets page → PUT /admin/budgets/project/<uuid> {max_budget, budget_duration}
  → backend derives project_id_<uuid> → tagInfo → tagNew|tagUpdate → LiteLLM
```

**User makes a completion (global default $20 enabled, first time)**
```
resolve-model / passthrough builds tags
  → ensureUserBudget(userId): cache miss → tagInfo(user_id_X)=none → tagNew($20/30d)
  → request proceeds; LiteLLM now enforces the $20 cap on user_id_X
```

**User opens chat (show-in-chat enabled)**
```
serverSideAuthCheck → GET /me/budget (read cache ~30s) → user.budget
  → UserContext → chat.tsx renders BudgetBar(used/left, prognosis)
```

## Testing

- **Unit:** `budgetTagFor` derivation; upsert new-vs-update decision; `ensureUserBudget`
  cache behavior + "never overwrite an existing budget"; `useBudgetProjection` math
  (under-pace, over-pace, near-zero elapsed time).
- **Manual:** set a $X budget on a user, exceed it, confirm LiteLLM returns the
  `budget_exceeded` 400; enable the global default and confirm a fresh user is
  auto-provisioned; bulk-apply a budget to multiple selected projects; toggle
  show-in-chat and confirm the bar appears/disappears in chat.

## Future options (out of scope)

- Reconcile job to retro-apply a changed global default to existing users.
- Global defaults for other entity types.
- Role-based (non-super-admin) budget management.
