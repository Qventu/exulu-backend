# Short plan — The honest context meter (marquee)

## Sources of truth

- Spec: `docs/superpowers/specs/2026-07-07-context-window-management-design.md` §5a (frontend meter), §1c (occupancy anchor+delta)
- UI: `frontend/app/(application)/chat/components/chat-header.tsx` (usage chip, frontend `8714e94`),
  `frontend/app/(application)/chat/components/usage-popover.tsx` (popover/dialog),
  `frontend/components/ai-elements/context.tsx` (ContextContentHeader / usage rows),
  `frontend/app/(application)/chat/lib/context-budget.ts` (occupancy math, `4987217`),
  `frontend/app/(application)/chat/hooks.ts` (controller context state, `d06c70e`)
- Strings: `frontend/messages/en.json` → `chat.usage.*`, `chat.header.*` (verbatim below)
- Brand: `releases/2026-07-08-context-management/hyperframes-design.md`

## What shipped

The chat header's usage chip used to sum per-turn usage across ALL messages — each turn's
`inputTokens` already contains the whole prior context, so the figure grew super-linearly
(the real "21M tokens" incident) and could exceed 100%. Now the chip shows **real context
occupancy**: the newest real usage number from the provider (or the latest compaction
checkpoint) plus a chars/4 estimate of everything after it, over the model's **usable
window** (`contextWindow − outputReserve`). The popover separates the two concepts:
a "Context window" section (occupancy / contextWindow with a progress bar) above the
relabeled "Session usage (cumulative)" breakdown. The ≥80% warning color keys off real
occupancy. Model overrides resolve their own window from the LiteLLM catalog
(`max_input_tokens ?? max_tokens`, selected in `app/(application)/chat/queries.ts`).

## Hook

**"Meet the honest context meter."** — context vs. cumulative usage, finally two separate
numbers; no more phantom 21M-token readings.

## Surface area

Pure UI (chat header chip + click-open popover). One user action: clicking the chip.

## Reconstruction cues (exact, from shipped code)

Header (`chat-header.tsx`): `<header class="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4">`.
Left→right: History ghost icon button (size-8, lucide `History` size-4) · agent avatar
circle size-6 · agent name `text-sm font-medium` (use "Atlas") · muted `/` · session title
`text-sm` (use "Quarterly report analysis") · **usage chip** · spacer · files chip
(lucide `FolderOpen` size-3 + "3 files") · ⋯ overflow button.

Usage chip (the CHIP recipe, verbatim):
`items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground`.
Content template: `{usagePct}% · {compactTokens}` → **"47% · 48.3K"**
(pct = occupancy/usableWindow; compact tokens = occupancy, `Intl notation:"compact"`).
Aria: `Context usage 47% — view details`.

Popover (`usage-popover.tsx`): `w-72 p-0`, `align="end"`, card #FCFCFC, border #E7E7EE,
radius 6px, `divide-y` sections:
1. Section `p-3 space-y-1`: label `text-xs font-medium text-muted-foreground` →
   **"Context window"** (`chat.usage.contextTitle`). Then `ContextContentHeader`:
   row `flex items-center justify-between text-xs` with **"37.7%"** left and
   **"48.3K / 128K"** right (`font-mono text-muted-foreground`) — NOTE: popover header is
   occupancy/contextWindow (37.7%), the chip is occupancy/usableWindow (47%); both are
   product-faithful. Below: a Progress bar (track `bg-muted` #F5F5F5, indicator #7033FF,
   height ~8px, rounded-full) at 37.7%.
2. Body `p-3 space-y-2`: label **"Session usage (cumulative)"** (`chat.usage.cumulativeTitle`),
   then rows `flex items-center justify-between text-xs`, label `text-muted-foreground`:
   **"Total tokens" 612K** (`chat.usage.total`) · **"Input" 540K** · **"Output" 58K** ·
   **"Reasoning" 8.6K** · **"Cache" 210K** (row labels hardcoded in
   `components/ai-elements/context.tsx`). Then explainer `text-xs text-muted-foreground`:
   **"Tokens are the units AI usage is measured in — roughly ¾ of a word each."**
   (`chat.usage.tokensExplainer`).

The 48K-in-window vs 612K-spent contrast IS the story — pick numbers that keep it stark.

## Demo arc — timed beats (1920×1080, 9.6s)

| t (s) | On screen | Notes |
|---|---|---|
| 0.0–0.4 | Hook enters: "Meet the honest context meter." | 5 words → 1.4s floor |
| 0.4–1.9 | Hook holds static (1.5s) | ≥1.4s ✓ |
| 1.9–2.3 | Crossfade to chat header strip (full 1920 width, chat thread dimly visible below) | establish |
| 2.3–3.1 | Cursor glides to the "47% · 48.3K" chip | approach |
| 3.1–3.35 | Click → popover opens (200ms scale 0.98→1 + fade, power2.out) | the one action |
| 3.35–4.1 | Popover holds completely still (750ms) | breath after action ✓ |
| 4.1–4.5 | Soft highlight sweep across "Context window" section, then "Session usage (cumulative)" label; caption enters bottom-center: "Context vs. cumulative — two different numbers." | 6 words → 1.4s floor |
| 4.5–6.6 | Caption holds static (1.7s+); popover unchanged | ≥1.4s ✓ |
| 6.6–7.0 | Caption fades out | clear stage |
| 7.0–7.6 | Still frame (600ms) | breath before payoff ✓ |
| 7.6–8.0 | Payoff enters: "No more phantom 21M-token totals." | 5 words → 1.4s floor |
| 8.0–9.6 | Payoff holds static (1.6s); last 600ms fully still | resting frame ✓ |

## Code snippet decision

**No snippet.** Pure UI slice; the occupancy math is internal (no export in
`backend/src/index.ts`). The developer-facing error shape lives in the hard-limit
section (`hard-limit-block.md`).
