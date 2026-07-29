# Email-Integration Client Tutorial (Docs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a client-facing "Turn emails into automated runs" tutorial on the IMP docs site, illustrated with four newly-authored animated mockups of the routines UI.

**Architecture:** Four hyperframes compositions (HTML + GSAP + the shared `kit/` CSS) under `mintlify-docs/mockups/compositions/`, each rendered via `npm run mockups <slug>` to `videos/<slug>.mp4` + `images/screens/<slug>.png`, embedded in a new `building/routines/email-integration.mdx` page added to the Building → Routines nav.

**Tech Stack:** Mintlify (MDX, `<Steps>`/`<Frame>`), hyperframes@0.7.42 + GSAP 3.14.2 + ffmpeg for rendering.

## Global Constraints

- All work is under `mintlify-docs/` in the backend repo (branch `develop`); docs-only, no app code. Stage only files this plan names (the tree holds unrelated uncommitted changes). Commit subjects start lowercase (commitlint).
- **Composition contract** (copy from the working `set-budget` / `routine-schedule` compositions): root `#root` is `1920×1080` with `data-composition-id="<slug>"` and `data-duration="<seconds>"`; scenes are `.clip` divs with `data-start`/`data-duration`/`data-track-index`; include GSAP CDN (`https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js`) and `<script src="kit/cursor.js"></script>`; register a PAUSED timeline as `window.__timelines["<slug>"] = gsap.timeline({ paused: true })`; drive the cursor with `impCursor(tl, { from:[x,y], to:[x,y], at, click, duration, show })` (returns a time for chaining). **Hold the final settled state ≥ 0.3 s** so the poster PNG is clean.
- Compositions must **faithfully recreate the current UI** using the shared `kit/` (`app-shell.css` gives `.imp-shell/.imp-sidebar/.imp-main/.imp-topbar/.imp-nav-item/.imp-btn`; `routine-schedule/index.html` is the routines-shell template incl. the section-nav rail and `.detail-section` blocks). Copy real labels verbatim (below).
- Each composition's `meta.json` is `{ "id": "<slug>", "name": "<Name>", "video": true }` so it renders an MP4.
- Video embeds use `<Frame caption="…"><video autoPlay muted loop playsInline src="/videos/<slug>.mp4" /></Frame>`.
- Facts to state correctly in the tutorial (from the shipped feature): the webhook URL is `POST {BACKEND}/webhooks/routine/{secret}`; the run receives `{email_from}`, `{email_subject}`, `{email_body}` and attachments are added to the run's session; accepted payloads are raw MIME, multipart form-data, or JSON; guards are allowed-senders allowlist, filter rules, optional HMAC signing secret, and rate limits; deep payload/HMAC detail lives in `administration/email-intake.mdx`; the trigger toggle label is **"Start this routine when an email arrives"**.

## Scaffolding a composition (used by Tasks 1-4)

From `mintlify-docs/`, to create composition `<slug>`:

```bash
mkdir -p mockups/compositions/<slug>
cp mockups/compositions/set-budget/package.json mockups/compositions/<slug>/package.json
cp mockups/compositions/set-budget/tokens.css   mockups/compositions/<slug>/tokens.css
cp mockups/compositions/set-budget/fonts.css    mockups/compositions/<slug>/fonts.css
cp -R mockups/compositions/set-budget/kit       mockups/compositions/<slug>/kit
cp -R mockups/compositions/set-budget/fonts     mockups/compositions/<slug>/fonts
# then edit package.json "name" → "<slug>", write meta.json + index.html
```

`package.json` after copy: set `"name": "<slug>"` (keep the hyperframes scripts verbatim).

Render + verify a single composition (needs `ffmpeg` on PATH; downloads hyperframes on first run):

```bash
npm run mockups <slug>
ls -la videos/<slug>.mp4 images/screens/<slug>.png
```

If `ffmpeg` is not installed the render **BLOCKS** — in that case commit the composition source (index.html/meta.json/package.json/tokens.css/fonts.css/kit/fonts) and report BLOCKED-on-ffmpeg; do not fake the mp4/png.

---

### Task 1: Composition `routine-email-create`

**Files:** Create `mockups/compositions/routine-email-create/` (scaffold above) with `meta.json` + `index.html`. Produces `videos/routine-email-create.mp4` + `images/screens/routine-email-create.png`.

**Interfaces — Produces:** the video/poster at the paths above (consumed by Task 5's MDX).

- [ ] **Step 1: Scaffold** — run the scaffold block with `<slug>=routine-email-create`; set `package.json` name.
- [ ] **Step 2: meta.json**

```json
{ "id": "routine-email-create", "name": "Create a routine", "video": true }
```

- [ ] **Step 3: Author `index.html`** — model the file on `mockups/compositions/set-budget/index.html` (scene structure + timeline/cursor) and `mockups/compositions/routine-schedule/index.html` (routines shell: sidebar with **Routines** active, topbar breadcrumb `Routines / Support triage`, section-nav rail `Basics · Access · Steps · Schedule · Runs · Queue · Danger zone`). Storyboard (duration ~7 s):
  - **hook clip** (0–1.9 s): eyebrow "ROUTINES" + headline "Start with a routine" (fade/slide in, mirror set-budget `#hook`).
  - **app clip** (1.9 s→end): the routines workbench on the **Basics** section. Cursor moves to the **Name** field and it fills to `Support triage` (reveal via a cover wipe like set-budget `#amount-cover`, or type-in). Then the section-nav cursor clicks **Steps**; show 3 step rows: `1 · Summarise the email`, `2 · Draft a reply`, `3 · Notify the owner`.
  - **settled hold** (≥0.3 s): rest on the Steps list.
- [ ] **Step 4: Render + verify** — `npm run mockups routine-email-create`; confirm the mp4 + poster exist and the poster's last frame shows the settled Steps list (open the PNG).
- [ ] **Step 5: Commit** — `git add mockups/compositions/routine-email-create videos/routine-email-create.mp4 images/screens/routine-email-create.png` then `git commit -m "docs(routines): add routine-email-create mockup"`.

---

### Task 2: Composition `routine-email-config` (the core screen)

**Files:** Create `mockups/compositions/routine-email-config/`. Produces `videos/routine-email-config.mp4` + `images/screens/routine-email-config.png`.

- [ ] **Step 1: Scaffold** — `<slug>=routine-email-config`.
- [ ] **Step 2: meta.json** — `{ "id": "routine-email-config", "name": "Configure the email trigger", "video": true }`
- [ ] **Step 3: Author `index.html`** — routines shell (as Task 1) with the **Triggers** area showing an **Email** tab active. Storyboard (~9 s), modelled on set-budget's cursor/toggle/reveal beats:
  - **hook** (0–1.9 s): eyebrow "EMAIL TRIGGER" + headline "One inbound address".
  - **app** (1.9 s→end): the Email trigger form. Beats:
    1. Cursor clicks the toggle labelled **"Start this routine when an email arrives"** → it switches ON (slide the knob + accent fill).
    2. A **webhook URL** row appears (reveal): monospace `POST {BACKEND}/webhooks/routine/••••••••` with a **Copy** button; cursor clicks **Copy** → button flashes and a "Copied" tick shows.
    3. Reveal the guard controls below: an **Allowed senders** chip row (`*@acme.com`), one **Filter** row (`Subject contains "invoice"`), and a **Generate signing secret** button.
  - **settled hold** (≥0.3 s): rest on the configured trigger form.
- [ ] **Step 4: Render + verify** — `npm run mockups routine-email-config`; confirm assets + poster shows the configured form.
- [ ] **Step 5: Commit** — stage the composition dir + its mp4 + png; `git commit -m "docs(routines): add routine-email-config mockup"`.

---

### Task 3: Composition `routine-email-send`

**Files:** Create `mockups/compositions/routine-email-send/`. Produces `videos/routine-email-send.mp4` + `images/screens/routine-email-send.png`.

- [ ] **Step 1: Scaffold** — `<slug>=routine-email-send`.
- [ ] **Step 2: meta.json** — `{ "id": "routine-email-send", "name": "Point your email at the webhook", "video": true }`
- [ ] **Step 3: Author `index.html`** — a centred "connect" scene (no full app shell needed; use `--surface-2` bg like other hooks). Storyboard (~7 s):
  - **hook** (0–1.5 s): eyebrow "CONNECT" + headline "Send a test delivery".
  - **stage** (1.5 s→end): top card shows the webhook URL `POST {BACKEND}/webhooks/routine/8f3c…`; below it a terminal card (mono, dark `--surface`) that types a `curl` command:
    ```
    curl -X POST "$BACKEND/webhooks/routine/8f3c…" \
      -H "Content-Type: application/json" \
      -d '{"from":"a@acme.com","subject":"Invoice 8842","body":"See attached."}'
    ```
    then a response line appears: `HTTP/1.1 202 Accepted` (fade/slide in) with a small "queued a run" note.
  - **settled hold** (≥0.3 s): rest on the 202 response.
- [ ] **Step 4: Render + verify** — `npm run mockups routine-email-send`; confirm assets.
- [ ] **Step 5: Commit** — stage the dir + mp4 + png; `git commit -m "docs(routines): add routine-email-send mockup"`.

---

### Task 4: Composition `routine-email-run`

**Files:** Create `mockups/compositions/routine-email-run/`. Produces `videos/routine-email-run.mp4` + `images/screens/routine-email-run.png`.

- [ ] **Step 1: Scaffold** — `<slug>=routine-email-run`.
- [ ] **Step 2: meta.json** — `{ "id": "routine-email-run", "name": "Watch it run", "video": true }`
- [ ] **Step 3: Author `index.html`** — routines shell on the **Runs** section (use the `data-table.css` kit for the rows). Storyboard (~8 s):
  - **hook** (0–1.5 s): eyebrow "RUNS" + headline "Every email, a run".
  - **app** (1.5 s→end): the Runs list. Beats:
    1. A new run row slides in at the top: status dot + `Completed` badge + `email` trigger chip + subject `Invoice 8842` + `2s` duration + the token/cost cells **`↑1.2k ↓340  $0.004`** (mirror the shipped `runs-list.tsx` row order: status · state · trigger · subject · time · duration · tokens · cost).
    2. Cursor clicks the row → an **Open session** affordance, then a mini transcript panel appears with a user line and a **tool-approval card** ("Run Internet Search? — Allow once / Allow for this chat / Deny").
  - **settled hold** (≥0.3 s): rest on the open session with the approval card.
- [ ] **Step 4: Render + verify** — `npm run mockups routine-email-run`; confirm assets.
- [ ] **Step 5: Commit** — stage the dir + mp4 + png; `git commit -m "docs(routines): add routine-email-run mockup"`.

---

### Task 5: Tutorial page + navigation

**Files:**
- Create: `building/routines/email-integration.mdx`
- Modify: `docs.json` (Building → Routines `pages` array)

**Interfaces — Consumes:** the four `videos/*.mp4` from Tasks 1-4.

- [ ] **Step 1: Write `building/routines/email-integration.mdx`** with exactly this content:

````mdx
---
title: "Turn emails into automated runs"
description: "Connect an inbox to a routine so every matching email automatically starts a run — create the routine, wire up the webhook, lock it down, and watch it work."
icon: "mail-plus"
---

import { RightsCallout } from "/snippets/rights-callout.mdx";

<RightsCallout right="workflows (write)" />

Give a routine its own secret webhook URL, point an inbox at it, and every
matching email automatically starts a run. This tutorial walks the whole path
end to end. For field-by-field reference, see
[Email triggers](/building/routines/email-triggers); for payload formats and
HMAC signing, see [Email intake](/administration/email-intake).

**Before you start**
- A routine you can edit (this guide creates one), with the `workflows (write)` right.
- An email source you can add a forwarding rule or webhook to (your mail
  provider, a mail-to-webhook bridge, or any HTTP client).

<Steps>
  <Step title="Create a routine">
    Build the routine that should run for each email. Give it a name and the
    steps to perform — the incoming email arrives as the variables
    `{email_from}`, `{email_subject}` and `{email_body}`, and any attachments are
    added to the run's session so a step can read them.

    <Frame caption="Create a routine and give it the steps to run for each email.">
      <video autoPlay muted loop playsInline src="/videos/routine-email-create.mp4" />
    </Frame>
  </Step>

  <Step title="Enable the email trigger and copy the webhook URL">
    Open the routine's **Triggers → Email** section and turn on
    **Start this routine when an email arrives**. IMP generates a per-trigger
    secret webhook URL:

    ```
    POST {BACKEND}/webhooks/routine/{secret}
    ```

    Copy it — you'll point your inbox at it next. The trigger must stay enabled
    for deliveries to start runs.

    <Frame caption="Toggle the email trigger on, then copy the generated webhook URL.">
      <video autoPlay muted loop playsInline src="/videos/routine-email-config.mp4" />
    </Frame>
  </Step>

  <Step title="Point your email at the webhook">
    Send matching mail to the webhook URL using whatever your provider supports —
    a forwarding rule, a mail-to-webhook bridge, or a direct HTTP call. IMP
    accepts raw MIME, `multipart/form-data`, or JSON. A quick test with `curl`:

    ```bash
    curl -X POST "$BACKEND/webhooks/routine/{secret}" \
      -H "Content-Type: application/json" \
      -d '{"from":"a@acme.com","subject":"Invoice 8842","body":"See attached."}'
    ```

    An accepted delivery returns `202` and queues a run. See
    [Email intake](/administration/email-intake) for the full payload formats and
    HMAC signature details.

    <Frame caption="Point any inbox or HTTP client at the webhook URL to start a run.">
      <video autoPlay muted loop playsInline src="/videos/routine-email-send.mp4" />
    </Frame>
  </Step>

  <Step title="Lock it down">
    Before going live, tighten the guard chain in the same Email trigger section:

    - **Allowed senders** — an allowlist (exact addresses or `*@domain`); mail
      from anyone else is filtered out.
    - **Filter rules** — only start runs for mail matching your patterns (for
      example, subject contains `invoice`).
    - **Signing secret** — generate an HMAC secret and have your sender sign
      deliveries so only authentic requests are accepted.
    - **Rate limits** — per-trigger and per-sender hourly caps protect the
      routine from floods.

    <Warning>
      A run only starts when the trigger is **enabled**, the sender is
      **allowlisted**, and the mail passes your **filters**. Deliveries that fail
      a guard are recorded as `filtered` runs so you can see what was dropped.
    </Warning>
  </Step>

  <Step title="Watch it run">
    Each accepted email appears in the routine's **Runs** list with its trigger,
    subject, duration, and token/cost. Open a run's session to read the
    transcript — and to answer any tool approvals the agent pauses on.

    <Frame caption="Runs appear with tokens and cost; open a session to review it or answer approvals.">
      <video autoPlay muted loop playsInline src="/videos/routine-email-run.mp4" />
    </Frame>
  </Step>
</Steps>

## Troubleshooting

- **No run appears** — confirm the trigger is enabled and the sender is on the
  allowlist; check the Runs list for a `filtered` entry explaining the drop.
- **Signature rejected** — the HMAC secret on your sender must match the one
  generated here; regenerating the secret invalidates the old one.
- **Attachments missing** — send them as parts of the delivery (MIME or
  `multipart/form-data`); they're attached to the run's session.

## Next steps

- [Email triggers](/building/routines/email-triggers) — the full trigger reference.
- [Email intake](/administration/email-intake) — payload formats and HMAC signing.
- [Runs & schedules](/building/routines/runs-and-schedules) — managing and re-running runs.
````

- [ ] **Step 2: Add the nav entry** — in `docs.json`, in the Building → Routines group's `pages` array, insert `"building/routines/email-integration"` immediately after `"building/routines/email-triggers"`.
- [ ] **Step 3: Verify** — from `mintlify-docs/`, run the docs build/preview the repo uses (`npx mint dev` or the project's lint/build script) and confirm: the page renders, the four videos resolve (no broken `/videos/*.mp4`), `<Steps>` render, and the nav shows the new entry under Routines. If `mint` isn't available locally, at minimum confirm the four referenced `videos/*.mp4` files exist on disk and the JSON in `docs.json` is valid (`node -e "JSON.parse(require('fs').readFileSync('docs.json'))"`).
- [ ] **Step 4: Commit** — `git add building/routines/email-integration.mdx docs.json` then `git commit -m "docs(routines): add email-integration client tutorial"`.

---

## Self-Review

- **Spec coverage:** 4 compositions with `meta.video:true` rendered to `videos/`+`images/screens/` (Tasks 1-4) ✓; tutorial page with the 6-part `<Steps>` outline embedding the four videos (Task 5) ✓; nav entry after `email-triggers` (Task 5) ✓; cross-links to `email-triggers` + `email-intake` ✓; ffmpeg-missing contingency documented (scaffold section) ✓; faithful-UI + exact-label constraints in Global Constraints ✓.
- **Slug consistency:** `routine-email-create`, `routine-email-config`, `routine-email-send`, `routine-email-run` are used identically in each composition's `meta.id`, the render command, the produced asset paths, and the MDX `<video src>` — matched across Tasks 1-5.
- **No placeholders:** the MDX page is given in full; composition tasks give concrete storyboards, exact labels/copy, the template files to model, and a render+verify gate (bespoke animation HTML is the implementer's authored deliverable, guided by those templates).
