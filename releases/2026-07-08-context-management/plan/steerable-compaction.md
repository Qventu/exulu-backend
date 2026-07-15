# Short plan — Steerable one-click compaction

## Sources of truth

- Spec: `docs/superpowers/specs/2026-07-07-context-window-management-design.md` §4 (compaction), §5b/§5c (banner + divider)
- Backend: `src/exulu/compact-session.ts` (`69f18d6`), compact endpoint in `src/exulu/routes.ts`
  (`registerAgentCompactRoute`, `1107826`), checkpoint-aware model view
  `sliceHistoryAtCheckpoint` in `src/exulu/context-budget.ts` + ordered `getAgentMessages`
  (`4388173`)
- UI: `frontend/app/(application)/chat/components/context-banner.tsx` (`916854d`),
  `frontend/components/message-renderer.tsx` compaction divider (`1c351ef`),
  `compactConversation` in `frontend/app/(application)/chat/hooks.ts` (`d06c70e`)
- Strings: `frontend/messages/en.json` → `chat.context.*` (verbatim below); divider strings
  are hardcoded in `message-renderer.tsx`
- Brand: `releases/2026-07-08-context-management/hyperframes-design.md`

## What shipped

At 80% of the usable window an amber banner appears in the composer stack with a
user-triggered **"Compact conversation"** action and an optional steering input
("Anything to preserve in detail?"). Compaction is never silent. The backend endpoint
(`POST /agents/litellm/compact/:instance`, a sibling of the run route) summarizes
everything before a verbatim tail (one temperature-0 call, summary budget
`min(8K, 5% of usable)`), inserts a **checkpoint message** into `agent_messages`
(`metadata.compaction = { coversUpTo, originalTokens, summaryTokens, occupancyEstimate, steer? }`),
and returns it. The model then sees `checkpoint + tail`; full history stays in the DB and
the UI — the thread renders the checkpoint as an expandable divider and the meter drops
immediately. 409 while streaming; structured `COMPACTION_INSUFFICIENT` (422) if even
compaction can't fit ("start a new chat" guidance).

## Hook

**"Long chats? Compact, don't restart."** — one click summarizes history into a
checkpoint you can steer; nothing is deleted.

## Surface area

UI feature (composer banner → click → thread divider + meter drop) with a real REST
surface (the compact endpoint) → snippet earned.

## Reconstruction cues (exact, from shipped code)

Numbers for this short: 128K window → usable 102,400; warn at 81,920. Start at **84%**
occupancy ≈ 86K. After compaction: originalTokens 78K (head), summaryTokens 2.2K,
occupancyEstimate 8.4K → chip drops to **"8% · 8.4K"**.

Header chip (see `context-meter.md` for recipe) in warn state: `border-warning text-warning`
(amber #D97706) → **"84% · 86K"**.

Warn banner (`context-banner.tsx`, sits directly above the composer card, same column):
`mb-2 rounded-md border px-3 py-2 text-xs border-warning/50 bg-warning/10 text-muted-foreground`.
Row `flex items-start gap-2`: lucide `TriangleAlert` size-3.5 amber · body:
**"Approaching the context limit"** (`font-medium text-foreground`) + " — " +
**"This conversation uses 84% of the model's context window. Compact it to keep the agent
fast and accurate."** Below (mt-2): steer input already open —
`w-full rounded-md border bg-background px-2 py-1.5 text-xs`, placeholder
**"e.g. keep the exact figures from the service reports"** (`chat.context.steerPlaceholder`).
Button row (mt-2, gap-2): outline button `h-7 border-warning/50 text-xs` with lucide
`Archive` size-3 + **"Compact conversation"**; dismiss `X` size-3.5 top-right (warn only).
Progress state swaps button content to `Loader2` spinner + **"Summarizing conversation…"**
(`chat.context.compacting`).

Composer card below the banner: `rounded-lg border bg-card p-2` — ＋ attach button, textarea
placeholder **"Ask me anything..."** (`chat.composer.placeholder`), mic ghost icon, purple
#7033FF send button (size-9, `ArrowUp`).

Checkpoint divider (`message-renderer.tsx`, appears in the thread): `my-6 w-full`; center
row `flex items-center gap-3 text-xs text-muted-foreground` with `h-px flex-1 bg-border`
rules either side of **"Conversation compacted — older messages summarized"**; below, a
collapsed `<details>` `mx-auto mt-2 max-w-xl rounded-md border bg-muted/30 px-3 py-2 text-xs`
whose `<summary>` reads **"Summary (78K → 2.2K tokens)"** (Intl compact notation). Keep it
collapsed — expandability is visible from the disclosure marker; do not add a second click.

Thread above: two or three plausible messages (user + assistant) about analyzing uploaded
service reports, faded/scrolled so the divider insertion point is obvious.

## Demo arc — timed beats (1920×1080, 9.4s, ONE user action)

| t (s) | On screen | Notes |
|---|---|---|
| 0.0–0.4 | Hook enters: "Long chats? Compact, don't restart." | 5 words → 1.4s floor |
| 0.4–1.9 | Hook holds static (1.5s) | ≥1.4s ✓ |
| 1.9–2.3 | Crossfade to chat: thread + amber warn banner + composer; header chip "84% · 86K" amber | establish; banner text is already on screen and stays put |
| 2.3–3.4 | Cursor glides toward "Compact conversation"; UI otherwise still (banner gets its read time here) | approach ~1.1s |
| 3.4–3.65 | Click → button swaps to spinner + "Summarizing conversation…" | the one action |
| 3.65–5.2 | Progress state holds (~1.55s), spinner rotating; everything else still | working beat |
| 5.2–5.7 | Resolution cluster: divider fades/slides into the thread; banner fades out; chip animates 84%→8%, amber→gray | one state-change cluster |
| 5.7–6.5 | New state holds completely still (800ms) | breath after change ✓ |
| 6.5–6.9 | Payoff enters: "One click. History summarized, nothing deleted." | 7 words → 1.4s floor |
| 6.9–8.7 | Payoff holds static (1.8s) | generous ✓ |
| 8.7–9.4 | Fully still resting frame (700ms) | loop rest ✓ |

## Code snippet decision

**Yes — REST (curl).** Real route from `src/exulu/routes.ts`
(`registerAgentCompactRoute("/agents/litellm/compact")` → `app.post(slug + "/:instance")`);
headers match the run route; body `{ steer }`; response shape from `compactSession`.

Label: "Compact any session over REST"

```bash
curl -X POST "$BACKEND/agents/litellm/compact/$AGENT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Session: $SESSION_ID" -H "User: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{"steer": "keep the exact figures from the service reports"}'
# → { "checkpoint": { …UIMessage with metadata.compaction… },
#     "occupancyEstimate": 8400, "originalTokens": 78031, "summaryTokens": 2210 }
```
