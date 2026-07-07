# Context-Window Management for Chat Sessions

**Date:** 2026-07-07
**Status:** Approved — ready for implementation plan
**Scope:** backend (`exulu/backend`) + frontend (`exulu/frontend`)

## Problem

When a chat session's history outgrows the model's context window, Exulu breaks
badly and opaquely. A real incident: a user uploaded 89 `.odt` service reports;
every subsequent turn re-sent ~1.3M input tokens of document/tool content, the
frontend usage chip showed a nonsensical cumulative figure ("21M tokens"), and
requests eventually failed with raw provider errors.

Root causes (verified in code):

1. **The full history is re-sent verbatim every turn.** `generateStream` loads
   up to 50 messages (`getAgentMessages`, `src/exulu/provider.ts:1176` — with
   **no `ORDER BY`**, so >50-message sessions send an arbitrary 50) and passes
   every UIMessage, including all tool outputs, straight into `streamText`.
   There is no token counting, trimming, or summarization anywhere in the path.
2. **Tool-output truncation barely applies.** `truncateToolOutput`
   (`src/utils/truncate-tool-output.ts`, spec:
   `2026-07-03-sandbox-output-truncation-design.md`) guards only the three
   sandbox tools (readFile / bash stdout / bash stderr). Context search,
   agentic retrieval, web search, session-item retrieval, agent-as-tool, and
   document text extracted by `processFilePartsInMessages` all escape it.
3. **The context window is unknown at runtime.** `agent.maxContextLength` is
   hydrated only in the GraphQL layer
   (`src/graphql/utilities/sanitize-and-hydrate-fields.ts:288-297`); the
   runtime agent object never carries it, so `truncateToolOutput` always falls
   back to a 128K window — too big for 32K models, too small for 1M models.
4. **No pre-flight check and no overflow handling.** An oversized request is
   sent anyway; the provider's context-length error surfaces as a generic red
   alert with raw text (`session-screen.tsx:69-100`).
5. **The frontend meter is wrong.** The header chip sums per-turn usage across
   ALL messages (`hooks.ts:363-384`), but each turn's `inputTokens` already
   includes the whole prior context — so the figure grows super-linearly (the
   "21M" artifact), overstates real occupancy, and can exceed 100%.

## Decisions (from design review, 2026-07-07)

- **Limit UX:** at 80% of the usable window a banner appears with a
  **user-triggered "Compact conversation"** action and an optional text input
  that steers the compaction prompt. No silent auto-compaction.
- **Hard limit:** at 95% the composer is **blocked** with an inline "Compact to
  continue" action; the backend independently enforces the same gate.
- **Tool outputs:** **cap + offload** at the tool boundary, platform-wide.
  Oversized outputs become session artifacts with a preview + pointer;
  retrievable on demand. Restorable — nothing is lost.
- **Architecture:** compaction inserts a **checkpoint message** into
  `agent_messages`; the model view is `summary + messages after checkpoint`.
  Full history stays in the DB and UI.

## Goals

- A user can never hit the max context length through normal use: not by long
  conversations, not by huge tool outputs, not by document uploads.
- Mid-response overflow (a single turn whose tool outputs blow the window) is
  handled without user interaction and without a failed request.
- The context meter shows true occupancy; every intervention (truncation,
  compaction, blocking) is visible and explainable in the UI.
- Works identically across all providers/models (LiteLLM and catalog mode) —
  no dependence on provider-specific server-side compaction betas.
- No new Postgres columns; no migration required (checkpoint messages are
  ordinary `agent_messages` rows; all new state lives in UIMessage `metadata`).

## Non-goals

- Silent/automatic compaction (explicitly rejected in design review).
- Vector-RAG over session files — agentic retrieval over artifacts first;
  embeddings only if that proves too slow (separate future project).
- Anthropic `compact_20260112` / OpenAI `compact_threshold` server-side betas
  (revisit later as an optimization; both are beta and LiteLLM passthrough is
  unverified).
- Cross-session memory, eviction counters, or Headroom proxy compression
  (orthogonal — see `DRAF_2026-06-19-headroom-token-compression-design.md`).
- Persisting a per-session cumulative usage ledger (frontend keeps computing
  the cumulative "session usage" from message metadata as today).

## Thresholds (single source of truth)

All derived from `contextWindow` = the model's max input tokens:

| Name | Formula | Purpose |
|---|---|---|
| `outputReserve` | `min(32_000, 0.2 × contextWindow)` | headroom for the response |
| `usableWindow` | `contextWindow − outputReserve` | budget for the prompt |
| `warnThreshold` | `0.80 × usableWindow` | frontend banner |
| `blockThreshold` | `0.95 × usableWindow` | composer block + backend gate |
| `toolOutputCap` | `min(25_000, max(4_000, 0.1 × contextWindow))` tokens | per-tool-result cap |
| `compactionTail` | last messages up to `0.10 × usableWindow`, min 2 messages | kept verbatim |
| `summaryBudget` | `min(8_000, 0.05 × usableWindow)` tokens | target summary length |

Constants and derivation live in one new module (`src/exulu/context-budget.ts`)
shared by every consumer; the frontend receives the raw `contextWindow` and
mirrors the same formulas in one hook.

## Design

### 1. Foundations

**1a. Deterministic, checkpoint-aware history loading.**
`getAgentMessages` gets `ORDER BY created_at ASC` (tiebreak on `id`) and loses
the blind `limit: 50`. Assembly rule: find the newest message whose
`metadata.compaction` is set; return `[checkpoint, ...messages after it]`. No
checkpoint → full session history. The budget gate (§3) protects the model
call; compaction keeps the loaded set bounded over time.

**1b. `resolveContextWindow(agentModel, modelOverride?)`** — new resolver:

- LiteLLM mode: `findLiteLLMModel(model)` → `max_input_tokens ?? max_tokens`.
- Catalog mode: `ExuluProvider.maxContextLength`.
- Fallback: 128,000 (log a warning — an unknown window is a config smell).

The resolved value is attached to the per-request context and passed into tool
conversion (fixing the permanent-128K bug in `truncateToolOutput` call sites)
and into the budget gate and compaction endpoint. It respects the
`x-exulu-model-override` header.

**1c. Token accounting.**

- `estimateTokens(text)` — tiktoken via the existing `ExuluTokenizer`
  (`ee/tokenizer.ts`, already a dependency, currently chunking-only), with a
  chars/4 fallback if tokenizer init fails. Never calls a network endpoint.
- `contextOccupancy(messages)` — anchor on the most recent *real* number and
  estimate the delta:
  - anchor = the newer of (last assistant message carrying usage metadata:
    `inputTokens + outputTokens`) or (last compaction checkpoint:
    `metadata.compaction.occupancyEstimate`);
  - plus `estimateTokens` over every message after the anchor (new user
    message, file parts, tool outputs);
  - no anchor at all (legacy sessions) → estimate over the whole serialized
    history.

  Real usage from the provider self-corrects the estimate every turn, so
  chars/4 drift never accumulates.

### 2. Tool-boundary cap + offload

A single guard wraps **every** tool's output in
`convert-exulu-tools-to-ai-sdk-tools.ts` (built-ins, MCP tools, agent-as-tool,
retrieval tools, sandbox tools — replacing the three bespoke
`truncateToolOutput` call sites):

- `estimateTokens(serializedOutput) ≤ toolOutputCap` → pass through unchanged.
- Over the cap →
  1. Store the **full output** via the existing storage layer and register it
     as a **session item** (same mechanism as uploaded session files), named
     e.g. `tool-output/<tool>-<step>-<ts>.txt`. It appears in the Session
     files side panel.
  2. Replace the in-context output with: a head preview (first ~1,000 tokens)
     + a structured notice:
     `[Output truncated: ~84,000 tokens total. Full output stored as session
     file "<name>". Retrieve specific parts with the session retrieval tool.]`
     The notice names the escape hatch so the model self-corrects (Claude
     Code's pattern).
- **Document uploads** get the same treatment at the extraction point
  (`processFilePartsInMessages`): extracted text beyond `toolOutputCap` is
  stored as a session file; the message keeps the preview + pointer. Large
  uploads become retrievable corpora instead of inline megabytes — the direct
  fix for the 89-document incident.

**Mid-response overflow (in-flight microcompaction).** A `prepareStep` hook
(same mechanism as the existing `finalAnswerGuard`,
`src/exulu/resolve-max-steps.ts`) tracks estimated context during the step
loop. If `occupancy + next-step reserve > usableWindow`, it collapses the
*current response's* older tool results down to their pointer notices
(dropping the previews). This is restorable — the artifacts already exist from
the guard above — and requires no user interaction and no failed request.
Both `prepareStep` hooks compose (context guard runs first, final-answer guard
second).

### 3. Budget gate (every model call)

Before `streamText`/`generateText` in `provider.ts` (chat, sync, and via the
shared path the OpenAI gateway and routines):

- `contextOccupancy(assembled) ≥ blockThreshold` → **do not call the model**.
  Emit a structured stream error:
  `{ code: "CONTEXT_COMPACTION_REQUIRED", occupancy, usableWindow, contextWindow }`
  (JSON in the error message, matching the existing
  `JSON.parse(err.message).message` convention in `hooks.ts:300-311`, plus a
  `code` field).
- Provider context-length failures that slip through anyway (LiteLLM
  `ContextWindowExceededError`, provider 400s matching known context-length
  patterns) are caught in the stream `onError` and mapped to the **same
  structured code**, so unexpected overflows land in the same UX instead of a
  raw red alert.

Surfaces without the chat UI (gateway, routines) still benefit: they get the
gate and the caps; the structured error appears in their result/error output.

### 4. Compaction (user-triggered, steerable, checkpoint message)

**Endpoint:** an Express sibling of the run route, registered wherever
`registerAgentRunRoute` registers `…/run/:instance` (i.e.
`POST /agents/<agent-name-slug>/compact/:instance`, and in LiteLLM mode the
fixed `POST /agents/litellm/compact/:instance`); session via the same
`session`/`user` headers as the run route. Body:
`{ steer?: string }`. Honors `x-exulu-model-override`. Rejected with 409 while
a response is streaming for the session (frontend also disables the control).

**Procedure:**

1. Load post-checkpoint history (§1a). Split into `head` (to summarize) and
   `tail` = `compactionTail` (kept verbatim; never split a tool call from its
   result — extend the tail to the enclosing turn boundary, the same rule
   `flattenToolHistory` respects).
2. One summarization call on the session's model (temperature 0, no tools,
   `maxOutputTokens = summaryBudget`) with a structured prompt covering: the
   user's intent/requests; key facts and decisions; files/artifacts touched
   **with their session-item names** (so they remain retrievable); errors and
   resolutions; pending tasks; current state. If `steer` is present, append
   `Focus especially on: <steer>`.
3. Insert a **checkpoint message row** into `agent_messages`: a UIMessage with
   a single text part (the summary, prefixed
   `[Conversation summary — earlier messages were compacted]`) and
   `metadata.compaction = { coversUpTo: <message_id>, originalTokens,
   summaryTokens, occupancyEstimate, steer? }`. `occupancyEstimate` =
   `summaryTokens + estimateTokens(tail)`.
4. Return the checkpoint UIMessage + the new occupancy. The frontend appends
   it to the thread and the meter drops.

Model assembly (§1a) then sends `system prompt + checkpoint + tail + new
messages`. Repeat compactions nest naturally — the newest checkpoint wins; the
previous summary is part of the `head` that gets re-summarized.

**Thrashing guard:** if post-compaction `occupancyEstimate` is still
`≥ blockThreshold` (e.g. one giant item inside the tail), the endpoint returns
a structured `COMPACTION_INSUFFICIENT` error; the frontend shows "This
conversation can't be compacted further — start a new chat." — no retry loop.

**Integrity:** checkpoint messages are excluded from the UI message actions
(no edit/remove/retry) — removing one would silently restore an oversized
model view.

### 5. Frontend

**5a. Accurate meter.** `useChatSession` computes occupancy with the same
anchor+delta rule as the backend (§1c; chars/4 estimate is fine client-side).
The header chip shows `occupancy / usableWindow` percent; `UsagePopover` keeps
the cumulative sums, relabeled **"Session usage (cumulative)"**, and adds a
"Context" row showing `occupancy / contextWindow`. The ≥80% warning color now
keys off real occupancy. For model overrides, the window comes from the
LiteLLM catalog: add `max_input_tokens` / `max_tokens` to
`GET_LITELLM_CATALOG` and use the override model's window when set;
`agent.maxContextLength` remains the default source.

**5b. Banner states** (composer banner stack, patterns already in
`composer.tsx`):

- `≥ warnThreshold`: warning-tone banner — "This conversation is close to the
  model's context limit ({pct}%). Compact it to keep the agent effective." +
  **[Compact conversation]** + a collapsible text input "Anything to preserve
  in detail?" (steering). Dismissible; reappears at the next 5-point crossing.
- `≥ blockThreshold` or on `CONTEXT_COMPACTION_REQUIRED` from the backend:
  composer disabled (existing `budgetExceeded` pattern), non-dismissible bar —
  "Context limit reached — compact to continue." with the same compact
  control. Warning/amber tones only (no violet — design rule).

**5c. Compaction flow.** Clicking Compact → banner swaps to a progress state
("Summarizing conversation…"); on success the checkpoint message renders as a
**divider** in the thread (new case in `message-renderer.tsx` keyed on
`metadata.compaction`): "Conversation compacted — older messages summarized",
expandable to read the full summary, with `originalTokens → summaryTokens`
counts. Scrollback above the divider stays fully visible.
`COMPACTION_INSUFFICIENT` renders the start-a-new-chat guidance with the
existing "New chat" action.

**5d. Error mapping.** `useChat.onError` recognizes the structured `code`
field; `CONTEXT_COMPACTION_REQUIRED` triggers the blocking state instead of
the generic destructive Alert. All new strings go through i18n
(`messages/*.json`, `chat.context.*` keys).

### 6. Edge cases

- **Single oversized user message:** the composer's existing char cap
  (`maxInputLength`) now derives from the real window via 5a; unchanged
  otherwise.
- **Messages without usage metadata** (legacy/errored turns): occupancy falls
  back to full estimation (§1c) — approximate but self-correcting after the
  next successful turn.
- **Session loaded mid-trouble** (legacy oversized session): occupancy is
  computed on load from persisted metadata, so the banner/block state appears
  immediately, before any send.
- **Concurrent compaction:** disabled while streaming (frontend) + 409
  (backend).
- **Display pagination:** the chat page may still paginate messages for
  rendering; model assembly is independent of display pagination.
- **`saveChat` upsert semantics:** unchanged — checkpoint rows use the same
  `message_id` upsert path; session deletion cascades as today.

### 7. Testing

- **Unit (backend):** `context-budget.ts` threshold math; `estimateTokens`
  fallback behavior; occupancy anchor+delta (with/without usage metadata,
  with/without checkpoint); the cap/offload guard (pass-through, offload,
  pointer text, session-item registration); checkpoint-aware
  `getAgentMessages` assembly; budget-gate trigger; compaction tail-boundary
  rule (never splits a tool call from its result); thrashing guard.
- **Integration:** tsx repro script against local LiteLLM with a
  small-window model walking the full path: fill context → 80% banner data →
  compact (with steer) → verify checkpoint assembly → push to 95% → verify
  structured block error; plus the mid-response overflow path (tool loop that
  generates > usableWindow of output in one turn).
- **Frontend:** meter states at 79/80/95%; banner → progress → divider flow;
  blocked composer; `CONTEXT_COMPACTION_REQUIRED` and
  `COMPACTION_INSUFFICIENT` mappings; divider rendering + expandable summary.

## Files touched

**Backend**

- `src/exulu/context-budget.ts` (new) — thresholds, `estimateTokens`,
  `contextOccupancy`, context-length error pattern matching.
- `src/exulu/resolve-context-window.ts` (new) — window resolution for both
  modes.
- `src/exulu/provider.ts` — ordered/checkpoint-aware `getAgentMessages`;
  budget gate before model calls; context-guard `prepareStep` composition.
- `src/exulu/resolve-max-steps.ts` — compose final-answer guard with the new
  context guard.
- `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts` — universal
  cap/offload guard (replaces per-tool `truncateToolOutput` call sites).
- `src/utils/truncate-tool-output.ts` — kept as the head/tail preview
  primitive the guard uses; its direct call sites in tool conversion are
  replaced by the guard.
- Document extraction path (`processFilePartsInMessages`) — cap + offload for
  extracted text.
- `src/exulu/routes.ts` — compact endpoint; onError mapping to structured
  codes.
- GraphQL: no schema change needed — the `LiteLLMModel` type already exposes
  `max_tokens`/`max_input_tokens` (`src/graphql/schemas/index.ts:730-748`);
  only the frontend query needs to select them.

**Frontend**

- `app/(application)/chat/hooks.ts` — occupancy computation, banner/block
  state, compact mutation, error-code mapping.
- `app/(application)/chat/components/composer.tsx` — banner + blocking states
  + steering input.
- `app/(application)/chat/components/chat-header.tsx`, `usage-popover.tsx` —
  meter rework, relabeled cumulative usage.
- `components/message-renderer.tsx` — compaction divider; exclude checkpoint
  messages from message actions.
- `app/(application)/chat/queries.ts` — catalog context-length fields.
- `messages/*.json` — `chat.context.*` strings.

## References

- Research basis (2026-07-07): Anthropic context editing / compaction /
  memory-tool docs; Claude Code compaction internals; OpenAI Responses
  truncation + compaction; LiteLLM token utilities & context-window fallback
  routing; LangChain Deep Agents offload thresholds (>20K tokens → filesystem
  + pointer); Manus "restorable compression"; MemGPT/Letta paging; Cursor /
  Claude.ai limit UX. Key numbers adopted: tool cap ~25K (Claude Code),
  offload-with-pointer (Deep Agents/Manus), warn/block layering with reserved
  output headroom (Codex CLI/Claude Code), summary-as-checkpoint with verbatim
  tail (Anthropic compaction, OpenCode).
- Related specs: `2026-07-03-sandbox-output-truncation-design.md` (superseded
  in part by §2), `DRAF_2026-06-19-headroom-token-compression-design.md`
  (orthogonal proxy-level compression).
