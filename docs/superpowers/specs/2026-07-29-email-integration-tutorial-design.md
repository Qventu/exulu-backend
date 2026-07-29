# "Turn Emails Into Automated Runs" — Client Tutorial (Docs) — Design

- **Date:** 2026-07-29
- **Status:** Approved (ready for implementation plan)
- **Repo:** `exulu/backend` → `mintlify-docs/` (the IMP docs site). Docs-only; no app code.

## Goal

A client-facing, task-oriented **tutorial** that walks a client end-to-end
through integrating their email with a routine: create a routine, enable its
email trigger, point their mail at the webhook, lock it down, and watch runs
fire. Illustrated with **animated screens** of the routines configuration UI,
produced through the repo's existing mockups pipeline.

## Context (existing infrastructure)

- Docs animations are authored as **hyperframes compositions** under
  `mockups/compositions/<slug>/` (self-contained `index.html` using GSAP +
  the shared `kit/` CSS + `tokens.css` + `fonts.css`, plus `meta.json` and a
  `package.json`). `routine-schedule` is a faithful static template for the
  routines shell; `set-budget` / `create-agent` are animated templates.
- Animation: a PAUSED GSAP timeline registered on `window.__timelines["<id>"]`,
  with a simulated cursor via `window.impCursor(tl, { from, to, at, click })`
  (kit/cursor.js). Convention: hold the final settled state ≥ 0.3 s (the render
  extracts the last frame as the poster PNG).
- Render: `npm run mockups` (`scripts/render-mockups.mjs`, needs `ffmpeg` +
  `npx hyperframes`) → poster `images/screens/<slug>.png` for every composition,
  and `videos/<slug>.mp4` only when `meta.json` has `"video": true`.
- Routines docs live in **Building → Routines** (`docs.json`), currently:
  `overview`, `email-triggers` (reference), `runs-and-schedules`.
- Reference material to cross-link (not duplicate): `building/routines/email-triggers.mdx`
  (the trigger reference) and `administration/email-intake.mdx` (payload formats
  + HMAC).

## Non-goals

- No changes to `email-triggers.mdx` / `email-intake.mdx` beyond adding
  cross-links to/from the new tutorial.
- No new mockups-kit primitives unless a screen genuinely needs one (reuse the
  existing kit).
- Not a reference page — this is a guided walkthrough; deep field-by-field
  reference stays in `email-triggers.mdx`.

## Design

### Page

- **File:** `building/routines/email-integration.mdx`
- **Title:** "Turn emails into automated runs" · **icon:** `mail-plus` (or
  `workflow`) · sits in the Building → Routines nav group **after**
  `email-triggers`.
- **Frontmatter + intro:** one-paragraph outcome ("every matching inbound email
  automatically starts a run"), a `<RightsCallout right="workflows (write)" />`,
  and a short prerequisites list (a saved routine; an email source you can add a
  forwarding rule / webhook to).
- **Body:** Mintlify `<Steps>`, each major step embedding its composition video
  via the repo's `<Frame>` + `<video>` embed pattern (mirroring an existing page
  that embeds `videos/*.mp4`).

### The 4 animated compositions

Each is a new `mockups/compositions/<slug>/` with `meta.json` `{"id","name","video":true}`,
a `package.json` (copied from a sibling composition), `tokens.css` + `fonts.css`
+ `kit/` (copied from a sibling), and an `index.html` that faithfully recreates
the relevant current UI and animates a short cursor-driven walkthrough ending in
a settled hold. Faithfulness is anchored to the real components (`email-tab.tsx`,
the triggers layout, `runs-list.tsx` incl. the new tokens/cost cells,
`routine-schedule` for the shell).

| # | Slug | Storyboard (motion → settled state) |
|---|------|-------------------------------------|
| 1 | `routine-email-create` | Routines workbench → Basics: cursor types a routine name ("Support triage"); Steps section shows 2–3 step rows. Settled on the saved routine. |
| 2 | `routine-email-config` | Triggers → **Email** tab: cursor toggles *"Start this routine when an email arrives"* ON → the webhook URL row appears → cursor clicks **Copy** (tick); then the allowed-senders chip, one filter row, and **Generate signing secret** are visible. Settled on the configured trigger. |
| 3 | `routine-email-send` | The copied webhook URL at top + a terminal card running a `curl -X POST …/webhooks/routine/{secret}` with a JSON body; a small "202 Accepted" result appears. Settled on the accepted response. |
| 4 | `routine-email-run` | The **Runs** list: a new `email` run row animates in (state → Completed, with `↑in ↓out $cost` cells); cursor opens the session → transcript + a tool-approval card. Settled on the open session. |

### Content outline (the `<Steps>`)

1. **What you'll build** + prerequisites (intro, above the Steps).
2. **Create a routine** — the steps that run per email; note the auto-provided
   variables `{email_from}`, `{email_subject}`, `{email_body}` and that
   attachments are added to the run session. [comp 1]
3. **Enable the email trigger & copy the webhook URL** —
   `POST {BACKEND}/webhooks/routine/{secret}`; enable the toggle before delivery
   starts. [comp 2]
4. **Point your email at the webhook** — forwarding rule / mail-to-webhook
   bridge / any HTTP client; accepted formats (raw MIME, multipart form-data,
   JSON) with a `curl` example; link to **Email intake** for full payload + HMAC
   detail. [comp 3]
5. **Lock it down** — allowed senders, filter rules, signing secret, rate
   limits (prose + `<Warning>`/`<Tip>` callouts, anchored to comp 2; deep detail
   links to the reference).
6. **Watch it run** — the Runs overview (tokens/cost per run) and opening the
   session to answer tool approvals. [comp 4]
7. **Troubleshooting & next steps** — common gotchas (trigger disabled, sender
   not allowlisted, filtered runs) + cross-links to `email-triggers` and
   `email-intake`.

### Navigation

Add `"building/routines/email-integration"` to the Building → Routines `pages`
array in `docs.json`, positioned after `"building/routines/email-triggers"`.

### Rendering

Run `npm run mockups` from `mintlify-docs/` to render all four compositions
(posters + MP4s). Requires `ffmpeg`. If `ffmpeg` is unavailable in the working
environment, commit the composition sources + the MDX with correct embed paths
and hand off the single render command; the page references
`videos/<slug>.mp4` + `images/screens/<slug>.png` which the render produces.

## Testing / verification

- `npm run mockups -- routine-email-config` (and the other three slugs) renders
  without error and produces the expected `videos/*.mp4` + `images/screens/*.png`.
- Mintlify build/preview renders the new page with working `<Steps>`, embedded
  videos, and no broken asset links; nav shows the new entry under Routines.
- Content review: steps are correct against the shipped behavior (webhook URL
  shape, auto-variables, allowlist/filter/signing, runs view), and cross-links
  resolve.

## Sequencing

1. Author the 4 compositions (each independently renderable) — scaffold from a
   sibling, recreate the UI, add the GSAP + cursor timeline, set `meta.video:true`.
2. Render them (`npm run mockups`).
3. Write `email-integration.mdx` embedding the four videos.
4. Add the `docs.json` nav entry; build/preview to verify.
