# ExuluModels Export Implementation Plan (Sub-project A2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give consuming projects a supported way to obtain a `LanguageModel` bound to the tenant's LiteLLM proxy, with caller-identity tags intact.

**Architecture:** `resolveModel` (`src/exulu/resolve-model.ts:141`) already builds a tagged LiteLLM provider, but nothing model-related is exported from `src/index.ts` — the package's only entry point. This adds a minimal `ExuluModels` namespace wrapping it, plus the Gemini provider-options helper that constrained structured-output calls need.

**Tech Stack:** TypeScript, jest + ts-jest, Vercel AI SDK (`ai`), LiteLLM.

**Spec:** `docs/superpowers/specs/2026-08-27-recall-video-training-guides-design.md`

## Why this exists (discovered during planning, not in the spec)

Sub-project B's pipeline makes roughly 40 vision calls per training guide. It cannot make any of them: `ExuluApp` exposes `tool()`, `agent()`, `context()`, `embeddings`, `bullmq` and `queues()` — no model route — and `resolveModel` is not exported.

The workaround (algikiag builds its own OpenAI-compatible provider against `PROXY_BASE_URL`) was rejected because `resolveModel` embeds caller-identity tags via `getLiteLLMProvider` (`resolve-model.ts:162-172`), and those tags are what per-team LiteLLM budgets attribute against. A pipeline burning tokens without them is spend nobody can see.

## Global Constraints

- Node.js **v22.18.0** exactly — `preinstall` hard-fails otherwise.
- Test runner: `npx jest <path>`. Config `jest.config.cjs`, preset `ts-jest`.
- Path aliases: `@SRC/*` → `src/*`, `@EXULU_TYPES/*` → `types/*`, `@EE/*` → `ee/*`.
- **Inherited baseline, do not try to fix:** `develop` carries **9 TypeScript errors** (`auth/flow.ts`, `auth/validate.ts`, `openai-transformer.ts`, `convert-exulu-tools-to-ai-sdk-tools.ts`, `memory-tool.ts`) and **12 test failures** across 4 suites (`resolve-context-window`, `convert-exulu-tools-to-ai-sdk-tools`, `email-inbound/intake`, `compact-session`). Gates are "no NEW errors in touched files" and "no NEW failures vs that baseline".
- semantic-release reads commit types: use `feat:` (this is new public API, minor bump).
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Worktree `/Users/daniel.claessen/Desktop/Projects/exulu/backend-models-export`, branch `feat/exulu-models-export`. Verify with `git branch --show-current` in the same command as any commit.

---

### Task 1: Export the ExuluModels surface

**Files:**
- Create: `src/exulu/models/public.ts`
- Create: `src/exulu/models/public.test.ts`
- Modify: `src/index.ts` (add the export)

**Interfaces:**
- Consumes: `resolveModel(input)` from `@SRC/exulu/resolve-model` (signature at `resolve-model.ts:141`, input type at `:107-115`); `postgresClient()` from `@SRC/postgres/client`; `microCallProviderOptions(model)` from `@EE/agentic-retrieval/pipeline/micro-call` (`:27-34`).
- Produces:
  - `ExuluModels.resolve({ modelId, userId? }): Promise<LanguageModel>`
  - `ExuluModels.providerOptions(model): Record<string, Record<string, string>> | undefined`

**Design notes for the implementer:**

`resolveModel` takes a full `User` object, but a context processor only ever receives `user?: number`. The established idiom for bridging that gap is `src/exulu/recall/service.ts:553-559` — load the raw row with `db("users").where({ id }).first()` and pass it straight through. `resolveModel` reads `user?.role`, `user?.team`, `user?.project` and tolerates the raw row shape. Follow that idiom rather than inventing a hydration step.

`resolve` returns the `languageModel` only, not the `{ languageModel, model }` pair. The `model` half is a synthetic `ModelRow` (`resolve-model.ts:175-182`) with no value to a consumer — exporting it would be surface we would have to keep supporting. YAGNI.

- [ ] **Step 1: Write the failing tests**

Create `src/exulu/models/public.test.ts`:

```ts
const resolveModelSpy = jest.fn(async () => ({
  languageModel: { modelId: "vertex-gemini-2.5-flash" },
  model: { id: "vertex-gemini-2.5-flash" },
}));
jest.mock("@SRC/exulu/resolve-model", () => ({
  resolveModel: (...args: any[]) => resolveModelSpy(...args),
}));

const firstSpy = jest.fn();
jest.mock("@SRC/postgres/client", () => ({
  postgresClient: async () => ({
    db: () => ({ where: () => ({ first: () => firstSpy() }) }),
  }),
}));

import { ExuluModels } from "./public";

describe("ExuluModels.resolve", () => {
  beforeEach(() => {
    resolveModelSpy.mockClear();
    firstSpy.mockReset();
  });

  it("passes the loaded user through so LiteLLM tags attribute the spend", async () => {
    const row = { id: 7, email: "a@b.c", role: "role-1", team: "team-1" };
    firstSpy.mockResolvedValueOnce(row);

    await ExuluModels.resolve({ modelId: "vertex-gemini-2.5-flash", userId: 7 });

    expect(resolveModelSpy).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "vertex-gemini-2.5-flash", user: row }),
    );
  });

  it("returns the language model, not the {languageModel, model} pair", async () => {
    firstSpy.mockResolvedValueOnce({ id: 7 });

    const model = await ExuluModels.resolve({ modelId: "m", userId: 7 });

    expect(model).toEqual({ modelId: "vertex-gemini-2.5-flash" });
  });

  it("resolves without a userId — the call is simply unattributed", async () => {
    await ExuluModels.resolve({ modelId: "m" });

    expect(firstSpy).not.toHaveBeenCalled();
    expect(resolveModelSpy).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "m", user: undefined }),
    );
  });

  it("resolves unattributed rather than throwing when the user row is gone", async () => {
    firstSpy.mockResolvedValueOnce(undefined);

    await expect(
      ExuluModels.resolve({ modelId: "m", userId: 999 }),
    ).resolves.toBeDefined();
    expect(resolveModelSpy).toHaveBeenCalledWith(
      expect.objectContaining({ user: undefined }),
    );
  });

  it("propagates resolveModel failures — an unusable model must not look resolved", async () => {
    firstSpy.mockResolvedValueOnce({ id: 7 });
    resolveModelSpy.mockRejectedValueOnce(new Error("LiteLLM is not ready"));

    await expect(
      ExuluModels.resolve({ modelId: "m", userId: 7 }),
    ).rejects.toThrow("LiteLLM is not ready");
  });
});

describe("ExuluModels.providerOptions", () => {
  it("disables reasoning for gemini models", () => {
    expect(ExuluModels.providerOptions({ modelId: "vertex-gemini-2.5-flash" } as any)).toEqual({
      litellm: { reasoningEffort: "disable" },
    });
  });

  it("accepts a bare model id string", () => {
    expect(ExuluModels.providerOptions("gemini-3.5-flash" as any)).toEqual({
      litellm: { reasoningEffort: "disable" },
    });
  });

  it("returns undefined for non-gemini models", () => {
    expect(ExuluModels.providerOptions({ modelId: "gpt-4o" } as any)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/models/public.test.ts`
Expected: FAIL — cannot find module `./public`

- [ ] **Step 3: Implement the surface**

Create `src/exulu/models/public.ts`:

```ts
import type { LanguageModel } from "ai";
import { resolveModel } from "@SRC/exulu/resolve-model";
import { postgresClient } from "@SRC/postgres/client";
import { microCallProviderOptions } from "@EE/agentic-retrieval/pipeline/micro-call";

/**
 * Model access for consuming projects.
 *
 * Exists because ExuluApp exposes no model route and resolveModel is internal,
 * so a consumer's only alternative was building its own provider against
 * PROXY_BASE_URL — which produces untagged calls that per-team LiteLLM budgets
 * cannot attribute.
 */
export const ExuluModels = {
  /**
   * A LanguageModel bound to the tenant's LiteLLM proxy.
   *
   * Pass `userId` wherever one is known — it is what carries the caller's
   * identity tags into LiteLLM, and therefore what makes the spend visible to
   * that user's team budget. Resolution still succeeds without it; the calls
   * are simply unattributed.
   */
  resolve: async ({
    modelId,
    userId,
  }: {
    modelId: string;
    userId?: number;
  }): Promise<LanguageModel> => {
    let user: any;
    if (userId != null) {
      const { db } = await postgresClient();
      // Raw row on purpose: resolveModel reads role/team/project off it
      // directly, matching the idiom in src/exulu/recall/service.ts:553.
      user = await db("users").where({ id: userId }).first();
    }
    const { languageModel } = await resolveModel({ modelId, user: user || undefined });
    return languageModel;
  },

  /**
   * Provider options for a constrained structured-output call.
   *
   * Gemini 3+ counts thinking tokens against maxOutputTokens, so a call with a
   * token cap returns an empty 200 unless reasoning is disabled. Returns
   * undefined for non-Gemini models.
   */
  providerOptions: (model: LanguageModel) => microCallProviderOptions(model),
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/exulu/models/public.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Export it from the package**

In `src/index.ts`, beside the other namespace exports (see `ExuluJobs` at `:61`), add:

```ts
export { ExuluModels } from "./exulu/models/public";
```

- [ ] **Step 6: Verify the gates**

Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: exactly `9`, and none of them in `src/exulu/models/public.ts` or `src/index.ts` — check with:
`npx tsc --noEmit 2>&1 | grep "exulu/models\|src/index.ts"` (expect no output)

Run: `npx jest src/`
Expected: 12 failures across the 4 known suites, no others.

- [ ] **Step 7: Confirm the export survives the build**

The package ships `dist/`, so an export that fails to bundle is invisible until a consumer installs it.

Run: `npm run build`
Then: `grep -c "ExuluModels" dist/index.d.ts`
Expected: at least 1. If the symbol is absent from the type declarations, the export did not make it into the public surface and Task 1 is not done.

- [ ] **Step 8: Commit**

```bash
git branch --show-current   # must print feat/exulu-models-export
git add src/exulu/models/public.ts src/exulu/models/public.test.ts src/index.ts
git commit -m "feat(models): export ExuluModels for consuming projects

ExuluApp exposes no model route and resolveModel was internal, so a
consuming project had no supported way to get a LanguageModel. The only
alternative was building a provider against PROXY_BASE_URL directly, which
produces calls carrying no caller-identity tags — invisible to the
per-team LiteLLM budgets that spend is actually controlled by.

resolve() takes a userId rather than a User because that is what a context
processor receives; it loads the row the same way recall/service.ts does.
Returns the LanguageModel alone — the ModelRow half is synthetic and would
be surface we have to keep supporting.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Definition of done

- `npx jest src/exulu/models/public.test.ts` passes (8 tests)
- `npx tsc --noEmit` still reports exactly 9 errors, none in touched files
- `npx jest src/` shows the baseline 12 failures and no others
- `ExuluModels` appears in `dist/index.d.ts` after `npm run build`
- Released to npm together with sub-project A, so algikiag can bump once
