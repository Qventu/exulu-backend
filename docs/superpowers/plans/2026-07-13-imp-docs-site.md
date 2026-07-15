# IMP Documentation Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete client-facing Mintlify documentation site for IMP in `/Users/daniel.claessen/Desktop/Projects/exulu/exulu-docs`, replacing `backend/mintlify-docs`, per the approved spec `docs/superpowers/specs/2026-07-13-imp-docs-site-design.md`.

**Architecture:** One Mintlify project with 8 audience tabs. UI docs are illustrated by a HyperFrames mockup workspace (`mockups/`) that renders scoped-CSS product replicas to committed PNGs/MP4s. Developer/API reference is grounded in generated artifacts (`schema.graphql` emitted from backend `createSDL()`, authored OpenAPI spec). All generated content is committed; scripts are refresh tools.

**Tech Stack:** Mintlify (`mint` CLI, docs.json, MDX), HyperFrames 0.7.42 + GSAP (mockups/animations), Node ≥ 20 for docs scripts, `tsx` + backend repo for SDL emission, `graphql` npm package for SDL validation.

## Global Constraints

Copied from the spec — every task implicitly includes these:

- **Product name is "IMP"** in all copy. Exulu appears only as the company (footer). Never "Exulu IMP" in running text. Site name: "IMP Docs".
- **Confidentiality:** the strings `newlkiag`, `newlift`, `Newton`, `Zendesk` (as a client integration), and any client name NEVER appear in any file. Recipes use generic names ("a ticketing system", "a document archive").
- **No violet/purple anywhere** in docs chrome or mockups: forbidden hexes `#7033FF`, `#8B5CF6`, `#A78BFA`, `#7C3AED`, `#9061FF`, `#B192FF` (case-insensitive).
- **Docs chrome CI:** light bg bone `#f8f6f1`, dark bg ink `#222f30`/void `#1b1714`, primary olive `#6f9a37` (light) / lime `#cef79e` (dark), hairlines `#e4ddd0`/`#4d5757`, `border-radius: 0`, no shadows, fonts Aspekta (`inter-tight-400/500.woff2`) + RobotoMono (`roboto-mono-400.woff2`).
- **Mockup CI (product replicas):** warm surfaces `#f8f6f1`/`#fbfaf7`/`#efece4`, hairline `#e4ddd0`, text ramp `#241f1a`/`#55504a`/`#6b6560`/`#9b948d`, accent `#6f9a37` (olive) / `#8fbf4d` / `#cef79e` (lime chip), ink buttons `#222f30`, radius 0, fonts Aspekta/RobotoMono. This is the release-pipeline reskin palette (`releases/_build/reskin-videos-prep.mjs` HEX_MAP), NOT `frontend/app/globals.css` (which still carries the old purple default theme — do not extract from it).
- **UI terminology canon (exact nav labels):** Agents · Knowledge (route `/data`; entities "contexts", "items") · Prompts · Skills · Routines (route `/workflows`) · Automation (n8n) · Feedback · Evals / Test cases · Transcripts (route `/transcriptions`) · Variables · Theme (route `/configuration`) · Users & access (tabs Users · Roles · Teams) · Models · Budgets · Analytics · Projects · Chat.
- **Writing rules:** Diátaxis (how-to / concept / reference, never mixed on one page); second person; sentence-case headings; Mintlify components over markdown walls; no marketing language; every code block has a language tag; every image has alt text; internal links root-relative without extension.
- **Every UI page** starts with the `RightsCallout` snippet stating required rights/config flags.
- **Verification gates:** `mint validate` and `mint broken-links` must pass at the end of every task that touches MDX or docs.json. Mockup compositions must pass `npm run check` (hyperframes lint + validate + inspect).
- **Source-of-truth rule:** UI claims trace to `frontend/` components or `frontend/messages/en.json`; env vars to actual `process.env` reads in `backend/src`; class docs to `backend/src` class sources; GraphQL to the emitted `schema.graphql`. Fix known drift, never copy it (README's `DATABASE_URL` is wrong — real vars are `POSTGRES_DB_HOST/PORT/USER/PASSWORD/SSL/NAME`; SMTP vars per code are `SMTP_USER`/`SMTP_FROM`/`SMTP_SECURE`).
- Backend repo referenced from the docs repo as sibling path `../backend`; reference implementation at `/Users/daniel.claessen/Desktop/Projects/newlkiag` (read-only, for pattern abstraction).
- Node pin fact for docs content: the backend requires **exactly Node 22.18.0** (preinstall check).
- Commit after every task with conventional-commit messages; end commit messages with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure (target)

```
exulu-docs/
├── docs.json                    # site config — single source of navigation
├── styles.css                   # website-CI chrome overrides
├── AGENTS.md                    # maintenance conventions
├── .mintignore                  # excludes mockups/, scripts/, node_modules
├── .gitignore
├── package.json                 # devDeps: graphql; scripts: tokens/render/sdl/changelog
├── index.mdx                    # landing page
├── get-started/                 # concepts, editions, role router
├── user-guide/
│   ├── chat/ …                  # 12 pages
│   ├── projects/ … transcripts/ … settings.mdx
├── building/
│   ├── agents/ … knowledge/ … prompts/ … skills/ … routines/ … evals/ …
│   ├── automation.mdx  feedback.mdx
├── administration/              # users-access/, models, budgets, analytics, variables, theme, api-keys
├── self-hosting/                # architecture, requirements, quickstart, services/, containers, env-reference, database, operations, troubleshooting
├── developers/
│   ├── setup.mdx  getting-started.mdx
│   ├── core/<class>/{introduction,configuration,api-reference}.mdx   # 8 triples
│   ├── reference/<name>.mdx     # 13 single-page refs + functions-and-types.mdx
│   ├── tutorials/ …  recipes/ …
├── api-reference/
│   ├── graphql/                 # introduction, conventions, dynamic-types, vector-search, schema.graphql, core-types/
│   ├── rest/                    # OpenAPI-driven + gateway pages
├── changelog/index.mdx          # generated <Update> entries
├── snippets/                    # rights-callout.mdx, edition-badge.mdx
├── images/  videos/  fonts/  logo/
├── openapi/openapi.json
├── mockups/                     # HyperFrames workspace (.mintignore'd)
│   ├── tokens.css  kit/  compositions/<slug>/{index.html,package.json}
└── scripts/
    ├── check-tokens.mjs  render-mockups.mjs  emit-graphql-sdl.mjs  build-changelog.mjs
../backend/scripts/print-sdl.ts  # tiny helper committed to backend repo (Task 12)
```

## Phases

- **Phase 0 — Foundation:** T1 scaffold+theme, T2 snippets + Get Started tab
- **Phase 1 — Mockup pipeline:** T3 tokens+kit, T4 render pipeline
- **Phase 2 — UI tabs (content + static mockups per area):** T5–T11
- **Phase 3 — Key-flow animations:** T12–T13
- **Phase 4 — Self-Hosting tab:** T14–T16
- **Phase 5 — Developers tab:** T17–T23
- **Phase 6 — API Reference tab:** T24–T27
- **Phase 7 — Changelog + launch QA:** T28–T29

Phases 2, 4, 5, 6 are independent of each other after Phase 1 and may be executed in any order (or in parallel worktrees), except T24 (SDL emit) which only needs Phase 0.

---

### Task 1: Repo scaffold, theme, and brand assets

**Files:**
- Create: `docs.json`, `styles.css`, `index.mdx`, `.gitignore`, `.mintignore`, `AGENTS.md`, `package.json`
- Copy in: `fonts/inter-tight-400.woff2`, `fonts/inter-tight-500.woff2`, `fonts/roboto-mono-400.woff2` (from `../exulu-website/web/public/fonts/`), `logo/exulu-wordmark-light.svg`, `logo/exulu-wordmark-dark.svg`, `logo/exulu-icon-light.svg` (from `../exulu-website/web/public/logo/`)

**Interfaces:**
- Produces: the `docs.json` skeleton whose `navigation.tabs` array later tasks append groups into (tab names exactly: `Get Started`, `User Guide`, `Building`, `Administration`, `Self-Hosting`, `Developers`, `API Reference`, `Changelog`); CSS variables `--imp-*` available to all custom styling.

- [ ] **Step 1: Initialize repo and node project**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/exulu-docs
git init -b main
npm init -y
npm install --save-dev graphql
npm install -g mint || true   # mint CLI; skip if already installed
```

- [ ] **Step 2: Create `.gitignore` and `.mintignore`**

`.gitignore`:
```gitignore
node_modules/
.DS_Store
mockups/**/node_modules/
mockups/**/dist/
mockups/**/snapshots/
```

`.mintignore`:
```gitignore
mockups/
scripts/
openapi/README.md
node_modules/
```

- [ ] **Step 3: Copy brand assets**

```bash
mkdir -p fonts logo images videos snippets
cp ../exulu-website/web/public/fonts/inter-tight-400.woff2 fonts/
cp ../exulu-website/web/public/fonts/inter-tight-500.woff2 fonts/
cp ../exulu-website/web/public/fonts/roboto-mono-400.woff2 fonts/
cp ../exulu-website/web/public/logo/exulu-wordmark-light.svg logo/
cp ../exulu-website/web/public/logo/exulu-wordmark-dark.svg logo/
cp ../exulu-website/web/public/logo/exulu-icon-light.svg logo/
```

- [ ] **Step 4: Write `docs.json`** (full skeleton; tabs carry placeholder first pages that Task 2 fills)

```json
{
  "$schema": "https://mintlify.com/docs.json",
  "theme": "aspen",
  "name": "IMP Docs",
  "description": "Documentation for IMP — the Intelligence Management Platform.",
  "colors": {
    "primary": "#6f9a37",
    "light": "#cef79e",
    "dark": "#557a26"
  },
  "background": {
    "color": { "light": "#f8f6f1", "dark": "#1b1714" }
  },
  "logo": {
    "light": "/logo/exulu-wordmark-light.svg",
    "dark": "/logo/exulu-wordmark-dark.svg"
  },
  "favicon": "/logo/exulu-icon-light.svg",
  "icons": { "library": "lucide" },
  "contextual": {
    "options": ["copy", "view", "chatgpt", "claude", "perplexity", "mcp", "cursor", "vscode"]
  },
  "navigation": {
    "tabs": [
      { "tab": "Get Started", "icon": "rocket", "groups": [ { "group": "Welcome", "pages": ["index"] } ] },
      { "tab": "User Guide", "icon": "message-square", "groups": [] },
      { "tab": "Building", "icon": "hammer", "groups": [] },
      { "tab": "Administration", "icon": "shield", "groups": [] },
      { "tab": "Self-Hosting", "icon": "server", "groups": [] },
      { "tab": "Developers", "icon": "code", "groups": [] },
      { "tab": "API Reference", "icon": "braces", "groups": [] },
      { "tab": "Changelog", "icon": "history", "groups": [] }
    ]
  },
  "footer": {
    "socials": { "github": "https://github.com/Qventu" },
    "links": [
      {
        "header": "Company",
        "items": [
          { "label": "Exulu — exulu.com", "href": "https://exulu.com" },
          { "label": "Imprint", "href": "https://exulu.com/impressum" }
        ]
      }
    ]
  }
}
```

Note: Mintlify rejects empty `groups` arrays in some versions — if `mint validate` complains, give each empty tab one stub page (`<tab-dir>/index.mdx` with title/description) and list it; Task-by-task these stubs are replaced.

- [ ] **Step 5: Write `styles.css`**

```css
/* IMP Docs chrome — website CI (bone/ink/lime), squared aesthetic. */

@font-face { font-family: "Aspekta"; font-style: normal; font-weight: 400; src: url("/fonts/inter-tight-400.woff2") format("woff2"); font-display: swap; }
@font-face { font-family: "Aspekta"; font-style: normal; font-weight: 500; src: url("/fonts/inter-tight-500.woff2") format("woff2"); font-display: swap; }
@font-face { font-family: "RobotoMono"; font-style: normal; font-weight: 400; src: url("/fonts/roboto-mono-400.woff2") format("woff2"); font-display: swap; }

:root {
  --imp-bone: #f8f6f1;
  --imp-ink: #222f30;
  --imp-void: #1b1714;
  --imp-tissue: #efece4;
  --imp-lime: #cef79e;
  --imp-olive: #6f9a37;
  --imp-hair-light: #e4ddd0;
  --imp-hair-dark: #4d5757;
}

body {
  font-family: "Aspekta", "Inter Tight", system-ui, sans-serif;
  letter-spacing: -0.011em;
}

h1, h2, h3, h4 {
  font-family: "Aspekta", "Inter Tight", system-ui, sans-serif;
  font-weight: 500;
  letter-spacing: -0.03em;
}

code, pre, kbd, samp {
  font-family: "RobotoMono", "Roboto Mono", ui-monospace, monospace;
}

/* Squared aesthetic — 90-degree corners everywhere. */
*, *::before, *::after { border-radius: 0 !important; }
```

- [ ] **Step 6: Write `index.mdx`** (minimal landing; Task 2 expands)

```mdx
---
title: "IMP documentation"
description: "IMP is the Intelligence Management Platform: chat with agents over your organization's knowledge, manage access and budgets, and build on the platform's APIs."
mode: "wide"
---

IMP documentation is organized by what you do with the platform. Pick your path:

<Columns cols={2}>
  <Card title="Use IMP" icon="message-square" href="/user-guide/chat/overview">
    Chat with agents, work in projects, and transcribe meetings.
  </Card>
  <Card title="Build with IMP" icon="hammer" href="/building/agents/overview">
    Create agents, knowledge, prompts, skills, routines, and evals.
  </Card>
  <Card title="Administer IMP" icon="shield" href="/administration/users-access/overview">
    Manage users, roles, teams, budgets, and white-label theming.
  </Card>
  <Card title="Host IMP" icon="server" href="/self-hosting/architecture">
    Deploy the platform with Docker Compose and operate it.
  </Card>
  <Card title="Develop on IMP" icon="code" href="/developers/getting-started">
    Build backends with the npm package and integrate via the API.
  </Card>
  <Card title="API reference" icon="braces" href="/api-reference/graphql/introduction">
    GraphQL and REST reference, gateways, and authentication.
  </Card>
</Columns>
```

- [ ] **Step 7: Write `AGENTS.md`** — conventions file for future maintenance:

```markdown
# IMP Docs — conventions

- Product name is "IMP". Exulu = company, footer only. Never client names (see spec).
- Navigation lives ONLY in docs.json. New page ⇒ add to its tab's group.
- UI pages start with the RightsCallout snippet (snippets/rights-callout.mdx).
- Terminology: Knowledge (contexts/items), Routines, Transcripts, Users & access, Theme.
- Mockups: edit mockups/compositions/<slug>/, run `npm run mockups` to re-render
  images/ and videos/. Never hand-edit rendered PNGs/MP4s.
- Generated files: api-reference/graphql/schema.graphql (`npm run sdl`),
  changelog/index.mdx (`npm run changelog`). Regenerate, don't hand-edit.
- Gates before push: `mint validate && mint broken-links` plus `npm run check`
  inside any touched mockup composition.
```

- [ ] **Step 8: Verify**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/exulu-docs
mint validate
```
Expected: validation passes (or only warnings about empty tabs — fix per Step 4 note).
Run `mint dev` (background), open http://localhost:3000 — landing page renders with bone background, squared corners, Aspekta headings, olive accent. Stop server.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: scaffold IMP docs site with website-CI theme"
```

---

### Task 2: Snippets + Get Started tab

**Files:**
- Create: `snippets/rights-callout.mdx`, `snippets/edition-badge.mdx`
- Create: `get-started/what-is-imp.mdx`, `get-started/concepts.mdx`, `get-started/editions.mdx`, `get-started/where-do-i-start.mdx`
- Modify: `docs.json` (Get Started tab), `index.mdx` (keep as is)

**Interfaces:**
- Produces: `RightsCallout` snippet used by every UI page. Import and usage contract:
  ```mdx
  import { RightsCallout } from "/snippets/rights-callout.mdx";
  <RightsCallout right="budget_management (read)" flags="none" />
  ```

- [ ] **Step 1: Read sources** — `../backend/mintlify-docs/community-edition.mdx`, `enterprise-edition.mdx`, `index.mdx` (harvest CE/EE feature split), `../backend/README.md` (top ~150 lines), `../frontend/design/personas.md`.

- [ ] **Step 2: Write `snippets/rights-callout.mdx`**

```mdx
export const RightsCallout = ({ right, flags }) => (
  <Info>
    Who sees this: requires {right === "none" ? "no special rights — available to every signed-in user" : `the ${right} right (or super admin)`}.
    {flags && flags !== "none" ? ` Only visible when the server enables ${flags}.` : ""}
  </Info>
);
```

`snippets/edition-badge.mdx`:
```mdx
export const EditionBadge = ({ edition }) => (
  <Tooltip tip={edition === "ee" ? "Requires an Enterprise Edition license." : "Available in the Community Edition."}>
    <span style={{ fontFamily: "RobotoMono, monospace", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.04em", border: "1px solid var(--imp-hair-light)", padding: "2px 8px" }}>
      {edition === "ee" ? "Enterprise" : "Community"}
    </span>
  </Tooltip>
);
```

- [ ] **Step 3: Write the four Get Started pages.** Outlines (each page: frontmatter with title+description+icon, second person, no marketing):
  - `what-is-imp.mdx` — what IMP is (agents + knowledge + governance in one platform); the four surfaces (chat, building, administration, API); deployment models (hosted by Exulu / self-hosted); screenshot placeholder to be replaced in T5 (`/images/mockups/chat-overview.png` — reference it now, T5 renders it).
  - `concepts.mdx` — concept page defining: Agent, Knowledge (context, item, chunk, embedding), Session, Project, Prompt, Skill, Routine, Transcript, Budget, Role/Team, Variable. One short paragraph each + links to their doc sections. This page is the terminology anchor — every term matches the UI canon.
  - `editions.mdx` — CE vs EE: harvested feature split re-verified against `../backend/ee/entitlements` license flags (`agent-feedback`, `rbac`, `evals`, `template-conversations`, `queues`, `advanced-document-processing`, `multi-agent-tooling`); use a table, `EditionBadge` where useful.
  - `where-do-i-start.mdx` — role router: five `<Card>`s (I chat with agents / I build agents and knowledge / I administer the platform / I deploy it / I develop against it) linking to each tab's first page.

- [ ] **Step 4: Update `docs.json`** Get Started tab:

```json
{ "tab": "Get Started", "icon": "rocket", "groups": [
  { "group": "Welcome", "pages": ["index", "get-started/what-is-imp", "get-started/where-do-i-start"] },
  { "group": "Platform", "pages": ["get-started/concepts", "get-started/editions"] }
] }
```

- [ ] **Step 5: Verify** — `mint validate && mint broken-links`. Expected: pass; broken-links will flag `/images/mockups/chat-overview.png` only if linked as page link — image refs to not-yet-rendered files are acceptable this task only if flagged; otherwise temporarily comment the image.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: add Get Started tab and shared snippets"`

---

### Task 3: Mockup workspace — tokens + replica kit

**Files:**
- Create: `mockups/tokens.css`, `mockups/kit/README.md`, `mockups/kit/app-shell.css`, `mockups/kit/data-table.css`, `mockups/kit/dialog.css`, `mockups/kit/chat.css`, `mockups/kit/widgets.css` (cards/command-box/toast), `mockups/kit/cursor.css`, `mockups/kit/cursor.js`
- Create: `mockups/compositions/_sample-users/index.html`, `mockups/compositions/_sample-users/package.json`, `mockups/compositions/_sample-users/meta.json`
- Create: `scripts/check-tokens.mjs`

**Interfaces:**
- Produces: kit class contract used by ALL compositions (Tasks 5–13): `.imp-shell`, `.imp-sidebar`, `.imp-sidebar-group`, `.imp-nav-item`, `.imp-topbar`, `.imp-main`, `.imp-table`, `.imp-row`, `.imp-badge`, `.imp-dialog`, `.imp-btn` / `.imp-btn-ink` / `.imp-btn-ghost`, `.imp-chat`, `.imp-msg-user`, `.imp-msg-agent`, `.imp-composer`, `.imp-card`, `.imp-cmdbox`, `.imp-toast`, `.imp-cursor`. Compositions import kit files with `<link rel="stylesheet" href="../../tokens.css">` and `href="../../kit/<file>.css"`.

- [ ] **Step 1: Read the source replicas.** Read 2 recent reskinned compositions to lift working patterns and exact values (these are already in the warm/lime mockup CI): `../backend/releases/2026-07-08-projects/hyperframes/new-project/compositions/` (or its `index.html`) and `../backend/releases/2026-06-10-summer-release/hyperframes/compositions/teams.html`. Also read `../backend/releases/_build/reskin-videos-prep.mjs` HEX_MAP (authoritative palette).

- [ ] **Step 2: Write `mockups/tokens.css`** (values verbatim from the reskin map — see Global Constraints):

```css
/* IMP product-replica tokens — the warm/lime skin used in all release mockups.
   Source of truth: releases/_build/reskin-videos-prep.mjs HEX_MAP.
   Check drift with: node scripts/check-tokens.mjs */
:root {
  --bg: #f8f6f1;
  --surface: #fbfaf7;
  --surface-2: #efece4;
  --hair: #e4ddd0;
  --tx-hi: #241f1a;
  --tx-mid: #55504a;
  --tx-lo: #6b6560;
  --tx-faint: #9b948d;
  --accent: #6f9a37;
  --accent-soft: #8fbf4d;
  --chip: #cef79e;
  --chip-soft: #eef3e2;
  --ink: #222f30;
  --void: #1b1714;
  --destructive: #e54b50;
  --code-bg: #22253a;
  --code-fg: #f7f7ef;
  --radius: 0;
  --font-sans: "Aspekta", "Inter Tight", system-ui, sans-serif;
  --font-mono: "RobotoMono", "Roboto Mono", monospace;
}
```

Also copy the three font files into `mockups/fonts/` and add `mockups/fonts.css` with plain (non-base64) `@font-face` rules pointing at them (base64 embedding is only needed for the release publish path, not for local rendering).

- [ ] **Step 3: Write the kit CSS files.** Every rule is scoped under `.imp-shell` (or the component root class) so kit styles never leak. `app-shell.css` in full (adapt visual details from the Step-1 reference compositions — sidebar labels are RobotoMono uppercase 11px, nav items 13px, active item gets `background: var(--surface-2)`):

```css
/* kit/app-shell.css — IMP application frame replica */
.imp-shell { display: flex; width: 1600px; height: 1000px; background: var(--bg); font-family: var(--font-sans); color: var(--tx-hi); border: 1px solid var(--hair); overflow: hidden; }
.imp-sidebar { width: 232px; flex: none; background: var(--surface); border-right: 1px solid var(--hair); padding: 16px 10px; display: flex; flex-direction: column; gap: 2px; }
.imp-sidebar .imp-wordmark { font-weight: 500; font-size: 15px; letter-spacing: -0.02em; padding: 6px 10px 16px; }
.imp-sidebar-group { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--tx-faint); padding: 14px 10px 4px; }
.imp-nav-item { display: flex; align-items: center; gap: 9px; font-size: 13px; color: var(--tx-mid); padding: 6px 10px; cursor: default; }
.imp-nav-item svg { width: 15px; height: 15px; stroke-width: 1.5; }
.imp-nav-item.active { background: var(--surface-2); color: var(--tx-hi); }
.imp-topbar { height: 52px; flex: none; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; border-bottom: 1px solid var(--hair); background: var(--bg); }
.imp-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.imp-content { flex: 1; padding: 24px 28px; overflow: hidden; }
.imp-badge { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; border: 1px solid var(--hair); background: var(--chip-soft); color: var(--tx-mid); padding: 2px 8px; display: inline-flex; align-items: center; gap: 6px; }
.imp-badge .dot { width: 6px; height: 6px; background: var(--accent); }
.imp-btn { font-family: var(--font-mono); font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; padding: 9px 14px; border: 1px solid transparent; cursor: default; display: inline-flex; align-items: center; gap: 8px; }
.imp-btn-ink { background: var(--ink); color: #fff; }
.imp-btn-ghost { background: transparent; border-color: var(--hair); color: var(--tx-mid); }
```

Write `data-table.css` (`.imp-table` grid rows, header row mono-uppercase, `.imp-row` 1px `--hair` separators, avatar circles ⇒ squares per radius-0, hover `--surface-2`), `dialog.css` (`.imp-dialog` centered panel on `rgba(27,23,20,.35)` scrim, header/body/footer), `chat.css` (`.imp-chat` column max-width 760px, `.imp-msg-user` right-aligned surface-2 block, `.imp-msg-agent` plain text, `.imp-composer` bordered input bar with icon buttons), `widgets.css` (`.imp-card` stat card, `.imp-cmdbox` dark `--code-bg` command block with copy button, `.imp-toast` bottom-right ink panel), `cursor.css` + `cursor.js` (the simulated cursor: absolute 16px SVG pointer `.imp-cursor` + `.imp-click-ripple` keyframe-free GSAP-driven ripple; lift both from a Step-1 reference composition, generalized to `window.impCursor(tl, {from, to, at, click})` helper registered for GSAP timelines).

- [ ] **Step 4: Write the sample composition** `mockups/compositions/_sample-users/` — a static Users & access screen replica proving the kit composes: `index.html` uses `.imp-shell` + sidebar (groups Workspace/Build/Develop/Administration with "Users" active) + `.imp-table` with 5 invented users (e.g. "Maren Vogel — maren@example.com — Admin — 2 teams"). Include the HyperFrames boilerplate (composition root with `data-composition-id="sample-users"`, one `class="clip"` element with `data-start="0" data-duration="4" data-track-index="0"`, empty paused GSAP timeline registered on `window.__timelines["sample-users"]`). `package.json` identical to the release pattern:

```json
{
  "name": "sample-users",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "npx --yes hyperframes@0.7.42 preview",
    "check": "npx --yes hyperframes@0.7.42 lint && npx --yes hyperframes@0.7.42 validate && npx --yes hyperframes@0.7.42 inspect",
    "render": "npx --yes hyperframes@0.7.42 render",
    "snapshot": "npx --yes hyperframes@0.7.42 snapshot"
  }
}
```
`meta.json`: `{ "id": "sample-users", "name": "Sample: Users table" }`.

- [ ] **Step 5: Write `scripts/check-tokens.mjs`** — drift guard:

```js
// Verifies mockups/tokens.css values still match the canonical CI sources.
import { readFileSync } from "node:fs";

const tokens = readFileSync(new URL("../mockups/tokens.css", import.meta.url), "utf8");
const website = readFileSync("../exulu-website/web/app/globals.css", "utf8");
const reskin = readFileSync("../backend/releases/_build/reskin-videos-prep.mjs", "utf8");

const mustMatchWebsite = ["#f8f6f1", "#efece4", "#e4ddd0", "#cef79e", "#222f30", "#1b1714"];
const mustMatchReskin = ["#6f9a37", "#8fbf4d", "#fbfaf7", "#241f1a", "#55504a", "#6b6560", "#9b948d"];

let fail = 0;
for (const hex of mustMatchWebsite) {
  if (!tokens.includes(hex)) { console.error(`tokens.css missing ${hex}`); fail = 1; }
  if (!website.toLowerCase().includes(hex)) { console.error(`WEBSITE DRIFT: ${hex} no longer in exulu-website globals.css`); fail = 1; }
}
for (const hex of mustMatchReskin) {
  if (!tokens.includes(hex)) { console.error(`tokens.css missing ${hex}`); fail = 1; }
  if (!reskin.toLowerCase().includes(hex)) { console.error(`RESKIN DRIFT: ${hex} not in reskin-videos-prep.mjs`); fail = 1; }
}
if (fail) process.exit(1);
console.log("tokens.css matches website CI + reskin map.");
```

Add to root `package.json` scripts: `"tokens": "node scripts/check-tokens.mjs"`.

- [ ] **Step 6: Verify**

```bash
node scripts/check-tokens.mjs           # expected: "tokens.css matches…"
cd mockups/compositions/_sample-users && npm run check
```
Expected: hyperframes lint + validate + inspect pass with no errors. Then `npm run dev` (background), view the composition — it must read as a believable IMP screen in the warm/lime skin. Stop server.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: add mockup workspace with token stylesheet and replica kit"`

---

### Task 4: Render pipeline (`render-mockups.mjs`)

**Files:**
- Create: `scripts/render-mockups.mjs`
- Modify: `package.json` (add `"mockups": "node scripts/render-mockups.mjs"`)

**Interfaces:**
- Consumes: composition dirs `mockups/compositions/<slug>/` with the Task-3 package.json script contract.
- Produces: for every composition — `images/mockups/<slug>.png` (static: last poster frame at 2x); for compositions marked `"video": true` in their `meta.json` — `videos/<slug>.mp4`. Content tasks embed these exact paths.

- [ ] **Step 1: Confirm the HyperFrames CLI flags.** Run in `_sample-users`: `npx --yes hyperframes@0.7.42 render --help` and `npx --yes hyperframes@0.7.42 snapshot --help`. Note the flags for output path, frame/time selection, scale/width, and (for render) fps/quality. The next step's script has `RENDER_ARGS`/`SNAPSHOT_ARGS` constants at the top — set them to the real flags discovered here (e.g. snapshot at `t=<duration-0.1s>` or a `--frame` equivalent, width 3200 for 2x of the 1600px shell).

- [ ] **Step 2: Write `scripts/render-mockups.mjs`**

```js
// Renders every mockup composition to committed docs assets.
// PNG: images/mockups/<slug>.png (poster frame). MP4 (if meta.video): videos/<slug>.mp4.
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPS = join(ROOT, "mockups", "compositions");
// Set from `hyperframes render/snapshot --help` (Task 4 Step 1):
const SNAPSHOT_ARGS = process.env.SNAPSHOT_ARGS ?? "";       // e.g. "--width 3200 --at end --out snapshots"
const RENDER_ARGS = process.env.RENDER_ARGS ?? "";           // e.g. "--fps 30"
const only = process.argv[2];                                 // optional single slug

mkdirSync(join(ROOT, "images", "mockups"), { recursive: true });
mkdirSync(join(ROOT, "videos"), { recursive: true });

const slugs = readdirSync(COMPS).filter((d) => !d.startsWith(".") && (!only || d === only));
for (const slug of slugs) {
  const dir = join(COMPS, slug);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  console.log(`— ${slug}`);
  execSync(`npm run --silent check`, { cwd: dir, stdio: "inherit" });
  execSync(`npx --yes hyperframes@0.7.42 snapshot ${SNAPSHOT_ARGS}`, { cwd: dir, stdio: "inherit" });
  const snap = findNewestPng(dir); // helper: newest .png under dir/snapshots or dir/dist
  copyFileSync(snap, join(ROOT, "images", "mockups", `${slug}.png`));
  if (meta.video) {
    execSync(`npx --yes hyperframes@0.7.42 render ${RENDER_ARGS}`, { cwd: dir, stdio: "inherit" });
    const mp4 = findNewestMp4(dir);
    // docs-weight re-encode, mirrors releases/_build/encode-all.sh
    execSync(`ffmpeg -y -i "${mp4}" -an -vf "scale='min(1920,iw)':-2" -c:v libx264 -crf 27 -preset veryslow -movflags +faststart "${join(ROOT, "videos", `${slug}.mp4`)}"`, { stdio: "inherit" });
  }
}

function newest(dir, ext) {
  const hits = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== "node_modules") walk(join(d, e.name));
      else if (e.name.endsWith(ext)) hits.push(join(d, e.name));
    }
  })(dir);
  if (!hits.length) throw new Error(`no ${ext} produced in ${dir}`);
  return hits.map((f) => [f, statSync(f).mtimeMs]).sort((a, b) => b[1] - a[1])[0][0];
}
import { statSync } from "node:fs";
const findNewestPng = (d) => newest(d, ".png");
const findNewestMp4 = (d) => newest(d, ".mp4");
```

- [ ] **Step 3: Verify** — `node scripts/render-mockups.mjs _sample-users`. Expected: `images/mockups/_sample-users.png` exists, is 3200px wide (2x), and visually matches the preview. Open the PNG to confirm text is crisp and no styles bled.

- [ ] **Step 4: Delete the sample** — remove `mockups/compositions/_sample-users/` and `images/mockups/_sample-users.png` once the pipeline is proven (the kit remains).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: add mockup render pipeline (PNG snapshots + docs-weight MP4s)"`

---

### Task 5: User Guide — Chat core (pages + mockups)

**Files:**
- Create: `user-guide/chat/overview.mdx`, `conversations.mdx`, `attachments-and-session-files.mdx`, `dictation.mdx`, `prompts-in-chat.mdx`, `pinned-knowledge-and-presets.mdx`
- Create: `mockups/compositions/chat-overview/`, `mockups/compositions/chat-attach-menu/`, `mockups/compositions/chat-session-files/` (static, `meta.json` `"video": false`)
- Modify: `docs.json` (User Guide tab)

**Interfaces:**
- Consumes: kit classes (T3), render pipeline (T4).
- Produces: `/images/mockups/chat-overview.png` (referenced by Task 2's `what-is-imp.mdx` — un-comment that image now).

- [ ] **Step 1: Read sources.** `../frontend/components/shell/nav-config.ts`; chat page components under `../frontend/app/(application)/chat/` (or `../frontend/components/chat/` — locate via `grep -r "Choose an agent" ../frontend`); UI strings in `../frontend/messages/en.json` (search: chat, composer, session, attach, dictation, preset); `../frontend/design/pages/chat.md` (verify claims against components).

- [ ] **Step 2: Write the six pages.** All are task-oriented how-tos, start with `RightsCallout` (`right="none"` for chat pages), quote UI labels verbatim. Full example skeleton for `overview.mdx` (pattern for all UI pages in this plan):

```mdx
---
title: "Chat overview"
description: "Start a conversation with an agent, and find your way around the chat screen."
icon: "message-square"
---

import { RightsCallout } from "/snippets/rights-callout.mdx";

<RightsCallout right="none" flags="none" />

## Choose an agent

When you open **Chat**, IMP shows the agents you have access to. Select one to start
a conversation. If only one agent exists (or a default is set), IMP takes you
straight to it.

<Frame caption="The chat screen: history rail, conversation column, and composer.">
  <img src="/images/mockups/chat-overview.png" alt="IMP chat screen showing the sidebar, a conversation with an agent, and the message composer" />
</Frame>

## The chat screen

- **Header** — rename the conversation, start a new chat, toggle the history rail,
  and open the menu for sharing, usage, and more.
- **Budget chip** — shows how much of your budget this period is used. See
  [Budgets in chat](/user-guide/chat/budgets-in-chat).
…

## Next steps

<Columns cols={2}>
  <Card title="Attach files" href="/user-guide/chat/attachments-and-session-files" />
  <Card title="Pin knowledge" href="/user-guide/chat/pinned-knowledge-and-presets" />
</Columns>
```

Page content requirements: `conversations.mdx` (history rail, rename, delete, share, conversation search `/chat/[agent]/search`, bulk delete); `attachments-and-session-files.mdx` (composer attachments, "Add to conversation" menu, Session files panel: upload/preview/download/delete, session-private semantics); `dictation.mdx` (mic → Whisper transcription; note it requires the server's transcription backend — flag `Transcripts` config); `prompts-in-chat.mdx` (Insert prompt, template variables fill-in, slash autocomplete); `pinned-knowledge-and-presets.mdx` (Add knowledge: pin contexts/items; save selections as named context presets; sharing presets).

- [ ] **Step 3: Build the three mockups** with the kit: `chat-overview` (full shell, chat active in sidebar, one user + one agent message, composer with mic/attach icons); `chat-attach-menu` (same scene + open "Add to conversation" menu with Session files / Add knowledge / Insert prompt / Skills & tools rows); `chat-session-files` (side panel open with 3 files). Run `npm run check` in each; then `node scripts/render-mockups.mjs <slug>` for each.

- [ ] **Step 4: Wire navigation** — User Guide tab in `docs.json`:

```json
{ "tab": "User Guide", "icon": "message-square", "groups": [
  { "group": "Chat", "pages": [
    "user-guide/chat/overview", "user-guide/chat/conversations",
    "user-guide/chat/attachments-and-session-files", "user-guide/chat/dictation",
    "user-guide/chat/prompts-in-chat", "user-guide/chat/pinned-knowledge-and-presets"
  ] }
] }
```

- [ ] **Step 5: Verify** — `mint validate && mint broken-links` (both clean; the Task-2 image reference now resolves). Visual check of all three PNGs.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: add User Guide chat core pages with mockups"`

---

### Task 6: User Guide — Chat advanced (pages + mockups)

**Files:**
- Create: `user-guide/chat/tool-approvals.mdx`, `budgets-in-chat.mdx`, `context-compaction.mdx`, `image-generation.mdx`, `artifacts-and-sharing.mdx`, `model-override-and-usage.mdx`
- Create: `mockups/compositions/chat-tool-approval/`, `mockups/compositions/chat-budget-chip/`, `mockups/compositions/chat-artifact-share/` (static)
- Modify: `docs.json` (append pages to the Chat group in nav order above)

Same step pattern as Task 5. Sources add: `../backend/docs/superpowers/specs/` files for shareable artifacts, budget reset, context window management, in-chat image generation (feature rationale + exact behavior); grep frontend for "Allow once" (tool approval card), "Compact conversation", artifact share dialog.

Page requirements: `tool-approvals.mdx` ("Allow once / Allow for this chat / Deny" semantics, `needsApproval` default-on, admin-configured tool params are not user-editable); `budgets-in-chat.mdx` (budget chip %, budget-reached pause behavior, reset dates — budgets are set by admins, link to `/administration/budgets`); `context-compaction.mdx` (context-usage chip, compaction banner, what compaction keeps); `image-generation.mdx` (image widget: styles, reference images, count; requires LiteLLM + S3 on the server); `artifacts-and-sharing.mdx` (share an artifact: regular/public/password links, `/artifacts/[name]` viewer, revoking); `model-override-and-usage.mdx` (menu → Model override; Usage panel: tokens/cost per message).

Verify + commit: `git commit -m "feat: add User Guide chat advanced pages with mockups"`

---

### Task 7: User Guide — Projects, Transcripts, Settings (pages + mockups)

**Files:**
- Create: `user-guide/projects/overview.mdx`, `user-guide/projects/working-in-a-project.mdx`, `user-guide/transcripts/overview.mdx`, `user-guide/transcripts/recording-meetings.mdx`, `user-guide/transcripts/reviewing-and-saving.mdx`, `user-guide/settings.mdx`
- Create: `mockups/compositions/projects-overview/`, `mockups/compositions/transcripts-review/` (static)
- Modify: `docs.json` (add groups `Projects`, `Transcripts`, `Personal` to User Guide tab)

Sources: frontend `/projects`, `/transcriptions`, `/settings` components + en.json; transcription + meeting-bot specs in `../backend/docs/superpowers/specs/`.

Page requirements: projects overview (create, favorites, what a project groups: sessions + files + instructions + access); working-in-a-project (Sessions / Files / Settings tabs, custom instructions, danger zone); transcripts overview (`RightsCallout` flags="Transcripts (Whisper server or meeting bots configured)"; upload flow, monthly recording-time quota); recording-meetings (Record a meeting: bot joins a meeting URL, scheduling, auto-run post-processing prompts); reviewing-and-saving (diarized review sheet, rename speakers, audio timeline, save to Knowledge — cross-surface flow called out); settings (Appearance, Language, Personal system prompt, Account; personal token link into Developers).

Verify + commit: `git commit -m "feat: complete User Guide tab (projects, transcripts, settings)"`

---

### Task 8: Building — Agents + Knowledge (pages + mockups)

**Files:**
- Create: `building/agents/overview.mdx`, `building/agents/workbench.mdx`, `building/agents/tools-and-skills.mdx`, `building/agents/access-and-safety.mdx`, `building/knowledge/overview.mdx`, `building/knowledge/items.mdx`, `building/knowledge/pipeline.mdx`, `building/knowledge/entities.mdx`
- Create: `mockups/compositions/agents-workbench/`, `mockups/compositions/knowledge-pipeline/`, `mockups/compositions/knowledge-item-detail/` (static)
- Modify: `docs.json` (Building tab, groups `Agents`, `Knowledge`)

Sources: frontend `/agents/edit/[id]` (9 workbench sections), `/data` workspace (Items / Pipeline / Entities tabs), en.json; `../frontend/design/pages/agents.md`, `knowledge.md` (verify).

Page requirements — `RightsCallout right="agents (write)"` for agent pages: agents overview (list, search/filter/sort, duplicate, New agent dialog + AI avatar); workbench (all 9 sections: Basics, Instructions, Knowledge & memory, Tools & skills, Chat experience, Appearance, Safety, Access, Developer — one H2 each, concise; "Test in chat"); tools-and-skills (per-tool configuration, sub-agents as tools, skills toggles); access-and-safety (RBAC sharing users/teams, safety scanners). Knowledge pages: overview (context library, stats: items/retrievals/upserts, favourites; concept: context = items table + chunks + embedder); items (table, bulk ops, filters, new item, archive); pipeline (concept + how-to: Sources → Processor → Embedder stage cards, triggers, queues, jobs, pipeline health — this is the page that explains the knowledge mental model; cross-link Developers tutorials for code-defined contexts); entities (entity layer, extraction, backfill, item entity view).

Verify + commit: `git commit -m "feat: add Building tab agents and knowledge sections"`

---

### Task 9: Building — Prompts, Skills, Routines (pages + mockups)

**Files:**
- Create: `building/prompts.mdx`, `building/skills/overview.mdx`, `building/skills/editing-and-versions.mdx`, `building/skills/connect-your-agent.mdx`, `building/routines/overview.mdx`, `building/routines/runs-and-schedules.mdx`
- Create: `mockups/compositions/skills-editor/`, `mockups/compositions/routine-schedule/` (static)
- Modify: `docs.json` (Building tab groups `Prompts & Skills`, `Routines`)

Sources: frontend `/prompts`, `/skills`, `/workflows` + en.json; prompts/skills versioning + routines specs in `../backend/docs/superpowers/specs/`.

Page requirements: prompts (library, folders, favorites, versioning with diff/restore, variables, agent assignment, where prompts surface — the 4 surfaces cross-link); skills overview (SKILL.md packages, upload a bundle, preview); editing-and-versions (file-tree editor, version history, diffs); connect-your-agent (install command surface — quote the exact command style shown in UI); routines overview (**created exclusively from chat via "Save as Routine"** — call this out in a `<Note>`; run on demand); runs-and-schedules (runs history, cron schedule editor, queue, steps editor, access, danger zone).

Verify + commit: `git commit -m "feat: add Building tab prompts, skills, routines"`

---

### Task 10: Building — Evals, Automation, Feedback (pages + mockup)

**Files:**
- Create: `building/evals/overview.mdx`, `building/evals/test-cases.mdx`, `building/evals/runs.mdx`, `building/automation.mdx`, `building/feedback.mdx`
- Create: `mockups/compositions/evals-results/` (static)
- Modify: `docs.json` (Building tab groups `Evals`, `More`)

Sources: frontend `/evals`, `/n8n`, `/feedback` + en.json.

Page requirements — `RightsCallout right="evals (read/write)"`: evals overview (eval sets, EE edition badge); test-cases (global library + per-set); runs (Run eval, results matrix, result sheets, queue management: pause/resume/drain, retry/delete, "no workers running" warning — cross-link self-hosting workers page); automation (embedded n8n editor, desktop-only, `flags="Automation (N8N_URL configured)"`); feedback (review console: filters, conversation view, Open in Chat; distinguish from "Send feedback" dialog, `flags="Feedback (FEEDBACK_ENABLED)"`).

Verify + commit: `git commit -m "feat: complete Building tab (evals, automation, feedback)"`

---

### Task 11: Administration tab (pages + mockups)

**Files:**
- Create: `administration/users-access/overview.mdx`, `administration/users-access/roles.mdx`, `administration/users-access/teams.mdx`, `administration/models.mdx`, `administration/budgets.mdx`, `administration/analytics.mdx`, `administration/variables.mdx`, `administration/theme.mdx`, `administration/api-keys.mdx`
- Create: `mockups/compositions/users-table/`, `mockups/compositions/roles-matrix/`, `mockups/compositions/budgets-overview/`, `mockups/compositions/theme-studio/` (static)
- Modify: `docs.json` (Administration tab: groups `Users & access`, `Platform`, `Governance`)

Sources: frontend `/users`, `/models`, `/budgets`, `/analytics`, `/variables`, `/configuration`, `/keys`, `/token` + en.json; LiteLLM budget memory: reset dates are standardized UTC calendar boundaries, set via LiteLLM budget endpoints.

Page requirements — rights per page (`users (write)` for users/roles/teams; `budget_management` for budgets; super-admin for analytics/theme): users-access overview (one surface, tabs Users · Roles · Teams; search, bulk assign, add user, reset password, super-admin toggle + last-admin warning); roles (permission matrix: 7 right areas × read/write); teams; models (read-only LiteLLM catalog, "Open LiteLLM Admin UI" — `<Note>` the boundary: model CRUD lives in LiteLLM, cross-link self-hosting LiteLLM page); budgets (per user/role/team/project/agent budgets, at-risk list, editor: amount USD + reset period + reset date, bulk apply, Default budget policy dialog; note LiteLLM is the source of truth); analytics (KPI row, trend chart, breakdowns, 30-day max range, CSV export); variables (Secret vs Plain text, encryption at rest, reveal-on-demand, "Used by"); theme (white-label studio: grouped CSS variable editor, live preview, import/export CSS, publish/reset); api-keys (org keys: Admin vs Agents-allowlist scope, one-time reveal, role/team/project attribution; personal token: JWT with expiry + cURL example — cross-link API auth page).

Verify + commit: `git commit -m "feat: add Administration tab"`

---

### Task 12: Animation audit + reuse of existing shorts

**Files:**
- Create: `videos/` (populated), `mockups/ANIMATIONS.md` (the flow→asset map)

- [ ] **Step 1: Audit.** List all release shorts: `find ../backend/releases -path "*/shorts/*.mp4" -not -path "*_purple*" -not -name "*.open.mp4"`. For each of the ~15 spec flows (create an agent, pin knowledge, approve a tool call, share an artifact, create a project, record a meeting, save a routine, run an eval, upload a skill, context pipeline run, set a budget, assign a role, white-label theme, generate an image, command palette), check whether an existing short shows the current UI accurately (watch it; compare against the current frontend screens documented in T5–T11). Record verdicts in `mockups/ANIMATIONS.md` as a table: flow · reuse `<release>/shorts/<file>.mp4` | author-new · target docs page.

- [ ] **Step 2: Copy reusable shorts** through the docs-weight re-encode (same ffmpeg settings as T4 Step 2) into `videos/<flow-slug>.mp4`. Embed each into its docs page (T5–T11 pages) with the standard block:

```mdx
<Frame caption="Setting a budget for a team.">
  <video autoPlay muted loop playsInline src="/videos/set-budget.mp4" />
</Frame>
```

- [ ] **Step 3: Verify + commit** — `mint validate && mint broken-links`; play 2–3 embedded videos in `mint dev`. `git commit -m "feat: reuse release shorts as key-flow animations"`

---

### Task 13: Author the remaining key-flow animations

**Files:**
- Create: `mockups/compositions/<flow-slug>/` for every `author-new` row in `mockups/ANIMATIONS.md` (with `meta.json` `"video": true`)

- [ ] **Step 1:** For each new flow, author a 4–10s composition using the kit + GSAP timeline: hook (title beat ≥1.0s) → demo (simulated cursor via `window.impCursor`, 600ms breath after each click) → payoff (result state ≥1.4s). Caption read-time floors: 1.0s/1.4s/1.8s by length. Follow `../backend/releases/2026-07-13-connect-your-agent/hyperframes/connect-modal/` as the structural reference. `npm run check` clean per composition.
- [ ] **Step 2:** `node scripts/render-mockups.mjs <slug>` per flow → verify each MP4 (open and watch: timing legible, no style bleed, warm/lime CI only).
- [ ] **Step 3:** Embed in the target pages (block from T12 Step 2), update `mockups/ANIMATIONS.md` statuses.
- [ ] **Step 4:** `mint validate && mint broken-links`; commit — `git commit -m "feat: author remaining key-flow animations"`

---

### Task 14: Self-Hosting — architecture, requirements, quickstart

**Files:**
- Create: `self-hosting/architecture.mdx`, `self-hosting/requirements.mdx`, `self-hosting/quickstart.mdx`
- Modify: `docs.json` (Self-Hosting tab, group `Deploy`)

Sources (read first): `../../example/README.md`, all four `../../example/docker-compose.*.yml`, `../../example/Dockerfile.backend`, `start-backend.sh`, `.env.example`; `../../selise/.env.example`. (Paths relative to `exulu-docs/`; the `example` repo is `/Users/daniel.claessen/Desktop/Projects/exulu/example` — the canonical self-host template, github.com/Qventu/exulu-example.)

Page requirements:
- `architecture.mdx` — concept page: the service topology (frontend :3000 → backend :9001 → LiteLLM proxy :4000 (spawned by backend) / Postgres+pgvector / Redis / MinIO-S3; worker :9002 connecting to the backend's proxy in client mode; optional Whisper GPU server :9876). Render the diagram as a static mockup composition (`mockups/compositions/hosting-architecture/` — boxes + arrows with kit tokens, no product replica needed) OR a Mermaid diagram if visual parity is acceptable — decision: use Mermaid (```mermaid code block), reserving mockups for product UI.
- `requirements.mdx` — reference: Node **exactly 22.18.0**; Debian-based images mandatory (ONNX); Postgres 13+ with pgvector; a **second** Postgres database for LiteLLM; Redis 7 (only when using workers/queues); S3-compatible storage (bucket created manually); the private npm registry NPM_TOKEN license; hardware guidance (worker 8GB `--max-old-space-size=8192`); version pin table (litellm[proxy] 1.85.1, prisma 0.15.0, torch 2.5.1, pgvector/pgvector:pg17, CUDA 12.4 / driver ≥ 550).
- `quickstart.mdx` — `<Steps>` walkthrough of the example repo: clone → `.env` from template → `docker compose -f docker-compose.services.yml up -d` (MinIO+pgvector+Redis) → backend (`docker-compose.backend.yml`, NPM_TOKEN build arg, ports 9001+4000) → worker → frontend (pulls `ghcr.io/qventu/exulu-frontend:latest`) → first login (initdb prints one-time admin `admin@exulu.com`/`admin` + API key — `<Warning>` capture the first-boot log output and rotate the password). Note: the backend has no published image — it is always built locally with the license key.

Verify + commit: `git commit -m "feat: add Self-Hosting architecture, requirements, quickstart"`

---

### Task 15: Self-Hosting — service guides

**Files:**
- Create: `self-hosting/services/postgres.mdx`, `redis.mdx`, `s3-storage.mdx`, `litellm.mdx`, `whisper.mdx`, `smtp-and-auth.mdx`, `observability.mdx`
- Modify: `docs.json` (group `Services`)

Sources: `../backend/src/exulu/litellm/supervisor.ts` + `db-init.ts` (read the extensive comments), `../backend/src/postgres/client.ts`, `../../example/config.litellm.yaml`, `../backend/docker/whisper/README.md` + `Dockerfile`, `../backend/ee/python/requirements.txt`.

Page requirements:
- `postgres.mdx` — auto-created database (`POSTGRES_DB_NAME`, default `exulu`), `CREATE EXTENSION vector`, HNSW `ef_search=20`, pool max 300, per-context item/chunk tables with `vector(N)` columns sized from the LiteLLM `model_info.dimensionality`.
- `redis.mdx` — BullMQ queues, only required with workers; `REDIS_HOST/PORT/USER/PASSWORD`.
- `s3-storage.mdx` — MinIO or AWS via `COMPANION_S3_*`; bucket must exist beforehand; presigned-URL flows; the SDK default-checksum gotcha (see backend commit `fa88d2e`).
- `litellm.mdx` — the deep page: role (single model registry, chat routing, embeddings, reranking, OCR, image gen, budgets source-of-truth); supervisor lifecycle (child process when `EXULU_USE_LITELLM=true`, `/health/liveliness` polling, 90s boot budget, 5-crash backoff, workers in client mode over :4000); `config.litellm.yaml` schema with the Exulu `model_info` extensions (`type: embedder|reranker|ocr|image_generation`, `brand`, `region`, `dimensionality`, `max_chunk_size`, `max_batch_size`) with a real annotated YAML example lifted from `example/config.litellm.yaml`; **the dedicated database requirement** in a `<Warning>`: pointing `LITELLM_DATABASE_URL` at the Exulu DB would let LiteLLM's `prisma db push` drop every non-LiteLLM table — the backend refuses, do not work around it; admin UI at `/litellm-admin`.
- `whisper.mdx` — port `../backend/docker/whisper/README.md` (GPU container, HF_AUTH_TOKEN + pyannote licenses, ~3GB model, `/healthz` 1200s start_period, CPU variant note, `TRANSCRIPTION_SERVER`).
- `smtp-and-auth.mdx` — `AUTH_MODE` password|otp, SMTP vars **as the code reads them** (`SMTP_USER`, `SMTP_FROM`, `SMTP_SECURE`, …), optional Google OAuth, `NEXTAUTH_SECRET` symmetry between frontend/backend.
- `observability.mdx` — SigNoz OTel vars, what gets traced.

Verify + commit: `git commit -m "feat: add Self-Hosting service guides"`

---

### Task 16: Self-Hosting — containers, env reference, database, operations, troubleshooting

**Files:**
- Create: `self-hosting/containers.mdx`, `self-hosting/environment-variables.mdx`, `self-hosting/database.mdx`, `self-hosting/operations.mdx`, `self-hosting/troubleshooting.mdx`
- Modify: `docs.json` (group `Operate`)

Sources: `../../example/Dockerfile.backend`, `Dockerfile.worker`, start scripts; env enumeration — grep ground truth: `grep -rhoE "process\.env\.[A-Z_]+" ../backend/src ../backend/ee | sort -u`; `../backend/src/postgres/init-exulu-db.ts`; `../backend/bin/backend.cjs`.

Page requirements:
- `containers.mdx` — image anatomy (node:22.18.0-slim, apt deps incl. tesseract/poppler/pandoc/libreoffice/ripgrep/bubblewrap/socat, `npx @exulu/backend setup-python` venv, pm2 CMD); **the bwrap security block** as its own H2: why `security_opt: seccomp:unconfined` + `apparmor:unconfined` are required (skill sandboxing user namespaces), what it means, `EXULU_REQUIRE_SANDBOX`; no container healthchecks exist and the only probeable route is `/` (state this honestly, link troubleshooting).
- `environment-variables.mdx` — the authoritative reference table (~47 vars): Variable · Required · Component (server/worker/frontend) · Purpose · Example. Grouped: Core (NODE_ENV, PORT, BACKEND, FRONTEND, NEXT_BACKEND, NEXTAUTH_*, AUTH_MODE, INTERNAL_SECRET, NPM_TOKEN, EXULU_ENTERPRISE_LICENSE), Postgres (POSTGRES_DB_*), Redis, S3 (COMPANION_S3_*, MINIO_ROOT_*), LiteLLM (EXULU_USE_LITELLM, LITELLM_*), Providers (VERTEX_CREDENTIALS_PATH, COHERE_API_KEY), Transcription (TRANSCRIPTION_SERVER, WHISPER_*, HF_AUTH_TOKEN, TTS_*), Meetings (RECALL_*, TOTAL_MAX_RECORDINGS_DURATION_PER_MONTH), SMTP, Telemetry (SIGNOZ_*), Sandbox (EXULU_REQUIRE_SANDBOX). Every row verified against the grep from Sources.
- `database.mdx` — the no-migrations model: idempotent `npm run utils:initdb` on every boot (creates missing tables/columns, embedded one-time migrations behind column-existence checks), first-boot admin + one-time API key, LiteLLM guarded `prisma db push`; backup guidance (pg_dump both databases + S3 bucket).
- `operations.mdx` — server/worker split, scaling workers, queue concurrency/timeout tuning (embedder queues sized to provider rate limits — worked example: 5M tokens/min ⇒ concurrency), pm2 in-container, upgrade procedure (bump package, rebuild image, initdb runs automatically), Dokploy note.
- `troubleshooting.mdx` — `<AccordionGroup>` of failure modes: LiteLLM won't start (config path, master key, its DB unreachable), embeddings stuck (no workers running, Redis down, queue paused), transcription failing (TRANSCRIPTION_SERVER, GPU/model download), uploads failing (bucket missing, checksum gotcha), login loops (NEXTAUTH_URL/secret mismatch), sandbox errors (bwrap security_opt).

Verify + commit: `git commit -m "feat: complete Self-Hosting tab"`

---

### Task 17: Developers — setup + getting started

**Files:**
- Create: `developers/setup.mdx`, `developers/getting-started.mdx`
- Modify: `docs.json` (Developers tab, group `Start`)

Sources: `../backend/package.json`, `../backend/mintlify-docs/getting-started.mdx` (harvest skeleton), `../backend/README.md` quickstart, reference-implementation boot files (`exulu.ts`, `server.ts`, `worker.ts` in the reference project — genericize).

Page requirements:
- `setup.mdx` — `@exulu/backend` from the private registry (`.npmrc` with NPM_TOKEN), Node 22.18.0 pin (preinstall check fails otherwise), TypeScript ^5.8.3 peer dep, dual CJS/ESM, auto-loaded `.env` (dotenv banner), `npx @exulu/backend setup-python` for document processing, project scaffold (tsup build with entries for server/worker).
- `getting-started.mdx` — the canonical minimal app, verbatim-runnable:

```typescript
// exulu.ts — shared app definition
import { ExuluApp } from "@exulu/backend";

export const app = new ExuluApp();

export const ready = app.create({
  config: {
    fileUploads: {
      s3region: process.env.COMPANION_S3_REGION!,
      s3key: process.env.COMPANION_S3_KEY!,
      s3secret: process.env.COMPANION_S3_SECRET!,
      s3Bucket: process.env.COMPANION_S3_BUCKET!,
      s3endpoint: process.env.COMPANION_S3_ENDPOINT,
    },
    telemetry: { enabled: false },
    workers: { enabled: true },
    MCP: { enable: true },
  },
  contexts: [],
  tools: [],
});
```
```typescript
// server.ts
import { app, ready } from "./exulu";

await ready;
const server = await app.express.init();
server.listen(Number(process.env.PORT ?? 9001), () => {
  console.log("IMP backend listening on :9001");
});
```
```typescript
// worker.ts
import { app, ready } from "./exulu";

await ready;
await app.bullmq.workers.create();
```
`<Warning>`: verify every property name against `../backend/src/exulu/app/index.ts` `ExuluConfig` while writing — the shapes above came from the reference implementation and must be re-checked against current source (e.g. `MCP.enable` vs `MCP.enabled`). Then: what `create()` does (built-in contexts, 19 default providers, default tools, id validation, eval_runs queue), first run output (initdb, admin credentials), and `npm run utils:initdb` note.

Verify: the two code samples type-check against the installed package — `cd /tmp && mkdir imp-docs-check && cd imp-docs-check && npm init -y && npm i typescript tsx @exulu/backend` (requires NPM_TOKEN in env) then `npx tsc --noEmit` on the samples. If the private registry is unavailable in this environment, verify by reading `../backend/src/index.ts` + `src/exulu/app/index.ts` signatures instead and note verification method in the commit body.

Commit: `git commit -m "feat: add Developers setup and getting started"`

---

### Task 18: Developers — core class triples: ExuluApp, ExuluContext

**Files:**
- Create: `developers/core/exulu-app/{introduction,configuration,api-reference}.mdx`, `developers/core/exulu-context/{introduction,configuration,api-reference}.mdx`
- Modify: `docs.json` (Developers tab, group `Core classes`, nested groups per class)

**Interfaces:**
- Produces: the class-page pattern all of T19–T21 follow — `introduction.mdx` (what it is, when to use, minimal example), `configuration.mdx` (every constructor/config option as `<ParamField>` with type/required/default), `api-reference.mdx` (every public method: signature, params as `<ParamField>`, return, worked example).

- [ ] **Step 1: Harvest.** Read `../backend/mintlify-docs/core/exulu-app/*.mdx` and `core/exulu-context/*.mdx` (the ~56k-word base). Keep structure and still-valid prose.
- [ ] **Step 2: Verify against source.** Read `../backend/src/exulu/app/index.ts` (842 lines) and `../backend/src/exulu/context.ts` (1310 lines). For every documented option/method: confirm name, signature, default. Add what's new (e.g. context `entities` config, `queryRewriter`, `resultReranker`, `configuration.cutoffs/expand/languages`, app `privacy`, `requireSystemDependencies`; `embeddings.generate.one/all`; `entityLayer` methods). Delete what's gone.
- [ ] **Step 3: Write the six pages** in the T18 pattern. ExuluContext `configuration.mdx` documents the full `ExuluContextFieldDefinition` (name, type, editable, unique, required, default, index, enumValues, allowedFileTypes) and `ExuluContextSource` (schedule cron, queue, retries, backoff, params, execute → `ExuluItem[]` upsert semantics).
- [ ] **Step 4: Wire nav** (nested groups):

```json
{ "group": "Core classes", "pages": [
  { "group": "ExuluApp", "pages": ["developers/core/exulu-app/introduction", "developers/core/exulu-app/configuration", "developers/core/exulu-app/api-reference"] },
  { "group": "ExuluContext", "pages": ["developers/core/exulu-context/introduction", "developers/core/exulu-context/configuration", "developers/core/exulu-context/api-reference"] }
] }
```

- [ ] **Step 5: Verify + commit** — `mint validate && mint broken-links`; `git commit -m "feat: add ExuluApp and ExuluContext class documentation"`

---

### Task 19: Developers — triples: ExuluTool, ExuluProvider, ExuluEval

**Files:**
- Create: `developers/core/exulu-tool/…`, `developers/core/exulu-provider/…`, `developers/core/exulu-eval/…` (triples)
- Modify: `docs.json` (append to Core classes group)

Same harvest→verify→write pattern as T18. Sources: `../backend/src/exulu/tool.ts`, `provider.ts` (1283 lines), `eval.ts`; harvest `mintlify-docs/core/exulu-tool/*` and **`core/exulu-agent/*`** — the old ExuluAgent pages document what is now ExuluProvider: rename throughout, and add a `<Note>` that `ExuluAgent` remains only as the TypeScript type for DB agent rows. ExuluTool pages must document: constructor (id, name, description, category, inputSchema zod, type `function|web_search|skill|context`, config[] admin params, needsApproval default true, oauth `ExuluOauthConfig` + PKCE flow + `inputs.oauth` injection), execute return `{result?, job?, items?}` incl. AsyncGenerator streaming, `ExuluTool.internal()`. ExuluProvider: config incl. `model.create(...)` → AI-SDK LanguageModel, capabilities, `generateSync`/`generateStream` key options, `tool()` export (multi-agent-tooling license), slug. ExuluEval: constructor, 0–100 score contract, `run()`.

Commit: `git commit -m "feat: add ExuluTool, ExuluProvider, ExuluEval class documentation"`

---

### Task 20: Developers — triples: ExuluQueues, ExuluChunkers, ExuluDatabase

**Files:**
- Create: `developers/core/exulu-queues/…`, `developers/core/exulu-chunkers/…`, `developers/core/exulu-database/…` (triples)
- Modify: `docs.json`

Sources: `../backend/ee/queues/queues.ts`, chunker sources (`grep -r "SentenceChunker\|MarkdownChunker\|RecursiveChunker" ../backend/src`), `ExuluDatabase` in `../backend/src/index.ts` + `src/postgres/init-exulu-db.ts`; harvest corresponding `mintlify-docs/core/` pages. Document: `ExuluQueues.register(name, {worker, queue}, ratelimit=1, timeoutInSeconds=180).use()`, lazy Redis connection + fail-fast guard, concurrency/timeout tuning table (from reference-implementation patterns: 5–20 workers, 4–40min timeouts, embedder queues sized to provider rate limits); chunker output contract `{item, chunks[{content,index,metadata}]}`, `defaultChunker`, `ExuluChunkers.markdown()/sentence/recursive` + chunk-size vs embedding dimensionality guidance (~1024 tokens for 1024-dim models); `ExuluDatabase.init/update({contexts, litellm?})`, `api.key.generate(name, email)`.

Commit: `git commit -m "feat: add ExuluQueues, ExuluChunkers, ExuluDatabase class documentation"`

---

### Task 21: Developers — single-page references

**Files:**
- Create: `developers/reference/exulu-jobs.mdx`, `exulu-default-tools.mdx`, `exulu-default-providers.mdx`, `exulu-variables.mdx`, `exulu-authentication.mdx`, `exulu-document-processor.mdx`, `exulu-reranker.mdx`, `exulu-otel.mdx`, `exulu-python.mdx`, `exulu-read-api.mdx`, `exulu-storage.mdx`, `exulu-mcp.mdx`, `exulu-tokenizer.mdx`, `functions-and-types.mdx`
- Modify: `docs.json` (group `Reference`)

Sources: each export's source file located from `../backend/src/index.ts`. One page per export: what it is (2–4 sentences), full API surface (`<ParamField>`s), one worked example, edition badge where EE-licensed (ExuluDocumentProcessor → advanced-document-processing; ExuluTokenizer → ee/). `exulu-default-providers.mdx` lists all 19 default providers by id (anthropic.opus4/sonnet4/sonnet45, cerebras.*, google.vertex*, openai.*). `functions-and-types.mdx` covers `defaultChunker`, `enableLiteLLMClientMode` (when a worker/CLI consumes a proxy owned by another process), `postgresClient`, enums (`EXULU_STATISTICS_TYPE_ENUM`, `EXULU_JOB_STATUS_ENUM`), shipped types (ChunkerOperation, ChunkerResponse, ExuluContextEmbedder, ExuluAgent, VectorSearchChunkResult, ExuluOauthConfig, ExuluOauthToolContext, ExuluItem).

Commit: `git commit -m "feat: add Developers single-page references"`

---

### Task 22: Developers — tutorials

**Files:**
- Create: `developers/tutorials/first-app.mdx`, `defining-contexts.mdx`, `data-sources-and-sync.mdx`, `custom-processors.mdx`, `queues-and-workers.mdx`, `custom-tools.mdx`, `oauth-tools.mdx`, `running-evals.mdx`, `mcp.mdx`
- Modify: `docs.json` (group `Tutorials`)

Sources: the reference implementation (`/Users/daniel.claessen/Desktop/Projects/newlkiag` — `exulu.ts`, `server.ts`, `worker.ts`, `src/contexts/contexts.ts`, `src/tools/index.ts`, integration fetchers) for **patterns only**; every snippet rewritten with generic names. **Grep gate:** after writing, `grep -ri "newlkiag\|newlift\|newton\|zendesk" developers/` must return nothing.

Each tutorial is a `<Steps>` build-up with complete, runnable code. Required coverage: first-app (extends getting-started into a real project layout with tsup + scripts); defining-contexts (semantic embedder context vs always-include memory context — two complete context definitions, e.g. `support_tickets_context` for "a ticketing system" and `team_memory_context`); data-sources-and-sync (source with cron schedule/queue/retries/backoff, execute returning `ExuluItem[]`, hash-based incremental sync via `external_id` upserts); custom-processors (trigger, queue, `generateEmbeddings: true`, filter pattern, document→JSON processing example); queues-and-workers (register embedder queue sized to a rate limit, worker process scoping `workers.create(["my_queue"])`, 8GB memory note); custom-tools (zod inputSchema, `{result}` JSON, config params, streaming AsyncGenerator variant); oauth-tools (ExuluOauthConfig, authorization URL fallback, `inputs.oauth` token use); running-evals (ExuluEval definition, eval_runs queue, scoring contract); mcp (enable MCP, `/mcp/:agent` endpoint, connecting a client).

Commit: `git commit -m "feat: add Developers tutorials"`

---

### Task 23: Developers — recipes

**Files:**
- Create: `developers/recipes/s3-backed-context.mdx`, `api-sync-ticketing.mdx`, `sql-source.mdx`, `incremental-sync.mdx`
- Modify: `docs.json` (group `Recipes`)

Same abstraction rules and grep gate as T22. Recipes are shorter than tutorials (one problem, one complete solution): s3-backed-context (list bucket, hash files, presigned URLs for processing); api-sync-ticketing (paginated incremental fetch with retry/rate-limit handling, mapping to ExuluItem); sql-source (connection pooling, querying rows into items); incremental-sync (hash comparison + external_id upsert semantics in depth).

Commit: `git commit -m "feat: add Developers recipes"`

---

### Task 24: API Reference — SDL emission + GraphQL section

**Files:**
- Create: `../backend/scripts/print-sdl.ts` (committed to the **backend** repo)
- Create: `scripts/emit-graphql-sdl.mjs`, `api-reference/graphql/schema.graphql` (generated)
- Create: `api-reference/graphql/introduction.mdx`, `conventions.mdx`, `dynamic-types.mdx`, `vector-search.mdx`
- Modify: `package.json` (`"sdl": "node scripts/emit-graphql-sdl.mjs"`), `docs.json` (API Reference tab, group `GraphQL`)

**Interfaces:**
- Produces: `api-reference/graphql/schema.graphql` — the ground truth for T25's core-type pages.

- [ ] **Step 1: Write `../backend/scripts/print-sdl.ts`** (in the backend repo, committed there on `develop`):

```typescript
// Emits the core GraphQL SDL for documentation. Usage:
//   npx tsx scripts/print-sdl.ts /path/to/out/schema.graphql
// Run with the EE license env set so license-gated tables are included.
import { writeFileSync } from "node:fs";
import { printSchema } from "graphql";
import { createSDL } from "../src/graphql/schemas/index";
import { coreSchemas } from "../src/postgres/core-schema";

const out = process.argv[2];
if (!out) throw new Error("usage: tsx scripts/print-sdl.ts <outfile>");

const schema = createSDL(
  Object.values(coreSchemas),
  [], // contexts — dynamic per deployment, documented as patterns
  [], // providers
  [], // tools
  {} as never, // config — not needed for SDL shape
  [], // evals
);
writeFileSync(out, printSchema(schema));
console.error(`SDL written to ${out}`);
```

Adjust imports/typing to compile (`npx tsx scripts/print-sdl.ts /tmp/schema.graphql` from `../backend`; if module side effects require env, run with the backend's `.env` present; if `Object.values(coreSchemas)` doesn't match the 24-table list `routes.ts` passes, mirror the exact list from `routes.ts`). Fallback if imports drag in un-runnable side effects: start the backend dev server and introspect `POST /graphql` with `x-api-key` using `get-graphql-schema`; either path must produce the same artifact.

- [ ] **Step 2: Write `scripts/emit-graphql-sdl.mjs`** (docs repo):

```js
// Regenerates api-reference/graphql/schema.graphql from the backend checkout.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = process.env.BACKEND_REPO ?? join(ROOT, "..", "backend");
const OUT = join(ROOT, "api-reference", "graphql", "schema.graphql");

if (!existsSync(join(BACKEND, "scripts", "print-sdl.ts")))
  throw new Error(`backend checkout with scripts/print-sdl.ts not found at ${BACKEND}`);
execSync(`npx tsx scripts/print-sdl.ts ${OUT}`, { cwd: BACKEND, stdio: "inherit" });

// sanity: parse + count types
const { buildSchema } = await import("graphql");
const { readFileSync } = await import("node:fs");
const schema = buildSchema(readFileSync(OUT, "utf8"));
const typeCount = Object.keys(schema.getTypeMap()).filter((t) => !t.startsWith("__")).length;
console.log(`schema.graphql OK — ${typeCount} named types`);
```

Run it; expected: `schema.graphql OK — <n> named types` with n comfortably > 100 (24 entities × type+input+filters+pagination + operations).

- [ ] **Step 3: Write the four GraphQL MDX pages.** Harvest `../backend/mintlify-docs/api-reference/{introduction,queries,mutations,dynamic-types}.mdx` (pattern-based approach is correct — keep it), re-verify every claim against the emitted SDL:
  - `introduction.mdx` — endpoint `POST /graphql`; three auth methods exactly (header `x-api-key` or `exulu-api-key` with format `sk_xxx…/keyname`; `Authorization: Bearer <NextAuth HS256 JWT>`; `internal` header with INTERNAL_SECRET); introspection requires auth; `/explorer` playground; no subscriptions — streaming lives on REST (link).
  - `conventions.mdx` — merged queries+mutations pattern doc: per-entity CRUD naming table (`{singular}ById`, `{singular}ByIds`, `{singular}One`, `{plural}Pagination(limit, page, filters, sort)`, `{plural}Statistics`; `{plural}CreateOne(input, upsert)`, `{plural}CopyOneById`, `{plural}UpdateOne`, `{plural}UpdateOneById`, `{plural}RemoveOne(ById)`) with one fully worked example per group; filter operator inputs per type (String eq/ne/in/contains/and/or; Date lte/gte; Float; Boolean; JSON; enums); sorting/pagination; RBAC field + row-level access behavior; computed fields (agent providerName/modelName/…, `budget: JSON` on user/role/team/project/agent/workflow_template).
  - `dynamic-types.mdx` — how each ExuluContext becomes an items type + operations (VectorSearch, ChunkById, GenerateChunks, ExecuteSource, ProcessItem(s), entity ops); license-gated tables; QueueEnum runtime population; "your deployment's schema ≠ this reference" framing.
  - `vector-search.mdx` — `{plural}VectorSearch` deep dive: methods `cosineDistance|hybridSearch|tsvector`, cutoffs, expand{before,after}, entity filters/insights, worked queries with realistic values.

- [ ] **Step 4: Wire nav; verify** — `mint validate && mint broken-links`; commit both repos: backend `git commit -m "feat: add print-sdl script for docs generation"`, docs `git commit -m "feat: add GraphQL API reference with generated core SDL"`

---

### Task 25: API Reference — core types per entity

**Files:**
- Create: `api-reference/graphql/core-types/<entity>.mdx` for the 24 exposed entities (users, agents, agent-sessions, agent-messages, models, projects, skills, variables, platform-configurations, prompt-library, prompt-favorites, context-presets, entity-type-settings, transcription-jobs, statistics, feedback, roles, teams, rbac, test-cases, eval-sets, eval-runs, workflow-templates, job-results)
- Modify: `docs.json` (group `Core types`, `"expanded": false`)

For each entity: SDL block **copied from the generated `schema.graphql`** (not hand-transcribed), field notes for non-obvious fields (`rights_mode`, `created_by`, `_s3key` suffixes, `last_processed_at`, `embeddings_updated_at`), one realistic example query, edition badge for license-gated entities (feedback, roles/teams/rbac, evals trio, workflow_templates, job_results). Harvest field notes from `mintlify-docs/api-reference/core-types/*.mdx` where still accurate. Verification: a small check that every SDL block matches the generated schema — `node -e` script comparing each page's fenced `graphql` block against `schema.graphql` text (add as `scripts/verify-sdl-blocks.mjs`, run it; expected "24/24 pages match").

Commit: `git commit -m "feat: add GraphQL core type reference for all 24 entities"`

---

### Task 26: API Reference — REST OpenAPI spec part 1 (agents, sessions, media)

**Files:**
- Create: `openapi/openapi.json` (info + auth schemes + first path set)
- Create: `api-reference/rest/introduction.mdx`
- Modify: `docs.json` (group `REST` with `"openapi": "/openapi/openapi.json"` at group level)

Sources: `../backend/src/exulu/routes.ts` (read the actual route handlers for verbs, params, bodies, responses), `../backend/src/uppy/index.ts`.

- [ ] **Step 1: Author the spec skeleton + auth:**

```json
{
  "openapi": "3.1.0",
  "info": {
    "title": "IMP REST API",
    "version": "1.0.0",
    "description": "REST endpoints of the IMP backend. GraphQL covers entity CRUD; REST covers agent runs, media, files, budgets, and gateways."
  },
  "servers": [{ "url": "{baseUrl}", "variables": { "baseUrl": { "default": "http://localhost:9001" } } }],
  "components": {
    "securitySchemes": {
      "apiKey": { "type": "apiKey", "in": "header", "name": "x-api-key", "description": "API key in the form sk_xxx…/keyname." },
      "bearer": { "type": "http", "scheme": "bearer", "bearerFormat": "JWT", "description": "NextAuth session JWT." }
    }
  },
  "security": [{ "apiKey": [] }, { "bearer": [] }],
  "paths": {}
}
```

- [ ] **Step 2: Add paths** (each authored from the actual handler — parameters, request bodies, response shapes, streaming noted in description): agent run `POST /agents/litellm/run/{instance}` (+ header `stream`, `session`, `x-exulu-model-override`), `POST /agents/litellm/compact/{instance}`, `POST /agents/suggestions/{agentId}`; session files (`GET/POST/DELETE /sessions/{sessionId}/files…`, preview-pdf); `POST /transcribe` (multipart 25MB), `POST /speech`; `POST /images/generate|edit|select`, `GET /images/history`; `GET /ping`, `GET /theme`, `GET /config`. One complete worked example (`POST /agents/litellm/run/{instance}`) with request/response JSON.
- [ ] **Step 3:** `api-reference/rest/introduction.mdx` — auth (same three methods), base URL, streaming semantics (AI SDK UIMessage stream), when to use REST vs GraphQL.
- [ ] **Step 4: Verify** — `mint validate` (Mintlify parses the spec and generates pages; fix any spec validation errors it reports); check generated endpoint pages render in `mint dev`.
- [ ] **Step 5: Commit** — `git commit -m "feat: add REST OpenAPI reference (agents, sessions, media)"`

---

### Task 27: API Reference — REST part 2 + gateways

**Files:**
- Modify: `openapi/openapi.json` (remaining paths)
- Create: `api-reference/rest/gateways-openai.mdx`, `api-reference/rest/gateways-anthropic.mdx`, `api-reference/rest/mcp.mdx`, `api-reference/rest/gdpr.mdx`
- Modify: `docs.json` (append pages to REST group)

Paths to add: budgets admin (`GET/PUT /admin/budgets/settings`, `PUT /admin/budgets/{entityType}/bulk`, `PUT/DELETE /admin/budgets/{entityType}/{entityId}`, `GET /me/budget`, `GET /admin/litellm/tag-activity`); skills (~14 endpoints `/skills/registry…`, `/skills/{skillId}/…` — enumerate from routes.ts); uploads (`/s3/sign`, `/s3/multipart…`, `/s3/list`, `/s3/download`, `/s3/sts`); GDPR (`GET /users/{id}/data-export`, `DELETE /users/{id}`); shared artifacts (`/shared-artifacts…`).

Gateway pages (manual MDX, not OpenAPI): `gateways-openai.mdx` — `/gateway/open-ai/v1/models`, `/chat/completions`, `/completions`: OpenAI-compatible surface, point any OpenAI SDK at IMP (worked example with the `openai` npm client + baseURL + api key); `gateways-anthropic.mdx` — `/gateway/anthropic/{agent}/{project}`; `mcp.mdx` — `POST /mcp/{agent}` Streamable HTTP, connecting Claude/other MCP clients (worked config example); `gdpr.mdx` — concept + how-to for export/delete (note: API-only, no UI; links from User Guide deliberately absent per spec).

Verify + commit: `git commit -m "feat: complete REST reference and gateway docs"`

---

### Task 28: Changelog generation

**Files:**
- Create: `scripts/build-changelog.mjs`, `changelog/index.mdx` (generated)
- Modify: `package.json` (`"changelog": "node scripts/build-changelog.mjs"`), `docs.json` (Changelog tab: `{ "group": "Changelog", "pages": ["changelog/index"] }`)

- [ ] **Step 1: Write `scripts/build-changelog.mjs`:**

```js
// Generates changelog/index.mdx from the release pipeline's structured output.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.env.RELEASES_JSON ?? join(ROOT, "..", "backend", "releases", "_build", "releases.json");
const releases = JSON.parse(readFileSync(SRC, "utf8"));

const fmtDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
const clean = (s = "") => s.replace(/Exulu/g, "IMP").replace(/\s+/g, " ").trim();
const releaseName = (slug) => clean(slug.slice(11).replace(/-/g, " ")).replace(/\b\w/g, (c) => c.toUpperCase());

const updates = [...releases]
  .sort((a, b) => (a.date < b.date ? 1 : -1))
  .map((r) => {
    const feats = (r.sections ?? [])
      .map((s) => `### ${clean(s.heading)}\n\n${clean(s.oneLiner)}`)
      .join("\n\n");
    return `<Update label="${fmtDate(r.date)}" description="${releaseName(r.slug)}">\n\n${feats}\n\n</Update>`;
  })
  .join("\n\n");

writeFileSync(join(ROOT, "changelog", "index.mdx"),
`---
title: "Changelog"
description: "What shipped in IMP, release by release."
mode: "wide"
---

{/* GENERATED by scripts/build-changelog.mjs — do not hand-edit. */}

${updates}
`);
console.log(`changelog/index.mdx written — ${releases.length} releases`);
```

- [ ] **Step 2: Run + verify** — `node scripts/build-changelog.mjs`; expected `changelog/index.mdx written — 23 releases`. `mint validate` clean; spot-check: no "Exulu" remains in entry text, headings/one-liners read correctly, newest release first.
- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat: generate changelog from release pipeline"`

---

### Task 29: Launch QA sweep

**Files:**
- Create: `UPSTREAM-NOTES.md` (repo root, `.mintignore`d — add the line)
- Modify: anything the sweep flags

- [ ] **Step 1: Automated gates**

```bash
mint validate && mint broken-links && mint a11y
node scripts/check-tokens.mjs
grep -rin "newlkiag\|newlift\|newton\|zendesk" --include="*.mdx" --include="*.html" --include="*.json" . && echo "FAIL: client names" || echo "confidentiality OK"
grep -rin "7033ff\|8b5cf6\|a78bfa\|7c3aed\|9061ff\|b192ff" --include="*.mdx" --include="*.css" --include="*.html" --include="*.json" . && echo "FAIL: purple" || echo "palette OK"
grep -rin "exulu imp" --include="*.mdx" . && echo "FAIL: naming" || echo "naming OK"
```
Expected: all gates pass. Fix anything flagged.

- [ ] **Step 2: Navigation audit** — every `.mdx` file (except snippets/) appears in `docs.json`; no orphans: `node -e` script listing `.mdx` files missing from docs.json navigation. Terminology spot-check: grep for retired terms (`"Vault"`, `"Workflows"` used for routines, `"knowledge base"` where "Knowledge"/"context" is meant) and fix.
- [ ] **Step 3: Visual sweep** — `mint dev`; check in light AND dark mode: landing, one page per tab, changelog, a generated OpenAPI page, embedded videos play muted/looping. Squared corners, olive/lime accents, Aspekta headings everywhere.
- [ ] **Step 4: Write `UPSTREAM-NOTES.md`** — the engineering flags from the spec: no `/health` endpoint or container healthchecks; `example` compose references missing `postgres/schema.sql`; S3 bucket bootstrap undocumented/manual; backend README env-var section wrong (`DATABASE_URL`); SMTP var naming inconsistency; package version scheme (`0.3.13-development`) vs old docs' 1.4x line — confirm public versioning before announcing.
- [ ] **Step 5: Final commit** — `git add -A && git commit -m "chore: launch QA sweep"`. Then (human/dashboard steps, listed for the operator, not automated): create the GitHub repo under Qventu, push `main`, install the Mintlify GitHub app, verify preview deployment, repoint docs.exulu.com, then retire `backend/mintlify-docs` in a separate backend PR that also adds `redirects` to the new docs.json for the old URL paths (`/getting-started`, `/core/exulu-agent/*` → `/developers/core/exulu-provider/*`, `/api-reference/*` → `/api-reference/graphql/*`).

---

## Self-Review

**Spec coverage:** 8 tabs → T2 (Get Started), T5–T7 (User Guide), T8–T10 (Building), T11 (Administration), T14–T16 (Self-Hosting), T17–T23 (Developers), T24–T27 (API Reference), T28 (Changelog). Mockup kit + pipeline → T3–T4; static mockups embedded per UI task; ~15 key-flow animations → T12–T13. Theming → T1. Snippets/rights-callouts → T2, used throughout. OpenAPI replacement of Plant Store → T26–T27. SDL generation → T24. Harvest verdicts respected (T17–T21, T24–T25 harvest; starter content never copied). Known gaps → T29 UPSTREAM-NOTES. Launch/redirects/retirement → T29 Step 5. ✓

**Placeholder scan:** CLI-flag discovery steps (T4 Step 1, T24 Step 1 fallback) are explicit verification steps against external tools with concrete fallbacks, not placeholders. Content tasks carry per-page requirement lists + a full worked page pattern (T5 Step 2) rather than full prose for ~90 pages — the prose is the deliverable of each task, produced from named sources under the Global Constraints. ✓

**Type consistency:** kit class names (`.imp-*`) defined in T3 and used in T5–T13; `RightsCallout` props (`right`, `flags`) defined in T2, used in T5–T11; render script contract (`images/mockups/<slug>.png`, `videos/<slug>.mp4`, `meta.json.video`) defined in T4, consumed in T5–T13; `schema.graphql` produced in T24, consumed in T25; docs.json tab names fixed in T1 and referenced verbatim throughout. ✓
