# Agent memory redesign — sub-project 3b: conflicts

Date: 2026-10-03 · Status: design approved in conversation, spec for review · Branch: `feat/memory-conflicts` (backend from develop d8169c8, frontend from main ac009f2)

Builds on sub-project 1 (memory core + chat), sub-project 2 (the Memory area) and sub-project 3a (usage tracking, `2026-10-01-memory-usage-design.md`). Sub-project 3c (the entity-based memory map) follows.

## 1. Purpose

A memory base accumulates near-duplicates ("three shared memories say nearly the same thing") and contradictions ("two memories disagree"). Curators have no way to find them today. This sub-project adds an on-demand scan per base, a Conflicts page that shows the open groups with their members, and three resolutions: keep one, merge into one memory, or dismiss as not a conflict.

Decisions Daniel made on 2026-10-02/03:

| Decision | Choice |
|---|---|
| When detection runs | **on demand per base** ("Find conflicts"), results and decisions stored |
| Storage | approach A: one `memory_conflicts` table written by the scan and the resolutions; the memory base contract is unchanged |
| Scope | **public (shared) memories only**; private memories never enter detection |
| Judge | contradictions are judged by a structured model call per candidate pair; duplicates need no model |
| Surfaces | own route `/memory/[ctx]/conflicts`, a Conflicts card on the base page, a "Possible conflicts" line in the workbench Insights, a note on the memory detail page |
| Not built | notifications to authors (no notification system exists), a history timeline, background scans |

## 2. Data

### 2.1 `memory_conflicts` (new core table, no RBAC flag)

| Field | Type | Notes |
|---|---|---|
| `context` | text, index | memory base id |
| `kind` | text | `duplicate` \| `contradiction` |
| `key` | text, unique | `${context}:${kind}:${sorted member ids joined by ","}` |
| `members` | json | sorted memory ids (2–6) |
| `similarity` | number | max pairwise cosine similarity in the group |
| `reason` | text, nullable | the judge's one-line reason (contradictions) |
| `status` | text | `open` \| `dismissed` \| `resolved`; default `open` |
| `resolution` | text, nullable | `keep` \| `merge` \| `not_conflict` |
| `resolved_by` | number, nullable | user id |
| `resolved_at` | date, nullable | |
| `merged_into` | uuid, nullable | the merged memory (resolution `merge`) |
| `scanned_at` | date | last scan that saw this group |

Index on (`context`, `status`). Created by the existing init-db path; indexes by raw SQL like `memory_usages`.

### 2.2 `memory_judgements` (new core table, no RBAC flag)

Remembers judged pairs so a rescan never asks the model twice: `context` (index), `key` (unique, `${context}:${sorted pair}`), `verdict` (`same` \| `contradict` \| `compatible`), `reason`, `judged_at`. Rows are deleted when either member is archived or deleted by a resolution (they would be recreated if the memory ever came back).

## 3. Detection

`memoryConflictsScan(contextId: ID!): MemoryConflictScanResult` (mutation; requires agents **write** — a small `hasAgentsWriteAccess` helper next to the read one: super admin or `role.agents === "write"`).

1. **Candidates**: the base's non-archived memories with `rights_mode = "public"`, joined to their chunk vectors (`<ctx>_chunks.source = item id`; memories are short, the first chunk represents the memory). One SQL query computes all pairwise cosine distances (`a.embedding <=> b.embedding`, `a.source < b.source`) over those chunks and returns the pairs with distance ≤ 0.30 (similarity ≥ 0.70). Bases above 2,000 public memories return an error "base too large for a scan" (a per-item neighbour search is the follow-up if that ever happens).
2. **Duplicates**: pairs with similarity ≥ 0.88 are joined into connected components (union-find); a component larger than six is split by taking the six highest-similarity members and leaving the rest for the next scan. Each component is a `duplicate` group.
3. **Contradiction candidates**: pairs with 0.70 ≤ similarity < 0.88 not already inside a duplicate group. Pairs with a stored judgement are reused. The rest go to the judge in similarity order, at most **40 per scan**; the remainder are reported as unjudged.
4. **Judge**: one `generateText` with `Output.object({ verdict: enum same|contradict|compatible, reason: string ≤ 160 chars })`, temperature 0, the model of the first agent using the base, resolved through `resolveModel({ modelId: agent.model, agent, user, rbacBypass: true })` (the entity extractor's pattern). The prompt carries the two wordings only — no authors, no ids. `same` adds the pair to the duplicate groups; `contradict` becomes a `contradiction` group; `compatible` is stored and never shown. A failed call leaves the pair unjudged (not stored).
5. **Upsert** by `key`: new keys → `open` with `scanned_at`; existing `open` rows → `similarity`/`reason`/`scanned_at` refreshed; `dismissed`/`resolved` rows untouched. Open groups of this base whose key was **not** produced by this scan (a member archived, deleted, made private, or re-worded) are closed by the scan: `status = resolved`, `resolution = null`, `resolved_at = now` — nobody decided anything. Such machine-closed groups **reopen** when a later scan produces their key again (the memory came back or was re-shared); groups a person resolved or dismissed never reopen. The pairs query is bounded (`SCAN_MAX_PAIRS = 5000`, most similar first); when it hits the bound the result's `skipped` signals that another scan is needed.
6. **Result**: `{ open, duplicateGroups, contradictionGroups, judged, unjudged, skipped }` plus `scannedAt`.

Thresholds (0.70 / 0.88, cap 40, group cap 6, base cap 2,000) live as constants in `src/exulu/memory/conflicts/thresholds.ts`.

## 4. Resolution API

All mutations require agents write **and** `canEditMemory` (sub-project 1's rule: creator, super admin, or an explicit write grant) on **every** member; otherwise the error names the first member the user may not change.

```graphql
enum MemoryConflictAction { KEEP  MERGE  NOT_CONFLICT }
input MemoryMergeInput { information: String!  type: String }

memoryConflictsScan(contextId: ID!): MemoryConflictScanResult!
memoryConflictResolve(id: ID!, action: MemoryConflictAction!, keepId: ID, merged: MemoryMergeInput): MemoryConflict!
memoryConflictSuggestMerge(id: ID!): MemoryMergeSuggestion!   # { information, type }
```

- `KEEP` (both kinds; `keepId` must be a member): every other member is archived through `context.updateItem({ id, archived: true }, config, user.id, role.id, false, false)` (no re-embed, no processor); status `resolved`, resolution `keep`.
- `MERGE` (duplicates only): `context.createItem({ name: first 80 chars of the wording, information: merged.information, type: merged.type ?? the members' common type (else omitted), description: "Merged from N memories by <resolver>: <author names>", rights_mode: "public", created_by: user.id }, config, user.id, role.id, false)`; members archived as in KEEP; usage rows re-pointed: `update memory_usages set memory_id = <merged> where context = ? and memory_id in (members)` after deleting rows that would collide on (`message_id`, `memory_id`); `merged_into` set; status `resolved`, resolution `merge`. Judgements involving the members are deleted.
- `NOT_CONFLICT`: status `dismissed`, resolution `not_conflict`. A dismissed key stays dismissed on every later scan.
- Skip is client-side only.
- `memoryConflictSuggestMerge`: one model call (same resolution as the judge) returning `{ information, type }` — a single wording that keeps every fact of the members, in the members' language, and the most common member type. Not stored.

Reads (agents read):

```graphql
type MemoryConflictMember { id: ID!  information: String!  type: String  author: MemoryBaseUser  createdAt: String!  usedCount: Int! }
type MemoryConflict { id: ID!  kind: String!  status: String!  similarity: Float!  reason: String  members: [MemoryConflictMember!]!  scannedAt: String!  resolvedAt: String  resolution: String  mergedInto: ID }
type MemoryConflictCounts { open: Int!  memoriesInvolved: Int!  lastScanAt: String }

memoryConflicts(contextId: ID!): [MemoryConflict!]!        # open groups, newest scan first
memoryConflictCounts(contextId: ID!): MemoryConflictCounts
memoryConflictsForMemory(contextId: ID!, memoryId: ID!): { open: [MemoryConflict!]!  mergedFrom: [MemoryConflictMember!]! }
```

Members are hydrated from the items table (public rows only — they are by construction), author names via `displayName`, `usedCount` from `memory_usages`.

## 5. Frontend

Everything inside `app/(application)/memory/**` and the workbench memory section; route-local documents; i18n `memory.conflicts.*` (en/de): Conflicts / Konflikte, Near-duplicates / Fast-Duplikate, Contradiction / Widerspruch, Keep this one / Diese behalten, Merge / Zusammenführen, Not a duplicate / Kein Duplikat, Not a conflict / Kein Konflikt, Skip / Überspringen, Find conflicts / Konflikte suchen.

### 5.1 `/memory/[ctx]/conflicts`

- Breadcrumb Memory › base; title "Conflicts"; subtitle "Last scan {relative}" or "Not scanned yet"; **Find conflicts** button (agents write; disabled with a spinner while scanning; result toast "{open} open · {unjudged} pairs still unjudged, run again" when unjudged > 0).
- Open groups as cards, newest scan first. Card header: kind badge; "{n} memories say nearly the same thing" (duplicates) or the judge's reason (contradictions); "similarity {percent}". Members side by side (stack below `md`): wording, "{type} · {author} · {saved}", "used {n}×", a **Keep this one** button. Footer: **Not a duplicate** / **Not a conflict**, **Skip**, and **Merge** (duplicates only). Keep and Merge confirm through a ConfirmDialog naming what gets archived. Skip hides the card until the next visit.
- Merge side panel: on open, fetch the suggestion; editable wording (textarea) and type (select from the base's enum); line "Credits all {n} authors · keeps usage history"; **Merge** button; failures keep the panel open with the error.
- Members the viewer may not change: the card's actions are disabled with the hint "You can't change {author}'s memory".
- Empty states: "No open conflicts" with the last scan time; "Not scanned yet" with the button; an invalid base shows the sub-project 2 warning.

### 5.2 Base page, workbench, detail

- Base page: a fifth stat card **Conflicts** (open groups; caption "{n} memories involved"; "Not scanned yet" when there is no scan) linking to the conflicts page; the overflow menu gains "Find conflicts" (write).
- Workbench Insights, Needs attention: "Possible conflicts {n}" linking to the conflicts page.
- Memory detail: under Details, "Part of an open conflict · Open" when `memoryConflictsForMemory.open` is non-empty; on a merged memory, "Merged from {n} memories" with the archived originals' wordings. No timeline.

### 5.3 Pure modules (vitest)

`conflicts-data.ts`: `groupTitle(group, t)`, `memberLabel(member)`, `actionsFor(group, canEditIds)` (which buttons are enabled), `mergePanelState` (suggestion → editable draft, type options), `scanResultToast(result)`.

## 6. Privacy and error handling

| Case | Behaviour |
|---|---|
| Private memories | never scanned, never shown |
| Viewer may not change a member | actions disabled with a hint; the server rejects anyway |
| Judge call fails | pair stays unjudged, counted in the result, retried next scan |
| Pairwise query fails or the base is too large | the scan fails with a clear error; nothing is written |
| Merge creates the memory but archiving a member fails | the group stays open with `merged_into` set and the error names the member; a retry of KEEP finishes the job |
| A member was archived since the scan | the next scan closes the group; a resolution on a stale group archives nothing twice (`archived` is idempotent) |
| Suggestion call fails | the panel opens with the first member's wording and a notice |

Judge and suggestion prompts carry wordings only. Costs: ≤ 40 judge calls per scan, one suggestion call per Merge panel open.

## 7. Testing

- Backend (jest): union-find grouping with the cap; threshold bands; judge verdict mapping with a stubbed model and a failing model; upsert rules (new, refresh, dismissed untouched, closed-on-missing); each resolution's effects on a fake db (archive set, created memory, usage re-pointing with collisions, judgement cleanup, `merged_into`); the write-access gate on every member; `memoryConflictsForMemory`.
- Frontend (vitest): the pure modules; `queries.test.ts` extended; demo resolvers map the operations to empty results.
- UAT (Daniel): scan Newton's base twice (second scan judges nothing new); merge a duplicate group and see the merged memory with carried-over usage; keep one of a contradiction; dismiss a false positive and rescan — it stays gone; a non-admin user sees disabled actions on others' memories.

## 8. Out of scope

Notifications to authors, background or scheduled scans, scanning private memories, undo of a resolution (Knowledge can restore archived items), a history timeline, the memory map (3c), cross-base conflicts.
