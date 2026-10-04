# Memory Conflicts (agent memory redesign, sub-project 3b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let curators find near-duplicate and contradicting memories in a base with an on-demand scan, and resolve each group by keeping one, merging into one memory, or dismissing it.

**Architecture:** Two new core tables (`memory_conflicts` groups + decisions, `memory_judgements` remembered judge verdicts). A scan runs one pairwise cosine query over the base's public memory chunks in Postgres, groups duplicates with union-find, and judges the similarity band below duplicates with a structured model call (the entity extractor's pattern), capped per scan. Three resolution mutations reuse `context.updateItem`/`createItem` and re-point `memory_usages`. The frontend adds `/memory/[ctx]/conflicts`, a base-page card, a workbench line and a detail-page note, all route-local.

**Tech Stack:** Backend TypeScript, knex/Postgres + pgvector, AI SDK `generateText` + `Output.object`, generated GraphQL (`src/graphql/schemas/index.ts`), jest (`--maxWorkers=2`). Frontend Next.js app router, shadcn/ui, Apollo, next-intl (en/de), vitest (`--maxWorkers 2`).

**Spec:** `docs/superpowers/specs/2026-10-03-memory-conflicts-design.md` (backend repo, branch `feat/memory-conflicts`).

**Worktrees:** backend `/Users/daniel.claessen/Desktop/Projects/exulu/backend-agent-memory` (branch `feat/memory-conflicts` from develop d8169c8), frontend `/Users/daniel.claessen/Desktop/Projects/exulu/frontend-agent-memory` (branch `feat/memory-conflicts` from main ac009f2). Verify the branch in the same command as every commit.

## Global Constraints

- Detection covers **public, non-archived** memories only; private memories never enter detection and never appear in a group. Judge and suggestion prompts carry wordings only (no authors, no ids).
- Thresholds are constants in `src/exulu/memory/conflicts/thresholds.ts`: `DUPLICATE_MIN_SIMILARITY = 0.88`, `CANDIDATE_MIN_SIMILARITY = 0.70`, `JUDGE_CALLS_PER_SCAN = 40`, `GROUP_MAX_MEMBERS = 6`, `SCAN_MAX_MEMORIES = 2000`.
- Group key = `${context}:${kind}:${sorted ids joined by ","}`; judgement key = `${context}:${sorted pair joined by ","}`. Dismissed groups and groups a person resolved are never reopened by a scan; open groups whose key the scan did not produce are closed by the scan (`status = resolved`, `resolution = null`), and such machine-closed groups reopen when a later scan produces their key again (corrected 2026-10-03, Task 3 review). The pairs query is bounded by `SCAN_MAX_PAIRS = 5000`; a hit on the bound is reported through `skipped`.
- Scan requires agents **write** (`hasAgentsWriteAccess`: super admin or `role.agents === "write"`). Resolutions require agents write **and** `canEditMemory` on every member; the error names the first member the user may not change. Reads require agents read.
- Archiving never re-embeds and never runs the processor: `context.updateItem({ id, archived: true }, config, user.id, role?.id, false, false)`. Merged memories are created public with `created_by = user.id` and never re-embedded by the resolution beyond what `createItem` does by default (the merged memory must be embedded so recall finds it: pass `generateEmbeddingsOverwrite` undefined).
- Usage rows of merged members are re-pointed to the merged memory after collisions on (`message_id`, `memory_id`) are removed. Judgements involving archived members are deleted.
- i18n namespace `memory.conflicts.*` (en/de) with the spec's vocabulary; workbench keys under `agents.editor.memory.conflicts*`. Feature isolation: route-local documents; the workbench keeps its own counts query copy. No violet/purple; no new UI libraries.
- Process rules: foreground commands only, no `&`/`nohup`/watch modes/dev servers; jest `--maxWorkers=2`, vitest `--maxWorkers 2` (never `-w`); one build at a time; manual browser checks are listed for UAT. Baselines: backend jest fails only `compact-session`, `email-inbound/intake`, `resolve-context-window`; backend tsc 8 errors; frontend tsc 0; frontend `eslint .` has one pre-existing error in `app/(application)/data/components/entity-types.tsx`.

## Review Focus

1. A base with one public memory, or none with embeddings: the scan returns zeros and writes nothing (Task 3 test: empty pairs → no upsert, `open: 0`).
2. A duplicate component of nine memories: capped to the six most similar, the other three are left for the next scan, and the key is stable across scans (Task 2 test).
3. A pair the model answered `compatible` in an earlier scan: never sent to the judge again, never shown (Task 3 test with a pre-seeded judgement).
4. A member archived between scan and resolution: KEEP archives nothing twice and still resolves the group; MERGE re-points every member's usage rows, archived members included, and archives only the live ones (Task 4 tests with one member already archived).
5. A viewer with agents write who created none of the members and holds no write grant: every action disabled on the page (Task 6 `actionsFor` test) and the mutation rejects naming the member (Task 4 test).

---

## Backend

### Task 1: Tables and the write-access helper

**Files:**
- Modify: `src/postgres/core-schema.ts` (two schemas, registered in `coreSchemas.get()`), `src/postgres/core-schema.test.ts`
- Modify: `src/postgres/init-exulu-db.ts` (destructuring, `schemas` array, raw indexes after the `memory_usages` index block)
- Modify: `types/exulu-table-definition.ts` (add `"memory_conflicts"` / `"memory_judgements"` to the closed unions the way `"memory_usages"` was added)
- Modify: `src/graphql/utilities/access-control.ts` (+ `hasAgentsWriteAccess`), `src/graphql/utilities/access-control.test.ts`

**Interfaces:**
- Produces: tables `memory_conflicts` and `memory_judgements` (spec §2); `hasAgentsWriteAccess(user?: User): boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `src/postgres/core-schema.test.ts`:

```ts
describe("memory conflict schemas", () => {
  test("memory_conflicts holds groups and decisions without RBAC", () => {
    const schema = coreSchemas.get().memoryConflictsSchema();
    expect(schema.name).toEqual({ plural: "memory_conflicts", singular: "memory_conflict" });
    expect(schema.RBAC).toBeFalsy();
    const byName = Object.fromEntries(schema.fields.map((f) => [f.name, f]));
    expect(byName.context).toMatchObject({ type: "text", required: true });
    expect(byName.kind).toMatchObject({ type: "text", required: true });
    expect(byName.key).toMatchObject({ type: "text", required: true, unique: true });
    expect(byName.members).toMatchObject({ type: "json", required: true });
    expect(byName.similarity).toMatchObject({ type: "number", required: true });
    expect(byName.reason).toMatchObject({ type: "text" });
    expect(byName.status).toMatchObject({ type: "text", required: true, default: "open" });
    expect(byName.resolution).toMatchObject({ type: "text" });
    expect(byName.resolved_by).toMatchObject({ type: "number" });
    expect(byName.resolved_at).toMatchObject({ type: "date" });
    expect(byName.merged_into).toMatchObject({ type: "uuid" });
    expect(byName.scanned_at).toMatchObject({ type: "date", required: true });
    expect(byName.created_by).toBeUndefined();
  });
  test("memory_judgements remembers judged pairs", () => {
    const schema = coreSchemas.get().memoryJudgementsSchema();
    expect(schema.name).toEqual({ plural: "memory_judgements", singular: "memory_judgement" });
    const byName = Object.fromEntries(schema.fields.map((f) => [f.name, f]));
    expect(byName.context).toMatchObject({ type: "text", required: true });
    expect(byName.key).toMatchObject({ type: "text", required: true, unique: true });
    expect(byName.verdict).toMatchObject({ type: "text", required: true });
    expect(byName.reason).toMatchObject({ type: "text" });
    expect(byName.judged_at).toMatchObject({ type: "date", required: true });
  });
});
```

Append to `src/graphql/utilities/access-control.test.ts` (match the file's existing import of the module):

```ts
describe("hasAgentsWriteAccess", () => {
  it("is true for super admins and agents:write only", () => {
    expect(hasAgentsWriteAccess({ super_admin: true } as any)).toBe(true);
    expect(hasAgentsWriteAccess({ role: { agents: "write" } } as any)).toBe(true);
    expect(hasAgentsWriteAccess({ role: { agents: "read" } } as any)).toBe(false);
    expect(hasAgentsWriteAccess(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/postgres/core-schema src/graphql/utilities/access-control --maxWorkers=2`
Expected: FAIL — factories and helper missing.

- [ ] **Step 3: Implement**

In `src/postgres/core-schema.ts` after `memoryUsagesSchema`:

```ts
/**
 * Memory conflicts (sub-project 3b): one row per detected group (near-duplicates
 * or a contradiction) and the decision taken on it. `key` makes the scan's
 * upsert idempotent; `members` holds the sorted memory ids (2–6).
 */
const memoryConflictsSchema: ExuluTableDefinition = {
  type: "memory_conflicts",
  name: { plural: "memory_conflicts", singular: "memory_conflict" },
  fields: [
    { name: "context", type: "text", required: true, index: true },
    { name: "kind", type: "text", required: true },
    { name: "key", type: "text", required: true, unique: true },
    { name: "members", type: "json", required: true },
    { name: "similarity", type: "number", required: true },
    { name: "reason", type: "text" },
    { name: "status", type: "text", required: true, default: "open" },
    { name: "resolution", type: "text" },
    { name: "resolved_by", type: "number" },
    { name: "resolved_at", type: "date" },
    { name: "merged_into", type: "uuid" },
    { name: "scanned_at", type: "date", required: true },
  ],
};

/** Judged pairs, so a rescan never asks the model twice about the same two memories. */
const memoryJudgementsSchema: ExuluTableDefinition = {
  type: "memory_judgements",
  name: { plural: "memory_judgements", singular: "memory_judgement" },
  fields: [
    { name: "context", type: "text", required: true, index: true },
    { name: "key", type: "text", required: true, unique: true },
    { name: "verdict", type: "text", required: true },
    { name: "reason", type: "text" },
    { name: "judged_at", type: "date", required: true },
  ],
};
```

Register both in `coreSchemas.get()` after `memoryUsagesSchema`. In `init-exulu-db.ts`: destructure `memoryConflictsSchema, memoryJudgementsSchema`, add `memoryConflictsSchema(), memoryJudgementsSchema(),` to `schemas`, and after the `memory_usages` raw-index block:

```ts
  if (await knex.schema.hasTable("memory_conflicts")) {
    await knex.raw(`CREATE INDEX IF NOT EXISTS memory_conflicts_context_status_idx ON memory_conflicts (context, status)`);
  }
```

(`key` is unique through the field flag; `mapType` applies `unique` for text.)

In `src/graphql/utilities/access-control.ts` next to `hasAgentsReadAccess`:

```ts
export const hasAgentsWriteAccess = (user?: User): boolean =>
  user?.super_admin === true || user?.role?.agents === "write";
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx jest src/postgres src/graphql/utilities/access-control --maxWorkers=2 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: PASS; count 8.

- [ ] **Step 5: Commit**

```bash
git add src/postgres/core-schema.ts src/postgres/core-schema.test.ts src/postgres/init-exulu-db.ts types/exulu-table-definition.ts src/graphql/utilities/access-control.ts src/graphql/utilities/access-control.test.ts
git commit -m "feat(memory): memory_conflicts and memory_judgements tables, agents write helper"
```

---

### Task 2: Pure detection helpers

**Files:**
- Create: `src/exulu/memory/conflicts/thresholds.ts`, `src/exulu/memory/conflicts/detect.ts`, `src/exulu/memory/conflicts/detect.test.ts`

**Interfaces:**
- Produces: `Pair = { a: string; b: string; similarity: number }`; `pairKey(context, a, b)`, `groupKey(context, kind, ids)`, `sortIds(ids)`, `splitBands(pairs)` → `{ duplicatePairs, candidatePairs }`, `groupDuplicates(pairs, cap)` → `{ groups: { members: string[]; similarity: number }[]; leftover: Pair[] }`.

- [ ] **Step 1: Write the failing test**

`detect.test.ts`:

```ts
import { groupDuplicates, groupKey, pairKey, sortIds, splitBands, type Pair } from "./detect";

const p = (a: string, b: string, similarity: number): Pair => ({ a, b, similarity });

describe("keys", () => {
  it("sort ids so the same pair or group always maps to one key", () => {
    expect(sortIds(["b", "a", "c"])).toEqual(["a", "b", "c"]);
    expect(pairKey("mem", "b", "a")).toBe("mem:a,b");
    expect(groupKey("mem", "duplicate", ["c", "a"])).toBe("mem:duplicate:a,c");
  });
});

describe("splitBands", () => {
  it("splits at the duplicate threshold and drops anything below the candidate floor", () => {
    const { duplicatePairs, candidatePairs } = splitBands([p("a", "b", 0.95), p("a", "c", 0.88), p("c", "d", 0.75), p("d", "e", 0.69)]);
    expect(duplicatePairs.map((x) => x.b)).toEqual(["b", "c"]);
    expect(candidatePairs.map((x) => x.b)).toEqual(["d"]);
  });
});

describe("groupDuplicates", () => {
  it("joins pairs into connected components with the max similarity", () => {
    const { groups, leftover } = groupDuplicates([p("a", "b", 0.9), p("b", "c", 0.92), p("x", "y", 0.89)], 6);
    expect(groups).toEqual([{ members: ["a", "b", "c"], similarity: 0.92 }, { members: ["x", "y"], similarity: 0.89 }]);
    expect(leftover).toEqual([]);
  });
  it("caps a component to the cap most similar members and keeps the rest as leftover pairs", () => {
    const chain = [p("a", "b", 0.99), p("b", "c", 0.98), p("c", "d", 0.97), p("d", "e", 0.96), p("e", "f", 0.95), p("f", "g", 0.94), p("g", "h", 0.93), p("h", "i", 0.92)];
    const { groups, leftover } = groupDuplicates(chain, 6);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(leftover.map((x) => `${x.a}-${x.b}`)).toEqual(["f-g", "g-h", "h-i"]);
  });
  it("is stable: the same input in another order yields the same groups", () => {
    const one = groupDuplicates([p("a", "b", 0.9), p("b", "c", 0.92)], 6).groups;
    const two = groupDuplicates([p("c", "b", 0.92), p("b", "a", 0.9)], 6).groups;
    expect(one).toEqual(two);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/exulu/memory/conflicts --maxWorkers=2`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`thresholds.ts`:

```ts
/** Conflict detection knobs (spec §3). One place; nothing else hardcodes them. */
export const DUPLICATE_MIN_SIMILARITY = 0.88;
export const CANDIDATE_MIN_SIMILARITY = 0.7;
export const JUDGE_CALLS_PER_SCAN = 40;
export const GROUP_MAX_MEMBERS = 6;
export const SCAN_MAX_MEMORIES = 2000;
```

`detect.ts`:

```ts
import { CANDIDATE_MIN_SIMILARITY, DUPLICATE_MIN_SIMILARITY } from "./thresholds";

export type Pair = { a: string; b: string; similarity: number };
export type DuplicateGroup = { members: string[]; similarity: number };

export const sortIds = (ids: string[]): string[] => [...ids].sort();
export const pairKey = (context: string, a: string, b: string): string => `${context}:${sortIds([a, b]).join(",")}`;
export const groupKey = (context: string, kind: "duplicate" | "contradiction", ids: string[]): string =>
  `${context}:${kind}:${sortIds(ids).join(",")}`;

export function splitBands(pairs: Pair[]): { duplicatePairs: Pair[]; candidatePairs: Pair[] } {
  const duplicatePairs: Pair[] = [];
  const candidatePairs: Pair[] = [];
  for (const pair of pairs) {
    if (pair.similarity >= DUPLICATE_MIN_SIMILARITY) duplicatePairs.push(pair);
    else if (pair.similarity >= CANDIDATE_MIN_SIMILARITY) candidatePairs.push(pair);
  }
  return { duplicatePairs, candidatePairs };
}

/**
 * Connected components over duplicate pairs (union-find). A component larger
 * than `cap` keeps the `cap` members reached first when its pairs are walked in
 * descending similarity; pairs touching a dropped member become leftovers for
 * the next scan. Output is sorted (members and groups) so keys are stable.
 */
export function groupDuplicates(pairs: Pair[], cap: number): { groups: DuplicateGroup[]; leftover: Pair[] } {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
  for (const pair of pairs) union(pair.a, pair.b);

  const byRoot = new Map<string, Pair[]>();
  for (const pair of pairs) {
    const r = find(pair.a);
    byRoot.set(r, [...(byRoot.get(r) ?? []), pair]);
  }

  const groups: DuplicateGroup[] = [];
  const leftover: Pair[] = [];
  for (const componentPairs of byRoot.values()) {
    const sorted = [...componentPairs].sort((x, y) => y.similarity - x.similarity || `${x.a}${x.b}`.localeCompare(`${y.a}${y.b}`));
    const members = new Set<string>();
    for (const pair of sorted) {
      const fresh = [pair.a, pair.b].filter((id) => !members.has(id)).length;
      if (members.size + fresh <= cap) { members.add(pair.a); members.add(pair.b); }
    }
    for (const pair of sorted) if (!members.has(pair.a) || !members.has(pair.b)) leftover.push(pair);
    groups.push({ members: sortIds([...members]), similarity: sorted[0].similarity });
  }
  groups.sort((x, y) => x.members[0].localeCompare(y.members[0]));
  leftover.sort((x, y) => `${x.a}${x.b}`.localeCompare(`${y.a}${y.b}`));
  return { groups, leftover };
}
```

Traced for the chain fixture: the walk takes a-b, b-c, c-d, d-e, e-f (six members), then f-g would add a seventh and is skipped, as are g-h and h-i; those three become the leftovers.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/exulu/memory/conflicts --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/exulu/memory/conflicts
git commit -m "feat(memory): conflict detection helpers (bands, union-find grouping, keys)"
```

---

### Task 3: The scan (pairs query, judge, upsert)

**Files:**
- Create: `src/exulu/memory/conflicts/judge.ts`, `src/exulu/memory/conflicts/scan.ts`, `src/exulu/memory/conflicts/scan.test.ts`

**Interfaces:**
- Consumes: Task 2 helpers; `getTableName`/`getChunksTableName` (`@SRC/exulu/table-names`); `resolveModel` (`@SRC/exulu/resolve-model`); `generateText`, `Output` from `ai`.
- Produces: `Judge = (a: string, b: string) => Promise<{ verdict: "same" | "contradict" | "compatible"; reason: string }>`; `makeModelJudge({ modelId, user })`; `loadPublicPairs(db, context)`; `runScan({ db, context, user, judge, now? })` → `ScanResult = { open, duplicateGroups, contradictionGroups, judged, unjudged, skipped, scannedAt }`.

- [ ] **Step 1: Write the failing tests**

`scan.test.ts` uses a fake db that records inserts/updates and answers table reads:

```ts
jest.mock("@SRC/exulu/table-names", () => ({ getTableName: (id: string) => `${id}_items`, getChunksTableName: (id: string) => `${id}_chunks` }));

import { runScan, type Judge } from "./scan";

type Row = Record<string, any>;
function fakeDb(state: { pairs: Row[]; items: Row[]; conflicts?: Row[]; judgements?: Row[]; hasTable?: (t: string) => boolean; itemCount?: number }) {
  const writes: any[] = [];
  const conflicts = state.conflicts ?? [];
  const judgements = state.judgements ?? [];
  const db: any = jest.fn((table: string) => {
    const chain: any = { __table: table, __where: {} };
    const ret = (v: any) => { chain.__ret = v; return chain; };
    chain.where = (...args: any[]) => { if (typeof args[0] === "object") Object.assign(chain.__where, args[0]); else chain.__where[args[0]] = args[args.length - 1]; return chain; };
    chain.whereIn = (col: string, vals: any[]) => { chain.__where[`${col}__in`] = vals; return chain; };
    chain.whereNot = () => chain; chain.whereRaw = () => chain; chain.select = () => chain; chain.first = async () => chain.__ret?.[0];
    chain.count = async () => [{ c: String(state.itemCount ?? state.items.length) }];
    chain.insert = (rows: any) => { writes.push({ table, op: "insert", rows }); return { onConflict: () => ({ ignore: async () => undefined, merge: async () => undefined }) }; };
    chain.update = async (patch: any) => { writes.push({ table, op: "update", where: chain.__where, patch }); return 1; };
    chain.del = async () => { writes.push({ table, op: "delete", where: chain.__where }); return 1; };
    chain.then = (resolve: any, reject: any) => {
      const rows = table === "memory_conflicts" ? conflicts : table === "memory_judgements" ? judgements : table.endsWith("_items") ? state.items : [];
      return Promise.resolve(rows).then(resolve, reject);
    };
    return chain;
  });
  db.raw = async (_sql: string, _bindings?: any[]) => ({ rows: state.pairs });
  db.schema = { hasTable: async (t: string) => (state.hasTable ? state.hasTable(t) : true) };
  db.__writes = writes;
  return db;
}

const context = { id: "mem", name: "Memory" } as any;
const NOW = new Date("2026-10-03T10:00:00.000Z");
const stubJudge = (answers: Record<string, { verdict: "same" | "contradict" | "compatible"; reason: string }>): Judge =>
  jest.fn(async (a: string, b: string) => answers[`${a}|${b}`] ?? { verdict: "compatible", reason: "" });

describe("runScan", () => {
  it("writes nothing and reports zeros for a base without pairs", async () => {
    const db = fakeDb({ pairs: [], items: [{ id: "a" }] });
    const out = await runScan({ db, context, user: { id: 1 } as any, judge: stubJudge({}), now: NOW });
    expect(out).toMatchObject({ open: 0, duplicateGroups: 0, contradictionGroups: 0, judged: 0, unjudged: 0 });
    expect(db.__writes.filter((w: any) => w.op === "insert")).toEqual([]);
  });

  it("groups duplicates, judges the band once, stores judgements and upserts groups", async () => {
    const db = fakeDb({
      pairs: [{ a_id: "a", b_id: "b", similarity: 0.95 }, { a_id: "c", b_id: "d", similarity: 0.8 }, { a_id: "e", b_id: "f", similarity: 0.75 }],
      // wording == id so the stub judge can key on what it receives
      items: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, information: id })),
    });
    const judge = stubJudge({ "c|d": { verdict: "contradict", reason: "c says X, d says not X" }, "e|f": { verdict: "compatible", reason: "" } });
    const out = await runScan({ db, context, user: { id: 1 } as any, judge, now: NOW });
    expect(judge).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ open: 2, duplicateGroups: 1, contradictionGroups: 1, judged: 2, unjudged: 0 });
    const inserts = db.__writes.filter((w: any) => w.op === "insert");
    expect(inserts.find((w: any) => w.table === "memory_judgements").rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "mem:c,d", verdict: "contradict" }), expect.objectContaining({ key: "mem:e,f", verdict: "compatible" }),
    ]));
    const groups = inserts.find((w: any) => w.table === "memory_conflicts").rows;
    expect(groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "mem:duplicate:a,b", kind: "duplicate", members: JSON.stringify(["a", "b"]), similarity: 0.95, status: "open" }),
      expect.objectContaining({ key: "mem:contradiction:c,d", kind: "contradiction", reason: "c says X, d says not X", status: "open" }),
    ]));
  });

  it("reuses stored judgements, never reopens dismissed groups and closes open groups the scan did not produce", async () => {
    const db = fakeDb({
      pairs: [{ a_id: "c", b_id: "d", similarity: 0.8 }],
      items: [{ id: "c" }, { id: "d" }],
      judgements: [{ key: "mem:c,d", verdict: "contradict", reason: "stored" }],
      conflicts: [
        { id: "g1", key: "mem:contradiction:c,d", status: "dismissed" },
        { id: "g2", key: "mem:duplicate:x,y", status: "open" },
      ],
    });
    const judge = stubJudge({});
    const out = await runScan({ db, context, user: { id: 1 } as any, judge, now: NOW });
    expect(judge).not.toHaveBeenCalled();
    expect(out.judged).toBe(0);
    const inserts = db.__writes.filter((w: any) => w.op === "insert" && w.table === "memory_conflicts");
    expect(inserts).toEqual([]);                       // dismissed key is not re-inserted/reopened
    const closes = db.__writes.filter((w: any) => w.op === "update" && w.table === "memory_conflicts");
    expect(closes).toEqual([expect.objectContaining({ where: expect.objectContaining({ id__in: ["g2"] }), patch: expect.objectContaining({ status: "resolved", resolution: null }) })]);
  });

  it("caps judge calls per scan and reports the rest as unjudged; a failing judge leaves the pair unjudged", async () => {
    const pairs = Array.from({ length: 45 }, (_, i) => ({ a_id: `p${i}`, b_id: `q${i}`, similarity: 0.8 - i * 0.001 }));
    const items = pairs.flatMap((x) => [{ id: x.a_id, information: x.a_id }, { id: x.b_id, information: x.b_id }]);
    const judge: Judge = jest.fn(async (a: string) => { if (a === "p3") throw new Error("boom"); return { verdict: "compatible", reason: "" }; });
    const out = await runScan({ db: fakeDb({ pairs, items }), context, user: { id: 1 } as any, judge, now: NOW });
    expect(judge).toHaveBeenCalledTimes(40);
    expect(out.judged).toBe(39);
    expect(out.unjudged).toBe(6);  // 5 beyond the cap + 1 failed
  });

  it("refuses bases above the size cap", async () => {
    await expect(runScan({ db: fakeDb({ pairs: [], items: [], itemCount: 2001 }), context, user: { id: 1 } as any, judge: stubJudge({}), now: NOW })).rejects.toThrow(/too large/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/memory/conflicts/scan --maxWorkers=2`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the judge**

`judge.ts`:

```ts
import { generateText, Output } from "ai";
import { z } from "zod";
import type { User } from "@EXULU_TYPES/models/user";
import { resolveModel } from "@SRC/exulu/resolve-model";

export type Verdict = "same" | "contradict" | "compatible";
export type Judgement = { verdict: Verdict; reason: string };
export type Judge = (a: string, b: string) => Promise<Judgement>;

const schema = z.object({
  verdict: z.enum(["same", "contradict", "compatible"]),
  reason: z.string().max(160),
});

const SYSTEM = `You compare two short memories an assistant saved from conversations.
Answer with JSON: verdict = "same" when both state the same fact or instruction (wording may differ),
"contradict" when they cannot both be true or give opposite instructions for the same situation,
"compatible" otherwise (different facts, or one is a special case of the other). reason: one sentence, ≤ 160 characters, in the memories' language.`;

/** The model of the first agent using the base, resolved like the entity extractor does. */
export async function makeModelJudge({ modelId, user }: { modelId: string; user?: User }): Promise<Judge> {
  const { languageModel } = await resolveModel({ modelId, user, rbacBypass: true });
  return async (a, b) => {
    const { output } = await generateText({
      temperature: 0,
      model: languageModel,
      system: SYSTEM,
      prompt: `Memory A:\n${a}\n\nMemory B:\n${b}`,
      maxRetries: 1,
      output: Output.object({ schema }),
    });
    return { verdict: output.verdict, reason: output.reason };
  };
}

/** Suggested wording for a merge (spec §4); same model, one call. */
export async function makeMergeSuggester({ modelId, user }: { modelId: string; user?: User }) {
  const { languageModel } = await resolveModel({ modelId, user, rbacBypass: true });
  return async (members: { information: string; type?: string | null }[]): Promise<{ information: string; type: string | null }> => {
    const { output } = await generateText({
      temperature: 0,
      model: languageModel,
      system: "You merge near-duplicate memories into one. Keep every fact, drop repetition, keep the memories' language and tone, ≤ 400 characters. Answer with JSON { information }.",
      prompt: members.map((m, i) => `Memory ${i + 1}:\n${m.information}`).join("\n\n"),
      maxRetries: 1,
      output: Output.object({ schema: z.object({ information: z.string().min(1).max(600) }) }),
    });
    const types = members.map((m) => m.type).filter((t): t is string => !!t);
    const type = types.length ? [...types].sort((x, y) => types.filter((t) => t === y).length - types.filter((t) => t === x).length)[0] : null;
    return { information: output.information.trim(), type };
  };
}
```

(`resolveModel` returns `{ languageModel, … }`; the entity extractor reads the same property.)

- [ ] **Step 4: Implement the scan**

`scan.ts`:

```ts
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "@SRC/exulu/context";
import { getChunksTableName, getTableName } from "@SRC/exulu/table-names";
import { groupDuplicates, groupKey, pairKey, sortIds, splitBands, type Pair } from "./detect";
import type { Judge, Judgement } from "./judge";
import { CANDIDATE_MIN_SIMILARITY, GROUP_MAX_MEMBERS, JUDGE_CALLS_PER_SCAN, SCAN_MAX_MEMORIES } from "./thresholds";

export type { Judge, Judgement };
export type ScanResult = { open: number; duplicateGroups: number; contradictionGroups: number; judged: number; unjudged: number; skipped: number; scannedAt: string };

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);

/** All public, non-archived memory pairs of the base at or above the candidate floor (first chunk per memory). */
export async function loadPublicPairs(db: any, context: ExuluContext): Promise<Pair[]> {
  const items = getTableName(context.id);
  const chunks = getChunksTableName(context.id);
  const { rows } = await db.raw(
    `SELECT a.source AS a_id, b.source AS b_id, 1 - (a.embedding <=> b.embedding) AS similarity
       FROM ${chunks} a
       JOIN ${chunks} b ON a.source < b.source
       JOIN ${items} ia ON ia.id = a.source
       JOIN ${items} ib ON ib.id = b.source
      WHERE a.chunk_index = 0 AND b.chunk_index = 0
        AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
        AND ia.rights_mode = 'public' AND ib.rights_mode = 'public'
        AND (ia.archived IS NOT TRUE) AND (ib.archived IS NOT TRUE)
        AND 1 - (a.embedding <=> b.embedding) >= ?
      ORDER BY similarity DESC`,
    [CANDIDATE_MIN_SIMILARITY],
  );
  return (rows ?? []).map((r: any) => ({ a: r.a_id, b: r.b_id, similarity: num(r.similarity) }));
}

export async function runScan({ db, context, user, judge, now = new Date() }: { db: any; context: ExuluContext; user: User; judge: Judge; now?: Date }): Promise<ScanResult> {
  const items = getTableName(context.id);
  const [{ c }] = await db(items).whereNot("archived", true).where("rights_mode", "public").count("id as c");
  if (num(c) > SCAN_MAX_MEMORIES) throw new Error(`Memory base ${context.id} is too large for a conflict scan (${c} public memories, cap ${SCAN_MAX_MEMORIES})`);

  const pairs = await loadPublicPairs(db, context);
  const { duplicatePairs, candidatePairs } = splitBands(pairs);

  // Stored judgements: reuse, never re-ask.
  const stored: any[] = await db("memory_judgements").where("context", context.id).select("key", "verdict", "reason");
  const known = new Map(stored.map((j) => [j.key, { verdict: j.verdict as Judgement["verdict"], reason: j.reason ?? "" }]));

  const samePairs: Pair[] = [];
  const contradictions: { pair: Pair; reason: string }[] = [];
  const newJudgements: { key: string; verdict: string; reason: string }[] = [];
  let judged = 0, unjudged = 0, calls = 0;
  const wordings = new Map<string, string>();
  const needWording = candidatePairs.filter((p) => !known.has(pairKey(context.id, p.a, p.b)));
  if (needWording.length) {
    const ids = [...new Set(needWording.flatMap((p) => [p.a, p.b]))];
    for (const row of await db(items).whereIn("id", ids).select("id", "information")) wordings.set(row.id, String(row.information ?? ""));
  }
  for (const pair of candidatePairs) {
    const key = pairKey(context.id, pair.a, pair.b);
    let verdict = known.get(key);
    if (!verdict) {
      if (calls >= JUDGE_CALLS_PER_SCAN) { unjudged += 1; continue; }
      calls += 1;
      try {
        verdict = await judge(wordings.get(pair.a) ?? "", wordings.get(pair.b) ?? "");
        judged += 1;
        newJudgements.push({ key, verdict: verdict.verdict, reason: verdict.reason });
      } catch (e) {
        console.error("[EXULU] conflict judge failed", e);
        unjudged += 1;
        continue;
      }
    }
    if (verdict.verdict === "same") samePairs.push(pair);
    else if (verdict.verdict === "contradict") contradictions.push({ pair, reason: verdict.reason });
  }
  if (newJudgements.length) {
    await db("memory_judgements").insert(newJudgements.map((j) => ({ context: context.id, ...j, judged_at: now }))).onConflict("key").ignore();
  }

  const { groups, leftover } = groupDuplicates([...duplicatePairs, ...samePairs], GROUP_MAX_MEMBERS);
  const produced = new Map<string, { kind: "duplicate" | "contradiction"; members: string[]; similarity: number; reason: string | null }>();
  for (const g of groups) produced.set(groupKey(context.id, "duplicate", g.members), { kind: "duplicate", members: g.members, similarity: g.similarity, reason: null });
  for (const { pair, reason } of contradictions) {
    const members = sortIds([pair.a, pair.b]);
    produced.set(groupKey(context.id, "contradiction", members), { kind: "contradiction", members, similarity: pair.similarity, reason });
  }

  const existing: any[] = await db("memory_conflicts").where("context", context.id).select("id", "key", "status");
  const byKey = new Map(existing.map((r) => [r.key, r]));
  const inserts: any[] = [];
  for (const [key, g] of produced) {
    const row = byKey.get(key);
    if (!row) inserts.push({ context: context.id, kind: g.kind, key, members: JSON.stringify(g.members), similarity: g.similarity, reason: g.reason, status: "open", scanned_at: now });
    else if (row.status === "open") await db("memory_conflicts").where({ id: row.id }).update({ similarity: g.similarity, reason: g.reason, scanned_at: now });
    // dismissed / resolved: untouched
  }
  if (inserts.length) await db("memory_conflicts").insert(inserts).onConflict("key").ignore();
  const toClose = existing.filter((r) => r.status === "open" && !produced.has(r.key)).map((r) => r.id);
  if (toClose.length) await db("memory_conflicts").whereIn("id", toClose).update({ status: "resolved", resolution: null, resolved_at: now, scanned_at: now });

  return {
    open: [...produced.keys()].filter((k) => byKey.get(k)?.status !== "dismissed" && byKey.get(k)?.status !== "resolved").length,
    duplicateGroups: groups.length,
    contradictionGroups: contradictions.length,
    judged, unjudged, skipped: leftover.length,
    scannedAt: now.toISOString(),
  };
}
```

Fit the fake db's chain methods to the calls above (the test's `fakeDb` handles `where`, `whereIn`, `whereNot`, `select`, `count`, `insert().onConflict().ignore()`, `update`, `then`). If `db.raw` returns rows differently with the real pg driver (`{ rows }`), keep the `rows ?? []` read.

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx jest src/exulu/memory/conflicts --maxWorkers=2 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: PASS; count 8.

- [ ] **Step 6: Commit**

```bash
git add src/exulu/memory/conflicts
git commit -m "feat(memory): conflict scan — pairwise similarity, capped model judge, idempotent group upsert"
```

---

### Task 4: Resolutions, readers and GraphQL registration

**Files:**
- Create: `src/exulu/memory/conflicts/resolve.ts`, `src/exulu/memory/conflicts/resolve.test.ts`
- Create: `src/graphql/resolvers/memory-conflicts.ts` (readers), `src/graphql/resolvers/memory-conflicts.test.ts`
- Modify: `src/graphql/schemas/index.ts` (imports; Query/Mutation typedefs; types; resolvers)

**Interfaces:**
- Consumes: `canEditMemory` (`@SRC/exulu/memory/access`), `loadVisibleMemoryRows`/`displayName` (`@SRC/exulu/memory/recall-collector`), `creatorId`, `hasAgentsReadAccess`/`hasAgentsWriteAccess`, `runScan`/`makeModelJudge`/`makeMergeSuggester`, `ExuluConfig` (`config` in `createSDL` scope).
- Produces: `resolveConflict({ db, context, config, user, id, action, keepId?, merged? })`, `suggestMerge({ db, context, user, id, suggester })`, `memoryConflicts({ db, context })`, `memoryConflictCounts({ db, context })`, `memoryConflictsForMemory({ db, context, memoryId })`; GraphQL per spec §4.

- [ ] **Step 1: Write the failing tests**

`resolve.test.ts` (fake db records writes; `context.updateItem`/`createItem` are jest mocks; `canEditMemory` is mocked):

```ts
jest.mock("@SRC/exulu/memory/access", () => ({ canEditMemory: jest.fn(async (_c: unknown, row: any, user: any) => user.super_admin === true || row.created_by === user.id) }));
jest.mock("@SRC/exulu/table-names", () => ({ getTableName: (id: string) => `${id}_items` }));

import { resolveConflict } from "./resolve";

function fakeDb(state: { group: any; items: any[] }) {
  const writes: any[] = [];
  const db: any = jest.fn((table: string) => {
    const chain: any = { __where: {} };
    chain.where = (...a: any[]) => { if (typeof a[0] === "object") Object.assign(chain.__where, a[0]); else chain.__where[a[0]] = a[a.length - 1]; return chain; };
    chain.whereIn = (col: string, v: any[]) => { chain.__where[`${col}__in`] = v; return chain; };
    chain.whereNot = () => chain; chain.select = () => chain; chain.whereRaw = (sql: string, b: any[]) => { chain.__raw = { sql, b }; return chain; };
    chain.first = async () => (table === "memory_conflicts" ? state.group : undefined);
    chain.update = async (patch: any) => { writes.push({ table, op: "update", where: chain.__where, patch }); return 1; };
    chain.del = async () => { writes.push({ table, op: "delete", where: chain.__where, raw: chain.__raw }); return 1; };
    chain.then = (res: any) => Promise.resolve(table.endsWith("_items") ? state.items.filter((i) => (chain.__where.id__in ?? state.items.map((x: any) => x.id)).includes(i.id)) : []).then(res);
    return chain;
  });
  db.__writes = writes;
  return db;
}
const config: any = {};
const items = [
  { id: "a", information: "A", type: "FACT", rights_mode: "public", created_by: 4, archived: false },
  { id: "b", information: "B", type: "FACT", rights_mode: "public", created_by: 9, archived: false },
  { id: "c", information: "C", type: "FACT", rights_mode: "public", created_by: 4, archived: true },
];
const group = { id: "g1", context: "mem", kind: "duplicate", members: JSON.stringify(["a", "b", "c"]), status: "open" };
const makeContext = () => ({
  id: "mem", name: "Memory", fields: [],
  updateItem: jest.fn(async (item: any) => ({ item })),
  createItem: jest.fn(async (item: any) => ({ item: { id: "merged-1", ...item } })),
}) as any;
const admin = { id: 1, super_admin: true, role: { id: "r1", agents: "write" } } as any;
const author = { id: 4, role: { id: "r1", agents: "write" } } as any;

describe("resolveConflict", () => {
  it("KEEP archives every other non-archived member without re-embedding and resolves the group", async () => {
    const context = makeContext(); const db = fakeDb({ group, items });
    const out = await resolveConflict({ db, context, config, user: admin, id: "g1", action: "KEEP", keepId: "a" });
    expect(context.updateItem.mock.calls.map((c: any[]) => c[0])).toEqual([{ id: "b", archived: true }]);   // c already archived
    expect(context.updateItem.mock.calls[0].slice(1)).toEqual([config, 1, "r1", false, false]);
    expect(db.__writes).toContainEqual(expect.objectContaining({ table: "memory_conflicts", op: "update", patch: expect.objectContaining({ status: "resolved", resolution: "keep", resolved_by: 1 }) }));
    expect(db.__writes).toContainEqual(expect.objectContaining({ table: "memory_judgements", op: "delete" }));
    expect(out.status).toBe("resolved");
  });
  it("MERGE creates the public merged memory, archives members, re-points usage and records merged_into", async () => {
    const context = makeContext(); const db = fakeDb({ group, items });
    await resolveConflict({ db, context, config, user: admin, id: "g1", action: "MERGE", merged: { information: "A and B", type: "FACT" } });
    expect(context.createItem.mock.calls[0][0]).toMatchObject({ name: "A and B", information: "A and B", type: "FACT", rights_mode: "public", created_by: 1 });
    expect(context.createItem.mock.calls[0][0].description).toMatch(/Merged from 3 memories/);
    expect(context.updateItem.mock.calls.map((c: any[]) => c[0].id).sort()).toEqual(["a", "b"]);
    const usage = db.__writes.filter((w: any) => w.table === "memory_usages");
    expect(usage.map((w: any) => w.op)).toEqual(["delete", "update"]);
    expect(usage[1].patch).toEqual({ memory_id: "merged-1" });
    expect(usage[1].where).toMatchObject({ context: "mem", memory_id__in: ["a", "b", "c"] });
    expect(db.__writes).toContainEqual(expect.objectContaining({ table: "memory_conflicts", patch: expect.objectContaining({ resolution: "merge", merged_into: "merged-1" }) }));
  });
  it("NOT_CONFLICT dismisses without touching memories", async () => {
    const context = makeContext(); const db = fakeDb({ group, items });
    await resolveConflict({ db, context, config, user: admin, id: "g1", action: "NOT_CONFLICT" });
    expect(context.updateItem).not.toHaveBeenCalled();
    expect(db.__writes).toContainEqual(expect.objectContaining({ patch: expect.objectContaining({ status: "dismissed", resolution: "not_conflict" }) }));
  });
  it("rejects when the user may not change a member, naming it; rejects MERGE on contradictions and KEEP without a member keepId", async () => {
    await expect(resolveConflict({ db: fakeDb({ group, items }), context: makeContext(), config, user: author, id: "g1", action: "KEEP", keepId: "a" })).rejects.toThrow(/b/);
    await expect(resolveConflict({ db: fakeDb({ group: { ...group, kind: "contradiction" }, items }), context: makeContext(), config, user: admin, id: "g1", action: "MERGE", merged: { information: "x" } })).rejects.toThrow(/duplicate/);
    await expect(resolveConflict({ db: fakeDb({ group, items }), context: makeContext(), config, user: admin, id: "g1", action: "KEEP", keepId: "zzz" })).rejects.toThrow(/keepId/);
  });
  it("refuses groups that are not open", async () => {
    await expect(resolveConflict({ db: fakeDb({ group: { ...group, status: "dismissed" }, items }), context: makeContext(), config, user: admin, id: "g1", action: "KEEP", keepId: "a" })).rejects.toThrow(/open/);
  });
});
```

`src/graphql/resolvers/memory-conflicts.test.ts` (readers against a fake db; mock `@SRC/exulu/table-names` and `displayName` input):

```ts
jest.mock("@SRC/exulu/table-names", () => ({ getTableName: (id: string) => `${id}_items` }));
import { memoryConflictCounts, memoryConflicts, memoryConflictsForMemory } from "./memory-conflicts";

function fakeDb(t: Record<string, any[]>) {
  const db: any = jest.fn((table: string) => {
    const chain: any = {};
    for (const m of ["where", "whereIn", "whereNot", "orderBy", "select", "groupBy", "count", "max"]) chain[m] = () => chain;
    chain.first = async () => t[`${table}#first`]?.[0];
    chain.then = (res: any) => Promise.resolve(t[table] ?? []).then(res);
    return chain;
  });
  db.schema = { hasTable: async () => true };
  return db;
}
const context = { id: "mem", name: "Memory" } as any;

describe("memoryConflicts", () => {
  it("hydrates members with wording, author, saved and usedCount; drops groups with fewer than two live members", async () => {
    const db = fakeDb({
      memory_conflicts: [
        { id: "g1", kind: "duplicate", status: "open", similarity: 0.9, reason: null, members: JSON.stringify(["a", "b"]), scanned_at: new Date("2026-10-03T10:00:00Z") },
        { id: "g2", kind: "contradiction", status: "open", similarity: 0.8, reason: "r", members: JSON.stringify(["a", "gone"]), scanned_at: new Date("2026-10-03T10:00:00Z") },
      ],
      mem_items: [{ id: "a", information: "A", type: "FACT", created_by: "4", createdAt: new Date("2026-09-01T00:00:00Z") }, { id: "b", information: "B", type: null, created_by: null, createdAt: new Date("2026-09-02T00:00:00Z") }],
      users: [{ id: 4, firstname: "Sara", lastname: "Kraus" }],
      memory_usages: [{ memory_id: "a", c: "3" }],
    });
    const out = await memoryConflicts({ db, context });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "g1", kind: "duplicate", similarity: 0.9, members: [
      { id: "a", information: "A", type: "FACT", author: { id: 4, name: "Sara Kraus" }, createdAt: "2026-09-01T00:00:00.000Z", usedCount: 3 },
      { id: "b", information: "B", type: null, author: null, usedCount: 0 },
    ] });
  });
  it("counts open groups and distinct memories involved, with the last scan time", async () => {
    const db = fakeDb({ memory_conflicts: [{ members: JSON.stringify(["a", "b"]), scanned_at: new Date("2026-10-03T10:00:00Z") }, { members: JSON.stringify(["b", "c", "d"]), scanned_at: new Date("2026-10-02T10:00:00Z") }] });
    expect(await memoryConflictCounts({ db, context })).toEqual({ open: 2, memoriesInvolved: 4, lastScanAt: "2026-10-03T10:00:00.000Z" });
  });
  it("memoryConflictsForMemory returns the open groups containing the memory and the originals of a merge", async () => {
    const db = fakeDb({
      memory_conflicts: [{ id: "g1", kind: "duplicate", status: "open", similarity: 0.9, reason: null, members: JSON.stringify(["a", "b"]), scanned_at: new Date("2026-10-03T10:00:00Z") }],
      "memory_conflicts#first": [{ id: "g9", members: JSON.stringify(["x", "y"]), merged_into: "a" }],
      mem_items: [{ id: "a", information: "A" }, { id: "b", information: "B" }, { id: "x", information: "X", archived: true }, { id: "y", information: "Y", archived: true }],
      users: [], memory_usages: [],
    });
    const out = await memoryConflictsForMemory({ db, context, memoryId: "a" });
    expect(out.open.map((g) => g.id)).toEqual(["g1"]);
    expect(out.mergedFrom.map((m) => m.id)).toEqual(["x", "y"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/memory/conflicts/resolve src/graphql/resolvers/memory-conflicts --maxWorkers=2`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement resolutions**

`resolve.ts`:

```ts
import type { ExuluConfig } from "@SRC/exulu/app/index.ts";
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "@SRC/exulu/context";
import { canEditMemory } from "@SRC/exulu/memory/access";
import { creatorId } from "@SRC/exulu/memory/creator-id";
import { displayName } from "@SRC/exulu/memory/recall-collector";
import { getTableName } from "@SRC/exulu/table-names";
import { pairKey } from "./detect";

export type ResolveAction = "KEEP" | "MERGE" | "NOT_CONFLICT";
export type ResolveInput = {
  db: any; context: ExuluContext; config: ExuluConfig; user: User; id: string;
  action: ResolveAction; keepId?: string | null; merged?: { information: string; type?: string | null } | null;
};

const parseMembers = (raw: unknown): string[] => (Array.isArray(raw) ? raw : JSON.parse(String(raw ?? "[]"))) as string[];

async function loadGroup(db: any, context: ExuluContext, id: string) {
  const group = await db("memory_conflicts").where({ id, context: context.id }).first();
  if (!group) throw new Error(`Conflict ${id} not found`);
  if (group.status !== "open") throw new Error(`Conflict ${id} is not open`);
  return { ...group, members: parseMembers(group.members) };
}

async function assertWritable(db: any, context: ExuluContext, rows: any[], user: User) {
  for (const row of rows) {
    if (!(await canEditMemory(context, row, user, db))) throw new Error(`You can't change memory ${row.id}`);
  }
}

async function archiveMembers(context: ExuluContext, config: ExuluConfig, user: User, rows: any[], except?: string | null) {
  for (const row of rows) {
    if (row.id === except || row.archived === true) continue;
    await context.updateItem({ id: row.id, archived: true } as any, config, user.id, user.role?.id, false, false);
  }
}

async function dropJudgements(db: any, context: ExuluContext, memberIds: string[]) {
  // every judgement key containing one of the members: keys are "<ctx>:<a>,<b>"
  const likes = memberIds.map((id) => `%${id}%`);
  for (const like of likes) await db("memory_judgements").where("context", context.id).whereRaw("key LIKE ?", [like]).del();
}

export async function resolveConflict(input: ResolveInput): Promise<any> {
  const { db, context, config, user, id, action } = input;
  const group = await loadGroup(db, context, id);
  const items = getTableName(context.id);
  const rows: any[] = await db(items).whereIn("id", group.members).select("id", "information", "type", "rights_mode", "created_by", "archived");
  const now = new Date();

  if (action === "NOT_CONFLICT") {
    await db("memory_conflicts").where({ id }).update({ status: "dismissed", resolution: "not_conflict", resolved_by: user.id, resolved_at: now });
    return { ...group, status: "dismissed", resolution: "not_conflict" };
  }

  await assertWritable(db, context, rows, user);

  if (action === "KEEP") {
    if (!input.keepId || !group.members.includes(input.keepId)) throw new Error("keepId must be a member of the conflict");
    await archiveMembers(context, config, user, rows, input.keepId);
    await dropJudgements(db, context, group.members.filter((m: string) => m !== input.keepId));
    await db("memory_conflicts").where({ id }).update({ status: "resolved", resolution: "keep", resolved_by: user.id, resolved_at: now });
    return { ...group, status: "resolved", resolution: "keep" };
  }

  // MERGE
  if (group.kind !== "duplicate") throw new Error("Only duplicate groups can be merged");
  if (!input.merged?.information?.trim()) throw new Error("merged.information is required");
  const information = input.merged.information.trim();
  const types = rows.map((r) => r.type).filter((t): t is string => !!t);
  const type = input.merged.type ?? (types.length && types.every((t) => t === types[0]) ? types[0] : undefined);
  const authorIds = [...new Set(rows.map((r) => creatorId(r.created_by)).filter((x): x is number => x !== null))];
  const authors = authorIds.length ? await db("users").whereIn("id", authorIds).select("id", "firstname", "lastname", "email") : [];
  const names = authors.map((u: any) => displayName(u));
  const [me] = await db("users").whereIn("id", [user.id]).select("id", "firstname", "lastname", "email");
  const description = `Merged from ${group.members.length} memories by ${me ? displayName(me) : user.id}${names.length ? `: ${names.join(", ")}` : ""}`;

  const { item } = await context.createItem(
    { name: information.slice(0, 80), information, ...(type ? { type } : {}), description, rights_mode: "public", created_by: user.id } as any,
    config, user.id, user.role?.id, false,
  );
  const mergedId = item.id as string;

  // Record the link first so a failure below leaves the group open with merged_into set (spec §6 retry path).
  await db("memory_conflicts").where({ id }).update({ merged_into: mergedId });

  // Usage history follows the merged memory. Members recalled in the same answer share a message_id, so
  // keep exactly one row per message among members ∪ merged (lowest id) before re-pointing — corrected
  // 2026-10-03 after the Task 4 review: the original predicate tested the merged id, which no row has yet.
  await db("memory_usages").where("context", context.id).whereIn("memory_id", group.members)
    .whereRaw(
      `EXISTS (SELECT 1 FROM memory_usages m2
                WHERE m2.message_id = memory_usages.message_id
                  AND (m2.memory_id = ? OR (m2.memory_id = ANY(?) AND m2.id < memory_usages.id)))`,
      [mergedId, group.members],
    ).del();
  await db("memory_usages").where("context", context.id).whereIn("memory_id", group.members).update({ memory_id: mergedId });

  await archiveMembers(context, config, user, rows);
  await dropJudgements(db, context, group.members);
  await db("memory_conflicts").where({ id }).update({ status: "resolved", resolution: "merge", resolved_by: user.id, resolved_at: now, merged_into: mergedId });
  return { ...group, status: "resolved", resolution: "merge", mergedInto: mergedId };
}

export async function suggestMerge({ db, context, id, suggester }: { db: any; context: ExuluContext; id: string; suggester: (members: { information: string; type?: string | null }[]) => Promise<{ information: string; type: string | null }> }) {
  const group = await loadGroup(db, context, id);
  const rows: any[] = await db(getTableName(context.id)).whereIn("id", group.members).select("information", "type");
  return suggester(rows.map((r) => ({ information: String(r.information ?? ""), type: r.type ?? null })));
}
```

The fake db in the test models the usage delete as `whereRaw(...).del()` and the update as `whereIn(...).update(...)`, which is why the test expects `["delete", "update"]`.

- [ ] **Step 4: Implement readers**

`src/graphql/resolvers/memory-conflicts.ts`:

```ts
import type { ExuluContext } from "@SRC/exulu/context";
import { creatorId } from "@SRC/exulu/memory/creator-id";
import { displayName } from "@SRC/exulu/memory/recall-collector";
import { getTableName } from "@SRC/exulu/table-names";

export type ConflictMember = { id: string; information: string; type: string | null; author: { id: number; name: string } | null; createdAt: string; usedCount: number };
export type Conflict = { id: string; kind: string; status: string; similarity: number; reason: string | null; members: ConflictMember[]; scannedAt: string; resolvedAt: string | null; resolution: string | null; mergedInto: string | null };

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : typeof d === "string" ? new Date(d).toISOString() : null);
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const parseMembers = (raw: unknown): string[] => (Array.isArray(raw) ? raw : JSON.parse(String(raw ?? "[]"))) as string[];

async function hydrate(db: any, context: ExuluContext, rows: any[], opts: { includeArchived?: boolean } = {}): Promise<Conflict[]> {
  const ids = [...new Set(rows.flatMap((r) => parseMembers(r.members)))];
  if (ids.length === 0) return [];
  let q = db(getTableName(context.id)).whereIn("id", ids).select("id", "information", "type", "created_by", "createdAt", "archived");
  if (!opts.includeArchived) q = q.whereNot("archived", true);
  const items: any[] = await q;
  const byId = new Map(items.map((i) => [i.id, i]));
  const authorIds = [...new Set(items.map((i) => creatorId(i.created_by)).filter((x): x is number => x !== null))];
  const users = new Map<number, string>();
  if (authorIds.length) for (const u of await db("users").whereIn("id", authorIds).select("id", "firstname", "lastname", "email")) users.set(Number(u.id), displayName(u));
  const usage = new Map<string, number>();
  for (const u of await db("memory_usages").where("context", context.id).whereIn("memory_id", ids).groupBy("memory_id").select("memory_id").count("id as c")) usage.set(u.memory_id, num(u.c));
  const member = (id: string): ConflictMember | null => {
    const i = byId.get(id); if (!i) return null;
    const uid = creatorId(i.created_by);
    return { id, information: String(i.information ?? ""), type: i.type ?? null, author: uid !== null && users.has(uid) ? { id: uid, name: users.get(uid)! } : null, createdAt: iso(i.createdAt) ?? "", usedCount: usage.get(id) ?? 0 };
  };
  return rows.map((r) => ({
    id: r.id, kind: r.kind, status: r.status, similarity: num(r.similarity), reason: r.reason ?? null,
    members: parseMembers(r.members).map(member).filter((m): m is ConflictMember => m !== null),
    scannedAt: iso(r.scanned_at) ?? "", resolvedAt: iso(r.resolved_at), resolution: r.resolution ?? null, mergedInto: r.merged_into ?? null,
  })).filter((g) => g.members.length >= 2 || opts.includeArchived);
}

export async function memoryConflicts({ db, context }: { db: any; context: ExuluContext }): Promise<Conflict[]> {
  if (!(await db.schema.hasTable("memory_conflicts"))) return [];
  const rows: any[] = await db("memory_conflicts").where({ context: context.id, status: "open" }).orderBy("scanned_at", "desc").select("*");
  return hydrate(db, context, rows);
}

export async function memoryConflictCounts({ db, context }: { db: any; context: ExuluContext }) {
  if (!(await db.schema.hasTable("memory_conflicts"))) return { open: 0, memoriesInvolved: 0, lastScanAt: null };
  const rows: any[] = await db("memory_conflicts").where({ context: context.id, status: "open" }).select("members", "scanned_at");
  const last = await db("memory_conflicts").where("context", context.id).max("scanned_at as last").first();
  const involved = new Set(rows.flatMap((r) => parseMembers(r.members)));
  const newestOpen = rows.length ? new Date(Math.max(...rows.map((r) => new Date(r.scanned_at).getTime()))) : null;
  return { open: rows.length, memoriesInvolved: involved.size, lastScanAt: iso(last?.last) ?? (newestOpen ? newestOpen.toISOString() : null) };
}

/** One group hydrated for a mutation's return value (archived members included, so a resolved group still lists them). */
export async function hydrateConflictRow(db: any, context: ExuluContext, row: any): Promise<Conflict | null> {
  const [group] = await hydrate(db, context, [row], { includeArchived: true });
  return group ?? null;
}

export async function memoryConflictsForMemory({ db, context, memoryId }: { db: any; context: ExuluContext; memoryId: string }) {
  if (!(await db.schema.hasTable("memory_conflicts"))) return { open: [], mergedFrom: [] };
  const openRows: any[] = (await db("memory_conflicts").where({ context: context.id, status: "open" }).select("*")).filter((r: any) => parseMembers(r.members).includes(memoryId));
  const open = await hydrate(db, context, openRows);
  const merge = await db("memory_conflicts").where({ context: context.id, merged_into: memoryId }).first();
  const mergedFrom = merge ? (await hydrate(db, context, [{ ...merge, id: merge.id, kind: "duplicate", status: "resolved" }], { includeArchived: true }))[0]?.members ?? [] : [];
  return { open, mergedFrom };
}
```

The counts test expects `lastScanAt` from the `max()` query; the fake db's `max().first()` answers from `"memory_conflicts#first"` — when that is absent (the counts test), fall back to the open rows' newest `scanned_at` as the code does.

- [ ] **Step 5: GraphQL registration**

In `src/graphql/schemas/index.ts`:

- imports: `import { memoryConflictCounts, memoryConflicts, memoryConflictsForMemory } from "@SRC/graphql/resolvers/memory-conflicts";`, `import { resolveConflict, suggestMerge } from "@SRC/exulu/memory/conflicts/resolve";`, `import { runScan } from "@SRC/exulu/memory/conflicts/scan";`, `import { makeMergeSuggester, makeModelJudge } from "@SRC/exulu/memory/conflicts/judge";`, and `hasAgentsWriteAccess` next to `hasAgentsReadAccess`.
- Query typedefs (next to `memoryBaseUnusedIds`):

```graphql
    memoryConflicts(contextId: ID!): [MemoryConflict!]!
    memoryConflictCounts(contextId: ID!): MemoryConflictCounts
    memoryConflictsForMemory(contextId: ID!, memoryId: ID!): MemoryConflictsForMemory
```

- Mutation typedefs (a new `mutationDefs += \`…\`` block after the generated per-table ones):

```graphql
    memoryConflictsScan(contextId: ID!): MemoryConflictScanResult!
    memoryConflictResolve(id: ID!, action: MemoryConflictAction!, keepId: ID, merged: MemoryMergeInput): MemoryConflict!
    memoryConflictSuggestMerge(id: ID!): MemoryMergeSuggestion!
```

- Types after the usage types:

```graphql
enum MemoryConflictAction { KEEP  MERGE  NOT_CONFLICT }
input MemoryMergeInput { information: String!  type: String }
type MemoryConflictMember { id: ID!  information: String!  type: String  author: MemoryBaseUser  createdAt: String!  usedCount: Int! }
type MemoryConflict { id: ID!  kind: String!  status: String!  similarity: Float!  reason: String  members: [MemoryConflictMember!]!  scannedAt: String!  resolvedAt: String  resolution: String  mergedInto: ID }
type MemoryConflictCounts { open: Int!  memoriesInvolved: Int!  lastScanAt: String }
type MemoryConflictsForMemory { open: [MemoryConflict!]!  mergedFrom: [MemoryConflictMember!]! }
type MemoryConflictScanResult { open: Int!  duplicateGroups: Int!  contradictionGroups: Int!  judged: Int!  unjudged: Int!  skipped: Int!  scannedAt: String! }
type MemoryMergeSuggestion { information: String!  type: String }
```

- Resolvers (next to the usage ones; `memoryContextOf` exists there):

```ts
  const firstAgentModel = async (db: any, contextId: string): Promise<string> => {
    const agent = await db("agents").where("memory", contextId).orderBy("createdAt", "asc").select("model").first();
    if (!agent?.model) throw new Error("No agent with a model uses this memory base; a conflict scan needs one");
    return agent.model;
  };
  resolvers.Query["memoryConflicts"] = async (_, args, context) => {
    const target = memoryContextOf(args.contextId);
    if (!hasAgentsReadAccess(context.user) || !target) return [];
    return memoryConflicts({ db: context.db, context: target });
  };
  resolvers.Query["memoryConflictCounts"] = async (_, args, context) => {
    const target = memoryContextOf(args.contextId);
    if (!hasAgentsReadAccess(context.user) || !target) return null;
    return memoryConflictCounts({ db: context.db, context: target });
  };
  resolvers.Query["memoryConflictsForMemory"] = async (_, args, context) => {
    const target = memoryContextOf(args.contextId);
    if (!hasAgentsReadAccess(context.user) || !target) return null;
    return memoryConflictsForMemory({ db: context.db, context: target, memoryId: args.memoryId });
  };
  resolvers.Mutation["memoryConflictsScan"] = async (_, args, context) => {
    const target = memoryContextOf(args.contextId);
    if (!hasAgentsWriteAccess(context.user) || !target) throw new Error("Not allowed");
    const judge = await makeModelJudge({ modelId: await firstAgentModel(context.db, target.id), user: context.user });
    return runScan({ db: context.db, context: target, user: context.user, judge });
  };
  resolvers.Mutation["memoryConflictResolve"] = async (_, args, context) => {
    const group = await context.db("memory_conflicts").where({ id: args.id }).first();
    const target = group ? memoryContextOf(group.context) : undefined;
    if (!hasAgentsWriteAccess(context.user) || !target) throw new Error("Not allowed");
    await resolveConflict({ db: context.db, context: target, config, user: context.user, id: args.id, action: args.action, keepId: args.keepId, merged: args.merged });
    const row = await context.db("memory_conflicts").where({ id: args.id }).first();
    return hydrateConflictRow(context.db, target, row);
  };
  resolvers.Mutation["memoryConflictSuggestMerge"] = async (_, args, context) => {
    const group = await context.db("memory_conflicts").where({ id: args.id }).first();
    const target = group ? memoryContextOf(group.context) : undefined;
    if (!hasAgentsWriteAccess(context.user) || !target) throw new Error("Not allowed");
    const suggester = await makeMergeSuggester({ modelId: await firstAgentModel(context.db, target.id), user: context.user });
    return suggestMerge({ db: context.db, context: target, id: args.id, suggester });
  };
```

The import line for the readers becomes `import { hydrateConflictRow, memoryConflictCounts, memoryConflicts, memoryConflictsForMemory } from "@SRC/graphql/resolvers/memory-conflicts";`.

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx jest src/exulu/memory src/graphql/resolvers --maxWorkers=2 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: PASS; count 8.

- [ ] **Step 7: Commit**

```bash
git add src/exulu/memory/conflicts src/graphql/resolvers/memory-conflicts.ts src/graphql/resolvers/memory-conflicts.test.ts src/graphql/schemas/index.ts
git commit -m "feat(memory): conflict resolutions (keep, merge, dismiss), merge suggestion and readers"
```

---

### Task 5: Backend verification and docs

**Files:**
- Modify: `mintlify-docs/building/memory/overview.mdx` ("## Conflicts" section before "## A memory"), `mintlify-docs/building/agents/workbench.mdx` (one clause)

- [ ] **Step 1: Verification**

```bash
npx jest --silent --maxWorkers=2 2>&1 | grep -E "^(Tests:|Test Suites:|FAIL)" | sort -u
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"
npm run build 2>&1 | tail -3
```
Expected: only the 3 pre-existing failing suites; tsc 8; build succeeds.

- [ ] **Step 2: Docs**

Insert before "## A memory" in `overview.mdx`:

```mdx
## Conflicts

**Find conflicts** on a base's Conflicts page scans the shared memories: memories that say nearly the same thing are grouped as near-duplicates, and similar memories that disagree are judged by the agent's model and listed as contradictions. For each group you can **keep one** (the others are archived), **merge** near-duplicates into a single memory with a suggested wording that credits all authors and keeps the usage history, or mark the group as **not a conflict** so it never comes back. Private memories are never scanned. Changing a memory needs write access on it; the page disables what you may not change.
```

In `workbench.mdx`, extend the Insights sentence: "… saved per week, and how many possible conflicts the last scan found."

Run `npx mint validate` and `npx mint broken-links` in `mintlify-docs/` when available.

- [ ] **Step 3: Commit**

```bash
git add mintlify-docs
git commit -m "docs(memory): conflicts in the Memory area"
```

---

## Frontend

**Conventions (verified 2026-10-03):** feature isolation lint (route-local documents in `app/(application)/memory/queries.ts`; the workbench keeps its own copy in `app/(application)/agents/edit/[id]/queries.ts`); the base page `base-shell.tsx` currently renders four `StatCard`s (Memories, Contributors, Last saved, Never used) in a `grid-cols-2 lg:grid-cols-4` and an `OverflowMenu` with "Open in Knowledge"; `memory-detail.tsx` has a Details `<dl>` ending at `detail.updated` followed by the Usage section; the workbench `memory-section.tsx` Needs-attention column has two `Link`s (never used, stale); `SidePanel`, `ConfirmDialog` (reject keeps it open), `EmptyState`, `Badge`, `Button`, `Textarea` (`@/components/ui/textarea`), `Select` exist; `guardRoute("memory")` + `fetchGraphQLServerSide` is the server-page pattern (`app/(application)/memory/[ctx]/page.tsx`); `UserContext` exposes `{ user }` with `id`, `super_admin`, `role`.

### Task 6: Scaffolding — queries, i18n, demo resolvers, pure module

**Files:**
- Modify: `app/(application)/memory/queries.ts`, `queries.test.ts`; `messages/en.json`, `messages/de.json`; `lib/demo/resolvers.ts`, `lib/demo/apollo-link.operations.test.ts`
- Create: `app/(application)/memory/[ctx]/conflicts/components/conflicts-data.ts`, `conflicts-data.test.ts`

**Interfaces:**
- Produces: `GET_MEMORY_CONFLICTS`, `GET_MEMORY_CONFLICT_COUNTS`, `GET_MEMORY_CONFLICTS_FOR_MEMORY`, `SCAN_MEMORY_CONFLICTS`, `RESOLVE_MEMORY_CONFLICT`, `SUGGEST_MEMORY_MERGE`; types `Conflict`, `ConflictMember`; `groupTitle(group)` → `{ kind, count }`, `canResolve(group, user)` → `{ keep: boolean; merge: boolean; dismiss: boolean; blockedBy: string | null }`, `scanToastKey(result)`, `commonType(members)`, `memberLine(member)`.

- [ ] **Step 1: Write the failing tests**

`conflicts-data.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canResolve, commonType, groupTitle, memberLine, scanToastKey, type Conflict } from "./conflicts-data";

const member = (id: string, author: { id: number; name: string } | null, type: string | null = "FACT") => ({ id, information: `M ${id}`, type, author, createdAt: "2026-09-01T00:00:00.000Z", usedCount: 2 });
const group: Conflict = { id: "g1", kind: "duplicate", status: "open", similarity: 0.91, reason: null, members: [member("a", { id: 4, name: "Sara" }), member("b", { id: 9, name: "Lena" })], scannedAt: "2026-10-03T10:00:00.000Z", resolvedAt: null, resolution: null, mergedInto: null };

describe("groupTitle", () => {
  it("names the kind and the member count", () => {
    expect(groupTitle(group)).toEqual({ kind: "duplicate", count: 2 });
  });
});

describe("canResolve", () => {
  it("super admins may do everything; merge only on duplicates", () => {
    expect(canResolve(group, { id: 1, super_admin: true })).toEqual({ keep: true, merge: true, dismiss: true, blockedBy: null });
    expect(canResolve({ ...group, kind: "contradiction" }, { id: 1, super_admin: true })).toEqual({ keep: true, merge: false, dismiss: true, blockedBy: null });
  });
  it("a non-admin needs to be the author of every member; the first foreign member blocks and is named", () => {
    expect(canResolve(group, { id: 4 })).toEqual({ keep: false, merge: false, dismiss: false, blockedBy: "Lena" });
    const own: Conflict = { ...group, members: [member("a", { id: 4, name: "Sara" }), member("c", { id: 4, name: "Sara" })] };
    expect(canResolve(own, { id: 4 })).toEqual({ keep: true, merge: true, dismiss: true, blockedBy: null });
    expect(canResolve(group, undefined).keep).toBe(false);
  });
});

describe("helpers", () => {
  it("picks the most common type, null when mixed evenly or absent", () => {
    expect(commonType([member("a", null, "FACT"), member("b", null, "FACT"), member("c", null, "RULE")])).toBe("FACT");
    expect(commonType([member("a", null, null), member("b", null, null)])).toBeNull();
  });
  it("scan toast key depends on unjudged pairs", () => {
    expect(scanToastKey({ open: 2, unjudged: 0 })).toBe("scanDone");
    expect(scanToastKey({ open: 2, unjudged: 5 })).toBe("scanDoneUnjudged");
  });
  it("member line joins type, author and leaves out blanks", () => {
    expect(memberLine(member("a", { id: 4, name: "Sara" }), "Unknown")).toBe("FACT · Sara");
    expect(memberLine(member("a", null, null), "Unknown")).toBe("Unknown");
  });
});
```

Append to `queries.test.ts`:

```ts
import { GET_MEMORY_CONFLICTS, GET_MEMORY_CONFLICT_COUNTS, GET_MEMORY_CONFLICTS_FOR_MEMORY, RESOLVE_MEMORY_CONFLICT, SCAN_MEMORY_CONFLICTS, SUGGEST_MEMORY_MERGE } from "./queries";
describe("conflict documents", () => {
  it("name the conflict operations", () => {
    expect(body(GET_MEMORY_CONFLICTS)).toContain("query MemoryConflicts(");
    expect(body(GET_MEMORY_CONFLICT_COUNTS)).toContain("query MemoryConflictCounts");
    expect(body(GET_MEMORY_CONFLICTS_FOR_MEMORY)).toContain("query MemoryConflictsForMemory");
    expect(body(SCAN_MEMORY_CONFLICTS)).toContain("mutation MemoryConflictsScan");
    expect(body(RESOLVE_MEMORY_CONFLICT)).toContain("mutation MemoryConflictResolve");
    expect(body(SUGGEST_MEMORY_MERGE)).toContain("mutation MemoryConflictSuggestMerge");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run "app/(application)/memory" --maxWorkers 2`
Expected: FAIL — missing modules/exports.

- [ ] **Step 3: Queries**

Append to `queries.ts`:

```ts
// ---- Conflicts (sub-project 3b) --------------------------------------------

const CONFLICT_FIELDS = `
  id
  kind
  status
  similarity
  reason
  members { id information type author { id name } createdAt usedCount }
  scannedAt
  resolvedAt
  resolution
  mergedInto
`;

export const GET_MEMORY_CONFLICTS = gql`
  query MemoryConflicts($contextId: ID!) { memoryConflicts(contextId: $contextId) { ${CONFLICT_FIELDS} } }
`;
export const GET_MEMORY_CONFLICT_COUNTS = gql`
  query MemoryConflictCounts($contextId: ID!) { memoryConflictCounts(contextId: $contextId) { open memoriesInvolved lastScanAt } }
`;
export const GET_MEMORY_CONFLICTS_FOR_MEMORY = gql`
  query MemoryConflictsForMemory($contextId: ID!, $memoryId: ID!) {
    memoryConflictsForMemory(contextId: $contextId, memoryId: $memoryId) {
      open { ${CONFLICT_FIELDS} }
      mergedFrom { id information type author { id name } createdAt usedCount }
    }
  }
`;
export const SCAN_MEMORY_CONFLICTS = gql`
  mutation MemoryConflictsScan($contextId: ID!) {
    memoryConflictsScan(contextId: $contextId) { open duplicateGroups contradictionGroups judged unjudged skipped scannedAt }
  }
`;
export const RESOLVE_MEMORY_CONFLICT = gql`
  mutation MemoryConflictResolve($id: ID!, $action: MemoryConflictAction!, $keepId: ID, $merged: MemoryMergeInput) {
    memoryConflictResolve(id: $id, action: $action, keepId: $keepId, merged: $merged) { ${CONFLICT_FIELDS} }
  }
`;
export const SUGGEST_MEMORY_MERGE = gql`
  mutation MemoryConflictSuggestMerge($id: ID!) { memoryConflictSuggestMerge(id: $id) { information type } }
`;
```

- [ ] **Step 4: Pure module**

`conflicts-data.ts`:

```ts
/** Pure helpers for the Conflicts page (spec §5.3). */

export interface ConflictMember { id: string; information: string; type: string | null; author: { id: number; name: string } | null; createdAt: string; usedCount: number }
export interface Conflict {
  id: string; kind: "duplicate" | "contradiction" | string; status: string; similarity: number; reason: string | null;
  members: ConflictMember[]; scannedAt: string; resolvedAt: string | null; resolution: string | null; mergedInto: string | null;
}
export interface Viewer { id?: number | null; super_admin?: boolean | null }

export function groupTitle(group: Conflict): { kind: string; count: number } {
  return { kind: group.kind, count: group.members.length };
}

/** Mirrors the server rule the client can see: super admin, or author of every member (write grants are checked server-side). */
export function canResolve(group: Conflict, user: Viewer | undefined): { keep: boolean; merge: boolean; dismiss: boolean; blockedBy: string | null } {
  const none = { keep: false, merge: false, dismiss: false, blockedBy: null as string | null };
  if (!user?.id) return none;
  if (!user.super_admin) {
    const foreign = group.members.find((m) => m.author?.id !== user.id);
    if (foreign) return { ...none, blockedBy: foreign.author?.name ?? "?" };
  }
  return { keep: true, merge: group.kind === "duplicate", dismiss: true, blockedBy: null };
}

export function commonType(members: Pick<ConflictMember, "type">[]): string | null {
  const counts = new Map<string, number>();
  for (const m of members) if (m.type) counts.set(m.type, (counts.get(m.type) ?? 0) + 1);
  if (counts.size === 0) return null;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) return null;
  return sorted[0][0];
}

export function scanToastKey(result: { open: number; unjudged: number }): "scanDone" | "scanDoneUnjudged" {
  return result.unjudged > 0 ? "scanDoneUnjudged" : "scanDone";
}

export function memberLine(member: Pick<ConflictMember, "type" | "author">, unknownLabel: string): string {
  const parts = [member.type, member.author?.name].filter((x): x is string => !!x);
  return parts.length ? parts.join(" · ") : unknownLabel;
}
```

- [ ] **Step 5: i18n**

`messages/en.json`, inside `memory`:

```json
"conflicts": {
  "title": "Conflicts",
  "lastScan": "Last scan {when}",
  "notScanned": "Not scanned yet",
  "find": "Find conflicts",
  "scanning": "Scanning…",
  "scanDone": "{open, plural, =0 {No open conflicts} one {# open conflict} other {# open conflicts}}",
  "scanDoneUnjudged": "{open, plural, =0 {No open conflicts} one {# open conflict} other {# open conflicts}} · {unjudged} pairs still unjudged, run again",
  "scanFailed": "The scan failed: {message}",
  "duplicate": "Near-duplicates",
  "contradiction": "Contradiction",
  "duplicateTitle": "{count} memories say nearly the same thing",
  "similarity": "similarity {percent}%",
  "usedTimes": "used {count}×",
  "keepThis": "Keep this one",
  "notDuplicate": "Not a duplicate",
  "notConflict": "Not a conflict",
  "skip": "Skip",
  "merge": "Merge",
  "keepTitle": "Keep this memory?",
  "keepDescription": "{count, plural, one {The other memory is archived} other {The other # memories are archived}} and leave recall and the counts. You can restore them in Knowledge.",
  "dismissTitle": "Mark as not a conflict?",
  "dismissDescription": "The group is closed and never shown again, even after a new scan.",
  "mergeTitle": "Merge into one memory",
  "mergeHint": "Suggested wording – edit as needed.",
  "mergeCredits": "Credits all {count} authors · keeps usage history",
  "mergeAction": "Merge",
  "mergeConfirmTitle": "Merge {count} memories?",
  "mergeConfirmDescription": "One new public memory is created; the originals are archived and their usage counts move to the new memory.",
  "suggestFailed": "No suggestion available; the first memory's wording is prefilled.",
  "wording": "Wording",
  "type": "Type",
  "noType": "No type",
  "resolved": "Done",
  "blocked": "You can't change {author}'s memory",
  "emptyTitle": "No open conflicts",
  "emptyDescription": "Run a scan after new memories were saved.",
  "unscannedTitle": "Not scanned yet",
  "unscannedDescription": "Find near-duplicates and contradictions among the shared memories of this base.",
  "card": "Conflicts",
  "cardCaption": "{count} memories involved",
  "partOfOpen": "Part of an open conflict",
  "open": "Open",
  "mergedFrom": "Merged from {count} memories",
  "unknown": "Unknown"
}
```

`messages/de.json` `memory.conflicts`: `"title": "Konflikte", "lastScan": "Letzter Scan {when}", "notScanned": "Noch nicht gescannt", "find": "Konflikte suchen", "scanning": "Wird gescannt…", "scanDone": "{open, plural, =0 {Keine offenen Konflikte} one {# offener Konflikt} other {# offene Konflikte}}", "scanDoneUnjudged": "{open, plural, =0 {Keine offenen Konflikte} one {# offener Konflikt} other {# offene Konflikte}} · {unjudged} Paare noch nicht geprüft, erneut ausführen", "scanFailed": "Der Scan ist fehlgeschlagen: {message}", "duplicate": "Fast-Duplikate", "contradiction": "Widerspruch", "duplicateTitle": "{count} Erinnerungen sagen fast dasselbe", "similarity": "Ähnlichkeit {percent} %", "usedTimes": "{count}× verwendet", "keepThis": "Diese behalten", "notDuplicate": "Kein Duplikat", "notConflict": "Kein Konflikt", "skip": "Überspringen", "merge": "Zusammenführen", "keepTitle": "Diese Erinnerung behalten?", "keepDescription": "{count, plural, one {Die andere Erinnerung wird archiviert} other {Die anderen # Erinnerungen werden archiviert}} und verlässt den Abruf und die Zählung. In Wissen lässt sich das rückgängig machen.", "dismissTitle": "Als keinen Konflikt markieren?", "dismissDescription": "Die Gruppe wird geschlossen und nie wieder angezeigt, auch nach einem neuen Scan.", "mergeTitle": "Zu einer Erinnerung zusammenführen", "mergeHint": "Vorgeschlagener Wortlaut – bei Bedarf anpassen.", "mergeCredits": "Nennt alle {count} Autoren · behält die Verwendung", "mergeAction": "Zusammenführen", "mergeConfirmTitle": "{count} Erinnerungen zusammenführen?", "mergeConfirmDescription": "Eine neue öffentliche Erinnerung entsteht; die Originale werden archiviert und ihre Verwendung wandert zur neuen Erinnerung.", "suggestFailed": "Kein Vorschlag verfügbar; der Wortlaut der ersten Erinnerung ist vorausgefüllt.", "wording": "Wortlaut", "type": "Typ", "noType": "Kein Typ", "resolved": "Erledigt", "blocked": "Du kannst die Erinnerung von {author} nicht ändern", "emptyTitle": "Keine offenen Konflikte", "emptyDescription": "Starte einen Scan, nachdem neue Erinnerungen gespeichert wurden.", "unscannedTitle": "Noch nicht gescannt", "unscannedDescription": "Finde Fast-Duplikate und Widersprüche unter den geteilten Erinnerungen dieser Basis.", "card": "Konflikte", "cardCaption": "{count} Erinnerungen betroffen", "partOfOpen": "Teil eines offenen Konflikts", "open": "Öffnen", "mergedFrom": "Zusammengeführt aus {count} Erinnerungen", "unknown": "Unbekannt"`.

`agents.editor.memory` (both locales): en `"conflictsLine": "Possible conflicts"`; de `"conflictsLine": "Mögliche Konflikte"`.

`npm run check-messages` must pass.

- [ ] **Step 6: Demo resolvers and the operations test**

In `lib/demo/resolvers.ts` after the usage entries:

```ts
  MemoryConflicts: () => ({ memoryConflicts: [] }),
  MemoryConflictCounts: () => ({ memoryConflictCounts: { open: 0, memoriesInvolved: 0, lastScanAt: null } }),
  MemoryConflictsForMemory: () => ({ memoryConflictsForMemory: { open: [], mergedFrom: [] } }),
  WorkbenchMemoryConflictCounts: () => ({ memoryConflictCounts: { open: 0, memoriesInvolved: 0, lastScanAt: null } }),
```

(The mutations are not mapped: demo mode never scans or resolves; the page's buttons are disabled in demo mode if the app exposes a demo flag — check `lib/demo/flag.ts`; otherwise leave them enabled and let the unmapped-operation error surface, as other demo-mode mutations do.) Add one operations-test case per mapped operation.

- [ ] **Step 7: Run the tests, parity and lint**

Run: `npx vitest run "app/(application)/memory" lib/demo --maxWorkers 2 && npm run check-messages && npx eslint "app/(application)/memory" lib/demo && npx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: PASS; parity OK; clean; `0`.

- [ ] **Step 8: Commit**

```bash
git branch --show-current   # feat/memory-conflicts
git add "app/(application)/memory" messages/en.json messages/de.json lib/demo
git commit -m "feat(memory): conflict queries, i18n, demo resolvers and pure helpers"
```

---

### Task 7: The Conflicts page

**Files:**
- Create: `app/(application)/memory/[ctx]/conflicts/page.tsx`, `loading.tsx`, `components/conflicts-shell.tsx`, `components/conflict-card.tsx`, `components/merge-panel.tsx`

**Interfaces:**
- Consumes: Task 6 documents, helpers, i18n; `MemoryContext` + `NotFoundBase` (`../components/...` of `[ctx]`); `memoryTypeOptions` (`../components/memory-list-data`); `UserContext`.

- [ ] **Step 1: Server page and loading**

`page.tsx` mirrors `app/(application)/memory/[ctx]/page.tsx`: `guardRoute("memory")`, `fetchGraphQLServerSide(GET_MEMORY_BASE…, { id: ctx })`, `NotFoundBase` when missing, else `<ConflictsShell context={context} />`. `loading.tsx`: copy `app/(application)/memory/[ctx]/loading.tsx`.

- [ ] **Step 2: Shell**

`conflicts-shell.tsx` (client):

- `useQuery(GET_MEMORY_CONFLICTS, { variables: { contextId }, fetchPolicy: "cache-and-network" })`, `useQuery(GET_MEMORY_CONFLICT_COUNTS, …)`, `useMutation(SCAN_MEMORY_CONFLICTS)`, `useMutation(RESOLVE_MEMORY_CONFLICT)`; `const { user } = useContext(UserContext)`; `canScan = hasAgentsWrite(user)` where `hasAgentsWrite = (u) => !!u?.super_admin || u?.role?.agents === "write"` (local helper, mirrors the server).
- `PageHeader` breadcrumb `{ label: context.name, href: `/memory/${context.id}` }`, title `t("conflicts.title")`, description `counts.lastScanAt ? t("conflicts.lastScan", { when: <relative string> }) : t("conflicts.notScanned")` (use `new Date(lastScanAt).toLocaleString()` since `description` is a string), action: `<Button disabled={!canScan || scanning} onClick={runScan}>{scanning ? t("conflicts.scanning") : t("conflicts.find")}</Button>`.
- `runScan`: `await scan({ variables: { contextId } })` → toast `t(`conflicts.${scanToastKey(result)}`, { open, unjudged })` → refetch both queries; on error toast `conflicts.scanFailed` with the message.
- Invalid base (`context.memoryBase?.ok === false`): render the sub-project 2 warning `EmptyState` instead of the list.
- `skipped` local state (`Set<string>`) hides skipped cards for the visit.
- List: `groups.filter((g) => !skipped.has(g.id)).map((g) => <ConflictCard key={g.id} group={g} context={context} user={user} onSkip onResolved={() => { refetch both }} />)`; empty states per spec.

- [ ] **Step 3: Card**

`conflict-card.tsx`:

- Props `{ group, context, user, onSkip(), onResolved() }`. `const actions = canResolve(group, user)`; `resolve` mutation local; state `keepId`, `dismissOpen`, `mergeOpen`.
- Header: `<Badge>{t(`conflicts.${group.kind}`)}</Badge>`; title `group.kind === "duplicate" ? t("conflicts.duplicateTitle", { count }) : group.reason`; `t("conflicts.similarity", { percent: Math.round(group.similarity * 100) })`.
- Members: `grid gap-3 md:grid-cols-{min(members,3)}`: wording (`text-sm`), `memberLine(member, t("conflicts.unknown"))` + `<RelativeTime date={member.createdAt} />`, `t("conflicts.usedTimes", { count: member.usedCount })`, `<Button variant="outline" size="sm" disabled={!actions.keep} onClick={() => setKeepId(member.id)}>{t("conflicts.keepThis")}</Button>`.
- Footer: `<Button variant="ghost" disabled={!actions.dismiss} onClick={() => setDismissOpen(true)}>{group.kind === "duplicate" ? t("conflicts.notDuplicate") : t("conflicts.notConflict")}</Button>`, `<Button variant="ghost" onClick={onSkip}>{t("conflicts.skip")}</Button>`, `{group.kind === "duplicate" && <Button disabled={!actions.merge} onClick={() => setMergeOpen(true)}>{t("conflicts.merge")}</Button>}`; when `actions.blockedBy` show `<p className="text-xs text-muted-foreground">{t("conflicts.blocked", { author: actions.blockedBy })}</p>`.
- Dialogs: keep (`ConfirmDialog` variant default, title `conflicts.keepTitle`, description `conflicts.keepDescription` with `count = members.length - 1`, `onConfirm` → `resolve({ variables: { id, action: "KEEP", keepId } })` then `onResolved()`; rethrow on failure); dismiss (`conflicts.dismissTitle/Description`, action `NOT_CONFLICT`); merge → `<MergePanel open group context onMerged={onResolved} />`.

- [ ] **Step 4: Merge panel**

`merge-panel.tsx`:

- `SidePanel` titled `conflicts.mergeTitle`, description `conflicts.mergeHint`; on open run `useMutation(SUGGEST_MEMORY_MERGE)` once: on success set `information`/`type` from the suggestion; on failure set `information` to the first member's wording and `type` to `commonType(members)` and show `conflicts.suggestFailed`.
- Form: `<Textarea value={information} …>` labelled `conflicts.wording`; `<Select>` labelled `conflicts.type` with `memoryTypeOptions(context)` plus a `conflicts.noType` entry; line `t("conflicts.mergeCredits", { count: distinct authors })`; buttons Cancel / `conflicts.mergeAction` (disabled while the wording is empty or the request runs).
- Merge click opens a `ConfirmDialog` (`conflicts.mergeConfirmTitle/Description`) whose `onConfirm` runs `resolve({ variables: { id, action: "MERGE", merged: { information, type } } })`, toasts, closes the panel, calls `onMerged`; rejects to keep the dialog open on failure.

- [ ] **Step 5: Lint and typecheck**

Run: `npx eslint "app/(application)/memory" && npx tsc --noEmit 2>&1 | grep "app/(application)/memory" | head`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # feat/memory-conflicts
git add "app/(application)/memory"
git commit -m "feat(memory): /memory/[ctx]/conflicts page with scan, keep, merge and dismiss"
```

---

### Task 8: Base card, overflow item, workbench line, detail note

**Files:**
- Modify: `app/(application)/memory/[ctx]/components/base-shell.tsx`
- Modify: `app/(application)/memory/[ctx]/[id]/components/memory-detail.tsx`
- Modify: `app/(application)/agents/edit/[id]/queries.ts` (`GET_MEMORY_CONFLICT_COUNTS` copy, op `WorkbenchMemoryConflictCounts`), `app/(application)/agents/edit/[id]/components/memory-section.tsx`

- [ ] **Step 1: Base page**

`base-shell.tsx`: add `useQuery(GET_MEMORY_CONFLICT_COUNTS, { variables: { contextId: context.id }, skip: !valid })`; change the grid to `lg:grid-cols-5`; append:

```tsx
        <StatCard
          label={t("conflicts.card")}
          value={counts.error ? "—" : (counts.data?.memoryConflictCounts?.open ?? 0)}
          caption={counts.data?.memoryConflictCounts?.lastScanAt ? t("conflicts.cardCaption", { count: counts.data.memoryConflictCounts.memoriesInvolved }) : t("conflicts.notScanned")}
          loading={counts.loading && !counts.data}
          href={`/memory/${context.id}/conflicts`}
        />
```

(`StatCard` has an `href` prop.) Overflow menu: add `{ label: t("conflicts.find"), onSelect: () => router.push(`/memory/${context.id}/conflicts`) }` (navigates to the page; the scan button lives there).

- [ ] **Step 2: Detail page**

`memory-detail.tsx`: `useQuery(GET_MEMORY_CONFLICTS_FOR_MEMORY, { variables: { contextId: context.id, memoryId: itemId }, skip: !memory })` declared with the other hooks. After the Details `</dl>` (inside the same `DetailSection`):

```tsx
            {conflicts.data?.memoryConflictsForMemory?.open?.length ? (
              <p className="mt-3 text-sm">
                {t("conflicts.partOfOpen")} · <Link href={`/memory/${context.id}/conflicts`} className="underline">{t("conflicts.open")}</Link>
              </p>
            ) : null}
            {conflicts.data?.memoryConflictsForMemory?.mergedFrom?.length ? (
              <div className="mt-3 text-sm">
                <p>{t("conflicts.mergedFrom", { count: conflicts.data.memoryConflictsForMemory.mergedFrom.length })}</p>
                <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                  {conflicts.data.memoryConflictsForMemory.mergedFrom.map((m) => <li key={m.id}>{m.information}</li>)}
                </ul>
              </div>
            ) : null}
```

- [ ] **Step 3: Workbench**

`queries.ts` (agents edit): add `GET_MEMORY_CONFLICT_COUNTS = gql\`query WorkbenchMemoryConflictCounts($contextId: ID!) { memoryConflictCounts(contextId: $contextId) { open memoriesInvolved lastScanAt } }\``. In `memory-section.tsx`: `useQuery` for it (skip under the same condition as the usage query); in the Needs-attention column add a third `Link`: `href={`/memory/${contextId}/conflicts`}` with `t("editor.memory.conflictsLine")` and the `open` count (show "—" on error).

- [ ] **Step 4: Checks**

Run: `npx vitest run "app/(application)/memory" "app/(application)/agents/edit" lib/demo --maxWorkers 2 && npx eslint "app/(application)/memory" "app/(application)/agents/edit/[id]" && npx tsc --noEmit 2>&1 | grep -c "error TS" && npm run check-messages`
Expected: PASS; clean; `0`; parity OK.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # feat/memory-conflicts
git add "app/(application)/memory" "app/(application)/agents/edit/[id]"
git commit -m "feat(memory): Conflicts card and links on the base page, workbench and memory detail"
```

---

### Task 9: Frontend verification and UAT handoff

- [ ] **Step 1: Full checks, one at a time**

```bash
npx vitest run --maxWorkers 2 2>&1 | tail -5
npm run check-messages
npm run lint 2>&1 | tail -5
npx tsc --noEmit 2>&1 | grep -c "error TS"
npm run build 2>&1 | grep -E "Compiled|/memory|rror" | head
```
Expected: vitest green; parity OK; lint only the pre-existing `entity-types.tsx` error; tsc 0; build OK listing `/memory/[ctx]/conflicts`; `git status --short` clean.

- [ ] **Step 2: UAT list for Daniel**

1. Scan Newton's base twice: the second scan judges nothing new (toast reports 0 judged) and the groups stay identical.
2. Merge a near-duplicate group: the new public memory appears with the credited authors in its description, "Merged from N memories" on its page, usage counts carried over; the originals are archived.
3. Keep one of a contradiction: the other is archived, the group disappears.
4. Dismiss a false positive and rescan: it stays gone.
5. A non-admin builder sees disabled actions with the blocking author's name on groups containing others' memories; the server also rejects a forced call.
6. Base card "Conflicts N" and the workbench "Possible conflicts N" match the page.
7. Demo mode: the conflicts page renders the unscanned empty state; no console errors.

- [ ] **Step 3: Hand off**

Report test/lint/build results verbatim, the UAT list, and that nothing was pushed or merged.
