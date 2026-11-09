# Typed JSON Fields and Key-Level Merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `json` context field can declare its shape; the generated write tools expose it, writes merge into it by key, and filters on unknown paths are refused with a message an agent can act on.

**Architecture:** One pure module holds every decision (path extraction, path validation, merge computation) so it is testable without a database. One shared write helper applies merge and validation; both the tool path and the GraphQL path call it, which is what makes them agree. The filter converter gains a path check at its single existing chokepoint.

**Tech Stack:** TypeScript, Zod, Knex, Jest.

**Spec:** `docs/superpowers/specs/2026-11-09-typed-json-fields-design.md`

## Global Constraints

- `npx tsc --noEmit` must report **exactly 8** errors at every commit — the pre-existing baseline. Compare error *identities*, not just the count: a drop can mean a stray backtick killed a template literal.
- Backward compatibility is absolute: a `json` field with no `schema` behaves exactly as it does today, on every path. Every task's tests must include the no-schema case.
- **Validation never strips.** Check the value, then write the caller's original. Never substitute a parse result for the input. (Spec anti-goal; this has already cost a customer production data once.)
- No Postgres error text ever reaches a model. Catch, map, log the original.
- `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts` is not modified by this plan.
- Backend tests are typechecked by nothing (tsconfig excludes them, ts-jest only transpiles). A fixture can assert a shape no code emits and stay green — assert against values the code actually produces.

## Review Focus

Five conditions the spec implies that no task's happy path exercises. Each has its test named in the owning task.

1. **Stored value predates the schema.** A row written before a schema existed holds a shape the schema rejects. A merge that only touches valid keys must still succeed — validating the *stored* value would make old rows permanently unwritable. (Task 3)
2. **Explicit `null` deletes a key**, and is distinguishable from an absent key, which preserves it. (Task 1)
3. **Stored value is `null` or absent.** Merging into a field never written must produce the patch, not throw. (Task 1)
4. **Schema wrappers.** `.optional()`, `.nullable()`, `.default()` and unions wrap the object; path extraction must see through them or it will report every path as unknown. (Task 1)
5. **Two merges on different keys both survive.** This is the entire concurrency claim; without it the feature is decoration. (Task 4)

---

### Task 1: The pure core

**Files:**
- Create: `src/exulu/json-field-schema.ts`
- Test: `src/exulu/json-field-schema.test.ts`

**Interfaces:**
- Consumes: nothing. Pure, no imports beyond `zod`.
- Produces:
  - `schemaPaths(schema: z.ZodTypeAny): string[]` — dotted paths the schema defines, one level into each top-level key. A key whose value is not an object yields the bare key.
  - `unknownPaths(schema: z.ZodTypeAny, value: unknown): string[]` — paths present in `value` that the schema does not define. Empty when all are known.
  - `mergeJson(stored: unknown, patch: Record<string, unknown>): Record<string, unknown>` — shallow top-level merge. `null` in the patch deletes the key. `stored` that is `null`, `undefined` or not an object is treated as `{}`.

- [ ] **Step 1: Write the failing tests**

```ts
const feld = z.object({ wert: z.string(), konfidenz: z.enum(["low","high"]) });
const schema = z.record(z.string(), feld);

test("schemaPaths sees through .optional()", () => {
  expect(schemaPaths(z.object({ a: z.string() }).optional())).toEqual(["a"]);
});
test("unknownPaths names a path the schema does not define", () => {
  expect(unknownPaths(z.object({ a: feld }), { b: { wert: "x" } })).toEqual(["b"]);
});
test("unknownPaths is empty when every path is known", () => {
  expect(unknownPaths(z.object({ a: feld }), { a: { wert: "x" } })).toEqual([]);
});
test("mergeJson keeps keys the patch does not mention", () => {
  expect(mergeJson({ a: 1, b: 2 }, { a: 9 })).toEqual({ a: 9, b: 2 });
});
test("mergeJson deletes a key given explicit null", () => {
  expect(mergeJson({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
});
test("mergeJson treats a null stored value as empty", () => {
  expect(mergeJson(null, { a: 1 })).toEqual({ a: 1 });
});
```

Review Focus 2, 3 and 4 are the last three plus the first.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx jest src/exulu/json-field-schema.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the three functions**

Unwrap `ZodOptional`, `ZodNullable`, `ZodDefault` before inspecting `.shape`; for `ZodRecord`, every top-level key is permitted and only the second path segment is checkable. Prefer `schema.def` traversal over `instanceof` chains — Zod version drift breaks `instanceof` silently.

- [ ] **Step 4: Run to green, then commit**

```bash
npx jest src/exulu/json-field-schema.test.ts && npx tsc --noEmit
git add src/exulu/json-field-schema.ts src/exulu/json-field-schema.test.ts
git commit -m "feat(json-fields): path extraction and key-level merge"
```

---

### Task 2: Declare the shape, and expose it to the model

**Files:**
- Modify: `src/exulu/context.ts:58-76` (`ExuluContextFieldDefinition`)
- Modify: `src/templates/tools/context-write-tools.ts:112`
- Test: `src/templates/tools/context-write-tools.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `ExuluContextFieldDefinition.schema?: z.ZodTypeAny` — the property every later task reads.

- [ ] **Step 1: Write the failing tests** in the existing file, matching its style

```ts
test("a json field with no schema is still offered as a JSON string", () => { /* current behaviour, unchanged */ });
test("a json field with a schema offers that schema to the model", () => {
  // build a context whose json field declares z.object({ wert: z.string() })
  // assert the generated update tool's input accepts { wert: "x" }
  // and rejects { wert: 1 }
});
```

The first test is the backward-compatibility guard from Global Constraints and must not be skipped.

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/templates/tools/context-write-tools.test.ts`

- [ ] **Step 3: Add the property and use it**

At `context-write-tools.ts:112`, use `field.schema` when present and the existing `z.string().describe(...)` line when not. The `.describe()` text on a declared schema should name the field, as the surrounding cases do.

- [ ] **Step 4: Run to green, then commit**

```bash
npx jest src/templates/tools/context-write-tools.test.ts && npx tsc --noEmit
git commit -am "feat(json-fields): declare a shape and offer it to the model"
```

---

### Task 3: The shared write helper

**Files:**
- Create: `src/exulu/item-write.ts`
- Test: `src/exulu/item-write.test.ts`

**Interfaces:**
- Consumes: `mergeJson`, `unknownPaths` from Task 1; `ExuluContextFieldDefinition` from Task 2.
- Produces:
  - `prepareItemWrite(args: { fields: ExuluContextFieldDefinition[]; existing: Record<string, unknown> | null; input: Record<string, unknown>; merge?: string[] }): { ok: true; values: Record<string, unknown> } | { ok: false; message: string }`

  Pure. No database, no Knex. `merge` names the json fields whose value is a patch rather than a replacement.

- [ ] **Step 1: Write the failing tests**

```ts
test("a field not named in merge is replaced, as today", ...);
test("a field named in merge keeps stored keys the patch omits", ...);
test("a schema violation is refused, and the message names the field and what was expected", ...);
test("a refusal message never contains SQL or a Postgres type name", ...);
test("the written value is the caller's object, not a parse result", () => {
  // an undeclared extra key survives the write — Global Constraints: never strip
});
test("a stored value that violates the schema still accepts a valid merge", () => {
  // Review Focus 1: old rows must not become permanently unwritable
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/exulu/item-write.test.ts`

- [ ] **Step 3: Implement `prepareItemWrite`**

Validate only the *incoming* value, never the stored one. On failure build the four-part message from the spec (what, why, expected, what is available) using `schemaPaths` for the fourth part.

- [ ] **Step 4: Run to green, then commit**

```bash
npx jest src/exulu/item-write.test.ts && npx tsc --noEmit
git commit -m "feat(json-fields): one write helper for merge and validation"
```

---

### Task 4: Both write paths, and a test that they agree

**Files:**
- Modify: `src/exulu/context.ts:799` (`updateItem`)
- Modify: `src/graphql/mutations/index.ts:833-839` (the knex `.update()`)
- Test: `src/exulu/item-write-parity.test.ts`

**Interfaces:**
- Consumes: `prepareItemWrite` from Task 3.
- Produces: nothing new. The deliverable is that both paths route through the helper.

- [ ] **Step 1: Write the failing parity test**

Drive both paths over the same fixture — the tool path through `updateItem`, the GraphQL path through the resolver's write — and assert identical stored values for: a replace, a merge, and a refused write.

```ts
test("two merges on different keys both survive", () => {
  // Review Focus 5. Apply merge {a:1} then {b:2} to the same row and assert
  // the result carries both. This is the concurrency claim; without it the
  // feature is decoration.
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/exulu/item-write-parity.test.ts`

- [ ] **Step 3: Route both paths through the helper**

The GraphQL resolver currently spreads `...input` straight into `.update()`. It must call `prepareItemWrite` first and return the refusal as a GraphQL error when `ok` is false. Do not change processor or embedding behaviour in either path — both already run processors (`src/graphql/mutations/index.ts:221-229`), and this plan does not touch that.

- [ ] **Step 4: Run the full suite, then commit**

```bash
npx jest && npx tsc --noEmit
git commit -am "feat(json-fields): merge and validation on both write paths"
```

---

### Task 5: Refuse a filter on a path that does not exist

**Files:**
- Modify: `src/graphql/utilities/convert-graphql-filter-operator-to-pg-query.ts:52` (the `contains` branch)
- Test: `src/graphql/utilities/convert-graphql-filter-operator-to-pg-query.test.ts`

**Interfaces:**
- Consumes: `unknownPaths`, `schemaPaths` from Task 1.
- Produces: nothing. Behaviour only.

- [ ] **Step 1: Write the failing tests** in the existing file, in its knex-as-string-builder style

```ts
test("a contains filter on a declared path still compiles to @>", ...);
test("a contains filter on an undeclared path is refused, not answered", () => {
  // The spec's core finding: today this returns zero rows and no error.
});
test("the refusal lists the valid paths", ...);
test("a json field with no schema filters exactly as before", ...);
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/graphql/utilities/convert-graphql-filter-operator-to-pg-query.test.ts`

- [ ] **Step 3: Add the path check**

Only when the field carries a schema. The converter currently receives `table`; it needs the field definition, which `applyFilters` already resolves — pass it rather than looking it up twice.

**One chokepoint covers every surface.** `applyFilters` is called by the generated pagination resolvers, by the mutation `where` lookups, and — at `src/graphql/resolvers/vector-search.ts:213` — by agentic retrieval's `itemFilters`. The spec's scope ("wherever a model supplies a filter") is satisfied by this one change; no second site needs editing.

**How the refusal travels — decided, not left open.** The converter raises a typed error (`UnknownFilterPathError` carrying field, offending paths and valid paths); the boundary that owns the caller maps it to a message. A discriminated union would change every call site of a function used in seven places, for no gain.

The binding constraint from the spec applies to what the **model** receives, not to the internals: a refused filter must arrive as a readable tool result, not as a thrown error that ends the turn. The internal raise is fine precisely because it is mapped before it gets there.

- [ ] **Step 4: Run the full suite, then commit**

```bash
npx jest && npx tsc --noEmit
git commit -am "feat(json-fields): refuse a filter on an undeclared path"
```
