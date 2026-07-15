# Short plan — The hard stop (composer block + structured 413)

## Sources of truth

- Spec: `docs/superpowers/specs/2026-07-07-context-window-management-design.md` §3
  (budget gate) + §5b (blocked state)
- Backend: pre-flight gate in `src/exulu/provider.ts` (`contextOccupancy ≥ blockThreshold`
  → `ContextCompactionRequiredError`, `6b221ad`), structured 413 in `src/exulu/routes.ts`
  (`res.status(413).send(err.message)`), error class + provider-error pattern mapping in
  `src/exulu/context-budget.ts`
- UI: blocked branch of `frontend/app/(application)/chat/components/context-banner.tsx`
  + composer disable in `frontend/app/(application)/chat/components/composer.tsx`
  (`916854d`), `onError` code mapping + `serverContextBlocked` in
  `frontend/app/(application)/chat/hooks.ts`
- Strings: `frontend/messages/en.json` → `chat.context.*`
- Brand: `releases/2026-07-08-context-management/hyperframes-design.md`

## What shipped

At 95% of the usable window the composer **blocks**: the banner becomes non-dismissible
("Context limit reached"), the textarea disables with a swapped placeholder, and the send
button greys out. The backend independently enforces the same gate before every model
call — an oversized request is never sent to the provider; instead the run route returns a
**structured 413** whose body is JSON:
`{ code: "CONTEXT_COMPACTION_REQUIRED", message, occupancy, usableWindow, contextWindow }`.
Provider context-length errors that slip through mid-stream are pattern-matched
(`ContextWindowExceededError`, "maximum context length", "prompt is too long", …) and
mapped to the **same code**, so every overflow lands in the same recoverable UX instead of
a raw red alert.

## Hook

**"A hard stop before the model breaks."** — enforced in the composer AND on the server;
you'll never see a raw context error again.

## Surface area

UI state change (warn → blocked) with a real developer-facing error shape → JSON snippet
earned. Zero user actions: the state flips as streaming pushes occupancy over 95%.

## Reconstruction cues (exact, from shipped code)

Numbers: 128K window → usable 102,400; block at 97,280 (95%). Start at **"93% · 95K"**,
tick to **"96% · 98.5K"** as the assistant streams.

Start state: chat with warn banner (recipe in `steerable-compaction.md`; body text at 93%)
+ active composer (placeholder **"Ask me anything..."**), header chip amber `border-warning
text-warning`. An assistant message is streaming (subtle text growth).

Blocked state (the flip):
- Banner title → **"Context limit reached"**; body → **"This conversation no longer fits
  the model's context window. Compact it to continue."** (`chat.context.blockedTitle` /
  `blockedBody`); dismiss `X` disappears (non-dismissible); body text tone shifts
  `text-muted-foreground` → `text-foreground`; **"Compact conversation"** button stays.
- Composer textarea: `disabled:opacity-50 disabled:cursor-not-allowed`, placeholder swaps
  to **"Compact the conversation to continue…"** (`chat.context.placeholderBlocked`).
- Purple send button → disabled (opacity-50).
- Chip → "96% · 98.5K", still amber.

## Demo arc — timed beats (1920×1080, 9.4s, zero user actions)

| t (s) | On screen | Notes |
|---|---|---|
| 0.0–0.4 | Hook enters: "A hard stop before the model breaks." | 7 words → 1.4s floor |
| 0.4–1.9 | Hook holds static (1.5s) | ≥1.4s ✓ |
| 1.9–2.3 | Crossfade to chat: warn banner at 93%, live composer, chip "93% · 95K" amber | establish |
| 2.3–3.1 | Assistant reply streams a few words; chip ticks 93% → 96% | ambient motion, one idea |
| 3.1–3.5 | The flip: banner swaps to "Context limit reached…", composer greys with the new placeholder, send disables | the state change |
| 3.5–4.3 | Blocked state holds completely still (800ms) | breath after change ✓ |
| 4.3–4.7 | Callout enters near the composer: "Enforced client- and server-side" | 5 words → 1.4s floor |
| 4.7–6.2 | Callout holds static (1.5s) | ≥1.4s ✓ |
| 6.2–6.6 | Callout fades out | clear stage |
| 6.6–7.2 | Still frame (600ms) | breath before payoff ✓ |
| 7.2–7.6 | Payoff enters: "No more raw context errors. Ever." | 6 words → 1.4s floor |
| 7.6–9.4 | Payoff holds static (1.8s); last 600ms fully still | resting frame ✓ |

## Code snippet decision

**Yes — JSON (the structured 413).** Real shape from `ContextCompactionRequiredError`
(`src/exulu/context-budget.ts`); SDK/REST callers of the run route receive exactly this
body. Numbers consistent with a 128K window (usable 102,400).

Label: "What the run route returns instead of a provider crash"

```json
HTTP/1.1 413

{
  "code": "CONTEXT_COMPACTION_REQUIRED",
  "message": "This conversation no longer fits the model's context window (~99,862 of 102,400 usable tokens). Compact the conversation to continue.",
  "occupancy": 99862,
  "usableWindow": 102400,
  "contextWindow": 128000
}
```
