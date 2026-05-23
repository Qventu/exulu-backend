# Models Entity & Agent–Provider Decoupling — Design

**Date:** 2026-05-23
**Status:** Drafted (pending user review)
**Sibling spec:** Spec B — LiteLLM proxy integration (deferred; this spec lays the groundwork)

## Goal

Introduce a first-class `Model` entity (DB-backed, RBAC-controlled, admin-managed) that mediates between agents and the in-code `ExuluProvider` definitions. Replace `agents.provider` + `agents.providerapikey` with `agents.model`. Centralize the "resolve model id → language model" logic into a single function, eliminating 6+ duplicated call sites. Add a chat-level model override (per-request header) that swaps only the language model. Lay the schema groundwork for LiteLLM-driven cost/budget enforcement without implementing any of it.

## Background

Today an `ExuluAgent` row carries two columns:

- `agents.provider` — string id of an `ExuluProvider` (an in-code class registered at boot, like `vertexGemini25FlashProvider`).
- `agents.providerapikey` — string name of an entry in the `variables` table holding the encrypted auth credential.

At request time, ~8 separate call sites do the same lookup dance: `providers.find(p => p.id === agent.provider)`, then `db.from("variables").where({ name: agent.providerapikey }).first()`, then `CryptoJS.AES.decrypt(...)`, then `provider.config.model.create({ apiKey, user, role, project, agent })`. Sites: `src/exulu/routes.ts` (×2 paths), `src/exulu/openai-gateway.ts`, `src/exulu/provider.ts` (tool + generateSync + generateStream), `src/mcp/index.ts`, `src/exulu/tool.ts`, `src/templates/evals/index.ts`.

This couples agents to a specific provider+key pair, makes the model selection invisible to RBAC, and forces every consumer of "give me a language model for this agent" to re-implement the same logic. It also leaves no surface for per-tenant rate limits, budget controls, or per-request model overrides.

## Scope

**In scope:**
- New `models` schema with RBAC; columns: name, description, provider (ExuluProvider.id), authvariable (variables.name), active, plus **inert** rate/budget/cost fields (`requests_per_window`, `window_seconds`, `token_budget`, `cost_budget_usd`, `budget_window`).
- Drop `agents.provider` and `agents.providerapikey`. Add `agents.model` (uuid → models.id).
- Add `agent_messages.model` (uuid → models.id, nullable) so the model used for each message is persisted and queryable for UI display.
- Atomic, idempotent migration in `src/postgres/init-db.ts`, gated on column-existence checks. Backfills one Models row per unique (provider, providerapikey) pair, then updates each agent. `agent_messages.model` is left null for historic messages (pre-migration); new messages get the resolved model id written.
- New `resolveModel()` resolver in `src/exulu/resolve-model.ts` owning Model lookup, RBAC, variable decrypt, ExuluProvider lookup, and language model construction.
- Refactor of all 8 call sites listed above through the resolver. `ExuluProvider.generateSync` / `generateStream` signatures change to accept a pre-built `languageModel` instead of `providerapikey`.
- Admin Models page (frontend CRUD with RBAC editor).
- Chat-level model override via `X-Exulu-Model-Override` request header. RBAC-enforced through `resolveModel`. Chat UI dropdown replacing the static model badge at `chat.tsx:631`.
- GraphQL schema/resolvers/mutations for `models` (mirror existing patterns).
- Tests: unit tests for `resolveModel`; migration test in `init-db.test.ts`.

**Out of scope (deferred to Spec B — LiteLLM):**
- LiteLLM proxy provider, postinstall sidecar, env toggle.
- Real enforcement of token/cost budgets and per-Model request-rate limits. Those columns exist as data but are inert; the admin UI renders them with an info banner stating they require LiteLLM.
- Auto-population of the `models` table during `initDb` (roadmap item).
- Override behavior in the OpenAI-compatible gateway. The gateway keeps its existing semantics (`req.body.model` = agent slug) and just gets the standard refactor through `resolveModel`.

**Explicit non-goals:**
- The existing per-`ExuluProvider` `rateLimit` (hardcoded platform-level Redis cap, enforced by `check-provider-rate-limit.ts`) stays exactly as-is. `models.requests_per_window` is a separate, per-tenant cap that Spec B will wire.
- Capability validation on chat override is **not** added. The dropdown shows all Models the user has read access to; switching blindly swaps the language model.

## Data model

### New schema: `models` (`src/postgres/core-schema.ts`)

```ts
const modelsSchema: ExuluTableDefinition = {
  type: "models",
  name: { plural: "models", singular: "model" },
  RBAC: true,                              // gives rights_mode + created_by + rbac join
  fields: [
    { name: "name",         type: "text", required: true },
    { name: "description",  type: "text" },
    { name: "provider",     type: "text", required: true },        // ExuluProvider.id
    { name: "authvariable", type: "text", required: true },        // variables.name
    { name: "active",       type: "boolean", default: true },

    // Inert in Spec A. UI shows "requires LiteLLM". Spec B enforces them.
    { name: "requests_per_window", type: "number" },
    { name: "window_seconds",      type: "number" },
    { name: "token_budget",        type: "number" },
    { name: "cost_budget_usd",     type: "number" },
    { name: "budget_window",       type: "text" },                 // "daily" | "monthly" | "lifetime"
  ],
};
```

Registered in `coreSchemas.get()` and added to the `schemas` array in `init-db.ts:66`.

### Agent schema change (`src/postgres/core-schema.ts`)

Remove `provider` and `providerapikey` from `agentsSchema` (lines 243–249). Add:

```ts
{ name: "model", type: "uuid" },   // FK-ish to models.id; nullable for draft/incomplete agents
```

Naming: `model` (no `_id` suffix) to match the existing convention (`memory` for a context id, no `_id` suffix on other id refs).

### Agent messages schema change (`src/postgres/core-schema.ts`)

Add to `agentMessagesSchema` (lines 15–45):

```ts
{ name: "model", type: "uuid" },   // models.id used to generate this message; null for historic/user messages
```

Written by `saveChat` (see "Per-message model persistence" below). Used by the chat UI to render an inline badge or tooltip per assistant message, so users can see which model produced each response — especially useful when overrides are in play.

## Migration

Added to `src/postgres/init-db.ts`, immediately after the existing `for (const schema of schemas)` loop. The whole block is wrapped in `knex.transaction(async (trx) => { ... })` so a mid-run failure rolls back cleanly; next boot retries.

```ts
const hasOldProviderCol = await knex.schema.hasColumn("agents", "provider");
const hasOldKeyCol      = await knex.schema.hasColumn("agents", "providerapikey");

if (hasOldProviderCol || hasOldKeyCol) {
  console.log("[EXULU] Migrating agents.provider/providerapikey -> models table.");

  await knex.transaction(async (trx) => {
    // 1. Group existing agents by (provider, providerapikey) pair
    const pairs: { provider: string; providerapikey: string | null }[] =
      await trx("agents")
        .distinct("provider", "providerapikey")
        .whereNotNull("provider");

    // 2. Create one models row per unique pair; map old-pair -> new modelId
    const pairToModelId = new Map<string, string>();
    for (const { provider, providerapikey } of pairs) {
      const [{ id }] = await trx("models").insert({
        name: `${provider}${providerapikey ? ` (${providerapikey})` : ""}`,
        provider,
        authvariable: providerapikey,
        active: true,
        rights_mode: "public",   // preserve existing access; admins lock down later
      }).returning("id");
      pairToModelId.set(`${provider}::${providerapikey ?? ""}`, id);
    }

    // 3. Update each agent
    for (const [key, modelId] of pairToModelId) {
      const [provider, providerapikey] = key.split("::");
      await trx("agents")
        .where({ provider, providerapikey: providerapikey || null })
        .update({ model: modelId });
    }

    // 4. Drop old columns
    if (hasOldProviderCol)
      await trx.schema.alterTable("agents", t => t.dropColumn("provider"));
    if (hasOldKeyCol)
      await trx.schema.alterTable("agents", t => t.dropColumn("providerapikey"));

    console.log(`[EXULU] Migrated ${pairToModelId.size} unique provider+key pairs into models.`);
  });
}
```

**Idempotent.** First boot after upgrade: runs. Every subsequent boot: column check is false, no-op.

**Backfill defaults:** `rights_mode: "public"` so no existing agent suddenly becomes inaccessible after migration. Admins lock down via the Models page.

**`agent_messages.model` is additive.** No backfill needed — the existing `addMissingFields` mechanism in `init-db.ts:34-61` picks up the new column on every boot. Historic rows stay `null`; new rows get populated by `saveChat`.

**Edge cases:**
- Agent with `provider=null` (draft/incomplete): left with `model=null`. The existing "no provider" runtime error fires the same way against `model`.
- Agent points at a provider id no longer in code (deleted ExuluProvider): migration still creates a Models row. `resolveModel` then fails at request time with a clear `PROVIDER_NOT_FOUND` — louder than today's silent `provider.find() === undefined`.
- Auth variable deleted before migration: Models row created with the dead name; request time fails with `AUTH_VAR_NOT_FOUND` — same failure mode as today, clearer error.

## Resolution layer

### New file: `src/exulu/resolve-model.ts`

```ts
import type { LanguageModel } from "ai";
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluProvider } from "./provider";
import { postgresClient } from "@SRC/postgres/client";
import { checkRecordAccess } from "@SRC/utils/check-record-access";
import CryptoJS from "crypto-js";

export type ModelRow = {
  id: string;
  name: string;
  description?: string;
  provider: string;            // ExuluProvider.id
  authvariable: string;        // variables.name
  active: boolean;
  rights_mode: string;
  created_by: string;
  // inert in Spec A:
  requests_per_window?: number;
  window_seconds?: number;
  token_budget?: number;
  cost_budget_usd?: number;
  budget_window?: string;
};

export type ResolvedModel = {
  languageModel: LanguageModel;
  model: ModelRow;
  exuluProvider: ExuluProvider;
  apiKey: string | undefined;
};

export type ResolveModelInput = {
  modelId: string;
  user?: User;
  providers: ExuluProvider[];
  agent?: { id: string };
  project?: { id: string };
  rbacRequest?: "read" | "write";
  rbacBypass?: boolean;          // for trusted internal callers (evals)
};

export async function resolveModel(input: ResolveModelInput): Promise<ResolvedModel> {
  const { modelId, user, providers, agent, project, rbacBypass } = input;
  const rbacRequest = input.rbacRequest ?? "read";

  const { db } = await postgresClient();
  const model: ModelRow | undefined =
    await db.from("models").where({ id: modelId }).first();
  if (!model)
    throw new ResolveModelError("MODEL_NOT_FOUND", `Model ${modelId} not found`);
  if (!model.active)
    throw new ResolveModelError("MODEL_INACTIVE", `Model ${model.name} is inactive`);

  if (!rbacBypass) {
    const ok = await checkRecordAccess(model, rbacRequest, user);
    if (!ok)
      throw new ResolveModelError("MODEL_FORBIDDEN",
        `No ${rbacRequest} access to model ${model.name}`);
  }

  const exuluProvider = providers.find(p => p.id === model.provider);
  if (!exuluProvider)
    throw new ResolveModelError("PROVIDER_NOT_FOUND",
      `ExuluProvider ${model.provider} (referenced by model ${model.name}) not registered`);
  if (!exuluProvider.config?.model?.create)
    throw new ResolveModelError("PROVIDER_NO_MODEL",
      `ExuluProvider ${exuluProvider.id} has no model.create()`);

  let apiKey: string | undefined;
  if (model.authvariable) {
    const variable =
      await db.from("variables").where({ name: model.authvariable }).first();
    if (!variable)
      throw new ResolveModelError("AUTH_VAR_NOT_FOUND",
        `Auth variable ${model.authvariable} not found`);
    if (!variable.encrypted)
      throw new ResolveModelError("AUTH_VAR_NOT_ENCRYPTED",
        `Auth variable ${model.authvariable} must be encrypted`);
    apiKey = CryptoJS.AES
      .decrypt(variable.value, process.env.NEXTAUTH_SECRET!)
      .toString(CryptoJS.enc.Utf8);
  }

  const languageModel = exuluProvider.config.model.create({
    apiKey,
    user: user?.id,
    role: user?.role?.id,
    project: project?.id,
    agent: agent?.id,
  });

  return { languageModel, model, exuluProvider, apiKey };
}

export class ResolveModelError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
```

**Key design points:**
- Caller passes `modelId` (already resolved from `agent.model` or override header). Resolver is agnostic to where the id came from.
- Caller passes `providers` array. Avoids reaching into the `exuluApp` singleton; better testability.
- `apiKey` returned. Several call sites pass it to `convertExuluToolsToAiSdkTools` for tools that need provider credentials. Avoids a second variable lookup.
- Typed error class with a `code`. Existing call sites map codes to HTTP statuses consistently.

### Why this seam works for Spec B

Spec B's LiteLLM branch is one if-statement inside `resolveModel`:

```ts
let languageModel: LanguageModel;
if (process.env.EXULU_USE_LITELLM === "true" && model.litellm_model_id) {
  languageModel = createLiteLLMLanguageModel(model);   // new in Spec B
} else {
  languageModel = exuluProvider.config.model.create({ /* ... */ });
}
```

No other call site changes. That's the payoff for centralization.

## Call-site refactor

| Site | Before | After |
|---|---|---|
| `src/exulu/routes.ts:686-720` (agent run, stream + sync paths) | inline lookup + decrypt | `const { languageModel, apiKey, model } = await resolveModel({ modelId: overrideModelId ?? agent.model, user, providers, agent, project });` — `model.id` then threaded through to `saveChat({ ..., model: model.id })` in the stream `onFinish` (`routes.ts:819`) and the sync path's equivalent. |
| `src/exulu/routes.ts:1032-1040` (separate validate path) | inline | same |
| `src/exulu/openai-gateway.ts:395-435` | inline | `resolveModel({ modelId: agent.model, user, providers, agent, project })` — no override path |
| `src/exulu/provider.ts:209-244` (agent-as-tool `tool()` method) | inline | resolves the callee agent's model |
| `src/exulu/provider.ts:378-384` (`generateSync`) and `:921-927` (`generateStream`) | `this.model.create({ apiKey: providerapikey, ... })` | **Signature change**: methods accept `languageModel: LanguageModel` from caller instead of `providerapikey: string`. They no longer call `this.model.create()`. |
| `src/mcp/index.ts:81-98` | inline | `resolveModel({ modelId: agent.model, user, providers, agent })` |
| `src/exulu/tool.ts:115` | inline | same |
| `src/templates/evals/index.ts:52-58` (uses `ExuluVariables.get`) | inline | `resolveModel({ ..., rbacBypass: true })` |

### The `generateSync` / `generateStream` signature change

Today they take `providerapikey: string` and internally call `this.model.create({ apiKey })`. After: they take a fully constructed `languageModel: LanguageModel` and skip the `this.model.create()` call. Cleaner separation — methods become "given a language model, run the agent loop" instead of "given an API key, also build the model."

### `ExuluProvider.modelName` getter (provider.ts:149-154)

Currently `chat.tsx:631` renders `agent.modelName` as a static badge, where that string comes from the ExuluProvider's hardcoded `config.name`. After the refactor:
- `model.name` (admin-set display name on the Models row) is canonical for UI.
- `ExuluProvider.modelName` getter stays for legacy callers but is no longer the source of truth for the chat header.

## Chat-level override

### Backend

**Header:** `X-Exulu-Model-Override` (single uuid → `models.id`). Matches existing `X-Exulu-*` conventions in `routes.ts`.

**Resolution precedence in the agent run route:**

```ts
const overrideModelId = req.headers["x-exulu-model-override"] as string | undefined;
const modelId = overrideModelId ?? agent.model;

if (!modelId) {
  return res.status(400).json({ message: "Agent has no model configured." });
}

const { languageModel, apiKey } = await resolveModel({
  modelId,
  user,
  providers,
  agent,
  project,
});
```

RBAC is enforced inside `resolveModel`. A client passing an override Model id they don't have read access to gets a 403. No special trust granted to the header.

**Per-message model persistence.** The resolved `modelId` (whether from `agent.model` or the override header) is recorded on each saved message. `saveChat` (`src/exulu/provider.ts:1253`) and its callers (`src/exulu/routes.ts:819` in the stream `onFinish` and the equivalent sync path) get an additional parameter:

```ts
export const saveChat = async ({
  session,
  user,
  messages,
  model,                           // NEW — models.id used for this exchange
}: {
  session: string;
  user: number;
  messages: UIMessage[];
  model?: string;
}) => {
  // ... existing insert, with `model` added to the column list
};
```

`saveChat` writes the same `model` value to every row in the batch — both user and assistant messages from a given exchange share it (cleaner than trying to attribute the user message to a model it didn't produce; the column on user rows is just contextual). Historic messages (pre-migration) keep `model = null`; the UI renders no badge in that case.

**UI display.** The chat message renderer (consumes the `messages { model }` GraphQL field) shows a small inline badge or tooltip per assistant message: `model.name`. When a message's model equals the agent's current default, the badge can be styled muted; when it differs (an override was active), styled prominently. Implementation detail to be finalized when wiring the chat component.

**Not supported in the OpenAI-compatible gateway.** Gateway keeps `req.body.model` = agent slug semantics and resolves `agent.model` internally. The override is chat-UI-only. The gateway's saved messages still get `model` populated (always `agent.model`), so the column is consistent regardless of entry point.

### Frontend (`chat.tsx`)

Replace the static `<Badge>{agent.modelName}</Badge>` at line 631 with a `<Select>`:
- Populated from `models { id, name, description }`, RBAC-filtered server-side.
- Defaults to `agent.model`.
- On change, subsequent message sends include `X-Exulu-Model-Override: <id>` (omit when selection equals `agent.model`).
- Hover tooltip shows `model.description`.

No other chat UI changes; the dropdown sits where the badge currently sits.

## Admin Models page

Route: `frontend/app/(application)/models/page.tsx` (sibling to existing admin pages).

**Top bar:** "Models" title, "+ Create model" button (admin-gated via existing `super_admin` / admin role check).

**List:** table of all models, RBAC-filtered. Columns: Name, Provider (renders `ExuluProvider.name` via the in-code catalog), Auth variable, Active toggle, Access badge (Public / Users / Roles / Private), Rate limit badge ("—" when not set), Actions (Edit, Delete).

**Create/edit drawer:**
- Name (required), Description (optional).
- **Provider** (required) — dropdown of available `ExuluProvider`s from a new GraphQL query `availableProviders`. On selection, renders the provider's existing `authenticationInformation` markdown inline.
- **Auth variable** (required) — dropdown of encrypted entries in `variables`, plus inline "Create new variable" affordance.
- **Active** toggle.
- **Rate / budget** section — collapsed by default. When expanded: `requests_per_window`, `window_seconds`, `token_budget`, `cost_budget_usd`, `budget_window`. Info banner: *"These limits require LiteLLM to be enabled. They are stored but not enforced until you enable LiteLLM in your environment configuration."* Fields are editable so admins can pre-fill ahead of Spec B.
- **Access** — reuse the existing RBAC component used on agents.

## GraphQL surface

Resolvers (mirror existing patterns in `src/graphql/resolvers/`, `mutations/`, `schemas/`):
- `models(filter)` — list, RBAC-filtered.
- `modelById(id)` — single, RBAC-checked.
- `availableProviders` — returns the in-code `ExuluProvider` catalog (id, name, description, authenticationInformation). Read-only, no DB.

Mutations (admin-only):
- `createModel(input)`, `updateModel(id, input)`, `deleteModel(id)`.

## Agent edit form change

Wherever the agent edit form currently shows "Provider" + "Provider API key variable" dropdowns: replace both with a single "Model" dropdown populated from `models { id, name }`, RBAC-filtered.

## Tests

- `src/exulu/resolve-model.test.ts` (new) — unit tests covering every error code: `MODEL_NOT_FOUND`, `MODEL_INACTIVE`, `MODEL_FORBIDDEN`, `PROVIDER_NOT_FOUND`, `PROVIDER_NO_MODEL`, `AUTH_VAR_NOT_FOUND`, `AUTH_VAR_NOT_ENCRYPTED`, plus happy path and `rbacBypass`.
- `src/postgres/init-db.test.ts` (extend or create) — fake `agents` table with old columns and 5 agents across 3 distinct (provider, providerapikey) pairs; assert 3 Models rows created, agents updated, old columns dropped, re-running the migration is a no-op.
- Update existing fixtures that reference `agent.provider` / `agent.providerapikey` to use `agent.model` with a fixture Models row.

## Rollout

- No env flag. Migration is auto-idempotent in `initDb`. Consumers upgrading the package get the migration on first boot of the new version.
- Frontend (Models page, agent edit form, chat dropdown) ships together with the backend. Backend-only upgrade still works for chat (badge renders `model.name`) but loses access to the new admin page. Frontend-only upgrade against an old backend is the unsupported direction — release notes call this out.
- Risks:
  - **Migration failure mid-run** — transaction rolls back; next boot retries.
  - **Auth variable deleted pre-migration** — `resolveModel` throws `AUTH_VAR_NOT_FOUND` at request time. Same failure mode as today, clearer error.
  - **ExuluProvider removed from code in a later release while a Models row still references it** — Admin Models page renders a warning badge for orphaned rows; runtime fails with `PROVIDER_NOT_FOUND`.

## Open questions

None at design time. Carry forward to implementation:
- Confirm the exact GraphQL field names match existing conventions (snake_case vs camelCase) once we start writing resolvers.
- Decide on the exact admin-gating check for the Models page (existing `super_admin` flag vs. a new admin role) when wiring the frontend route.
