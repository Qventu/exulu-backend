# Usage & budgets — release plan (2026-07-22)

Three features, one theme: cost transparency moves out of the admin console.
A) Personal usage: Settings → Usage — your own model/day spend, chart + table,
   backed by GET /me/usage.
B) Project budget visibility: read-only budget indicator on the project
   detail header for every member.
C) Budget reset date: admins pick the day a budget resets (calendar picker,
   applied via LiteLLM /budget/update).

Research: ./research.md (exact strings, routes, response shapes — use it).

Hook: See what you spend. See what's left. Reset on your billing day.

## Shorts (1920×1080, 7–8s each, output to ../shorts/)

1. **personal-usage** (8s, hero) — Settings page, Usage section: range toggle
   "7 days / 30 days / 90 days" (exact labels) → cursor clicks 30 days →
   area chart draws left-to-right (green --chart-1, zero-filled days) →
   per-model table rows populate (Model / Requests / Tokens / Spend — exact
   columns). Payoff: "Your models, your days, your spend."

2. **project-budget** (7s) — project detail header: the compact budget face
   "NN% · Budget" with colored bar fades in → cursor hovers → popover with
   the real detail lines: "$X of $Y used", "… remaining · Monthly",
   "Projected ≈ … by reset", "Resets {date}" (exact strings from research.md).
   Payoff: "Members see budget health without asking an admin."

3. **reset-date** (7s) — admin budget editor: "Reset date" field → calendar
   picker opens → cursor picks the 1st of next month → field updates, save.
   Payoff: "Budgets reset on your billing day — not a rolling window."

## Code snippets

1. "REST" — curl GET /me/usage with trimmed real response shape
   ({ usage: { window, totals, daily, byModel } }) — from research.md.
2. "REST" — curl PUT /admin/budgets/... with budget_reset_at in the body.
Both ≤10 lines, real paths.

## Page prose extras

- Personal usage is gated by the same "Show budget status to users" toggle as
  the budget chip; 92-day clamp.
- Percent-mode budgets never leak dollar amounts to members.
- Reset dates snap to smart defaults per duration (next midnight / next
  Monday / 1st of month, UTC).
- All three require the LiteLLM proxy.

## Build rules (apply to every short)

- Follow the hyperframes skill; register paused timeline on window.__timelines.
- Read-time floors: short phrase ≥1.0s static hold AFTER entrance; sentence
  ≥1.8s. Breath ≥600ms after any click/state change before new captions.
  Final 1.5–2s of each loop completely still.
- Render a cursor for every click. Product-faithful motion: power2.out,
  150–350ms, no bounce. Chart draw ~900ms, power2.inOut.
- UI reconstruction uses the exact strings/tailwind classes in research.md.
  Brand tokens: copy design.md from
  ../../2026-07-13-connect-your-agent/hyperframes/connect-modal/design.md.
- House caption style: mimic
  ../../2026-07-13-connect-your-agent/hyperframes/list-skills/index.html.
