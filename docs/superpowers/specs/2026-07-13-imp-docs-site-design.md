# IMP Documentation Site — Design

**Date:** 2026-07-13
**Status:** Approved (brainstorm complete, pending implementation plan)
**Location of new project:** `/Users/daniel.claessen/Desktop/Projects/exulu/exulu-docs` (currently empty; becomes its own git repo)

## Goal

A client-facing documentation website for IMP (Intelligence Management Platform), built with Mintlify, covering five audiences: regular users, power users, admins, devops (self-hosting), and developers consuming the `@exulu/backend` npm package and its GraphQL/REST API. It replaces the existing, four-months-stale `backend/mintlify-docs` site (docs.exulu.com).

## Decisions (from brainstorm Q&A)

| Decision | Choice |
|---|---|
| Publishing | Public on Mintlify cloud; `docs.exulu.com` repointed to the new repo when ready |
| Language | English only (i18n possible later) |
| Scope | Full build for all five audiences in this project |
| Visuals | Static mockups for every documented screen + animated MP4s for ~15 key flows |
| Relation to existing docs | **Replace** `backend/mintlify-docs`; harvest still-accurate content as seed material; retire the old folder after launch (separate backend-repo cleanup) |
| Product naming | **"IMP" only** as product name throughout; Exulu appears only as the company (footer/imprint). Header lockup: Exulu icon mark + "IMP Docs" |
| Approach | Fresh audience-first IA + shared mockup component kit (Approach A) |

## Site structure (8 Mintlify tabs)

Navigation uses the product UI's exact terminology: **Agents, Knowledge** (route `/data`, entities "contexts" and "items"), **Prompts, Skills, Routines** (route `/workflows`), **Evals / Test cases, Transcripts** (route `/transcriptions`), **Variables, Automation** (n8n), **Theme** (route `/configuration`), **Users & access** (Users · Roles · Teams tabs).

1. **Get Started** — What is IMP · Core concepts (agents, knowledge, sessions, projects, budgets) · Community vs Enterprise edition · "Where do I start?" role router page.
2. **User Guide** (regular users) — Chat (~12 pages: choosing an agent, conversations & history, attachments & session files, mic dictation, inserting prompts, pinned knowledge & context presets, tool-call approvals, budgets in chat, context compaction, image generation, artifacts & sharing, model override, conversation search) · Projects (workspaces: sessions/files/instructions/access) · Transcripts (audio upload, meeting bots via Recall, review & speaker rename, save to Knowledge) · Personal settings (appearance, language, personal system prompt).
3. **Building** (power users) — Agents (workbench: Basics, Instructions, Knowledge & memory, Tools & skills, Chat experience, Appearance, Safety, Access, Developer) · Knowledge (contexts, items, pipeline: Sources → Processor → Embedder, entities, item detail) · Prompts (library, versioning, variables, sharing) · Skills (packages, file editor, versions, connect-your-agent) · Routines (created from chat via "Save as Routine"; runs, schedules/cron, queue, steps) · Evals (eval sets, test cases, runs, queue management) · Automation (n8n embed) · Feedback review.
4. **Administration** — Users & access (users table, roles permission matrix, teams) · Models (read-only LiteLLM catalog + LiteLLM Admin UI) · Budgets (per user/role/team/project/agent, at-risk view, default policy, reset dates) · Analytics (super-admin) · Variables (secret vs plain, usage tracking) · Theme (white-label studio) · API keys & personal tokens.
5. **Self-Hosting** (devops) — Architecture overview · Requirements (Node exactly 22.18.0, Postgres 13+ with pgvector, versions matrix) · Docker Compose quickstart (walkthrough of the `example` repo's 4 compose files) · Service guides: Postgres+pgvector, Redis (workers only), MinIO/S3, **LiteLLM proxy** (dedicated page: supervisor lifecycle, `config.litellm.yaml` incl. custom `model_info` fields, mandatory dedicated database + data-loss guard, budgets role, admin UI at `/litellm-admin`), Whisper GPU container, SMTP (OTP auth), SigNoz (OTel) · Backend & worker containers (Dockerfiles, NPM_TOKEN license build-arg, bwrap seccomp/apparmor-unconfined explanation) · Environment variable reference (~47 vars, synthesized from source — no accurate single source exists today) · Database init & upgrades (idempotent `utils:initdb` on every boot, first-boot admin credentials + one-time API key) · Scaling & operations (server/worker split, queue tuning, 8GB worker memory) · Troubleshooting.
6. **Developers** (npm package) — Package setup & licensing (private registry, NPM_TOKEN) · Getting started (minimal app: `new ExuluApp().create({...})`, `app.express.init()`, separate worker via `app.bullmq.workers.create()`) · **Core classes** — every export of `src/index.ts`. Full introduction/configuration/api-reference triples for the heavyweight surfaces: ExuluApp, ExuluContext, ExuluTool, ExuluProvider, ExuluEval, ExuluQueues, ExuluChunkers, ExuluDatabase. Single reference pages for the smaller namespaces/utilities: ExuluJobs, ExuluDefaultTools, ExuluDefaultProviders, ExuluVariables, ExuluAuthentication, ExuluDocumentProcessor, ExuluReranker, ExuluOtel, ExuluPython, ExuluReadApi, ExuluStorage, ExuluMCP, ExuluTokenizer, plus functions (defaultChunker, enableLiteLLMClientMode, postgresClient) and enums/shipped types on a shared page · Tutorials (first app, defining contexts, data sources & sync, custom processors, queues & workers, custom tools, OAuth tools, evals, MCP) · Recipes (S3-backed contexts, ticket-system API sync, SQL sources, incremental sync via hash/external_id).
7. **API Reference** — GraphQL: introduction (endpoint `POST /graphql`, three auth methods, `/explorer` playground), conventions of the generated CRUD schema (`{singular}ById`, `{plural}Pagination`, `{plural}CreateOne`…, filter/sort/pagination inputs), core types per entity (24 exposed tables), dynamic context types (vector search, chunks, entities, processing mutations), jobs/queues operations; **no subscriptions exist** — do not promise real-time GraphQL · REST via authored OpenAPI spec: agent run/stream + compact + suggestions, transcribe, speech, images, budgets admin, skills registry, session files, uploads (Uppy/S3 companion), GDPR export/delete, shared artifacts · Gateways: OpenAI-compatible (`/gateway/open-ai/v1/*`), Anthropic gateway, MCP endpoint (`POST /mcp/:agent`).
8. **Changelog** — generated from `backend/releases/_build/releases.json` (23 releases, 2026-05-24 → 2026-07-13) as Mintlify `<Update>` entries; the release pipeline feeds it going forward.

Cross-cutting IA rules:

- Every page states its required right / config flag in a consistent snippet callout (RBAC rights: agents, workflows, variables, users, api, evals, budget_management × read/write + super_admin; config flags: Transcripts, Automation/N8N_URL, Send feedback/FEEDBACK_ENABLED).
- Cross-surface flows get explicit pages: chat → Save as Routine, Transcripts → Knowledge, prompts appearing in 4 surfaces, budgets set in Administration surfacing as chips in chat.
- GDPR export/delete has no UI — documented under API Reference, not the User Guide.

## Content sourcing & writing rules

Ground truth per tab:

| Tab | Sources |
|---|---|
| User Guide / Building / Administration | `frontend/components/shell/nav-config.ts` (nav + RBAC single source of truth), page components, `frontend/messages/en.json` (UI strings verbatim), `frontend/design/pages/*.md` (verify against current components — "Current state" sections predate the redesign) |
| Self-Hosting | `example` repo (compose files, Dockerfiles, `config.litellm.yaml`, start scripts, README), `selise/.env.example` (best-annotated env template), `backend/docker/whisper/README.md` (docs-quality, port nearly verbatim), source comments in `backend/src/exulu/litellm/supervisor.ts`, `db-init.ts`, `backend/src/postgres/init-exulu-db.ts` |
| Developers | `backend/src/index.ts` + class source files; harvest existing `mintlify-docs/core/` (~56k words) where audit verdict = UPDATE, re-verify line-by-line; resolve ExuluAgent→ExuluProvider naming drift; tutorials abstracted from the reference implementation at `/Users/daniel.claessen/Desktop/Projects/newlkiag` with ALL identifying names genericized |
| API Reference | `backend/src/graphql/schemas/index.ts` (`createSDL()`), `backend/src/exulu/routes.ts` (~70 REST endpoints), `backend/src/validators/requests.ts` (auth); existing pattern-based GraphQL docs updated |
| Changelog | `backend/releases/_build/releases.json` |

Writing rules:

- **Diátaxis split**: task-oriented how-tos for UI audiences; concept pages for mental models (knowledge pipeline, budgets, RBAC); pure reference for classes/API/env vars. No page mixes genres.
- Second person, present tense; Mintlify components (Steps, Tabs, Accordion, ParamField, ResponseField, Frame, Update) over raw markdown walls.
- Every UI claim traces to a frontend component or i18n string; every code sample is valid against the current package; every env var against actual `process.env` reads.
- Fix known drift instead of copying it (README's `DATABASE_URL` claim is wrong — actual vars are `POSTGRES_DB_HOST/PORT/USER/PASSWORD/SSL/NAME`; SMTP var naming per code: `SMTP_USER`/`SMTP_FROM`/`SMTP_SECURE`).
- **Confidentiality**: newlkiag/newlift/client names never appear; recipes use generic integrations ("a ticketing system", "a document archive").
- Mockup content: "IMP" branding, invented users/agents, neutral data.

## Visual & mockup pipeline

`mockups/` inside the docs repo is a HyperFrames project (excluded from Mintlify serving via `.mintignore`):

- **Generated token stylesheet**: `scripts/extract-tokens.mjs` extracts brand tokens from `frontend/app/globals.css` into `mockups/tokens.css`. Never hand-transcribe (the purple→lime reskin needed a 67-entry regex map to fix drift).
- **Shared replica kit** (`mockups/kit/`): scoped-CSS partials factored from release compositions — app shell (sidebar + topbar), data table, dialog, chat column + composer, stat cards, command box, toast, simulated cursor + click ripple. New mockups compose the kit.
- **Static mockups**: one composition per documented screen → build-time 2x PNGs via HyperFrames snapshot tooling → `images/`, embedded with `<Frame>`. Light mode first; dark variants only for hero images.
- **Key-flow animations**: ~15 flows, at least one per major surface — candidates: create an agent, pin knowledge in chat, approve a tool call, share an artifact, create a project, record a meeting, save a routine, run an eval, upload a skill, create a context + run its pipeline, set a budget, assign a role, white-label the theme, generate an image, use the command palette. The final list is fixed in the implementation plan after auditing which of the 67 existing shorts are reusable. Each: 4–10s MP4s, hook→demo→payoff grammar with read-time floors (1.0–1.8s) and 600ms post-action breaths (per `releases` animation-recipes), encoded libx264 CRF 27 / max 1080p / muted / +faststart, embedded muted+looping with pause-when-offscreen. Audit the 67 existing lime-CI shorts first and reuse the still-accurate ones.
- **Regeneration**: mockups are source-controlled HTML; `scripts/render-mockups.mjs` re-renders all images/videos after UI changes.
- Mockups replicate the **product UI theme** (warm surfaces + lime accent — current frontend CI); docs chrome uses the **website CI**. Same design family, coherent pages.

## Docs chrome theming (website CI → Mintlify)

Via `docs.json` + restrained custom `styles.css` (tokens only — colors, fonts, radius — not fighting Mintlify internals):

- **Colors**: light bg bone `#f8f6f1`; dark bg ink `#222f30` / void `#1b1714`; primary accent olive `#6f9a37` (light) / lime `#cef79e` (dark); hairlines `#e4ddd0` / `#4d5757`. **No violet/purple anywhere.**
- **Typography**: self-hosted Aspekta (`inter-tight-400.woff2`) for headings (−0.03em tracking) and body; RobotoMono for code, badges, nav group labels (uppercase, 12–13px, wide tracking). Font files copied from `exulu-website/web/public/fonts` into the docs repo.
- **Shape**: `border-radius: 0`, hairline 1px borders, no shadows ("squared aesthetic" rule from website `globals.css`).
- **Branding**: Exulu icon mark + "IMP Docs" lockup; light/dark wordmark variants from `exulu-website/web/public/logo/`; `exulu-icon-light.svg` favicon; Exulu-as-company only in footer.
- **Kept from old docs**: AI-native contextual menu (copy page / Claude / ChatGPT / Cursor / MCP), Lucide icons, `<Update>` changelog format.

## Repo layout & tooling

```
exulu-docs/                      (new git repo)
  docs.json  styles.css  index.mdx  .mintignore  AGENTS.md
  get-started/  user-guide/  building/  administration/
  self-hosting/  developers/  api-reference/  changelog/
  snippets/                      reusable MDX (rights-callouts, edition badges)
  images/  videos/  fonts/  logo/
  openapi/openapi.json           authored REST spec
  mockups/                       HyperFrames project (.mintignore'd)
    tokens.css  kit/  compositions/
  scripts/
    extract-tokens.mjs           frontend globals.css → mockups/tokens.css
    render-mockups.mjs           compositions → images/ + videos/
    emit-graphql-sdl.mjs         backend createSDL() → schema.graphql + core-type MDX
    build-changelog.mjs          backend releases.json → changelog entries
```

- Dev loop: `mint dev` local preview; `mint broken-links` gate before every push (old docs shipped dead anchors — `/quickstart`, `#1-47-0`).
- Generated content is **committed**, not built at deploy; the scripts are refresh tools.
- `emit-graphql-sdl.mjs` documents the **core** schema and labels deployment-specific parts (dynamic context types, license-gated tables, runtime QueueEnum) as patterns.
- Deployment: push to GitHub (Qventu org) → Mintlify GitHub app auto-deploy → repoint `docs.exulu.com` when ready → retire `backend/mintlify-docs` in a separate backend-repo cleanup.

## Existing-content harvest verdicts (from audit)

- **UPDATE (harvest + re-verify)**: `core/` class docs (~56k words, best asset), GraphQL `api-reference/{introduction,queries,mutations,dynamic-types}` + `core-types/` split, `getting-started` + guides skeletons, editions pages (content only — rebuild with Mintlify components), changelog structure.
- **DISCARD**: all Mintlify starter leftovers (`essentials/`, `ai-tools/`, `snippets/snippet-intro`, `api-reference/endpoint/*`, Plant Store `openapi.json`, `development.mdx`, `products.mdx`, orphaned `api-reference/core-types.mdx` monolith, starter README/AGENTS/LICENSE), `frontend/introduction.mdx` stub, violet palette.
- **NEW (no existing source)**: entire User Guide / Building / Administration tabs, Self-Hosting tab (biggest greenfield), pages for LiteLLM, budgets, routines, transcription/speech, artifacts, skills, teams, OAuth tools, image generation, gateways, ExuluStorage/ExuluMCP/ExuluTokenizer.

## Known gaps to flag during implementation

- No backend `/health` endpoint and no container healthchecks — ops docs can only point at `/` today; flag to engineering rather than inventing.
- No Terraform/Helm/K8s anywhere — Self-Hosting documents Docker Compose (+ Dokploy note) only.
- `example` compose references a non-existent `postgres/schema.sql`; S3 bucket bootstrap is undocumented/manual — verify against the example repo while writing and flag upstream fixes.
- Backend package version is `0.3.13-development` while old docs referenced a 1.4x line — confirm the published version scheme before writing version references.

## Success criteria

- All 8 tabs populated; no Mintlify starter content anywhere; `mint broken-links` clean.
- Every documented screen has an accurate mockup; ~15 key flows animated.
- Every core-class page verified against current `src/` (no ExuluAgent-style drift).
- Site renders in the website CI (bone/ink/lime, zero radius, Aspekta/RobotoMono) in light and dark mode.
- No client/project names from reference implementations anywhere.
