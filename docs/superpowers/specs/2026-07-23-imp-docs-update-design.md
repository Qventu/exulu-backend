# IMP Docs Site Update — July 2026 Feature Catch-Up

- **Date:** 2026-07-23
- **Status:** Approved (design reviewed with Daniel 2026-07-23)
- **Target:** `backend/mintlify-docs` (the IMP Docs Mintlify project; navigation in `docs.json`)
- **Source of truth:** 31-agent docs-gap audit run 2026-07-23. Every finding below was adversarially verified against both the docs tree and the shipped code. Full audit JSON (per-page stale quotes with line numbers, git evidence):
  `~/.claude/projects/-Users-daniel-claessen-Desktop-Projects-exulu-backend/49ffbe01-5698-44f1-a58e-4afcec956adc/tool-results/docs-gap-audit-full.json`

## 1. Problem

The docs content was snapshotted at the 2026-07-15 rebuild (`41f1921`). Everything shipped June 22 – July 23 on `backend@develop` and `frontend@main` (all pushed to origin as of 2026-07-23) is either missing or contradicted by current pages. The worst case is the ExuluOauth → ExuluTools authentication refactor: **every developer page teaches the removed `oauth:` constructor option, and copying any sample throws at construction.** Generated API artifacts (`schema.graphql`, core-type pages) are frozen at the snapshot and now expose fields that were removed and omit fields that were added.

## 2. Goals

1. No docs page teaches an API that no longer exists or misdescribes shipped behavior.
2. Every shipped feature with an externally visible surface (user UI, admin surface, REST/GraphQL API, env/config, developer SDK) is documented in the right tab.
3. Generated artifacts are regenerated from source and get a repeatable refresh step so they cannot silently drift again.
4. Each docs file is edited exactly once, with all changes from all features consolidated (page-major, not feature-major).

## 3. Non-goals / out of scope

- **Changelog tab and release pages.** All findings about `changelog/index.mdx`, the release-page sources under `docs/releases/`, and `scripts/build-changelog.mjs` are excluded (decided 2026-07-23). Tracked as follow-ups in §11.
- **New marketing announcements** (imp rebrand, branding). Queued separately per the hold-until-shipped rule.
- **Frontend code changes.** The vestigial trajectory-feedback UI (renders `TrajectoryReuseIndicator`, POSTs to a deleted backend route) is a frontend removal task, not a docs task. Do **not** document it.
- **Spec-only work.** The elevator-website spec (2026-07-04) has no implementation; docs must not reference it.

## 4. Decisions (from brainstorming, 2026-07-23)

| Decision | Choice |
| --- | --- |
| Scope | Everything: high + medium + low priority items, plus process items (schema regeneration) |
| Publication | Write all, publish freely — docs track the develop/main tips; no per-page gating machinery |
| Changelog | Excluded — docs pages only |
| Structure | Page-major, phased by surface; each file appears once with all changes consolidated |

## 5. Approach

Five phases grouped by surface. Phases 1–2 fix actively-wrong content (highest priority), Phase 3 adds the eight missing pages, Phases 4–5 sweep the remaining updates. Priorities per item: **H** = actively wrong or missing info for a shipped feature, **M** = discoverability gap, **L** = polish.

Conventions used below: "quote" means the audit verified the stale sentence verbatim at the cited line (line numbers are as of the 2026-07-15 snapshot — re-locate before editing). Backend/frontend refs are `repo:path` or commit hashes for verification during implementation.

---

## 6. Phase 1 — Developers tab: authentication rewrite (11 files)

The `oauth` → `authentication` refactor (`ExuluAuthConfig` discriminated union, tagged by `authType: "oauth" | "user_credentials"`). Verify all statements against `src/exulu/tool.ts`, `src/exulu/auth/` (types, validate, wrap-execute, credential-store), and `src/routes.ts` (credentials + oauth callback mounts).

### 6.1 `developers/core/exulu-tool/configuration.mdx` — H (+L)
- Frontmatter and body still document constructor option `oauth` (`ParamField path="oauth"`, type block omitting `authType`). Replace the OAuth section with an **Authentication** section covering both union arms:
  - `ExuluOauthConfig` (with required `authType: "oauth"` tag; behavior otherwise unchanged; `inputs.oauth = {accessToken, expiresAt, scopes}`).
  - `ExuluUserCredentialsConfig`: `authType: "user_credentials"`, `provider`, `fields: CredentialField[]` (`{name, label, type: "text"|"password", placeholder?, help?}`), optional server-side `validate(values)` hook.
  - Construction-time validation: duplicate field names rejected, field types checked, `BACKEND` env var required (`src/exulu/auth/validate.ts`).
  - Injected contexts: `inputs.oauth` vs `inputs.credentials`; values never transit the model.
  - `CredentialInvalidError(provider, reason?)` — throwing from `execute` deletes the stale row and re-prompts in the same turn.
- **L:** document `json` config option hydration semantics (object values pass through unchanged; strings are JSON-parsed — commit 7284c31). Currently the `json` type is listed but hydration is nowhere in the docs tree.

### 6.2 `developers/tutorials/oauth-tools.mdx` — H
- Both code samples declare `oauth: {...}`; intro says "declare an `oauth` config". Update every sample to `authentication: { authType: "oauth", ... }` and add a one-sentence breaking-rename migration note.
- Redirect-URI guidance (`BACKEND` + `/oauth/callback`) is unchanged — keep.
- Add one sentence: the no-token short-circuit now returns a structured `oauth: { authorizationUrl }` field which chat renders as a Connect card (backend `wrap-execute.ts`, frontend 560c5ec).

### 6.3 NEW `developers/tutorials/user-credential-tools.mdx` — H
Full tutorial for the `user_credentials` arm (nothing outside the changelog mentions it). Cover:
- Declaring `authType: "user_credentials"`, `provider`, `fields`, optional `validate`.
- Provider sharing: tools sharing a `provider` share one credential set per user.
- Runtime flow: no stored credentials → tool short-circuits with `{ credentialRequest: { provider, fields, submitUrl, nonce }, result: null }` (AES-sealed nonce over `{provider, userId, expiresAt}`, 15-min TTL) → chat renders the credential form card → `POST /credentials/submit` → decrypted values injected as `inputs.credentials` on the next call.
- Self-healing: throw `CredentialInvalidError` on provider-side 401s.
- User-side management: Settings → Connections (list + revoke), `GET /credentials` / `DELETE /credentials/:provider`.
- Security posture: payloads scrubbed from the model view and chat history; system guardrail refuses to collect secrets in chat (9276752, 35a8546, 4393b55).

### 6.4 `developers/core/exulu-tool/introduction.mdx` — H
Stale at ~lines 22, 99, the sample at 114 (`oauth: { provider: "google", ... }`), and the closing option-list card. Same rename treatment as 6.2.

### 6.5 `developers/core/exulu-tool/api-reference.mdx` — H
Instance-property table documents `oauth: ExuluOauthConfig | undefined`; the shipped class exposes `authentication?: ExuluAuthConfig` (`src/exulu/tool.ts:43`).

### 6.6 `developers/reference/functions-and-types.mdx` — H
Three defects: (a) says construction uses an `oauth` property; (b) claims injection as `inputs._oauth` — the code injects `inputs.oauth` (`wrap-execute.ts`); (c) the type listings omit `authType` on `ExuluOauthConfig` and are missing `ExuluAuthConfig`, `ExuluUserCredentialsConfig`, `CredentialField`, `ExuluCredentialsToolContext`, and `CredentialInvalidError` entirely. Add all five with signatures from `src/exulu/auth/types.ts`.

### 6.7 `developers/core/exulu-context/configuration.mdx` — H
The `ExuluContextFieldDefinition` block presents itself as the complete option list but lacks `hidden?: boolean` (`src/exulu/context.ts:72`). Add the ParamField + semantics: hidden fields are excluded from GraphQL reads, filters, sort, and groupBy (write-only secrets; 51ccd02, 1ca43ca).

### 6.8 `developers/reference/exulu-default-tools.mdx` — L (×2)
- The pipeline-factory docs are accurate but list none of the 13 saved knowledge-search config options — add them (source: `ee/agentic-retrieval/pipeline/index.ts` + config schemas).
- Add the auto-registered tools absent from the Developers tab: `read_session_file` (approval-free, pages offloaded outputs back), `parse_document`, `view_document_page`.

### 6.9 `developers/reference/exulu-read-api.mdx` — L
Add ParamFields for `embedQuery` opts (routing/cost-attribution notes already exist).

### 6.10 `developers/core/exulu-context/api-reference.mdx` — L
Add a forward cross-link to `exulu-read-api` (the link currently exists only in reverse).

### 6.11 `developers/reference/exulu-document-processor.mdx` — L
`maxPagesPerChunk` docs are correct but say nothing about byte size: the processor also bisects chunks exceeding 25 MB (`--max-size-mb 25` to `split_pdf.py`; de1c5f0, 9ee95ee).

---

## 7. Phase 2 — API reference: regeneration + core types + REST (15 files)

### 7.1 `api-reference/graphql/schema.graphql` — H (process item)
Regenerate via the `print-sdl` script (74863ae). The published schema still exposes `users.apikey/anthropic_token/temporary_token` (now hidden) and omits routineRuns, workflowTriggers, guest fields, `auto_approve_tools`, `sandbox_enabled`. **Also add a repeatable refresh step** (npm script in `mintlify-docs/package.json`, e.g. `npm run refresh-sdl`, invoking the backend print-sdl script and writing the artifact in place) and document the workflow in `mintlify-docs/AGENTS.md`. Generated artifacts are never hand-edited.

### 7.2 `api-reference/graphql/core-types/users.mdx` — H
- Remove `temporary_token`, `apikey`, `password`, `anthropic_token` from the SDL block and field notes — hidden since 51ccd02; the "write-only, set via usersUpdateOneById" note for `apikey` is also stale for reads.
- `type` field note says `"user"` / `"api"` only; add `"external"` (self-registered guest-mode users, frontend ensure-user route).

### 7.3 `api-reference/graphql/core-types/agents.mdx` — M (+L)
- Add the four guest read fields (`guest_access`, `guest_auth_mode`, `guest_cover_image`, plus the input-only plaintext `guest_password` — hashed server-side; `guest_password_hash` is never queryable/filterable).
- **L:** add a field note for `sandbox_enabled` (already in the SDL listing, absent from field notes).

### 7.4 `api-reference/graphql/core-types/job-results.mdx` — H + M
- `state` note lists only terminal `completed`/`failed`: add `waiting_approval` (persisted, non-terminal), `cancelled`, `filtered` (terminal) — b568c89, 73d6897.
- Add the four new fields: `trigger`, `trigger_metadata`, `session`, `workflow` (`ee/schemas.ts:268-280`).

### 7.5 `api-reference/graphql/core-types/workflow-templates.mdx` — M
- "triggered manually, via the API, or on a cron schedule" → add email triggers.
- Add `auto_approve_tools` (boolean, default false; `ee/schemas.ts:418`).

### 7.6 `api-reference/graphql/core-types/projects.mdx` — M
`budget` field note is one line; document the two shapes the resolver returns: full envelope for budget-management/super-admin viewers vs the reduced member view (272a45a, `budget-field.ts`).

### 7.7 `api-reference/graphql/core-types/transcription-jobs.mdx` — H
The `status` values listed are wrong, **and** the audit's first-pass correction was itself wrong — the implementer must re-derive the real written values from backend source (grep status writes in the transcription/recall job code) rather than trusting either list.

### 7.8 `api-reference/graphql/introduction.mdx` — M
The "Platform queries and mutations" accordion omits all new operations: `routineRuns`, `cancelRoutineRun`, `retryRoutineRun` (1753262) and the five email-trigger operations (`workflowTriggers` CRUD + `emailInboundConfig`, 7c35dfa).

### 7.9 NEW `api-reference/graphql/routine-runs.mdx` — M
Document the shipped API exactly: `routineRuns` query (filtering, needs-attention count), `cancelRoutineRun`, `retryRoutineRun` (retry-from-step semantics), run states, and the graceful behavior for role-less users (a080fef).

### 7.10 `api-reference/graphql/conventions.mdx` — M (×2)
- Access-control section: `rights_mode` is now settable on create when explicitly validated (a1c45e3).
- Sorting/statistics sections: since 1ca43ca, `sort.field` and `groupBy` must be non-hidden defined fields — document the validation error behavior.

### 7.11 `api-reference/graphql/dynamic-types.mdx` — M
Add a short note to the generated-type-family walkthrough: fields flagged `hidden` are omitted from object types, inputs, and filters.

### 7.12 `openapi/openapi.json` — H + M (+L)
- Add: `POST /credentials/submit`, `GET /credentials`, `DELETE /credentials/{provider}`, `GET /oauth/callback` (H).
- Add: `GET /me/usage` (H — the changelog already advertises a curl for it).
- Add the four public-agents paths: list, meta, cover, verify-password (M).
- Fix the agent-run endpoint description still describing the retired `rights_mode=public` unauthenticated rule (M).
- **L:** fix the shared-artifacts `rights_mode` property description ("For `regular` shares: `private`, `organization`, etc." — align with `check-record-access.ts` reality).

### 7.13 `api-reference/rest/introduction.mdx` — H + M (+L)
- Stale note: "The agent-run endpoint does not require authentication when the agent's `rights_mode` is set to `public`." → replace with the guest-access model (guest modes govern anonymous access; 4262d88).
- Add a **Skills registry** section: `GET /skills/registry?tag=` (RBAC-filtered), `GET /skills/registry/:name`, and the public bootstrap endpoint (be53b07, f482461, 2939798, b1b7c94) — powers the `imp` CLI.
- **L:** mirror the GraphQL intro's note that a session JWT via `x-api-key` also works (30960c8).

### 7.14 NEW `api-reference/rest/public-agents.mdx` — M
The four endpoints (`routes.ts` ~5278–5365): list, meta (8-field whitelisted projection), cover, verify-password (204/401/429, rate-limited); 404 on non-UUID or unpublished agents.

### 7.15 `api-reference/rest/gateways-litellm.mdx` — L
Pointer: the project detail page generates ready-made client configs (Claude Code / Cowork / continue.dev) for this gateway.

---

## 8. Phase 3 — New pages (8) + navigation

Each page ships with its `docs.json` nav entry (group placements below). Follow the existing page style in each tab (frontmatter description, Mintlify components, cross-link cards).

### 8.1 `building/agents/guest-access.mdx` — H — nav: Building → Agents
The whole guest-publishing surface (zero coverage today): the editor's Guest access section; three modes (public / password / login); the `/public/agents` visitor flow (selection page, per-agent gate, custom cover); external self-registration + login and the `ALLOWED_EMAIL_DOMAINS` exemption; external users are redirected out of the internal app; per-IP rate limits and message caps; precedence: guest mode governs anonymous access over legacy `rights_mode=public`.

### 8.2 `building/agents/knowledge-search.mdx` — H — nav: Building → Agents
The agentic retrieval pipeline's 13 saved config options (routing/memory/search/rerank phases, HyDE, multi-query RRF, fuzzy/exact prefilters, identifier pins, project scope, step budgets), what each does, and sensible defaults. Source: `ee/agentic-retrieval/pipeline/` config schemas. Note the editions positioning (`agentic-retrieval` module).

### 8.3 `building/routines/email-triggers.mdx` — H — nav: Building → Routines
Per-routine trigger addresses (generation + regeneration), allowlist chips, regex filter rules, limits; the guard chain in plain language (auto-reply suppression, allowlist, rate limits, Message-ID dedup, filters → `filtered` runs); email variables available to steps; prerequisite: platform email intake must be configured (cross-link 8.5).

### 8.4 `building/knowledge/bulk-import.mdx` — H — nav: Building → Knowledge
The import wizard: two exclusive flows (file drop vs CSV); CSV rows reference storage keys (filename matching is retired); template download with example row; storage-existence verification pass; inline cell errors; batch access (rights mode) control and the read-only access column in review.

### 8.5 `administration/email-intake.mdx` — H — nav: Administration
The super-admin `/configuration/email` surface: Mailgun signing-key setup (encrypted at rest), the setup checklist, the webhook URL (`BACKEND`-based `POST /webhooks/email/mime`), signature verification + replay guard, and what happens when intake is unconfigured.

### 8.6 `user-guide/chat/connecting-tools.mdx` — H — nav: User Guide → Chat
When a tool needs access: the credential form card (typed fields, submit, success state) and the OAuth connect card; the guest notice on public pages; secrets never shown to the model and redacted in tool chips; managing connections in Settings → Connections (list, revoke); never paste secrets into the chat itself (the system will refuse to collect them). Cross-link from `tool-approvals.mdx`.

### 8.7 `user-guide/chat/memory.mdx` — H — nav: User Guide → Chat
The memory tool from the user's side: when the agent saves a memory it asks whether it should be **private** (only you) or **public** (shared) — this maps to `rights_mode`; memory types; where memories are stored (the configured memory context) and how to review them.

### 8.8 `self-hosting/branding.mdx` — H — nav: Self-hosting
Client branding: single `favicon.png` replaces the old four-size icon set (**breaking** for existing self-hosted brand kits — the old `icon_16x16/32x32/48x48/512x512.png` links are gone), `apple-touch-icon`, the web-app manifest route, and `APP_NAME` (default "IMP") — where each is configured and what the fallbacks are.

---

## 9. Phase 4 — Existing-page sweep (~28 files, each edited once)

### User Guide
- **`user-guide/settings.mdx` — H:** "four sections" list is stale; add **Connections** (stored tool credentials: connected date, revoke with confirm) and **Usage** (range toggle, daily chart, per-model table; visible only when the admin budget-visibility toggle is on).
- **`user-guide/chat/tool-approvals.mdx` — M (×2, +L):** (a) routine runs pause as *waiting approval* when they hit an approval-gated tool and auto-resume after the approval turn in chat; (b) sending a new message while an approval card is pending auto-declines it (c3884ff); (c) cross-link `connecting-tools`; **L:** optionally mention KB write tools as an approval-prompting example.
- **`user-guide/chat/artifacts-and-sharing.mdx` — M (×2):** share dialog now reachable from three entry points (session-files panel, message actions, artifact viewer — frontend 3604cae); per-message formatted **copy/download for email and WhatsApp** (d7d4e3b).
- **`user-guide/chat/attachments-and-session-files.mdx` — M (×2):** on-demand document tools `parse_document` / `view_document_page` (sandbox); oversized tool outputs and extracted document text are capped and offloaded into Session Files, and the agent pages them back with `read_session_file`.
- **`user-guide/chat/context-compaction.mdx` — M:** per-call sandbox output truncation (25% of the agent's context window, 128k-char default) is separate from compaction — one sentence + cross-link.
- **`user-guide/chat/model-override-and-usage.mdx` — L (×2):** per-message input/output token split in the message footer; knowledge-search output shows a benchmark line (tokens + time).
- **`user-guide/chat/pinned-knowledge-and-presets.mdx` — L:** preset per-row edit and inline-confirm delete in the selection modal (visible to owners/editors only).
- **`user-guide/chat/overview.mdx` — L:** run-backed conversations carry a banner linking to the routine run.
- **`user-guide/chat/budgets-in-chat.mdx` — M:** the budget chip popover's **Details** link → Settings → Usage; add a next-steps card.
- **`user-guide/projects/working-in-a-project.mdx` — H + M (×2):** header now shows a read-only budget indicator (H — header enumeration is stale); overflow menu: **Download Claude Code / Cowork / continue.dev config** + **Copy project ID** (what each file contains, requests route through the project gateway); project Files feed retrieval scope for project sessions.
- **`user-guide/transcripts/reviewing-and-saving.mdx` — H + M:** the post-processing list now renders never-ran prompts as **Run** cards ("Running…" while a claim is fresh, <30 min) — the "each prompt … Re-run" description is stale; deleting a saved entry offers an optional cascade delete of the exported knowledge item.
- **`user-guide/transcripts/recording-meetings.mdx` — M:** recovery guarantees — interrupted meeting jobs self-heal automatically (reconcile sweep), with a bounded give-up (24h).
- **`user-guide/transcripts/overview.mdx` — L:** one sentence: jobs stuck in Processing recover automatically.

### Building
- **`building/agents/workbench.mdx` — H + M (×3):** sandbox row is stale — the toggle now provisions the file sandbox with the document tools (H); section enumeration/count must include Guest access; step-budget field: per-message scope, `0` = platform default of 10; Long-term memory: tool name is `create_<sanitized-context-name>_memory_item` and it asks private/public before saving.
- **`building/agents/tools-and-skills.mdx` — H (×2) + M:** add the **Knowledge base editor** picker entry + config sheet (per-context create/update switches, approval behavior) (H); skills require the sandbox — enabling a skill on a sandbox-disabled agent has no effect (H); parameter types: add `boolean` and `json` (+ hydration cross-ref to 6.1).
- **`building/agents/access-and-safety.mdx` — H + M:** add guest publishing (summary + link to 8.1) and the precedence rule over `rights_mode=public` (H); KB write-tools safety model: explicit per-context opt-in, dual gate (agent config + row-level write access), guest refusal, schema exclusions (file/uuid/calculated/hidden/reserved keys).
- **`building/agents/overview.mdx` — L:** fix the workbench section count card.
- **`building/routines/overview.mdx` — H:** trigger sentence ("on demand … or on a cron schedule") must include email triggers; workbench section list gains **Triggers**.
- **`building/routines/runs-and-schedules.mdx` — H (×2):** the substantive rewrite: eight workbench sections; run states incl. `waiting_approval` / `filtered` / `cancelled`; approval pauses + auto-resume after a chat approval; retry-from-step; cancel; needs-attention count and badge; `auto_approve_tools` (queue-backed runs respect tool approvals unless set); the runs console lives on the Routines page (there is no `/runs` route); trigger-source stamping (manual/API/scheduled/email).
- **`building/knowledge/overview.mdx` — M + L:** agents can now also *write* items when the KB editor is enabled (retrieval-only framing needs a sentence + link); mention importing in the Items card.
- **`building/knowledge/items.mdx` — M + L:** "New item" is no longer the only creation path — add bulk import (link 8.4) and agent-created/updated items (link tools-and-skills).

### Administration
- **`administration/budgets.mdx` — M:** the "Show budget status to users" toggle now also gates the personal Usage section in Settings and the Details link in the top-bar popover.
- **`administration/users-access/overview.mdx` — M:** external accounts: self-registered guests land in the users table as `type="external"` with the seeded `external` role, and are redirected out of the internal app.
- **`administration/users-access/roles.mdx` — M:** document the seeded **external** role (all permission areas null) + warning not to grant it internal permissions.
- **`administration/analytics.mdx` — L:** the second caption line on spend/tokens/requests cards shows usage not attributed to any user/team/agent tag.
- **`administration/theme.mdx` — L:** note the `/configuration/email` sibling page (link 8.5).

### Get Started
- **`get-started/editions.mdx` — M:** "Agentic retrieval — iterative multi-strategy search" describes the deleted v3 engine; reword to the pipeline engine (routing/search/rerank phases; link 8.2).
- **`get-started/concepts.mdx` — L:** extend the theme sentence to mention branding assets (favicon, `APP_NAME`; link 8.8).

---

## 10. Phase 5 — Self-hosting (7 files)

- **`self-hosting/environment-variables.mdx` — H + M (×2):** add `EXULU_GUEST_RATE_PER_MINUTE` (10), `EXULU_GUEST_RATE_PER_HOUR` (60), `EXULU_GUEST_MAX_MESSAGE_CHARS` (8000), `EXULU_GUEST_MAX_TOTAL_CHARS` (32000), `EXULU_TRUST_PROXY` (H); extend the `BACKEND` row (also the base for inbound-email webhook URLs and credential submit URLs); add `APP_NAME` (M). The page claims to be the authoritative env-var reference — it must actually be complete.
- **`self-hosting/database.mdx` — H + L (×2):** correct the migrations description if stale vs current initdb behavior; document the `user_credentials` table, the unconditional `DROP TABLE IF EXISTS oauth_tokens CASCADE` on boot, and the warning that rotating `NEXTAUTH_SECRET` makes stored tool credentials undecryptable (users must reconnect); short note that secret columns are write-only at the API layer.
- **`self-hosting/services/smtp-and-auth.mdx` — H:** the `ALLOWED_EMAIL_DOMAINS` paragraph is stale — external/guest self-registration is exempt from the domain restriction.
- **`self-hosting/architecture.mdx` — M:** add a public-webhook inventory: `POST /webhooks/email/mime` (Mailgun-signed, persist-before-ACK) and the Recall webhook — both must be internet-reachable; exposure/proxy guidance.
- **`self-hosting/services/redis.mdx` — L:** persistence guidance: guest/email rate-limit windows and email dedup keys live in Redis; data loss resets limits (bounded blast radius).
- **`self-hosting/troubleshooting.mdx` — M:** add a "Meeting recording stuck in Processing" accordion: the reconcile loop (runs when Recall is enabled) self-heals within ~60s cycles; what to check if it doesn't.
- **`self-hosting/containers.mdx` — L:** the poppler line must include `pdftotext` — it is now a startup-probed required binary (`src/exulu/system-dependencies.ts`).

---

## 11. Content standards

1. **Verify before writing.** Every statement is checked against shipped code at implementation time; the audit's line refs are hints, not gospel (one audit finding — transcription statuses, §7.7 — was itself corrected by the verifier). Never copy claims from the changelog or release pages without a code check.
2. **Page-major edits.** Each file is opened once; all bullets for that file land in a single edit/PR unit.
3. **Match the tab's voice.** Reuse each tab's existing frontmatter style, Mintlify components (`ParamField`, `Note`, `Card`, accordions), and heading depth. IMP naming throughout (no bare "Exulu" in new prose).
4. **Generated artifacts are regenerated, never hand-edited** (`schema.graphql` via the refresh script; `openapi.json` is hand-maintained today — edit it directly but keep it internally consistent).
5. **Cross-link, don't duplicate.** New pages own their topic; existing pages get a sentence + link (e.g. tool-approvals → connecting-tools).

## 12. Validation gates (per phase)

1. Mintlify link check (`mintlify broken-links` / `mint broken-links`) passes.
2. Every page referenced in `docs.json` exists and vice versa (new pages added to nav; no orphans).
3. Grep gates: zero occurrences of `oauth:` as an ExuluTool constructor sample, `inputs._oauth`, or `ExuluOauthConfig` without `authType` in the Developers tab; zero hits for the retired `rights_mode=public` unauthenticated-run rule outside historical changelog content.
4. `schema.graphql` byte-matches a fresh `refresh-sdl` run.
5. Spot-check each H item's stale quote is gone (the audit JSON is the checklist).

## 13. Follow-ups (explicitly out of this spec)

1. **Changelog/release pipeline** (excluded by decision): July 20 credentials entry lacks the July 22 UI wave; `exulu → imp` CLI rename on the connect-your-agent release page; June 22 agent-workbench stub entry; `build-changelog.mjs` external-href handling; queued announcements (imp rebrand, branding).
2. **Frontend cleanup:** remove the vestigial trajectory-feedback UI (`TrajectoryReuseIndicator`, POST `/retrieval/trajectories/:ref/feedback` — backend route deleted 2026-07-04).
3. **Docs process:** consider wiring `refresh-sdl` (and a future openapi generation) into CI so generated artifacts can't drift after the next feature wave.

## 14. Size estimate

11 new pages (8 in Phase 3, plus the user-credentials tutorial in §6.3 and the two API-reference pages in §7.9/§7.14), ~58 updated files, ~70 consolidated work items (≈30 H / ≈25 M / ≈15 L). Suitable for one implementation plan with five phases; phases 1–3 are independently shippable.
