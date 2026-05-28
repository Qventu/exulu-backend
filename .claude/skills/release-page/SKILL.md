---
name: release-page
description: Build a release announcement page for the Exulu platform — a scrollable HTML page with embedded animated feature demos, plus standalone short videos for social sharing. Use whenever the user asks to "build a release page", "make a launch page", "create a changelog page", "write a release announcement", "announce these features", or wants any kind of marketing-style page summarizing newly shipped features from `docs/superpowers/specs`. Also use when the user references one or more design specs from that folder and asks to "show them off", "demo them", "make a video about them", or "package them for launch", even when they don't use the word "release". The skill orchestrates feature selection, code research, video generation via the hyperframes skill, and final page assembly. Pulls real brand colors and fonts from the Exulu frontend so the output matches the product.
---

# Release Page

Build a public-facing release announcement for the Exulu platform from internal feature specs. The output is twofold:

1. **One HTML release page** — scrollable, animated, embeds rendered feature demo videos inline.
2. **One standalone MP4 per featured feature** — for posting to social, Slack, customer emails.

You orchestrate. The actual video work happens inside the [hyperframes](../hyperframes/SKILL.md) skill — invoke it explicitly when building compositions. Don't reimplement hyperframes patterns here.

## Why this skill exists

Every shipped feature has a design spec in `docs/superpowers/specs/`. When the team cuts a release, someone (usually you) has to translate a stack of dense design docs into a tight, exciting page that lands the value for users. Doing this from scratch every time loses tone, drifts off-brand, and skips the embedded demos that make a release land. This skill captures the recipe.

## The five inputs you have

You can read all of these — use them aggressively, don't guess:

| What | Where | Use it for |
|---|---|---|
| Feature specs | `docs/superpowers/specs/*.md` | The source of truth for what shipped, the problem, the decisions, and the surface area |
| Frontend code | `/Users/daniel.claessen/Desktop/Projects/exulu/frontend` | Reconstruct UI screens exactly — components, tailwind classes, layouts |
| Brand tokens | `frontend/tailwind.config.js`, `frontend/app/globals.css` | Colors, fonts, radius, shadow — extract fresh every run |
| SDK | `backend/src/index.ts` | TypeScript code snippets users can copy-paste |
| REST API | `backend/src/exulu/routes.ts` | `curl` snippets — copy actual route paths and shapes |
| GraphQL examples | `frontend/queries/queries.ts` (callers) + `backend/src/graphql` (schema) | GraphQL snippets — use the operation names actually used by the frontend |

## Workflow

### Step 1 — Show specs, ask which to include

List the spec folder, then read just the first ~30 lines of each file to grab the title and one-line goal. Present a numbered menu like:

```
Specs available in docs/superpowers/specs:
  1. 2026-05-26 — gdpr-data-export-and-deletion: export and erase user data on request
  2. 2026-05-25 — text-to-speech: read assistant messages aloud
  3. 2026-05-24 — speech-to-text-transcription: speak instead of typing
  ...
```

Then ask: **"Which features should this release page cover? (numbers, names, or 'all')"**

Don't pick for them. Even when the user says something like "do the recent ones", show the list and confirm — release scope is a product call, not yours.

### Step 2 — Build a feature plan (one short doc per feature)

For each selected spec, do this work upfront so the later video-building goes fast:

1. Read the full spec.
2. Identify the **surface area** — this drives the demo:
   - **UI feature** → reconstruct the actual screen (locate the components in `frontend/components` or `frontend/app`)
   - **Backend / API feature** → demo the call (find the route in `backend/src/exulu/routes.ts` or the SDK method in `backend/src/index.ts`)
   - **Infra / cost / billing feature** → harder to visualize; lean on a before/after metric or a labeled diagram
3. Capture a **hook** — one sentence of benefit-language. Not "we added X" but "Y is now N× faster" or "Z works without leaving the chat."
4. Identify whether a **code snippet** earns its place (see [Code snippets](#code-snippets) below). Skip code for pure-UI changes.
5. Sketch the **demo arc** — what the 8–12 second video shows. Read [references/animation-recipes.md](references/animation-recipes.md) for patterns.

Write this as a short plan per feature — markdown is fine, kept in your working directory under `releases/<date-or-name>/plan/`. Confirm the plan with the user before generating videos. Generating shorts is the slow part of this workflow; aligning on the demo idea cheaply up front saves a lot of regenerating later.

### Step 3 — Derive brand from the live frontend

Open `frontend/tailwind.config.js` and `frontend/app/globals.css` and pull the current values for:

- `--primary`, `--background`, `--foreground`, `--accent`, `--muted`, `--border`, `--card`
- `--font-sans`, `--font-mono`, `--font-serif`
- `--radius`, `--tracking-normal`

Convert the HSL values to hex (HyperFrames is happy with hex in `design.md`). Write a `design.md` in your hyperframes project root with these tokens — this is how HyperFrames will pick up the actual product look instead of inventing a palette.

**Always re-extract every run.** These tokens drift; don't trust a cached version.

### Step 4 — Scaffold a hyperframes project

Inside `releases/<date-or-name>/hyperframes/`:

```bash
npx hyperframes init
```

Drop the `design.md` from Step 3 into the project. Plan one sub-composition per feature, plus an optional hero/title composition at the top.

### Step 5 — Build the per-feature shorts (invoke hyperframes skill)

For each feature, hand off to the hyperframes skill with a brief built from the plan you wrote in Step 2:

- The hook line
- The demo arc (what user journey to show)
- Concrete CSS / layout cues pulled from the real frontend components — class names, hex codes, spacing. Don't paraphrase the UI; reconstruct it.
- Aspect ratio: **1920×1080 for the page-embedded version, 1080×1920 for the social-share version.** Either build both (cleanest, two compositions), or build one and crop in render.
- **Duration: 4–10 seconds. Hard cap at 10.** Most demos with a hook + an action + a payoff land in **7–9s**, not 4–6. The shorter end is for single-state-change slices without a hook line — rare.
- **One slice per short.** Each video shows exactly one part of a feature — the most demo-worthy moment. If a spec has several notable parts (e.g. a UI toggle *and* a new SDK method *and* a webhook), build one short per part rather than cramming them together. Multiple shorts per feature is fine; one short trying to cover three things is not.
- **Pacing rules — read [references/animation-recipes.md](references/animation-recipes.md#read-times--non-negotiable-minimums) before writing the brief.** The two failure modes that ruin a first-attempt video:
  - **Captions don't sit long enough.** Static hold *after* entrance must be ≥ 1.0s for a short phrase, ≥ 1.4s for a sentence fragment, ≥ 1.8s for a full sentence. Entrance time does not count as read time.
  - **No breath after action.** After a click / state change / type-in completes, hold the resulting state still for **≥ 600ms** before introducing any new caption, title, or layout change. Otherwise the payoff caption lands on top of the action moment and gets ignored.
- **More than one user action in your beat list = split the slice.** A click + click + transcribe loop in 7s won't have room for proper read times. Cover one moment well.

The hyperframes skill will handle motion, easing, timeline structure, and house style. Don't try to write GSAP from this skill — let it own that.

### Step 6 — Render the shorts

```bash
npx hyperframes render --composition <feature-id> --output ../shorts/<feature-slug>.mp4
```

Render both aspect ratios if you scoped both in Step 5. Land MP4s in `releases/<date-or-name>/shorts/`.

### Step 7 — Assemble the HTML release page

Build `releases/<date-or-name>/index.html`. Use [references/page-structure.md](references/page-structure.md) as the template. The page wraps the rendered MP4s with:

- A hero with the release date and tagline
- One section per feature: header → embedded video → 2–3 paragraphs → code snippet (if applicable)
- A footer with a docs link or CTA

The page itself is a static HTML doc — Tailwind via CDN is fine, or a single `<style>` block using the brand tokens. The MP4s are referenced from `./shorts/<slug>.mp4` and play with `autoplay loop muted playsinline`. Keep it one file so the user can open it directly in a browser without a server.

## Outputs (final tree)

```
releases/<YYYY-MM-DD-release-name>/
├── index.html             ← the release page (open in browser)
├── shorts/                ← standalone MP4s for sharing
│   ├── feature-1.mp4      ← 1920×1080 for embedding
│   ├── feature-1-vert.mp4 ← 1080×1920 for social (if built)
│   └── ...
├── hyperframes/           ← the source project, reproducible
│   ├── design.md
│   ├── index.html
│   └── compositions/
└── plan/                  ← per-feature plan docs from Step 2
```

## Code snippets

Snippets are the part developers screenshot. Worth getting right.

**Earn-the-spot rule.** Show code only when the feature has a developer-facing surface. A new SDK method, REST endpoint, GraphQL operation, or webhook payload — yes. A UI affordance, animation polish, or backend optimization — no.

**Don't invent.** Always pull the actual symbol, route, or operation name from source. If you can't find it in `src/index.ts`, `src/exulu/routes.ts`, or `frontend/queries/queries.ts`, that probably means the feature isn't developer-facing — drop the snippet.

**Choose the right language for the surface:**

| Feature surface | Snippet language | Source |
|---|---|---|
| SDK method | TypeScript | `backend/src/index.ts` — copy the actual method signature |
| REST endpoint | bash + curl | `backend/src/exulu/routes.ts` — copy the actual route, method, body shape |
| GraphQL | graphql | `frontend/queries/queries.ts` — copy the actual operation, not a paraphrase |
| Webhook / event payload | json | source of truth in the spec or backend |

**Length:** ≤ 12 lines. Strip imports unless they're load-bearing. Anchor with one short line above ("From the chat SDK:") so the reader knows what they're looking at.

## Brand discipline

The Exulu product is **light theme, vivid purple primary, Inter sans, JetBrains Mono code, subtle shadows, small radius**. The release page must read like the product — not like a generic SaaS landing page or a dark-mode dev tool.

- Pull the exact HSL values from `globals.css` every run. Don't cache.
- If the user explicitly asks for a different mood ("make it dark", "go bolder"), follow it but warn that it'll feel disconnected from the product.

## What this skill is not

- Not a docs generator. The release page sells the feature; full docs live elsewhere.
- Not a roadmap. Only ship features that already have specs in `docs/superpowers/specs/`.
- Not a changelog dump. Don't list every commit. Curate.
- Not a video editor. Hand video work to the hyperframes skill — don't try to write GSAP here.

## Quick reference

| Reference | When to read |
|---|---|
| [references/page-structure.md](references/page-structure.md) | Writing `index.html` in Step 7 — has the actual HTML template |
| [references/animation-recipes.md](references/animation-recipes.md) | Planning the per-feature demo arc in Step 2 — patterns for UI / API / infra features |
| The `hyperframes` skill | Steps 4–6 — composition authoring, motion, brand, timing |
| The `hyperframes-cli` skill | When `npx hyperframes` commands misbehave |
