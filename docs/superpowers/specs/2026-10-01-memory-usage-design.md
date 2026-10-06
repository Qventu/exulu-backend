# Agent memory redesign — sub-project 3a: usage tracking

Date: 2026-10-01 · Status: design approved in conversation, spec for review · Branch: `feat/memory-usage` (backend from develop f2b7a69, frontend from main ca828b6)

Builds on sub-project 1 (memory core + chat, `2026-09-29-agent-memory-redesign-design.md`) and sub-project 2 (the Memory area, `2026-09-30-memory-area-design.md`). Sub-project 3 was split on 2026-10-01 into three specs in dependency order: **3a usage tracking (this spec)**, 3b conflicts, 3c the entity-based memory map. History on the detail page is reduced to the existing created/updated fields.

## 1. Purpose

Builders and curators keep a memory base healthy. Today they see what was saved; they cannot see what the agents actually draw on. This sub-project records every memory an agent was given for an answer and shows the result where the designer put it: a Last used column and a Usage filter on the base page, a Usage section on the memory detail page, a Never used card, an Archive bulk action for the leftovers, and an Insights block on the agent workbench.

Decisions Daniel made on 2026-10-01:

| Decision | Choice |
|---|---|
| Order of sub-project 3 | usage → conflicts → map; history reduced to created/updated |
| What counts as a use | a memory **recalled into the answer** (given to the agent), one record per recalled memory per answer; no citation parsing |
| Never-used and stale memories | a **Usage filter** on the list (Never used / Not used in 90 days) and an **Archive** bulk action reusing the item `archived` flag |
| Storage | approach A: one core table written when the answer finishes, everything else derived by query, **guest sessions recorded too** |

## 2. Data

### 2.1 `memory_usages` (new core table)

Defined in `src/postgres/core-schema.ts` like the other core tables (no `RBAC` flag; `createdAt`/`updatedAt` come from the generic table creation). Created by the existing init-db path on boot.

| Field | Type | Notes |
|---|---|---|
| `memory_id` | uuid, index | the item id in the memory base |
| `context` | text, index | the memory base (context id) |
| `agent` | text | agent id |
| `session` | text, nullable | the chat session id from the request header; null when absent |
| `message_id` | text | the assistant message id of the answer |
| `user` | number, nullable | null for guests |
| `guest` | boolean, default false | |
| `createdAt` | timestamp | the use time |

Indexes: unique on (`message_id`, `memory_id`) so a retried finish never double-counts; composite on (`context`, `memory_id`, `createdAt`) for the aggregates; (`context`, `createdAt`) for the weekly buckets.

No columns are added to memory bases; the contract (`information`, `type`, optional `source_session`) is unchanged.

### 2.2 Writer

`src/exulu/memory/usage.ts` exports `recordMemoryUsage({ db, recall, context, agent, session, messageId, user })`:

- Takes the recall collector's `list()` (the memories given to the model this turn). Returns immediately when the collector is absent or empty.
- One batch insert of `{ memory_id, context: context.id, agent: agent.id, session: session ?? null, message_id, user: user?.id ?? null, guest: !user?.id }` with `onConflict(["message_id", "memory_id"]).ignore()`.
- Wrapped in try/catch: logs one `console.error` and never throws; the answer is never affected.

Hook points in `src/exulu/routes.ts`:

- **Streaming path**: inside the existing `onFinish` of `pipeUIMessageStreamToResponse`, after `saveChat` for signed-in sessions and unconditionally for guests (guests have no saved chat; the usage row carries `guest = true` and the session header when present). `messageId` is `responseMessage.id`.
- **Non-streaming path** (`generateSync`): the route records usage after the response is generated and before it is sent; `generateSync` exposes its recall collector alongside the response (extend its return type if it does not already).

### 2.3 Archiving

Archiving reuses the item `archived` flag through the generated `<ctx>_itemsUpdateOneById(id, input: { archived: true })` mutation (existing write-access checks). Archived memories already leave recall (`loadVisibleMemoryRows` excludes archived rows), the list (`archived: { eq: false }`) and the counts (`memoryBaseStats` ignores archived rows). Usage rows of archived memories stay; they are history.

## 3. Read API

All four queries live in `src/graphql/resolvers/memory-usage.ts`, are registered next to `memoryBases`, and are gated by `hasAgentsReadAccess` (empty result otherwise). Counts are unscoped by the sub-project 2 policy (numbers, never content); the only scoped element is the conversation title on the detail page.

```graphql
type MemoryUsageSummary { memoryId: ID!  count: Int!  lastUsedAt: String }
type MemoryUsageEntry {
  sessionId: String  messageId: String!  usedAt: String!
  agent: MemoryBaseAgent            # id + name
  user: MemoryBaseUser              # null for guests
  title: String                     # only when the viewer may read the session
}
type MemoryUsage { count: Int!  lastUsedAt: String  recent: [MemoryUsageEntry!]! }
type MemoryWeekBucket { weekStart: String!  count: Int! }
type MemoryMostUsed { id: ID!  information: String!  count: Int!  lastUsedAt: String }
type MemoryBaseUsage {
  used: Int!            # memories with at least one row
  neverUsed: Int!       # non-archived memories with no row
  stale: Int!           # used before, not within staleDays
  mostUsed: [MemoryMostUsed!]!        # top 5 by count, ties by last use
  newPerWeek: [MemoryWeekBucket!]!    # last 6 ISO weeks from item createdAt
}
enum MemoryUnusedMode { NEVER  STALE }

memoryUsageByIds(contextId: ID!, ids: [ID!]!): [MemoryUsageSummary!]!
memoryUsage(contextId: ID!, memoryId: ID!, limit: Int = 5): MemoryUsage
memoryBaseUsage(contextId: ID!, staleDays: Int = 90): MemoryBaseUsage
memoryBaseUnusedIds(contextId: ID!, mode: MemoryUnusedMode!, staleDays: Int = 90): [ID!]!
```

- `memoryUsageByIds`: one grouped query over `memory_usages` for the page's ids; ids without rows are omitted (the client treats them as never used).
- `memoryUsage`: the count and last use over all rows; `recent` = the last `limit` rows ordered by `createdAt desc`. Titles come from one `agent_sessions` query over the distinct session ids **through `applyAccessControl`** (sessions always enforce RBAC); entries whose session is not returned keep `title: null`. Agent names from one `agents` query (unscoped, id + name, as `memoryBases` does); user names via the existing `displayName` helper, `null` for guests.
- `memoryBaseUsage`: `used`/`neverUsed`/`stale` from one aggregate over the base's non-archived items left-joined with their last use; `mostUsed` from the usage counts joined with the item `information` **through `applyAccessControl` on the items table** so a wording the viewer may not read is never returned (such memories are skipped, not blanked); `newPerWeek` from item `createdAt` bucketed by ISO week in UTC.
- `memoryBaseUnusedIds`: the ids of non-archived memories with no row (`NEVER`) or with a last use older than `staleDays` (`STALE`). The list passes them as `id: { in: ids }` to its existing generated query (the generated string filter supports `in`); bases are hundreds of rows, not millions. An empty result renders the empty state without a query.

Every query returns zeros / empty lists when the usage table or the items table does not exist yet (same `hasTable` guard as `memoryBaseStats`).

## 4. Frontend

Everything stays inside `app/(application)/memory/**` and the workbench memory section; no new routes. Route-local documents in `app/(application)/memory/queries.ts`. i18n namespace `memory.usage.*` (en/de): "used" / "verwendet", "never used" / "nie verwendet", "not used in {days} days" / "seit {days} Tagen nicht verwendet", "Used in {count} answers" / "In {count} Antworten verwendet", "Archive" / "Archivieren".

### 4.1 Base page `/memory/[ctx]`

- Stat cards: Memories · Contributors · Last saved · **Never used** (replaces Used by; the agents already sit in the header line). Caption "candidates to archive"; value from `memoryBaseUsage.neverUsed`.
- Inline filters gain **Usage**: Any / Never used / Not used in 90 days. When set, the list first resolves `memoryBaseUnusedIds` and passes `id: { in: ids }`; the Mine, visibility, type and creator filters still apply on top.
- Table: new **Last used** column (`RelativeTime` or "Never"); the row subtitle appends "used N×" when N > 0. One `memoryUsageByIds` call per page (ids of the current rows), `cache-and-network`.
- Bulk actions: **Archive** joins Set access and Delete. ConfirmDialog ("Archive {count} memories?" / "They leave recall and the counts; you can restore them in Knowledge."), then the generated update mutation per id with `archived: true`, partial failures listed in the dialog and kept selected, same contract as Delete. After success: refetch list, stats and usage.
- Footer unchanged ("N of M visible to you").

### 4.2 Detail page `/memory/[ctx]/[id]`

A **Usage** `DetailSection` (open by default) in the right column under Details:

- "Used in {count} answers · last {relative}" or "Never used".
- Up to five recent entries: "{agent} · {user or Guest} · {relative}"; when `title` is present the entry is a link to `/chat/{agentId}/{sessionId}` labelled with the title; otherwise plain text.
- Query errors render an inline error with retry inside the section; the rest of the page is unaffected.

### 4.3 Workbench (agent edit → memory section, on state)

An **Insights** block under the existing stats, inside the `ChartCard` primitive, hidden when the base is invalid:

- **Most used**: top three wordings with "{count}×", each linking to `/memory/{ctx}/{id}`.
- **Needs attention**: "Never used {n}" and "Not used in 90 days {n}", each linking to `/memory/{ctx}?usage=never|stale` (the base page reads the `usage` search param to preset the filter).
- **New memories per week**: six bars drawn with plain `div`s (height proportional to the max), week labels under them, "Last 6 weeks" caption. No chart library.

### 4.4 Pure modules (vitest)

- `usage-data.ts`: `usageLabel({ count, lastUsedAt })`, `unusedFilterToMode(value)`, `weekBars(buckets)` (normalised heights and labels), `usageEntryLabel(entry)`.
- Existing `memory-list-data.ts`: `buildMemoryFilters` gains `ids?: string[]` → `id: { in }`.

## 5. Privacy and error handling

| Case | Behaviour |
|---|---|
| Viewer may not read a session a memory was used in | entry shows agent and time, no title, no link; count unaffected |
| Viewer may not read a most-used memory's wording | that memory is skipped in `mostUsed` |
| Guest usage | counted; entry shows "Guest", no user, no link |
| Usage write fails | one `console.error`, answer unaffected, row missing |
| Usage read fails on the list | Last used column shows "—", list still renders |
| Usage table not created yet | all queries return zeros / empty |
| Archive partially fails | dialog stays open with per-item errors, failed ids stay selected |

Usage rows carry ids and timestamps only, never message content or memory wording.

## 6. Testing

- Backend (jest): `recordMemoryUsage` (batch shape, conflict-ignore, guest rows, no write without recall, swallowed errors); each read query against a fake db (grouping, never vs stale with the window boundary, top-5 ordering and RBAC skip, ISO-week buckets incl. empty weeks, title scoping, missing tables); the agents-read gate; schema fragment builds.
- Frontend (vitest): the pure modules above; `queries.test.ts` extended with the new documents; demo resolvers map the new operations to empty results (`usage` filter shows the empty state in demo mode).
- UAT (Daniel): chat with Newton twice, see the two memories' Last used update and the detail page list the conversation with a link; a second user sees the count but no link; the Usage filter plus Archive removes a never-used memory from recall and the counts; the workbench Insights block matches the base page.

## 7. Out of scope

Citation-based usage, retention of usage rows, usage charts beyond the six bars, conflicts (3b), the memory map (3c), history events, restoring archived memories from the Memory area (Knowledge has it).
