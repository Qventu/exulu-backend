# IMP Docs Site Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `mintlify-docs/` up to date with everything shipped June 22 – July 23, 2026 (spec: `docs/superpowers/specs/2026-07-23-imp-docs-update-design.md`).

**Architecture:** Page-major docs update in five phases: (1) Developers-tab auth rewrite, (2) API reference regeneration + core types, (3) eleven new pages + nav, (4) existing-page sweep, (5) self-hosting. Each file is edited exactly once with all changes consolidated. Every task follows the docs TDD cycle: verify facts against shipped code → locate the stale text → edit → validate with greps → commit.

**Tech Stack:** Mintlify (MDX + `docs.json` nav), backend repo `develop` (source of truth for all backend claims), frontend repo at `/Users/daniel.claessen/Desktop/Projects/exulu/frontend` on `main` (read-only, for UI claims).

## Global Constraints

- **Work in a worktree.** Parallel sessions use the primary checkouts; create a sibling worktree off `develop` on branch `docs/imp-docs-update` via superpowers:using-git-worktrees before Task 1. All paths below are relative to that repo root.
- **Follow `mintlify-docs/AGENTS.md`** (read it first). In particular: product name is "IMP" (Exulu = company, footer only; never client names); navigation lives ONLY in `docs.json`; UI pages start with the `RightsCallout` snippet (`snippets/rights-callout.mdx`) — mirror how sibling pages import/use it on every new Phase-3 UI page; generated files (`schema.graphql` via `npm run sdl`) are regenerated, never hand-edited.
- **House gates** (run from `mintlify-docs/`): `npx mint validate && npx mint broken-links`. Wherever this plan says "link check", run both. Core-type page edits additionally run `npm run verify-sdl` (asserts every ```graphql `type` block matches `schema.graphql` verbatim — so SDL blocks are COPIED from the regenerated schema, never hand-typed).
- **Verify before writing.** Every factual claim is checked against shipped code in the step-1 commands. The spec/audit line numbers date from the 2026-07-15 snapshot — always re-locate stale text by grepping the quoted words, never by line number.
- **One edit per file.** No file appears in two tasks. If you find yourself reopening a file from an earlier task, stop — the change belongs in that file's task.
- **Never touch** `mintlify-docs/changelog/`, `docs/releases/`, or `mintlify-docs/scripts/build-changelog.mjs` (out of scope by decision).
- **Never hand-edit** `mintlify-docs/api-reference/graphql/schema.graphql` — regenerate via the Task 8 script only.
- **IMP naming** in all new prose (no bare "Exulu" except in code identifiers like `ExuluTool`, which keep their real names).
- **Match the tab's voice**: reuse each tab's existing frontmatter style, Mintlify components (`ParamField`, `Note`, `Card`, `Accordion`), and heading depth. Look at a sibling page before writing.
- **Commit per task**, message prefix `docs(mintlify): …`, and verify the branch in the same command: `[ "$(git branch --show-current)" = "docs/imp-docs-update" ] && git add … && git commit …`. Every commit step below implies this guard.
- Full audit evidence (verbatim stale quotes, git hashes): `~/.claude/projects/-Users-daniel-claessen-Desktop-Projects-exulu-backend/49ffbe01-5698-44f1-a58e-4afcec956adc/tool-results/docs-gap-audit-full.json`.
- `FRONTEND=/Users/daniel.claessen/Desktop/Projects/exulu/frontend` (read-only; never modify, never switch its branch).

---

## Phase 1 — Developers tab: authentication rewrite

### Task 1: `developers/core/exulu-tool/configuration.mdx` — Authentication section rewrite

**Files:**
- Modify: `mintlify-docs/developers/core/exulu-tool/configuration.mdx`

**Interfaces:**
- Produces: the canonical Authentication section other pages link to as `/developers/core/exulu-tool/configuration#authentication`.

- [ ] **Step 1: Verify the shipped API**

```bash
grep -n "authentication" src/exulu/tool.ts | head -20
grep -n "authType" src/exulu/auth/types.ts
grep -n "BACKEND" src/exulu/auth/validate.ts
grep -n "inputs.credentials\|inputs.oauth" src/exulu/auth/wrap-execute.ts
```

Expected: `tool.ts` declares `authentication?: ExuluAuthConfig` (constructor option + public property, ~line 43/82); `types.ts` shows the union `ExuluAuthConfig = ExuluOauthConfig | ExuluUserCredentialsConfig` tagged by `authType`, plus `CredentialField` (`{name, label, type: "text"|"password", placeholder?, help?}`); `validate.ts` requires the `BACKEND` env var and rejects duplicate/invalid fields; `wrap-execute.ts` injects `inputs.oauth` and `inputs.credentials`. Record the exact type shapes — they go into the page verbatim.

- [ ] **Step 2: Locate the stale content**

```bash
grep -n "oauth" mintlify-docs/developers/core/exulu-tool/configuration.mdx
```

Expected: hits in the frontmatter description ("…needsApproval, oauth, and execute"), a `<ParamField path="oauth" type="ExuluOauthConfig">`, and a `type ExuluOauthConfig = {` block without `authType`.

- [ ] **Step 3: Edit**

1. Frontmatter description: replace `oauth` with `authentication` in the option list.
2. Replace the OAuth section with an **Authentication** section:
   - `<ParamField path="authentication" type="ExuluAuthConfig">` — discriminated union tagged by `authType`.
   - Sub-section **OAuth** (`authType: "oauth"`): config shape from `types.ts` including the required `authType` tag; behavior unchanged — token injected as `inputs.oauth = {accessToken, expiresAt, scopes}`; no-token short-circuit returns a structured `oauth: { authorizationUrl }` that chat renders as a Connect card.
   - Sub-section **User credentials** (`authType: "user_credentials"`): `provider` (tools sharing a provider share one credential set per user), `fields: CredentialField[]` (show the `CredentialField` type verbatim), optional server-side `validate(values)` hook.
   - Construction-time validation: duplicate field names rejected, field types checked, `BACKEND` env var required.
   - Injected contexts: `inputs.oauth` vs `inputs.credentials` — values are injected server-side and never transit the model.
   - `CredentialInvalidError(provider, reason?)`: throwing it from `execute` deletes the stale stored row and re-prompts the user in the same turn.
   - Link to the tutorials: `/developers/tutorials/oauth-tools` and `/developers/tutorials/user-credential-tools`.
3. In the config-option type list, add `json` hydration semantics (verify first: `git show 7284c31 --stat` then read the touched file): object values pass through unchanged; string values are JSON-parsed at hydration.
4. Include a short migration `<Note>`: *Breaking (July 2026): the `oauth` constructor option was renamed `authentication` and needs an explicit `authType: "oauth"` tag.*

- [ ] **Step 4: Validate**

```bash
grep -n "path=\"oauth\"\|ExuluOauthConfig = {" mintlify-docs/developers/core/exulu-tool/configuration.mdx
grep -c "authType" mintlify-docs/developers/core/exulu-tool/configuration.mdx
```

Expected: first grep — no hits without an `authType` tag in the same block; second grep ≥ 3.

- [ ] **Step 5: Commit**

```bash
[ "$(git branch --show-current)" = "docs/imp-docs-update" ] && git add mintlify-docs/developers/core/exulu-tool/configuration.mdx && git commit -m "docs(mintlify): rewrite ExuluTool configuration for authentication union"
```

### Task 2: `developers/tutorials/oauth-tools.mdx` — rename in both samples

**Files:**
- Modify: `mintlify-docs/developers/tutorials/oauth-tools.mdx`

- [ ] **Step 1: Verify**

```bash
grep -n "oauth/callback" src/routes.ts | head -3
grep -n "authorizationUrl" src/exulu/auth/wrap-execute.ts
```

Expected: `GET /oauth/callback` still mounted (redirect-URI guidance stays); the no-token short-circuit emits `oauth: { authorizationUrl }`.

- [ ] **Step 2: Locate**

```bash
grep -n "oauth: {" mintlify-docs/developers/tutorials/oauth-tools.mdx
```

Expected: two code samples declaring `oauth: {...}` plus intro prose "declare an `oauth` config".

- [ ] **Step 3: Edit**

1. Both samples: `oauth: {` → `authentication: { authType: "oauth",` (keep all other keys).
2. Intro sentence: "declare an `authentication` config with `authType: "oauth"`".
3. Add one sentence after the flow description: when no token is stored, the tool short-circuits with `oauth: { authorizationUrl }` and chat shows a **Connect** button.
4. Add the same breaking-rename `<Note>` as Task 1 (one sentence, link to the configuration page).

- [ ] **Step 4: Validate**

```bash
grep -n "oauth: {" mintlify-docs/developers/tutorials/oauth-tools.mdx
```

Expected: no constructor-sample hits (the `oauth: { authorizationUrl }` mention in prose/short-circuit context is allowed — check each remaining hit is that).

- [ ] **Step 5: Commit** — `git add mintlify-docs/developers/tutorials/oauth-tools.mdx && git commit -m "docs(mintlify): oauth tutorial uses authentication config"` (with the branch guard as in Task 1).

### Task 3: NEW `developers/tutorials/user-credential-tools.mdx` + nav

**Files:**
- Create: `mintlify-docs/developers/tutorials/user-credential-tools.mdx`
- Modify: `mintlify-docs/docs.json` (Developers tab → Tutorials group: add `"developers/tutorials/user-credential-tools"` directly after `"developers/tutorials/oauth-tools"`)

**Interfaces:**
- Produces: page path `/developers/tutorials/user-credential-tools`, linked from Tasks 1, 22, 15.

- [ ] **Step 1: Verify the full runtime contract**

```bash
grep -n "credentialRequest" src/exulu/auth/wrap-execute.ts src/exulu/auth/credential-request.ts 2>/dev/null || grep -rn "credentialRequest" src/exulu/auth/
grep -rn "15\|TTL\|expiresAt" src/exulu/auth/*nonce* src/exulu/auth/*request* 2>/dev/null | head
grep -n "credentials" src/routes.ts | grep -iE "post|get|delete" | head
grep -rn "class CredentialInvalidError" src/exulu/
```

Expected: short-circuit shape `{ credentialRequest: { provider, fields, submitUrl, nonce }, result: null }`; AES-sealed nonce over `{provider, userId, expiresAt}` with 15-min TTL; routes `POST /credentials/submit`, `GET /credentials`, `DELETE /credentials/:provider`; the error class. Confirm scrubbing/guardrail commits: `git log --oneline 9276752 35a8546 4393b55 -1 --format='%h %s'` each.

- [ ] **Step 2: Write the page** (mirror the structure/voice of `oauth-tools.mdx` — read it first). Required sections:

1. **What you're building** — a tool that collects an API key/login via a typed form in chat, no OAuth app needed.
2. **Declare the config** — full runnable sample: `authentication: { authType: "user_credentials", provider: "...", fields: [{name, label, type: "password", help}], validate: async (values) => ... }`.
3. **How the flow works** — no stored credentials → short-circuit with `credentialRequest` (show the JSON shape) → chat renders the credential form card → user submits (`POST /credentials/submit`, session-authenticated, nonce cross-checked, 15-min TTL) → next call gets `inputs.credentials`.
4. **Provider sharing** — tools with the same `provider` share one credential set per user.
5. **Self-healing** — throw `CredentialInvalidError(provider, reason?)` on provider-side 401s: stale row deleted, fresh form in the same turn.
6. **Security posture** — values AES-encrypted at rest (keyed off `NEXTAUTH_SECRET`), injected server-side, scrubbed from the model view and history; a system guardrail refuses to collect secrets in the chat text itself.
7. **User management** — Settings → Connections (list + revoke); `GET /credentials` (metadata only) / `DELETE /credentials/:provider`.

- [ ] **Step 3: Add the nav entry** in `docs.json` (exact string above).

- [ ] **Step 4: Validate**

```bash
grep -n "user-credential-tools" mintlify-docs/docs.json
grep -c "authType" mintlify-docs/developers/tutorials/user-credential-tools.mdx
```

Expected: 1 nav hit; ≥ 2.

- [ ] **Step 5: Commit** — `docs(mintlify): add user-credential tools tutorial`.

### Task 4: `exulu-tool/introduction.mdx` + `exulu-tool/api-reference.mdx` — rename fixes

**Files:**
- Modify: `mintlify-docs/developers/core/exulu-tool/introduction.mdx`
- Modify: `mintlify-docs/developers/core/exulu-tool/api-reference.mdx`

- [ ] **Step 1: Locate** — `grep -n "oauth" mintlify-docs/developers/core/exulu-tool/introduction.mdx mintlify-docs/developers/core/exulu-tool/api-reference.mdx`. Expected: intro prose ("Declare an `oauth` config…"), a code sample `oauth: { provider: "google", ... }`, a closing option-list card, and the api-reference instance-property row `oauth | ExuluOauthConfig \| undefined`.
- [ ] **Step 2: Edit** — introduction: prose → "Declare an `authentication` config (`authType: "oauth"`)…" (keep the `inputs.oauth` injection claim — still correct); sample → `authentication: { authType: "oauth", provider: "google", ... }`; option-list card → replace `oauth` with `authentication`. api-reference: property row → `authentication` | `ExuluAuthConfig \| undefined` | "Authentication config (OAuth or user credentials), or `undefined`."; mention both arms in one sentence.
- [ ] **Step 3: Validate** — re-run the Step 1 grep. Expected: zero constructor-option references to `oauth` (only `inputs.oauth` / `authType: "oauth"` remain).
- [ ] **Step 4: Commit** — `docs(mintlify): ExuluTool intro + API reference use authentication property`.

### Task 5: `developers/reference/functions-and-types.mdx` — type surface

**Files:**
- Modify: `mintlify-docs/developers/reference/functions-and-types.mdx`

- [ ] **Step 1: Verify** — read `src/exulu/auth/types.ts` in full; `grep -n "inputs.oauth" src/exulu/auth/wrap-execute.ts` (expected: injection is `inputs.oauth`, NOT `inputs._oauth`).
- [ ] **Step 2: Locate** — `grep -n "oauth\|_oauth" mintlify-docs/developers/reference/functions-and-types.mdx`. Expected: "constructed with an `oauth` property…" prose, `inputs._oauth` claim, `ExuluOauthConfig` listing without `authType`.
- [ ] **Step 3: Edit** — (a) prose → `authentication` property; (b) `inputs._oauth` → `inputs.oauth`; (c) update `ExuluOauthConfig` to include `authType: "oauth"`; (d) add complete listings (copied from `types.ts`, then prose-described in the page's established format) for: `ExuluAuthConfig`, `ExuluUserCredentialsConfig`, `CredentialField`, `ExuluCredentialsToolContext`, `CredentialInvalidError`.
- [ ] **Step 4: Validate** — `grep -n "_oauth" mintlify-docs/developers/reference/functions-and-types.mdx` → no hits; `grep -c "ExuluUserCredentialsConfig" …` → ≥ 1.
- [ ] **Step 5: Commit** — `docs(mintlify): functions-and-types covers the auth union`.

### Task 6: `exulu-context/configuration.mdx` (hidden flag) + `exulu-context/api-reference.mdx` (cross-link)

**Files:**
- Modify: `mintlify-docs/developers/core/exulu-context/configuration.mdx`
- Modify: `mintlify-docs/developers/core/exulu-context/api-reference.mdx`

- [ ] **Step 1: Verify** — `grep -n "hidden" src/exulu/context.ts` (expected: `hidden?: boolean` on the field definition, ~line 72); `git show 51ccd02 --format='%s' --stat | head -8` and `git show 1ca43ca --format='%s' --stat | head -8` for the read/filter + sort/groupBy exclusion behavior.
- [ ] **Step 2: Edit** — configuration.mdx: add `hidden` to the `ExuluContextFieldDefinition` code block and a `<ParamField path="fields[].hidden" type="boolean">`: flagged fields are write-only secrets — excluded from GraphQL object types, filters, sort fields, and groupBy; writes still accepted. api-reference.mdx: add a cross-link card/sentence to `/developers/reference/exulu-read-api` (the link currently exists only in reverse).
- [ ] **Step 3: Validate** — `grep -n "hidden" mintlify-docs/developers/core/exulu-context/configuration.mdx` → ≥ 2 hits; `grep -n "exulu-read-api" mintlify-docs/developers/core/exulu-context/api-reference.mdx` → 1 hit.
- [ ] **Step 4: Commit** — `docs(mintlify): hidden field flag + read-api cross-link`.

### Task 7: Developers small refs + Phase 1 gate

**Files:**
- Modify: `mintlify-docs/developers/reference/exulu-default-tools.mdx`
- Modify: `mintlify-docs/developers/reference/exulu-read-api.mdx`
- Modify: `mintlify-docs/developers/reference/exulu-document-processor.mdx`

- [ ] **Step 1: Verify** — `ls ee/agentic-retrieval/pipeline/` and read the zod config schema file (Task requires the 13 saved knowledge-search option names + defaults); `grep -rn "read_session_file\|parse_document\|view_document_page" src/ ee/ --include="*.ts" -l | head` (registration sites + approval-free status); `grep -n "max-size-mb\|25" src/exulu/document-processor* -r 2>/dev/null || grep -rn "max-size-mb" src/`; `grep -n "embedQuery" src/exulu/read-api* -r 2>/dev/null || grep -rn "embedQuery" src/exulu/ | head -5` (opts shape).
- [ ] **Step 2: Edit** —
  1. `exulu-default-tools.mdx`: add the 13 saved config options for the retrieval pipeline (name, type, default, one-line effect — from the zod schema; cross-link `/building/agents/knowledge-search` for the product-side view); add entries for the auto-registered tools `read_session_file` (approval-free; pages offloaded outputs back into context), `parse_document`, `view_document_page` (sandbox document tools).
  2. `exulu-read-api.mdx`: add `ParamField`s for `embedQuery`'s opts (from the shape found in Step 1).
  3. `exulu-document-processor.mdx`: alongside `maxPagesPerChunk`, document byte-size bisection: chunks over 25 MB are recursively split (`--max-size-mb 25` to `split_pdf.py`).
- [ ] **Step 3: Phase 1 gate**

```bash
grep -rn "inputs._oauth" mintlify-docs/ ; echo "exit=$?"
grep -rn "oauth: {" mintlify-docs/developers/ --include="*.mdx" | grep -v "authorizationUrl"
grep -rn "ExuluOauthConfig" mintlify-docs/developers/ --include="*.mdx" | head
cd mintlify-docs && npx mint validate && npx mint broken-links; cd ..
```

Expected: first two greps empty (exit=1); every remaining `ExuluOauthConfig` hit sits next to an `authType` mention (inspect each); link check passes (fallback command: `npx mint broken-links`).

- [ ] **Step 4: Commit** — `docs(mintlify): default-tools/read-api/document-processor additions`.

---

## Phase 2 — API reference

### Task 8: Regenerate `schema.graphql` via the existing `npm run sdl`

**Files:**
- Regenerate: `mintlify-docs/api-reference/graphql/schema.graphql`

**Interfaces:**
- Produces: a fresh `schema.graphql` that Tasks 9–12 copy their SDL blocks from verbatim (enforced by `npm run verify-sdl`), and that the Task 37 final gate re-runs.

> The refresh mechanism already exists: `mintlify-docs/package.json` has `"sdl": "node scripts/emit-graphql-sdl.mjs"`, which runs the backend's `scripts/print-sdl.ts` via **bun** with `EXULU_ENTERPRISE_LICENSE` set so license-gated tables (workflow templates, job results, roles, teams…) are included, then sanity-parses the output. `AGENTS.md` already documents it. The script's default backend path assumes mintlify-docs sits NEXT TO a `backend` checkout — inside this repo you must pass `BACKEND_REPO` explicitly.

- [ ] **Step 1: Regenerate**

```bash
cd mintlify-docs && BACKEND_REPO="$(git rev-parse --show-toplevel)" npm run sdl; cd ..
git diff --stat mintlify-docs/api-reference/graphql/schema.graphql
```

Expected: script exits 0 (needs `bun` on PATH — install via `curl -fsSL https://bun.sh/install | bash` if missing) and the diff shows changes. If it reports missing license-gated tables on stderr, stop and investigate before committing.

- [ ] **Step 2: Validate the regenerated schema**

```bash
grep -n "apikey\|anthropic_token\|temporary_token" mintlify-docs/api-reference/graphql/schema.graphql
grep -cn "routineRuns\|workflowTriggers\|guest_access\|auto_approve_tools\|sandbox_enabled" mintlify-docs/api-reference/graphql/schema.graphql
```

Expected: hidden user secrets GONE from the User object type (any remaining hit must be input-only — inspect); all five new names present. Then `cd mintlify-docs && npm run verify-sdl; cd ..` — this will now FAIL for core-type pages whose SDL blocks are stale; that's expected and is exactly what Tasks 9–12 fix. Record which pages it lists.

- [ ] **Step 3: Commit** — `docs(mintlify): regenerate schema.graphql`.

### Task 9: `core-types/users.mdx`

**Files:**
- Modify: `mintlify-docs/api-reference/graphql/core-types/users.mdx`

- [ ] **Step 1: Verify** — `grep -n "hidden" $(git show 51ccd02 --stat --format= | awk '{print $1}' | grep -v '^$' | head -3)` to see which user columns are flagged; `grep -rn "'external'" $FRONTEND/app/api/public-auth/ensure-user/route.ts` (expected: inserts `type='external'`).
- [ ] **Step 2: Edit** — replace the SDL block with the `User` type copied VERBATIM from the regenerated `schema.graphql` (Task 8); remove `temporary_token`, `apikey`, `password`, `anthropic_token` from the field-notes table (hidden from reads/filters since 51ccd02; note once under an "Access" note that secret columns are write-only). Update the `type` note: `"user"` (human), `"api"` (service), `"external"` (self-registered guest-mode users; redirected out of the internal app).
- [ ] **Step 3: Validate** — `grep -n "anthropic_token\|temporary_token" mintlify-docs/api-reference/graphql/core-types/users.mdx` → no hits; `grep -n "external" …users.mdx` → ≥ 1; `cd mintlify-docs && npm run verify-sdl` no longer lists users.mdx.
- [ ] **Step 4: Commit** — `docs(mintlify): users core type drops hidden secrets, adds external type`.

### Task 10: `core-types/agents.mdx` + `workflow-templates.mdx` + `projects.mdx`

**Files:**
- Modify: `mintlify-docs/api-reference/graphql/core-types/agents.mdx`
- Modify: `mintlify-docs/api-reference/graphql/core-types/workflow-templates.mdx`
- Modify: `mintlify-docs/api-reference/graphql/core-types/projects.mdx`

- [ ] **Step 1: Verify** — `grep -n "guest_" mintlify-docs/api-reference/graphql/schema.graphql` (post-Task-8: expected `guest_access`, `guest_auth_mode`, `guest_cover_image` on the type; `guest_password` input-only; `guest_password_hash` absent); `grep -n "auto_approve_tools" ee/schemas.ts` (~418, boolean default false); read the project budget resolver (`git show 272a45a --stat`, then the touched `budget-field.ts`) for the two response shapes.
- [ ] **Step 2: Edit** —
  1. `agents.mdx`: replace the SDL block with the regenerated `Agents` type verbatim (Task 8); add field notes for the three guest read fields + input-only `guest_password` (hashed server-side; the hash is never queryable or filterable) and for `sandbox_enabled`.
  2. `workflow-templates.mdx`: trigger sentence gains **email** ("manually, via the API, on a cron schedule, or by inbound email"); add `auto_approve_tools` (boolean, default false — queue-backed runs skip per-tool approval pauses when true).
  3. `projects.mdx`: expand the `budget` field note to the two shapes: full envelope (budget-management permission or super-admin) vs reduced member view.
- [ ] **Step 3: Validate** — `grep -n "guest_access" …agents.mdx` ≥ 1; `grep -n "auto_approve_tools" …workflow-templates.mdx` ≥ 1; `grep -n "member" …projects.mdx` ≥ 1; `npm run verify-sdl` (from `mintlify-docs/`) no longer lists these three pages. SDL blocks in all three come verbatim from the regenerated schema.
- [ ] **Step 4: Commit** — `docs(mintlify): agents/workflow-templates/projects core-type fields`.

### Task 11: `core-types/job-results.mdx`

**Files:**
- Modify: `mintlify-docs/api-reference/graphql/core-types/job-results.mdx`

- [ ] **Step 1: Verify** — `grep -n "waiting_approval\|filtered\|cancelled\|TERMINAL_JOB_STATES" src/ ee/ -r --include="*.ts" | head`; `sed -n '260,290p' ee/schemas.ts` (expected: `trigger`, `trigger_metadata`, `session`, `workflow` fields).
- [ ] **Step 2: Edit** — replace the SDL block with the regenerated type verbatim (Task 8). `state` field note: list all states, marking `waiting_approval` as persisted **non-terminal** (run paused on a tool approval) and `cancelled` / `filtered` as terminal (filtered = an email-trigger guard rejected the message). Add notes for the four new fields: `trigger` (manual/api/scheduled/email), `trigger_metadata` (JSON, e.g. email envelope), `session` (run-backed chat session id), `workflow` (owning routine).
- [ ] **Step 3: Validate** — `grep -n "waiting_approval" …job-results.mdx` ≥ 1; `npm run verify-sdl` no longer lists job-results.mdx.
- [ ] **Step 4: Commit** — `docs(mintlify): job-results states + trigger fields`.

### Task 12: `core-types/transcription-jobs.mdx` — re-derive statuses from source

**Files:**
- Modify: `mintlify-docs/api-reference/graphql/core-types/transcription-jobs.mdx`

> ⚠️ Spec §7.7: the currently documented values AND the audit's first-pass correction were both wrong. Trust only what Step 1 finds.

- [ ] **Step 1: Derive the authoritative status list**

```bash
grep -rln "transcription" src/ ee/ --include="*.ts" | grep -viE "test|spec" | head
# then, on the files found (job service / recall service / routes):
grep -rnE "status['\"]?\s*[:=]\s*['\"]" <files-found> | grep -oE "['\"][a-z_]+['\"]" | sort -u
```

Expected: the complete set of status strings actually written (include recall meeting-job statuses if they share the type). Cross-check against the regenerated `schema.graphql` if the field is an enum.

- [ ] **Step 2: Edit** — replace the `status` field-note value list with exactly the Step 1 set, one line each with when it occurs. Note the recovery behavior: interrupted meeting jobs are reconciled automatically (63c47bc).
- [ ] **Step 3: Validate** — every value in the page appears in the Step 1 output and vice versa (manual diff).
- [ ] **Step 4: Commit** — `docs(mintlify): correct transcription-job statuses from source`.

### Task 13: `graphql/introduction.mdx` + NEW `graphql/routine-runs.mdx` + nav

**Files:**
- Modify: `mintlify-docs/api-reference/graphql/introduction.mdx`
- Create: `mintlify-docs/api-reference/graphql/routine-runs.mdx`
- Modify: `mintlify-docs/docs.json` (API Reference tab → GraphQL group: add `"api-reference/graphql/routine-runs"` after the conventions/dynamic-types entries)

- [ ] **Step 1: Verify** — `git show 1753262 --stat` then read the resolver for exact operation signatures (`routineRuns` query args/filters + needs-attention count, `cancelRoutineRun`, `retryRoutineRun`); `git show 7c35dfa --stat` for the five email-trigger operations (`workflowTriggers` CRUD + `emailInboundConfig`); `git show a080fef --format='%s'` (role-less users get an empty result, not an error).
- [ ] **Step 2: Edit `introduction.mdx`** — extend the "Platform queries and mutations" accordion with all eight new operations (three routine-run + five email-trigger), one line each.
- [ ] **Step 3: Write `routine-runs.mdx`** — mirror an existing API page's structure (e.g. a core-type page with operations). Sections: the `routineRuns` query (args, filters, needs-attention count, pagination), `cancelRoutineRun`, `retryRoutineRun` (retry-from-step semantics: resumes from the failed step with prior step outputs intact), run-state lifecycle (link to job-results, Task 11), role-less behavior (empty list). Include one complete query + one mutation example with realistic fields from the Step 1 resolver.
- [ ] **Step 4: Validate** — `grep -n "routineRuns" mintlify-docs/api-reference/graphql/introduction.mdx mintlify-docs/docs.json` → ≥ 1 each.
- [ ] **Step 5: Commit** — `docs(mintlify): routine-runs API page + operations inventory`.

### Task 14: `graphql/conventions.mdx` + `graphql/dynamic-types.mdx`

**Files:**
- Modify: `mintlify-docs/api-reference/graphql/conventions.mdx`
- Modify: `mintlify-docs/api-reference/graphql/dynamic-types.mdx`

- [ ] **Step 1: Verify** — `git show a1c45e3 --format='%s' --stat` (rights_mode honored in createOne when explicitly validated); `git show 1ca43ca --format='%s' --stat` (groupBy/sort allow-listed against hidden + defined fields — note the error behavior by reading the diff).
- [ ] **Step 2: Edit** — conventions.mdx Access-control section: `rights_mode` is settable on create (validated against the caller's allowed modes). Sorting/statistics sections: `sort.field` and `groupBy` must name a defined, non-hidden field; document the rejection behavior found in Step 1. dynamic-types.mdx: add a 2–3 sentence note to the generated-type-family walkthrough: `hidden` fields are omitted from object types, inputs, and filters.
- [ ] **Step 3: Validate** — `grep -n "hidden" mintlify-docs/api-reference/graphql/dynamic-types.mdx` ≥ 1; `grep -n "rights_mode" mintlify-docs/api-reference/graphql/conventions.mdx | head`.
- [ ] **Step 4: Commit** — `docs(mintlify): conventions + dynamic-types cover hidden fields and create-time rights_mode`.

### Task 15: `openapi/openapi.json`

**Files:**
- Modify: `mintlify-docs/openapi/openapi.json`

- [ ] **Step 1: Verify every endpoint** — `grep -n "'/credentials\|\"/credentials\|me/usage\|public-agents\|oauth/callback" src/routes.ts | head -20`; read each handler for method, auth, request/response shapes. Credentials endpoints speak the `{ok: true|false, error?}` dialect (0f088c5); `GET /credentials` returns metadata only (never values); `GET /me/usage` is gated by the admin budget-visibility setting; the four public-agents endpoints per audit: list, meta (8-field projection), cover, verify-password (204/401/429, rate-limited), 404 on non-UUID/unpublished.
- [ ] **Step 2: Edit** — add paths: `POST /credentials/submit`, `GET /credentials`, `DELETE /credentials/{provider}`, `GET /oauth/callback`, `GET /me/usage`, and the four public-agents paths (exact route strings from Step 1). Fix the agent-run endpoint description (currently repeats the retired `rights_mode=public` unauthenticated rule — reword to guest-access modes, matching Task 16's REST intro). Fix the shared-artifacts `rights_mode` property description to match `src/utils/check-record-access.ts` evaluation modes.
- [ ] **Step 3: Validate** — `python3 -c "import json; json.load(open('mintlify-docs/openapi/openapi.json')); print('valid')"` → `valid`; `grep -c "/credentials" mintlify-docs/openapi/openapi.json` ≥ 3; link check still passes.
- [ ] **Step 4: Commit** — `docs(mintlify): openapi adds credentials, me/usage, public-agents paths`.

### Task 16: `rest/introduction.mdx` + NEW `rest/public-agents.mdx` + `rest/gateways-litellm.mdx` + Phase 2 gate

**Files:**
- Modify: `mintlify-docs/api-reference/rest/introduction.mdx`
- Create: `mintlify-docs/api-reference/rest/public-agents.mdx`
- Modify: `mintlify-docs/api-reference/rest/gateways-litellm.mdx`
- Modify: `mintlify-docs/docs.json` (API Reference tab → REST group: add `"api-reference/rest/public-agents"`)

- [ ] **Step 1: Verify** — `grep -n "skills/registry" src/routes.ts | head` (list + `:name` + public bootstrap endpoints; RBAC-filtered); `git show 4262d88 --format='%s'` (guest access mode governs anonymous access over legacy rights_mode=public); `git show 30960c8 --format='%s'` (x-api-key JWTs route to getToken); `sed -n '5270,5370p' src/routes.ts` for the public-agents handlers.
- [ ] **Step 2: Edit `rest/introduction.mdx`** — (a) replace the stale Note ("agent-run endpoint does not require authentication when … `rights_mode` … `public`") with the guest-access rule: anonymous access is governed by the agent's guest mode; link `/building/agents/guest-access`. (b) Add a **Skills registry** section: `GET /skills/registry?tag=` (RBAC-filtered list), `GET /skills/registry/:name` (metadata), public bootstrap endpoint — powers the `imp` CLI. (c) One sentence: a session JWT passed via `x-api-key` is detected and routed to session auth (parity with the GraphQL intro note).
- [ ] **Step 3: Write `rest/public-agents.mdx`** — the four endpoints with method, path, auth (none/rate-limited), status codes (404 non-UUID/unpublished; verify-password 204/401/429), and the 8-field projection; one curl example each, following the tab's existing endpoint-page format.
- [ ] **Step 4: Edit `gateways-litellm.mdx`** — one pointer sentence: the project detail page generates ready-made client configs (Claude Code / Cowork / continue.dev) for this gateway (link `/user-guide/projects/working-in-a-project`).
- [ ] **Step 5: Phase 2 gate**

```bash
grep -rn "rights_mode.*public" mintlify-docs/api-reference/ --include="*.mdx" | grep -iv "guest"
cd mintlify-docs && npx mint validate && npx mint broken-links; cd ..
```

Expected: no un-reworded retired-rule hits; link check passes.

- [ ] **Step 6: Commit** — `docs(mintlify): REST intro guest rule, skills registry, public-agents page`.

---

## Phase 3 — New pages

Every task here: read one sibling page in the target group first and mirror its frontmatter/components; add the `docs.json` nav entry in the stated position; end with the house gates (`npx mint validate && npx mint broken-links` from `mintlify-docs/`) (fold into the task's validate step). Facts must be verified against the cited sources before writing.

### Task 17: NEW `building/agents/guest-access.mdx`

**Files:**
- Create: `mintlify-docs/building/agents/guest-access.mdx`
- Modify: `mintlify-docs/docs.json` (Building → Agents group: after `"building/agents/access-and-safety"`)

**Interfaces:** page path `/building/agents/guest-access`, linked from Tasks 16, 30, 31, 34.

- [ ] **Step 1: Verify** — frontend `$FRONTEND/app/(public)/` route group (selection page, per-agent gate, login/registration with custom cover); backend `grep -n "guest_auth_mode\|verifyGuestPassword" src/ -r | head`; rate limits `grep -rn "EXULU_GUEST_RATE" src/`; `git show 9dafaf4 --format='%s'` (domain allowlist exemption); `git show 6657bdc --format='%s'` (externals redirected out of internal app).
- [ ] **Step 2: Write** — sections: (1) what guest access is (publish an agent to visitors at `/public/agents`); (2) enabling it in the editor's Guest access section; (3) the three modes — **public** (anonymous, browser-local transcripts), **password** (shared password gate; stored hashed), **login** (external self-registration + persistent sessions/history); (4) external users: `type="external"`, exempt from `ALLOWED_EMAIL_DOMAINS`, redirected away from the internal app; (5) abuse limits: per-IP rate limits and message caps (env-tunable — link self-hosting env vars); (6) precedence `<Note>`: when guest access is configured it governs anonymous access, superseding legacy `rights_mode=public`.
- [ ] **Step 3: Validate + commit** — `grep -n "guest-access" mintlify-docs/docs.json` → 1 hit; link check; `docs(mintlify): add guest access page`.

### Task 18: NEW `building/agents/knowledge-search.mdx`

**Files:**
- Create: `mintlify-docs/building/agents/knowledge-search.mdx`
- Modify: `mintlify-docs/docs.json` (Building → Agents group: after `"building/agents/guest-access"`)

- [ ] **Step 1: Verify** — read the pipeline config zod schemas (`ee/agentic-retrieval/pipeline/` — same source as Task 7) for the 13 saved options: names, types, defaults; confirm the agent-editor surface in `$FRONTEND` (grep the config keys) so the page describes real UI labels.
- [ ] **Step 2: Write** — sections: (1) what the pipeline does (routing → memory → search → rerank; HyDE + multi-query RRF; fuzzy/exact prefilters; identifier pins; project scope); (2) the 13 config options — a table: UI label, what it does, default, when to change it; (3) step budgets (per-message; `0` = platform default of 10); (4) note the editions positioning (`agentic-retrieval` module) and cross-link `/developers/reference/exulu-default-tools` for the SDK factory.
- [ ] **Step 3: Validate + commit** — nav hit = 1; link check; `docs(mintlify): add knowledge-search configuration page`.

### Task 19: NEW `building/routines/email-triggers.mdx`

**Files:**
- Create: `mintlify-docs/building/routines/email-triggers.mdx`
- Modify: `mintlify-docs/docs.json` (Building → Routines group: after `"building/routines/overview"`)

- [ ] **Step 1: Verify** — `git show 8fb9eb7 --format='%s' --stat` (address generation); `git show 2e72d48 --format='%s'` (guard chain: auto-reply, allowlist, rate limits, dedup, filters); frontend `git -C $FRONTEND show fd26e27 --format='%s' --stat` (TriggersSection UI: allowlist chips, regex filter rules, limits, generated address); `git show 5bf73f5 --format='%s'` (email variables into step substitution).
- [ ] **Step 2: Write** — sections: (1) concept (a routine gets a unique inbound address; matching emails start runs); (2) the Triggers workbench section: generated address (+ regenerate), sender allowlist, regex filter rules, rate limits; (3) the guard chain in plain language — auto-replies suppressed, non-allowlisted senders rejected, rate limits, Message-ID dedup, filter mismatches produce `filtered` runs (link runs-and-schedules); (4) email variables available in steps (subject/from/body per Step 1); (5) prerequisite `<Note>`: a super-admin must configure platform email intake first — link `/administration/email-intake`.
- [ ] **Step 3: Validate + commit** — nav hit = 1; link check; `docs(mintlify): add email triggers page`.

### Task 20: NEW `administration/email-intake.mdx`

**Files:**
- Create: `mintlify-docs/administration/email-intake.mdx`
- Modify: `mintlify-docs/docs.json` (Administration tab — open `docs.json`, place next to `"administration/theme"` in its group)

- [ ] **Step 1: Verify** — `git show 97cf103 --format='%s'` (platform config store, encrypted signing key); `git show 18e48bd --format='%s'` (Mailgun signature verification + replay guard); `git show 310806a --format='%s'` (`POST /webhooks/email/mime`, persist-before-ACK); frontend `git -C $FRONTEND show 699b1c6 --format='%s'` (setup checklist surface).
- [ ] **Step 2: Write** — sections: (1) the `/configuration/email` super-admin surface + setup checklist; (2) Mailgun setup: signing key (encrypted at rest), the inbound route pointing at `{BACKEND}/webhooks/email/mime`; (3) how delivery works (signature verification, replay guard, persist-before-ACK — a crash never loses an acknowledged email); (4) behavior when unconfigured (triggers inactive); (5) link `/building/routines/email-triggers`.
- [ ] **Step 3: Validate + commit** — nav hit = 1; link check; `docs(mintlify): add email intake admin page`.

### Task 21: NEW `building/knowledge/bulk-import.mdx`

**Files:**
- Create: `mintlify-docs/building/knowledge/bulk-import.mdx`
- Modify: `mintlify-docs/docs.json` (Building → Knowledge group: after `"building/knowledge/items"`)

- [ ] **Step 1: Verify** — frontend commits: `git -C $FRONTEND show ba1b7d1 --format='%s'` (two exclusive zones), `b0b58f4` (CSV rows reference storage keys; filename matching retired), `0ada892` (example row in template), `8d727bf`/`9cf9426` (storage verification), `c7f2d54` (batch access control), `398fea4` (read-only access column).
- [ ] **Step 2: Write** — sections: (1) entry points in the knowledge workspace; (2) flow A — file drop (files upload to storage, one item per file); (3) flow B — CSV (download the template with example row; rows reference **storage keys**, not filenames; editable storage-key cells); (4) the two zones are exclusive; (5) review step: inline cell errors, storage-existence verification, blank-clears warning; (6) batch access: rights mode applied to the whole batch, echoed in a read-only access column; (7) progress/done semantics (skipped rows still reach 100%; error report download).
- [ ] **Step 3: Validate + commit** — nav hit = 1; link check; `docs(mintlify): add bulk import page`.

### Task 22: NEW `user-guide/chat/connecting-tools.mdx`

**Files:**
- Create: `mintlify-docs/user-guide/chat/connecting-tools.mdx`
- Modify: `mintlify-docs/docs.json` (User Guide → Chat group: insert `"user-guide/chat/connecting-tools"` directly after `"user-guide/chat/tool-approvals"`)

**Interfaces:** page path `/user-guide/chat/connecting-tools`, linked from Tasks 1, 25, 26.

- [ ] **Step 1: Verify** — frontend `git -C $FRONTEND show 0589e7e --format='%s'` (credential form card, oauth connect card, guest notice), `fcdec2f` (tool-chip redaction), `4f5a786` (Settings Connections); backend guardrail `git show 4393b55 --format='%s'`.
- [ ] **Step 2: Write** — sections: (1) when a tool needs access, chat shows a **credential form card** (typed fields, inline validation, success state) or a **Connect** button for OAuth; (2) what happens after connecting (the tool retries in the same turn); (3) guests on public pages see a sign-in notice instead of the form; (4) privacy: submitted values never reach the model, tool chips redact auth payloads, and the assistant refuses to collect secrets typed into chat — use the form; (5) managing connections: Settings → Connections, revoke anytime; (6) cross-link `/user-guide/chat/tool-approvals`.
- [ ] **Step 3: Validate + commit** — nav hit = 1; link check; `docs(mintlify): add connecting-tools page`.

### Task 23: NEW `user-guide/chat/memory.mdx`

**Files:**
- Create: `mintlify-docs/user-guide/chat/memory.mdx`
- Modify: `mintlify-docs/docs.json` (User Guide → Chat group: after `"user-guide/chat/pinned-knowledge-and-presets"`)

- [ ] **Step 1: Verify** — read `src/templates/tools/memory-tool.ts`: the unset-visibility dialogue (asks PRIVATE vs PUBLIC before saving), rights_mode mapping, type persistence, enum validation at write (a826517), dynamic tool name `create_<sanitized-context-name>_memory_item`.
- [ ] **Step 2: Write** — sections: (1) what agent memory is (agents with a memory context save facts across conversations); (2) the visibility question — before saving, the agent asks **private** (only you) or **public** (shared with everyone who can read the memory context); what each means; (3) memory types; (4) where memories live (the configured memory context in Knowledge) and how to review/edit/delete them there; (5) cross-link `/building/agents/workbench` for builders.
- [ ] **Step 3: Validate + commit** — nav hit = 1; link check; `docs(mintlify): add chat memory page`.

### Task 24: NEW `self-hosting/branding.mdx` + Phase 3 gate

**Files:**
- Create: `mintlify-docs/self-hosting/branding.mdx`
- Modify: `mintlify-docs/docs.json` (Self-hosting group: place near theme/ops pages)

- [ ] **Step 1: Verify** — `git -C $FRONTEND show b967fe0` (READ THE DIFF: four `icon_*.png` link tags removed, replaced by `favicon.png` + apple-touch-icon), `9bdb845` (manifest route), `git -C $FRONTEND show 0e22ee5 --format='%s'` (`APP_NAME` default "IMP"); find where the favicon file is configured (client branding assets doc 173b0c0).
- [ ] **Step 2: Write** — sections: (1) branding assets overview (client logo/favicon/app name); (2) **favicon**: a single `favicon.png` now serves all sizes + apple-touch-icon — `<Warning>`: **breaking** for existing self-hosted brand kits still shipping only `icon_16x16/32x32/48x48/512x512.png`; state the required file and location; (3) the web-app manifest route (installable app icon; served from the client favicon); (4) `APP_NAME` (default "IMP") — where it appears (manifest, titles); (5) cross-link `/administration/theme` and env-vars.
- [ ] **Step 3: Phase 3 gate**

```bash
python3 -c "import json; d=json.load(open('mintlify-docs/docs.json')); print('valid nav')"
cd mintlify-docs && npx mint validate && npx mint broken-links; cd ..
```

Expected: valid JSON; zero broken links; manually confirm all 8 new Phase-3 page ids appear exactly once in `docs.json`.

- [ ] **Step 4: Commit** — `docs(mintlify): add self-hosting branding page`.

---

## Phase 4 — Existing-page sweep

Same cycle per task: locate the stale quote by grep → verify the replacement facts against the cited commits → edit → grep the stale text is gone → commit. Spec §9 carries the full per-file requirements; each task below restates them.

### Task 25: `user-guide/settings.mdx`

**Files:** Modify: `mintlify-docs/user-guide/settings.mdx`

- [ ] **Step 1: Locate** — `grep -n "four sections" mintlify-docs/user-guide/settings.mdx` (expected 1 hit). Verify the shipped sections in `$FRONTEND` settings-view component (grep `Connections`/`Usage`).
- [ ] **Step 2: Edit** — update the section enumeration and add two sections: **Connections** (stored tool credentials: provider, connected date, Revoke with confirm — link `/user-guide/chat/connecting-tools`) and **Usage** (range toggle, daily chart, per-model table; appears only when the admin enables budget visibility — link `/user-guide/chat/budgets-in-chat`).
- [ ] **Step 3: Validate** — `grep -n "four sections" …` → no hits; `grep -n "Connections" …` ≥ 1. **Commit:** `docs(mintlify): settings adds Connections + Usage`.

### Task 26: Chat sweep A — `tool-approvals.mdx`, `artifacts-and-sharing.mdx`, `attachments-and-session-files.mdx`, `context-compaction.mdx`

**Files:** Modify all four under `mintlify-docs/user-guide/chat/`.

- [ ] **Step 1: Verify** — `git show c3884ff --format='%s'` (stale approvals auto-declined on next user message); `git -C $FRONTEND show 3604cae --format='%s' --stat` (share dialog entry points: session-files panel, message actions, artifact viewer); `git -C $FRONTEND show d7d4e3b --format='%s'` (formatted copy/download for email + WhatsApp); `git show b5656f0 --format='%s'` (head+tail truncation, 128k default) and the 25%-of-context cap (`grep -rn "toolOutputCapTok\|0.25" src/ | head`); read_session_file offload (`grep -rn "read_session_file" src/ | head -3`).
- [ ] **Step 2: Edit** —
  1. `tool-approvals.mdx`: add (a) routine runs pause as *waiting approval* on approval-gated tools and auto-resume after you approve in the linked chat; (b) sending a new message while an approval card is pending declines it automatically; (c) a cross-link to `/user-guide/chat/connecting-tools` ("tools that need accounts or keys ask via credential cards, not approvals").
  2. `artifacts-and-sharing.mdx`: share dialog reachable from all three entry points (list them); per-message **Copy/Download formatted for email or WhatsApp** actions.
  3. `attachments-and-session-files.mdx`: sandbox document tools `parse_document` / `view_document_page` (on-demand parsing/page views); oversized tool outputs + extracted document text are offloaded into Session Files and paged back by the agent with `read_session_file`.
  4. `context-compaction.mdx`: one sentence + link — long tool outputs are also truncated per call (25% of the context window, 128k characters by default), separate from compaction.
- [ ] **Step 3: Validate** — `grep -n "read_session_file" mintlify-docs/user-guide/chat/attachments-and-session-files.mdx` ≥ 1; `grep -n "WhatsApp" mintlify-docs/user-guide/chat/artifacts-and-sharing.mdx` ≥ 1. **Commit:** `docs(mintlify): chat sweep A (approvals, sharing, session files, compaction)`.

### Task 27: Chat sweep B — `model-override-and-usage.mdx`, `pinned-knowledge-and-presets.mdx`, `overview.mdx`, `budgets-in-chat.mdx`

**Files:** Modify all four under `mintlify-docs/user-guide/chat/`.

- [ ] **Step 1: Verify** — frontend `git -C $FRONTEND show 22fbcc3 --format='%s'` (per-message input/output token split), `25b8d4e` (knowledge-search benchmark line), `e7eef26` (preset per-row edit + inline-confirm delete), `a52f05d` (run-session banner), `89becf8` (budget popover Details link → settings usage).
- [ ] **Step 2: Edit** — `model-override-and-usage.mdx`: message footers show the message's own input/output token split; knowledge-search output carries a benchmark line (tokens + time). `pinned-knowledge-and-presets.mdx`: per-row edit + inline-confirm delete in the preset selection modal (owners/editors only). `overview.mdx`: run-backed conversations show a banner linking to the routine run. `budgets-in-chat.mdx`: the budget chip popover has a **Details** link to Settings → Usage; add a next-steps card.
- [ ] **Step 3: Validate** — one grep per new term (e.g. `grep -n "Details" …budgets-in-chat.mdx`). **Commit:** `docs(mintlify): chat sweep B (usage, presets, run banner, budget details)`.

### Task 28: `user-guide/projects/working-in-a-project.mdx`

**Files:** Modify: `mintlify-docs/user-guide/projects/working-in-a-project.mdx`

- [ ] **Step 1: Locate + verify** — `grep -n "New session" mintlify-docs/user-guide/projects/working-in-a-project.mdx` (header enumeration); frontend `git -C $FRONTEND show 6233fcd --format='%s'` (header budget indicator), `992400a` + `d764ca0` (config download actions: Claude Code settings.json with the gateway key, Cowork, continue.dev; Copy project ID); project files → retrieval scope (`git show` the project-scope retrieval commit found via `git log --oneline --grep="projectScope" | head -2`).
- [ ] **Step 2: Edit** — (a) header enumeration gains the read-only **budget indicator** (visible per admin budget-visibility setting; links to details for authorized users); (b) overflow menu: **Download Claude Code config / Cowork config / continue.dev config** — each generates a ready-made client config routing requests through the project's gateway — and **Copy project ID**; (c) Files tab: project files also feed knowledge retrieval for project sessions.
- [ ] **Step 3: Validate** — `grep -n "continue.dev" …` ≥ 1; `grep -n "budget" …` ≥ 1. **Commit:** `docs(mintlify): project page — budget indicator, config downloads, retrieval scope`.

### Task 29: Transcripts — `reviewing-and-saving.mdx`, `recording-meetings.mdx`, `overview.mdx`

**Files:** Modify all three under `mintlify-docs/user-guide/transcripts/`.

- [ ] **Step 1: Locate + verify** — `grep -n "Re-run" mintlify-docs/user-guide/transcripts/reviewing-and-saving.mdx`; frontend `git -C $FRONTEND show 0b55998 --format='%s'` (never-ran prompts runnable from review sheet), `2d2d5e4` + `b2397cc` (delete saved entry with optional knowledge-item cascade); backend `git show 63c47bc --format='%s'` (reconcile sweep + crash-safe post-processing; 24h give-up — confirm in the diff).
- [ ] **Step 2: Edit** — `reviewing-and-saving.mdx`: the post-processing list also shows **never-ran** prompts as Run cards ("Running…" while a run claim is fresh, under ~30 min); deleting a saved entry offers an optional cascade delete of the exported knowledge item (confirm dialog). `recording-meetings.mdx`: recovery guarantees — interrupted meeting jobs self-heal via an automatic reconcile sweep, bounded by a 24h give-up. `overview.mdx`: one sentence — jobs stuck in Processing recover automatically.
- [ ] **Step 3: Validate** — greps for "never" / "cascade" / "recover". **Commit:** `docs(mintlify): transcripts recovery + post-processing updates`.

### Task 30: `building/agents/workbench.mdx`

**Files:** Modify: `mintlify-docs/building/agents/workbench.mdx`

- [ ] **Step 1: Locate + verify** — `grep -n "Sandbox\|eight" mintlify-docs/building/agents/workbench.mdx`; verify: sandbox toggle provisions the **file sandbox** including `parse_document`/`view_document_page` (frontend sandbox commit + backend af3f3a2); count the actual workbench sections in `$FRONTEND` (agent editor component) — the enumeration must include **Guest access**; step-budget semantics (`grep -rn "respectToolApprovals\|maxSteps\|stepBudget" src/ ee/ | head` — per-message, `0` = platform default 10); memory tool name + visibility ask (Task 23's source).
- [ ] **Step 2: Edit** — (a) sandbox row: toggle gives the agent a file sandbox for code execution and on-demand document tools; (b) fix the section enumeration/count to match the shipped editor (include Guest access; link `/building/agents/guest-access`); (c) step-budget field: per-message cap, `0` = platform default (10); (d) Long-term memory row: tool is named `create_<context-name>_memory_item` and asks private/public before saving (link `/user-guide/chat/memory`).
- [ ] **Step 3: Validate** — stale-quote greps return nothing; `grep -n "guest-access" …workbench.mdx` ≥ 1. **Commit:** `docs(mintlify): workbench — sandbox, sections, step budget, memory`.

### Task 31: `building/agents/tools-and-skills.mdx` + `access-and-safety.mdx` + `overview.mdx`

**Files:** Modify all three under `mintlify-docs/building/agents/`.

- [ ] **Step 1: Verify** — KB editor: `git show 8ecc13d --format='%s'` (picker entry in Tools default category), frontend `git -C $FRONTEND show c891b75 --format='%s'` (config sheet: per-context Create/Update switches); safety gates: read `src/templates/tools/context-write-tools.ts` (guest refusal, reserved keys, hidden/calculated/file-field exclusions) + `src/utils/check-item-write-access` (dual gate); skills→sandbox precondition (`grep -rn "sandbox" src/ | grep -i skill | head`); param types `boolean`/`json` (Task 1's hydration source).
- [ ] **Step 2: Edit** —
  1. `tools-and-skills.mdx`: add the **Knowledge base editor** entry (Tools → default category): config sheet with per-context Create/Update switches; created/updated items respect approval prompts unless skip-approval is set. Skills note: skills run in the sandbox — enabling a skill on a sandbox-disabled agent has no effect. Parameter types: add `boolean` and `json` (objects pass through; strings JSON-parsed).
  2. `access-and-safety.mdx`: add a Guest publishing summary + link `/building/agents/guest-access` and the precedence note (guest mode supersedes legacy `rights_mode=public` for anonymous access). Add the KB write-tools safety model: explicit per-context opt-in; dual gate (agent config AND row-level write access); guests refused; file/uuid/calculated/hidden/reserved fields excluded from tool schemas.
  3. `overview.mdx`: fix the workbench section count card to match Task 30's enumeration.
- [ ] **Step 3: Validate** — `grep -n "Knowledge base editor" …tools-and-skills.mdx` ≥ 1; `grep -n "guest" …access-and-safety.mdx` ≥ 1. **Commit:** `docs(mintlify): agents — KB editor, guest publishing, skills sandbox note`.

### Task 32: `building/routines/runs-and-schedules.mdx` + `overview.mdx`; `building/knowledge/overview.mdx` + `items.mdx`

**Files:** Modify the two routines pages and two knowledge pages.

- [ ] **Step 1: Locate + verify** — `grep -n "seven sections\|succeeded, failed, or running" mintlify-docs/building/routines/runs-and-schedules.mdx`; `grep -n "cron schedule" mintlify-docs/building/routines/overview.mdx`; verify run-state facts against Task 11's findings; `grep -rn "respectToolApprovals" ee/workers.ts` (auto_approve_tools semantics); frontend: runs console on the Routines page (8f598b3), no `/runs` route (16d1012).
- [ ] **Step 2: Edit** —
  1. `runs-and-schedules.mdx` (the substantive rewrite): eight workbench sections (Basics, Access, Steps, Schedule, Triggers, Runs, Queue, Danger zone); run states incl. `waiting_approval` (paused on a tool approval — approve in the linked chat and the run auto-resumes), `filtered`, `cancelled`; **Retry** resumes from the failed step; **Cancel**; the needs-attention count/badge; `auto_approve_tools` (queue-backed runs pause on approval-gated tools unless enabled); the global runs console lives below the routines table (no separate `/runs` page); the trigger-source column (manual / API / scheduled / email).
  2. `overview.mdx`: trigger sentence → "on demand, on a cron schedule, or by inbound email" (link email-triggers); workbench list gains **Triggers**.
  3. `knowledge/overview.mdx`: one sentence + links — agents can also *write* items when the KB editor is enabled; Items card mentions importing.
  4. `knowledge/items.mdx`: "New item" is one of three creation paths — add bulk import (link `/building/knowledge/bulk-import`) and agent-created/updated items (link tools-and-skills).
- [ ] **Step 3: Validate** — `grep -n "seven sections" …runs-and-schedules.mdx` → none; `grep -n "waiting" …runs-and-schedules.mdx` ≥ 1; `grep -n "bulk-import" …items.mdx` ≥ 1. **Commit:** `docs(mintlify): routines runs rewrite + knowledge write/import paths`.

### Task 33: Administration + Get Started sweep + Phase 4 gate

**Files:** Modify `mintlify-docs/administration/{budgets,analytics,theme}.mdx`, `mintlify-docs/administration/users-access/{overview,roles}.mdx`, `mintlify-docs/get-started/{editions,concepts}.mdx`.

- [ ] **Step 1: Verify** — `grep -n "external" src/postgres/init-db.ts | head -3` (seeded external role, null permission areas); unattributed-usage hint (`git -C $FRONTEND show 5e08396 --format='%s'`); editions stale quote `grep -n "iterative" mintlify-docs/get-started/editions.mdx`.
- [ ] **Step 2: Edit** —
  1. `budgets.mdx`: the "Show budget status to users" toggle also gates the personal Usage section in Settings and the top-bar Details link.
  2. `users-access/overview.mdx`: external accounts — self-registered guests, `type="external"`, seeded `external` role, redirected out of the internal app.
  3. `users-access/roles.mdx`: document the seeded **external** role (all permission areas null) + `<Warning>` not to grant it internal permissions.
  4. `analytics.mdx`: the second caption line on spend/tokens/requests cards = usage not attributed to any user/team/agent tag (e.g. direct gateway traffic).
  5. `theme.mdx`: note the `/configuration/email` sibling page (link `/administration/email-intake`).
  6. `editions.mdx`: reword "iterative multi-strategy search" → the pipeline engine (routing/search/rerank; link `/building/agents/knowledge-search`).
  7. `concepts.mdx`: extend the theme sentence to mention branding assets (favicon, `APP_NAME`; link `/self-hosting/branding`).
- [ ] **Step 3: Phase 4 gate** — `cd mintlify-docs && npx mint validate && npx mint broken-links; cd ..` → passes; re-grep the H stale quotes from Tasks 25–32 (settings "four sections", routines "seven sections", editions "iterative", workbench sandbox row) → all gone.
- [ ] **Step 4: Commit** — `docs(mintlify): administration + get-started sweep`.

---

## Phase 5 — Self-hosting

### Task 34: `self-hosting/environment-variables.mdx`

**Files:** Modify: `mintlify-docs/self-hosting/environment-variables.mdx`

- [ ] **Step 1: Verify defaults from source** — `grep -rn "EXULU_GUEST_RATE_PER_MINUTE\|EXULU_GUEST_RATE_PER_HOUR\|EXULU_GUEST_MAX_MESSAGE_CHARS\|EXULU_GUEST_MAX_TOTAL_CHARS\|EXULU_TRUST_PROXY\|APP_NAME" src/ $FRONTEND/lib $FRONTEND/app -r 2>/dev/null | head -15`. Expected defaults: 10 / 60 / 8000 / 32000 (confirm each in code — do not trust this plan's numbers over source).
- [ ] **Step 2: Edit** — add rows for the five guest vars (+ `EXULU_TRUST_PROXY` semantics: trust `X-Forwarded-For` for rate-limit IPs behind a proxy) and `APP_NAME` (default "IMP"; used in manifest/titles — link `/self-hosting/branding`); extend the `BACKEND` row: also the base URL for inbound-email webhook URLs and credential submit URLs.
- [ ] **Step 3: Validate** — `grep -c "EXULU_GUEST" …environment-variables.mdx` ≥ 4. **Commit:** `docs(mintlify): env vars — guest limits, APP_NAME, BACKEND row`.

### Task 35: `self-hosting/database.mdx` + `self-hosting/services/smtp-and-auth.mdx`

**Files:** Modify both.

- [ ] **Step 1: Verify** — `grep -n "oauth_tokens\|user_credentials" src/postgres/init-db.ts init-exulu-db.ts 2>/dev/null | head` (expected: `DROP TABLE IF EXISTS oauth_tokens CASCADE` runs unconditionally on boot; `user_credentials` created); confirm the migrations description in the page against current initdb behavior (read the relevant initdb section); `git -C $FRONTEND show 9dafaf4 --format='%s'` (external users exempt from `ALLOWED_EMAIL_DOMAINS`).
- [ ] **Step 2: Edit** — `database.mdx`: (a) correct the migrations description where it contradicts current initdb behavior found in Step 1; (b) document `user_credentials` (AES-encrypted JSON blobs keyed off `NEXTAUTH_SECRET`) and that `oauth_tokens` is dropped on boot; (c) `<Warning>`: rotating `NEXTAUTH_SECRET` makes stored tool credentials undecryptable — users must reconnect; (d) one sentence: secret columns are write-only at the API layer. `smtp-and-auth.mdx`: amend the `ALLOWED_EMAIL_DOMAINS` paragraph — external/guest self-registration is exempt (link `/building/agents/guest-access`).
- [ ] **Step 3: Validate** — `grep -n "user_credentials" …database.mdx` ≥ 1; `grep -n "exempt" …smtp-and-auth.mdx` ≥ 1. **Commit:** `docs(mintlify): database credentials store + domain-allowlist exemption`.

### Task 36: `architecture.mdx` + `services/redis.mdx` + `troubleshooting.mdx` + `containers.mdx`

**Files:** Modify all four under `mintlify-docs/self-hosting/`.

- [ ] **Step 1: Verify** — webhook routes (`grep -n "webhooks/email/mime\|recall/webhooks" src/routes.ts`); Redis keys for rate limits/dedup (`grep -rn "expire\|sliding" src/ ee/ | grep -i "guard\|rate" | head -5`); reconcile loop (`grep -rn "reconcile" src/ | head -3`, runs when Recall enabled, ~60s cycle); `grep -n "pdftotext" src/exulu/system-dependencies.ts`.
- [ ] **Step 2: Edit** — `architecture.mdx`: add a **Public webhooks** subsection: `POST /webhooks/email/mime` (Mailgun-signed, persist-before-ACK) and the Recall webhook — both must be internet-reachable; proxy/exposure guidance. `redis.mdx`: persistence note — guest/email rate-limit windows and email dedup keys live in Redis; losing Redis resets limits (bounded impact, no data loss beyond that). `troubleshooting.mdx`: add accordion "Meeting recording stuck in Processing" — the reconcile loop self-heals in ~60s cycles when Recall is enabled; what to check if it doesn't (recallEnabled, bot status, logs). `containers.mdx`: the poppler line gains `pdftotext` (startup-probed required binary).
- [ ] **Step 3: Validate** — `grep -n "webhooks/email/mime" …architecture.mdx` ≥ 1; `grep -n "pdftotext" …containers.mdx` ≥ 1. **Commit:** `docs(mintlify): self-hosting webhooks, redis, troubleshooting, containers`.

### Task 37: Final validation gate

**Files:** none (verification only; fix regressions in place).

- [ ] **Step 1: Full link check** — `cd mintlify-docs && npx mint validate && npx mint broken-links` → both pass, zero broken links.
- [ ] **Step 2: Nav audit** — every page in `docs.json` exists on disk and every `.mdx` under the doc dirs is either in nav or intentionally excluded:

```bash
python3 - <<'EOF'
import json, glob, os
nav=json.dumps(json.load(open('mintlify-docs/docs.json')))
missing=[p for p in [x[len('mintlify-docs/'):-4] for x in glob.glob('mintlify-docs/**/*.mdx',recursive=True) if 'node_modules' not in x and '/snippets/' not in x and not x.startswith('mintlify-docs/changelog')] if f'"{p}"' not in nav]
print('not in nav:',missing)
EOF
```

Expected: empty (or an explainable list).

- [ ] **Step 3: Grep gates (whole tree)** — `grep -rn "inputs._oauth" mintlify-docs/` → empty; `grep -rn "oauth: {" mintlify-docs/developers/ | grep -v authorizationUrl` → empty; `grep -rn "rights_mode.*public" mintlify-docs/ --include="*.mdx" | grep -v changelog | grep -iv guest` → empty or each hit justified.
- [ ] **Step 4: Schema freshness** — `cd mintlify-docs && BACKEND_REPO="$(git rev-parse --show-toplevel)" npm run sdl && git diff --exit-code api-reference/graphql/schema.graphql && npm run verify-sdl` → exit 0 (byte-identical schema; all core-type SDL blocks match).
- [ ] **Step 5: H-item spot check** — for each H item in the spec (§6–§10), grep its stale quote → zero hits (use the audit JSON for the exact quote list).
- [ ] **Step 6: Commit any gate fixes** — `docs(mintlify): final validation fixes`.
