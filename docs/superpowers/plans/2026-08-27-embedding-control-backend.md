# Embedding Control (Backend) Implementation Plan (Sub-project C, backend half)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a caller decide explicitly whether saving an item regenerates its embeddings, and stop unauthorised users triggering embedding regeneration on items they cannot read.

**Architecture:** GraphQL item mutations write to the database and then call `postprocessUpdate`, which decides whether to embed based solely on the context's `calculateVectors`. This adds a `generateEmbeddings: Boolean` argument threaded into that decision as a tri-state override, fixes `postprocessUpdate` conflating the create and update triggers, and adds the missing access-control call on `GenerateChunks`.

**Tech Stack:** TypeScript, GraphQL, knex, jest + ts-jest.

**Spec:** `docs/superpowers/specs/2026-08-27-recall-video-training-guides-design.md` (sub-project C)

## Corrections to the spec, already ruled on

The spec's C2 says the new argument is "passed to `context.createItem` / `context.updateItem` as `generateEmbeddingsOverwrite`", and that the tri-state therefore needs "no new logic underneath". **That is wrong.** The GraphQL mutations never call those methods — they insert or update directly and then call `postprocessUpdate` (`src/graphql/mutations/index.ts:105-201`), which has its own embedding decision. The tri-state must be implemented there. `context.createItem`/`updateItem` keep their existing behaviour and are not touched by this plan.

The spec also did not know that `postprocessUpdate` serves **both** create and update while only ever checking `calculateVectors === "onUpdate" || "always"`. A context configured `onInsert` therefore never embeds anything created through the API or the UI. In this repo that is `transcriptionsContext` (`src/templates/contexts/transcriptions.ts:34`), which escapes the bug only because `finalize` calls `context.createItem` directly. Daniel ruled on 2026-08-27 that this plan fixes it.

**Behaviour change to be aware of:** after this ships, a deployment with an `onInsert` context begins embedding API-created items where it previously silently did not. In-repo that is only `transcriptions`; consuming projects may have their own.

## Global Constraints

- Node.js **v22.18.0** exactly — `preinstall` hard-fails otherwise.
- Test runner: `npx jest <path>`. Config `jest.config.cjs`, preset `ts-jest`.
- Path aliases: `@SRC/*` → `src/*`, `@EXULU_TYPES/*` → `types/*`, `@EE/*` → `ee/*`.
- **Tri-state semantics are exact.** `true` → embed regardless of config. `false` → do not embed, *even when the config says to*. `undefined` → fall back to `calculateVectors`. These map onto "modal toggle on / toggle off / modal not shown"; anything else breaks the frontend half.
- **Inherited baseline, do not try to fix:** `develop` carries **9 TypeScript errors** (`auth/flow.ts`, `auth/validate.ts`, `openai-transformer.ts`, `convert-exulu-tools-to-ai-sdk-tools.ts`, `memory-tool.ts`) and **12 test failures** across 4 suites (`resolve-context-window`, `convert-exulu-tools-to-ai-sdk-tools`, `email-inbound/intake`, `compact-session`). Gates: no NEW errors in touched files, no NEW failures beyond that baseline.
- semantic-release reads commit types: `feat:` for the new argument, `fix:` for the trigger and access-control corrections.
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Worktree `/Users/daniel.claessen/Desktop/Projects/exulu/backend-models-export`, branch `feat/exulu-models-export`. Verify with `git branch --show-current` in the same command as any commit.

---

### Task 1: Extract and correct the embedding decision

**Files:**
- Create: `src/graphql/mutations/should-generate-embeddings.ts`
- Create: `src/graphql/mutations/should-generate-embeddings.test.ts`

**Interfaces:**
- Produces: `shouldGenerateEmbeddings({ calculateVectors, operation, override }): boolean`, where `operation` is `"create" | "update"` and `override` is `boolean | undefined`.

**Why a separate module:** the decision currently lives inline in a 100-line function that needs a live database and a full context registry to invoke. Pulling the predicate out is the only way to test the tri-state and the create/update split at all, and it is the part with the actual subtlety.

- [ ] **Step 1: Write the failing tests**

Create `src/graphql/mutations/should-generate-embeddings.test.ts`:

```ts
import { shouldGenerateEmbeddings } from "./should-generate-embeddings";

describe("shouldGenerateEmbeddings — override wins over config", () => {
  it("embeds when forced, even on a manual context", () => {
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "manual",
        operation: "update",
        override: true,
      }),
    ).toBe(true);
  });

  it("suppresses when told to, even when the config says to embed", () => {
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "always",
        operation: "update",
        override: false,
      }),
    ).toBe(false);
  });

  it("suppresses on create too, so a caller can opt out of an onInsert context", () => {
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "onInsert",
        operation: "create",
        override: false,
      }),
    ).toBe(false);
  });
});

describe("shouldGenerateEmbeddings — config drives it when no override", () => {
  it("embeds on create for onInsert", () => {
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "onInsert",
        operation: "create",
        override: undefined,
      }),
    ).toBe(true);
  });

  it("does NOT embed on update for onInsert", () => {
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "onInsert",
        operation: "update",
        override: undefined,
      }),
    ).toBe(false);
  });

  it("embeds on update for onUpdate", () => {
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "onUpdate",
        operation: "update",
        override: undefined,
      }),
    ).toBe(true);
  });

  it("does NOT embed on create for onUpdate", () => {
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "onUpdate",
        operation: "create",
        override: undefined,
      }),
    ).toBe(false);
  });

  it("embeds for always, on both operations", () => {
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "always",
        operation: "create",
        override: undefined,
      }),
    ).toBe(true);
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "always",
        operation: "update",
        override: undefined,
      }),
    ).toBe(true);
  });

  it("never embeds for manual, on either operation", () => {
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "manual",
        operation: "create",
        override: undefined,
      }),
    ).toBe(false);
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "manual",
        operation: "update",
        override: undefined,
      }),
    ).toBe(false);
  });

  it("treats an absent calculateVectors as manual", () => {
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: undefined,
        operation: "create",
        override: undefined,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/graphql/mutations/should-generate-embeddings.test.ts`
Expected: FAIL — cannot find module `./should-generate-embeddings`

- [ ] **Step 3: Implement the predicate**

Create `src/graphql/mutations/should-generate-embeddings.ts`:

```ts
export type CalculateVectors = "manual" | "onUpdate" | "onInsert" | "always";

/**
 * Whether a GraphQL item mutation should regenerate embeddings.
 *
 * The override is tri-state and deliberately allows suppression: `false` means
 * "do not embed" even when the context config says to, which is what lets a
 * caller save a draft without paying to re-embed it. `undefined` means the
 * caller expressed no preference and the context config decides.
 *
 * The operation split matters: postprocessUpdate serves both create and update
 * and used to check only `onUpdate`/`always`, so an `onInsert` context never
 * embedded anything created through the API.
 */
export const shouldGenerateEmbeddings = ({
  calculateVectors,
  operation,
  override,
}: {
  calculateVectors: CalculateVectors | undefined;
  operation: "create" | "update";
  override: boolean | undefined;
}): boolean => {
  if (override !== undefined) return override;
  if (calculateVectors === "always") return true;
  return operation === "create"
    ? calculateVectors === "onInsert"
    : calculateVectors === "onUpdate";
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/graphql/mutations/should-generate-embeddings.test.ts`
Expected: PASS, 10 tests (two of them assert both operations, so 13 assertions)

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print feat/exulu-models-export
git add src/graphql/mutations/should-generate-embeddings.ts \
        src/graphql/mutations/should-generate-embeddings.test.ts
git commit -m "feat(graphql): extract the embedding decision as a testable predicate

The decision lived inline in postprocessUpdate, which needs a live database
and a full context registry to invoke, so neither the create/update split
nor a caller override could be tested.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Thread generateEmbeddings through the mutations

**Files:**
- Modify: `src/graphql/schemas/index.ts:403-408` (three mutation signatures)
- Modify: `src/graphql/mutations/index.ts:105-201` (`postprocessUpdate`), `:530` (CreateOne call site), `:647` (UpdateOne call site), `:742` (UpdateOneById call site)

**Interfaces:**
- Consumes: `shouldGenerateEmbeddings` from Task 1.
- Produces: `generateEmbeddings: Boolean` argument on `<plural>CreateOne`, `<plural>UpdateOne`, `<plural>UpdateOneById`. The frontend modal (sub-project C, frontend half) sends it.

- [ ] **Step 1: Add the argument to the three mutation signatures**

In `src/graphql/schemas/index.ts`, replace lines 403-408 with:

```ts
      ${tableNamePlural}CreateOne(input: ${tableNameSingular}Input!, upsert: Boolean, generateEmbeddings: Boolean): ${tableNameSingular}MutationPayload
      ${tableNamePlural}CopyOneById(id: ID!): ${tableNameSingular}MutationPayload

      ${tableNamePlural}UpdateOne(where: [Filter${tableNameSingularUpperCaseFirst}], input: ${tableNameSingular}Input!, generateEmbeddings: Boolean): ${tableNameSingular}MutationPayload
      ${tableNamePlural}UpdateOneById(id: ID!, input: ${tableNameSingular}Input!, generateEmbeddings: Boolean): ${tableNameSingular}MutationPayload
      ${tableNamePlural}RemoveOneById(id: ID!): ${tableNameSingular}
      ${tableNamePlural}RemoveOne(where: JSON!): ${tableNameSingular}
```

Leave `CopyOneById`, `RemoveOneById` and `RemoveOne` exactly as they are.

- [ ] **Step 2: Accept the parameters in postprocessUpdate**

In `src/graphql/mutations/index.ts`, add the import at the top of the file beside the other local imports:

```ts
import { shouldGenerateEmbeddings } from "./should-generate-embeddings";
```

In `postprocessUpdate`'s destructured parameter list (`:105-113`), add two entries after `config`:

```ts
  operation,
  generateEmbeddings,
```

and in its type annotation (`:114-123`), after `config: ExuluConfig;`:

```ts
  operation: "create" | "update";
  generateEmbeddings?: boolean;
```

- [ ] **Step 3: Use the predicate**

In `postprocessUpdate`, replace this condition (currently at `:152-156`):

```ts
      if (
        context.embedder &&
        (context.configuration.calculateVectors === "onUpdate" ||
          context.configuration.calculateVectors === "always")
      ) {
```

with:

```ts
      if (
        shouldGenerateEmbeddings({
          calculateVectors: context.configuration.calculateVectors,
          operation,
          override: generateEmbeddings,
        })
      ) {
```

The `context.embedder` check is already made and returned on at `:149-151` (`if (!context.embedder) return result;`), so it is not needed again in this condition. Confirm that guard is still directly above this block before you drop `context.embedder &&` — if it ever moves, the predicate would happily return true for a context with no embedder and `embeddings.generate.one` would be called without one.

- [ ] **Step 4: Pass operation and the override at all three call sites**

At `:530` (inside `CreateOne`), add to the `postprocessUpdate({...})` argument object:

```ts
        operation: "create",
        generateEmbeddings: args.generateEmbeddings,
```

At `:647` (inside `UpdateOne`) and `:742` (inside `UpdateOneById`), add:

```ts
        operation: "update",
        generateEmbeddings: args.generateEmbeddings,
```

Every one of the three is required. A missed call site means `operation` is `undefined`, and the predicate would then treat it as an update — silently reintroducing the `onInsert` bug on the create path.

- [ ] **Step 5: Verify the gates**

Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: exactly `9`.

Run: `npx tsc --noEmit 2>&1 | grep "graphql/mutations\|graphql/schemas"`
Expected: no output. If `operation` is reported as missing at a call site, you skipped one in Step 4.

Run: `npx jest src/`
Expected: the baseline 12 failures across the 4 known suites, no others.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # must print feat/exulu-models-export
git add src/graphql/schemas/index.ts src/graphql/mutations/index.ts
git commit -m "feat(graphql): let callers control embedding regeneration on save

Adds generateEmbeddings to CreateOne/UpdateOne/UpdateOneById. Tri-state:
true forces, false suppresses even when the context config says to embed,
undefined defers to calculateVectors. The suppression case is the point —
it is what lets a draft be saved without paying to re-embed it.

Also fixes postprocessUpdate conflating create and update. It serves both
but only ever checked onUpdate/always, so a context configured onInsert
never embedded anything created through the API. In this repo that is
transcriptions, which escaped it only because finalize calls
context.createItem directly.

Behaviour change: deployments with an onInsert context now embed
API-created items where they previously silently did not.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Fix access control on GenerateChunks

**Files:**
- Modify: `src/graphql/mutations/index.ts:1095` (the where-filtered branch of `GenerateChunks`)

**Interfaces:**
- Consumes: `applyAccessControl(table, query, user)` from `../utilities/access-control`, already imported at `:9` and already used by `DeleteChunks` at `:1140`.

**The defect:** `GenerateChunks`'s where-filtered branch applies `applyFilters` but never `applyAccessControl`. Only the regenerate-everything branch is super-admin gated (`:1076`). So any authenticated user can trigger embedding regeneration against any item in any context, including items they cannot read. It is not a content leak — the response is a count — but it lets any user burn embedding spend on the largest context and stamp `embeddings_updated_at` on items they should not touch. Its sibling `DeleteChunks` already guards this exact path.

- [ ] **Step 1: Read the two branches side by side**

Read `src/graphql/mutations/index.ts:1057-1160`. Confirm for yourself that `DeleteChunks` (`:1140`) calls `applyAccessControl` immediately after `applyFilters`, and that `GenerateChunks` (`:1095`) does not. Match the working one.

- [ ] **Step 2: Apply the fix**

In `GenerateChunks`, after the `applyFilters` line (`:1095`):

```ts
      query = applyFilters(query, args.where, table);
      query = applyAccessControl(table, query, context.user);
```

- [ ] **Step 3: Verify the gates**

Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: exactly `9`.

Run: `npx jest src/`
Expected: the baseline 12 failures, no others.

- [ ] **Step 4: Manual verification**

This path has no test harness — `GenerateChunks` needs a live database, a context registry and a real user. Verify by hand against a running instance:

1. As a non-super-admin user with no access to a private item they did not create, call `<context>ItemGenerateChunks(where: [{ id: { eq: "<that item id>" } }])`.
2. Expected after the fix: `No items found to generate chunks for.` Before the fix it returned `Chunks generated successfully.` with a count of 1.
3. As a user who *can* read the item, the same call must still succeed — the fix must not lock out legitimate callers.

Record both results in the commit message or the task report.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print feat/exulu-models-export
git add src/graphql/mutations/index.ts
git commit -m "fix(graphql): apply access control to GenerateChunks

The where-filtered branch applied applyFilters but never
applyAccessControl, and only the regenerate-everything branch is
super-admin gated. Any authenticated user could therefore trigger
embedding regeneration against any item in any context, including items
they cannot read.

Not a content leak — the response is a count — but it lets any user burn
embedding spend on the largest context and stamp embeddings_updated_at on
items they should not touch. DeleteChunks already guarded this same path.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Definition of done

- `npx jest src/graphql/mutations/should-generate-embeddings.test.ts` passes (11 tests)
- `npx tsc --noEmit` reports exactly 9 errors, none in touched files
- `npx jest src/` shows the baseline 12 failures and no others
- All three `postprocessUpdate` call sites pass `operation`
- `GenerateChunks` access control verified by hand, both the denied and the permitted case
- Released to npm with sub-projects A and A2

## Out of scope

- The frontend modal (sub-project C, frontend half) — its own plan, depends on Task 2's argument existing
- `context.createItem` / `context.updateItem` — they already implement the tri-state and are not on the GraphQL path
- `postprocessUpdate` returning early on the embedder branch, so a context with both an embedder and an `onUpdate` processor runs embeddings but never the processor. Noticed while reading; pre-existing, unrelated to this change, and fixing it blind could break processors that rely on the current ordering.
