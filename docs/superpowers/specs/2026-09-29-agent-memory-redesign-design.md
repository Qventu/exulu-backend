# Agent memory redesign, sub-project 1: memory core and chat — Design

**Date:** 2026-09-29
**Status:** Drafted (pending user review)
**Branches:** `feat/agent-memory` in both repos (worktrees `../backend-agent-memory`, `../frontend-agent-memory`)
**Related:**
- Designer deliverable: `Projects/exulu/redesigns/Agent Memory Redesign.pdf` (14 screens) and `.html`
- Design brief the mockups were built from: Claude Doc "Agent Memory Design Brief" (2026-09-23)
- `src/templates/tools/memory-tool.ts` (current create tool), `src/exulu/generate-stream.ts` (memory pre-fetch),
  `ee/agentic-retrieval/pipeline/memory.ts` (knowledge-search memory phase)
- `docs/superpowers/specs/2026-07-15-agent-kb-write-tools.md` (create/update item tools this design reuses)
- `docs/superpowers/specs/2026-07-22-tool-credentials-chat-ui-design.md` (custom cards on tool parts, the pattern reused here)

## Summary

Agent memory lets an agent keep facts users tell it in chat and use them in later conversations. Today the
feature works but is invisible: a text question in chat, a generic approval card, a system-prompt injection
nobody sees, and a generic knowledge-base table to review what was saved. The redesign makes memory
**visible, editable and governable** in three sub-projects. This spec covers sub-project 1:

1. **Memory core** — the agent's memory settings, a corrected retrieval path, and three agent tools
   (remember, update, forget) whose consent step *is* the save card.
2. **Chat** — the save card, the correction/forget card, a "Recalled N memories" block on answers, and a
   "What <agent> remembers about you" side panel.
3. **Workbench** — the Knowledge & memory section rebuilt around the memory base picker, retrieval
   behaviour and the few sharing rules that exist.

Sub-project 2 (the Memory area in the Build navigation, per-base overview and lists) and sub-project 3
(conflicts, insights, usage tracking, the entity-based memory map) follow with their own specs.

**Reuse first.** Every screen maps onto something the platform already has: the AI SDK tool-approval flow
(consent, persistence, hydration on reload), the RBAC control, the knowledge-citation syntax and badges, the
Sources collapsible, the SidePanel primitive, the item create/update/delete mutations and the item
write-access check. The only schema change is one json column on `agents`. **Zero new tables.**

## Decisions (from brainstorming, 2026-09-29)

| Topic | Decision |
|---|---|
| Memory bases | **Existing knowledge bases only** (option C). A memory base is an `ExuluContext` defined in code that meets the memory-base contract (§2.1). No runtime creation of knowledge bases; the workbench only picks among existing ones. |
| Consent and persistence | The save card is the AI SDK **approval step** of the `memory_remember` tool. No proposals table, no review queue, no approval workflow beyond the card itself. Edits (wording, type, access) travel in the approval response's `reason`. |
| Editing and forgetting | Same mechanism: `memory_update` and `memory_forget` tools whose approval step is a diff or forget card. Rejected: flags, curators, corrections queue. Showing who created a memory is enough; a user without write rights asks the creator or an admin. |
| Access on save | The card embeds the existing **RBACControl** (private, users, roles, teams, public, with read/write per subject). Default is the context's `defaultRightsMode` (read for that mode) or the agent's preselect. |
| Guests | **Use versus show.** The server keeps using memories for guest sessions (they only ever match public items). A per-agent switch decides whether recalled memories are shown to guests. Guests never get the remember/update/forget tools, because a memory needs an owner. |
| Recall once, use by reference | One recall step per turn owns memory retrieval. Its output is injected once into the system prompt, shown as "Recalled N memories", and handed to the knowledge-search tool, whose memory phase no longer retrieves anything and no longer appends memory chunks to its result. Nothing reaches the model twice. (Decided 2026-09-29 after finding the streaming path had injection disabled and the search tool re-fetching.) |
| Recalled memories | Delivered as **message metadata** (`recalledMemories`). Metadata is persisted with the message and never reaches the model (the SDK's message conversion reads parts only), so it costs no context tokens. |
| Newlift regression eval | Acceptance gate for the recall change: a standalone script replays Newlift's positive-feedback answers (275, of which 17 used memory) against the new recall over the tunnelled Newlift database and reports memory hit rate and answer quality (§6.1). No platform eval feature involved. |
| Retrieval bug | The pre-fetch in `generateSync`/`generateStream` searches without a user, so `applyAccessControl` returns only public rows and private memories are never used on the plain chat path. Fixed here by passing user and role. |
| Retrieval toggles | "Look up memories before every answer" (recall on/off plus the per-answer limit) is new agent config and is the single switch. The three knowledge-search memory behaviours (override, file hints, query widening) stay in the `agentic_context_search` tool config, are shown nested under that switch as "when knowledge search runs, recalled memories may also …", and are disabled when recall is off. The wizard's Memory step becomes a link. |
| Destructive actions | Forget, turn memory off, change store, and dismiss all confirm through the shared `ConfirmDialog`. |
| Picker | Contexts that fail the memory-base contract are listed **disabled** with the hint "Not configured correctly for memory, must include the fields …". |

## 1. Architecture

```
┌──────────────── Chat (frontend) ──────────────────────────────────────────────────────┐
│ MemoryCard (approval UI for memory_* tool parts)  RecalledMemories (message metadata) │
│ MemoryPanel (SidePanel: what <agent> remembers)   header chip "Remembers N things"   │
└───────┬──────────────────────────────┬──────────────────────────────┬────────────────┘
        │ addToolApprovalResponse       │ existing item mutations       │ items query
        │ reason = JSON edits           │ (update / delete / RBAC)      │ (created_by = me)
        ▼                               ▼                               ▼
┌──────────────── @exulu/backend ───────────────────────────────────────────────────────┐
│ generateStream: read memory decisions from incoming messages → tool params            │
│   memory pre-fetch (user-scoped, limit) → RecallCollector → metadata.recalledMemories │
│ tools: memory_remember / memory_update / memory_forget (needsApproval)                │
│   execute = context.createItem / updateItem / deleteItem + RBAC rows                  │
│ agents.memory_config (json)   memoryBaseStats(contextId)   context.memoryBase check   │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

**Invariants**

- Nothing is written to a memory base without an approved tool call from the session's user. The tool's
  `execute` is the only writer on the chat path; panel actions use the existing item mutations.
- Every read and write goes through the context methods with the existing per-item RBAC. No query bypasses
  `applyAccessControl`.
- Memory tools always require approval. The "Allow for this chat" pre-approval shortcut does not apply to
  them (the card is the consent).
- Message metadata is UI-only. The model only ever sees the memory block injected for the current turn and
  its own citation markers.
- Memory is recalled **once** per turn, before the model runs. Every consumer (system prompt, UI, knowledge
  search) works from that one set; no component fetches memories on its own.

## 2. Data model

### 2.1 Memory base contract

A context is a valid memory base when its `fields` contain:

| Field | Type | Purpose |
|---|---|---|
| `information` | `text` or `longText` | The memory wording shown everywhere. |
| `type` | `enum` with ≥ 1 value | Memory type (e.g. FACT, PREFERENCE, DECISION, INSTRUCTION). The card's type chip and the tools' `type` input use these values. |

Other fields are ignored by the memory tools. Standard columns used: `name` (short title), `description`
("why it was saved": the question or topic that triggered it, plain text, no prefixes), `rights_mode`,
`created_by`, `createdAt`, `updatedAt`. Newton's `newton_memory_context` already satisfies the contract.

Backend helper `checkMemoryBase(context) → { ok: boolean; missing: string[] }` in
`src/exulu/memory/memory-base.ts`. Exposed on the GraphQL context type as `memoryBase { ok missing }` so the
frontend applies the same rule. When an agent's configured context fails the check: retrieval of existing
items still runs, the tools are **not** registered, and the workbench shows a warning.

### 2.2 `agents.memory_config` (new json column)

```ts
type MemoryConfig = {
  retrieval: { enabled: boolean; limit: number };   // defaults: true, 10 (1..50)
  visibility: "ask" | "preselect_private";           // default "ask"
  guests: { showRecalled: boolean };                 // default false
};
```

Declared in `agentsSchema` (`src/postgres/core-schema.ts`); `addMissingFields` adds the column on boot; null
means defaults. Exposed through the generated GraphQL type like `tools`. `agents.memory` (context id) is
unchanged. `src/exulu/memory/config.ts` exports `resolveMemoryConfig(agent)`.

### 2.3 Memory tool outputs (tool parts, persisted by the SDK)

```ts
{ type: "memory_saved";     contextId; itemId; title; information; type; rights_mode }
{ type: "memory_updated";   contextId; itemId; title; information; type; rights_mode }
{ type: "memory_forgotten"; contextId; itemId; title }
{ type: "memory_no_access"; contextId; itemId; title; createdBy: { id; name } }
{ type: "memory_error";     message }
```

### 2.4 Approval decision (approval response `reason`, JSON)

```ts
type MemoryDecision =
  | { v: 1; kind: "remember"; title: string; information: string; type: string;
      rights_mode: ExuluRightsMode; rbac?: { users?: {id; rights}[]; roles?: {id; rights}[]; teams?: {id; rights}[] } }
  | { v: 1; kind: "update"; information?: string; title?: string; type?: string }
  | { v: 1; kind: "forget" };
```

A denial carries the plain reason `"declined"`. Malformed or missing JSON on an approval → the tool falls
back to its original input (and the context default rights mode).

### 2.5 `recalledMemories` (message metadata)

```ts
type RecalledMemory = {
  id: string; contextId: string; title: string; information: string; type?: string;
  rights_mode: ExuluRightsMode; createdBy: { id: number; name: string } | null;
  createdAt: string; updatedAt: string; source: "prefetch" | "knowledge_search";
};
```

Written once per turn on the SDK `finish` part (metadata chunks merge; last write wins), alongside the
existing usage metadata. Omitted for guest sessions when `guests.showRecalled` is false.

## 3. Backend

### 3.1 Recall, once per turn (`generateSync`, `generateStream`)

Today the streaming path runs the memory search but has the injection commented out, and the
knowledge-search tool's memory phase re-fetches (keyword recall over the whole base) and appends memory
chunks to its result. This design replaces both with one recall step, `recallMemories()` in
`src/exulu/memory/recall.ts`, called at the start of both generation paths:

- Skip entirely when `memory_config.retrieval.enabled === false` (then no memories reach the model at all,
  not even through knowledge search).
- `context.search({ ..., user, role: user?.role?.id, method: "hybridSearch", limit: memory_config.retrieval.limit })`.
  Hybrid search covers semantic and full-text matching of the question; the pipeline's separate keyword-variant
  recall is dropped. Guests (no user) keep today's behaviour: public items only. If the Newlift eval (§6.1)
  shows verified memories missing, a keyword-variant expansion of the question is added to this same step —
  never a second retrieval elsewhere.
- **Recall query is conversation-aware** (added 2026-09-30 after the Newlift eval): the search text is the
  current user message, but when that message is short (fewer than 8 words) or refers back to an earlier turn
  ("ich meinte …", "sorry", "the same one"), the previous one or two user turns are prepended, capped at 600
  characters keeping the current message. A terse follow-up such as "sorry, ich meinte 000048F2" otherwise
  recalls nothing.
- The result is the turn's memory set. It is (1) injected once into the system prompt as the block below,
  (2) emitted as `recalledMemories` metadata, and (3) passed to the knowledge-search tool as its memory
  chunks. The pipeline's memory phase keeps its model-side judgement (relevance filter, override, file
  hints, query widening) on that set but performs no retrieval of its own and does not add memory chunks
  to the tool result; the override directive still quotes the authoritative memory because that is a
  distinct instruction, not a second copy.
- Injected block (system prompt, current turn only):

  ```
  Memories: facts people saved earlier for this assistant. Use them where relevant and cite each memory you
  rely on with {item_name: <title>, item_id: <id>, context: <contextId>}.
  - {item_name: "…", item_id: "…", context: "…"} <information> (saved by <creator name> on <date>, <private|public>)
  ```

  The citation object matches the knowledge-source citation regex in the frontend renderer
  (`components/message-renderer.tsx`, "flexibleCitationRegex"; chunk fields optional), so the existing
  inline citation badges render for memories with no frontend change. Memory item ids in the block are what
  `memory_update` / `memory_forget` receive.
- `RecallCollector` (`src/exulu/memory/recall-collector.ts`): request-scoped, filled by the recall step
  before the model runs (item rows loaded with the user's RBAC, creator names resolved in one query).
  `list()` is the turn's set. `generateStream` returns the collector; `routes.ts` reads it in
  `messageMetadata` on the `finish` part. Nothing adds to it later.

### 3.2 Tools (`src/exulu/memory/tools.ts`, replaces `src/templates/tools/memory-tool.ts`)

Registered in `convertExuluToolsToAiSdkTools` when `agent.memory` resolves to a valid memory base **and**
`user?.id` is set (never for guests). Fixed ids so the frontend can detect them:

| Tool | Input | needsApproval | Execute (after approval) |
|---|---|---|---|
| `memory_remember` | `title`, `information`, `type` (context enum), `whySaved`, `visibility?` (`private`/`public`, only when the user said so) | always | Merge the decision over the input → `context.createItem({ name, information, type, description: whySaved, rights_mode }, exuluConfig, user.id, user.role?.id, false)` → apply `rbac` rows through the helper used by `itemsBulkUpdateRBAC` → `memory_saved`. RBAC rows are written through the shared helper (§3.2, enum note below). |
| `memory_update` | `memoryId`, `information?`, `title?`, `type?`, `reason` | function: `true` when the item exists and `checkItemWriteAccess` allows the user; `false` otherwise | Writable → merge decision → `context.updateItem(patch)` (existing method) → `memory_updated`. Not writable → no approval, returns `memory_no_access` with the creator so the model can say who to ask. |
| `memory_forget` | `memoryId`, `reason` | same function | Writable → `context.deleteItem` (existing method) → `memory_forgotten`. Not writable → `memory_no_access`. |

Tool descriptions tell the model: propose one memory per call, use the user's own wording, ask nothing
about visibility unless the user raised it (the card handles it), never claim something was saved before
the tool result says so. `visibility` default in the card: agent preselect if set, else the context's
`defaultRightsMode`. Enum normalisation (case-insensitive, drop unknown) reuses `canonicalizeEnumFields`
from the KB write tools (currently module-private in `context-write-tools.ts`; export it). The RBAC row
write is extracted from the `itemsBulkUpdateRBAC` mutation into a shared helper (`src/utils/apply-item-rbac.ts`)
used by both.

**Decision plumbing.** Before `streamText`, `generateStream` scans the incoming UI messages' last assistant
message for memory tool parts with `approval.approved === true` and parses `approval.reason` into a
`Map<toolCallId, MemoryDecision>`. The map is passed into `convertExuluToolsToAiSdkTools` (next to
`memoryItems`) and the wrapper hands `memoryDecision = decisions.get(options.toolCallId)` to `execute`.
Pre-approval: the wrapper never applies the `approvedTools` shortcut to memory tools.

### 3.3 GraphQL

- `memoryBaseStats(contextId: ID!): { total, public, private, contributors, lastSavedAt, lastSavedBy { id name } }`
  — counts as visible to the viewer (RBAC applied), `contributors` = distinct `created_by`. Requires agents
  read.
- Context type gains `memoryBase { ok missing }` (computed from `checkMemoryBase`).
- `${ctx}_items` accepts a `created_by` filter (verify; add to the allowed filter fields if missing). Used by
  the panel and the "All my memories" link.
- Everything else reuses existing mutations: `${ctx}_itemsUpdate`, `${ctx}_itemsDelete`, RBAC update, agent
  update (for `memory` and `memory_config`).

### 3.4 Migration and compatibility

- Column added on boot; existing agents with memory set behave as before plus the retrieval fix.
- The old tool id `create_<ctx>_memory_item` disappears; `disabledTools` or pre-approval entries that name it
  become inert. Existing memory items are not touched; new items store `description` without the old
  "Description: … Surrounding Context: …" prefixes.
- `ee/agentic-retrieval/pipeline/memory.ts` / `index.ts`: the memory phase no longer receives the memory
  context (so `recallMemoryByKeywords` and the 5-minute item cache are unused and removed) and the pipeline
  no longer appends `memoryChunksForAnswer` to the tool result. Override, file hints and query widening work
  on the recalled set exactly as before. Newton (Newlift) is the reference deployment for this change; the
  regression eval in §6.1 gates the merge.

## 4. Frontend

### 4.1 Chat: memory card (`app/(application)/chat/components/memory-card.tsx`)

`makeUntypedToolPart` in `message-column.tsx` routes tool parts whose type is `tool-memory_remember`,
`tool-memory_update` or `tool-memory_forget` to `MemoryCard` (pure detection in `memory-card-data.ts`,
tested like `credential-request-data.ts`).

- **approval-requested**
  - *remember*: title "Remember this?", type chip (Select over the context enum, from the contexts query),
    editable wording (Textarea, prefilled with `information`), `RBACControl` with `subjectLabel="memory"`
    and all modes, default mode from the agent preselect or the context default, footnote "Nothing is saved
    until you choose Save". Buttons: **Don't save** (deny, reason `declined`) · **Save** (approve, reason =
    `MemoryDecision`).
  - *update*: fetches the current item (existing item query) and shows old wording struck through, new
    wording editable. **Keep as is** · **Update memory**.
  - *forget*: "Forget this memory?" with the wording. **Keep** · **Forget** (ConfirmDialog before deny/approve).
  - No "Allow for this chat" option.
- **Stacking**: consecutive `memory_remember` approval parts in one assistant message render under one
  "Remember these? · Save all (N)" bar; each card keeps its own edits; Save all approves each with its
  current edits. Grouping is a pure helper (`groupMemoryParts`).
- **approval-responded / output-available**: one quiet resolved line reusing the current approval card's
  resolved styling — "Saving…", "Saved · Private" (link to `/data/<ctx>/items/<id>`), "Updated", "Forgotten",
  "Not saved", or the `memory_error` message.
- Guests never see these parts (tools are not registered for guests).

### 4.2 Chat: recalled memories (`recalled-memories.tsx`)

Rendered under an assistant message when `message.metadata.recalledMemories` is non-empty, using the
existing `Sources` / `SourcesTrigger` / `SourcesContent` primitives: trigger "Recalled N memories", rows
numbered in list order with wording, visibility icon, creator and date. Row actions: **Open** (item page),
**Forget** (own or write access; ConfirmDialog → `${ctx}_itemsDelete`). Edit and access changes happen on
the item page (Open). Inline citation badges keep their current look. Hidden for guests when the metadata
is absent. Deviation from the mockup: no numbered pills in the text, no mobile bottom sheet.

### 4.3 Chat: header chip and panel (`memory-panel.tsx`)

- Header chip "Remembers N things about you" built with the header's quiet-chip recipe; N = items in the
  memory context with `created_by = me` (items query, RBAC applied). Hidden for guests and when memory is off.
- Opens the `SidePanel` primitive (docked and resizable ≥ lg, sheet below) titled "What <agent> remembers"
  with the count line, tabs **All / Private / Public** (client-side on `rights_mode`), rows with visibility
  icon and wording, a **New** badge for items whose id appears in a `memory_saved` output of this session,
  and an expandable row with type, creator, date, **Edit** (item page), **Change access** (item page,
  Access section) and **Forget** (ConfirmDialog). Footer: tip "say 'forget that' in the chat" and **All my
  memories** → `/data/<ctx>?mine=1`.
- Empty state: "<agent> doesn't remember anything about you yet — say 'remember that …' in the chat."
- `/data/[ctx]` gains a `mine=1` query param that applies the `created_by` filter (small addition to
  `items-filter-fields.ts`).

### 4.4 Workbench: Knowledge & memory section (`sections/knowledge.tsx` → `memory-section.tsx`)

- **Off**: explanation and the three steps from the mockup; "Where should memories be stored?" with only
  **Use an existing memory base**: the current combobox, listing contexts already used as memory by other
  agents first ("used by Alfredinio, Ersatzteil-Bot"), contexts failing `memoryBase.ok` disabled with the hint
  "Not configured correctly for memory, must include the fields: information, type". **Turn on memory** sets
  `memory` and default `memory_config`.
- **On**: header "Memory · On · Stored in <context>" (link to `/data/<ctx>`), **Change store** and **Turn
  off** (both ConfirmDialog). Three stat cards from `memoryBaseStats` (memories with public/private split,
  contributors of N users, last saved by …). "How <agent> uses memories": one primary switch, "Look up memories
  before every answer" (`retrieval.enabled`) with the per-answer limit beside it; nested under it, indented
  and titled "When knowledge search runs, recalled memories may also…", the three existing `memory` entries
  of the knowledge-search config (override, filePrioritization, queryAugmentation). The nested three are
  disabled when the primary switch is off or knowledge search is off, each with a hint saying which. "Sharing rules": visibility
  question (Ask every time / Preselect private), memories per answer (1–50), show recalled memories to
  guests. Warning banner when the configured context fails the contract or no longer exists.
- The wizard's Memory step is replaced by a note linking to the section. Dropped for now: flagged card,
  who-can-save-public, curators, insights.
- Saved through the existing agent update mutation; editor state in `hooks.ts` gains `memory_config`.

### 4.5 Vocabulary and i18n

EN/DE terms from the vocabulary page: Memory / Gedächtnis, a memory / Erinnerung, Remember this? / Im
Gedächtnis speichern?, Private / Privat, Public / Öffentlich, Recalled N memories / N Erinnerungen genutzt,
Forget / Vergessen. Icons: bookmark (memory), lock (private), globe (public), trash (forget). New
namespaces `chat.memory.*` and `agents.editor.memory.*` in `messages/en.json` and `messages/de.json`.
No violet accents; existing palette.

## 5. Error handling

| Case | Behaviour |
|---|---|
| Approval reason not parseable | Tool uses its original input and the default rights mode; card shows the saved result. |
| Item create/update/delete fails | Tool returns `memory_error`; card shows the message; model is told. |
| Context fails the contract or is missing | Tools not registered; retrieval still runs when the context exists; workbench warning; no thrown error in `generateStream` (today's throw becomes a logged warning and memory off for the turn). |
| Memory id unknown or not visible | `memory_update`/`memory_forget` return `memory_no_access` without a creator; model says it cannot find it. |
| Session reload | Card state comes from the SDK's persisted approval and output parts; nothing else to hydrate. |
| Guest session | No memory tools; retrieval public-only; recalled metadata omitted unless `guests.showRecalled`. |
| Same memory proposed twice in a turn | Two cards; the user declines one. No de-duplication in sub-project 1. |

## 6. Testing

**Backend (jest)**
- `memory-base.test.ts`: contract check (missing `information`, wrong `type` kind, valid Newton-style context).
- `tools.test.ts`: remember merges the decision over the input, falls back on malformed reason, writes
  `rights_mode` and RBAC rows, normalises enum values; update/forget `needsApproval` false and
  `memory_no_access` when not writable, patch/delete when writable; guests get no tools.
- `recall-collector.test.ts`: de-duplication, source tagging, creator resolution, guest omission rule.
- `generate-stream` unit: decisions parsed from incoming messages; pre-fetch passes user/role and limit;
  disabled retrieval skips the search.
- `memoryBaseStats` resolver: counts respect RBAC; contributors distinct.

### 6.1 Newlift regression eval (acceptance gate for the recall change)

A standalone script, not the platform's eval feature. It runs from the newlkiag repo (which links
`@exulu/backend` to the worktree build and owns the `newton_memory_context` definition and LiteLLM access)
against the Newlift database over the local tunnel (`127.0.0.1:5433`, database `exulu-test`, IAM user).

- **Cases**: the latest 60 `feedback` rows with `score = 1` for the production Newton agent (275 exist at
  planning time), plus every older positive case whose answer used memory. For each: the assistant message
  closest before the feedback time in that session, the user question before it, the prior turns as text,
  and the memory item ids the answer actually used (tool outputs carry `chunk_id: "memory:<item_id>"`).
  17 answers in 15 sessions used memory; those form the **memory subset**.
- **How cases are replayed**: through the real run endpoint (`POST /agents/litellm/run/<agent>` with
  `stream: true`) of the newlkiag dev server running the worktree build, one fresh session per case, prior
  user turns replayed in order (max 4), then the question. The stream's message metadata carries
  `recalledMemories` (the exact set the model was given) and the text deltas carry the answer, so one call
  per case yields both measurements with no script-side bootstrapping of the app.
- **Stage 1, recall hit rate (deterministic)** — revised 2026-09-30. The first run showed the original
  ground truth (memory chunks present in the old search tool's output) was the retired retriever's whole
  candidate list, partly deleted since, so set-equality with it could never pass. The gate now uses the
  memories the verified answer **cited** in its text (citation objects with `context: newton_memory_context`
  or the older alias `context: memory`), restricted to ids that still exist. A case passes when every such id
  is in `recalledMemories`. Gate: ≥ 80 % of cited cases pass at Newton's limit of 25 (the first run measured
  54.5 % at limit 10 and a clear improvement at 25, so 25 becomes Newton's setting).
- **Stage 2, answer quality (model-judged, all selected cases)**: score
  each new answer against the verified answer with an LLM-as-judge prompt (0–100) on Newton's own model via
  LiteLLM. Gate: mean ≥ 70 and no cited case below 50; turns whose historical answer was a "remember this"
  request are excluded, because the new design correctly stops at the save card instead of answering.
  Optionally the same cases are run against the current `develop` build on a second port for a side-by-side
  mean.
- **Re-run (2026-09-30)**: after the conversation-aware recall query, the eval is re-run on every cited case
  plus the latest 20 non-cited cases with Newton's limit at 25; the result gates the frontend work.
- Output: a markdown report committed under `docs/superpowers/evals/2026-09-29-newlift-memory-recall.md`
  with counts, hit rate, misses, judge scores and the decision.

**Frontend (vitest, pure modules)**
- `memory-card-data.test.ts`: part detection, decision encoding, resolved-state mapping from outputs.
- `group-memory-parts.test.ts`: stacking of consecutive remember parts.
- `recalled-memories-data.test.ts`: metadata parsing, own-vs-others action rules.
- Component behaviour (cards, panel, workbench states, ConfirmDialogs) by manual UAT, as elsewhere in the repo.

## 7. Out of scope (later sub-projects)

- Memory area in the Build navigation, per-base Overview / Memories / Flagged / Conflicts, memory detail page
  (sub-project 2).
- Flags, corrections queue, curators, conflict detection and merge, insights, usage tracking, the
  entity-extraction-based memory map (sub-project 3).
- Runtime creation of knowledge bases; who-may-save-public roles; de-duplication of proposals.
