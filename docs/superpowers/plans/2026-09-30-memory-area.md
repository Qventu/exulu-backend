# Memory Area (agent memory redesign, sub-project 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give builders and curators a Memory area under Build: a bases overview, a per-base memory list with a stats strip, and a memory detail page, built as memory-specific views over the knowledge workspace's existing item queries and mutations.

**Architecture:** Backend adds one optional contract field (`source_session`), makes `memoryBaseStats` count all memories (plus a viewer-scoped `visible`), and adds one aggregate `memoryBases` query. Frontend adds a `/memory` feature folder with route-local GraphQL documents (the lint rules ban cross-feature imports), three pages on the shared primitives (page header, toolbar, stat card, data table, filter panel, bulk action bar, detail section, side panel, confirm dialog, bulk access dialog), and pure data modules with tests. No new tables, no new mutations.

**Tech Stack:** Backend TypeScript, knex/Postgres, generated GraphQL (`src/graphql/schemas/index.ts`), jest (`--maxWorkers=2`). Frontend Next.js app router, shadcn/ui, Apollo, next-intl (en/de), vitest (`--maxWorkers 2`), Turbopack build.

**Spec:** `docs/superpowers/specs/2026-09-30-memory-area-design.md` (backend repo, branch `feat/memory-area`).

**Worktrees:** backend `/Users/daniel.claessen/Desktop/Projects/exulu/backend-agent-memory`, frontend `/Users/daniel.claessen/Desktop/Projects/exulu/frontend-agent-memory`, both on `feat/memory-area`. Newton's context lives in `/Users/daniel.claessen/Desktop/Projects/newlkiag` (branch `develop`). Verify the branch before every commit.

## Global Constraints

- No new tables and no new mutations; every write reuses `<ctx>_itemsUpdateOneById`, `<ctx>_itemsBulkUpdateRBAC`, `<ctx>_itemsRemoveOneById` with their existing RBAC checks.
- Counts may include private memories; content never crosses item RBAC. The list, the detail and the source quote come from RBAC-scoped queries only.
- Access to the area: `requires: { area: "agents", level: "read" }` (same as Knowledge); `memoryBases` and `memoryBaseStats` are gated with `hasAgentsReadAccess`.
- Contract: `source_session` (`text`) is OPTIONAL; `checkMemoryBase` is unchanged; the remember tool writes it only when the base defines it and a session id is present.
- Search filters the memory wording only (`information: { contains }`); the generated filter input cannot OR across fields.
- Vocabulary: Memory base / Gedächtnis-Basis, memories / Erinnerungen, Private / Privat, Public / Öffentlich, Delete / Löschen. i18n namespace `memory` (new top-level) in `messages/en.json` and `messages/de.json`; `navigation.memory` = "Memory" / "Gedächtnis". No violet/purple.
- Process limits (after the 2026-09-30 lockup): foreground commands only, no `&`/`nohup`/`xargs -P`/watch modes/dev servers; jest `--maxWorkers=2`, vitest `--maxWorkers 2` (never `-w`); one build at a time; manual browser checks are skipped and listed for UAT.
- Conventional commits; one commit per task at minimum.

## Review Focus

1. An agent references a memory context id that no longer exists in code: the overview must list it greyed as "not found in code" and never throw or omit the agent (test in Task 3).
2. A viewer with agents read but no access to another user's private memory: the per-base stats count it, the list and the detail never reveal it (`visible` test in Task 2; the list and detail only ever read RBAC-scoped item queries, so the row is absent and the detail renders "not available" — UAT item 6 in Task 9).
3. A base without the optional `source_session` field: the memory item query must not request the field (Task 5's query builder test, Task 7's `hasSourceSession` test) and the detail renders "No conversation recorded" from the missing value (Task 8's `sourceQuote` null cases cover an unreadable or empty session).
4. Search input of only whitespace or characters like `%`, `_`, `{`: the filter must be omitted for whitespace and passed verbatim otherwise (Task 7 test) — the server does not escape `contains`; `buildMemoryFilters` escapes `\`, `%` and `_`.
5. Bulk delete where one selected item is not writable by the viewer: the existing dialog's error list must show which failed and keep the others (reused behaviour, UAT item in Task 9).

---

## Backend

### Task 1: Optional `source_session` in the contract and the remember tool (+ Newton)

**Files:**
- Modify: `src/exulu/memory/memory-base.ts` (add `memoryBaseHasSourceSession`, doc comment)
- Modify: `src/exulu/memory/memory-base.test.ts`
- Modify: `src/exulu/memory/tools.ts` (`memory_remember` execute, the `createItem` call)
- Modify: `src/exulu/memory/tools.test.ts`
- Modify (newlkiag repo): `/Users/daniel.claessen/Desktop/Projects/newlkiag/src/contexts/contexts.ts` (Newton memory fields)

**Interfaces:**
- Produces: `memoryBaseHasSourceSession(context): boolean`; the created memory item carries `source_session` when the base defines it.

- [ ] **Step 1: Write the failing tests**

Append to `src/exulu/memory/memory-base.test.ts`:

```ts
import { memoryBaseHasSourceSession } from "./memory-base";

describe("memoryBaseHasSourceSession", () => {
  it("is true only for a text field named source_session", () => {
    expect(memoryBaseHasSourceSession({ fields: [{ name: "source_session", type: "text" }] } as any)).toBe(true);
    expect(memoryBaseHasSourceSession({ fields: [{ name: "source_session", type: "longText" }] } as any)).toBe(true);
    expect(memoryBaseHasSourceSession({ fields: [{ name: "source_session", type: "uuid" }] } as any)).toBe(false);
    expect(memoryBaseHasSourceSession({ fields: [{ name: "information", type: "text" }] } as any)).toBe(false);
    expect(memoryBaseHasSourceSession(undefined)).toBe(false);
  });
});
```

Append to `src/exulu/memory/tools.test.ts` inside `describe("memory_remember")` (the file's fixtures `context`, `agent`, `me`, `base`, `createItem`, `tools()` already exist):

```ts
  it("writes source_session when the base defines the field and a session id is present", async () => {
    const withSource: any = { ...context, fields: [...context.fields, { name: "source_session", type: "text" }] };
    const t = Object.fromEntries(createMemoryTools({ agent, context: withSource, user: me }).map((x) => [x.id, x]));
    await t.memory_remember.tool.execute!({ ...base, user: me, exuluConfig: {}, sessionID: "sess-1" } as any, {} as any);
    expect(createItem.mock.calls[0][0]).toMatchObject({ source_session: "sess-1" });
  });

  it("omits source_session when the base does not define it, or when no session id is present", async () => {
    await tools().memory_remember.tool.execute!({ ...base, user: me, exuluConfig: {}, sessionID: "sess-1" } as any, {} as any);
    expect(createItem.mock.calls[0][0]).not.toHaveProperty("source_session");
    createItem.mockClear();
    const withSource: any = { ...context, fields: [...context.fields, { name: "source_session", type: "text" }] };
    const t = Object.fromEntries(createMemoryTools({ agent, context: withSource, user: me }).map((x) => [x.id, x]));
    await t.memory_remember.tool.execute!({ ...base, user: me, exuluConfig: {} } as any, {} as any);
    expect(createItem.mock.calls[0][0]).not.toHaveProperty("source_session");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/memory/memory-base src/exulu/memory/tools --maxWorkers=2`
Expected: FAIL — `memoryBaseHasSourceSession` is not exported; `source_session` not written.

- [ ] **Step 3: Implement**

In `src/exulu/memory/memory-base.ts` add:

```ts
/**
 * Optional contract field (sub-project 2): a `source_session` text field lets the
 * remember tool record the chat session a memory was saved from, so the Memory
 * area can link to the conversation. Bases without it simply have no link.
 */
export function memoryBaseHasSourceSession(context: ContextLike): boolean {
  const field = context?.fields?.find((f) => f.name === "source_session");
  return !!field && TEXT_TYPES.has(field.type);
}
```

In `src/exulu/memory/tools.ts`, `memory_remember` execute: read `const sessionID = typeof params.sessionID === "string" && params.sessionID ? params.sessionID : undefined;` next to the other param reads, and change the `createItem` payload to:

```ts
          {
            name: title, information, ...(type ? { type } : {}),
            description: String(params.whySaved ?? ""),
            ...(rights_mode ? { rights_mode } : {}),
            ...(sessionID && memoryBaseHasSourceSession(context) ? { source_session: sessionID } : {}),
          },
```

Import `memoryBaseHasSourceSession` from `./memory-base`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx jest src/exulu/memory --maxWorkers=2 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: PASS; tsc count 8 (pre-existing: 2 each in `src/exulu/auth/flow.ts`, `src/exulu/auth/validate.ts`, `src/exulu/openai-transformer.ts`, `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`).

- [ ] **Step 5: Newton's context (newlkiag)**

In `/Users/daniel.claessen/Desktop/Projects/newlkiag/src/contexts/contexts.ts`, in `newtonMemory.fields` after the `type` field, add:

```ts
        {
            name: "source_session",
            type: "text"
        }
```

Run `git -C /Users/daniel.claessen/Desktop/Projects/newlkiag branch --show-current` (must print `develop`), then commit there: `git -c commit.gpgsign=false commit -am "feat(memory): record the source session on Newton memories"`. The column is added by init-db on the next boot of that app.

- [ ] **Step 6: Commit (backend)**

```bash
git add src/exulu/memory/memory-base.ts src/exulu/memory/memory-base.test.ts src/exulu/memory/tools.ts src/exulu/memory/tools.test.ts
git commit -m "feat(memory): optional source_session contract field, written by the remember tool"
```

---

### Task 2: `memoryBaseStats` counts all memories and adds `visible`

**Files:**
- Modify: `src/graphql/resolvers/memory-base-stats.ts`
- Modify: `src/graphql/resolvers/memory-base-stats.test.ts`
- Modify: `src/graphql/schemas/index.ts` (`type MemoryBaseStats` gains `visible: Int!`)

**Interfaces:**
- Produces: `MemoryBaseStats = { total, public, private, contributors, lastSavedAt, lastSavedBy, visible }` where `total/public/private/contributors/lastSaved*` are over ALL non-archived rows and `visible` is RBAC-scoped to the viewer.

- [ ] **Step 1: Update the tests**

Replace the `fakeDb` helper and the two existing tests in `src/graphql/resolvers/memory-base-stats.test.ts` so the fake distinguishes scoped from unscoped queries. The mocked `applyAccessControl` tags the builder:

```ts
jest.mock("@SRC/graphql/utilities/access-control", () => ({
  applyAccessControl: jest.fn((_t: unknown, q: any) => { q.__scoped = true; return q; }),
}));

import { memoryBaseStats } from "./memory-base-stats";

type Answers = { total: number; pub: number; priv: number; contributors: number; visible: number; last?: any; user?: any; hasTable?: boolean; throwOnCount?: boolean };

function fakeDb(a: Answers) {
  const make = () => {
    let mode: "count" | "public" | "private" = "count";
    const q: any = {
      __scoped: false,
      whereNot: () => q,
      where: (col: string, val: string) => { if (col === "rights_mode") mode = val as any; return q; },
      count: async () => {
        if (a.throwOnCount) throw new Error("boom");
        if (q.__scoped) return [{ c: a.visible }];
        return [{ c: mode === "public" ? a.pub : mode === "private" ? a.priv : a.total }];
      },
      countDistinct: async () => [{ c: a.contributors }],
      orderBy: () => q, select: () => q,
      first: async () => a.last,
      whereIn: () => ({ select: async () => (a.user ? [a.user] : []) }),
    };
    return q;
  };
  const db: any = jest.fn(() => make());
  db.schema = { hasTable: async () => a.hasTable ?? true };
  return db;
}

const context = { id: "mem", name: "Memory", fields: [] } as any;

describe("memoryBaseStats", () => {
  it("counts all rows for totals and the viewer's rows for visible", async () => {
    const db = fakeDb({ total: 47, pub: 31, priv: 16, contributors: 9, visible: 33, last: { createdAt: new Date("2026-09-29T10:00:00Z"), created_by: 9 }, user: { id: 9, firstname: "Sara", lastname: "Kraus" } });
    expect(await memoryBaseStats({ context, user: { id: 4 } as any, db })).toEqual({
      total: 47, public: 31, private: 16, contributors: 9, visible: 33,
      lastSavedAt: "2026-09-29T10:00:00.000Z", lastSavedBy: { id: 9, name: "Sara Kraus" },
    });
  });
  it("returns zeros for an empty base, a missing table, or a failing query", async () => {
    const zero = { total: 0, public: 0, private: 0, contributors: 0, visible: 0, lastSavedAt: null, lastSavedBy: null };
    expect(await memoryBaseStats({ context, user: undefined, db: fakeDb({ total: 0, pub: 0, priv: 0, contributors: 0, visible: 0 }) })).toEqual(zero);
    expect(await memoryBaseStats({ context, user: undefined, db: fakeDb({ total: 5, pub: 5, priv: 0, contributors: 1, visible: 5, hasTable: false }) })).toEqual(zero);
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await memoryBaseStats({ context, user: undefined, db: fakeDb({ total: 5, pub: 5, priv: 0, contributors: 1, visible: 5, throwOnCount: true }) })).toEqual(zero);
    expect(spy).toHaveBeenCalledTimes(1); spy.mockRestore();
  });
  it("leaves lastSavedBy null when created_by is null or the user row is gone", async () => {
    const a = { total: 1, pub: 1, priv: 0, contributors: 1, visible: 1 };
    expect((await memoryBaseStats({ context, user: undefined, db: fakeDb({ ...a, last: { createdAt: "2026-09-01T00:00:00.000Z", created_by: null } }) })).lastSavedBy).toBeNull();
    expect((await memoryBaseStats({ context, user: undefined, db: fakeDb({ ...a, last: { createdAt: "2026-09-01T00:00:00.000Z", created_by: 9 } }) })).lastSavedBy).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/graphql/resolvers/memory-base-stats --maxWorkers=2`
Expected: FAIL — `visible` missing; totals are scoped.

- [ ] **Step 3: Implement**

In `memory-base-stats.ts`: add `visible: number` to the type and `visible: 0` to `EMPTY`; inside the try block build two query factories:

```ts
    const all = () => db(tableName).whereNot("archived", true);
    const scoped = () => applyAccessControl(table, db(tableName).whereNot("archived", true), user);
    const [totalRow] = await all().count("id as c");
    const [publicRow] = await all().where("rights_mode", "public").count("id as c");
    const [privateRow] = await all().where("rights_mode", "private").count("id as c");
    const [contribRow] = await all().countDistinct("created_by as c");
    const last = await all().orderBy("createdAt", "desc").select("createdAt", "created_by").first();
    const [visibleRow] = await scoped().count("id as c");
```

and return `visible: num(visibleRow?.c)`. Update the doc comment: totals are over all rows (counts only; the query is gated on agents read by its resolver), `visible` is the viewer's.

In `src/graphql/schemas/index.ts`, `type MemoryBaseStats` gains `visible: Int!` after `contributors: Int!`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx jest src/graphql/resolvers --maxWorkers=2 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: PASS; count 8.

- [ ] **Step 5: Commit**

```bash
git add src/graphql/resolvers/memory-base-stats.ts src/graphql/resolvers/memory-base-stats.test.ts src/graphql/schemas/index.ts
git commit -m "feat(memory): memoryBaseStats counts every memory and reports the viewer's visible count"
```

---

### Task 3: `memoryBases` aggregate query

**Files:**
- Create: `src/graphql/resolvers/memory-bases.ts`
- Create: `src/graphql/resolvers/memory-bases.test.ts`
- Modify: `src/graphql/schemas/index.ts` (typeDefs `MemoryBaseAgent`, `MemoryBase`, `Query.memoryBases`; resolver registration next to `memoryBaseStats`)

**Interfaces:**
- Consumes: `checkMemoryBase` (memory-base.ts), `memoryBaseStats` (Task 2), `hasAgentsReadAccess`.
- Produces: `listMemoryBases({ contexts, user, db }): Promise<MemoryBaseRow[]>` with `MemoryBaseRow = { id, name, description, valid, missing, missingFromCode, agents: { id, name }[], stats: MemoryBaseStats | null }`.

- [ ] **Step 1: Write the failing test**

`src/graphql/resolvers/memory-bases.test.ts`:

```ts
jest.mock("./memory-base-stats", () => ({
  memoryBaseStats: jest.fn(async ({ context }: any) => ({ total: context.id === "mem_a" ? 47 : 3, public: 1, private: 1, contributors: 2, visible: 1, lastSavedAt: null, lastSavedBy: null })),
}));
import { listMemoryBases } from "./memory-bases";

const valid = (id: string, name: string) => ({ id, name, description: `${name} desc`, fields: [{ name: "information", type: "text" }, { name: "type", type: "enum", enumValues: ["FACT"] }] }) as any;
const invalid = { id: "docs", name: "Docs", fields: [{ name: "body", type: "text" }] } as any;
const db = (agents: any[]) => jest.fn(() => ({ select: async () => agents }));

describe("listMemoryBases", () => {
  it("groups agents per base, includes valid unused bases and invalid ones an agent points at, and orders them", async () => {
    const rows = await listMemoryBases({
      contexts: [invalid, valid("mem_b", "Beta"), valid("mem_a", "Alpha")],
      user: { id: 1 } as any,
      db: db([{ id: "ag1", name: "Alfredinio", memory: "mem_a" }, { id: "ag2", name: "Bot", memory: "mem_a" }, { id: "ag3", name: "Docs-Bot", memory: "docs" }, { id: "ag4", name: "Lost", memory: "gone" }, { id: "ag5", name: "NoMem", memory: null }]),
    });
    expect(rows.map((r) => r.id)).toEqual(["mem_a", "mem_b", "docs", "gone"]);
    expect(rows[0]).toMatchObject({ valid: true, missingFromCode: false, agents: [{ id: "ag1", name: "Alfredinio" }, { id: "ag2", name: "Bot" }], stats: { total: 47 } });
    expect(rows[1]).toMatchObject({ valid: true, agents: [], stats: { total: 3 } });
    expect(rows[2]).toMatchObject({ valid: false, missing: ["information", "type"], agents: [{ id: "ag3", name: "Docs-Bot" }], stats: { total: 3 } });
    expect(rows[3]).toEqual({ id: "gone", name: "gone", description: null, valid: false, missing: ["information", "type"], missingFromCode: true, agents: [{ id: "ag4", name: "Lost" }], stats: null });
  });

  it("does not list invalid contexts nobody uses", async () => {
    const rows = await listMemoryBases({ contexts: [invalid, valid("mem_a", "Alpha")], user: { id: 1 } as any, db: db([]) });
    expect(rows.map((r) => r.id)).toEqual(["mem_a"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/graphql/resolvers/memory-bases --maxWorkers=2`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/graphql/resolvers/memory-bases.ts`:

```ts
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "@SRC/exulu/context";
import { checkMemoryBase } from "@SRC/exulu/memory/memory-base";
import { memoryBaseStats, type MemoryBaseStats } from "./memory-base-stats";

export type MemoryBaseRow = {
  id: string; name: string; description: string | null;
  valid: boolean; missing: string[]; missingFromCode: boolean;
  agents: { id: string; name: string }[];
  stats: MemoryBaseStats | null;
};

type AgentRow = { id: string; name: string; memory: string | null };

/** Spec §2.3: valid bases (in use first), then valid unused, then invalid ones an agent uses, then ids missing from code. */
export async function listMemoryBases({ contexts, user, db }: { contexts: ExuluContext[]; user: User | undefined; db: any }): Promise<MemoryBaseRow[]> {
  const agents: AgentRow[] = await db("agents").select("id", "name", "memory");
  const byBase = new Map<string, { id: string; name: string }[]>();
  for (const a of agents) {
    if (!a.memory) continue;
    const list = byBase.get(a.memory) ?? [];
    list.push({ id: a.id, name: a.name });
    byBase.set(a.memory, list);
  }
  const rows: MemoryBaseRow[] = [];
  for (const context of contexts) {
    const check = checkMemoryBase(context);
    const used = byBase.get(context.id) ?? [];
    if (!check.ok && used.length === 0) continue;
    rows.push({
      id: context.id, name: context.name, description: context.description ?? null,
      valid: check.ok, missing: check.missing, missingFromCode: false, agents: used,
      stats: await memoryBaseStats({ context, user, db }),
    });
    byBase.delete(context.id);
  }
  for (const [id, used] of byBase) {
    rows.push({ id, name: id, description: null, valid: false, missing: ["information", "type"], missingFromCode: true, agents: used, stats: null });
  }
  const rank = (r: MemoryBaseRow) => (r.missingFromCode ? 3 : !r.valid ? 2 : r.agents.length > 0 ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
```

In `src/graphql/schemas/index.ts`: import `listMemoryBases`; add to the Query typeDefs next to `memoryBaseStats`:

```ts
  typeDefs += `
    memoryBases: [MemoryBase!]!
    `;
```

add after `type MemoryBaseStats { … }`:

```graphql
type MemoryBaseAgent {
    id: ID!
    name: String!
}
type MemoryBase {
    id: ID!
    name: String!
    description: String
    valid: Boolean!
    missing: [String!]!
    missingFromCode: Boolean!
    agents: [MemoryBaseAgent!]!
    stats: MemoryBaseStats
}
```

and register next to `resolvers.Query["memoryBaseStats"]`:

```ts
  resolvers.Query["memoryBases"] = async (_, _args, context) => {
    if (!hasAgentsReadAccess(context.user)) return [];
    return listMemoryBases({ contexts, user: context.user, db: context.db });
  };
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx jest src/graphql/resolvers src/exulu/memory --maxWorkers=2 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: PASS; count 8.

- [ ] **Step 5: Commit**

```bash
git add src/graphql/resolvers/memory-bases.ts src/graphql/resolvers/memory-bases.test.ts src/graphql/schemas/index.ts
git commit -m "feat(memory): memoryBases aggregate query with agents and stats per base"
```

---

### Task 4: Backend verification and docs

**Files:**
- Create: `mintlify-docs/building/memory/overview.mdx`
- Modify: `mintlify-docs/user-guide/chat/memory.mdx` (add a "Reviewing memories" paragraph), `mintlify-docs/building/agents/workbench.mdx` (one sentence linking the Memory area), `mintlify-docs/docs.json` (add the page to the Building navigation next to Knowledge; look at how `building/knowledge/overview` is registered and mirror it)

- [ ] **Step 1: Verification**

```bash
npx jest --silent --maxWorkers=2 2>&1 | tail -6
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"
npm run build 2>&1 | tail -3
```
Expected: only the 3 pre-existing failing suites (`compact-session`, `email-inbound/intake`, `resolve-context-window`); tsc 8; build succeeds.

- [ ] **Step 2: Docs**

`mintlify-docs/building/memory/overview.mdx`:

```mdx
---
title: "Memory area"
description: "See every memory base, what each agent has learned, and one memory in full."
icon: "bookmark"
---

import { RightsCallout } from "/snippets/rights-callout.mdx";

<RightsCallout right="agents (read)" />

Open **Memory** in the Build section. The overview lists every memory base — a knowledge base with an `information` field and a `type` field — with the agents that use it, how many memories it holds, how many people contributed, and when it was last saved to.

Counts include private memories. Their content stays visible only to the people who saved them: the list on a base's page shows what you may see ("8 of 33 visible to you").

A base greyed out with "not configured correctly" is missing a required field; a base marked "not found in code" is referenced by an agent but no longer exists in the deployment.

## A memory base

Click a base to see its memories with search, a Mine filter, and filters for visibility, type and creator. Select rows to change access or delete in bulk — the same dialogs as in Knowledge. "Open in Knowledge" reaches the generic item tools.

## A memory

Each memory shows its wording, why it was saved, the source conversation when the base records it (an optional `source_session` field), who saved it and when, and who can see it. **Make private** and **Delete** are available to the creator, admins, and people with write access.
```

In `memory.mdx` (user guide) append under "Seeing what was used":

```mdx
Builders and curators review everything an agent has learned under **Build → Memory**: every memory base, its memories, and each memory in full. See [Memory area](/building/memory/overview).
```

In `workbench.mdx`, at the end of the **Long-term memory** paragraph, add: `Review the stored memories under **Build → Memory**.`

- [ ] **Step 3: Commit**

```bash
git add mintlify-docs
git commit -m "docs(memory): the Memory area"
```

---

## Frontend

All frontend tasks run in `/Users/daniel.claessen/Desktop/Projects/exulu/frontend-agent-memory` on `feat/memory-area`. The backend from Tasks 1–3 must be built for manual checks, but no dev server is started by implementers; UAT is Daniel's.

**Frontend conventions the tasks rely on (verified 2026-09-30):**
- Features may not import other features' folders (`eslint.config.mjs` feature isolation) nor `@/queries/queries`; every GraphQL document the memory feature uses is copied into `app/(application)/memory/queries.ts`.
- `guardRoute("<nav id>")` from `@/lib/route-guard` gates server pages by the nav entry's `requires`; server pages never call `getTranslations` (copy lives in client components).
- Every item table has `rights_mode` (string), `created_by` (number), `archived` (boolean) plus the context fields, so `Filter<Ctx>_items` accepts `rights_mode: { eq }`, `created_by: { eq }`, `information: { contains }`, `type: { eq }`; filter objects in one array element are ANDed.
- `UserContext` (`@/app/(application)/authenticated`) exposes `{ user }` with `id: number`, `super_admin?: boolean`. RBAC subject ids are strings; compare with `String(a) === String(b)`.
- Chat message rows carry `content` as a JSON string of the UI message (`{ role, parts: [{ type: "text", text }] }`; older rows `{ role, content }`).
- The knowledge item detail link is `/data/<ctx>/items/<id>`; a chat session link is `/chat/<agentId>/<sessionId>`.
- Icon: the spec names `Brain`, but Knowledge already uses `Brain`; the Memory entry uses `Bookmark` (the icon the chat's memory panel already uses), so the two Build entries stay distinguishable.

### Task 5: Feature scaffolding — nav entry, i18n, demo resolvers, route-local queries, FilterPanel `select`/`entity` field types

**Files:**
- Modify: `components/shell/nav-config.ts` (entry after `knowledge`), `components/shell/nav-config.test.ts`
- Modify: `messages/en.json`, `messages/de.json` (`navigation.memory`, new top-level `memory`)
- Modify: `lib/demo/resolvers.ts` (`MemoryBases`, `MemoryAgentCount`)
- Modify: `components/primitives/filter-panel.tsx` (two new field types)
- Create: `app/(application)/memory/queries.ts`, `app/(application)/memory/queries.test.ts`

**Interfaces:**
- Produces: nav id `memory`; i18n namespace `memory` (keys below); `GET_MEMORY_BASES`, `GET_AGENT_COUNT`, `GET_MEMORY_BASE`, `GET_MEMORY_ITEMS(ctx)`, `MEMORY_ITEMS_KEY(ctx)`, `GET_MEMORY_ITEM_BY_ID(ctx)`, `MEMORY_ITEM_KEY(ctx)`, `DELETE_MEMORY_ITEM(ctx)`, `BULK_UPDATE_MEMORY_RBAC(ctx)`, `GET_USERS_BY_IDS`, `SEARCH_USERS`, `GET_SOURCE_SESSION`, `GET_SOURCE_MESSAGES`; `FilterFieldDef.type` gains `"select"` (with `options`) and `"entity"` (with `fetchOptions`, `resolveLabel`).

- [ ] **Step 1: Write the failing tests**

`app/(application)/memory/queries.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { GET_MEMORY_ITEMS, GET_MEMORY_ITEM_BY_ID, MEMORY_ITEMS_KEY, MEMORY_ITEM_KEY, memoryItemFields } from "./queries";

const body = (doc: { loc?: { source: { body: string } } }) => doc.loc?.source.body ?? "";

describe("memory item queries", () => {
  it("request the memory fields and the source session only when the base defines it", () => {
    expect(memoryItemFields(false)).toEqual(["information", "type", "created_by"]);
    expect(memoryItemFields(true)).toEqual(["information", "type", "created_by", "source_session"]);
    expect(body(GET_MEMORY_ITEMS("newton_memory_context", false))).not.toContain("source_session");
    expect(body(GET_MEMORY_ITEM_BY_ID("newton_memory_context", true))).toContain("source_session");
  });
  it("use the generated per-context operations", () => {
    expect(body(GET_MEMORY_ITEMS("mem", false))).toContain("mem_itemsPagination(");
    expect(body(GET_MEMORY_ITEMS("mem", false))).toContain("[FilterMem_items]");
    expect(body(GET_MEMORY_ITEM_BY_ID("mem", false))).toContain("mem_itemsById(");
    expect(MEMORY_ITEMS_KEY("mem")).toBe("mem_itemsPagination");
    expect(MEMORY_ITEM_KEY("mem")).toBe("mem_itemsById");
  });
});
```

In `components/shell/nav-config.test.ts` add `"memory",` on the line after each `"knowledge",` (four places: the table-order list, the `agents: "read"` list, the `agents: "write"` list, the build-group list).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run components/shell/nav-config.test.ts "app/(application)/memory" --maxWorkers 2`
Expected: FAIL — nav lists differ; `./queries` not found.

- [ ] **Step 3: Nav entry**

In `components/shell/nav-config.ts` add `Bookmark` to the `lucide-react` import and insert after the `knowledge` entry:

```ts
  {
    id: "memory",
    group: "build",
    route: "/memory",
    i18nKey: "navigation.memory",
    icon: Bookmark,
    requires: { area: "agents", level: "read" },
    aliases: ["/memory/*"],
  },
```

- [ ] **Step 4: i18n**

`messages/en.json`: add `"memory": "Memory"` inside `navigation` (alphabetical position) and a new top-level namespace:

```json
"memory": {
  "title": "Memory",
  "description": "What your agents have learned in conversations. One memory base can serve several agents.",
  "countsNote": "Counts include private memories; their content stays visible only to the people who saved them.",
  "stats": {
    "bases": "Memory bases",
    "agents": "Agents with memory",
    "agentsOf": "of {count}",
    "memories": "Memories",
    "memoriesSplit": "{public} public · {private} private",
    "contributors": "Contributors",
    "lastSaved": "Last saved",
    "lastSavedBy": "by {name}",
    "never": "Never",
    "usedBy": "Used by"
  },
  "filter": {
    "all": "All",
    "inUse": "In use",
    "unused": "Unused",
    "mine": "Mine",
    "searchBases": "Search bases and agents",
    "searchMemories": "Search memories",
    "visibility": "Visibility",
    "type": "Type",
    "creator": "Creator",
    "creatorPlaceholder": "Any creator",
    "creatorSearch": "Search by email",
    "creatorEmpty": "No users found",
    "any": "Any",
    "apply": "Apply"
  },
  "columns": {
    "base": "Memory base",
    "usedBy": "Used by",
    "memories": "Memories",
    "contributors": "Contributors",
    "lastSaved": "Last saved",
    "memory": "Memory",
    "visibility": "Visibility",
    "saved": "Saved"
  },
  "base": {
    "createdWith": "created with {agent}",
    "notUsed": "Not used by any agent",
    "assign": "Assign",
    "invalid": "Not configured correctly for memory, must include the fields: {fields}",
    "missingFromCode": "Not found in code",
    "moreAgents": "+{count}",
    "usedByOne": "Used by {agent}",
    "usedByMore": "Used by {agent} +{count}",
    "openInKnowledge": "Open in Knowledge",
    "visibleFooter": "{visible} of {total} visible to you",
    "noList": "Memories cannot be shown until the base is configured correctly."
  },
  "empty": {
    "basesTitle": "No memory bases yet",
    "basesDescription": "Define a knowledge context with an information and a type field to give agents long-term memory.",
    "basesAction": "Read the docs",
    "memoriesTitle": "No memories yet",
    "memoriesDescription": "Agents save them when people say “remember that …”.",
    "notAvailableTitle": "This memory isn't available to you",
    "notAvailableDescription": "It is private to the person who saved it, or it was deleted.",
    "back": "Back to the memory base"
  },
  "visibility": {
    "public": "Public",
    "private": "Private",
    "users": "Users",
    "roles": "Roles",
    "teams": "Teams"
  },
  "detail": {
    "breadcrumb": "Memory",
    "whySaved": "Why it was saved",
    "notRecorded": "Not recorded",
    "source": "Source conversation",
    "noSource": "No conversation recorded",
    "openConversation": "Open conversation",
    "details": "Details",
    "whoCanSee": "Who can see it",
    "change": "Change",
    "createdBy": "Created by",
    "created": "Created",
    "updated": "Updated",
    "editWording": "Edit wording",
    "makePrivate": "Make private",
    "makePrivateTitle": "Make this memory private?",
    "makePrivateDescription": "Only you and admins will see it. Agents will no longer recall it for other people.",
    "madePrivate": "The memory is now private",
    "delete": "Delete",
    "deleteTitle": "Delete this memory?",
    "deleteDescription": "The agent will no longer recall it. This cannot be undone.",
    "deleted": "Memory deleted",
    "accessTitle": "Who can see this memory",
    "accessSubject": "memory",
    "accessSaved": "Access updated",
    "unknownUser": "Unknown user",
    "failed": "That didn't work. Please try again."
  },
  "bulk": {
    "setAccess": "Set access",
    "delete": "Delete",
    "deleteTitle": "Delete {count} memories?",
    "deleteDescription": "Agents will no longer recall them. This cannot be undone.",
    "deleted": "{count} memories deleted",
    "deleteFailed": "{count} could not be deleted"
  }
}
```

`messages/de.json`: `"memory": "Gedächtnis"` in `navigation` and:

```json
"memory": {
  "title": "Gedächtnis",
  "description": "Was deine Agenten in Gesprächen gelernt haben. Eine Gedächtnis-Basis kann mehrere Agenten versorgen.",
  "countsNote": "Die Zahlen enthalten private Erinnerungen; deren Inhalt sehen nur die Personen, die sie gespeichert haben.",
  "stats": {
    "bases": "Gedächtnis-Basen",
    "agents": "Agenten mit Gedächtnis",
    "agentsOf": "von {count}",
    "memories": "Erinnerungen",
    "memoriesSplit": "{public} öffentlich · {private} privat",
    "contributors": "Beitragende",
    "lastSaved": "Zuletzt gespeichert",
    "lastSavedBy": "von {name}",
    "never": "Nie",
    "usedBy": "Genutzt von"
  },
  "filter": {
    "all": "Alle",
    "inUse": "In Nutzung",
    "unused": "Ungenutzt",
    "mine": "Meine",
    "searchBases": "Basen und Agenten durchsuchen",
    "searchMemories": "Erinnerungen durchsuchen",
    "visibility": "Sichtbarkeit",
    "type": "Typ",
    "creator": "Erstellt von",
    "creatorPlaceholder": "Beliebig",
    "creatorSearch": "Nach E-Mail suchen",
    "creatorEmpty": "Keine Nutzer gefunden",
    "any": "Beliebig",
    "apply": "Anwenden"
  },
  "columns": {
    "base": "Gedächtnis-Basis",
    "usedBy": "Genutzt von",
    "memories": "Erinnerungen",
    "contributors": "Beitragende",
    "lastSaved": "Zuletzt gespeichert",
    "memory": "Erinnerung",
    "visibility": "Sichtbarkeit",
    "saved": "Gespeichert"
  },
  "base": {
    "createdWith": "erstellt mit {agent}",
    "notUsed": "Von keinem Agenten genutzt",
    "assign": "Zuweisen",
    "invalid": "Nicht korrekt für Gedächtnis konfiguriert, muss die Felder enthalten: {fields}",
    "missingFromCode": "Nicht im Code gefunden",
    "moreAgents": "+{count}",
    "usedByOne": "Genutzt von {agent}",
    "usedByMore": "Genutzt von {agent} +{count}",
    "openInKnowledge": "In Wissen öffnen",
    "visibleFooter": "{visible} von {total} für dich sichtbar",
    "noList": "Erinnerungen können erst angezeigt werden, wenn die Basis korrekt konfiguriert ist."
  },
  "empty": {
    "basesTitle": "Noch keine Gedächtnis-Basen",
    "basesDescription": "Definiere einen Wissens-Kontext mit einem information- und einem type-Feld, um Agenten ein Langzeitgedächtnis zu geben.",
    "basesAction": "Zur Dokumentation",
    "memoriesTitle": "Noch keine Erinnerungen",
    "memoriesDescription": "Agenten speichern sie, wenn jemand sagt „merk dir …“.",
    "notAvailableTitle": "Diese Erinnerung ist für dich nicht verfügbar",
    "notAvailableDescription": "Sie ist privat für die Person, die sie gespeichert hat, oder wurde gelöscht.",
    "back": "Zurück zur Gedächtnis-Basis"
  },
  "visibility": {
    "public": "Öffentlich",
    "private": "Privat",
    "users": "Nutzer",
    "roles": "Rollen",
    "teams": "Teams"
  },
  "detail": {
    "breadcrumb": "Gedächtnis",
    "whySaved": "Warum gespeichert",
    "notRecorded": "Nicht erfasst",
    "source": "Ursprungsgespräch",
    "noSource": "Kein Gespräch erfasst",
    "openConversation": "Gespräch öffnen",
    "details": "Details",
    "whoCanSee": "Wer sie sieht",
    "change": "Ändern",
    "createdBy": "Erstellt von",
    "created": "Erstellt",
    "updated": "Aktualisiert",
    "editWording": "Wortlaut bearbeiten",
    "makePrivate": "Privat machen",
    "makePrivateTitle": "Diese Erinnerung privat machen?",
    "makePrivateDescription": "Nur du und Admins sehen sie noch. Agenten rufen sie für andere Personen nicht mehr ab.",
    "madePrivate": "Die Erinnerung ist jetzt privat",
    "delete": "Löschen",
    "deleteTitle": "Diese Erinnerung löschen?",
    "deleteDescription": "Der Agent ruft sie nicht mehr ab. Das lässt sich nicht rückgängig machen.",
    "deleted": "Erinnerung gelöscht",
    "accessTitle": "Wer diese Erinnerung sieht",
    "accessSubject": "Erinnerung",
    "accessSaved": "Zugriff aktualisiert",
    "unknownUser": "Unbekannter Nutzer",
    "failed": "Das hat nicht geklappt. Bitte versuche es erneut."
  },
  "bulk": {
    "setAccess": "Zugriff festlegen",
    "delete": "Löschen",
    "deleteTitle": "{count} Erinnerungen löschen?",
    "deleteDescription": "Agenten rufen sie nicht mehr ab. Das lässt sich nicht rückgängig machen.",
    "deleted": "{count} Erinnerungen gelöscht",
    "deleteFailed": "{count} konnten nicht gelöscht werden"
  }
}
```

- [ ] **Step 5: Demo resolvers**

In `lib/demo/resolvers.ts`, inside `DEMO_RESOLVERS` after the `GetContextById` entry:

```ts
  // --- /memory (memory area, sub-project 2) ---------------------------------
  // No fabricated memories: the overview renders its empty state and the
  // per-base pages are never reached from it.
  MemoryBases: () => ({ memoryBases: [] }),
  MemoryAgentCount: (world) => ({
    agentsPagination: { pageInfo: { itemCount: world.agents.length } },
  }),
```

- [ ] **Step 6: FilterPanel field types**

In `components/primitives/filter-panel.tsx`:

```ts
export type FilterFieldType = "text" | "datetime" | "number-range" | "select" | "entity";

export interface FilterFieldOption {
  value: string;
  label: string;
}

export interface FilterFieldDef {
  id: string;
  label: string;
  type: FilterFieldType;
  placeholder?: string;
  graphqlField?: string;
  /** `select` only: the fixed choices. An empty selection clears the key. */
  options?: FilterFieldOption[];
  /** `entity` only: async search for an EntityCombobox (id → label). */
  fetchOptions?: (query: string) => Promise<FilterFieldOption[]>;
  resolveLabel?: (id: string) => Promise<string | null>;
  /** `entity` only: copy for the combobox. */
  emptyMessage?: string;
  searchPlaceholder?: string;
}
```

Add imports `import { EntityCombobox } from "@/components/primitives/entity-combobox";` and `import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";`, and in `FieldRow` before the `datetime` branch:

```tsx
  if (field.type === "select") {
    const current = (value as Record<string, unknown>)[field.id] as string | undefined;
    return (
      <div className="flex flex-col gap-2">
        <Label htmlFor={field.id}>{field.label}</Label>
        <Select
          value={current ?? "__any"}
          onValueChange={(v) => onChange(setKey(value, field.id, v === "__any" ? undefined : v))}
        >
          <SelectTrigger id={field.id}>
            <SelectValue placeholder={field.placeholder} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__any">{field.placeholder ?? "—"}</SelectItem>
            {(field.options ?? []).map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (field.type === "entity") {
    const current = (value as Record<string, unknown>)[field.id] as string | undefined;
    return (
      <div className="flex flex-col gap-2">
        <Label>{field.label}</Label>
        <EntityCombobox
          value={current ?? null}
          onChange={(id) => onChange(setKey(value, field.id, id ?? undefined))}
          fetchOptions={async (q) =>
            (field.fetchOptions ? await field.fetchOptions(q) : []).map((o) => ({ id: o.value, label: o.label }))
          }
          resolveLabel={
            field.resolveLabel
              ? async (id) => { const label = await field.resolveLabel!(id); return label ? { label } : null; }
              : undefined
          }
          placeholder={field.placeholder ?? ""}
          emptyMessage={field.emptyMessage ?? ""}
          searchPlaceholder={field.searchPlaceholder}
        />
      </div>
    );
  }
```

(`EntityComboboxOption` is `{ id, label, sublabel? }` and `resolveLabel` returns `{ label } | null`; the mapping above adapts the panel's `{ value, label }` options to it.)

- [ ] **Step 7: Route-local queries**

`app/(application)/memory/queries.ts`:

```ts
/**
 * Memory area (agent memory redesign, sub-project 2) — route-local GraphQL
 * documents. Copies of the knowledge/chat/users documents this feature needs:
 * the lint rules forbid importing other features' folders and the queries
 * monolith. Operation names are unique so demo resolvers can map them.
 */
import { gql } from "@apollo/client";

export const MEMORY_STATS_FIELDS = `
  total
  public
  private
  contributors
  visible
  lastSavedAt
  lastSavedBy { id name }
`;

export const GET_MEMORY_BASES = gql`
  query MemoryBases {
    memoryBases {
      id
      name
      description
      valid
      missing
      missingFromCode
      agents { id name }
      stats { ${MEMORY_STATS_FIELDS} }
    }
  }
`;

export const GET_AGENT_COUNT = gql`
  query MemoryAgentCount {
    agentsPagination(page: 1, limit: 1) {
      pageInfo { itemCount }
    }
  }
`;

/** The base's contract (fields → type enum, source_session) and default rights mode. */
export const GET_MEMORY_BASE = gql`
  query MemoryBaseById($id: ID!) {
    contextById(id: $id) {
      id
      name
      description
      fields
      configuration
      memoryBase { ok missing }
    }
  }
`;

const ITEM_FIELDS = (fields: string[]) => `
  id
  name
  description
  createdAt
  updatedAt
  rights_mode
  RBAC {
    type
    users { id rights }
    roles { id rights }
  }
  ${fields.join("\n")}
`;

export const memoryItemFields = (withSourceSession: boolean) => [
  "information",
  "type",
  "created_by",
  ...(withSourceSession ? ["source_session"] : []),
];

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const MEMORY_ITEMS_KEY = (context: string) => `${context}_itemsPagination`;
export const MEMORY_ITEM_KEY = (context: string) => `${context}_itemsById`;

export const GET_MEMORY_ITEMS = (context: string, withSourceSession: boolean) => gql`
  query ${context}MemoriesPagination($page: Int!, $limit: Int!, $filters: [Filter${upperFirst(context)}_items], $sort: SortBy = { field: "createdAt", direction: DESC }) {
    ${context}_itemsPagination(page: $page, limit: $limit, filters: $filters, sort: $sort) {
      pageInfo { pageCount itemCount currentPage hasPreviousPage hasNextPage }
      items { ${ITEM_FIELDS(memoryItemFields(withSourceSession))} }
    }
  }
`;

export const GET_MEMORY_ITEM_BY_ID = (context: string, withSourceSession: boolean) => gql`
  query ${context}MemoryById($id: ID!) {
    ${context}_itemsById(id: $id) { ${ITEM_FIELDS(memoryItemFields(withSourceSession))} }
  }
`;

export const DELETE_MEMORY_ITEM = (context: string) => gql`
  mutation DeleteMemory${context}($id: ID!) {
    ${context}_itemsRemoveOneById(id: $id) { id }
  }
`;

/** Same operation shape as knowledge's BULK_UPDATE_ITEM_RBAC (BulkAccessDialog contract). */
export const BULK_UPDATE_MEMORY_RBAC = (context: string) => gql`
  mutation BulkUpdateMemoryRBAC${context}($ids: [ID!]!, $rights_mode: String!, $rbac: RBACInput) {
    ${context}_itemsBulkUpdateRBAC(ids: $ids, rights_mode: $rights_mode, RBAC: $rbac) {
      message
      itemCount
    }
  }
`;

export const GET_USERS_BY_IDS = gql`
  query MemoryUsersByIds($ids: [Float]) {
    usersPagination(page: 1, limit: 100, filters: [{ id: { in: $ids } }]) {
      items { id firstname lastname email }
    }
  }
`;

/** Same filter shape as the RBAC control's user search (email contains, no api users). */
export const SEARCH_USERS = gql`
  query MemoryUserSearch($search: String!) {
    usersPagination(page: 1, limit: 8, filters: [{ type: { ne: "api" } }, { email: { contains: $search } }]) {
      items { id firstname lastname email }
    }
  }
`;

export const GET_SOURCE_SESSION = gql`
  query MemorySourceSession($id: ID!) {
    agent_sessionById(id: $id) { id title agent }
  }
`;

export const GET_SOURCE_MESSAGES = gql`
  query MemorySourceMessages($session: String!) {
    agent_messagesPagination(page: 1, limit: 5, sort: { field: "createdAt", direction: ASC }, filters: [{ session: { eq: $session } }]) {
      items { id content createdAt }
    }
  }
`;
```

- [ ] **Step 8: Run the tests, the message check and lint**

Run: `npx vitest run components/shell "app/(application)/memory" --maxWorkers 2 && npm run check-messages && npx eslint components/primitives/filter-panel.tsx components/shell/nav-config.ts "app/(application)/memory" lib/demo/resolvers.ts`
Expected: PASS, "no mismatches", no lint errors.

- [ ] **Step 9: Commit**

```bash
git branch --show-current   # must print feat/memory-area
git add components/shell/nav-config.ts components/shell/nav-config.test.ts messages/en.json messages/de.json lib/demo/resolvers.ts components/primitives/filter-panel.tsx "app/(application)/memory/queries.ts" "app/(application)/memory/queries.test.ts"
git commit -m "feat(memory): Memory nav entry, i18n, demo resolvers, route-local queries, FilterPanel select/entity fields"
```

---

### Task 6: `/memory` — bases overview

**Files:**
- Create: `app/(application)/memory/components/memory-bases-data.ts`, `memory-bases-data.test.ts`
- Create: `app/(application)/memory/page.tsx`, `app/(application)/memory/loading.tsx`, `app/(application)/memory/components/memory-overview.tsx`

**Interfaces:**
- Consumes: `GET_MEMORY_BASES`, `GET_AGENT_COUNT` (Task 5).
- Produces: `MemoryBase`, `MemoryBaseStats` types; `baseState`, `filterBases`, `overviewTotals`, `baseSubtitle` (used by Task 7 for the base header too).

- [ ] **Step 1: Write the failing tests**

`memory-bases-data.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { baseState, baseSubtitle, filterBases, overviewTotals, type MemoryBase } from "./memory-bases-data";

const stats = (total: number, contributors: number) => ({ total, public: total, private: 0, contributors, visible: total, lastSavedAt: null, lastSavedBy: null });
const base = (p: Partial<MemoryBase>): MemoryBase => ({ id: "x", name: "X", description: null, valid: true, missing: [], missingFromCode: false, agents: [], stats: stats(0, 0), ...p });
const alpha = base({ id: "a", name: "Alpha", agents: [{ id: "1", name: "Alfredinio" }, { id: "2", name: "Bot" }], stats: stats(47, 9) });
const beta = base({ id: "b", name: "Beta", description: "  Second base ", stats: stats(3, 1) });
const docs = base({ id: "docs", name: "Docs", valid: false, missing: ["type"], agents: [{ id: "3", name: "Docs-Bot" }], stats: stats(3, 1) });
const gone = base({ id: "gone", name: "gone", valid: false, missingFromCode: true, agents: [{ id: "1", name: "Alfredinio" }], stats: null });

describe("baseState", () => {
  it("ranks missing-from-code over invalid over usage", () => {
    expect([alpha, beta, docs, gone].map(baseState)).toEqual(["inUse", "unused", "invalid", "missingFromCode"]);
  });
});

describe("filterBases", () => {
  it("matches base and agent names case-insensitively", () => {
    expect(filterBases([alpha, beta], "BOT", "all").map((b) => b.id)).toEqual(["a"]);
    expect(filterBases([alpha, beta], "  ", "all").map((b) => b.id)).toEqual(["a", "b"]);
  });
  it("in use = has agents; unused = valid without agents", () => {
    expect(filterBases([alpha, beta, docs, gone], "", "inUse").map((b) => b.id)).toEqual(["a", "docs", "gone"]);
    expect(filterBases([alpha, beta, docs, gone], "", "unused").map((b) => b.id)).toEqual(["b"]);
  });
});

describe("overviewTotals", () => {
  it("counts valid bases, distinct agents, and sums totals over every listed base", () => {
    expect(overviewTotals([alpha, beta, docs, gone], 12)).toEqual({ bases: 2, agentsWithMemory: 3, agentCount: 12, memories: 53, contributors: 11 });
  });
});

describe("baseSubtitle", () => {
  it("prefers the trimmed description, then the single agent, then nothing", () => {
    expect(baseSubtitle(beta)).toEqual({ kind: "description", text: "Second base" });
    expect(baseSubtitle(docs)).toEqual({ kind: "createdWith", agent: "Docs-Bot" });
    expect(baseSubtitle(alpha)).toEqual({ kind: "none" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "app/(application)/memory" --maxWorkers 2`
Expected: FAIL — module not found.

- [ ] **Step 3: Pure module**

`memory-bases-data.ts`:

```ts
/** Pure helpers for the /memory overview (spec §4.2). No React, no Apollo. */

export interface MemoryBaseStats {
  total: number;
  public: number;
  private: number;
  contributors: number;
  visible: number;
  lastSavedAt: string | null;
  lastSavedBy: { id: number; name: string } | null;
}

export interface MemoryBase {
  id: string;
  name: string;
  description: string | null;
  valid: boolean;
  missing: string[];
  missingFromCode: boolean;
  agents: { id: string; name: string }[];
  stats: MemoryBaseStats | null;
}

export type BaseFilterMode = "all" | "inUse" | "unused";
export type BaseState = "inUse" | "unused" | "invalid" | "missingFromCode";

export function baseState(base: MemoryBase): BaseState {
  if (base.missingFromCode) return "missingFromCode";
  if (!base.valid) return "invalid";
  return base.agents.length > 0 ? "inUse" : "unused";
}

export function filterBases(bases: MemoryBase[], search: string, mode: BaseFilterMode): MemoryBase[] {
  const q = search.trim().toLowerCase();
  return bases.filter((b) => {
    if (mode === "inUse" && b.agents.length === 0) return false;
    if (mode === "unused" && (b.agents.length > 0 || !b.valid)) return false;
    if (!q) return true;
    return b.name.toLowerCase().includes(q) || b.agents.some((a) => a.name.toLowerCase().includes(q));
  });
}

export function overviewTotals(bases: MemoryBase[], agentCount: number) {
  const agentIds = new Set(bases.flatMap((b) => b.agents.map((a) => a.id)));
  return {
    bases: bases.filter((b) => b.valid).length,
    agentsWithMemory: agentIds.size,
    agentCount,
    memories: bases.reduce((s, b) => s + (b.stats?.total ?? 0), 0),
    contributors: bases.reduce((s, b) => s + (b.stats?.contributors ?? 0), 0),
  };
}

export type BaseSubtitle =
  | { kind: "description"; text: string }
  | { kind: "createdWith"; agent: string }
  | { kind: "none" };

export function baseSubtitle(base: MemoryBase): BaseSubtitle {
  const text = base.description?.trim();
  if (text) return { kind: "description", text };
  if (base.agents.length === 1) return { kind: "createdWith", agent: base.agents[0].name };
  return { kind: "none" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run "app/(application)/memory" --maxWorkers 2`
Expected: PASS.

- [ ] **Step 5: Pages**

`app/(application)/memory/page.tsx`:

```tsx
/**
 * /memory — Memory area overview (agent memory redesign, sub-project 2).
 * Server component: guard, then hand off to the client overview which owns
 * i18n and all state (server pages must not call getTranslations here).
 */
import { guardRoute } from "@/lib/route-guard";

import { MemoryOverview } from "./components/memory-overview";

export default async function MemoryPage() {
  const denied = await guardRoute("memory");
  if (denied) return denied;
  return <MemoryOverview />;
}
```

`app/(application)/memory/loading.tsx`:

```tsx
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="flex h-full flex-1 flex-col gap-6 p-4 md:p-8">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <Skeleton className="h-10 w-full md:max-w-sm" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
```

`app/(application)/memory/components/memory-overview.tsx`:

```tsx
"use client";

import { useQuery } from "@apollo/client";
import type { ColumnDef } from "@tanstack/react-table";
import { Bookmark } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

import { DataTable } from "@/components/primitives/data-table";
import { PageHeader } from "@/components/primitives/page-header";
import { PageShell } from "@/components/primitives/page-shell";
import { RelativeTime } from "@/components/primitives/relative-time";
import { StatCard } from "@/components/primitives/stat-card";
import { Toolbar } from "@/components/primitives/toolbar";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { GET_AGENT_COUNT, GET_MEMORY_BASES } from "../queries";
import {
  type BaseFilterMode,
  type MemoryBase,
  baseState,
  baseSubtitle,
  filterBases,
  overviewTotals,
} from "./memory-bases-data";

const DOCS_URL = "https://docs.exulu.com/building/memory/overview";

export function AgentChips({ agents, max = 2 }: { agents: { id: string; name: string }[]; max?: number }) {
  const t = useTranslations("memory");
  const shown = agents.slice(0, max);
  const rest = agents.slice(max);
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((a) => (
        <Badge key={a.id} variant="secondary" className="font-normal">{a.name}</Badge>
      ))}
      {rest.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="font-normal">{t("base.moreAgents", { count: rest.length })}</Badge>
          </TooltipTrigger>
          <TooltipContent>{rest.map((a) => a.name).join(", ")}</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}

function BaseCell({ base }: { base: MemoryBase }) {
  const t = useTranslations("memory");
  const state = baseState(base);
  const sub = baseSubtitle(base);
  const muted = state === "invalid" || state === "missingFromCode";
  return (
    <div className={cn("flex flex-col gap-0.5", muted && "text-muted-foreground")}>
      <span className="font-medium">{base.name}</span>
      {state === "invalid" && (
        <span className="text-xs">{t("base.invalid", { fields: base.missing.join(", ") })}</span>
      )}
      {state === "missingFromCode" && <span className="text-xs">{t("base.missingFromCode")}</span>}
      {!muted && sub.kind === "description" && (
        <span className="text-xs text-muted-foreground line-clamp-1">{sub.text}</span>
      )}
      {!muted && sub.kind === "createdWith" && (
        <span className="text-xs text-muted-foreground">{t("base.createdWith", { agent: sub.agent })}</span>
      )}
      {state === "unused" && (
        <span className="text-xs text-muted-foreground">
          {t("base.notUsed")} ·{" "}
          <Link href="/agents" className="underline" onClick={(e) => e.stopPropagation()}>
            {t("base.assign")}
          </Link>
        </span>
      )}
    </div>
  );
}

export function MemoryOverview() {
  const t = useTranslations("memory");
  const router = useRouter();
  const [search, setSearch] = React.useState("");
  const [mode, setMode] = React.useState<BaseFilterMode>("all");

  const bases = useQuery<{ memoryBases: MemoryBase[] }>(GET_MEMORY_BASES, { fetchPolicy: "cache-and-network" });
  const agents = useQuery<{ agentsPagination: { pageInfo: { itemCount: number } } }>(GET_AGENT_COUNT);

  const all = bases.data?.memoryBases ?? [];
  const rows = React.useMemo(() => filterBases(all, search, mode), [all, search, mode]);
  const totals = overviewTotals(all, agents.data?.agentsPagination.pageInfo.itemCount ?? 0);

  const columns = React.useMemo<ColumnDef<MemoryBase>[]>(
    () => [
      { id: "base", header: t("columns.base"), cell: ({ row }) => <BaseCell base={row.original} /> },
      { id: "usedBy", header: t("columns.usedBy"), cell: ({ row }) => <AgentChips agents={row.original.agents} /> },
      { id: "memories", header: t("columns.memories"), cell: ({ row }) => row.original.stats?.total ?? "—" },
      { id: "contributors", header: t("columns.contributors"), cell: ({ row }) => row.original.stats?.contributors ?? "—" },
      {
        id: "lastSaved",
        header: t("columns.lastSaved"),
        cell: ({ row }) =>
          row.original.stats?.lastSavedAt ? <RelativeTime date={row.original.stats.lastSavedAt} /> : t("stats.never"),
      },
    ],
    [t],
  );

  return (
    <PageShell>
      <PageHeader title={t("title")} description={t("description")} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label={t("stats.bases")} value={totals.bases} loading={bases.loading && !bases.data} />
        <StatCard
          label={t("stats.agents")}
          value={totals.agentsWithMemory}
          caption={t("stats.agentsOf", { count: totals.agentCount })}
          loading={bases.loading && !bases.data}
        />
        <StatCard label={t("stats.memories")} value={totals.memories} loading={bases.loading && !bases.data} />
        <StatCard label={t("stats.contributors")} value={totals.contributors} loading={bases.loading && !bases.data} />
      </div>
      <Toolbar
        search={{ value: search, onChange: setSearch, placeholder: t("filter.searchBases"), debounceMs: 0 }}
        view={
          <Tabs value={mode} onValueChange={(v) => setMode(v as BaseFilterMode)}>
            <TabsList>
              <TabsTrigger value="all">{t("filter.all")}</TabsTrigger>
              <TabsTrigger value="inUse">{t("filter.inUse")}</TabsTrigger>
              <TabsTrigger value="unused">{t("filter.unused")}</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />
      <DataTable<MemoryBase>
        columns={columns}
        data={rows}
        loading={bases.loading && !bases.data}
        error={bases.error}
        onRowClick={(row) => {
          if (!row.missingFromCode) router.push(`/memory/${row.id}`);
        }}
        getRowId={(row) => row.id}
        empty={{
          icon: Bookmark,
          title: t("empty.basesTitle"),
          description: t("empty.basesDescription"),
          action: { label: t("empty.basesAction"), href: DOCS_URL },
        }}
        mobileCard={(row) => (
          <div className="flex flex-col gap-2">
            <BaseCell base={row} />
            <AgentChips agents={row.agents} />
            <span className="text-xs text-muted-foreground">
              {t("columns.memories")}: {row.stats?.total ?? "—"} · {t("columns.contributors")}: {row.stats?.contributors ?? "—"}
            </span>
          </div>
        )}
      />
      <p className="text-xs text-muted-foreground">{t("countsNote")}</p>
    </PageShell>
  );
}
```

`EmptyStateAction` accepts `{ label, href }`, which is what the docs link uses.

- [ ] **Step 6: Lint and typecheck**

Run: `npx eslint "app/(application)/memory" && npx tsc --noEmit 2>&1 | grep "app/(application)/memory" | head`
Expected: no lint errors; no type errors under the memory folder.

- [ ] **Step 7: Commit**

```bash
git branch --show-current   # feat/memory-area
git add "app/(application)/memory"
git commit -m "feat(memory): /memory bases overview"
```

---

### Task 7: `/memory/[ctx]` — per-base page with stats strip, list, filters and bulk actions

**Files:**
- Create: `app/(application)/memory/[ctx]/components/memory-list-data.ts`, `memory-list-data.test.ts`
- Create: `app/(application)/memory/[ctx]/page.tsx`, `loading.tsx`, `components/base-shell.tsx`, `components/memory-table.tsx`, `components/use-memory-items.ts`

**Interfaces:**
- Consumes: Task 5 queries; `AgentChips`, `MemoryBase`, `baseState` (Task 6).
- Produces: `MemoryItem`, `MemoryContext` types; `buildMemoryFilters`, `activeFilterCount`, `memoryTypeOptions`, `hasSourceSession`, `creatorIds`, `creatorName`, `visibilityKey` (Task 8 reuses the types and `creatorName`).

- [ ] **Step 1: Write the failing tests**

`memory-list-data.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  activeFilterCount, buildMemoryFilters, creatorIds, creatorName, hasSourceSession, memoryTypeOptions, visibilityKey,
} from "./memory-list-data";

const ctx = { fields: [{ name: "information", type: "text" }, { name: "type", type: "enum", enumValues: ["FACT", "PREFERENCE"] }] };

describe("buildMemoryFilters", () => {
  it("always excludes archived rows and searches the wording only", () => {
    expect(buildMemoryFilters({ search: " gearbox ", mine: false, userId: 4, filters: {} })).toEqual([
      { archived: { eq: false }, information: { contains: "gearbox" } },
    ]);
  });
  it("omits the search for whitespace and passes special characters verbatim", () => {
    expect(buildMemoryFilters({ search: "   ", mine: false, userId: 4, filters: {} })).toEqual([{ archived: { eq: false } }]);
    expect(buildMemoryFilters({ search: "100%_{x}", mine: false, userId: 4, filters: {} })[0]).toMatchObject({ information: { contains: "100%_{x}" } });
  });
  it("maps visibility, type and creator; Mine overrides creator", () => {
    expect(buildMemoryFilters({ search: "", mine: false, userId: 4, filters: { visibility: "private", type: "FACT", creator: "9" } })).toEqual([
      { archived: { eq: false }, rights_mode: { eq: "private" }, type: { eq: "FACT" }, created_by: { eq: 9 } },
    ]);
    expect(buildMemoryFilters({ search: "", mine: true, userId: 4, filters: { creator: "9" } })).toEqual([
      { archived: { eq: false }, created_by: { eq: 4 } },
    ]);
    expect(buildMemoryFilters({ search: "", mine: true, userId: undefined, filters: {} })).toEqual([{ archived: { eq: false } }]);
  });
});

describe("helpers", () => {
  it("counts active filters and reads the type enum and the source_session field", () => {
    expect(activeFilterCount({ visibility: "public", creator: "" })).toBe(1);
    expect(memoryTypeOptions(ctx)).toEqual(["FACT", "PREFERENCE"]);
    expect(memoryTypeOptions({ fields: [] })).toEqual([]);
    expect(hasSourceSession(ctx)).toBe(false);
    expect(hasSourceSession({ fields: [...ctx.fields, { name: "source_session", type: "text" }] })).toBe(true);
  });
  it("collects distinct creator ids and formats names", () => {
    expect(creatorIds([{ id: "1", created_by: 9 }, { id: "2", created_by: 9 }, { id: "3", created_by: null }])).toEqual([9]);
    const users = [{ id: 9, firstname: "Sara", lastname: "Kraus", email: "s@x.de" }, { id: 3, firstname: null, lastname: null, email: "t@x.de" }];
    expect(creatorName(users, 9)).toBe("Sara Kraus");
    expect(creatorName(users, 3)).toBe("t@x.de");
    expect(creatorName(users, 7)).toBeNull();
  });
  it("maps rights modes to visibility keys", () => {
    expect(visibilityKey("public")).toBe("public");
    expect(visibilityKey(undefined)).toBe("private");
    expect(visibilityKey("teams")).toBe("teams");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "app/(application)/memory/[ctx]" --maxWorkers 2`
Expected: FAIL — module not found.

- [ ] **Step 3: Pure module**

`memory-list-data.ts`:

```ts
/** Pure helpers for the per-base memory list (spec §4.3). */

export interface MemoryContextField { name: string; type: string; enumValues?: string[] | null }
export interface MemoryContext {
  id: string;
  name: string;
  description?: string | null;
  fields?: MemoryContextField[] | null;
  configuration?: { defaultRightsMode?: string } | null;
  memoryBase?: { ok: boolean; missing: string[] } | null;
}

export interface MemoryItem {
  id: string;
  name?: string | null;
  information?: string | null;
  type?: string | null;
  description?: string | null;
  rights_mode?: string | null;
  created_by?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  source_session?: string | null;
  RBAC?: { type?: string | null; users?: { id: string; rights: string }[] | null; roles?: { id: string; rights: string }[] | null } | null;
}

export interface MemoryListFilters {
  visibility?: string;
  type?: string;
  creator?: string;
  [key: string]: string | number | undefined;
}

export function buildMemoryFilters(args: {
  search: string;
  mine: boolean;
  userId: number | null | undefined;
  filters: MemoryListFilters;
}): Record<string, unknown>[] {
  const f: Record<string, unknown> = { archived: { eq: false } };
  const q = args.search.trim();
  if (q) f.information = { contains: q };
  if (args.filters.visibility) f.rights_mode = { eq: args.filters.visibility };
  if (args.filters.type) f.type = { eq: args.filters.type };
  if (args.mine) {
    if (typeof args.userId === "number") f.created_by = { eq: args.userId };
  } else if (args.filters.creator) {
    f.created_by = { eq: Number(args.filters.creator) };
  }
  return [f];
}

export function activeFilterCount(filters: MemoryListFilters): number {
  return ["visibility", "type", "creator"].filter((k) => !!filters[k]).length;
}

export function memoryTypeOptions(context: Pick<MemoryContext, "fields">): string[] {
  const type = context.fields?.find((f) => f.name === "type");
  if (!type || type.type !== "enum") return [];
  return [...(type.enumValues ?? [])];
}

export function hasSourceSession(context: Pick<MemoryContext, "fields">): boolean {
  const f = context.fields?.find((x) => x.name === "source_session");
  return !!f && (f.type === "text" || f.type === "longText");
}

export function creatorIds(items: Pick<MemoryItem, "id" | "created_by">[]): number[] {
  return [...new Set(items.map((i) => i.created_by).filter((x): x is number => typeof x === "number"))];
}

export interface UserName { id: number; firstname?: string | null; lastname?: string | null; email?: string | null }

export function creatorName(users: UserName[], id: number | null | undefined): string | null {
  if (typeof id !== "number") return null;
  const u = users.find((x) => Number(x.id) === id);
  if (!u) return null;
  const full = [u.firstname, u.lastname].filter(Boolean).join(" ").trim();
  return full || u.email || null;
}

export type VisibilityKey = "public" | "private" | "users" | "roles" | "teams";

export function visibilityKey(mode: string | null | undefined): VisibilityKey {
  return mode === "public" || mode === "users" || mode === "roles" || mode === "teams" ? mode : "private";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run "app/(application)/memory/[ctx]" --maxWorkers 2`
Expected: PASS.

- [ ] **Step 5: Server page and loading**

`app/(application)/memory/[ctx]/page.tsx`:

```tsx
/**
 * /memory/[ctx] — one memory base (spec §4.3). Server: guard + context fetch,
 * then the client shell owns i18n, stats, list and bulk actions.
 */
import { fetchGraphQLServerSide } from "@/lib/graphql/server";
import { guardRoute } from "@/lib/route-guard";

import { GET_MEMORY_BASE } from "../queries";
import { BaseShell, NotFoundBase } from "./components/base-shell";
import type { MemoryContext } from "./components/memory-list-data";

export default async function MemoryBasePage({
  params,
  searchParams,
}: {
  params: Promise<{ ctx: string }>;
  searchParams: Promise<{ mine?: string; page?: string }>;
}) {
  const denied = await guardRoute("memory");
  if (denied) return denied;
  const { ctx } = await params;
  const sp = await searchParams;
  const data = (await fetchGraphQLServerSide(GET_MEMORY_BASE.loc?.source.body ?? "", { id: ctx })) as
    | { contextById: MemoryContext | null }
    | null
    | undefined;
  const context = data?.contextById ?? null;
  if (!context) return <NotFoundBase contextId={ctx} />;
  return <BaseShell context={context} initialMine={sp.mine === "1"} initialPage={Number(sp.page) || 1} />;
}
```

`app/(application)/memory/[ctx]/loading.tsx`: copy `app/(application)/memory/loading.tsx` verbatim (same layout: header, four stat skeletons, toolbar, rows).

- [ ] **Step 6: Items hook**

`components/use-memory-items.ts`:

```ts
"use client";

import { useQuery } from "@apollo/client";
import * as React from "react";

import { UserContext } from "@/app/(application)/authenticated";

import { GET_MEMORY_ITEMS, GET_USERS_BY_IDS, MEMORY_ITEMS_KEY } from "../../queries";
import {
  type MemoryItem, type MemoryListFilters, type UserName, buildMemoryFilters, creatorIds,
} from "./memory-list-data";

export const PAGE_SIZE = 20;

export interface PageInfo { pageCount: number; itemCount: number; currentPage: number; hasPreviousPage: boolean; hasNextPage: boolean }

export function useMemoryItems(args: {
  contextId: string;
  withSourceSession: boolean;
  page: number;
  search: string;
  mine: boolean;
  filters: MemoryListFilters;
  skip?: boolean;
}) {
  const { user } = React.useContext(UserContext) as { user?: { id?: number } };
  const filters = React.useMemo(
    () => buildMemoryFilters({ search: args.search, mine: args.mine, userId: user?.id, filters: args.filters }),
    [args.search, args.mine, args.filters, user?.id],
  );
  const query = useQuery<{ [key: string]: { pageInfo: PageInfo; items: MemoryItem[] } }>(
    GET_MEMORY_ITEMS(args.contextId, args.withSourceSession),
    {
      skip: args.skip,
      fetchPolicy: "cache-and-network",
      nextFetchPolicy: "network-only",
      variables: { page: args.page, limit: PAGE_SIZE, filters, sort: { field: "createdAt", direction: "DESC" } },
    },
  );
  const live = query.data?.[MEMORY_ITEMS_KEY(args.contextId)] ?? query.previousData?.[MEMORY_ITEMS_KEY(args.contextId)];
  const items = live?.items ?? [];
  const ids = creatorIds(items);
  const users = useQuery<{ usersPagination: { items: UserName[] } }>(GET_USERS_BY_IDS, {
    skip: ids.length === 0,
    variables: { ids },
  });
  return {
    items,
    pageInfo: live?.pageInfo ?? { pageCount: 0, itemCount: 0, currentPage: args.page, hasPreviousPage: false, hasNextPage: false },
    users: users.data?.usersPagination.items ?? [],
    loading: query.loading && !query.data,
    error: query.error,
    refetch: () => { void query.refetch(); },
  };
}
```

- [ ] **Step 7: Table with filters and bulk actions**

`components/memory-table.tsx`:

```tsx
"use client";

import { useApolloClient, useMutation } from "@apollo/client";
import type { ColumnDef } from "@tanstack/react-table";
import { Bookmark, Globe, Lock, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";

import { BulkActionBar } from "@/components/primitives/bulk-action-bar";
import { ConfirmDialog } from "@/components/primitives/confirm-dialog";
import { DataTable } from "@/components/primitives/data-table";
import { FilterPanel, type FilterFieldDef } from "@/components/primitives/filter-panel";
import { RelativeTime } from "@/components/primitives/relative-time";
import { Toolbar } from "@/components/primitives/toolbar";
import { BulkAccessDialog } from "@/components/widgets/bulk-access-dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { BULK_UPDATE_MEMORY_RBAC, DELETE_MEMORY_ITEM, SEARCH_USERS, GET_USERS_BY_IDS } from "../../queries";
import {
  type MemoryContext, type MemoryItem, type MemoryListFilters, type UserName,
  activeFilterCount, creatorName, hasSourceSession, memoryTypeOptions, visibilityKey,
} from "./memory-list-data";
import { useMemoryItems } from "./use-memory-items";

const VISIBILITY_ICON = { public: Globe, private: Lock, users: Users, roles: Users, teams: Users } as const;

export function VisibilityLabel({ mode }: { mode: string | null | undefined }) {
  const t = useTranslations("memory");
  const key = visibilityKey(mode);
  const Icon = VISIBILITY_ICON[key];
  return (
    <span className="inline-flex items-center gap-1 text-sm">
      <Icon className="size-3.5 text-muted-foreground" aria-hidden />
      {t(`visibility.${key}`)}
    </span>
  );
}

function MemoryCell({ item, users }: { item: MemoryItem; users: UserName[] }) {
  const t = useTranslations("memory");
  const creator = creatorName(users, item.created_by) ?? t("detail.unknownUser");
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm line-clamp-2">{item.information ?? item.name}</span>
      <span className="text-xs text-muted-foreground">{[item.type, creator].filter(Boolean).join(" · ")}</span>
    </div>
  );
}

export function MemoryTable({
  context, initialMine, initialPage, onChanged,
}: { context: MemoryContext; initialMine: boolean; initialPage: number; onChanged: () => void }) {
  const t = useTranslations("memory");
  const tc = useTranslations("common");
  const router = useRouter();
  const client = useApolloClient();
  const [search, setSearch] = React.useState("");
  const [mine, setMine] = React.useState(initialMine);
  const [page, setPage] = React.useState(initialPage);
  const [draft, setDraft] = React.useState<MemoryListFilters>({});
  const [filters, setFilters] = React.useState<MemoryListFilters>({});
  const [selected, setSelected] = React.useState<string[]>([]);
  const [accessOpen, setAccessOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  const withSourceSession = hasSourceSession(context);
  const list = useMemoryItems({ contextId: context.id, withSourceSession, page, search, mine, filters });
  const [deleteItem] = useMutation(DELETE_MEMORY_ITEM(context.id));

  // Back to page 1 whenever the query changes — but not on mount, where the
  // page comes from the URL.
  const mounted = React.useRef(false);
  React.useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    setPage(1);
    setSelected([]);
  }, [search, mine, filters]);

  const fields = React.useMemo<FilterFieldDef[]>(() => [
    {
      id: "visibility", label: t("filter.visibility"), type: "select", placeholder: t("filter.any"),
      options: (["public", "private", "users", "roles", "teams"] as const).map((v) => ({ value: v, label: t(`visibility.${v}`) })),
    },
    {
      id: "type", label: t("filter.type"), type: "select", placeholder: t("filter.any"),
      options: memoryTypeOptions(context).map((v) => ({ value: v, label: v })),
    },
    {
      id: "creator", label: t("filter.creator"), type: "entity",
      placeholder: t("filter.creatorPlaceholder"), searchPlaceholder: t("filter.creatorSearch"), emptyMessage: t("filter.creatorEmpty"),
      fetchOptions: async (q) => {
        if (!q.trim()) return [];
        const res = await client.query<{ usersPagination: { items: UserName[] } }>({ query: SEARCH_USERS, variables: { search: q.trim() } });
        return res.data.usersPagination.items.map((u) => ({ value: String(u.id), label: creatorName([u], Number(u.id)) ?? String(u.id) }));
      },
      resolveLabel: async (id) => {
        const res = await client.query<{ usersPagination: { items: UserName[] } }>({ query: GET_USERS_BY_IDS, variables: { ids: [Number(id)] } });
        return creatorName(res.data.usersPagination.items, Number(id));
      },
    },
  ], [t, context, client]);

  const columns = React.useMemo<ColumnDef<MemoryItem>[]>(() => [
    { id: "memory", header: t("columns.memory"), cell: ({ row }) => <MemoryCell item={row.original} users={list.users} /> },
    { id: "visibility", header: t("columns.visibility"), cell: ({ row }) => <VisibilityLabel mode={row.original.rights_mode} /> },
    { id: "saved", header: t("columns.saved"), cell: ({ row }) => (row.original.createdAt ? <RelativeTime date={row.original.createdAt} /> : "—") },
  ], [t, list.users]);

  const handleBulkDelete = async () => {
    const results = await Promise.allSettled(selected.map((id) => deleteItem({ variables: { id } })));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed) toast.error(t("bulk.deleteFailed", { count: failed }));
    if (failed < selected.length) toast.success(t("bulk.deleted", { count: selected.length - failed }));
    setSelected([]);
    setDeleteOpen(false);
    list.refetch();
    client.cache.gc();
    onChanged();
  };

  return (
    <div className="flex flex-col gap-4">
      <Toolbar
        search={{ value: search, onChange: setSearch, placeholder: t("filter.searchMemories") }}
        activeFilterCount={activeFilterCount(filters)}
        onResetFilters={() => { setFilters({}); setDraft({}); }}
        filters={
          <FilterPanel<MemoryListFilters>
            fields={fields}
            value={draft}
            onChange={setDraft}
            ctaLabel={t("filter.apply")}
            cancelLabel={tc("cancel")}
            onCancel={() => setDraft(filters)}
            onClear={() => { setDraft({}); setFilters({}); }}
            onConfirm={() => setFilters(draft)}
          />
        }
        view={
          <Tabs value={mine ? "mine" : "all"} onValueChange={(v) => setMine(v === "mine")}>
            <TabsList>
              <TabsTrigger value="all">{t("filter.all")}</TabsTrigger>
              <TabsTrigger value="mine">{t("filter.mine")}</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />
      {selected.length > 0 && (
        <BulkActionBar
          count={selected.length}
          onClear={() => setSelected([])}
          actions={[
            { label: t("bulk.setAccess"), onClick: () => setAccessOpen(true) },
            { label: t("bulk.delete"), onClick: () => setDeleteOpen(true), destructive: true },
          ]}
        />
      )}
      <DataTable<MemoryItem>
        columns={columns}
        data={list.items}
        loading={list.loading}
        error={list.error}
        pagination={{ pageInfo: list.pageInfo, onPageChange: setPage }}
        selection={{ selected, onChange: setSelected }}
        onRowClick={(row) => router.push(`/memory/${context.id}/${row.id}`)}
        getRowId={(row) => row.id}
        empty={{ icon: Bookmark, title: t("empty.memoriesTitle"), description: t("empty.memoriesDescription") }}
        mobileCard={(row) => (
          <div className="flex flex-col gap-1">
            <MemoryCell item={row} users={list.users} />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <VisibilityLabel mode={row.rights_mode} />
              {row.createdAt && <RelativeTime date={row.createdAt} />}
            </div>
          </div>
        )}
      />
      <BulkAccessDialog
        open={accessOpen}
        onOpenChange={setAccessOpen}
        mutation={BULK_UPDATE_MEMORY_RBAC(context.id)}
        ids={selected}
        onApplied={() => { setSelected([]); list.refetch(); onChanged(); }}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        variant="destructive"
        title={t("bulk.deleteTitle", { count: selected.length })}
        description={t("bulk.deleteDescription")}
        confirmLabel={t("bulk.delete")}
        onConfirm={handleBulkDelete}
      />
    </div>
  );
}
```

`ConfirmDialog.onConfirm` is `(optionIds?: string[]) => Promise<void>`; the async handler above satisfies it and the dialog shows its pending state while the deletes run.

- [ ] **Step 8: Base shell (header, stats strip, list or warning)**

`components/base-shell.tsx`:

```tsx
"use client";

import { useQuery } from "@apollo/client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import * as React from "react";

import { EmptyState } from "@/components/primitives/empty-state";
import { OverflowMenu } from "@/components/primitives/overflow-menu";
import { PageHeader } from "@/components/primitives/page-header";
import { PageShell } from "@/components/primitives/page-shell";
import { StatCard } from "@/components/primitives/stat-card";

import { type MemoryBase } from "../../components/memory-bases-data";
import { GET_MEMORY_BASES } from "../../queries";
import type { MemoryContext } from "./memory-list-data";
import { MemoryTable } from "./memory-table";

export function NotFoundBase({ contextId }: { contextId: string }) {
  const t = useTranslations("memory");
  return (
    <PageShell>
      <EmptyState title={t("base.missingFromCode")} description={contextId} action={{ label: t("empty.back"), href: "/memory" }} />
    </PageShell>
  );
}

export function BaseShell({ context, initialMine, initialPage }: { context: MemoryContext; initialMine: boolean; initialPage: number }) {
  const t = useTranslations("memory");
  const router = useRouter();
  const bases = useQuery<{ memoryBases: MemoryBase[] }>(GET_MEMORY_BASES, { fetchPolicy: "cache-and-network" });
  const base = bases.data?.memoryBases.find((b) => b.id === context.id);
  const stats = base?.stats ?? null;
  const agents = base?.agents ?? [];
  const valid = context.memoryBase?.ok ?? false;

  const usedBy =
    agents.length === 0 ? t("base.notUsed")
    : agents.length === 1 ? t("base.usedByOne", { agent: agents[0].name })
    : t("base.usedByMore", { agent: agents[0].name, count: agents.length - 1 });

  return (
    <PageShell>
      <PageHeader
        breadcrumb={{ label: t("title"), href: "/memory" }}
        title={context.name}
        description={usedBy}
        action={<OverflowMenu items={[{ label: t("base.openInKnowledge"), onSelect: () => router.push(`/data/${context.id}`) }]} />}
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label={t("stats.memories")}
          value={stats?.total ?? 0}
          caption={stats ? t("stats.memoriesSplit", { public: stats.public, private: stats.private }) : undefined}
          loading={bases.loading && !bases.data}
        />
        <StatCard label={t("stats.contributors")} value={stats?.contributors ?? 0} loading={bases.loading && !bases.data} />
        <StatCard
          label={t("stats.lastSaved")}
          value={stats?.lastSavedAt ? new Date(stats.lastSavedAt).toLocaleDateString() : t("stats.never")}
          caption={stats?.lastSavedBy ? t("stats.lastSavedBy", { name: stats.lastSavedBy.name }) : undefined}
          loading={bases.loading && !bases.data}
        />
        <StatCard
          label={t("stats.usedBy")}
          value={agents.length}
          caption={agents.length ? agents.slice(0, 3).map((a) => a.name).join(", ") + (agents.length > 3 ? ` ${t("base.moreAgents", { count: agents.length - 3 })}` : "") : t("base.notUsed")}
          loading={bases.loading && !bases.data}
        />
      </div>
      {valid ? (
        <>
          <MemoryTable context={context} initialMine={initialMine} initialPage={initialPage} onChanged={() => { void bases.refetch(); }} />
          {stats && <p className="text-xs text-muted-foreground">{t("base.visibleFooter", { visible: stats.visible, total: stats.total })}</p>}
        </>
      ) : (
        <EmptyState
          title={t("base.invalid", { fields: (context.memoryBase?.missing ?? []).join(", ") })}
          description={t("base.noList")}
        />
      )}
    </PageShell>
  );
}
```

`StatCard.value` is `string | number` and `caption` is a string, which is why the "Last saved" and "Used by" cards render text, not `RelativeTime`/chips. Do not widen the primitive.

- [ ] **Step 9: Lint and typecheck**

Run: `npx eslint "app/(application)/memory" && npx tsc --noEmit 2>&1 | grep "app/(application)/memory" | head`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git branch --show-current   # feat/memory-area
git add "app/(application)/memory"
git commit -m "feat(memory): /memory/[ctx] base page with stats strip, list, filters and bulk actions"
```

---

### Task 8: `/memory/[ctx]/[id]` — memory detail

**Files:**
- Create: `app/(application)/memory/[ctx]/[id]/components/memory-detail-data.ts`, `memory-detail-data.test.ts`
- Create: `app/(application)/memory/[ctx]/[id]/page.tsx`, `components/memory-detail.tsx`

**Interfaces:**
- Consumes: Task 5 queries; `MemoryContext`, `MemoryItem`, `creatorName`, `visibilityKey` (Task 7); `VisibilityLabel` (Task 7 `memory-table.tsx`).
- Produces: `sourceQuote(messages)`, `detailActions(item, user)`.

- [ ] **Step 1: Write the failing tests**

`memory-detail-data.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { detailActions, sourceQuote } from "./memory-detail-data";

const msg = (o: unknown) => ({ content: JSON.stringify(o) });

describe("sourceQuote", () => {
  it("takes the first user message's text from parts or legacy content, trimmed and capped", () => {
    expect(sourceQuote([msg({ role: "assistant", parts: [{ type: "text", text: "Hi" }] }), msg({ role: "user", parts: [{ type: "text", text: "  Remember the gearbox tip  " }] })])).toBe("Remember the gearbox tip");
    expect(sourceQuote([msg({ role: "user", content: "legacy text" })])).toBe("legacy text");
    expect(sourceQuote([msg({ role: "user", parts: [{ type: "text", text: "x".repeat(300) }] })])).toBe("x".repeat(279) + "…");
  });
  it("returns null for no messages, unparseable rows, or no user turn", () => {
    expect(sourceQuote([])).toBeNull();
    expect(sourceQuote([{ content: "{not json" }])).toBeNull();
    expect(sourceQuote([msg({ role: "assistant", parts: [{ type: "text", text: "Hi" }] })])).toBeNull();
  });
});

describe("detailActions", () => {
  const item = { id: "m1", created_by: 9, rights_mode: "public", RBAC: { users: [{ id: "4", rights: "write" }, { id: "5", rights: "read" }] } };
  it("creator, super admin and explicit write grant may act; make-private only when not private", () => {
    expect(detailActions(item, { id: 9 })).toEqual({ canEdit: true, canMakePrivate: true, canDelete: true });
    expect(detailActions(item, { id: 1, super_admin: true })).toEqual({ canEdit: true, canMakePrivate: true, canDelete: true });
    expect(detailActions(item, { id: 4 })).toEqual({ canEdit: true, canMakePrivate: true, canDelete: true });
    expect(detailActions(item, { id: 5 })).toEqual({ canEdit: false, canMakePrivate: false, canDelete: false });
    expect(detailActions({ ...item, rights_mode: "private" }, { id: 9 })).toEqual({ canEdit: true, canMakePrivate: false, canDelete: true });
    expect(detailActions(item, undefined)).toEqual({ canEdit: false, canMakePrivate: false, canDelete: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "app/(application)/memory/[ctx]/[id]" --maxWorkers 2`
Expected: FAIL — module not found.

- [ ] **Step 3: Pure module**

`memory-detail-data.ts`:

```ts
/** Pure helpers for the memory detail page (spec §4.4). */
import type { MemoryItem } from "../../components/memory-list-data";

const QUOTE_MAX = 280;

/** First user turn of the source session, as a short quote; null when there is none. */
export function sourceQuote(messages: { content: string }[]): string | null {
  for (const m of messages) {
    let parsed: { role?: string; parts?: { type?: string; text?: string }[]; content?: unknown };
    try { parsed = JSON.parse(m.content); } catch { continue; }
    if (parsed?.role !== "user") continue;
    const text = Array.isArray(parsed.parts)
      ? parsed.parts.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join(" ")
      : typeof parsed.content === "string" ? parsed.content : "";
    const trimmed = text.trim();
    if (!trimmed) continue;
    return trimmed.length > QUOTE_MAX ? `${trimmed.slice(0, QUOTE_MAX - 1)}…` : trimmed;
  }
  return null;
}

export interface Viewer { id?: number | null; super_admin?: boolean | null }

/** Same rule as the chat's forget/update: creator, super admin, or an explicit write grant. */
export function detailActions(item: Pick<MemoryItem, "created_by" | "rights_mode" | "RBAC">, user: Viewer | undefined) {
  const id = user?.id;
  const isCreator = typeof id === "number" && item.created_by === id;
  const hasWrite = typeof id === "number" && !!item.RBAC?.users?.some((u) => String(u.id) === String(id) && u.rights === "write");
  const canEdit = !!user?.super_admin || isCreator || hasWrite;
  return { canEdit, canMakePrivate: canEdit && item.rights_mode !== "private", canDelete: canEdit };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run "app/(application)/memory/[ctx]/[id]" --maxWorkers 2`
Expected: PASS.

- [ ] **Step 5: Server page**

`app/(application)/memory/[ctx]/[id]/page.tsx`:

```tsx
/** /memory/[ctx]/[id] — one memory (spec §4.4). Server: guard + context, client detail. */
import { fetchGraphQLServerSide } from "@/lib/graphql/server";
import { guardRoute } from "@/lib/route-guard";

import { GET_MEMORY_BASE } from "../../queries";
import { NotFoundBase } from "../components/base-shell";
import type { MemoryContext } from "../components/memory-list-data";
import { MemoryDetail } from "./components/memory-detail";

export default async function MemoryDetailPage({ params }: { params: Promise<{ ctx: string; id: string }> }) {
  const denied = await guardRoute("memory");
  if (denied) return denied;
  const { ctx, id } = await params;
  const data = (await fetchGraphQLServerSide(GET_MEMORY_BASE.loc?.source.body ?? "", { id: ctx })) as
    | { contextById: MemoryContext | null } | null | undefined;
  const context = data?.contextById ?? null;
  if (!context) return <NotFoundBase contextId={ctx} />;
  return <MemoryDetail context={context} itemId={id} />;
}
```

- [ ] **Step 6: Detail component**

`components/memory-detail.tsx`:

```tsx
"use client";

import { useMutation, useQuery } from "@apollo/client";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";

import { UserContext } from "@/app/(application)/authenticated";
import { ConfirmDialog } from "@/components/primitives/confirm-dialog";
import { DetailSection } from "@/components/primitives/detail-section";
import { EmptyState } from "@/components/primitives/empty-state";
import { PageHeader } from "@/components/primitives/page-header";
import { PageShell } from "@/components/primitives/page-shell";
import { RelativeTime } from "@/components/primitives/relative-time";
import { SidePanel } from "@/components/primitives/side-panel";
import { RBACControl } from "@/components/rbac";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import {
  BULK_UPDATE_MEMORY_RBAC, DELETE_MEMORY_ITEM, GET_MEMORY_ITEM_BY_ID, GET_SOURCE_MESSAGES, GET_SOURCE_SESSION, GET_USERS_BY_IDS, MEMORY_ITEM_KEY,
} from "../../../queries";
import { type MemoryContext, type MemoryItem, type UserName, creatorName, hasSourceSession, visibilityKey } from "../../components/memory-list-data";
import { VisibilityLabel } from "../../components/memory-table";
import { detailActions, sourceQuote } from "./memory-detail-data";

type Rbac = { rights_mode: "private" | "users" | "roles" | "teams" | "public"; users: { id: number; rights: "read" | "write" }[]; roles: { id: string; rights: "read" | "write" }[]; teams: { id: string; rights: "read" | "write" }[] };

function SourceConversation({ sessionId }: { sessionId: string }) {
  const t = useTranslations("memory");
  const session = useQuery<{ agent_sessionById: { id: string; title?: string | null; agent: string } | null }>(GET_SOURCE_SESSION, { variables: { id: sessionId } });
  const messages = useQuery<{ agent_messagesPagination: { items: { id: string; content: string; createdAt: string }[] } }>(GET_SOURCE_MESSAGES, { variables: { session: sessionId } });
  const quote = sourceQuote(messages.data?.agent_messagesPagination.items ?? []);
  const s = session.data?.agent_sessionById;
  if (session.loading || messages.loading) return <Skeleton className="h-16 w-full" />;
  if (!s || !quote) return <p className="text-sm text-muted-foreground">{t("detail.noSource")}</p>;
  return (
    <div className="flex flex-col gap-2">
      <blockquote className="border-l-2 pl-3 text-sm text-muted-foreground">“{quote}”</blockquote>
      <Link href={`/chat/${s.agent}/${s.id}`} className="text-sm underline">{t("detail.openConversation")}</Link>
    </div>
  );
}

export function MemoryDetail({ context, itemId }: { context: MemoryContext; itemId: string }) {
  const t = useTranslations("memory");
  const tc = useTranslations("common");
  const router = useRouter();
  const { user } = React.useContext(UserContext) as { user?: { id?: number; super_admin?: boolean } };
  const withSource = hasSourceSession(context);

  const item = useQuery<{ [key: string]: MemoryItem | null }>(GET_MEMORY_ITEM_BY_ID(context.id, withSource), { variables: { id: itemId }, fetchPolicy: "cache-and-network" });
  const memory = item.data?.[MEMORY_ITEM_KEY(context.id)] ?? null;
  const users = useQuery<{ usersPagination: { items: UserName[] } }>(GET_USERS_BY_IDS, { skip: typeof memory?.created_by !== "number", variables: { ids: [memory?.created_by] } });
  const [updateRbac, updateState] = useMutation(BULK_UPDATE_MEMORY_RBAC(context.id));
  const [deleteItem] = useMutation(DELETE_MEMORY_ITEM(context.id));

  const [accessOpen, setAccessOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<Rbac | null>(null);
  const [privateOpen, setPrivateOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  if (item.loading && !item.data) {
    return <PageShell><Skeleton className="h-8 w-64" /><Skeleton className="h-40 w-full" /></PageShell>;
  }
  if (!memory) {
    return (
      <PageShell>
        <EmptyState title={t("empty.notAvailableTitle")} description={t("empty.notAvailableDescription")} action={{ label: t("empty.back"), href: `/memory/${context.id}` }} />
      </PageShell>
    );
  }

  const actions = detailActions(memory, user);
  const creator = creatorName(users.data?.usersPagination.items ?? [], memory.created_by) ?? t("detail.unknownUser");

  const makePrivate = async () => {
    try {
      await updateRbac({ variables: { ids: [memory.id], rights_mode: "private", rbac: null } });
      toast.success(t("detail.madePrivate"));
      setPrivateOpen(false);
      void item.refetch();
    } catch { toast.error(t("detail.failed")); }
  };
  const saveAccess = async () => {
    if (!draft) { setAccessOpen(false); return; }
    try {
      await updateRbac({ variables: { ids: [memory.id], rights_mode: draft.rights_mode, rbac: { users: draft.users, roles: draft.roles, teams: draft.teams } } });
      toast.success(t("detail.accessSaved"));
      setAccessOpen(false);
      void item.refetch();
    } catch { toast.error(t("detail.failed")); }
  };
  const remove = async () => {
    try {
      await deleteItem({ variables: { id: memory.id } });
      toast.success(t("detail.deleted"));
      router.push(`/memory/${context.id}`);
    } catch { toast.error(t("detail.failed")); }
  };

  return (
    <PageShell>
      <PageHeader
        breadcrumb={{ label: context.name, href: `/memory/${context.id}` }}
        title={memory.information ?? memory.name ?? ""}
      />
      <div className="-mt-4 flex items-center gap-2">
        <Badge variant="outline"><VisibilityLabel mode={memory.rights_mode} /></Badge>
        {memory.type && <Badge variant="secondary">{memory.type}</Badge>}
      </div>
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-6">
          <DetailSection title={t("detail.whySaved")}>
            <p className="text-sm">{memory.description?.trim() || <span className="text-muted-foreground">{t("detail.notRecorded")}</span>}</p>
          </DetailSection>
          <DetailSection title={t("detail.source")}>
            {memory.source_session ? <SourceConversation sessionId={memory.source_session} /> : <p className="text-sm text-muted-foreground">{t("detail.noSource")}</p>}
          </DetailSection>
        </div>
        <div className="flex flex-col gap-4">
          <DetailSection title={t("detail.details")}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("detail.whoCanSee")}</dt>
              <dd className="flex items-center gap-2">
                <VisibilityLabel mode={memory.rights_mode} />
                {actions.canEdit && <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setAccessOpen(true)}>{t("detail.change")}</Button>}
              </dd>
              <dt className="text-muted-foreground">{t("detail.createdBy")}</dt>
              <dd>{creator}</dd>
              <dt className="text-muted-foreground">{t("detail.created")}</dt>
              <dd>{memory.createdAt ? <RelativeTime date={memory.createdAt} /> : "—"}</dd>
              <dt className="text-muted-foreground">{t("detail.updated")}</dt>
              <dd>{memory.updatedAt ? <RelativeTime date={memory.updatedAt} /> : "—"}</dd>
            </dl>
          </DetailSection>
          <div className="flex flex-wrap gap-2">
            {actions.canEdit && <Button variant="outline" asChild><Link href={`/data/${context.id}/items/${memory.id}`}>{t("detail.editWording")}</Link></Button>}
            {actions.canMakePrivate && <Button variant="outline" onClick={() => setPrivateOpen(true)}>{t("detail.makePrivate")}</Button>}
            {actions.canDelete && <Button variant="destructive" onClick={() => setDeleteOpen(true)}>{t("detail.delete")}</Button>}
          </div>
        </div>
      </div>

      <SidePanel open={accessOpen} onOpenChange={setAccessOpen} title={t("detail.accessTitle")}>
        <div className="flex flex-col gap-4 p-4">
          <RBACControl
            subjectLabel={t("detail.accessSubject")}
            initialRightsMode={visibilityKey(memory.rights_mode)}
            initialUsers={(memory.RBAC?.users ?? undefined) as { id: string; rights: "read" | "write" }[] | undefined}
            initialRoles={(memory.RBAC?.roles ?? undefined) as { id: string; rights: "read" | "write" }[] | undefined}
            onChange={(rights_mode, users, roles, teams) => setDraft({ rights_mode, users, roles, teams: teams ?? [] } as Rbac)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setAccessOpen(false)}>{tc("cancel")}</Button>
            <Button onClick={saveAccess} disabled={updateState.loading}>{tc("save")}</Button>
          </div>
        </div>
      </SidePanel>
      <ConfirmDialog open={privateOpen} onOpenChange={setPrivateOpen} title={t("detail.makePrivateTitle")} description={t("detail.makePrivateDescription")} confirmLabel={t("detail.makePrivate")} onConfirm={makePrivate} />
      <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} variant="destructive" title={t("detail.deleteTitle")} description={t("detail.deleteDescription")} confirmLabel={t("detail.delete")} onConfirm={remove} />
    </PageShell>
  );
}
```

`PageHeader.description` is a string, so the badges sit in their own row under the header. `RBACControl` accepts `initialUsers: { id: string | number; rights }[]` and `initialRoles: { id: string; rights }[]`; the item's `RBAC.users`/`RBAC.roles` (string ids, `rights` typed as string in `MemoryItem`) are narrowed with the casts above.

- [ ] **Step 7: Lint and typecheck**

Run: `npx eslint "app/(application)/memory" && npx tsc --noEmit 2>&1 | grep "app/(application)/memory" | head`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git branch --show-current   # feat/memory-area
git add "app/(application)/memory"
git commit -m "feat(memory): /memory/[ctx]/[id] memory detail with access, make-private and delete"
```

---

### Task 9: Frontend verification and UAT handoff

**Files:** none new.

- [ ] **Step 1: Full checks (one at a time, no watch modes)**

```bash
npx vitest run --maxWorkers 2 2>&1 | tail -5
npm run check-messages
npm run lint 2>&1 | tail -5
npx tsc --noEmit 2>&1 | grep -c "error TS"
npm run build 2>&1 | tail -8
```
Expected: vitest all green; message parity OK; lint clean; tsc count equal to the pre-branch count (record it from `main` first with `git stash`-free means: run the same grep on the `frontend` primary checkout at `main`); build succeeds (Turbopack needs the worktree's real `node_modules`, see the repo-layout memory).

- [ ] **Step 2: Manual UAT list for Daniel (implementers do not start servers)**

1. Nav shows Memory under Build for an agents:read user; `/memory` lists Newton's base with agents and counts equal to the workbench cards.
2. A base referenced by an agent but absent from code is greyed "Not found in code" and not clickable.
3. `/memory/<ctx>`: search narrows on wording; Mine shows own memories; the Visibility/Type/Creator filters combine; "N of M visible to you" matches the counts.
4. Select two memories → Set access changes both; Delete asks for confirmation and removes both; a non-writable selection reports how many failed.
5. Detail: why-saved text, source quote and "Open conversation" (only for memories saved after the `source_session` field was added to Newton), Change access panel saves, Make private hides the memory from another user, Delete returns to the list.
6. A private memory of another user: counted on the base page, absent from the list, `/memory/<ctx>/<id>` shows "not available".
7. Demo mode: `/memory` renders the empty state, no console errors.

- [ ] **Step 3: Commit anything the checks changed, then hand off**

```bash
git status --short
git branch --show-current   # feat/memory-area
```

Report: test/lint/build results verbatim, the UAT list, and that nothing was pushed or merged.
