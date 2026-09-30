# Agent memory redesign, sub-project 2: the Memory area — Design

**Date:** 2026-09-30
**Status:** Drafted (pending user review)
**Branches:** `feat/memory-area` in both repos (worktrees `../backend-agent-memory`, `../frontend-agent-memory`), forked from the merged `develop` / `main` that contain sub-project 1.
**Related:**
- Sub-project 1 spec: `docs/superpowers/specs/2026-09-29-agent-memory-redesign-design.md` (memory base contract, `memory_config`, tools, recall, `memoryBase`, `memoryBaseStats`)
- Designer deliverable: `Projects/exulu/redesigns/Agent Memory Redesign.pdf`, screens 8 (Memory overview), 9–10 (per-base Overview and Memories tabs), 12 (memory detail), 13 (vocabulary and empty states)
- Recall follow-ups (out of scope here): `docs/superpowers/plans/2026-09-30-memory-recall-followups.md`

## Summary

Sub-project 1 made memory visible in chat and configurable in the workbench. Builders and curators still have
no place that shows **all memory bases**, **what each agent has learned**, and **one memory in full**. This
sub-project adds that place: a `Memory` area under Build with three pages — the bases overview, the per-base
memory list with a stats strip, and the memory detail — built as memory-specific views over the knowledge
workspace's existing item queries, mutations, filters, access section and dialogs.

Decisions from brainstorming (2026-09-30):

| Topic | Decision |
|---|---|
| Placement | Own `/memory` route and nav entry, reusing the knowledge workspace's internals; links out to the knowledge item page for generic tools. |
| Source conversation | Optional `source_session` text field in the memory base contract; the remember tool fills it when the base defines it; detail shows "Open conversation" when set. Newton gets the field in newlkiag. |
| Per-base page | One page: stats strip above the memory list. Sub-project 3 adds Overview (map) and Conflicts as tabs. |
| Data shape | Approach A: one aggregate `memoryBases` query plus the generated per-context item queries and mutations. No new tables, no new mutations. |
| Counts policy | Stats count all memories including private ones (counts only, never content); the list shows what the viewer may see with "N of M visible to you". |
| Out of scope | Flagged tab and curators (dropped in sub-project 1), Conflicts, usage/"last used", history, the 3D memory map, creating memory bases from the UI, assigning a base to an agent from the overview (links to the workbench instead). |

## 1. Architecture

```
/memory                      MemoryBasesPage      ← memoryBases (aggregate) + agents (for "of N agents")
/memory/[ctx]                MemoryBasePage       ← memoryBaseStats(ctx) + <ctx>_itemsPagination (filters)
/memory/[ctx]/[id]           MemoryDetailPage     ← <ctx>_itemsPagination (id filter, RBAC field)
                                                    + agent messages (session filter) for the source quote
mutations reused: <ctx>_itemsUpdateOneById, <ctx>_itemsBulkUpdateRBAC, <ctx>_itemsRemoveOneById
```

**Invariants**

- No new tables and no new mutations. Every write is an existing item mutation with the existing RBAC checks.
- Counts may include private memories; content never crosses item RBAC. The list, the detail and the source
  quote are always fetched through RBAC-scoped queries.
- The Memory area requires the same right as Knowledge (`agents: read`). Everything below that is item RBAC.
- A memory base is still a code-defined context that passes `checkMemoryBase`; invalid and vanished bases are
  shown so builders understand why an agent has no memory. A base an agent references but code no longer defines
  is not navigable at all; an invalid base opens a page that shows the warning and no list.

## 2. Data model

### 2.1 Contract addition

`src/exulu/memory/memory-base.ts` documents an **optional** field:

| Field | Type | Written by | Purpose |
|---|---|---|---|
| `source_session` | `text` | `memory_remember` (only when the context defines the field) | id of the chat session the memory was saved from |

`checkMemoryBase` is unchanged. `memoryTypeValues` is unchanged. A helper `memoryBaseHasSourceSession(context)`
returns whether the field exists. The `memory_remember` tool adds `source_session: sessionID` to the created
item when the helper is true and a session id is present (the tool wrapper already passes `sessionID`).

Newton: `newton_memory_context` in newlkiag gains `{ name: "source_session", type: "text" }` (one line; the
column is added by init-db on the next boot). Existing memories keep `null`.

### 2.2 `memoryBaseStats` (changed meaning, additive shape)

```graphql
type MemoryBaseStats {
  total: Int!            # all non-archived items, including private ones
  public: Int!
  private: Int!
  contributors: Int!     # distinct created_by over all items
  lastSavedAt: String
  lastSavedBy: MemoryBaseUser
  visible: Int!          # items the viewer may read (RBAC-scoped) — used for "N of M visible to you"
}
```

The unscoped counts are what the designer's screens show ("47 · 31 public · 16 private"); they are counts of
rows, never content. The query keeps its agents-read gate (`hasAgentsReadAccess`). The sub-project 1 workbench
cards read the same query and therefore show the same numbers as the Memory area.

### 2.3 `memoryBases` (new aggregate query)

```graphql
type MemoryBase {
  id: ID!                 # context id
  name: String!
  description: String
  valid: Boolean!         # checkMemoryBase.ok
  missing: [String!]!     # checkMemoryBase.missing
  missingFromCode: Boolean!   # referenced by an agent but no context with that id exists
  agents: [MemoryBaseAgent!]! # agents whose memory column points at this base
  stats: MemoryBaseStats      # null when missingFromCode
}
type MemoryBaseAgent { id: ID!  name: String! }
type Query { memoryBases: [MemoryBase!]! }
```

Resolver (`src/graphql/resolvers/memory-bases.ts`): gated on agents read; reads `agents` (`id, name, memory`)
once; unions the contexts that pass `checkMemoryBase` with every distinct `agents.memory` value; computes
`stats` per base by reusing the `memoryBaseStats` function (a handful of bases, sequential). Ordered: valid
bases in use first (by name), then valid unused, then invalid, then missing-from-code.

### 2.4 Memory list and detail (existing generated API)

- List: `<ctx>_itemsPagination(page, limit, filters, sort)` with filters built from `rights_mode: { eq }`,
  `type: { eq }`, `created_by: { eq }`, and search as `information: { contains }` — the generated filter input
  only ORs conditions within one field (`FilterOperatorString.or`), not across fields, and the wording is what
  people search for (the title is derived from it). Sort `createdAt desc`. Fields: `id name information type rights_mode created_by createdAt
  updatedAt source_session` (the last only when the base defines it; the query is built from the context's
  fields at runtime the way the knowledge page builds its item queries).
- Detail: the same query with an `id` filter and `limit: 1`, plus the item's `RBAC { users roles teams }`
  through the existing field, so the access section works as on the knowledge item page.
- Creator names: the item rows carry `created_by` (a user id). The page resolves names with the existing
  users query by ids (the RBAC control already has one); no new backend field.
- Source quote: the existing agent-messages query with a session filter (used by the feedback detail panel),
  first user message, truncated to 240 characters; "Open conversation" links to `/chat/<agent>/<session>` using
  the session's agent id from the existing session-by-id query. Both fail soft.

## 3. Backend changes

| File | Change |
|---|---|
| `src/exulu/memory/memory-base.ts` | `memoryBaseHasSourceSession(context)`; doc comment on the optional field |
| `src/exulu/memory/tools.ts` | remember writes `source_session` when the base defines it (`params.sessionID`) |
| `src/graphql/resolvers/memory-base-stats.ts` | unscoped totals + `visible` (scoped); same table-existence guard and try/catch |
| `src/graphql/resolvers/memory-bases.ts` (new) | aggregate resolver as in §2.3 |
| `src/graphql/schemas/index.ts` | typeDefs for `MemoryBase`, `MemoryBaseAgent`, `visible` on `MemoryBaseStats`, `Query.memoryBases`; resolver registration |
| `mintlify-docs/user-guide/chat/memory.mdx`, `building/agents/workbench.mdx`, new `building/memory/overview.mdx` | the Memory area, the counts policy, the optional field |

No migration: the optional field is per deployment; `source_session` on Newton is a newlkiag change.

## 4. Frontend changes

### 4.1 Navigation

`components/shell/nav-config.ts`: entry `memory` in group `build`, route `/memory`, icon `Brain`
(lucide), `requires: { area: "agents", level: "read" }`, placed after Knowledge. i18n `navigation.memory`:
"Memory" / "Gedächtnis". Demo mode: the resolvers map `memoryBases` to an empty list so the page renders its
empty state; no fabricated data.

### 4.2 `/memory` — bases overview (`app/(application)/memory/page.tsx`)

- `PageHeader` title "Memory", description "What your agents have learned in conversations. One memory base
  can serve several agents." No primary button.
- Four `StatCard`s: memory bases (valid), agents with memory (of N agents), memories (sum of totals),
  contributors (sum of per-base contributors).
- `Toolbar` search (base and agent names, client-side) and a segmented filter All / In use / Unused.
- Table on the `data-table` primitive: Memory base (name + description or "created with <agent>" when only one
  agent uses it), Used by (agent chips, "+N" overflow with a tooltip), Memories, Contributors, Last saved
  (`RelativeTime`). Invalid rows are greyed with "Not configured correctly for memory, must include the
  fields: …"; missing-from-code rows are greyed with "Not found in code" and the agent names. Unused valid
  bases show "Not used by any agent · Assign" where Assign links to `/agents`. Rows navigate to `/memory/<id>`.
- Footer line: "Counts include private memories; their content stays visible only to the people who saved them."
- Empty state: "No memory bases yet" with a link to the developer docs on defining a memory context.
- Pure module `memory-bases-data.ts`: `filterBases(bases, search, mode)`, `overviewTotals(bases, agentCount)`,
  `baseSubtitle(base)`. Tested.

### 4.3 `/memory/[ctx]` — per-base page (`app/(application)/memory/[ctx]/page.tsx`)

- Breadcrumb Memory › name; title; "Used by <agent> +N"; `OverflowMenu` with "Open in Knowledge" (`/data/<ctx>`).
- Stats strip: memories (public/private split), contributors ("of N users" omitted — no user count query),
  last saved (by whom), agents using it (chips).
- Memory list: `Toolbar` with search and All / Mine; `FilterPanel` with visibility, type (from the context's
  enum), creator (user combobox from the RBAC control's user search). Table columns: Memory (wording in
  `text-sm`; type · creator underneath), Visibility (icon + label), Saved (`RelativeTime`). Row selection
  enables the existing `BulkActionBar` actions **Set access** (`BulkAccessDialog`) and **Delete**
  (`ConfirmDialog`), reused unchanged. Pagination as on the knowledge page. Footer "N of M visible to you"
  from `stats.visible` / `stats.total`.
- Rows navigate to `/memory/<ctx>/<id>`.
- Empty state (base valid, no items): "No memories yet — agents save them when people say 'remember that …'".
  Base invalid or missing: the page shows the warning and no list.
- Pure module `memory-list-data.ts`: `buildMemoryFilters({ search, mine, userId, visibility, type, creator })`,
  `memoryRowSubtitle(item, names)`. Tested.

### 4.4 `/memory/[ctx]/[id]` — memory detail (`app/(application)/memory/[ctx]/[id]/page.tsx`)

- Breadcrumb Memory › base › Memory; badges visibility and type; the wording as the title (`text-2xl`).
- Left column: "Why it was saved" (`description`, shown as text; "Not recorded" when empty) and "Source
  conversation" (quote of the first user message + "Open conversation", or "No conversation recorded").
- Right column: `DetailSection` "Details": who can see (label + Change → opens the existing `ItemAccessSection`
  in a `SidePanel`), created by (name), created, updated. Buttons: **Make private** (only when not private;
  `ConfirmDialog` → update `rights_mode` via the bulk-RBAC mutation with the single id), **Delete**
  (`ConfirmDialog` → remove mutation → back to the list). "Edit wording" links to `/data/<ctx>/items/<id>`.
- Placeholders for Usage and History render nothing (sub-project 3 fills them).
- Not visible (query returns no row): `EmptyState` "This memory isn't available to you" with a back link.
- Pure module `memory-detail-data.ts`: `sourceQuote(messages)`, `detailActions(item, user)` (make-private and
  delete availability follow the same rule as the chat: creator, super admin, or explicit write grant from the
  item's RBAC field). Tested.

### 4.5 Vocabulary, i18n, responsiveness

Terms from the designer's vocabulary page: Memory base / Gedächtnis-Basis, memories / Erinnerungen, Private /
Privat, Public / Öffentlich, Delete stays "Delete" here (the chat uses Forget). Namespace `memory.*` in
`messages/en.json` and `messages/de.json`. Narrow screens: overview rows become cards, the per-base filters move
into the sheet, the detail stacks. No violet/purple.

## 5. Error handling

| Case | Behaviour |
|---|---|
| Base missing from code (agent references an id with no context) | Listed greyed as "Not found in code" with the agents; not navigable. |
| Base invalid (contract not met) | Listed greyed with the missing fields; per-base page shows the warning and no list. |
| Items table not created yet | `memoryBaseStats` returns zeros (existing guard); the list shows the empty state. |
| Viewer may not read a memory | Detail page shows "not available"; list never contained it. |
| Session of a source quote deleted or not readable | "No conversation recorded"; the link is omitted. |
| Bulk action partially fails | The existing dialogs' error lists are reused unchanged. |

## 6. Testing

**Backend (jest)**: `memoryBaseHasSourceSession`; remember writes `source_session` only when the base defines
it and a session id exists; `memoryBaseStats` unscoped totals vs `visible`; `memoryBases` grouping (in use /
unused / invalid / missing-from-code), ordering, and the read gate; schema fragment builds.

**Frontend (vitest, pure modules)**: `memory-bases-data`, `memory-list-data`, `memory-detail-data` as listed.
Component behaviour, navigation and the reused bulk dialogs by UAT.

## 7. Out of scope

Everything listed in the decisions table, plus: editing the wording in the Memory area (links to the knowledge
item page), a user count for "of N users", assigning bases from the overview, usage tracking, history,
conflicts, the memory map, flags and curators.
