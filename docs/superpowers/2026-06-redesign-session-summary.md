# Frontend Redesign Sweep — Session Summary

**Date range:** 2026-06-13 → 2026-06-16
**Frontend branch:** `redesign/phase-0-foundations` (+44 commits ahead of origin)
**Backend branch:** `develop` (+6 commits ahead of origin)

This document summarizes everything the multi-day redesign sweep landed, plus everything it surfaced for the backend backlog. Written for backend engineers who need to know what frontend now expects, what schema work is queued, and the operational notes worth keeping.

---

## 1. What shipped

### 1.1 Phase 3 — Build area & P3 Admin sweep

| Item | Frontend commit | Backend commit |
|------|----------------|----------------|
| **3.3.1** Analytics LiteLLM pivot (drop `trackingStatistics`, source-of-truth → LiteLLM `/tag/daily/activity`) | `0101bd6` + `6205d65` + `37eab75` | `fe0f9b9` (proxy endpoint) |
| **3.3.2** Routines dimension + routine budget tab (closes WORKFLOW_RUN → dimension gap) | `a19c06f` | `28e7cbe` (routine_id_/routine_name_ tags + accept entity_type=routine in budgets) |
| **3.3.3** Lens.type → dimension collapse + first totals dedup attempt | `4f7bdbb` | `edfc380` (initial canonical user_id_ dedup) |
| **3.3.4** CSV export + range/dimension polish + workflow_template.budget GraphQL field | `ad9f71b` | `07b7a15` (drop listTagsByPrefix translation — later REVERTED; add byTagByDay; expose budget on workflow_template GraphQL type) |
| **3.3.5** Real totals fix (LiteLLM response shape investigation) + hydrate teams/roles names | `ec1b59c` + `4fd2924` + `252832e` | `8c45f28` (restore listTagsByPrefix translation) + `9a31b02` (read per-tag breakdown from `breakdown.entities` — final fix) |
| **4.2 Models** — full migration to LiteLLM-only read-only catalog. Custom CRUD path deleted (8 files, ~1140 LOC). 8 GraphQL queries deleted. Two downstream consumers (`agent-model-selector.tsx`, `chat/hooks.ts#useAvailableModels`) collapsed to LiteLLM-only branch. Nav gate relaxed `agents:write` → `agents:read`. | `0d6d0c1` | — |
| **4.5 Variables / Vault** — secrets no longer over-fetched. Query split: `GET_VARIABLES_LIST` (no value), `GET_VARIABLES_LITE` (consumer selects), `GET_VARIABLE_VALUE` (single-by-id, no-cache), `GET_VARIABLE_USAGE`. New SecretField primitive with on-demand reveal + auto-remask. New detail panel Sheet. Edit page: no auto-fetch of secret on mount. Bulk delete via ConfirmDialog. Mobile cards. Hooks-in-loop violation on usage page fixed. Read-role redirect guard. Full `variables.*` i18n in en+de. | `ccc9a33` + `70df375` | — |
| **4.6 Feedback console** — PageShell + PageHeader + Toolbar + ListDetail. Three split files (`feedback-list.tsx`, `feedback-toolbar.tsx`, `use-feedback-query.ts`). New detail panel with "Open in Chat" link. EntityCombobox primitive (replaces 1000-row Selects). Header summary stat from `pageInfo.itemCount` probes. ConfirmDialog on bulk delete. Mobile cards. Type indicator semantic tokens (no purple). Agent/user name hydration via batch queries. | `f1956c5` + `d3631aa` | — |
| **5.1 Evals** — biggest scope. List pages + detail Tabs restructure + run matrix CSS-grid rewrite + queue panel Sheet + close both RBAC leaks. Full `evals.*` i18n (was zero). | `e609e98` + `e1e5073` | — |
| **Knowledge cleanup** — extend view-mode CopyButton coverage to description + tags. Three other backlog items already done in earlier commits. | `fbe13f1` | — |

### 1.2 Adjacent polish (not in tracking table)

- Calendar primitive upgraded to react-day-picker v9 classNames API (silently regressed when the package bumped). `09a9aca`.
- Chat-side U6: `ReferencedSourceRow` Deactivate now routes through ConfirmDialog (was direct `onClick` → global archive mutation with no confirmation). In `f1956c5`.

---

## 2. What backend needs to schedule

Twelve tickets surfaced. None blocks current frontend behavior — every UI ships with an honest-degradation state where backend lags. Listed by priority (mandate-critical first).

### 2.1 Variables (`/variables`)

**BE-1: `variable.used_by` resolver** — **mandate-critical**. The "where is this secret used" pillar of the vault page is dead code today. Add `used_by: [String]` (and `used_by_count: Int`) to the GraphQL `variable` type. Sources to scan:
- `users.anthropic_token` (per existing TODO in `columns.tsx:133-136` from the pre-redesign codebase) → emit `"user/<id>"`
- Agent config JSON (by NAME, per `agents/edit/[id]/form.tsx:111-150` + `hooks.ts:505`) → emit `"agent/<id>"` — label as heuristic "referenced in configuration"
- Embedder settings (`stage-embedder.tsx` writes the variable id) → emit `"embedder/<id>"`
- Workflows → emit `"workflow/<id>"`
- Models — out of scope post-4.2 (model-form.tsx deleted). Confirm with team whether LiteLLM YAML references Exulu variable names; if so, surface at ingest time, not on the variable resolver.

Until shipped: every "Used by" surface renders `t("variables.usedBy.unavailable")`. **Never "0 resources"** — the UI fakes nothing.

**BE-2: Value-on-demand semantics audit** — **latent data-corruption risk**. Two questions:
- (a) On `variableById(id) { value }` for an encrypted variable, does the resolver return **decrypted plaintext** or **ciphertext**? If ciphertext, the current edit flow round-trips it into `UPDATE_VARIABLE` and re-encrypts it, **corrupting any variable edited twice**. Audit existing data before any write-path changes.
- (b) Does `variablesUpdateOneById(id, input: { value: null })` treat null as "leave value unchanged" or "blank the value"? The frontend's value-unchanged semantics (post-4.5 simplification) rely on the former. Confirm or add an explicit `valueChanged: Boolean` input field.

**BE-3: Actor attribution** — QoL. Add `created_by: User`, `updated_by: User`, optionally `last_revealed_by` + `last_revealed_at` to the `variable` type. personas.md P3 explicitly asks for actor attribution on admin surfaces.

**BE-4: `agentsByIds` batch resolver** — small QoL. Mirror `usersByIds` (`queries.ts:1608`) so the variables-usage list doesn't fall back to N+1 fetches in `Promise.all`.

### 2.2 Feedback (`/feedback`)

**BE-5: `feedbackUpdateOne` mutation for status triage** — `FEEDBACK_FIELDS` selects `status` but no UI consumes it because the mutation doesn't exist. With it, the detail panel can flip `new → reviewed → resolved` and the list can hide resolved items by default. Suggested shape: `feedbackUpdateOne(id: ID!, input: {status: FeedbackStatus}): Feedback`.

**BE-6: True bulk-delete endpoint** — today `feedback-list.tsx` fans out N requests via `Promise.all`. Fine for 20-row pages, but a transactional endpoint lets ConfirmDialog surface per-id errors. Suggested: `feedbackRemoveMany(filter: FilterFeedback, ids: [ID!]): {removedCount, errors: [{id, message}]}`.

**BE-7: `feedback` role right in RBAC** — `components/role-form.tsx` `PERMISSION_AREAS` has no `feedback` key. /feedback is super-admin-or-nothing. Adding `feedback:read|write` opens the P2 secondary persona (power users seeing feedback for their own agents) without IA change. Backend filter must scope by agent ownership for `read`. When it lands, flip `nav-config.ts:214` from `requires: 'super_admin'` to `{area: 'feedback', level: 'read'}` — no other frontend change.

**BE-8: Server-side name enrichment on `feedbackPagination`** — today the table hydrates names client-side via one batched `GET_AGENTS_BY_IDS` + one `GET_USERS_BY_IDS` per page (interim post-`d3631aa`). Denormalizing `agentName / userName / userEmail` onto `feedbackPagination` items drops both round-trips. When it lands, delete the two `useQuery` calls + maps in `feedback-list.tsx`.

**BE-9: `createdAt` range operator on `FilterFeedback`** — optional. Only needed if the header summary stat becomes time-windowed (e.g. "last 30d positive vs negative"). The current all-time `pageInfo.itemCount` probes work fine.

### 2.3 Evals (`/evals`)

**BE-10: `GET_EVAL_SETS` aggregate** — **highest value**. Add per-set fields:
- `test_case_count: Int!` — number of test cases with `eval_set_id = set.id`
- `last_run: { id, status, avg_score, finishedAt } | null` — most recent eval run

Unlocks the "Cases" + "Last run" columns on the /evals list (status dot + average score + relative time). Spec **explicitly forbids client-side per-row fan-out as fallback** — the columns stay invisible until this lands.

**BE-11: Batched `GET_JOB_RESULTS` for the matrix** — today each visible run column fires its own `GET_JOB_RESULTS` query (`label contains "eval-run-{id}"`, limit 500). 8 columns × 500 rows × N polls. Proposed: accept `OR` semantics over labels, OR a dedicated `eval_run_results(run_ids: [ID!]!)` resolver. Critical: preserve the label semantics (`label contains "eval-run-{id}"` + `label contains "{test_case_id}"`) — both id substrings drive per-cell lookup.

**BE-12: Bulk `UPDATE_TEST_CASE` for set membership** — today `[id]/page.tsx` loops N independent mutations through `Promise.all` (now wrapped in serialized progress UI but still N-mutation underneath). Proposed: `addTestCasesToEvalSet(eval_set_id: ID!, test_case_ids: [ID!]!)` with 500-cap + dedupe + returns updated list.

**BE-13: `rights_mode` / RBAC editing UI for eval runs** — frontend ticket actually, but blocked on understanding what the backend `rights_mode` enum allows. `CREATE_EVAL_RUN` / `UPDATE_EVAL_RUN` accept `rights_mode` (default `"private"`) + `RBAC.users`/`RBAC.roles` arrays. The dialog passes them through but exposes no editor. Invisible access semantics violate "Nothing here can surprise me."

---

## 3. Backend changes that shipped this session

Six backend commits on `develop`, all related to LiteLLM analytics.

| Commit | What it does |
|--------|--------------|
| `fe0f9b9` | New `/admin/litellm/tag-activity` proxy endpoint (3.3.1) — attaches LITELLM_MASTER_KEY server-side so the frontend never sees it. |
| `28e7cbe` | `buildTags()` emits `routine_id_<id>` + `routine_name_<name>` for cron-triggered workflow runs. `/admin/budgets/*` accepts `entity_type='routine'`. New `BUDGET_ENTITY_SINGULARS` for hydration. (3.3.2) |
| `edfc380` | First totals dedup attempt — canonical `user_id_` prefix filter. Removed `suppliedTotals` fallback (it was multi-counting). (3.3.3) |
| `07b7a15` | Removed `listTagsByPrefix` translation (assumed LiteLLM returned all data unfiltered — wrong). Added `byTagByDay[]` accumulator for the CSV pivot. Added `workflow_template` to GraphQL `budget` field whitelist (`schemas/index.ts:105`). (3.3.4) |
| `8c45f28` | Restored `listTagsByPrefix` translation — `/tag/list` returns ALL tags (not just budgeted; the earlier reasoning was wrong). (3.3.5) |
| `9a31b02` | **Final totals fix** — LiteLLM `/tag/daily/activity` returns one row per **date** with aggregate metrics + nested `breakdown.entities` keyed by tag name. There's NO `row.tag` field. Rewrote `projectTagActivity` to read per-tag data from `breakdown.entities`, per-model from `breakdown.models`, daily from `row.metrics` directly. Prefers `metadata.total_*` for totals (canonical, includes cache-token deltas). (3.3.5) |

### Notable backend response shape

LiteLLM `/tag/daily/activity` actual response (verified live, undocumented):

```json
{
  "results": [{
    "date": "2026-06-15",
    "metrics": { "spend", "prompt_tokens", "completion_tokens", "total_tokens", "successful_requests", "failed_requests", "api_requests", "cache_read_input_tokens", "cache_creation_input_tokens" },
    "breakdown": {
      "models": { "<model_name>": { "metrics": {...} } },
      "model_groups": { "<group>": { "metrics": {...} } },
      "providers": { "<provider>": { "metrics": {...} } },
      "endpoints": { "<endpoint>": { "metrics": {...} } },
      "api_keys": { "<key_alias>": { "metrics": {...} } },
      "entities": { "<tag_name>": { "metrics": {...} } }
    }
  }],
  "metadata": {
    "total_spend", "total_prompt_tokens", "total_completion_tokens", "total_tokens",
    "total_api_requests", "total_successful_requests", "total_failed_requests",
    "total_cache_read_input_tokens", "total_cache_creation_input_tokens",
    "page", "total_pages", "has_more"
  }
}
```

Required query params: `start_date`, `end_date`, and at least one of `tags` (CSV) or `model`. **Without `tags` returns aggregate rows with no `tag` field** — that's the trap that caused two iterations of the totals fix.

LiteLLM `/tag/list` returns all emitted tags (both budgeted via `litellm_budget_table` and ad-hoc). The earlier assumption that `/tag/list` was budget-only was incorrect.

LiteLLM `/global/spend/all_tag_names` exists as a lighter alternative for enumeration (returns just `{tag_names: [...]}`). Not currently used but available if `/tag/list` becomes expensive at scale.

---

## 4. Direction memos saved

Five direction notes live in the frontend session memory under `~/.claude/projects/.../memory/`:

| File | Purpose |
|------|---------|
| `litellm-only-models-direction.md` | Platform is migrating to LiteLLM-proxy-only for model management. Custom-models CRUD deleted in 4.2. Treat any proposal involving `model-form`/`CREATE_MODEL`/etc as obsolete. |
| `api-explorer-skipped.md` | Work item 5.2 intentionally skipped — page is third-party library, not under our control. |
| `variables-4.5-backend-backlog.md` | BE-1..4 above, plus operational caveats (dropped 30s poll → refetch-on-focus; read-role mutation rejection must be verified). |
| `feedback-4.6-backend-backlog.md` | BE-5..9 above, plus a spec-divergence note (design/pages/feedback.md prescribes stacked ConfirmDialog over chat modal; codebase-structure §2.1 forbids modal-on-modal). |
| `evals-5.1-backend-backlog.md` | BE-10..13 above, plus a **workflow lesson**: multi-builder workflows should never include a fix-up agent that can revert valid work based on misread scope-violation flags. Phase 5.1 lost ~2000 LOC of Builder C output that had to be rebuilt. |

---

## 5. Loose threads (not in any backend backlog)

- **Credential rotation** in vendor dashboards: PhotoRoom (`sk_pr_default_a33a0ab3...`), TinyPNG (`vF5yRvMn...`), `FEEDBACK_TOKEN`. Operational, requires dashboard access.
- **Feedback spec divergence**: `design/pages/feedback.md` should be updated to align with `codebase-structure.md` §2.1 (no modal-on-modal) — the chat-side Deactivate now sits inside a single overlay per the codebase rule, not the stacked dialog the spec describes.
- **`design/responsive.md` and `design/navigation.md`**: forward-referenced by `philosophy.md` and several page specs but don't exist yet. Multiple page specs include their own normative breakpoint/nav spec as a self-sufficient seed for these docs when they're written.

---

## 6. Tracking table status

All redesign items in `frontend/design/IMPLEMENTATION_PLAN.md` either complete or explicitly skipped. The redesign sweep is done end-to-end.

| Phase | Item | Status |
|-------|------|--------|
| 0.x | Foundations, hygiene, tokens, directory scaffolding | Done before this session |
| 1.A/B/C | Spine, palette, Home route | Done before this session |
| 2.x | Workspace pages | Done before this session |
| 3.x | Build area pages (3.1 access, 3.2 budgets, 3.3 analytics, 3.4 knowledge) | Done |
| 4.2 | Models | **Done this session** |
| 4.5 | Variables | **Done this session** |
| 4.6 | Feedback | **Done this session** |
| 5.1 | Evals | **Done this session** |
| 5.2 | API Explorer | **Skipped** — library-provided |

---

Generated 2026-06-16 from `redesign/phase-0-foundations` @ commit `fbe13f1`.
