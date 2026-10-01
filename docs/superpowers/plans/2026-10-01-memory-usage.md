# Memory Usage Tracking (agent memory redesign, sub-project 3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every memory an agent is given for an answer and show the result: a Last used column and a Usage filter with an Archive bulk action on the base page, a Usage section on the memory detail page, a Never used card, and an Insights block on the agent workbench.

**Architecture:** One new core table `memory_usages`, written by a small fire-and-forget writer at the two answer-completion points in `src/exulu/routes.ts`. Four agents-read gated GraphQL queries derive counts, last-use, unused sets and insights from it; the only RBAC-scoped element is the conversation title on the detail page. The frontend extends the existing `/memory` feature and the workbench memory section with route-local queries, pure data modules with vitest tests, and no new routes.

**Tech Stack:** Backend TypeScript, knex/Postgres, generated GraphQL (`src/graphql/schemas/index.ts`), jest (`--maxWorkers=2`). Frontend Next.js app router, shadcn/ui, Apollo, next-intl (en/de), vitest (`--maxWorkers 2`), Turbopack build.

**Spec:** `docs/superpowers/specs/2026-10-01-memory-usage-design.md` (backend repo, branch `feat/memory-usage`).

**Worktrees:** backend `/Users/daniel.claessen/Desktop/Projects/exulu/backend-agent-memory` (branch `feat/memory-usage` from develop f2b7a69), frontend `/Users/daniel.claessen/Desktop/Projects/exulu/frontend-agent-memory` (branch `feat/memory-usage` from main ca828b6). Verify the branch in the same command as every commit.

## Global Constraints

- A "use" is a memory recalled into an answer: one row per recalled memory per answer, written for signed-in and guest sessions alike (`guest = true`, `user = null` for guests). No citation parsing.
- Idempotent writes: unique index on (`message_id`, `memory_id`), insert with `onConflict().ignore()`; a failed write logs once and never affects the answer.
- No columns on memory bases; the contract (`information`, `type`, optional `source_session`) is unchanged. Archiving reuses the item `archived` flag through the generated `<ctx>_itemsUpdateOneById` mutation.
- Read queries are gated by `hasAgentsReadAccess` (empty results otherwise). Counts and timestamps are unscoped; conversation titles only for sessions the viewer may read (`applyAccessControl` on `agent_sessions`); `mostUsed` wordings only for items the viewer may read (`applyAccessControl` on the items table), skipped otherwise. Usage rows never carry message content or memory wording.
- Every read query returns zeros / empty lists when the usage table or the items table does not exist (same `hasTable` guard as `memoryBaseStats`).
- Stale window: query argument `staleDays`, default 90. "Never used" = non-archived memory with no row; "stale" = used at least once, last use older than the window.
- Vocabulary (en/de): "used" / "verwendet", "never used" / "nie verwendet", "Not used in {days} days" / "Seit {days} Tagen nicht verwendet", "Used in {count} answers" / "In {count} Antworten verwendet", "Archive" / "Archivieren". i18n under `memory.usage.*` and `memory.bulk.archive*` (memory feature) and `agents.editor.memory.insights*` (workbench).
- Frontend feature isolation: the memory feature imports only from `app/(application)/memory/**`, `@/components/...`, `@/lib/...`, `@/app/(application)/authenticated`; the workbench keeps its own copy of the usage query in `app/(application)/agents/edit/[id]/queries.ts`. No chart library; the six bars are `div`s. No violet/purple.
- Process rules (after the 2026-09-30 lockup): foreground commands only, no `&`/`nohup`/watch modes/dev servers; jest `--maxWorkers=2`, vitest `--maxWorkers 2` (never `-w`); one build at a time; manual browser checks are listed for UAT. Pre-existing baselines: backend jest fails only `compact-session`, `email-inbound/intake`, `resolve-context-window`; backend tsc 8 errors; frontend tsc 0, `eslint .` has one pre-existing error in `app/(application)/data/components/entity-types.tsx`.

## Review Focus

1. The same answer finishing twice (stream retry, continuation): the second write must be a no-op — unique index + `ignore()` (Task 1 index, Task 2 writer test with a conflict-ignoring fake).
2. A guest answer with no session header: a row with `session = null`, `guest = true`, `user = null`, still counted (Task 2 test).
3. A memory used exactly `staleDays` ago: the boundary is "older than the cutoff" → stale when `lastUsedAt < cutoff`, not `<=` (Task 3 pure helper test).
4. A viewer who may not read a session a memory was used in: entry without `title`, no link, count unchanged (Task 3 scoping test; Task 7 renders plain text when `title` is null).
5. Archiving a memory the viewer may not write: the generated mutation rejects, the dialog lists it and keeps it selected, the others are archived and leave the counts (Task 6 reuses the Delete contract; UAT item 4).

---

## Backend

### Task 1: `memory_usages` core table and indexes

**Files:**
- Modify: `src/postgres/core-schema.ts` (new `memoryUsagesSchema`, registered in `coreSchemas.get()`)
- Modify: `src/postgres/core-schema.test.ts`
- Modify: `src/postgres/init-exulu-db.ts` (destructuring list ~line 22-43, `schemas` array ~line 118-141, raw indexes after the `job_results` index block)

**Interfaces:**
- Produces: table `memory_usages` with columns `id`, `createdAt`, `updatedAt`, `memory_id` uuid, `context` text, `agent` text, `session` text nullable, `message_id` text, `user` float nullable, `guest` boolean default false; unique index `memory_usages_message_memory_uidx (message_id, memory_id)`; indexes `memory_usages_context_memory_created_idx (context, memory_id, "createdAt")`, `memory_usages_context_created_idx (context, "createdAt")`.

- [ ] **Step 1: Write the failing test**

Append to `src/postgres/core-schema.test.ts`:

```ts
describe("memory_usages schema", () => {
  test("is registered with the usage columns and no RBAC", () => {
    const schema = coreSchemas.get().memoryUsagesSchema();
    expect(schema.name).toEqual({ plural: "memory_usages", singular: "memory_usage" });
    expect(schema.RBAC).toBeFalsy();
    const byName = Object.fromEntries(schema.fields.map((f) => [f.name, f]));
    expect(byName.memory_id).toMatchObject({ type: "uuid", required: true });
    expect(byName.context).toMatchObject({ type: "text", required: true });
    expect(byName.agent).toMatchObject({ type: "text", required: true });
    expect(byName.session).toMatchObject({ type: "text" });
    expect(byName.message_id).toMatchObject({ type: "text", required: true });
    expect(byName.user).toMatchObject({ type: "number" });
    expect(byName.guest).toMatchObject({ type: "boolean", default: false });
    // no RBAC → addCoreFields must not add rights_mode/created_by
    expect(byName.rights_mode).toBeUndefined();
    expect(byName.created_by).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/postgres/core-schema --maxWorkers=2`
Expected: FAIL — `memoryUsagesSchema is not a function`.

- [ ] **Step 3: Implement**

In `src/postgres/core-schema.ts`, after `promptFavoritesSchema`:

```ts
/**
 * Memory usage (agent memory redesign, sub-project 3a): one row per memory
 * recalled into an answer. Ids and timestamps only — never content. Counts
 * are derived by query; the unique (message_id, memory_id) index makes the
 * writer idempotent. Indexes are created in init-exulu-db.ts (the schema's
 * `index` flag is informational only).
 */
const memoryUsagesSchema: ExuluTableDefinition = {
  type: "memory_usages",
  name: {
    plural: "memory_usages",
    singular: "memory_usage",
  },
  fields: [
    { name: "memory_id", type: "uuid", required: true, index: true },
    { name: "context", type: "text", required: true, index: true },
    { name: "agent", type: "text", required: true },
    { name: "session", type: "text" },
    { name: "message_id", type: "text", required: true },
    { name: "user", type: "number" },
    { name: "guest", type: "boolean", default: false },
  ],
};
```

(If `ExuluTableDefinition.type` is a closed union that rejects `"memory_usages"`, add the literal to that union the way the other core tables are listed.)

In `coreSchemas.get()` add `memoryUsagesSchema: (): ExuluTableDefinition => addCoreFields(memoryUsagesSchema),` after `promptFavoritesSchema`.

In `src/postgres/init-exulu-db.ts`: add `memoryUsagesSchema,` to the destructuring from `coreSchemas.get()` and `memoryUsagesSchema(),` to the `schemas` array (after `promptFavoritesSchema()`). After the `job_results_session_waiting_idx` raw-index block add:

```ts
  // Memory usage (sub-project 3a): idempotent writes + the aggregate paths.
  if (await knex.schema.hasTable("memory_usages")) {
    await knex.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS memory_usages_message_memory_uidx
          ON memory_usages (message_id, memory_id)`,
    );
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS memory_usages_context_memory_created_idx
          ON memory_usages (context, memory_id, "createdAt")`,
    );
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS memory_usages_context_created_idx
          ON memory_usages (context, "createdAt")`,
    );
  }
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx jest src/postgres --maxWorkers=2 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: PASS; count 8.

- [ ] **Step 5: Commit**

```bash
git add src/postgres/core-schema.ts src/postgres/core-schema.test.ts src/postgres/init-exulu-db.ts
git commit -m "feat(memory): memory_usages core table with idempotency and aggregate indexes"
```

---

### Task 2: Usage writer and the two completion hooks

**Files:**
- Create: `src/exulu/memory/usage.ts`, `src/exulu/memory/usage.test.ts`
- Modify: `src/exulu/routes.ts` (stream `onFinish` ~line 873; sync path ~line 967)

**Interfaces:**
- Produces: `usageRows(input): UsageRow[]` (pure) and `recordMemoryUsage(input): Promise<number>` where `input = { db, recall: RecallCollector | undefined, contextId: string, agentId: string, session?: string | null, messageId: string, userId?: number | null }`.
- Consumes: `RecallCollector.list()` (`src/exulu/memory/recall-collector.ts`), `generateStream`/`generateSync` results carry `recall` (the collector).

- [ ] **Step 1: Write the failing test**

`src/exulu/memory/usage.test.ts`:

```ts
import { recordMemoryUsage, usageRows } from "./usage";

const recall: any = { list: () => [{ id: "m1" }, { id: "m2" }] };
const base = { recall, contextId: "mem", agentId: "ag1", session: "s1", messageId: "msg1", userId: 4 };

function fakeDb(opts: { throwOnInsert?: boolean } = {}) {
  const calls: any[] = [];
  const db: any = jest.fn((table: string) => ({
    insert: (rows: any[]) => {
      calls.push({ table, rows });
      return {
        onConflict: (cols: string[]) => {
          calls[calls.length - 1].onConflict = cols;
          return { ignore: async () => { if (opts.throwOnInsert) throw new Error("boom"); } };
        },
      };
    },
  }));
  db.__calls = calls;
  return db;
}

describe("usageRows", () => {
  it("builds one row per recalled memory, guest when there is no user", () => {
    expect(usageRows(base)).toEqual([
      { memory_id: "m1", context: "mem", agent: "ag1", session: "s1", message_id: "msg1", user: 4, guest: false },
      { memory_id: "m2", context: "mem", agent: "ag1", session: "s1", message_id: "msg1", user: 4, guest: false },
    ]);
    expect(usageRows({ ...base, session: undefined, userId: null })[0]).toMatchObject({ session: null, user: null, guest: true });
    expect(usageRows({ ...base, recall: undefined })).toEqual([]);
    expect(usageRows({ ...base, recall: { list: () => [] } as any })).toEqual([]);
  });
});

describe("recordMemoryUsage", () => {
  it("inserts the batch with conflict-ignore on (message_id, memory_id)", async () => {
    const db = fakeDb();
    expect(await recordMemoryUsage({ ...base, db })).toBe(2);
    expect(db.__calls).toEqual([{ table: "memory_usages", rows: usageRows(base), onConflict: ["message_id", "memory_id"] }]);
  });
  it("writes nothing without recalled memories", async () => {
    const db = fakeDb();
    expect(await recordMemoryUsage({ ...base, db, recall: undefined })).toBe(0);
    expect(db).not.toHaveBeenCalled();
  });
  it("swallows write errors with one console.error", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await recordMemoryUsage({ ...base, db: fakeDb({ throwOnInsert: true }) })).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/exulu/memory/usage --maxWorkers=2`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the writer**

`src/exulu/memory/usage.ts`:

```ts
import type { RecallCollector } from "./recall-collector";

/**
 * Memory usage tracking (sub-project 3a, spec §2.2): one row per memory
 * recalled into an answer — ids and timestamps only, never content.
 * Idempotent through the unique (message_id, memory_id) index; a failed
 * write is logged and never reaches the answer.
 */
export type UsageRow = {
  memory_id: string; context: string; agent: string;
  session: string | null; message_id: string; user: number | null; guest: boolean;
};

export type UsageWriteInput = {
  db: any;
  recall: RecallCollector | undefined;
  contextId: string;
  agentId: string;
  session?: string | null;
  messageId: string;
  userId?: number | null;
};

export function usageRows(input: Omit<UsageWriteInput, "db">): UsageRow[] {
  const memories = input.recall?.list() ?? [];
  const user = typeof input.userId === "number" ? input.userId : null;
  return memories.map((m) => ({
    memory_id: m.id,
    context: input.contextId,
    agent: input.agentId,
    session: input.session ?? null,
    message_id: input.messageId,
    user,
    guest: user === null,
  }));
}

export async function recordMemoryUsage(input: UsageWriteInput): Promise<number> {
  const rows = usageRows(input);
  if (rows.length === 0) return 0;
  try {
    await input.db("memory_usages").insert(rows).onConflict(["message_id", "memory_id"]).ignore();
    return rows.length;
  } catch (e) {
    console.error("[EXULU] memory usage write failed", e);
    return 0;
  }
}
```

- [ ] **Step 4: Hook the stream path**

In `src/exulu/routes.ts` import `recordMemoryUsage` from `./memory/usage.ts` (same style as the `recalled-metadata.ts` import). Inside `onFinish`, after the `if (headers.session && user?.id) { … }` block and before `const metadata = …`:

```ts
            // Usage tracking (memory usage spec §2.2): one row per recalled
            // memory per answer, guests included. Never affects the answer.
            if (agent.memory) {
              await recordMemoryUsage({
                db,
                recall: result.recall,
                contextId: agent.memory,
                agentId: agent.id,
                session: (headers.session as string | undefined) ?? null,
                messageId: responseMessage?.id ?? messages[messages.length - 1]?.id ?? "",
                userId: user?.id ?? null,
              });
            }
```

- [ ] **Step 5: Hook the non-streaming path (corrected 2026-10-01)**

`generateSync` (`src/exulu/generate-stream.ts`) returns plain text from both of its branches and never exposes the recall collector, so the route cannot record usage after the fact. Record it inside `generateSync` instead, in both text-returning branches after `generateText` and before the `return` (the collector, `agent`, `user`, `session` and `memoryDb` are in scope there; the branch's `generateText` result carries the model's `response.id`):

```ts
    if (agent.memory) {
      await recordMemoryUsage({
        db: memoryDb,
        recall: memoryRecall.collector,
        contextId: agent.memory,
        agentId: agent.id,
        session: session ?? null,
        messageId: result.response?.id ?? randomUUID(),
        userId: user?.id ?? null,
      });
    }
```

Import `recordMemoryUsage` from `./memory/usage` and `randomUUID` from `node:crypto` in generate-stream.ts. Nothing is added to the routes.ts sync branch. (The original plan text wrongly attributed `generateStream`'s `recall` return field to `generateSync`; the Task 2 review caught it — see the SDD ledger, Ruling 2.)

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx jest src/exulu/memory --maxWorkers=2 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: PASS; count 8.

- [ ] **Step 7: Commit**

```bash
git add src/exulu/memory/usage.ts src/exulu/memory/usage.test.ts src/exulu/routes.ts
git commit -m "feat(memory): record memory usage when an answer finishes (stream and sync paths)"
```

---

### Task 3: Usage read queries

**Files:**
- Create: `src/graphql/resolvers/memory-usage.ts`, `src/graphql/resolvers/memory-usage.test.ts`
- Modify: `src/graphql/schemas/index.ts` (import next to `memoryBaseContributors` ~line 80; Query typedefs next to `memoryBases` ~line 723-731; types after `type MemoryBase {…}` ~line 3001; resolvers next to `resolvers.Query["memoryBases"]` ~line 2631)

**Interfaces:**
- Consumes: `getTableName` (`@SRC/exulu/table-names`), `applyAccessControl` (`@SRC/graphql/utilities/access-control`), `convertContextToTableDefinition`, `coreSchemas.get().agentSessionsSchema()`, `displayName` (`@SRC/exulu/memory/recall-collector`), `creatorId` (`@SRC/exulu/memory/creator-id`), `hasAgentsReadAccess`.
- Produces (exported): `staleCutoff(now, days)`, `isStale(lastUsedAt, cutoff)`, `weekBuckets(dates, now)`, `memoryUsageByIds`, `memoryUsage`, `memoryBaseUsage`, `memoryBaseUnusedIds`; GraphQL per spec §3.

- [ ] **Step 1: Write the failing tests**

`src/graphql/resolvers/memory-usage.test.ts` — pure helpers first, then the db functions with a fake knex that records the call chain:

```ts
jest.mock("@SRC/graphql/utilities/access-control", () => ({ applyAccessControl: jest.fn((_t: unknown, q: any) => { q.__scoped = true; return q; }) }));
jest.mock("@SRC/exulu/table-names", () => ({ getTableName: (id: string) => `${id}_items` }));
jest.mock("@SRC/graphql/utilities/convert-context-to-table-definition", () => ({ convertContextToTableDefinition: (c: any) => ({ name: { singular: c.id, plural: `${c.id}s` } }) }));
jest.mock("@SRC/postgres/core-schema", () => ({ coreSchemas: { get: () => ({ agentSessionsSchema: () => ({ name: { singular: "agent_session", plural: "agent_sessions" } }) }) } }));

import { isStale, memoryBaseUnusedIds, memoryBaseUsage, memoryUsage, memoryUsageByIds, staleCutoff, weekBuckets } from "./memory-usage";

const NOW = new Date("2026-10-01T12:00:00.000Z");

describe("pure helpers", () => {
  it("staleCutoff subtracts whole days; isStale is strictly older than the cutoff", () => {
    const cutoff = staleCutoff(NOW, 90);
    expect(cutoff.toISOString()).toBe("2026-07-03T12:00:00.000Z");
    expect(isStale(new Date("2026-07-03T12:00:00.000Z"), cutoff)).toBe(false);
    expect(isStale(new Date("2026-07-03T11:59:59.000Z"), cutoff)).toBe(true);
    expect(isStale(null, cutoff)).toBe(false);
  });
  it("weekBuckets returns the last six ISO weeks oldest first, zero-filled", () => {
    const buckets = weekBuckets([new Date("2026-09-30T08:00:00Z"), new Date("2026-09-29T08:00:00Z"), new Date("2026-08-25T08:00:00Z"), new Date("2026-01-01T00:00:00Z")], NOW);
    expect(buckets).toHaveLength(6);
    expect(buckets[5]).toEqual({ weekStart: "2026-09-28", count: 2 });
    expect(buckets[0]).toEqual({ weekStart: "2026-08-24", count: 1 });
    expect(buckets.map((b) => b.count)).toEqual([1, 0, 0, 0, 0, 2]);
  });
});

/** A tiny knex stand-in: every builder method returns the same chain; terminal awaits resolve per table. */
function fakeDb(answers: Record<string, any[] | (() => any[])>, opts: { hasTable?: (t: string) => boolean } = {}) {
  const log: any[] = [];
  const make = (table: string) => {
    const rows = () => { const a = answers[table] ?? []; return typeof a === "function" ? a() : a; };
    const chain: any = { __table: table, __scoped: false };
    const methods = ["where", "whereIn", "whereNotIn", "whereNot", "whereNull", "groupBy", "orderBy", "limit", "select", "count", "countDistinct", "max", "min", "andWhere", "whereRaw", "distinct"];
    for (const m of methods) chain[m] = (...args: any[]) => { log.push([table, m, ...args]); return chain; };
    chain.then = (resolve: any, reject: any) => Promise.resolve(rows()).then(resolve, reject);
    // `.first()` answers from "<table>#first" when given, so a count query and a
    // row query on the same table can be stubbed separately.
    chain.first = async () => { const f = answers[`${table}#first`]; return (f ? (typeof f === "function" ? f() : f) : rows())[0]; };
    return chain;
  };
  const db: any = jest.fn((table: string) => make(table));
  db.schema = { hasTable: async (t: string) => (opts.hasTable ? opts.hasTable(t) : true) };
  db.raw = (s: string) => s;
  db.__log = log;
  return db;
}

const context = { id: "mem", name: "Memory" } as any;

describe("memoryUsageByIds", () => {
  it("groups by memory and maps count + last use; absent ids are omitted", async () => {
    const db = fakeDb({ memory_usages: [{ memory_id: "m1", c: "3", last: new Date("2026-09-30T08:00:00Z") }] });
    expect(await memoryUsageByIds({ db, contextId: "mem", ids: ["m1", "m2"] })).toEqual([{ memoryId: "m1", count: 3, lastUsedAt: "2026-09-30T08:00:00.000Z" }]);
    expect(db.__log).toContainEqual(["memory_usages", "whereIn", "memory_id", ["m1", "m2"]]);
  });
  it("returns [] when the usage table is missing or ids are empty", async () => {
    expect(await memoryUsageByIds({ db: fakeDb({}, { hasTable: () => false }), contextId: "mem", ids: ["m1"] })).toEqual([]);
    const db = fakeDb({});
    expect(await memoryUsageByIds({ db, contextId: "mem", ids: [] })).toEqual([]);
    expect(db).not.toHaveBeenCalled();
  });
});

describe("memoryUsage", () => {
  it("returns count, last use and recent entries with scoped titles, guest entries without a user", async () => {
    const db = fakeDb({
      "memory_usages#first": [{ c: "14", last: new Date("2026-09-30T08:00:00Z") }],
      memory_usages: [
        { session: "s1", message_id: "a", createdAt: new Date("2026-09-30T08:00:00Z"), agent: "ag1", user: 4, guest: false },
        { session: "s2", message_id: "b", createdAt: new Date("2026-09-29T08:00:00Z"), agent: "ag1", user: null, guest: true },
      ],
      agent_sessions: [{ id: "s1", title: "Display zeigt 0,2 m/s" }],
      agents: [{ id: "ag1", name: "Newton" }],
      users: [{ id: 4, firstname: "Daniel", lastname: "C." }],
    });
    const out = await memoryUsage({ db, contextId: "mem", memoryId: "m1", limit: 5, user: { id: 9 } as any });
    expect(out).toEqual({
      count: 14, lastUsedAt: "2026-09-30T08:00:00.000Z",
      recent: [
        { sessionId: "s1", messageId: "a", usedAt: "2026-09-30T08:00:00.000Z", agent: { id: "ag1", name: "Newton" }, user: { id: 4, name: "Daniel C." }, title: "Display zeigt 0,2 m/s" },
        { sessionId: "s2", messageId: "b", usedAt: "2026-09-29T08:00:00.000Z", agent: { id: "ag1", name: "Newton" }, user: null, title: null },
      ],
    });
    expect((require("@SRC/graphql/utilities/access-control") as any).applyAccessControl).toHaveBeenCalled();
  });
  it("is null-safe for a missing table", async () => {
    expect(await memoryUsage({ db: fakeDb({}, { hasTable: () => false }), contextId: "mem", memoryId: "m1", limit: 5, user: undefined })).toEqual({ count: 0, lastUsedAt: null, recent: [] });
  });
});

describe("memoryBaseUsage", () => {
  it("splits used / never / stale, ranks mostUsed by count then last use through the viewer's scope, buckets new items by week", async () => {
    const db = fakeDb({
      memory_usages: [
        { memory_id: "m1", c: "19", last: new Date("2026-09-30T08:00:00Z") },
        { memory_id: "m2", c: "6", last: new Date("2026-05-01T08:00:00Z") },
        { memory_id: "m3", c: "6", last: new Date("2026-09-01T08:00:00Z") },
      ],
      mem_items: () => [{ id: "m1", information: "A", createdAt: new Date("2026-09-30T08:00:00Z") }, { id: "m3", information: "C", createdAt: new Date("2026-09-29T08:00:00Z") }, { id: "m4", information: "D", createdAt: new Date("2026-01-01T00:00:00Z") }],
    });
    const out = await memoryBaseUsage({ db, context, user: { id: 9 } as any, staleDays: 90, now: NOW });
    expect(out.used).toBe(2);        // m1, m3 are non-archived & visible-independent counts: usage ids ∩ existing items (m2 was archived/deleted → not an item)
    expect(out.neverUsed).toBe(1);   // m4
    expect(out.stale).toBe(0);       // m2 is stale but no longer an item
    expect(out.mostUsed).toEqual([
      { id: "m1", information: "A", count: 19, lastUsedAt: "2026-09-30T08:00:00.000Z" },
      { id: "m3", information: "C", count: 6, lastUsedAt: "2026-09-01T08:00:00.000Z" },
    ]);
    expect(out.newPerWeek).toHaveLength(6);
    expect(out.newPerWeek[5]).toEqual({ weekStart: "2026-09-28", count: 2 });
    expect(db.__log.some((l: any[]) => l[0] === "mem_items" && l[1] === "whereNot" && l[2] === "archived")).toBe(true);
  });
  it("returns zeros when the items table or the usage table is missing", async () => {
    const zero = { used: 0, neverUsed: 0, stale: 0, mostUsed: [], newPerWeek: expect.any(Array) };
    expect(await memoryBaseUsage({ db: fakeDb({}, { hasTable: (t) => t !== "memory_usages" }), context, user: undefined, staleDays: 90, now: NOW })).toMatchObject(zero);
  });
});

describe("memoryBaseUnusedIds", () => {
  it("NEVER = items without usage; STALE = items whose last use is older than the cutoff", async () => {
    const db = fakeDb({
      memory_usages: [{ memory_id: "m1", last: new Date("2026-09-30T08:00:00Z") }, { memory_id: "m2", last: new Date("2026-05-01T08:00:00Z") }],
      mem_items: [{ id: "m1" }, { id: "m2" }, { id: "m4" }],
    });
    expect(await memoryBaseUnusedIds({ db, context, mode: "NEVER", staleDays: 90, now: NOW })).toEqual(["m4"]);
    expect(await memoryBaseUnusedIds({ db, context, mode: "STALE", staleDays: 90, now: NOW })).toEqual(["m2"]);
  });
});
```

The totals query ends in `.first()` and the recent-rows query is awaited directly, which is why the fake answers `"memory_usages#first"` and `memory_usages` separately.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/graphql/resolvers/memory-usage --maxWorkers=2`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/graphql/resolvers/memory-usage.ts`:

```ts
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "@SRC/exulu/context";
import { creatorId } from "@SRC/exulu/memory/creator-id";
import { displayName } from "@SRC/exulu/memory/recall-collector";
import { getTableName } from "@SRC/exulu/table-names";
import { coreSchemas } from "@SRC/postgres/core-schema";
import { applyAccessControl } from "@SRC/graphql/utilities/access-control";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";

const USAGE = "memory_usages";
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

export type UsageSummary = { memoryId: string; count: number; lastUsedAt: string | null };
export type UsageEntry = {
  sessionId: string | null; messageId: string; usedAt: string;
  agent: { id: string; name: string } | null; user: { id: number; name: string } | null; title: string | null;
};
export type MemoryUsageResult = { count: number; lastUsedAt: string | null; recent: UsageEntry[] };
export type WeekBucket = { weekStart: string; count: number };
export type BaseUsage = {
  used: number; neverUsed: number; stale: number;
  mostUsed: { id: string; information: string; count: number; lastUsedAt: string | null }[];
  newPerWeek: WeekBucket[];
};

const iso = (d: unknown): string | null => (d instanceof Date ? d.toISOString() : typeof d === "string" ? new Date(d).toISOString() : null);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0) || 0);

export function staleCutoff(now: Date, days: number): Date { return new Date(now.getTime() - days * DAY); }
export function isStale(lastUsedAt: Date | string | null | undefined, cutoff: Date): boolean {
  if (!lastUsedAt) return false;
  return new Date(lastUsedAt).getTime() < cutoff.getTime();
}

/** Monday 00:00 UTC of the ISO week containing `d`. */
function weekStart(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - day);
  return start;
}

export function weekBuckets(dates: (Date | string)[], now: Date, weeks = 6): WeekBucket[] {
  const current = weekStart(now);
  const starts = Array.from({ length: weeks }, (_, i) => new Date(current.getTime() - (weeks - 1 - i) * WEEK));
  const counts = new Map(starts.map((s) => [s.toISOString().slice(0, 10), 0]));
  for (const d of dates) {
    const key = weekStart(new Date(d)).toISOString().slice(0, 10);
    if (counts.has(key)) counts.set(key, counts.get(key)! + 1);
  }
  return starts.map((s) => { const key = s.toISOString().slice(0, 10); return { weekStart: key, count: counts.get(key)! }; });
}

async function hasTables(db: any, ...names: string[]): Promise<boolean> {
  for (const n of names) if (!(await db.schema.hasTable(n))) return false;
  return true;
}

/** Per-memory count + last use for the given ids (one grouped query). */
export async function memoryUsageByIds({ db, contextId, ids }: { db: any; contextId: string; ids: string[] }): Promise<UsageSummary[]> {
  if (ids.length === 0 || !(await hasTables(db, USAGE))) return [];
  const rows: any[] = await db(USAGE).where("context", contextId).whereIn("memory_id", ids).groupBy("memory_id").select("memory_id").count("id as c").max("createdAt as last");
  return rows.map((r) => ({ memoryId: r.memory_id, count: num(r.c), lastUsedAt: iso(r.last) }));
}

/** Count, last use and the recent conversations of one memory; titles only for sessions the viewer may read. */
export async function memoryUsage({ db, contextId, memoryId, limit, user }: { db: any; contextId: string; memoryId: string; limit: number; user: User | undefined }): Promise<MemoryUsageResult> {
  if (!(await hasTables(db, USAGE))) return { count: 0, lastUsedAt: null, recent: [] };
  const totals = await db(USAGE).where({ context: contextId, memory_id: memoryId }).count("id as c").max("createdAt as last").first();
  const recentRows: any[] = await db(USAGE).where({ context: contextId, memory_id: memoryId }).orderBy("createdAt", "desc").limit(Math.max(1, Math.min(limit, 20))).select("session", "message_id", "createdAt", "agent", "user", "guest");
  const sessionIds = [...new Set(recentRows.map((r) => r.session).filter(Boolean))];
  const agentIds = [...new Set(recentRows.map((r) => r.agent).filter(Boolean))];
  const userIds = [...new Set(recentRows.map((r) => creatorId(r.user)).filter((x): x is number => x !== null))];
  const titles = new Map<string, string | null>();
  if (sessionIds.length) {
    const sessions: any[] = await applyAccessControl(coreSchemas.get().agentSessionsSchema(), db("agent_sessions").whereIn("id", sessionIds), user).select("id", "title");
    for (const s of sessions) titles.set(s.id, s.title ?? "");
  }
  const agents = new Map<string, string>();
  if (agentIds.length) for (const a of await db("agents").whereIn("id", agentIds).select("id", "name")) agents.set(a.id, a.name);
  const users = new Map<number, string>();
  if (userIds.length) for (const u of await db("users").whereIn("id", userIds).select("id", "firstname", "lastname", "email")) users.set(Number(u.id), displayName(u));
  return {
    count: num(totals?.c),
    lastUsedAt: iso(totals?.last),
    recent: recentRows.map((r) => {
      const uid = creatorId(r.user);
      return {
        sessionId: r.session ?? null, messageId: r.message_id, usedAt: iso(r.createdAt) ?? "",
        agent: r.agent && agents.has(r.agent) ? { id: r.agent, name: agents.get(r.agent)! } : null,
        user: uid !== null && users.has(uid) ? { id: uid, name: users.get(uid)! } : null,
        title: r.session && titles.has(r.session) ? titles.get(r.session) ?? null : null,
      };
    }),
  };
}

type UsageAgg = { memory_id: string; c: number; last: Date | null };

async function usageByMemory(db: any, contextId: string): Promise<UsageAgg[]> {
  const rows: any[] = await db(USAGE).where("context", contextId).groupBy("memory_id").select("memory_id").count("id as c").max("createdAt as last");
  return rows.map((r) => ({ memory_id: r.memory_id, c: num(r.c), last: r.last ? new Date(r.last) : null }));
}

/** Base-level usage for the stat card, the Usage filter and the workbench Insights block. */
export async function memoryBaseUsage({ db, context, user, staleDays, now = new Date() }: { db: any; context: ExuluContext; user: User | undefined; staleDays: number; now?: Date }): Promise<BaseUsage> {
  const itemsTable = getTableName(context.id);
  const empty: BaseUsage = { used: 0, neverUsed: 0, stale: 0, mostUsed: [], newPerWeek: weekBuckets([], now) };
  if (!(await hasTables(db, itemsTable))) return empty;
  const items: any[] = await db(itemsTable).whereNot("archived", true).select("id", "createdAt");
  const newPerWeek = weekBuckets(items.map((i) => i.createdAt), now);
  if (!(await hasTables(db, USAGE))) return { ...empty, neverUsed: items.length, newPerWeek };
  const agg = await usageByMemory(db, context.id);
  const itemIds = new Set(items.map((i) => i.id));
  const live = agg.filter((a) => itemIds.has(a.memory_id));
  const cutoff = staleCutoff(now, staleDays);
  const used = live.length;
  const stale = live.filter((a) => isStale(a.last, cutoff)).length;
  const neverUsed = items.length - used;
  // mostUsed: top candidates by count then last use, then only the wordings the viewer may read.
  const candidates = [...live].sort((a, b) => b.c - a.c || (b.last?.getTime() ?? 0) - (a.last?.getTime() ?? 0)).slice(0, 10);
  let mostUsed: BaseUsage["mostUsed"] = [];
  if (candidates.length) {
    const table = convertContextToTableDefinition(context);
    const visible: any[] = await applyAccessControl(table, db(itemsTable).whereIn("id", candidates.map((c) => c.memory_id)).whereNot("archived", true), user).select("id", "information");
    const wording = new Map(visible.map((v) => [v.id, String(v.information ?? "")]));
    mostUsed = candidates.filter((c) => wording.has(c.memory_id)).slice(0, 5).map((c) => ({ id: c.memory_id, information: wording.get(c.memory_id)!, count: c.c, lastUsedAt: c.last ? c.last.toISOString() : null }));
  }
  return { used, neverUsed, stale, mostUsed, newPerWeek };
}

/** Ids of non-archived memories never used (NEVER) or last used before the cutoff (STALE). */
export async function memoryBaseUnusedIds({ db, context, mode, staleDays, now = new Date() }: { db: any; context: ExuluContext; mode: "NEVER" | "STALE"; staleDays: number; now?: Date }): Promise<string[]> {
  const itemsTable = getTableName(context.id);
  if (!(await hasTables(db, itemsTable))) return [];
  const items: any[] = await db(itemsTable).whereNot("archived", true).select("id");
  if (!(await hasTables(db, USAGE))) return mode === "NEVER" ? items.map((i) => i.id) : [];
  const agg = await usageByMemory(db, context.id);
  const last = new Map(agg.map((a) => [a.memory_id, a.last]));
  const cutoff = staleCutoff(now, staleDays);
  return items.map((i) => i.id).filter((id) => (mode === "NEVER" ? !last.has(id) : last.has(id) && isStale(last.get(id) ?? null, cutoff)));
}
```

In `src/graphql/schemas/index.ts`:

- import: `import { memoryBaseUnusedIds, memoryBaseUsage, memoryUsage, memoryUsageByIds } from "@SRC/graphql/resolvers/memory-usage";`
- Query typedefs (next to `memoryAgentCount`):

```ts
  typeDefs += `
    memoryUsageByIds(contextId: ID!, ids: [ID!]!): [MemoryUsageSummary!]!
    memoryUsage(contextId: ID!, memoryId: ID!, limit: Int = 5): MemoryUsage
    memoryBaseUsage(contextId: ID!, staleDays: Int = 90): MemoryBaseUsage
    memoryBaseUnusedIds(contextId: ID!, mode: MemoryUnusedMode!, staleDays: Int = 90): [ID!]!
    `;
```

- types after `type MemoryBase {…}`:

```graphql
type MemoryUsageSummary { memoryId: ID!  count: Int!  lastUsedAt: String }
type MemoryUsageEntry {
    sessionId: String
    messageId: String!
    usedAt: String!
    agent: MemoryBaseAgent
    user: MemoryBaseUser
    title: String
}
type MemoryUsage { count: Int!  lastUsedAt: String  recent: [MemoryUsageEntry!]! }
type MemoryWeekBucket { weekStart: String!  count: Int! }
type MemoryMostUsed { id: ID!  information: String!  count: Int!  lastUsedAt: String }
type MemoryBaseUsage {
    used: Int!
    neverUsed: Int!
    stale: Int!
    mostUsed: [MemoryMostUsed!]!
    newPerWeek: [MemoryWeekBucket!]!
}
enum MemoryUnusedMode { NEVER  STALE }
```

- resolvers (next to `resolvers.Query["memoryBases"]`):

```ts
  const memoryContextOf = (id: string) => contexts.find((c) => c.id === id);
  resolvers.Query["memoryUsageByIds"] = async (_, args, context) => {
    if (!hasAgentsReadAccess(context.user) || !memoryContextOf(args.contextId)) return [];
    return memoryUsageByIds({ db: context.db, contextId: args.contextId, ids: args.ids });
  };
  resolvers.Query["memoryUsage"] = async (_, args, context) => {
    if (!hasAgentsReadAccess(context.user) || !memoryContextOf(args.contextId)) return null;
    return memoryUsage({ db: context.db, contextId: args.contextId, memoryId: args.memoryId, limit: args.limit ?? 5, user: context.user });
  };
  resolvers.Query["memoryBaseUsage"] = async (_, args, context) => {
    const target = memoryContextOf(args.contextId);
    if (!hasAgentsReadAccess(context.user) || !target) return null;
    return memoryBaseUsage({ db: context.db, context: target, user: context.user, staleDays: args.staleDays ?? 90 });
  };
  resolvers.Query["memoryBaseUnusedIds"] = async (_, args, context) => {
    const target = memoryContextOf(args.contextId);
    if (!hasAgentsReadAccess(context.user) || !target) return [];
    return memoryBaseUnusedIds({ db: context.db, context: target, mode: args.mode, staleDays: args.staleDays ?? 90 });
  };
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx jest src/graphql/resolvers src/exulu/memory --maxWorkers=2 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: PASS; count 8.

- [ ] **Step 5: Commit**

```bash
git add src/graphql/resolvers/memory-usage.ts src/graphql/resolvers/memory-usage.test.ts src/graphql/schemas/index.ts
git commit -m "feat(memory): usage read queries (per ids, per memory with scoped titles, base aggregate, unused ids)"
```

---

### Task 4: Backend verification and docs

**Files:**
- Modify: `mintlify-docs/building/memory/overview.mdx` (new "## Usage" section), `mintlify-docs/building/agents/workbench.mdx` (one sentence on Insights)

- [ ] **Step 1: Verification**

```bash
npx jest --silent --maxWorkers=2 2>&1 | grep -E "^(Tests:|Test Suites:|FAIL)" | sort -u
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"
npm run build 2>&1 | tail -3
```
Expected: only the 3 pre-existing failing suites; tsc 8; build succeeds.

- [ ] **Step 2: Docs**

Append to `mintlify-docs/building/memory/overview.mdx` before "## A memory":

```mdx
## Usage

Every time an agent is given a memory for an answer, that use is recorded — the memory, the agent, the conversation and the time, never the content. A base's page shows how many memories were never used, the list has a **Last used** column and a **Usage** filter (never used, not used in 90 days), and selected memories can be **archived** in bulk: they leave recall and the counts, and can be restored in Knowledge. A memory's page lists its recent conversations; the link opens only conversations you may read. Guest chats count too, shown as "Guest".
```

Replace the end of the "## A memory" paragraph's last sentence so it reads "… an explicit write grant on the memory. Its **Usage** section shows how often it was given to an agent and the recent conversations."

In `mintlify-docs/building/agents/workbench.mdx`, after the sentence added in sub-project 2 ("Review the stored memories under Build → Memory."), add: "The **Insights** block shows the most used memories, how many were never used or not used in 90 days, and how many were saved per week."

Run `cd mintlify-docs && npx mint validate` if the CLI is available (the sub-project 2 implementer used `mint validate` and `mint broken-links`); otherwise skip and say so.

- [ ] **Step 3: Commit**

```bash
git add mintlify-docs
git commit -m "docs(memory): usage tracking in the Memory area and the workbench"
```

---

## Frontend

**Conventions the tasks rely on (verified 2026-10-01):** feature isolation lint (route-local documents; the workbench copies its own query); `Toolbar` renders the `filters` slot inline on desktop and in a bottom sheet on mobile (compact `Select`s, applied immediately); `ConfirmDialog.onConfirm` rejects to stay open and lists `errors: { item, message }[]`; `DataTable.error` is `{ message, onRetry } | null`; `StatCard.value` is `string | number`, `caption` a string; `DetailSection({ title, defaultOpen })`; `ChartCard({ title, description?, toolbar?, loading?, error?, children })` from `@/components/primitives/chart-card`; `RelativeTime({ date })`; the generated update mutation shape is `mutation UpdateOneById${ctx}($id: ID!, $input: ${ctx}_itemsInput!) { ${ctx}_itemsUpdateOneById(id: $id, input: $input) { item { id } job } }`; `buildMemoryFilters` in `app/(application)/memory/[ctx]/components/memory-list-data.ts`; `useMemoryItems` returns `{ items, pageInfo, contributors, loading, error, refetch }`; the workbench memory section is `app/(application)/agents/edit/[id]/components/memory-section.tsx` with a local `Stat` helper and `GET_MEMORY_BASE_STATS` in `app/(application)/agents/edit/[id]/queries.ts`; i18n namespaces `memory` and `agents.editor.memory`.

### Task 5: Scaffolding — queries, i18n, demo resolvers, pure modules

**Files:**
- Modify: `app/(application)/memory/queries.ts`, `app/(application)/memory/queries.test.ts`
- Modify: `messages/en.json`, `messages/de.json`
- Modify: `lib/demo/resolvers.ts`, `lib/demo/apollo-link.operations.test.ts`
- Create: `app/(application)/memory/[ctx]/components/usage-data.ts`, `usage-data.test.ts`
- Modify: `app/(application)/memory/[ctx]/components/memory-list-data.ts`, `memory-list-data.test.ts`

**Interfaces:**
- Produces: `GET_MEMORY_USAGE_BY_IDS`, `GET_MEMORY_USAGE`, `GET_MEMORY_BASE_USAGE`, `GET_MEMORY_BASE_UNUSED_IDS`, `UPDATE_MEMORY_ITEM(ctx)`; types `UsageSummary`, `BaseUsage`, `UsageEntry`; `usageLabel`, `unusedFilterToMode`, `weekBars`, `usageEntryLabel`; `MemoryListFilters.usage?: "never" | "stale"`; `buildMemoryFilters({ …, ids? })`.

- [ ] **Step 1: Write the failing tests**

Append to `app/(application)/memory/queries.test.ts`:

```ts
import { GET_MEMORY_BASE_UNUSED_IDS, GET_MEMORY_BASE_USAGE, GET_MEMORY_USAGE, GET_MEMORY_USAGE_BY_IDS, UPDATE_MEMORY_ITEM } from "./queries";

describe("usage documents", () => {
  it("name the usage operations and the generated update mutation", () => {
    expect(body(GET_MEMORY_USAGE_BY_IDS)).toContain("query MemoryUsageByIds");
    expect(body(GET_MEMORY_USAGE)).toContain("query MemoryUsage(");
    expect(body(GET_MEMORY_BASE_USAGE)).toContain("query MemoryBaseUsage");
    expect(body(GET_MEMORY_BASE_UNUSED_IDS)).toContain("query MemoryBaseUnusedIds");
    expect(body(UPDATE_MEMORY_ITEM("mem"))).toContain("mem_itemsUpdateOneById(");
  });
});
```

`app/(application)/memory/[ctx]/components/usage-data.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { unusedFilterToMode, usageEntryLabel, usageLabel, weekBars } from "./usage-data";

describe("usageLabel", () => {
  it("reports never-used and counts", () => {
    expect(usageLabel({ count: 0, lastUsedAt: null })).toEqual({ kind: "never" });
    expect(usageLabel({ count: 14, lastUsedAt: "2026-09-30T08:00:00.000Z" })).toEqual({ kind: "used", count: 14, lastUsedAt: "2026-09-30T08:00:00.000Z" });
    expect(usageLabel(undefined)).toEqual({ kind: "never" });
  });
});

describe("unusedFilterToMode", () => {
  it("maps the filter value to the query mode or null", () => {
    expect(unusedFilterToMode("never")).toBe("NEVER");
    expect(unusedFilterToMode("stale")).toBe("STALE");
    expect(unusedFilterToMode(undefined)).toBeNull();
    expect(unusedFilterToMode("")).toBeNull();
  });
});

describe("weekBars", () => {
  it("normalises heights to the max and labels by week start, flat bars when everything is zero", () => {
    expect(weekBars([{ weekStart: "2026-09-21", count: 2 }, { weekStart: "2026-09-28", count: 4 }])).toEqual([
      { weekStart: "2026-09-21", count: 2, height: 50, label: "21.09." },
      { weekStart: "2026-09-28", count: 4, height: 100, label: "28.09." },
    ]);
    expect(weekBars([{ weekStart: "2026-09-28", count: 0 }])[0].height).toBe(0);
  });
});

describe("usageEntryLabel", () => {
  it("joins agent and user, falls back to Guest and unknown", () => {
    expect(usageEntryLabel({ agent: { id: "a", name: "Newton" }, user: { id: 4, name: "Daniel C." } }, "Guest", "Unknown")).toBe("Newton · Daniel C.");
    expect(usageEntryLabel({ agent: null, user: null }, "Guest", "Unknown")).toBe("Unknown · Guest");
  });
});
```

Append to `memory-list-data.test.ts`:

```ts
  it("passes an ids restriction for the Usage filter and keeps the other filters", () => {
    expect(buildMemoryFilters({ search: "", mine: false, userId: 4, filters: { type: "FACT" }, ids: ["a", "b"] })).toEqual([
      { archived: { eq: false }, type: { eq: "FACT" }, id: { in: ["a", "b"] } },
    ]);
    expect(buildMemoryFilters({ search: "", mine: false, userId: 4, filters: {}, ids: undefined })).toEqual([{ archived: { eq: false } }]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run "app/(application)/memory" --maxWorkers 2`
Expected: FAIL — missing exports / modules.

- [ ] **Step 3: Queries**

Append to `app/(application)/memory/queries.ts`:

```ts
// ---- Usage tracking (sub-project 3a) --------------------------------------

export const GET_MEMORY_USAGE_BY_IDS = gql`
  query MemoryUsageByIds($contextId: ID!, $ids: [ID!]!) {
    memoryUsageByIds(contextId: $contextId, ids: $ids) { memoryId count lastUsedAt }
  }
`;

export const GET_MEMORY_USAGE = gql`
  query MemoryUsage($contextId: ID!, $memoryId: ID!, $limit: Int) {
    memoryUsage(contextId: $contextId, memoryId: $memoryId, limit: $limit) {
      count
      lastUsedAt
      recent { sessionId messageId usedAt agent { id name } user { id name } title }
    }
  }
`;

export const GET_MEMORY_BASE_USAGE = gql`
  query MemoryBaseUsage($contextId: ID!, $staleDays: Int) {
    memoryBaseUsage(contextId: $contextId, staleDays: $staleDays) {
      used
      neverUsed
      stale
      mostUsed { id information count lastUsedAt }
      newPerWeek { weekStart count }
    }
  }
`;

export const GET_MEMORY_BASE_UNUSED_IDS = gql`
  query MemoryBaseUnusedIds($contextId: ID!, $mode: MemoryUnusedMode!, $staleDays: Int) {
    memoryBaseUnusedIds(contextId: $contextId, mode: $mode, staleDays: $staleDays)
  }
`;

/** Same operation shape as knowledge's UPDATE_ITEM; used for the Archive bulk action. */
export const UPDATE_MEMORY_ITEM = (context: string) => gql`
  mutation UpdateMemory${context}($id: ID!, $input: ${context}_itemsInput!) {
    ${context}_itemsUpdateOneById(id: $id, input: $input) { item { id } job }
  }
`;
```

- [ ] **Step 4: Pure modules**

`usage-data.ts`:

```ts
/** Pure helpers for usage display (spec §4.4). */

export interface UsageSummary { memoryId?: string; count: number; lastUsedAt: string | null }
export interface UsageEntry {
  sessionId: string | null; messageId: string; usedAt: string;
  agent: { id: string; name: string } | null; user: { id: number; name: string } | null; title: string | null;
}
export interface BaseUsage {
  used: number; neverUsed: number; stale: number;
  mostUsed: { id: string; information: string; count: number; lastUsedAt: string | null }[];
  newPerWeek: { weekStart: string; count: number }[];
}

export type UsageLabel = { kind: "never" } | { kind: "used"; count: number; lastUsedAt: string | null };

export function usageLabel(summary: Pick<UsageSummary, "count" | "lastUsedAt"> | undefined): UsageLabel {
  if (!summary || summary.count <= 0) return { kind: "never" };
  return { kind: "used", count: summary.count, lastUsedAt: summary.lastUsedAt };
}

export function unusedFilterToMode(value: string | undefined): "NEVER" | "STALE" | null {
  if (value === "never") return "NEVER";
  if (value === "stale") return "STALE";
  return null;
}

export function weekBars(buckets: { weekStart: string; count: number }[]) {
  const max = Math.max(0, ...buckets.map((b) => b.count));
  return buckets.map((b) => {
    const [, m, d] = b.weekStart.split("-");
    return { ...b, height: max > 0 ? Math.round((b.count / max) * 100) : 0, label: `${d}.${m}.` };
  });
}

export function usageEntryLabel(entry: Pick<UsageEntry, "agent" | "user">, guestLabel: string, unknownLabel: string): string {
  return `${entry.agent?.name ?? unknownLabel} · ${entry.user?.name ?? guestLabel}`;
}
```

In `memory-list-data.ts`: add `usage?: string;` to `MemoryListFilters`; add `ids?: string[]` to `buildMemoryFilters`' args and, after the creator branch, `if (args.ids) f.id = { in: args.ids };`. `activeFilterCount` counts `usage` too (`["visibility", "type", "creator", "usage"]`) — update its existing test expectation accordingly if one asserts the list.

- [ ] **Step 5: i18n**

`messages/en.json`, inside `memory`:

```json
"usage": {
  "label": "Usage",
  "any": "Any",
  "never": "Never used",
  "stale": "Not used in {days} days",
  "neverUsedCard": "Never used",
  "neverUsedCaption": "candidates to archive",
  "lastUsed": "Last used",
  "neverShort": "Never",
  "usedTimes": "used {count}×",
  "section": "Usage",
  "usedInCount": "Used in {count, plural, one {# answer} other {# answers}}",
  "lastPrefix": "last",
  "neverUsedLong": "Never used",
  "openConversation": "Open conversation",
  "guest": "Guest",
  "unknownAgent": "Unknown agent",
  "loadFailed": "Usage could not be loaded."
}
```

and inside `memory.bulk`:

```json
"archive": "Archive",
"archiveTitle": "{count, plural, one {Archive # memory?} other {Archive # memories?}}",
"archiveDescription": "They leave recall and the counts; you can restore them in Knowledge.",
"archived": "{count, plural, one {# memory archived} other {# memories archived}}",
"archiveFailed": "{count, plural, one {# could not be archived} other {# could not be archived}}"
```

`messages/de.json`: `usage` → `"label": "Verwendung", "any": "Beliebig", "never": "Nie verwendet", "stale": "Seit {days} Tagen nicht verwendet", "neverUsedCard": "Nie verwendet", "neverUsedCaption": "Kandidaten fürs Archiv", "lastUsed": "Zuletzt verwendet", "neverShort": "Nie", "usedTimes": "{count}× verwendet", "section": "Verwendung", "usedInCount": "In {count, plural, one {# Antwort} other {# Antworten}} verwendet", "lastPrefix": "zuletzt", "neverUsedLong": "Nie verwendet", "openConversation": "Gespräch öffnen", "guest": "Gast", "unknownAgent": "Unbekannter Agent", "loadFailed": "Verwendung konnte nicht geladen werden."`; `bulk` → `"archive": "Archivieren", "archiveTitle": "{count, plural, one {# Erinnerung archivieren?} other {# Erinnerungen archivieren?}}", "archiveDescription": "Sie verlassen den Abruf und die Zählung; in Wissen lassen sie sich wiederherstellen.", "archived": "{count, plural, one {# Erinnerung archiviert} other {# Erinnerungen archiviert}}", "archiveFailed": "{count, plural, one {# konnte nicht archiviert werden} other {# konnten nicht archiviert werden}}"`.

Also under `agents.editor.memory` (both locales, Task 8 uses them): en `"insightsTitle": "Insights", "insightsHint": "What the memories are worth to {agent}.", "mostUsed": "Most used", "needsAttention": "Needs attention", "neverUsed": "Never used", "staleUsed": "Not used in 90 days", "newPerWeek": "New memories per week", "lastWeeks": "Last 6 weeks", "noUsageYet": "No answers have used memories yet."`; de `"insightsTitle": "Einblicke", "insightsHint": "Was die Erinnerungen {agent} bringen.", "mostUsed": "Am häufigsten verwendet", "needsAttention": "Braucht Aufmerksamkeit", "neverUsed": "Nie verwendet", "staleUsed": "Seit 90 Tagen nicht verwendet", "newPerWeek": "Neue Erinnerungen pro Woche", "lastWeeks": "Letzte 6 Wochen", "noUsageYet": "Noch keine Antwort hat Erinnerungen verwendet."`.

`npm run check-messages` must pass.

- [ ] **Step 6: Demo resolvers and the operations test**

In `lib/demo/resolvers.ts` after `MemoryBaseContributors`:

```ts
  MemoryUsageByIds: () => ({ memoryUsageByIds: [] }),
  MemoryUsage: () => ({ memoryUsage: { count: 0, lastUsedAt: null, recent: [] } }),
  MemoryBaseUsage: () => ({ memoryBaseUsage: { used: 0, neverUsed: 0, stale: 0, mostUsed: [], newPerWeek: [] } }),
  MemoryBaseUnusedIds: () => ({ memoryBaseUnusedIds: [] }),
```

In `lib/demo/apollo-link.operations.test.ts`, in the `/memory page operations` block, add one `it` per operation asserting the shape (list / object with `count` / object with `used` / list), importing the documents from `@/app/(application)/memory/queries` like the existing cases.

- [ ] **Step 7: Run the tests, parity and lint**

Run: `npx vitest run "app/(application)/memory" lib/demo --maxWorkers 2 && npm run check-messages && npx eslint "app/(application)/memory" lib/demo && npx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: PASS; parity OK; no lint errors; `0`.

- [ ] **Step 8: Commit**

```bash
git branch --show-current   # feat/memory-usage
git add "app/(application)/memory" messages/en.json messages/de.json lib/demo
git commit -m "feat(memory): usage queries, i18n, demo resolvers and pure usage helpers"
```

---

### Task 6: Base page — Never used card, Usage filter, Last used column, Archive bulk action

**Files:**
- Modify: `app/(application)/memory/[ctx]/page.tsx` (`usage` search param)
- Modify: `app/(application)/memory/[ctx]/components/use-memory-items.ts`
- Modify: `app/(application)/memory/[ctx]/components/memory-table.tsx`
- Modify: `app/(application)/memory/[ctx]/components/base-shell.tsx`

**Interfaces:**
- Consumes: Task 5 documents and helpers; `BaseShell({ context, initialMine, initialPage, initialUsage? })`; `MemoryTable({ context, initialMine, initialPage, initialUsage?, onChanged })`.
- Produces: `useMemoryItems` returns additionally `usage: Map<string, UsageSummary>` and `unusedLoading: boolean`.

- [ ] **Step 1: Page param**

`page.tsx`: extend `searchParams` with `usage?: string`; pass `initialUsage={sp.usage === "never" || sp.usage === "stale" ? sp.usage : undefined}` to `BaseShell`, which forwards it to `MemoryTable` as `initialUsage`.

- [ ] **Step 2: Hook**

In `use-memory-items.ts`:

```ts
import { GET_MEMORY_BASE_UNUSED_IDS, GET_MEMORY_USAGE_BY_IDS } from "../../queries";
import { type UsageSummary, unusedFilterToMode } from "./usage-data";
```

- Before building `filters`, resolve the Usage filter:

```ts
  const mode = unusedFilterToMode(args.filters.usage);
  const unused = useQuery<{ memoryBaseUnusedIds: string[] }>(GET_MEMORY_BASE_UNUSED_IDS, {
    skip: !mode,
    fetchPolicy: "cache-and-network",
    variables: { contextId: args.contextId, mode, staleDays: 90 },
  });
  const ids = mode ? unused.data?.memoryBaseUnusedIds : undefined;
```

- `buildMemoryFilters({ …, ids })`; skip the items query while `mode && !unused.data` (`skip: args.skip || (!!mode && !unused.data)`); when `mode` is set and `ids` is an empty array, skip the items query and return `items: []` with an empty `pageInfo` so the empty state renders without a request.
- After the items query, one usage lookup for the page:

```ts
  const itemIds = items.map((i) => i.id);
  const usage = useQuery<{ memoryUsageByIds: UsageSummary[] }>(GET_MEMORY_USAGE_BY_IDS, {
    skip: itemIds.length === 0,
    fetchPolicy: "cache-and-network",
    variables: { contextId: args.contextId, ids: itemIds },
  });
  const usageById = React.useMemo(() => new Map((usage.data?.memoryUsageByIds ?? []).map((u) => [u.memoryId, u])), [usage.data]);
```

- Return `{ …, usage: usageById, usageError: !!usage.error, unusedLoading: !!mode && unused.loading && !unused.data, refetch }` where `refetch` also refetches `unused` (when active) and `usage`.

- [ ] **Step 3: Table**

In `memory-table.tsx`:

- Props: `initialUsage?: "never" | "stale"`; initial `filters` state becomes `initialUsage ? { usage: initialUsage } : {}`.
- `fields` gains a fourth select: `{ id: "usage", label: t("usage.label"), placeholder: t("usage.any"), options: [{ value: "never", label: t("usage.never") }, { value: "stale", label: t("usage.stale", { days: 90 }) }] }`.
- `MemoryCell` gets `usage?: UsageSummary` and appends `t("usage.usedTimes", { count })` to the subtitle parts when `usageLabel(usage).kind === "used"`.
- Columns: after Saved add `{ id: "lastUsed", header: t("usage.lastUsed"), cell: ({ row }) => { const u = usageLabel(list.usage.get(row.original.id)); return u.kind === "used" && u.lastUsedAt ? <RelativeTime date={u.lastUsedAt} /> : <span className="text-muted-foreground">{list.usageError ? "—" : t("usage.neverShort")}</span>; } }` (deps add `list.usage`, `list.usageError`). Mobile card: add the last-used line.
- Archive: `const [updateItem] = useMutation(UPDATE_MEMORY_ITEM(context.id));`, state `archiveOpen`, `archiveErrors`; a `handleBulkArchive` that mirrors `handleBulkDelete` exactly (allSettled over `updateItem({ variables: { id, input: { archived: true } } })`, refetch + `onChanged()` regardless, failed ids stay selected, `errors` populated, `throw` on any failure, toasts `bulk.archived` / `bulk.archiveFailed`). Factor the shared loop into a local `runBulk(ids, fn)` helper returning `{ failedIds, failures, succeededCount }` so Delete and Archive do not duplicate it. `BulkActionBar` gets `{ label: t("bulk.archive"), onClick: () => { setArchiveErrors([]); setArchiveOpen(true); } }` between Set access and Delete. A second `ConfirmDialog` (`variant="default"`, `title={t("bulk.archiveTitle", { count })}`, `description={t("bulk.archiveDescription")}`, `confirmLabel={t("bulk.archive")}`, `errors={archiveErrors}`, `onConfirm={handleBulkArchive}`).
- Loading: while `list.unusedLoading`, pass `loading` to the table.

- [ ] **Step 4: Base shell**

`base-shell.tsx`: add `const usage = useQuery<{ memoryBaseUsage: BaseUsage | null }>(GET_MEMORY_BASE_USAGE, { variables: { contextId: context.id, staleDays: 90 }, fetchPolicy: "cache-and-network", skip: !valid });` and replace the fourth card:

```tsx
        <StatCard
          label={t("usage.neverUsedCard")}
          value={usage.data?.memoryBaseUsage?.neverUsed ?? 0}
          caption={t("usage.neverUsedCaption")}
          loading={usage.loading && !usage.data}
        />
```

Remove the now-unused `stats.usedBy` key from both locales if nothing else uses it (grep first). `onChanged` also refetches `usage`. Pass `initialUsage` through to `MemoryTable`.

- [ ] **Step 5: Lint and typecheck**

Run: `npx vitest run "app/(application)/memory" --maxWorkers 2 && npx eslint "app/(application)/memory" && npx tsc --noEmit 2>&1 | grep "app/(application)/memory" | head`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # feat/memory-usage
git add "app/(application)/memory" messages/en.json messages/de.json
git commit -m "feat(memory): Never used card, Usage filter, Last used column and Archive bulk action on the base page"
```

---

### Task 7: Detail page — Usage section

**Files:**
- Modify: `app/(application)/memory/[ctx]/[id]/components/memory-detail.tsx`

**Interfaces:**
- Consumes: `GET_MEMORY_USAGE`, `usageLabel`, `usageEntryLabel`, `UsageEntry` (Task 5).

- [ ] **Step 1: Implement**

Add `const usage = useQuery<{ memoryUsage: { count: number; lastUsedAt: string | null; recent: UsageEntry[] } | null }>(GET_MEMORY_USAGE, { variables: { contextId: context.id, memoryId: itemId, limit: 5 }, skip: !memory });` (declared with the other hooks, before any early return). In the right column after the Details section:

```tsx
          <DetailSection title={t("usage.section")} defaultOpen>
            {usage.loading && !usage.data ? (
              <Skeleton className="h-16 w-full" />
            ) : usage.error ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                {t("usage.loadFailed")}
                <Button variant="link" size="sm" className="h-auto p-0" onClick={() => { void usage.refetch(); }}>{tc("retry")}</Button>
              </div>
            ) : (() => {
              const data = usage.data?.memoryUsage ?? { count: 0, lastUsedAt: null, recent: [] };
              const label = usageLabel(data);
              if (label.kind === "never") return <p className="text-sm text-muted-foreground">{t("usage.neverUsedLong")}</p>;
              return (
                <div className="flex flex-col gap-2 text-sm">
                  <p>
                    {t("usage.usedInCount", { count: label.count })}
                    {label.lastUsedAt && <> · {t("usage.lastPrefix")} <RelativeTime date={label.lastUsedAt} /></>}
                  </p>
                  <ul className="flex flex-col gap-1">
                    {data.recent.map((e) => (
                      <li key={e.messageId} className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                        <span>{usageEntryLabel(e, t("usage.guest"), t("usage.unknownAgent"))}</span>
                        <RelativeTime date={e.usedAt} />
                        {e.title !== null && e.sessionId && e.agent && (
                          <Link href={`/chat/${e.agent.id}/${e.sessionId}`} className="underline">{e.title || t("usage.openConversation")}</Link>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
          </DetailSection>
```

`RelativeTime` is a component, so the sentence is rendered as two nodes (count text, then "last" + the relative time) using the `usage.usedInCount` and `usage.lastPrefix` keys from Task 5. `tc("retry")` exists in `common`; add `const tc = useTranslations("common");` next to `t`.

- [ ] **Step 2: Lint and typecheck**

Run: `npx eslint "app/(application)/memory" && npx tsc --noEmit 2>&1 | grep "app/(application)/memory" | head && npm run check-messages`
Expected: clean; parity OK.

- [ ] **Step 3: Commit**

```bash
git branch --show-current   # feat/memory-usage
git add "app/(application)/memory" messages/en.json messages/de.json
git commit -m "feat(memory): Usage section on the memory detail page"
```

---

### Task 8: Workbench — Insights block

**Files:**
- Modify: `app/(application)/agents/edit/[id]/queries.ts` (`GET_MEMORY_BASE_USAGE` copy)
- Modify: `app/(application)/agents/edit/[id]/components/memory-section-data.ts`, `memory-section-data.test.ts` (`weekBars` copy — feature isolation forbids importing the memory feature's helper; keep both tiny)
- Modify: `app/(application)/agents/edit/[id]/components/memory-section.tsx`

**Interfaces:**
- Consumes: backend `memoryBaseUsage` (Task 3); i18n `agents.editor.memory.insights*` (Task 5).

- [ ] **Step 1: Write the failing test**

Append to `memory-section-data.test.ts`:

```ts
import { weekBars } from "./memory-section-data";

describe("weekBars", () => {
  it("normalises heights to the max and labels day.month.", () => {
    expect(weekBars([{ weekStart: "2026-09-21", count: 1 }, { weekStart: "2026-09-28", count: 4 }])).toEqual([
      { weekStart: "2026-09-21", count: 1, height: 25, label: "21.09." },
      { weekStart: "2026-09-28", count: 4, height: 100, label: "28.09." },
    ]);
  });
});
```

(Use the file's existing import style — vitest globals or explicit `import { describe, expect, it } from "vitest"` — whichever the file already uses.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "app/(application)/agents/edit" --maxWorkers 2`
Expected: FAIL — `weekBars` not exported.

- [ ] **Step 3: Implement**

`memory-section-data.ts`: export the same `weekBars` as Task 5 (copy, with a one-line comment naming the memory feature's twin).

`queries.ts` (agents edit): add

```ts
export const GET_MEMORY_BASE_USAGE = gql`
  query WorkbenchMemoryBaseUsage($contextId: ID!, $staleDays: Int) {
    memoryBaseUsage(contextId: $contextId, staleDays: $staleDays) {
      used
      neverUsed
      stale
      mostUsed { id information count lastUsedAt }
      newPerWeek { weekStart count }
    }
  }
`;
```

Add `WorkbenchMemoryBaseUsage: () => ({ memoryBaseUsage: { used: 0, neverUsed: 0, stale: 0, mostUsed: [], newPerWeek: [] } }),` to `lib/demo/resolvers.ts` and one case to the operations test.

`memory-section.tsx`: next to the stats query add

```ts
  const { data: usageData, loading: usageLoading } = useQuery<{ memoryBaseUsage: BaseUsage | null }>(GET_MEMORY_BASE_USAGE, {
    variables: { contextId, staleDays: 90 },
    skip: !memoryOn || !!invalid,
    fetchPolicy: "cache-and-network",
  });
```

(declare a local `type BaseUsage` matching the query's shape). After the `{stats && (…)}` grid render:

```tsx
      {!invalid && (
        <ChartCard title={t("editor.memory.insightsTitle")} description={t("editor.memory.insightsHint", { agent: agentName })} loading={usageLoading && !usageData}>
          {(() => {
            const u = usageData?.memoryBaseUsage;
            if (!u || (u.used === 0 && u.neverUsed === 0)) return <p className="text-sm text-muted-foreground">{t("editor.memory.noUsageYet")}</p>;
            const bars = weekBars(u.newPerWeek);
            return (
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">{t("editor.memory.mostUsed")}</p>
                  {u.mostUsed.slice(0, 3).map((m) => (
                    <Link key={m.id} href={`/memory/${contextId}/${m.id}`} className="block truncate text-sm underline-offset-2 hover:underline">
                      {m.information} <span className="text-muted-foreground">{m.count}×</span>
                    </Link>
                  ))}
                  {u.mostUsed.length === 0 && <p className="text-sm text-muted-foreground">—</p>}
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">{t("editor.memory.needsAttention")}</p>
                  <Link href={`/memory/${contextId}?usage=never`} className="block text-sm hover:underline">{t("editor.memory.neverUsed")} <span className="text-muted-foreground">{u.neverUsed}</span></Link>
                  <Link href={`/memory/${contextId}?usage=stale`} className="block text-sm hover:underline">{t("editor.memory.staleUsed")} <span className="text-muted-foreground">{u.stale}</span></Link>
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">{t("editor.memory.newPerWeek")}</p>
                  <div className="flex h-16 items-end gap-1" role="img" aria-label={t("editor.memory.newPerWeek")}>
                    {bars.map((b) => (
                      <div key={b.weekStart} className="flex flex-1 flex-col items-center gap-1">
                        <div className="w-full rounded-sm bg-primary/70" style={{ height: `${Math.max(b.height, 4)}%` }} title={`${b.label} · ${b.count}`} />
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">{t("editor.memory.lastWeeks")}</p>
                </div>
              </div>
            );
          })()}
        </ChartCard>
      )}
```

Import `ChartCard` from `@/components/primitives/chart-card`, `Link` from `next/link` (already imported), `weekBars` from `./memory-section-data`, `GET_MEMORY_BASE_USAGE` from `../queries`.

- [ ] **Step 4: Run the tests, lint and typecheck**

Run: `npx vitest run "app/(application)/agents/edit" lib/demo --maxWorkers 2 && npx eslint "app/(application)/agents/edit/[id]" lib/demo && npx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: PASS; clean; `0`.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # feat/memory-usage
git add "app/(application)/agents/edit/[id]" lib/demo
git commit -m "feat(agents): memory Insights block on the workbench (most used, needs attention, new per week)"
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
Expected: vitest green; parity OK; lint only the pre-existing `entity-types.tsx` error; tsc 0; build OK with the three `/memory` routes; `git status --short` clean.

- [ ] **Step 2: UAT list for Daniel (implementers do not start servers)**

1. Chat with Newton twice so memories are recalled; the base page's Last used column and the detail page's Usage section show the two conversations with links.
2. A second user with agents read sees the counts on the detail page but no link for the first user's private chat.
3. Usage filter "Never used" lists only memories without a row; "Not used in 90 days" lists stale ones; the Never used card matches the filter's count.
4. Select two never-used memories → Archive: both leave the list, recall and the counts; archiving one the viewer may not write keeps the dialog open with that item listed.
5. Workbench Insights: most used links open the memory, Needs attention links open the base page with the filter preset, the bars show the last six weeks.
6. Guest chat on a public agent with memory: the count rises and the entry reads "Guest" without a link.
7. Demo mode: `/memory/<ctx>` and the workbench render the empty usage state, no console errors.

- [ ] **Step 3: Hand off**

Report test/lint/build results verbatim, the UAT list, and that nothing was pushed or merged.
