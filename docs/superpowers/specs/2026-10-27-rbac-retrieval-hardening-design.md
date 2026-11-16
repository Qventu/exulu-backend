# RBAC retrieval hardening — Design

**Date:** 2026-10-27
**Status:** approved design, not yet planned
**Repos:** `exulu/backend` (all of it), `exulu/frontend` (one dialog option)
**Companion specs:** `2026-10-27-agent-guardrails-design.md` (same repo),
`newlkiag/docs/superpowers/specs/2026-10-27-external-newton-rollout-design.md`

## 1. Intent

Item-level RBAC is the data firewall for agents that external users can reach. Retrieval
already enforces it: `vectorSearch` runs `applyAccessControl(table, query, user, "items")`
on the chunk join, so a user only gets passages from items they may read. Newlift wants to
rely on exactly that, by switching its ticket knowledge bases from `rights_mode: "public"` to
`"roles"` and granting the `external` role per released ticket.

Three things stand in the way, all in the platform, none of them Newlift-specific:

1. **Imports cannot grant.** `createItem` sanitises `rights_mode` but never writes `rbac`
   rows, and the paths that call it bare (source imports, the knowledge-base write tools)
   get nothing. The paths that do grant (bulk import, memory tool, transcription service,
   the generic `CreateOne` mutation) each do it on their own after or instead of
   `createItem`. A context whose default mode is `roles` therefore produces, through an
   import, items nobody but a super admin can see.
2. **The `rbac` table has no lookup index.** In Newlift's production database it has only
   the primary key. Roles mode replaces the `rights_mode = 'public'` short-circuit with an
   `EXISTS` subquery per candidate chunk row; on a context with 50,000 items that needs an
   index.
3. **The retrieval pipeline keeps item-name caches that ignore RBAC.** The identifier and
   keyword prefilters and the memory-pin pass load names with `context.getItems({ fields,
   filters: [] })` without a user, process-wide, and a step note lists matched names to the
   model. Content never leaks, but a confidential item's name can.

This design fixes the three, adds a merge mode to the bulk access mutation so releasing
items does not require re-entering every grant, and sets a benchmark gate for the switch.

## 2. Goals, non-goals, anti-goals

**Goals**

- A context can declare default grants that every new item receives.
- Roles-mode lookups on large contexts perform within a stated budget.
- Nothing in the retrieval pipeline exposes a name, id or count of an item the caller may
  not read.
- Releasing a set of items to one more role is a single bulk action that keeps existing grants.

**Non-goals**

- Field-level RBAC and enforcement of the `hidden` field flag (known gap, separate work).
- Per-knowledge-base filters or field projections in the agent retrieval config. Considered
  on 2026-10-27 and dropped in favour of RBAC, because RBAC holds on every read path.
- Changing the super-admin bypass or the `agent_sessions` special case in `applyAccessControl`.
- Distributed caches. The pipeline caches stay in-process.

**Anti-goals**

- A fix that makes the item-name caches per user and silently kills their hit rate. The
  caches exist because the lists are big.
- "Fixing" the side channel by removing the step note. The note is useful; it must only
  name visible items.

## 3. Decisions taken (with Daniel, 2026-10-27)

| # | Decision |
|---|---|
| 1 | Item RBAC is the firewall. No duplicate "public" knowledge bases, no enum classification field, no retrieval-config filters. |
| 2 | Internal content stays in the index. Nothing is removed from items for the sake of external users; what they may not see is governed by grants and by the guardrail passage rules (companion spec). |
| 3 | Default grants are declared on the context, by role or team name, so code-defined contexts work across deployments where ids differ. |
| 4 | The `rbac` index is added through the init-db raw-SQL path, idempotent, like the `job_results` indexes. |
| 5 | A benchmark on Newlift's two ticket contexts gates the cutover. Budget below. |

## 4. Design

### 4.1 Context default grants

`ExuluContext.configuration` gains:

```ts
defaultRBAC?: {
  users?: { id: string; rights: "read" | "write" }[];
  roles?: { id?: string; name?: string; rights: "read" | "write" }[];
  teams?: { id?: string; name?: string; rights: "read" | "write" }[];
};
```

One helper, `applyDefaultGrants(context, itemId, rightsMode, trx)`, owns the logic. It is
called from every place an item row is inserted, and nowhere else.

- **Where rows are inserted.** `createItem` in `src/exulu/context.ts` (used by source
  imports, the knowledge-base write tools, bulk import, the memory tool and the transcription
  service), and the generic GraphQL mutations `${ctx}_itemsCreateOne` and
  `${ctx}_itemsCopyOneById` in `src/graphql/mutations/index.ts`, which insert directly and
  never call `createItem`. All of them call the helper. The builder lists every insert site
  in the plan; the ones above are the known set.
- **Insert, not update.** Source imports call `createItem` with `upsert = true` on every
  sync, so most calls are updates of existing tickets. Defaults apply only to a genuine
  insert. `createItem` learns whether the row was inserted (`RETURNING (xmax = 0) AS
  inserted` on the upsert statement, or an existence check inside the same transaction; the
  builder picks) and skips the helper otherwise. Updates never touch grants.
- **Explicit grants win.** `createItem` gains an optional `rbac` argument with the same
  shape the bulk mutation accepts. When present, it is applied through `handleRBACUpdate`
  instead of the defaults. The callers that grant after creation today (bulk import
  `src/exulu/import/worker-deps.ts`, the memory tool `src/exulu/memory/tools.ts`, the
  transcription service `src/exulu/transcription/service.ts`) are migrated to pass `rbac`
  in, so no path ends up with defaults plus its own rows. Any remaining post-create
  `handleRBACUpdate` call must pass `undefined` for the existing rows, not `[]`: the helper
  only fetches existing rows when the argument is falsy, and an empty array makes it insert
  duplicates (`rbac` has no unique constraint).
- **Generic mutations.** `CreateOne` defaults `rights_mode` to `private` today, ignoring
  the context's `defaultRightsMode`. It is changed to use `defaultRightsMode` when the input
  omits `rights_mode`, and to call the helper when the input carries no RBAC payload. Same
  for `CopyOneById`. This is a small behaviour change for the UI's new-item dialog, which
  normally sends an explicit mode; it is listed in the calls for Daniel to confirm.
- Applied only when the effective `rights_mode` is `users`, `roles` or `teams`. Public and
  private items get no rows.
- Names resolve to ids against the `roles` / `teams` tables on first use and are cached
  per process for five minutes. An unknown name logs a warning and is skipped; it must not
  fail the insert, because an import of 50,000 tickets must not die on a typo.
- Entity string: the one the bulk mutation `${tableNamePlural}BulkUpdateRBAC` and
  `applyAccessControl` agree on for this table (the table definition's singular name). The
  transcription service grants under `"transcriptions"` today while lookups use the
  `transcriptions_items` definition, so those grants are dead; the migration above fixes it
  as a side effect and the plan includes a one-line data repair for existing rows.
- Licence: `handleRBACUpdate` already no-ops without the `rbac` entitlement. Same here.

### 4.2 `rbac` lookup index

In `src/postgres/init-exulu-db.ts`, in the raw-SQL block that holds the `job_results` and
`memory_usages` indexes:

```sql
CREATE INDEX IF NOT EXISTS rbac_entity_target_idx
  ON rbac (entity, target_resource_id, access_type);
```

The `EXISTS` subqueries in `applyAccessControl` filter on `entity`, `target_resource_id`
(compared to `items.id` through `whereRaw`; both are `uuid`, no cast involved),
`access_type` and one of `role_id`, `user_id`, `team_id`. The builder confirms with
`EXPLAIN ANALYZE` during the benchmark (§4.5) that the planner uses the index for the chunk
join. A second index on `(entity, access_type, role_id)` is allowed only if the plan shows
the first one insufficient.

### 4.3 Pipeline caches scoped to the caller's access

One shared `itemCaches` map in `ee/agentic-retrieval/pipeline/prefilter.ts` is populated
from four places, all through `context.getItems({ fields, filters: [] })` with no user:
`identifier:<ctx>` (prefilter.ts), `routing:<ctx>` (routing.ts), `conversations:<ctx>`
(search.ts) and `memory-pin:<ctx>` (memory.ts, which despite its name is built over the
document contexts, not memory bases). Routing and the prefilter both emit step notes that
list matched names.

- **An access scope, not a user.** `getItems` gains an option `accessScope: { kind: "super"
  } | { kind: "role"; roleId: string } | { kind: "public" }`. With it, the query applies only
  the matching branch of the access predicate: everything, or `public` plus `roles`-mode
  items granted to that role, or `public` only. It never adds the `created_by`, `users` or
  `teams` branches, so a name list built for a role contains nothing that only one user of
  that role may see. The existing `user`-based path of `getItems` is untouched; so is its
  contract that no `user` and no `accessScope` means unfiltered, which other callers rely on.
- **Scope resolution** from the run's caller: super admin → `super`; a user with a role →
  `role:<roleId>`; a user without a role, an anonymous guest, or the public surface →
  `public`. Teams-mode items are not visible to any name cache; `teams` is out of scope here.
- **Keys** gain the scope as a suffix (`identifier:<ctx>:role:<roleId>`, and so on). Same
  five-minute TTL. `clearPrefilterCaches` clears all scopes.
- `runRoutingPhase`, `resolveIdentifierPins` and the conversations search receive the
  caller's scope; today they receive neither `user` nor `role`.
- The role-scoped list deliberately ignores per-user grants (`users` mode, `created_by`). A
  user's own private items may therefore be missing from the pin candidates. Pins only
  narrow a search; a missing pin costs a little recall on that user's own items and can
  never widen access. This trade-off is documented in the code next to the key.
- The step notes stay; after this they can only name items within the caller's scope.

### 4.4 Bulk access: merge mode

`${tableNamePlural}BulkUpdateRBAC(ids, rights_mode, RBAC, mode)` gains
`mode: "replace" | "merge"`, default `replace` (today's behaviour, unchanged for existing
callers).

- `merge` keeps every existing grant on each item and adds or updates the given ones.
  Implemented by reading the existing rows (already done per item) and unioning before
  `handleRBACUpdate`.
- `rights_mode` is still set on every selected item in both modes.
- Frontend `BulkAccessDialog`: a two-option choice "Replace access" / "Add access", default
  "Replace" to match current behaviour. Copy belongs to the frontend builder.

### 4.5 Benchmark gate

Before any client switches a large context to roles mode:

- Measure `context.search` on Newlift's `new_servicedb_context` (50,000 items, 50,816
  chunks) and `zendesk_context` (3,972 items, 24,699 chunks) for a `default`-role user,
  p50 and p95 over the same 20 queries, with all items public (today) and with every item in
  roles mode plus two grants each (`admin` write, `default` read).
- Budget: p95 no more than 20% slower with the index in place. If exceeded, the builder
  tries the second index from §4.2, then a rewrite of the access predicate as a semi-join
  on a pre-filtered item-id set. The gate is only passed with numbers in the plan's notes.
- **Environment.** Newlift's `exulu-test` database is production, and the only sanctioned
  schema path there is init-db, which applies every pending change at once. Roles mode
  cannot be simulated read-only, so the benchmark runs on a copy: the two contexts' items,
  chunks (with vectors) and the `rbac` table restored into a local Postgres with pgvector,
  the index created, the grants inserted by script. Producing that copy is part of the
  plan unless Daniel names an existing staging copy (open question §8).
- **Queries.** The 20 queries come from the labelled NEWLIFT feedback fixtures (the
  benchmark built from `feedback` + `agent_messages`), picked for the two ticket contexts.
- Never by switching production items as a test.

## 5. Security notes

- `applyAccessControl` is unchanged. This design adds grants and indexes around it and
  makes the pipeline's auxiliary lookups go through it.
- The super-admin bypass remains. Reviewers who need to see external users' sessions are
  handled in the guardrails spec through session grants, not through this bypass.
- Grants are additive. Nothing here can make an item visible to a role that was not granted.

## 6. Testing

There is no database-backed test harness in this repo: jest mocks the knex builders and CI
has no Postgres. Tests therefore assert the queries and calls, and the benchmark (§4.5) is
the only database-backed verification.

- Unit: the helper writes the expected rows for roles by id and by name, skips unknown
  names with a warning, writes nothing for public/private items, is skipped on an upsert
  that updated an existing row, and is skipped when `createItem` received `rbac`.
- Unit: `CreateOne` without `rights_mode` uses the context default and calls the helper;
  with an RBAC payload it does not.
- Unit: `getItems` with each `accessScope` builds exactly the matching predicate and never
  the `created_by`/`users`/`teams` branches (mocked builder assertions); cache keys per
  scope; the step notes name only what the scoped list returned.
- Unit: bulk merge keeps existing grants and adds the new role; replace still replaces;
  post-create callers pass `undefined`, not `[]`, as existing rows.
- Benchmark run with `EXPLAIN ANALYZE` captured for one roles-mode query per context,
  recorded in the plan notes.
- Note for the builder: backend tests are only transpiled, not typechecked, so fixtures
  must be built from the real table definitions, not hand-written shapes.

## 7. Left to the builder

- Exact shape of the name-resolution cache and where it lives.
- Whether the step note should also say how many matches were hidden. (Decide no unless
  it is free; a count is itself a signal.)
- The migration note for existing deployments: the index is idempotent; `defaultRBAC`
  changes nothing for existing items. Client-side backfills are the client's job (see the
  Newlift rollout spec).

## 8. Open questions

1. **Benchmark environment.** Is there an existing copy of Newlift's database (staging,
   a dump) the benchmark can run on, or does the plan include producing one from a
   read-only export of the two contexts? (Daniel.)

## 9. Calls made after the builder check (2026-10-27)

- Defaults apply on genuine inserts only; `createItem` detects insert versus upsert-update.
- `createItem` accepts an explicit `rbac` payload that wins over defaults; the three
  post-create granters are migrated to it.
- The generic `CreateOne`/`CopyOneById` mutations use the context's `defaultRightsMode`
  when the input omits a mode, and apply defaults when no RBAC payload is given. Small
  behaviour change for the UI's new-item dialog.
- Name caches are scoped by role through a new `getItems` access-scope option; anonymous
  and public-surface callers get a public-only list; teams-mode items are invisible to the
  caches.
- No database test harness is added; the `EXPLAIN` check moves into the benchmark.
- The dead transcription grants (wrong entity string) are repaired in passing.
