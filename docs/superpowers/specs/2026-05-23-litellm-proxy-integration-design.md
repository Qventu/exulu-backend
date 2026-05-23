# LiteLLM Proxy Integration — Design

**Date:** 2026-05-23
**Status:** Drafted (pending user review)
**Sibling spec:** Spec A — Models entity & agent decoupling (committed as `815efc3` backend / `ad2f1bc` frontend; this spec builds directly on its `resolveModel()` seam)

## Goal

When the dev sets `EXULU_USE_LITELLM=true`, Exulu boots a LiteLLM proxy as a child process (using the existing `ee/python/.venv`), routes all language-model traffic through it via `@ai-sdk/openai-compatible`, and treats LiteLLM's `config.yaml` as the single source of truth for the model catalog. Our DB `models` table becomes dormant. The Models admin page becomes a read-only viewer of LiteLLM's catalog. Agents reference models by their LiteLLM model name (e.g., `"vertex-flash"` — whatever the dev named it in `config.yaml`).

## Background

Spec A introduced `resolveModel()` as the single seam for "give me a `LanguageModel` for this agent". It currently does: load Models row from DB → find ExuluProvider by `model.provider` → decrypt auth variable → call `exuluProvider.config.model.create({ apiKey, ... })`. The spec explicitly anticipated that Spec B (this one) would add a LiteLLM branch as a single `if (litellmEnabled) { ... }` inside this function.

LiteLLM is a Python proxy (`pip install litellm[proxy]`) that exposes 100+ LLM providers behind a single OpenAI-compatible API and natively handles request-rate limits, token budgets, cost tracking, and per-key virtual quotas. By delegating to it we get cost controls and request-rate enforcement that Spec A only stubs out (the inert `requests_per_window` / `token_budget` / `cost_budget_usd` fields).

## Scope

**In scope:**
- New `EXULU_USE_LITELLM` env var (default `false`). New `LITELLM_MASTER_KEY` (required when on), `LITELLM_CONFIG_PATH` (default `ee/python/.litellm/config.yaml`), `LITELLM_PORT` (default `4000`), `LITELLM_HOST` (default `127.0.0.1`).
- Add `litellm[proxy]` to `ee/python/requirements.txt` — picked up automatically by the existing postinstall.
- New supervisor module `src/exulu/litellm/supervisor.ts` that spawns LiteLLM on boot, monitors stdout/stderr, exponential-backoff respawn (cap 5 attempts), clean shutdown via SIGTERM.
- Single conditional inside `resolveModel()`: in LiteLLM mode, bypass the DB and ExuluProvider lookup; construct a `LanguageModel` via `@ai-sdk/openai-compatible` pointing at LiteLLM with `modelId` used directly as the LiteLLM `model_name`.
- Extension of the existing `/config` endpoint at `routes.ts:509` with `liteLLM: { enabled: boolean }`. Frontend reads this via the existing `ConfigContextProvider` — no new GraphQL roundtrip.
- New GraphQL query `litellmCatalog`: backend hits LiteLLM's `/model/info` admin endpoint and returns a slimmed-down list of available models. Used by the Models admin page (in read-only mode), `AgentModelSelector`, and the chat header dropdown.
- Frontend mode-awareness: when `configContext.liteLLM.enabled === true`, Models page is read-only with a banner + Admin-UI link, `AgentModelSelector` and chat dropdown source from `litellmCatalog`.
- Documented one-way nature of the toggle: turning LiteLLM on (or off) requires admins to re-point existing agents.

**Out of scope (explicitly):**
- Auto-migration of `agents.model` UUIDs to LiteLLM model names. Admins re-point each agent in the UI; agent runs fail with a clear error when they can't resolve.
- Pushing rate/budget/cost limits from our Models table into LiteLLM. The dev configures everything in `config.yaml`. Spec A's "requires LiteLLM" rate/budget fields on the Models admin form become unreachable in LiteLLM mode (because the whole CRUD UI is hidden).
- Externally-hosted LiteLLM (e.g., a separate container the dev manages). Default is "Exulu spawns it." Easy to add later via a `LITELLM_BASE_URL` env override — single env check at the supervisor — but we deliberately ship without it.
- LiteLLM Admin UI integration. We link to LiteLLM's own UI on `:4000/ui` if the dev wants it.
- Read-back of LiteLLM's rate-limit state into our Statistics tables.
- Hot-reload of `config.yaml`. Dev restarts Exulu to pick up config changes.
- Per-tool API key flow for tools that need an upstream-provider key directly (Anthropic raw passthrough, Vertex billing labels). These tools degrade gracefully in LiteLLM mode (documented).

## Lifecycle: LiteLLM supervisor

**New module:** `src/exulu/litellm/supervisor.ts`. Called from the Exulu boot path (alongside DB init, telemetry start, etc.).

**Boot flow:**

1. Read `process.env.EXULU_USE_LITELLM`. If not `"true"`, return early — LiteLLM is off for this instance.
2. Validate required env vars. `LITELLM_MASTER_KEY` is required; missing it throws on boot. Optional vars with defaults: `LITELLM_CONFIG_PATH` (`ee/python/.litellm/config.yaml`), `LITELLM_PORT` (`4000`), `LITELLM_HOST` (`127.0.0.1`).
3. Check `LITELLM_CONFIG_PATH` exists. If not, log a clear error pointing to `ee/python/.litellm/config.yaml.example` (we ship one — see below) and **skip the spawn** but keep Exulu running so the admin UI is reachable to debug. `resolveModel` then fails with `LITELLM_NOT_READY` for any agent run until the config is provided and Exulu restarted.
4. Verify the Python venv (`isPythonEnvironmentSetup()` from `src/utils/python-setup.ts`). Skip + log if missing.
5. `spawn(`${venvPath}/bin/litellm`, ["--config", configPath, "--port", port, "--host", host], { ... })` with stdout/stderr piped.
6. Pipe LiteLLM's output to `console.log` lines prefixed `[EXULU-LITELLM]`. No separate log file — ops captures Exulu stdout however they already do.
7. On child `exit`: log + spawn replacement with exponential backoff (start at 1s, cap at 30s). After 5 consecutive crashes, stop respawning and log *"LiteLLM keeps crashing — fix the config and restart Exulu"*. Exulu itself keeps running.
8. Readiness probe: poll `GET http://${host}:${port}/health` every 200ms for up to 30s. Resolve a memoized `litellmReadyPromise` on 200; reject on timeout. `resolveModel` `await`s it on first use.
9. Register `SIGINT` / `SIGTERM` / `process.on("exit")` handlers that send `SIGTERM` to the LiteLLM child, wait up to 5s, then `SIGKILL`. Clean shutdown in dev (Ctrl-C) and prod (k8s scale-down).

**New file:** `ee/python/.litellm/config.yaml.example` — a starter config:

```yaml
# Documentation: https://docs.litellm.ai/docs/proxy/configs
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY

model_list:
  - model_name: vertex-flash
    litellm_params:
      model: vertex_ai/gemini-2.5-flash
      vertex_project: os.environ/GOOGLE_VERTEX_PROJECT
      vertex_location: europe-west1
      vertex_credentials: os.environ/GOOGLE_VERTEX_CREDENTIALS_JSON
  - model_name: claude-haiku
    litellm_params:
      model: anthropic/claude-haiku-4-5
      api_key: os.environ/ANTHROPIC_API_KEY
```

**Localhost binding default:** LiteLLM has its own auth (master key), but binding to `127.0.0.1` prevents it from being addressable from outside the host. Devs deliberately set `LITELLM_HOST=0.0.0.0` for k8s deployments where they want it externally reachable.

## Resolver branch

Single conditional at the top of `src/exulu/resolve-model.ts`. The else-path is the Spec A logic, untouched.

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

let _litellmProvider: ReturnType<typeof createOpenAICompatible> | undefined;
const getLiteLLMProvider = () => {
  if (_litellmProvider) return _litellmProvider;
  const host = process.env.LITELLM_HOST ?? "127.0.0.1";
  const port = process.env.LITELLM_PORT ?? "4000";
  const masterKey = process.env.LITELLM_MASTER_KEY;
  if (!masterKey) {
    throw new ResolveModelError(
      "LITELLM_NOT_CONFIGURED",
      "LITELLM_MASTER_KEY is required when EXULU_USE_LITELLM=true",
    );
  }
  _litellmProvider = createOpenAICompatible({
    name: "litellm",
    baseURL: `http://${host}:${port}/v1`,
    apiKey: masterKey,
  });
  return _litellmProvider;
};

export async function resolveModel(input: ResolveModelInput): Promise<ResolvedModel> {
  const { modelId, user, providers, agent, project, rbacBypass } = input;
  const rbacRequest = input.rbacRequest ?? "read";

  // ─────────── LiteLLM branch ───────────
  if (process.env.EXULU_USE_LITELLM === "true") {
    await waitForLiteLLMReady();   // memoized; only blocks first call

    const litellm = getLiteLLMProvider();
    const languageModel = litellm(modelId);

    const syntheticModel: ModelRow = {
      id: modelId,
      name: modelId,
      provider: modelId,
      active: true,
      rights_mode: "public",
      created_by: "litellm",
    };

    return {
      languageModel,
      model: syntheticModel,
      exuluProvider: LITELLM_PROVIDER_SENTINEL,
      apiKey: undefined,
    };
  }

  // ─────────── Catalog branch (Spec A, unchanged) ───────────
  // ... existing code
}
```

**Key design points:**

- **No DB lookup in LiteLLM mode.** `modelId` is the LiteLLM `model_name` directly (e.g., `"vertex-flash"`).
- **No RBAC at the resolver in LiteLLM mode.** LiteLLM has its own auth (virtual keys + access groups in config.yaml). RBAC on *which user can call which agent* still applies higher up the call chain via `checkRecordAccess(agent, ...)`.
- **`LITELLM_PROVIDER_SENTINEL`** is a frozen object that throws on any property access with a descriptive message. Call sites that read `exuluProvider.capabilities` / `.workflows` in LiteLLM mode get a loud error rather than silent `undefined`. These call sites (listed below) all need defensive handling.
- **No `apiKey` in LiteLLM mode.** Upstream auth happens inside LiteLLM from its own config.
- **New error code `LITELLM_NOT_READY`** → HTTP 503 in call sites.

**Refactors required so LiteLLM-mode boot doesn't crash on existing call sites:**

1. **`addProviderFields` in `sanitize-and-hydrate-fields.ts`**: when `EXULU_USE_LITELLM === "true"`, set `result.modelName = agent.model`, `result.providerName = "LiteLLM"`, and leave `capabilities`/`maxContextLength`/`authenticationInformation` as empty defaults. The function never reaches the Model-row DB lookup in LiteLLM mode.
2. **`resolveAgentProvider`**: returns `undefined` in LiteLLM mode. The 5 workflow sites in `graphql/schemas/index.ts` already check for `undefined` and error with a clear message — works as-is.
3. **`/config` endpoint** in `src/exulu/routes.ts:509`: add `liteLLM: { enabled: process.env.EXULU_USE_LITELLM === "true" }` to the response payload.

## Frontend changes

Detection: `configContext.liteLLM.enabled` (added to `BackendConfigType` in `util/api.ts`).

### Models admin page

When LiteLLM enabled:
- Banner at top: *"LiteLLM is enabled for this instance. Models are configured directly in LiteLLM's config.yaml — this page is read-only."* + button "Open LiteLLM Admin UI" → `${backend}:4000/ui` (new tab).
- List driven by `litellmCatalog` GraphQL query. Columns: `model_name`, `upstream_model` (the resolved `litellm_params.model`), `tags`.
- No row actions (no edit / delete).
- "+ Add Model" button hidden.
- `/models/create` and `/models/edit/[id]` render a "Not available in LiteLLM mode" placeholder.

When disabled: existing Spec A CRUD over our DB Models table.

### New GraphQL query: `litellmCatalog`

```graphql
type LiteLLMModel {
  model_name: String!
  upstream_model: String
  tags: [String]
}
type Query {
  litellmCatalog: [LiteLLMModel!]!
}
```

Resolver in `src/graphql/schemas/index.ts` hits LiteLLM's `/model/info` admin endpoint with the master key. Returns `[]` when LiteLLM is off (so callers don't crash). Cached briefly (~30s) — the catalog only changes when the dev edits config.yaml + restarts.

### `AgentModelSelector` mode switch

Reads `configContext.liteLLM.enabled`:
- false: queries `modelsPagination` (Spec A behavior).
- true: queries `litellmCatalog`; the dropdown lists `model_name` values; `agents.model` gets written as the LiteLLM model name string.

Same `value` / `onSelect` props. Parent (agent edit form, create-new-agent) doesn't care which mode.

### Chat header dropdown mode switch

Same pattern. The Select populated from `modelsPagination` or `litellmCatalog`. The `X-Exulu-Model-Override` header carries the LiteLLM model name string in LiteLLM mode — the resolver branches on env, not on the format of the modelId.

### Agent form — Provider Authentication card copy

In LiteLLM mode, the existing "Authentication is configured on the Model" card changes its copy to: *"Authentication is configured in LiteLLM's config.yaml. See the LiteLLM Admin UI for upstream provider credentials."* with the link to `${backend}:4000/ui`.

### Per-message badge (`agent_messages.model`)

Unchanged. Stores whatever modelId was used (LiteLLM model name string in LiteLLM mode). The chat UI renders it as-is.

### Stale agent `.model` after toggle

When `configContext.liteLLM.enabled === true` and `agents.model` doesn't appear in the `litellmCatalog`, `AgentModelSelector` shows the raw stored value as `"(unknown — re-select)"` in red. Forces explicit re-pointing without breaking the form.

## Tests

**Backend unit tests** (`src/exulu/resolve-model.test.ts`):
- 5 new tests in a `describe("resolveModel in LiteLLM mode", ...)` block: happy path, `LITELLM_NOT_CONFIGURED`, `LITELLM_NOT_READY`, RBAC bypass (assert `checkRecordAccess` not called), DB bypass (assert `db.from("models")` not called).
- Existing 12 catalog-mode tests stay valid (they all run with `EXULU_USE_LITELLM` undefined).

**New file `src/exulu/litellm/supervisor.test.ts`:**
- Returns early when env var unset.
- Throws when `LITELLM_MASTER_KEY` missing.
- Skips spawn + logs helpful error when config.yaml absent.
- Exponential-backoff respawn caps at 5 attempts.
- Shutdown handler sends SIGTERM.

Tests mock `child_process.spawn` and `fetch`. No real LiteLLM process during tests.

**Opt-in integration test `src/exulu/litellm/integration.test.ts`** (`RUN_LITELLM_INTEGRATION=true`):
- Spawns a real LiteLLM with a minimal config (one mock model).
- Calls `resolveModel` and asserts the returned `languageModel.doGenerate(...)` produces a response.
- Cleans up.
- Skipped in CI by default. Runnable locally for release confidence.

## Rollout

- `EXULU_USE_LITELLM` defaults to `false`. Spec A behavior is preserved for every existing deployment. Devs opt in.
- `litellm[proxy]` added to `ee/python/requirements.txt`. The existing postinstall picks it up — no user-visible change for installs that don't set the env var.
- README / CHANGELOG documents: required env vars, the starter `config.yaml.example`, the link to LiteLLM's config docs, and the explicit warning that toggling LiteLLM on requires re-pointing all existing agents to LiteLLM-listed model names.
- No backend migration is needed. Models table stays untouched; existing rows just sit dormant in LiteLLM mode.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| LiteLLM version drift breaks our config.yaml expectations | Pin a specific `litellm[proxy]` version in `requirements.txt`. Upgrades become deliberate. |
| Dev forgets `LITELLM_MASTER_KEY` | Supervisor logs a clear, actionable error and keeps Exulu running. `resolveModel` returns `LITELLM_NOT_CONFIGURED` on each request. |
| Port `4000` already in use | `LITELLM_PORT` override exists; on EADDRINUSE we log `"Port already in use, set LITELLM_PORT"`. |
| Stale `agents.model` UUID in LiteLLM mode | `AgentModelSelector` renders unknown values as `"(unknown — re-select)"` in red. |
| Tools that need upstream-provider keys don't work in LiteLLM mode | Documented limitation. Anthropic raw passthrough at `routes.ts:1032` already fails gracefully; Vertex billing labels skip when ExuluProvider is absent. |
| LiteLLM crash loop | Supervisor caps at 5 respawns with 1s → 30s backoff. |
| Toggling LiteLLM off later | Same shape as toggling on — admins re-point agents. Spec A code path resumes once the env var is unset; UUIDs in `agents.model` from before the LiteLLM era would need to be repaired (or admin re-selects). |

## Open questions

None at design time. Carry forward to implementation:
- Pin the exact `litellm[proxy]` version once we test against current main.
- Decide on log format for `[EXULU-LITELLM]` prefix (newline-split vs raw passthrough).
