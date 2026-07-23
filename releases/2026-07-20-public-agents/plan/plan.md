# Public agents — release plan (2026-07-20)

Feature: share an agent with people outside your org. Three access modes
(public link / password / login with self-registration), anonymous chat with
browser-local transcripts, per-IP rate limits and message caps, all governed
from a guest-access section in the agent editor.

Research: ./research.md (exact strings, classes, REST shapes, limits — use it).

Hook: Your agent, outside your org — in 30 seconds.

## Shorts (1920×1080, 7–9s each, output to ../shorts/)

1. **enable-guest** (9s, hero) — agent editor, guest access section. Hook:
   "Share an agent with the outside world." Cursor flips "Enable guest access"
   switch → section expands: radio group with the three modes (use exact mode
   labels + descriptions from research.md, e.g. "Anyone with the link can
   chat. No sign-in.") and the budget recommendation line → the public
   /public/agents/{id} link row appears → copy click → "Copied" state.
   Payoff: "One switch. One link."

2. **guest-chat** (9s) — visitor side. Centered card "This agent is password
   protected" → password dots type in → "Checking…" → chat opens; guest types
   a question, reply streams. Payoff: "No account. No setup. Just a link."

3. **guarded-by-default** (8s, recipe D) — quick montage, calm pacing: toast
   "You're sending messages too quickly." over a blurred chat → three stat
   cards fade in sequence: "10 msg/min · 60/h per IP", "8k char cap per
   message", "Public projection: 8 fields — instructions, tools & model never
   leave the server". Payoff: "Safe by default." No cursor needed.

## Code snippets

REST (bash + curl), from research.md file:line refs — the public endpoints:
list public agents, get agent meta, verify password. ≤12 lines total, real
paths only.

## Page prose extras

- Login mode: real self-registration with OTP, custom per-agent cover image;
  external users get history + resumable sessions but are redirected out of
  the internal app.
- Anonymous transcripts live in the visitor's browser (last 50 messages),
  "Clear conversation" wipes them. Unpublishing takes effect on the next request.

## Build rules (apply to every short)

- Follow the hyperframes skill; register paused timeline on window.__timelines.
- Read-time floors: short phrase ≥1.0s static hold AFTER entrance; sentence
  ≥1.8s. Breath ≥600ms after any click/state change before new captions.
  Final 1.5–2s of each loop completely still.
- Render a cursor for every click. Product-faithful motion: power2.out,
  150–350ms, no bounce.
- UI reconstruction uses the exact strings/tailwind classes in research.md.
  Brand tokens: copy design.md from
  ../../2026-07-13-connect-your-agent/hyperframes/connect-modal/design.md.
- House caption style: mimic the hook/payoff caption cards of
  ../../2026-07-13-connect-your-agent/hyperframes/list-skills/index.html.
