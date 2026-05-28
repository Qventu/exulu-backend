# Animation recipes per feature type

This is a planning aid for Step 2 of the release-page workflow — pick a recipe based on the feature's surface area, then hand it to the hyperframes skill as a brief. The actual GSAP, easing, and timeline work lives in hyperframes; here we just sketch the demo arc.

## Universal scene structure (4–10s, one slice per short)

**Hard duration rule: minimum 4s, maximum 10s.** Most demos with hook + action + payoff land in **7–9s**. Use 4–5s only when the slice is a single state change with no user action and no hook line (rare). Over 10s is a tutorial, not a release short.

**One slice per short.** Each video covers exactly one part of one feature. If the spec has multiple notable parts (a UI toggle *and* a new SDK call *and* a webhook payload), make multiple shorts. Cramming them together is the single most common way these go bad — viewer can't tell what the feature is because the video is busy proving three things at once.

### Read times — non-negotiable minimums

**The single most common failure on first attempt is captions that don't sit on screen long enough to actually be read.** Entrance animation is not read time; the count starts after the text settles. Use these floors:

| Text length | Static hold *after* entrance, *before* exit |
|---|---|
| 1–3 words (≤ ~20 chars) | **≥ 1.0s** |
| 4–7 words (~20–50 chars) | **≥ 1.4s** |
| 8+ words / a full sentence | **≥ 1.8s** |

These are floors, not targets. If the budget allows, add another 0.3–0.5s. Viewers need processing time, not just decoding time — they're also tracking the surrounding motion.

### Breath after action

**After a user-visible action lands (click, state change, text-typing completes), hold the resulting state still for at least 600ms before introducing any new caption, title, or layout change.** Without this beat, the viewer hasn't had time to register what just happened before something new pulls focus.

This rule routinely catches the bug where a payoff caption appears *during* or *immediately after* the demo's final action — the caption looks like part of the action and gets ignored.

### The three beats

| Beat | Typical share | Job |
|---|---|---|
| **Hook** | ~1.5–2.0s | Feature name + the benefit phrase for *this slice*. Entrance (~400ms) then **≥ 1.0s static hold** per the read-time table. Don't start exiting before the static hold completes. |
| **Demo** | ~3–5s | Show the one thing. Move with intent — every animation answers "what just happened?" Insert a 600ms breath after each user action. |
| **Payoff** | ~1.8–2.5s | A single metric, quote, or "Now you can…" line. Enter **only after** the demo has fully resolved AND been held for ≥ 600ms. Hold per read-time floors. The last ~600ms of the payoff is the loop's resting frame — completely still. |

If your beat list contains **more than one user action** (e.g. click → … → click), you're probably packing two slices into one. Split — that's another short, not a longer one. Showing a full record-stop-transcribe loop in 7s puts everything on top of everything; show "click to record" in one short and "click to stop, see transcript" in another if both moments matter.

### Worked example — 8s feature demo with proper breath

| t (s) | What's on screen | Why |
|---|---|---|
| 0.0 – 0.4 | Hook fades in | Entrance |
| 0.4 – 1.6 | Hook holds still (**1.2s**) | Read-time floor for a 4-word phrase |
| 1.6 – 2.0 | Hook fades out, UI surface fades in (crossfade) | Pivot |
| 2.0 – 2.8 | Cursor glides to the affordance | Approach |
| 2.8 – 3.1 | Click → state change happens | The moment |
| 3.1 – 3.8 | **Hold the new state still (700ms)** | Breath after action |
| 3.8 – 4.3 | Mid-demo caption fades in ("Listening…", "Saved.", etc.) | Optional ambient label |
| 4.3 – 5.5 | Caption holds (**1.2s**) | Read-time floor |
| 5.5 – 5.9 | Caption fades out | Clear stage |
| 5.9 – 6.5 | **Hold (600ms) before payoff** | Breath before payoff |
| 6.5 – 6.9 | Payoff caption fades in | Entrance |
| 6.9 – 8.0 | Payoff holds **still** (**1.1s**, of which the last ~600ms is the resting frame) | Read-time floor + loop rest |

Total: 8.0s. Three captions, each with a proper read window. Two distinct breaths around the action. Loop rests on a still frame.

**Common bug this prevents:** packing the payoff caption into the last 800ms of the timeline so it appears, gets glanced at, and the loop restarts — viewer reads it on attempt 2 or 3 at the earliest. By the time it's legible, the hook has already played again and they've lost the through-line.

## Recipes by feature type

### A. UI feature — "we added a button / panel / surface"

Reconstruct the actual screen. The user should see "oh, that's literally my app." Cheap-looking screen mocks erode trust.

**Beats:**
1. Establishing shot of the surrounding UI in its current state. Brief — 0.5s.
2. The new affordance appears (fades or scales in with the existing UI clearly visible around it).
3. A pointer / cursor moves to it and triggers it.
4. The reactive change happens (panel opens, audio plays, toast shows).
5. Hold the final state for the payoff line.

**Brief for hyperframes:**
- Class names and hex codes from the actual frontend component (grep `frontend/components` or `frontend/app` for the spec's keywords first)
- A simulated cursor (1080×1920 vertical: use a slightly larger cursor so it reads on mobile)
- Timing that respects the real interaction's rhythm — don't compress a 600ms transition into 100ms

**Example — speech-to-text:**
> Establish the chat input. Mic icon fades into the input row. Cursor clicks it. A waveform pulses for 1.5s. Text appears in the input letter-by-letter. Send button highlights. Cut to the assistant reply forming.

### B. SDK or REST API feature — "you can now call X"

Code is the demo. Show the call being typed/run, then the result.

**Beats:**
1. Editor or terminal opens (clean, dark theme, monospace).
2. The code types in — character-by-character or word-stream, fast.
3. A response appears below (JSON pretty-printed, or a returned object, or a `200 OK` row).
4. Highlight the one field that matters (the new capability) with a marker sweep or underline.
5. Payoff: "N lines" or "Y ms" or "one call away."

**Brief for hyperframes:**
- The exact snippet from `src/index.ts` (SDK) or `src/exulu/routes.ts` (REST). Don't paraphrase.
- Use the JetBrains Mono font (the product's mono) — pulls authenticity from the editor look.
- Syntax-highlight to a credible palette (use the actual brand primary for keywords / strings; the page lives in the brand world).

**Example — text-to-speech SDK:**
> Terminal cursor blinks. `await exulu.speech.create({ message, voice: "alloy" })` types in. Below it, a small audio waveform fades in and plays through. Cursor moves to `voice: "alloy"` and a marker sweep underlines it. Payoff text: "Any assistant message, now readable aloud."

### C. GraphQL feature — "new operation / new field"

Same general shape as the REST recipe, but the demo opens with a query and the response shows the new field highlighted.

**Beats:**
1. Query editor (or a code editor showing `queries.ts`).
2. Query types in, including the new operation or new field.
3. Response renders to the right or below — the new field pulses or gets a marker sweep.
4. Optional: cut to the rendered UI component that consumes this data, briefly.

**Brief:**
- Pull the operation name from `frontend/queries/queries.ts` — exact match.
- If the schema is generated, mention the relevant type from `backend/src/graphql` so the on-screen field name is right.

### D. Backend / infra / cost / billing feature — hard to show, easy to mistell

Don't try to show server internals. Show the **impact on the user**.

**Patterns that work:**
- **Before / after metric.** Two numbers, one large, animate from old → new. "API key rate limits: 60/min → 600/min."
- **A labeled diagram.** A box-and-arrow architecture sketch with one piece changing color or moving. Keep boxes few and labels readable.
- **A user-facing receipt.** If the feature is about billing labels or scoping, show a clean invoice / line item with the new label appearing.

**Avoid:** server cartoons (no anthropomorphized clouds, no dancing CPUs), terminal logs scrolling past too fast to read, vague "↑ performance" arrows without numbers.

**Example — vertex billing labels:**
> A clean invoice-style table fades in: project, model, tokens, cost. The "project" column is empty. A new column "project label" appears with a soft highlight. Values populate row by row, matching the brand accent color. Payoff: "Per-project cost attribution, on by default."

### E. Compliance / data feature — needs gravitas, not flash

GDPR export, retention controls, audit logs. The audience is reading because they have to comply with something, not because they're delighted.

**Beats:**
1. A request screen (clean, official-feeling — more whitespace, calmer motion curves).
2. A confirmation dialog with explicit copy.
3. A receipt or downloaded artifact (a zip icon, a JSON file, a "deleted" badge).
4. Payoff: a one-line policy claim with a docs link in the page copy below.

Use slower easing (`power2.out`, never `back.out`). No bouncy motion. The product feels trustworthy when the demo feels measured.

## Cross-cutting rules

- **One idea per second.** If two things move at once, the viewer reads neither. Stagger.
- **Cursor / pointer affordance.** When you're showing a click, render a cursor — without it, the change reads as magic and the user doesn't connect "I do X."
- **Hold the final state.** The last 1.5–2 seconds of a 9-second loop should be still. Loops where the last frame is mid-animation feel jittery on repeat.
- **No fake brand assets.** Don't invent fake user names ("Sarah from Acme"). Use neutral placeholders or anonymize ("user@example.com"). The page leads to a docs/CTA — credibility matters.
- **Two aspect ratios.** Build a 1920×1080 for the page-embedded version and a 1080×1920 for vertical social. Same content, re-laid-out — don't crop blindly, the type sizes need to scale.

## When in doubt

Drop the recipe and ask the hyperframes skill directly: "Build an 8-second composition that shows X happening. Brand: extracted from frontend (passed as design.md). Surface: [reconstructed CSS]. Output: 1920×1080 and 1080×1920." The hyperframes skill is the expert; this file is just to make sure the brief you send is good.
