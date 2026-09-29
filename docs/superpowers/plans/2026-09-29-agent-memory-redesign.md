# Agent Memory Redesign (sub-project 1: memory core and chat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent memory visible and editable in chat and governable in the workbench, reusing the AI SDK approval flow as the save card, with zero new tables.

**Architecture:** Memory bases stay code-defined `ExuluContext`s that satisfy a small field contract. Three agent tools (`memory_remember`, `memory_update`, `memory_forget`) require approval; the chat renders a memory-specific approval card whose Save carries the user's edits (wording, type, access) in the approval reason, which the backend hands to the tool. Memories are recalled **once per turn** (user-scoped, limit from the new `agents.memory_config` json column), injected once into the system prompt, shown to the user as message metadata, and handed to the knowledge-search tool, which no longer fetches memories itself. A standalone Newlift regression eval (Task 8b) gates the recall change.

**Tech Stack:** Backend: TypeScript, Express, AI SDK 6 (`ai` 6.0.49), knex/Postgres, GraphQL (schema generated from `core-schema.ts`), jest (ts-jest, aliases `@SRC`, `@EE`, `@EXULU_TYPES`). Frontend: Next.js app router, shadcn/ui, Apollo, next-intl (en/de), vitest for pure modules.

**Spec:** `docs/superpowers/specs/2026-09-29-agent-memory-redesign-design.md` (backend repo, branch `feat/agent-memory`).

**Worktrees:** backend `/Users/daniel.claessen/Desktop/Projects/exulu/backend-agent-memory`, frontend `/Users/daniel.claessen/Desktop/Projects/exulu/frontend-agent-memory`, both on branch `feat/agent-memory`. Every command below runs inside the matching worktree. Verify the branch before each commit: `git branch --show-current` must print `feat/agent-memory`.

## Global Constraints

- Zero new database tables. The only schema change is `agents.memory_config` (json), added by `addMissingFields` on boot.
- Memory base contract: context fields must include `information` (`text` or `longText`) and `type` (`enum` with ≥ 1 value). Missing either → tools not registered, retrieval still runs, workbench warning.
- Memory tool ids are exactly `memory_remember`, `memory_update`, `memory_forget`; frontend detection keys on `tool-memory_remember` etc.
- Memory tools always require approval; the `approvedTools` ("Allow for this chat") shortcut never applies to them.
- Approval reason JSON is versioned `{ "v": 1, ... }`; a denial's reason is the literal string `declined`.
- `memory_config` defaults: `{ retrieval: { enabled: true, limit: 10 }, visibility: "ask", guests: { showRecalled: false } }`; limit clamped to 1..50.
- Guests (no `user.id`) never get memory tools; retrieval for guests stays public-only; `recalledMemories` metadata is omitted for guests unless `guests.showRecalled` is true.
- Message metadata never reaches the model; the injected memory block is the only model-visible memory text, and it uses the citation object `{item_name: …, item_id: …, context: …}`.
- Every destructive UI action (Forget, Turn off memory, Change store) confirms through the shared `ConfirmDialog`.
- Vocabulary (EN/DE): Memory/Gedächtnis, a memory/Erinnerung, Remember this?/Im Gedächtnis speichern?, Private/Privat, Public/Öffentlich, Recalled N memories/N Erinnerungen genutzt, Forget/Vergessen. No violet/purple accents.
- Conventional commits (`feat(memory): …`, `test(memory): …`, `docs(memory): …`); one commit per task at minimum.

## Review Focus

1. A user replies "remember that" for a fact containing quotes, newlines or `}` characters — the approval reason JSON must round-trip unchanged and the injected memory block must not break the citation regex (test in Task 2 and Task 3).
2. The model calls `memory_update` with an id of a memory the user cannot see (another user's private memory) — no card, no leak of the wording, output `memory_no_access` without a creator (test in Task 4).
3. Two users share a session (shared conversation): the approval must run as the session's current user, and RBAC rows must reference that user — never the session owner (test in Task 4: `execute` uses `params.user`, and Task 5: wrapper passes the request user).
4. The configured memory context is removed from code while agents still reference it — chat must keep working with a logged warning, no thrown error on the streaming path (test in Task 6).
5. A reloaded session with an old, unanswered approval card must not re-execute a save when the user answers it days later against a context whose `type` enum changed — the tool re-validates the type against the current enum and falls back to the first value (test in Task 4).

---

## Backend

### Task 1: Memory base contract, memory config and the `memory_config` column

**Files:**
- Create: `src/exulu/memory/memory-base.ts`
- Create: `src/exulu/memory/memory-base.test.ts`
- Create: `src/exulu/memory/config.ts`
- Create: `src/exulu/memory/config.test.ts`
- Modify: `src/postgres/core-schema.ts:257-260` (agents schema, after the `memory` column)
- Modify: `types/models/agent.ts:8` (add `memory_config`)

**Interfaces:**
- Produces: `checkMemoryBase(context): { ok: boolean; missing: string[] }`, `memoryTypeValues(context): string[]`, `MEMORY_REQUIRED_FIELDS`, `MemoryConfig`, `DEFAULT_MEMORY_CONFIG`, `resolveMemoryConfig(raw: unknown): MemoryConfig`.

- [ ] **Step 1: Write the failing tests**

`src/exulu/memory/memory-base.test.ts`:

```ts
import { checkMemoryBase, memoryTypeValues } from "./memory-base";

const ctx = (fields: { name: string; type: string; enumValues?: string[] }[]) => ({ fields } as any);

describe("checkMemoryBase", () => {
  it("accepts a Newton-style context (information text + type enum)", () => {
    const r = checkMemoryBase(ctx([
      { name: "information", type: "text" },
      { name: "type", type: "enum", enumValues: ["FACT", "PREFERENCE"] },
    ]));
    expect(r).toEqual({ ok: true, missing: [] });
  });

  it("accepts longText for information", () => {
    expect(checkMemoryBase(ctx([
      { name: "information", type: "longText" },
      { name: "type", type: "enum", enumValues: ["FACT"] },
    ])).ok).toBe(true);
  });

  it("reports both fields missing on an unrelated context", () => {
    expect(checkMemoryBase(ctx([{ name: "body", type: "text" }]))).toEqual({
      ok: false, missing: ["information", "type"],
    });
  });

  it("rejects a type field that is not an enum or has no values", () => {
    expect(checkMemoryBase(ctx([
      { name: "information", type: "text" },
      { name: "type", type: "text" },
    ])).missing).toEqual(["type"]);
    expect(checkMemoryBase(ctx([
      { name: "information", type: "text" },
      { name: "type", type: "enum", enumValues: [] },
    ])).missing).toEqual(["type"]);
  });

  it("treats a missing context as failing both", () => {
    expect(checkMemoryBase(undefined).missing).toEqual(["information", "type"]);
  });
});

describe("memoryTypeValues", () => {
  it("returns the enum values, or [] when the contract is not met", () => {
    expect(memoryTypeValues(ctx([{ name: "type", type: "enum", enumValues: ["A", "B"] }]))).toEqual(["A", "B"]);
    expect(memoryTypeValues(ctx([]))).toEqual([]);
  });
});
```

`src/exulu/memory/config.test.ts`:

```ts
import { DEFAULT_MEMORY_CONFIG, resolveMemoryConfig } from "./config";

describe("resolveMemoryConfig", () => {
  it("returns defaults for null, undefined and garbage", () => {
    expect(resolveMemoryConfig(null)).toEqual(DEFAULT_MEMORY_CONFIG);
    expect(resolveMemoryConfig(undefined)).toEqual(DEFAULT_MEMORY_CONFIG);
    expect(resolveMemoryConfig("not json")).toEqual(DEFAULT_MEMORY_CONFIG);
    expect(resolveMemoryConfig(42)).toEqual(DEFAULT_MEMORY_CONFIG);
  });

  it("accepts an object and a JSON string, filling gaps with defaults", () => {
    expect(resolveMemoryConfig({ retrieval: { limit: 5 } })).toEqual({
      retrieval: { enabled: true, limit: 5 }, visibility: "ask", guests: { showRecalled: false },
    });
    expect(resolveMemoryConfig('{"visibility":"preselect_private","guests":{"showRecalled":true}}')).toEqual({
      retrieval: { enabled: true, limit: 10 }, visibility: "preselect_private", guests: { showRecalled: true },
    });
  });

  it("clamps the limit to 1..50 and rejects unknown visibility values", () => {
    expect(resolveMemoryConfig({ retrieval: { limit: 0 } }).retrieval.limit).toBe(1);
    expect(resolveMemoryConfig({ retrieval: { limit: 500 } }).retrieval.limit).toBe(50);
    expect(resolveMemoryConfig({ retrieval: { limit: "12" } }).retrieval.limit).toBe(12);
    expect(resolveMemoryConfig({ visibility: "everyone" }).visibility).toBe("ask");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/memory -v`
Expected: FAIL — "Cannot find module './memory-base'" and "./config".

- [ ] **Step 3: Implement the modules**

`src/exulu/memory/memory-base.ts`:

```ts
/**
 * Memory base contract (spec §2.1). A context can serve as an agent's memory
 * store when it has an `information` text field (the memory wording) and a
 * `type` enum (memory type). Used by tool registration, the GraphQL Context
 * type (`memoryBase`) and the workbench picker.
 */
export const MEMORY_REQUIRED_FIELDS = ["information", "type"] as const;

export type MemoryBaseCheck = { ok: boolean; missing: string[] };

type FieldLike = { name: string; type: string; enumValues?: string[] | null };
type ContextLike = { fields?: FieldLike[] } | null | undefined;

const TEXT_TYPES = new Set(["text", "longText"]);

export function checkMemoryBase(context: ContextLike): MemoryBaseCheck {
  const fields = context?.fields ?? [];
  const missing: string[] = [];
  const information = fields.find((f) => f.name === "information");
  if (!information || !TEXT_TYPES.has(information.type)) missing.push("information");
  const type = fields.find((f) => f.name === "type");
  if (!type || type.type !== "enum" || !type.enumValues?.length) missing.push("type");
  return { ok: missing.length === 0, missing };
}

/** Enum values of the `type` field, or [] when the contract is not met. */
export function memoryTypeValues(context: ContextLike): string[] {
  const type = context?.fields?.find((f) => f.name === "type");
  if (!type || type.type !== "enum") return [];
  return [...(type.enumValues ?? [])];
}
```

`src/exulu/memory/config.ts`:

```ts
/**
 * agents.memory_config (spec §2.2). Stored as json; null means defaults.
 */
export type MemoryConfig = {
  retrieval: { enabled: boolean; limit: number };
  visibility: "ask" | "preselect_private";
  guests: { showRecalled: boolean };
};

export const MEMORY_LIMIT_MIN = 1;
export const MEMORY_LIMIT_MAX = 50;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  retrieval: { enabled: true, limit: 10 },
  visibility: "ask",
  guests: { showRecalled: false },
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function resolveMemoryConfig(raw: unknown): MemoryConfig {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { value = undefined; }
  }
  if (!isRecord(value)) return structuredClone(DEFAULT_MEMORY_CONFIG);

  const retrieval = isRecord(value.retrieval) ? value.retrieval : {};
  const guests = isRecord(value.guests) ? value.guests : {};
  const limitNum = Number(retrieval.limit);
  const limit = Number.isFinite(limitNum)
    ? Math.min(MEMORY_LIMIT_MAX, Math.max(MEMORY_LIMIT_MIN, Math.round(limitNum)))
    : DEFAULT_MEMORY_CONFIG.retrieval.limit;

  return {
    retrieval: {
      enabled: typeof retrieval.enabled === "boolean" ? retrieval.enabled : DEFAULT_MEMORY_CONFIG.retrieval.enabled,
      limit,
    },
    visibility: value.visibility === "preselect_private" ? "preselect_private" : "ask",
    guests: {
      showRecalled: typeof guests.showRecalled === "boolean" ? guests.showRecalled : DEFAULT_MEMORY_CONFIG.guests.showRecalled,
    },
  };
}
```

- [ ] **Step 4: Add the column and the type**

In `src/postgres/core-schema.ts`, directly after the `memory` field of the agents schema (line 257-260):

```ts
    {
      name: "memory_config",
      type: "json", // MemoryConfig (src/exulu/memory/config.ts); null = defaults
    },
```

In `types/models/agent.ts`, after `memory?: string;` (line 8):

```ts
    /** Memory behaviour (retrieval limit, visibility preselect, guest display). null = defaults. */
    memory_config?: Record<string, unknown> | string | null;
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx jest src/exulu/memory -v && npx tsc --noEmit -p tsconfig.json`
Expected: PASS (9 tests), no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/exulu/memory src/postgres/core-schema.ts types/models/agent.ts
git commit -m "feat(memory): memory base contract, memory_config column and resolver"
```

---

### Task 2: Approval decision channel (pure module)

**Files:**
- Create: `src/exulu/memory/decisions.ts`
- Create: `src/exulu/memory/decisions.test.ts`

**Interfaces:**
- Produces: `MEMORY_TOOL_IDS`, `MemoryToolId`, `isMemoryToolId(id)`, `isMemoryToolPartType(type)`, `MemoryDecision` (union), `parseMemoryDecision(reason: unknown): MemoryDecision | undefined`, `collectMemoryDecisions(messages: UIMessage[]): Map<string, MemoryDecision>`.

- [ ] **Step 1: Write the failing tests**

`src/exulu/memory/decisions.test.ts`:

```ts
import type { UIMessage } from "ai";
import { collectMemoryDecisions, isMemoryToolPartType, parseMemoryDecision } from "./decisions";

const remember = { v: 1, kind: "remember", title: "T", information: 'He said "no" }\nline2', type: "FACT", rights_mode: "private" };

describe("parseMemoryDecision", () => {
  it("round-trips quotes, braces and newlines in the wording", () => {
    expect(parseMemoryDecision(JSON.stringify(remember))).toEqual(remember);
  });
  it("rejects malformed json, wrong version and unknown kinds", () => {
    expect(parseMemoryDecision("declined")).toBeUndefined();
    expect(parseMemoryDecision(JSON.stringify({ ...remember, v: 2 }))).toBeUndefined();
    expect(parseMemoryDecision(JSON.stringify({ v: 1, kind: "flag" }))).toBeUndefined();
    expect(parseMemoryDecision(undefined)).toBeUndefined();
  });
  it("rejects an invalid rights_mode on remember", () => {
    expect(parseMemoryDecision(JSON.stringify({ ...remember, rights_mode: "everyone" }))).toBeUndefined();
  });
  it("accepts update with only the changed fields, and forget with none", () => {
    expect(parseMemoryDecision(JSON.stringify({ v: 1, kind: "update", information: "new" }))).toEqual({ v: 1, kind: "update", information: "new" });
    expect(parseMemoryDecision(JSON.stringify({ v: 1, kind: "forget" }))).toEqual({ v: 1, kind: "forget" });
  });
});

describe("isMemoryToolPartType", () => {
  it("matches only the three memory tool part types", () => {
    expect(isMemoryToolPartType("tool-memory_remember")).toBe(true);
    expect(isMemoryToolPartType("tool-memory_update")).toBe(true);
    expect(isMemoryToolPartType("tool-memory_forget")).toBe(true);
    expect(isMemoryToolPartType("tool-memory_remember_x")).toBe(false);
    expect(isMemoryToolPartType("tool-bash")).toBe(false);
    expect(isMemoryToolPartType("text")).toBe(false);
  });
});

describe("collectMemoryDecisions", () => {
  const msg = (parts: unknown[]): UIMessage => ({ id: "m", role: "assistant", parts } as unknown as UIMessage);

  it("collects approved memory parts keyed by toolCallId", () => {
    const m = msg([
      { type: "tool-memory_remember", toolCallId: "c1", state: "approval-responded", approval: { id: "a1", approved: true, reason: JSON.stringify(remember) } },
      { type: "tool-memory_forget", toolCallId: "c2", state: "approval-responded", approval: { id: "a2", approved: true, reason: JSON.stringify({ v: 1, kind: "forget" }) } },
    ]);
    const map = collectMemoryDecisions([m]);
    expect([...map.keys()]).toEqual(["c1", "c2"]);
    expect(map.get("c1")).toEqual(remember);
  });

  it("ignores denials, non-memory tools, unparseable reasons and user messages", () => {
    const m = msg([
      { type: "tool-memory_remember", toolCallId: "c1", state: "approval-responded", approval: { id: "a1", approved: false, reason: "declined" } },
      { type: "tool-bash", toolCallId: "c2", state: "approval-responded", approval: { id: "a2", approved: true, reason: JSON.stringify(remember) } },
      { type: "tool-memory_remember", toolCallId: "c3", state: "approval-responded", approval: { id: "a3", approved: true } },
    ]);
    const u = { id: "u", role: "user", parts: [{ type: "tool-memory_remember", toolCallId: "c4", approval: { approved: true, reason: JSON.stringify(remember) } }] } as unknown as UIMessage;
    expect(collectMemoryDecisions([m, u]).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/memory/decisions -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/exulu/memory/decisions.ts`:

```ts
import type { UIMessage } from "ai";
import { VALID_RIGHTS_MODES, type ExuluRightsMode } from "@EXULU_TYPES/rbac-rights-modes";

export const MEMORY_TOOL_IDS = ["memory_remember", "memory_update", "memory_forget"] as const;
export type MemoryToolId = (typeof MEMORY_TOOL_IDS)[number];

export const isMemoryToolId = (id: string): id is MemoryToolId =>
  (MEMORY_TOOL_IDS as readonly string[]).includes(id);

/** UI part types are "tool-<toolId>". */
export const isMemoryToolPartType = (type: string): boolean =>
  type.startsWith("tool-") && isMemoryToolId(type.slice("tool-".length));

export type RbacGrant = { id: number | string; rights: "read" | "write" };
export type MemoryRbacInput = { users?: RbacGrant[]; roles?: RbacGrant[]; teams?: RbacGrant[] };

export type MemoryDecision =
  | { v: 1; kind: "remember"; title: string; information: string; type: string; rights_mode: ExuluRightsMode; rbac?: MemoryRbacInput }
  | { v: 1; kind: "update"; information?: string; title?: string; type?: string }
  | { v: 1; kind: "forget" };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const optString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function parseMemoryDecision(reason: unknown): MemoryDecision | undefined {
  if (typeof reason !== "string") return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(reason); } catch { return undefined; }
  if (!isRecord(parsed) || parsed.v !== 1) return undefined;
  switch (parsed.kind) {
    case "remember": {
      const title = optString(parsed.title);
      const information = optString(parsed.information);
      const type = optString(parsed.type);
      const rights_mode = optString(parsed.rights_mode);
      if (title === undefined || information === undefined || type === undefined) return undefined;
      if (!rights_mode || !(VALID_RIGHTS_MODES as readonly string[]).includes(rights_mode)) return undefined;
      const rbac = isRecord(parsed.rbac) ? (parsed.rbac as MemoryRbacInput) : undefined;
      return { v: 1, kind: "remember", title, information, type, rights_mode: rights_mode as ExuluRightsMode, ...(rbac ? { rbac } : {}) };
    }
    case "update": {
      const out: MemoryDecision = { v: 1, kind: "update" };
      const information = optString(parsed.information);
      const title = optString(parsed.title);
      const type = optString(parsed.type);
      if (information !== undefined) out.information = information;
      if (title !== undefined) out.title = title;
      if (type !== undefined) out.type = type;
      return out;
    }
    case "forget":
      return { v: 1, kind: "forget" };
    default:
      return undefined;
  }
}

/**
 * Approved memory tool parts carry the user's edits in approval.reason.
 * Scans assistant messages only; keyed by toolCallId. The SDK only executes
 * still-pending approvals, so stale entries are harmless.
 */
export function collectMemoryDecisions(messages: UIMessage[]): Map<string, MemoryDecision> {
  const out = new Map<string, MemoryDecision>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of (message.parts ?? []) as unknown[]) {
      if (!isRecord(part) || typeof part.type !== "string" || !isMemoryToolPartType(part.type)) continue;
      const approval = isRecord(part.approval) ? part.approval : undefined;
      if (!approval || approval.approved !== true) continue;
      const toolCallId = optString(part.toolCallId);
      const decision = parseMemoryDecision(approval.reason);
      if (toolCallId && decision) out.set(toolCallId, decision);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/exulu/memory/decisions -v`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exulu/memory/decisions.ts src/exulu/memory/decisions.test.ts
git commit -m "feat(memory): parse approval-reason decisions for memory tools"
```

---

### Task 3: Recall collector and memory prompt block

**Files:**
- Create: `src/exulu/memory/recall-collector.ts`
- Create: `src/exulu/memory/recall-collector.test.ts`

**Interfaces:**
- Consumes: `VectorSearchChunkResult` (`src/graphql/resolvers/vector-search.ts:32`), `ExuluContext.getItems({ fields, filters, user, role })`.
- Produces: `RecalledMemory`, `MemoryItemRow`, `RecallCollector` with `constructor({ contextId, loadItems, loadUsers })`, `addFromChunks(chunks, source)`, `addRows(rows, source)`, `list(): RecalledMemory[]`; `buildMemoryPromptBlock(memories: RecalledMemory[]): string`; `createRecallCollector(context, user, db)`; `displayName(user)`.

- [ ] **Step 1: Write the failing tests**

`src/exulu/memory/recall-collector.test.ts`:

```ts
import { RecallCollector, buildMemoryPromptBlock, displayName, type MemoryItemRow } from "./recall-collector";

const row = (id: string, extra: Partial<MemoryItemRow> = {}): MemoryItemRow => ({
  id, name: `Title ${id}`, information: `Fact ${id}`, type: "FACT", rights_mode: "public",
  created_by: 7, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z", ...extra,
});
const chunk = (item_id: string) => ({ item_id, item_name: `Title ${item_id}`, chunk_content: "…" }) as any;

function make(rows: MemoryItemRow[], users = [{ id: 7, firstname: "Sara", lastname: "Kraus", email: "s@x.de" }]) {
  const loadItems = jest.fn(async (ids: string[]) => rows.filter((r) => ids.includes(r.id)));
  const loadUsers = jest.fn(async (ids: number[]) => users.filter((u) => ids.includes(u.id)));
  return { collector: new RecallCollector({ contextId: "mem", loadItems, loadUsers }), loadItems, loadUsers };
}

describe("RecallCollector", () => {
  it("loads item rows for chunks, de-duplicates by item id and resolves creator names once", async () => {
    const { collector, loadItems, loadUsers } = make([row("a"), row("b")]);
    await collector.addFromChunks([chunk("a"), chunk("a"), chunk("b")], "prefetch");
    await collector.addFromChunks([chunk("b")], "knowledge_search");
    expect(loadItems).toHaveBeenCalledTimes(1);
    expect(loadItems.mock.calls[0][0]).toEqual(["a", "b"]);
    expect(loadUsers).toHaveBeenCalledTimes(1);
    const list = collector.list();
    expect(list.map((m) => m.id)).toEqual(["a", "b"]);
    expect(list[0]).toMatchObject({ contextId: "mem", title: "Title a", information: "Fact a", type: "FACT",
      rights_mode: "public", createdBy: { id: 7, name: "Sara Kraus" }, source: "prefetch" });
  });

  it("skips chunks whose items are not visible (loader returns nothing) and keeps createdBy null when unknown", async () => {
    const { collector } = make([row("a", { created_by: null })], []);
    await collector.addFromChunks([chunk("a"), chunk("ghost")], "prefetch");
    expect(collector.list()).toHaveLength(1);
    expect(collector.list()[0].createdBy).toBeNull();
  });
});

describe("buildMemoryPromptBlock", () => {
  it("emits one citation object per memory that the frontend citation regex matches", () => {
    const block = buildMemoryPromptBlock([{
      id: "a1", contextId: "mem", title: 'Encoder "X12"', information: "Check X12 first }", type: "FACT",
      rights_mode: "private", createdBy: { id: 7, name: "Sara Kraus" }, createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z", source: "prefetch",
    }]);
    expect(block).toContain('{item_name: "Encoder X12", item_id: "a1", context: "mem"}');
    expect(block).toContain("Check X12 first }");
    expect(block).toContain("saved by Sara Kraus");
    expect(block).toContain("private");
    // Same regex as components/message-renderer.tsx flexibleCitationRegex
    expect(block.match(/\{[^}]*?item_name\s*:\s*[^,}]+[^}]*?\}/g)).toHaveLength(1);
  });
  it("returns an empty string for no memories", () => {
    expect(buildMemoryPromptBlock([])).toBe("");
  });
});

describe("displayName", () => {
  it("prefers first+last name, then email, then the id", () => {
    expect(displayName({ id: 1, firstname: "A", lastname: "B" })).toBe("A B");
    expect(displayName({ id: 1, email: "a@b.c" })).toBe("a@b.c");
    expect(displayName({ id: 1 })).toBe("User 1");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/memory/recall-collector -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/exulu/memory/recall-collector.ts`:

```ts
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluRightsMode } from "@EXULU_TYPES/rbac-rights-modes";
import type { VectorSearchChunkResult } from "@SRC/graphql/resolvers/vector-search";
import type { ExuluContext } from "@SRC/exulu/context";
import { applyAccessControl } from "@SRC/graphql/utilities/access-control";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";
import { getTableName } from "@SRC/exulu/table-names";

export type RecallSource = "prefetch" | "knowledge_search";

export type MemoryItemRow = {
  id: string; name?: string | null; information?: string | null; description?: string | null;
  type?: string | null; rights_mode?: string | null; created_by?: number | null;
  createdAt?: string | Date | null; updatedAt?: string | Date | null;
};

export type RecalledMemory = {
  id: string; contextId: string; title: string; information: string; type?: string;
  rights_mode: ExuluRightsMode; createdBy: { id: number; name: string } | null;
  createdAt: string; updatedAt: string; source: RecallSource;
};

type UserRow = { id: number; firstname?: string | null; lastname?: string | null; email?: string | null };

export const displayName = (u: UserRow): string => {
  const full = [u.firstname, u.lastname].filter((s) => s && s.trim()).join(" ").trim();
  if (full) return full;
  if (u.email && u.email.trim()) return u.email.trim();
  return `User ${u.id}`;
};

const iso = (v: string | Date | null | undefined): string =>
  v instanceof Date ? v.toISOString() : typeof v === "string" ? v : "";

export const MEMORY_ITEM_FIELDS = ["id", "name", "information", "description", "type", "rights_mode", "created_by", "createdAt", "updatedAt"];

/**
 * Request-scoped collector of memories the model was given this turn
 * (spec §3.1). Item rows come through the caller's RBAC-scoped loader, so a
 * chunk the user may not see never produces an entry.
 */
export class RecallCollector {
  private readonly items = new Map<string, RecalledMemory>();
  private readonly creators = new Map<number, string>();

  constructor(private readonly deps: {
    contextId: string;
    loadItems: (ids: string[]) => Promise<MemoryItemRow[]>;
    loadUsers: (ids: number[]) => Promise<UserRow[]>;
  }) {}

  async addFromChunks(chunks: VectorSearchChunkResult[], source: RecallSource): Promise<void> {
    const ids = [...new Set(chunks.map((c) => c.item_id).filter((id): id is string => !!id && !this.items.has(id)))];
    if (ids.length === 0) return;
    const rows = await this.deps.loadItems(ids);
    await this.addRows(rows, source);
  }

  async addRows(rows: MemoryItemRow[], source: RecallSource): Promise<void> {
    const creatorIds = [...new Set(rows.map((r) => r.created_by).filter((id): id is number => typeof id === "number" && !this.creators.has(id)))];
    if (creatorIds.length > 0) {
      for (const u of await this.deps.loadUsers(creatorIds)) this.creators.set(u.id, displayName(u));
    }
    for (const r of rows) {
      if (this.items.has(r.id)) continue;
      const createdBy = typeof r.created_by === "number" && this.creators.has(r.created_by)
        ? { id: r.created_by, name: this.creators.get(r.created_by)! }
        : null;
      this.items.set(r.id, {
        id: r.id, contextId: this.deps.contextId,
        title: (r.name ?? "").toString(), information: (r.information ?? r.description ?? "").toString(),
        ...(r.type ? { type: String(r.type) } : {}),
        rights_mode: (r.rights_mode ?? "private") as ExuluRightsMode,
        createdBy, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt), source,
      });
    }
  }

  list(): RecalledMemory[] { return [...this.items.values()]; }
}

/**
 * Loads memory item rows by id with the caller's RBAC applied (public rows,
 * own rows, shared rows). No user → public rows only, which is the guest rule.
 */
export async function loadVisibleMemoryRows(context: ExuluContext, ids: string[], user: User | undefined, db: any): Promise<MemoryItemRow[]> {
  if (ids.length === 0) return [];
  const table = convertContextToTableDefinition(context);
  const query = db(getTableName(context.id)).whereIn("id", ids).whereNot("archived", true).select(MEMORY_ITEM_FIELDS);
  return applyAccessControl(table, query, user);
}

/** Binds the collector to a context with the user's RBAC and a users lookup. */
export function createRecallCollector(context: ExuluContext, user: User | undefined, db: any): RecallCollector {
  return new RecallCollector({
    contextId: context.id,
    loadItems: (ids) => loadVisibleMemoryRows(context, ids, user, db),
    loadUsers: (ids) => db("users").whereIn("id", ids).select("id", "firstname", "lastname", "email"),
  });
}

const cite = (s: string) => s.replace(/[{}",]/g, " ").replace(/\s+/g, " ").trim();

/** Model-visible block (spec §3.1). Citation objects match the frontend regex. */
export function buildMemoryPromptBlock(memories: RecalledMemory[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map((m) => {
    const who = m.createdBy ? `saved by ${m.createdBy.name}` : "saved earlier";
    const when = m.createdAt ? ` on ${m.createdAt.slice(0, 10)}` : "";
    return `- {item_name: "${cite(m.title)}", item_id: "${m.id}", context: "${m.contextId}"} ${m.information} (${who}${when}, ${m.rights_mode})`;
  });
  return [
    "Memories: facts people saved earlier for this assistant. Use them where relevant and cite each memory you rely on",
    "with its citation object exactly as given, e.g. {item_name: <title>, item_id: <id>, context: <contextId>}.",
    ...lines,
  ].join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/exulu/memory/recall-collector -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exulu/memory/recall-collector.ts src/exulu/memory/recall-collector.test.ts
git commit -m "feat(memory): request-scoped recall collector and citation prompt block"
```

---

### Task 4: Memory tools (remember, update, forget)

**Files:**
- Create: `src/exulu/memory/tools.ts`
- Create: `src/exulu/memory/tools.test.ts`
- Modify: `src/exulu/tool.ts:42` (add `needsApprovalFn` property) and `:75-90` (constructor option)
- Modify: `src/templates/tools/context-write-tools.ts:104` (`export` `canonicalizeEnumFields`)
- Delete: `src/templates/tools/memory-tool.ts`, `src/templates/tools/memory-tool.test.ts`

**Interfaces:**
- Consumes: `checkMemoryBase`, `memoryTypeValues` (Task 1); `MemoryDecision`, `MEMORY_TOOL_IDS` (Task 2); `loadVisibleMemoryRows`, `displayName`, `MEMORY_ITEM_FIELDS` (Task 3); `context.createItem(item, config, userId, roleId, upsert)`, `context.updateItem(item, config, userId, roleId)`, `context.deleteItem(item, userId, roleId)`; `checkItemWriteAccess(context, record, user)`; `handleRBACUpdate(db, entitySingular, resourceId, rbac, existing)`.
- Produces: `createMemoryTools({ agent, context, user }): ExuluTool[]`; tool outputs `MemoryToolOutput` (`memory_saved` | `memory_updated` | `memory_forgotten` | `memory_no_access` | `memory_error`); execute reads `params.memoryDecision` (injected in Task 5); `ExuluTool.needsApprovalFn?: (input, options) => Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

`src/exulu/memory/tools.test.ts`:

```ts
jest.mock("@SRC/postgres/client", () => ({ postgresClient: jest.fn(async () => ({ db: mockDb })) }));
jest.mock("@EE/rbac-update.ts", () => ({ handleRBACUpdate: jest.fn(async () => undefined) }));
jest.mock("./recall-collector", () => ({
  ...jest.requireActual("./recall-collector"),
  loadVisibleMemoryRows: jest.fn(),
}));

import { handleRBACUpdate } from "@EE/rbac-update.ts";
import { createMemoryTools } from "./tools";
import { loadVisibleMemoryRows } from "./recall-collector";

const mockDb: any = Object.assign(jest.fn(() => mockDb), { whereIn: jest.fn(() => mockDb), select: jest.fn(async () => [{ id: 9, firstname: "Sara", lastname: "Kraus" }]) });

const createItem = jest.fn(async (item: any) => ({ item: { id: "new-1", ...item }, job: undefined }));
const updateItem = jest.fn(async (item: any) => ({ item, job: undefined }));
const deleteItem = jest.fn(async () => ({ id: "m1" }));
const context: any = {
  id: "newton_memory_context", name: "Newton memory",
  fields: [{ name: "information", type: "text" }, { name: "type", type: "enum", enumValues: ["FACT", "PREFERENCE"] }],
  createItem, updateItem, deleteItem,
};
const agent: any = { id: "agent-1", name: "Newton", memory: "newton_memory_context" };
const me = { id: 4, role: { id: "r1" } } as any;
const other = { id: 5, role: { id: "r1" } } as any;
const visible = loadVisibleMemoryRows as jest.Mock;

const tools = () => Object.fromEntries(createMemoryTools({ agent, context, user: me }).map((t) => [t.id, t]));
const base = { title: "Encoder first", information: "Check X12 before valves", type: "fact", whySaved: "Question about AZFR" };

beforeEach(() => { createItem.mockClear(); updateItem.mockClear(); deleteItem.mockClear(); (handleRBACUpdate as jest.Mock).mockClear(); visible.mockReset(); });

describe("memory_remember", () => {
  it("registers three approval-gated tools with fixed ids", () => {
    const ids = createMemoryTools({ agent, context, user: me }).map((t) => t.id);
    expect(ids).toEqual(["memory_remember", "memory_update", "memory_forget"]);
    expect(tools().memory_remember.needsApproval).toBe(true);
    expect(typeof tools().memory_update.needsApprovalFn).toBe("function");
    expect(typeof tools().memory_forget.needsApprovalFn).toBe("function");
  });

  it("writes the decision's wording, type and rights over the model input and applies rbac grants", async () => {
    const decision = { v: 1, kind: "remember", title: "Encoder first!", information: "Edited wording", type: "PREFERENCE", rights_mode: "users", rbac: { users: [{ id: 5, rights: "read" }] } };
    const out: any = await tools().memory_remember.tool.execute!({ ...base, user: me, exuluConfig: {}, memoryDecision: decision } as any, {} as any);
    expect(createItem).toHaveBeenCalledWith(
      { name: "Encoder first!", information: "Edited wording", type: "PREFERENCE", description: "Question about AZFR", rights_mode: "users" },
      {}, 4, "r1", false,
    );
    expect(handleRBACUpdate).toHaveBeenCalledWith(mockDb, expect.any(String), "new-1", decision.rbac, []);
    expect(out).toMatchObject({ type: "memory_saved", itemId: "new-1", contextId: "newton_memory_context", rights_mode: "users", information: "Edited wording" });
  });

  it("falls back to the model input and the context default when there is no decision, normalising the enum", async () => {
    const out: any = await tools().memory_remember.tool.execute!({ ...base, user: me, exuluConfig: {} } as any, {} as any);
    expect(createItem.mock.calls[0][0]).toEqual({ name: "Encoder first", information: "Check X12 before valves", type: "FACT", description: "Question about AZFR" });
    expect(handleRBACUpdate).not.toHaveBeenCalled();
    expect(out.type).toBe("memory_saved");
  });

  it("re-validates a stale decision type against the current enum (falls back to the first value)", async () => {
    const decision = { v: 1, kind: "remember", title: "T", information: "I", type: "DECISION", rights_mode: "private" };
    await tools().memory_remember.tool.execute!({ ...base, user: me, exuluConfig: {}, memoryDecision: decision } as any, {} as any);
    expect(createItem.mock.calls[0][0].type).toBe("FACT");
  });

  it("refuses without a signed-in user and reports write failures as memory_error", async () => {
    const guest: any = await tools().memory_remember.tool.execute!({ ...base, exuluConfig: {} } as any, {} as any);
    expect(guest.type).toBe("memory_error");
    createItem.mockRejectedValueOnce(new Error("boom"));
    const failed: any = await tools().memory_remember.tool.execute!({ ...base, user: me, exuluConfig: {} } as any, {} as any);
    expect(failed).toMatchObject({ type: "memory_error", message: "boom" });
  });
});

describe("memory_update / memory_forget", () => {
  const mine = { id: "m1", name: "Old", information: "Old fact", type: "FACT", rights_mode: "private", created_by: 4 };
  const theirs = { id: "m2", name: "Theirs", information: "Their fact", type: "FACT", rights_mode: "public", created_by: 9 };

  it("needs approval when the item is visible and writable, not otherwise", async () => {
    visible.mockResolvedValueOnce([mine]);
    expect(await tools().memory_update.needsApprovalFn!({ memoryId: "m1" }, { toolCallId: "c", messages: [] })).toBe(true);
    visible.mockResolvedValueOnce([theirs]);
    expect(await tools().memory_update.needsApprovalFn!({ memoryId: "m2" }, { toolCallId: "c", messages: [] })).toBe(false);
    visible.mockResolvedValueOnce([]);
    expect(await tools().memory_forget.needsApprovalFn!({ memoryId: "nope" }, { toolCallId: "c", messages: [] })).toBe(false);
  });

  it("update merges the decision over the input and patches through updateItem", async () => {
    visible.mockResolvedValue([mine]);
    const out: any = await tools().memory_update.tool.execute!({ memoryId: "m1", information: "Model wording", reason: "user corrected", user: me, exuluConfig: {}, memoryDecision: { v: 1, kind: "update", information: "User wording" } } as any, {} as any);
    expect(updateItem).toHaveBeenCalledWith({ id: "m1", information: "User wording" }, {}, 4, "r1");
    expect(out).toMatchObject({ type: "memory_updated", itemId: "m1", information: "User wording" });
  });

  it("update on someone else's public memory returns memory_no_access with the creator, and never writes", async () => {
    visible.mockResolvedValue([theirs]);
    const out: any = await tools().memory_update.tool.execute!({ memoryId: "m2", information: "x", reason: "r", user: me, exuluConfig: {} } as any, {} as any);
    expect(updateItem).not.toHaveBeenCalled();
    expect(out).toMatchObject({ type: "memory_no_access", itemId: "m2", createdBy: { id: 9, name: "Sara Kraus" } });
  });

  it("update on an invisible memory returns memory_no_access without wording or creator", async () => {
    visible.mockResolvedValue([]);
    const out: any = await tools().memory_update.tool.execute!({ memoryId: "secret", information: "x", reason: "r", user: me, exuluConfig: {} } as any, {} as any);
    expect(out).toEqual({ type: "memory_no_access", contextId: "newton_memory_context", itemId: "secret", title: null, createdBy: null, result: expect.any(String) });
  });

  it("forget deletes an own memory and refuses someone else's", async () => {
    visible.mockResolvedValue([mine]);
    const ok: any = await tools().memory_forget.tool.execute!({ memoryId: "m1", reason: "r", user: me, exuluConfig: {} } as any, {} as any);
    expect(deleteItem).toHaveBeenCalledWith({ id: "m1" }, 4, "r1");
    expect(ok).toMatchObject({ type: "memory_forgotten", itemId: "m1", title: "Old" });
    visible.mockResolvedValue([theirs]);
    const no: any = await tools().memory_forget.tool.execute!({ memoryId: "m2", reason: "r", user: other, exuluConfig: {} } as any, {} as any);
    expect(no.type).toBe("memory_no_access");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/memory/tools -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Extend `ExuluTool` and export the enum helper**

In `src/exulu/tool.ts`:
- After `public needsApproval: boolean;` (line 42) add:

```ts
  /**
   * Dynamic approval check (memory tools): decides per call whether the
   * approval card is shown. When set, the AI SDK wrapper uses it instead of
   * the boolean and never applies the "Allow for this chat" shortcut.
   */
  public needsApprovalFn?: (input: unknown, options: { toolCallId: string; messages: unknown[] }) => Promise<boolean>;
```

- In `src/templates/tools/context-write-tools.ts:104` change `const canonicalizeEnumFields = (` to `export const canonicalizeEnumFields = (`.

- [ ] **Step 4: Implement the tools**

`src/exulu/memory/tools.ts`:

```ts
import { z } from "zod";
import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluRightsMode } from "@EXULU_TYPES/rbac-rights-modes";
import type { ExuluContext } from "@SRC/exulu/context";
import { ExuluTool } from "@SRC/exulu/tool";
import { postgresClient } from "@SRC/postgres/client";
import { checkItemWriteAccess } from "@SRC/utils/check-item-write-access";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";
import { handleRBACUpdate } from "@EE/rbac-update.ts";
import { memoryTypeValues } from "./memory-base";
import type { MemoryDecision } from "./decisions";
import { displayName, loadVisibleMemoryRows, type MemoryItemRow } from "./recall-collector";

export type MemoryToolOutput =
  | { type: "memory_saved" | "memory_updated"; contextId: string; itemId: string; title: string; information: string; memoryType?: string; rights_mode: ExuluRightsMode; result: string }
  | { type: "memory_forgotten"; contextId: string; itemId: string; title: string; result: string }
  | { type: "memory_no_access"; contextId: string; itemId: string; title: string | null; createdBy: { id: number; name: string } | null; result: string }
  | { type: "memory_error"; message: string; result: string };

type ToolParams = Record<string, any> & { user?: User; exuluConfig?: any; memoryDecision?: MemoryDecision };

const err = (message: string): MemoryToolOutput => ({ type: "memory_error", message, result: `Memory operation failed: ${message}` });

/** Case-insensitive match against the context's type enum; first value when unknown. */
const resolveType = (context: ExuluContext, raw: unknown): string | undefined => {
  const values = memoryTypeValues(context);
  if (values.length === 0) return undefined;
  const wanted = String(raw ?? "").toUpperCase();
  return values.find((v) => v.toUpperCase() === wanted) ?? values[0];
};

async function creatorOf(row: MemoryItemRow, db: any): Promise<{ id: number; name: string } | null> {
  if (typeof row.created_by !== "number") return null;
  const [u] = await db("users").whereIn("id", [row.created_by]).select("id", "firstname", "lastname", "email");
  return u ? { id: u.id, name: displayName(u) } : null;
}

async function findVisible(context: ExuluContext, id: string, user: User | undefined): Promise<{ row?: MemoryItemRow; db: any }> {
  const { db } = await postgresClient();
  const [row] = await loadVisibleMemoryRows(context, [id], user, db);
  return { row, db };
}

export function createMemoryTools({ agent, context, user }: { agent: ExuluAgent; context: ExuluContext; user?: User }): ExuluTool[] {
  const types = memoryTypeValues(context);
  const typeSchema = types.length > 0 ? z.enum(types as [string, ...string[]]) : z.string();
  const category = `${agent.name}_memory`;

  const remember = new ExuluTool({
    id: "memory_remember",
    name: "Remember",
    category,
    type: "function",
    config: [],
    needsApproval: true,
    description:
      `Propose saving ONE fact, preference, decision or instruction the user shared to ${agent.name}'s long-term memory. ` +
      `The user reviews the wording and who can see it on a card before anything is saved; never ask about visibility yourself ` +
      `unless the user raised it, and never claim something was saved until this tool returns memory_saved. ` +
      `Call it once per fact, in the user's own words.`,
    inputSchema: z.object({
      title: z.string().describe("Short title, max 80 characters"),
      information: z.string().describe("The fact in one or two sentences, in the user's own words"),
      type: typeSchema.describe(`Memory type. One of: ${types.join(", ")}`),
      whySaved: z.string().describe("Why this is worth remembering: the question or topic that triggered it"),
      visibility: z.enum(["private", "public"]).optional().describe("Only when the user explicitly said who may see it"),
    }),
    execute: async (params: ToolParams): Promise<MemoryToolOutput> => {
      const { user: u, exuluConfig, memoryDecision } = params;
      if (!u?.id) return err("Memory requires a signed-in user.");
      const d = memoryDecision?.kind === "remember" ? memoryDecision : undefined;
      const information = String(d?.information ?? params.information ?? "").trim();
      const title = String(d?.title ?? params.title ?? information.slice(0, 80)).trim();
      if (!information) return err("The memory wording is empty.");
      const type = resolveType(context, d?.type ?? params.type);
      const rights_mode: ExuluRightsMode | undefined =
        d?.rights_mode ?? (params.visibility === "public" ? "public" : params.visibility === "private" ? "private" : undefined);
      try {
        const { item } = await context.createItem(
          { name: title, information, ...(type ? { type } : {}), description: String(params.whySaved ?? ""), ...(rights_mode ? { rights_mode } : {}) },
          exuluConfig, u.id, u.role?.id, false,
        );
        if (!item?.id) return err("The memory could not be created.");
        if (d?.rbac && (d.rbac.users?.length || d.rbac.roles?.length || d.rbac.teams?.length)) {
          const { db } = await postgresClient();
          await handleRBACUpdate(db, convertContextToTableDefinition(context).name.singular, item.id, d.rbac, []);
        }
        const mode = (item.rights_mode ?? rights_mode ?? "private") as ExuluRightsMode;
        return { type: "memory_saved", contextId: context.id, itemId: item.id, title, information, ...(type ? { memoryType: type } : {}), rights_mode: mode, result: `Saved memory "${title}" (${mode}).` };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  const needsWriteApproval = async (input: unknown): Promise<boolean> => {
    const id = typeof (input as any)?.memoryId === "string" ? (input as any).memoryId : "";
    if (!id || !user?.id) return false;
    const { row } = await findVisible(context, id, user);
    return !!row && (await checkItemWriteAccess(context, row, user));
  };

  const noAccess = async (id: string, row: MemoryItemRow | undefined, db: any): Promise<MemoryToolOutput> => {
    const createdBy = row ? await creatorOf(row, db) : null;
    const title = row?.name ?? null;
    const result = createdBy
      ? `This memory was saved by ${createdBy.name}; only they or an admin can change it. Suggest asking them.`
      : "No memory with that id is available to this user.";
    return { type: "memory_no_access", contextId: context.id, itemId: id, title, createdBy, result };
  };

  const update = new ExuluTool({
    id: "memory_update",
    name: "Update memory",
    category,
    type: "function",
    config: [],
    needsApproval: true,
    description:
      `Propose a correction to an existing memory of ${agent.name} (use the item_id from the memory block). ` +
      `Only the person who saved it, people with write access, or admins can change it; otherwise the result names the creator so you can suggest asking them. ` +
      `The user confirms on a card before anything changes.`,
    inputSchema: z.object({
      memoryId: z.string().describe("item_id of the memory to change"),
      information: z.string().optional().describe("New wording, if it changes"),
      title: z.string().optional(),
      type: typeSchema.optional(),
      reason: z.string().describe("What the user said that contradicts or refines the memory"),
    }),
    execute: async (params: ToolParams): Promise<MemoryToolOutput> => {
      const { user: u, exuluConfig, memoryDecision } = params;
      if (!u?.id) return err("Memory requires a signed-in user.");
      const id = String(params.memoryId ?? "");
      const { row, db } = await findVisible(context, id, u);
      if (!row || !(await checkItemWriteAccess(context, row, u))) return noAccess(id, row, db);
      const d = memoryDecision?.kind === "update" ? memoryDecision : undefined;
      const patch: Record<string, unknown> = { id };
      const information = d?.information ?? params.information;
      const title = d?.title ?? params.title;
      const typeRaw = d?.type ?? params.type;
      if (typeof information === "string" && information.trim()) patch.information = information.trim();
      if (typeof title === "string" && title.trim()) patch.name = title.trim();
      if (typeRaw !== undefined) { const t = resolveType(context, typeRaw); if (t) patch.type = t; }
      if (Object.keys(patch).length === 1) return err("Nothing to change.");
      try {
        await context.updateItem(patch, exuluConfig, u.id, u.role?.id);
        const finalTitle = (patch.name as string) ?? row.name ?? "";
        const finalInfo = (patch.information as string) ?? row.information ?? "";
        return { type: "memory_updated", contextId: context.id, itemId: id, title: finalTitle, information: finalInfo, ...(patch.type ? { memoryType: String(patch.type) } : {}), rights_mode: (row.rights_mode ?? "private") as ExuluRightsMode, result: `Updated memory "${finalTitle}".` };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });
  update.needsApprovalFn = needsWriteApproval;

  const forget = new ExuluTool({
    id: "memory_forget",
    name: "Forget memory",
    category,
    type: "function",
    config: [],
    needsApproval: true,
    description:
      `Propose deleting one of ${agent.name}'s memories when the user asks to forget it (use the item_id from the memory block). ` +
      `Same access rule as update_memory; the user confirms on a card before anything is deleted.`,
    inputSchema: z.object({
      memoryId: z.string().describe("item_id of the memory to delete"),
      reason: z.string().describe("What the user said"),
    }),
    execute: async (params: ToolParams): Promise<MemoryToolOutput> => {
      const { user: u } = params;
      if (!u?.id) return err("Memory requires a signed-in user.");
      const id = String(params.memoryId ?? "");
      const { row, db } = await findVisible(context, id, u);
      if (!row || !(await checkItemWriteAccess(context, row, u))) return noAccess(id, row, db);
      try {
        await context.deleteItem({ id }, u.id, u.role?.id);
        return { type: "memory_forgotten", contextId: context.id, itemId: id, title: row.name ?? "", result: `Forgot memory "${row.name ?? id}".` };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });
  forget.needsApprovalFn = needsWriteApproval;

  return [remember, update, forget];
}
```

- [ ] **Step 5: Delete the old tool and run the tests**

```bash
git rm -q src/templates/tools/memory-tool.ts src/templates/tools/memory-tool.test.ts
npx jest src/exulu/memory -v
```
Expected: PASS. (`convert-exulu-tools-to-ai-sdk-tools.ts` still imports the deleted file; Task 5 replaces that import. Until then `npx tsc --noEmit` reports one missing-module error in that file, which is expected.)

- [ ] **Step 6: Commit**

```bash
git add src/exulu/memory/tools.ts src/exulu/memory/tools.test.ts src/exulu/tool.ts src/templates/tools/context-write-tools.ts
git commit -m "feat(memory): remember/update/forget tools with approval-driven writes"
```

---

### Task 5: Register the memory tools, pass decisions through the tool wrapper, make knowledge search consume the recalled set

**Files:**
- Modify: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts:23` (import), `:168-186` (signature), `:256-273` (registration block), `:316-360` (both `createAgenticRetrievalTool` calls), `:469-478` (needsApproval), `:591-600` (execute params)
- Modify: `ee/agentic-retrieval/pipeline/index.ts:371` (stop passing `memoryContext` to the memory phase) and `:416` (stop re-appending memory chunks to the tool result)
- Modify: `ee/agentic-retrieval/pipeline/memory.ts` (remove the keyword recall and the item cache; the phase judges the recalled set only) and `ee/agentic-retrieval/pipeline/memory.test.ts`
- Modify: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts:63-69` (fix the misaligned helper) and append new tests

**Interfaces:**
- Consumes: `createMemoryTools` (Task 4), `checkMemoryBase` (Task 1), `MemoryDecision`, `isMemoryToolId` (Task 2).
- Produces: one new trailing parameter on `convertExuluToolsToAiSdkTools(..., sessionOwnerId?, memoryDecisions?: Map<string, MemoryDecision>)`; `params.memoryDecision` inside every tool `execute`; the pipeline's memory phase consumes only the recalled `memoryItems` it already receives (spec §3.1 "recall once").

- [ ] **Step 1: Repair the pre-existing test baseline**

The helper in `convert-exulu-tools-to-ai-sdk-tools.test.ts:63-69` passes one `undefined` too many before the contexts array, so `project` lands in `sessionItems`. Replace the helper with:

```ts
const call = (currentTools: unknown[], opts?: { project?: string; disabledTools?: string[]; agent?: unknown; user?: unknown }) =>
  convertExuluToolsToAiSdkTools(
    currentTools as never, [], [], [], [],
    [docsContext, otherContext] as never, opts?.user as never, undefined, undefined, undefined,
    opts?.project, undefined, model, opts?.agent as never, undefined, undefined,
    opts?.disabledTools,
  );
```

Run: `npx jest src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts`
Expected: the 12 previously failing tests PASS. Commit this alone:

```bash
git add src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts
git commit -m "test(tools): realign convert helper with the current parameter list"
```

- [ ] **Step 2: Write the failing registration tests**

Append to `convert-exulu-tools-to-ai-sdk-tools.test.ts`:

```ts
describe("memory tool registration", () => {
  const memoryContext = {
    id: "newton_memory_context", name: "Newton memory",
    fields: [{ name: "information", type: "text" }, { name: "type", type: "enum", enumValues: ["FACT"] }],
  } as never;
  const agent = { id: "a1", name: "Newton", memory: "newton_memory_context" } as never;
  const user = { id: 4, role: { id: "r1" } } as never;
  const callWith = (opts: { user?: unknown; agent?: unknown; contexts?: unknown[]; decisions?: Map<string, unknown> }) =>
    convertExuluToolsToAiSdkTools(
      [] as never, [], [], [], [],
      (opts.contexts ?? [memoryContext]) as never, opts.user as never, undefined, undefined, undefined,
      undefined, undefined, model, (opts.agent ?? agent) as never, undefined, undefined,
      undefined, undefined, opts.decisions as never,
    );

  it("registers remember/update/forget for a signed-in user on a valid memory base", async () => {
    const tools = await callWith({ user });
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(["Remember", "Update_memory", "Forget_memory"]));
    expect((tools as any).Remember.needsApproval).toBe(true);
    expect(typeof (tools as any).Update_memory.needsApproval).toBe("function");
  });

  it("registers nothing for guests (no user id) and for a context failing the contract", async () => {
    expect(Object.keys(await callWith({}))).toEqual([]);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const bad = { id: "newton_memory_context", name: "x", fields: [{ name: "body", type: "text" }] } as never;
    expect(Object.keys(await callWith({ user, contexts: [bad] }))).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a valid memory base"));
    warn.mockRestore();
  });

  it("warns instead of throwing when the configured memory context is missing", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(callWith({ user, contexts: [docsContext] })).resolves.toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("was not found"));
    warn.mockRestore();
  });

  it("never applies the pre-approval shortcut to memory tools", async () => {
    const tools = await convertExuluToolsToAiSdkTools(
      [] as never, [], ["tool-Remember", "tool-memory_remember"], [], [],
      [memoryContext] as never, user, undefined, undefined, undefined,
      undefined, undefined, model, agent, undefined, undefined, undefined,
    );
    expect((tools as any).Remember.needsApproval).toBe(true);
  });

  it("hands the matching decision to the wrapped execute by toolCallId", async () => {
    const seen: any[] = [];
    const fake = {
      id: "memory_forget", name: "Forget memory", description: "d", type: "function", category: "m", needsApproval: true, config: [],
      tool: { execute: jest.fn(async (p: any) => { seen.push(p); return { type: "memory_forgotten" }; }) },
    } as never;
    const decisions = new Map([["call-1", { v: 1, kind: "forget" }]]);
    const tools = await convertExuluToolsToAiSdkTools(
      [fake] as never, [], [], [], [], [] as never, user, undefined, undefined, undefined,
      undefined, undefined, model, agent, undefined, undefined, undefined, undefined, decisions as never,
    );
    // The wrapper's execute is an async generator — drain it.
    for await (const _chunk of (tools as any).Forget_memory.execute({ memoryId: "m1" }, { toolCallId: "call-1", messages: [] })) { /* drain */ }
    expect(seen[0].memoryDecision).toEqual({ v: 1, kind: "forget" });
    expect(seen[0].user).toBe(user);
  });
});
```

Run: `npx jest src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts -t "memory tool registration"`
Expected: FAIL — `Remember` not registered / import of deleted `./memory-tool`.

- [ ] **Step 3: Replace the registration block and extend the wrapper**

In `convert-exulu-tools-to-ai-sdk-tools.ts`:

1. Replace line 23 `import { createNewMemoryItemTool } from "./memory-tool";` with:

```ts
import { createMemoryTools } from "@SRC/exulu/memory/tools";
import { checkMemoryBase } from "@SRC/exulu/memory/memory-base";
import { isMemoryToolId, type MemoryDecision } from "@SRC/exulu/memory/decisions";
```

2. Extend the signature after `sessionOwnerId?: number | string,` (line 186):

```ts
  /** Approved memory cards → edits keyed by toolCallId (spec §3.2). */
  memoryDecisions?: Map<string, MemoryDecision>,
```

3. Replace the block at lines 256-273 (`if (agent?.memory && contexts?.length) { … createNewMemoryTool … }`) with:

```ts
  if (agent?.memory) {
    const memoryContext = contexts.find((context) => context.id === agent.memory);
    if (!memoryContext) {
      console.warn(
        `[EXULU] memory: context "${agent.memory}" configured on agent "${agent.id}" was not found; memory tools off for this turn.`,
      );
    } else if (user?.id) {
      const check = checkMemoryBase(memoryContext);
      if (check.ok) {
        for (const memoryTool of createMemoryTools({ agent, context: memoryContext, user })) {
          if (!disabled.has(memoryTool.id)) {
            currentTools = currentTools ?? [];
            currentTools.push(memoryTool);
          }
        }
      } else {
        console.warn(
          `[EXULU] memory: context "${memoryContext.id}" is not a valid memory base (missing: ${check.missing.join(", ")}); memory tools not registered.`,
        );
      }
    }
  }
```

4. The two `createAgenticRetrievalTool({ … memoryItems, … })` calls (around lines 316-360) stay as they are: `memoryItems` is the recalled set and keeps flowing into the pipeline.

5. Replace the `needsApproval:` line (478) with:

```ts
          needsApproval: cur.needsApprovalFn
            ? (input: unknown, opts: { toolCallId: string; messages: unknown[] }) => cur.needsApprovalFn!(input, opts)
            : isMemoryToolId(cur.id)
              ? true
              : (approvedTools?.includes("tool-" + cur.name) || !cur.needsApproval) ? false : true,
```

6. In the execute params object (line 591-600, the `cur.tool.execute({ ...inputs, model, sessionID, … })` call) add:

```ts
                memoryDecision: memoryDecisions?.get(options?.toolCallId ?? ""),
```

- [ ] **Step 4: Make the knowledge-search memory phase consume the recalled set only**

Write the failing pipeline tests first. In `ee/agentic-retrieval/pipeline/memory.test.ts` delete every test that exercises `recallMemoryByKeywords`, `loadMemoryItems` or `clearMemoryItemCache` (grep the file for those names), and add:

```ts
it("runMemoryPhase judges only the chunks it is given and never searches", async () => {
  const search = jest.fn();
  const r = await runMemoryPhase({
    memoryChunks: [], question: "q", keywords: ["k"], importantKeyword: "k", user: { id: 1 }, role: "r",
    model: {} as never, memoryConfig: { enabled: true, override: true, filePrioritization: true, queryAugmentation: true },
    glossary: [], documentContexts: [{ id: "docs", search } as never],
  });
  expect(search).not.toHaveBeenCalled();
  expect(r.memoryChunksForAnswer).toEqual([]);
  expect(r.memoryOverride.active).toBe(false);
});
```

Run: `npx jest ee/agentic-retrieval/pipeline/memory.test.ts` → the new test FAILS on the type error (`memoryContext` is still expected) or on the removed exports.

Then in `ee/agentic-retrieval/pipeline/memory.ts`:
- Delete `memoryItemCache`, `clearMemoryItemCache`, `loadMemoryItems`, `recallMemoryByKeywords` and the `ITEM_CACHE_TTL_MS` constant, plus the now-unused imports (`singleSearch`, `deriveKeywordVariants`, `normalizeFileName`, `stripSeparators` — keep any that other functions in the file still use).
- In `runMemoryPhase`: remove the `memoryContext` parameter from the signature and its type, change the early return to `if (!memoryConfig.enabled || memoryChunks.length === 0) return neutralResult(question, keywords, importantKeyword);`, and delete the whole `if (memoryContext) { … keywordMatched … }` block so `retrieved_memory` is just `[...memoryChunks]`.

In `ee/agentic-retrieval/pipeline/index.ts`:
- Line 371: remove `memoryContext,` from the `runMemoryPhase({ … })` call (the `memoryContext` option of `createAgenticRetrievalTool` stays, since `convert-exulu-tools` still uses it to exclude the memory context from the searchable set).
- Line 415-416: delete the comment `// Memory citable chunks go first (insertion-order dedup)` and the line `addChunks(result, memResult.memoryChunksForAnswer);`. The model already holds these memories with citation ids from the system prompt; the override directive (line ~680) is unchanged.

Search the repo for other callers: `grep -rn "recallMemoryByKeywords\|clearMemoryItemCache\|memoryContext:" ee src --include="*.ts"` — remove or adjust each (tests that reset the cache in `beforeEach` drop that line).

Run: `npx jest ee/agentic-retrieval -v` → PASS.

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx jest src/templates/tools src/exulu/memory ee/agentic-retrieval -v && npx tsc --noEmit -p tsconfig.json`
Expected: PASS; the only remaining type error is `generate-stream.ts` (the two call sites still compile — new params are optional).

- [ ] **Step 6: Commit**

```bash
git add src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts ee/agentic-retrieval/pipeline/index.ts ee/agentic-retrieval/pipeline/memory.ts ee/agentic-retrieval/pipeline/memory.test.ts
git commit -m "feat(memory): register memory tools, route decisions, and make knowledge search consume the recalled set only"
```

---

### Task 6: Recall once — user-scoped memory recall, prompt block and decisions in generate-stream

**Files:**
- Create: `src/exulu/memory/recall.ts`
- Create: `src/exulu/memory/recall.test.ts`
- Modify: `src/exulu/generate-stream.ts:356-395` and `:420-423` (generateSync), `:788-830` and `:897-899` (generateStream), `:440-445` and `:1010-1015` (convert calls), `:1109-1113` (return)

**Interfaces:**
- Consumes: `resolveMemoryConfig` (Task 1), `createRecallCollector`, `buildMemoryPromptBlock` (Task 3), `collectMemoryDecisions` (Task 2).
- Produces: `recallMemories({ agent, contexts, query, user, db }): Promise<RecallResult>` with `{ collector?: RecallCollector; memoryItems?: VectorSearchChunkResult[]; promptBlock: string }`; `generateStream` returns `{ stream, originalMessages, previousMessages, recall }`.

- [ ] **Step 1: Write the failing tests**

`src/exulu/memory/recall.test.ts`:

```ts
import { recallMemories } from "./recall";

const chunk = { item_id: "m1", item_name: "T", chunk_content: "c" } as any;
const rows = [{ id: "m1", name: "T", information: "Fact", type: "FACT", rights_mode: "private", created_by: 4, createdAt: "2026-09-01", updatedAt: "2026-09-01" }];
const dbFor = (users: any[] = []) => {
  const chain: any = {
    whereIn: jest.fn(() => chain), whereNot: jest.fn(() => chain), select: jest.fn(async () => users.length ? users : rows), where: jest.fn(() => chain),
  };
  return Object.assign(jest.fn(() => chain), { chain });
};
const search = jest.fn(async () => ({ chunks: [chunk] }));
const context: any = { id: "mem", name: "Memory", fields: [], search };
const user: any = { id: 4, role: { id: "r1" } };

beforeEach(() => search.mockClear());

describe("recallMemories", () => {
  it("searches with the user, role and configured limit, and builds the prompt block", async () => {
    const r = await recallMemories({ agent: { id: "a", memory: "mem", memory_config: { retrieval: { limit: 3 } } } as any, contexts: [context], query: "q", user, db: dbFor() });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: "q", user, role: "r1", limit: 3, method: "hybridSearch" }));
    expect(r.memoryItems).toEqual([chunk]);
    expect(r.promptBlock).toContain('item_id: "m1"');
    expect(r.collector?.list()).toHaveLength(1);
  });

  it("skips the search when retrieval is disabled but still returns a collector", async () => {
    const r = await recallMemories({ agent: { id: "a", memory: "mem", memory_config: { retrieval: { enabled: false } } } as any, contexts: [context], query: "q", user, db: dbFor() });
    expect(search).not.toHaveBeenCalled();
    expect(r.promptBlock).toBe("");
    expect(r.collector).toBeDefined();
  });

  it("warns and returns empty when the memory context is missing, and does nothing without agent.memory or query", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await recallMemories({ agent: { id: "a", memory: "gone" } as any, contexts: [context], query: "q", user, db: dbFor() });
    expect(r).toEqual({ collector: undefined, memoryItems: undefined, promptBlock: "" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("gone"));
    warn.mockRestore();
    expect(await recallMemories({ agent: { id: "a" } as any, contexts: [context], query: "q", user, db: dbFor() })).toEqual({ collector: undefined, memoryItems: undefined, promptBlock: "" });
    expect(search).not.toHaveBeenCalled();
  });

  it("passes no user for guests (public-only search)", async () => {
    await recallMemories({ agent: { id: "a", memory: "mem" } as any, contexts: [context], query: "q", user: undefined, db: dbFor() });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ user: undefined, role: undefined, limit: 10 }));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/memory/recall -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the recall step**

`src/exulu/memory/recall.ts`:

```ts
import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "@SRC/exulu/context";
import type { VectorSearchChunkResult } from "@SRC/graphql/resolvers/vector-search";
import { resolveMemoryConfig } from "./config";
import { buildMemoryPromptBlock, createRecallCollector, type RecallCollector } from "./recall-collector";

export type RecallResult = {
  collector: RecallCollector | undefined;
  memoryItems: VectorSearchChunkResult[] | undefined;
  promptBlock: string;
};

const EMPTY: RecallResult = { collector: undefined, memoryItems: undefined, promptBlock: "" };

/**
 * Memory pre-fetch shared by generateSync and generateStream (spec §3.1):
 * user-scoped hybrid search over the agent's memory context, limited by
 * memory_config, feeding the recall collector and the model-visible block.
 */
export async function recallMemories({ agent, contexts, query, user, db }: {
  agent: ExuluAgent | undefined;
  contexts: ExuluContext[] | undefined;
  query: string | undefined;
  user: User | undefined;
  db: any;
}): Promise<RecallResult> {
  if (!agent?.memory || !query) return { ...EMPTY };
  const context = contexts?.find((c) => c.id === agent.memory);
  if (!context) {
    console.warn(`[EXULU] memory: context "${agent.memory}" configured on agent "${agent.id}" was not found; memory off for this turn.`);
    return { ...EMPTY };
  }
  const config = resolveMemoryConfig(agent.memory_config);
  const collector = createRecallCollector(context, user, db);
  if (!config.retrieval.enabled) return { collector, memoryItems: undefined, promptBlock: "" };

  const result = await context.search({
    query,
    itemFilters: [],
    chunkFilters: [],
    method: "hybridSearch",
    sort: { field: "updatedAt", direction: "desc" },
    trigger: "agent",
    limit: config.retrieval.limit,
    page: 1,
    user,
    role: user?.role?.id,
  });
  const chunks = result?.chunks ?? [];
  if (chunks.length === 0) return { collector, memoryItems: undefined, promptBlock: "" };
  await collector.addFromChunks(chunks, "prefetch");
  return { collector, memoryItems: chunks, promptBlock: buildMemoryPromptBlock(collector.list()) };
}
```

- [ ] **Step 4: Wire generateSync and generateStream**

In `src/exulu/generate-stream.ts`:

1. Add imports after line 43:

```ts
import { recallMemories } from "./memory/recall";
import { collectMemoryDecisions } from "./memory/decisions";
```

2. `generateSync`: replace lines 356-395 (from the comment `// If memory context was configured` through the closing `}` of `if (agent?.memory && …)`) with:

```ts
    const { db: memoryDb } = await postgresClient();
    const memoryRecall = await recallMemories({ agent, contexts, query, user, db: memoryDb });
    const memoryContext = memoryRecall.promptBlock;
    const memoryItems = memoryRecall.memoryItems;
```

   Keep lines 420-423 (`if (memoryContext) { system += … }`) unchanged.

3. `generateStream`: replace lines 788-830 the same way (same four lines), then replace the commented block at 897-899 with:

```ts
    if (memoryContext) {
        system += "\n\n" + memoryContext;
    }
```

4. Directly before the `convertExuluToolsToAiSdkTools(` call in `generateStream` (line ~995) add:

```ts
    const memoryDecisions = collectMemoryDecisions(messages);
```

   and append one argument to that call after `sessionOwnerId,`: `memoryDecisions,`. `generateSync`'s call (line ~440) is unchanged.

6. Export the recall step from the package so the Newlift eval (Task 8b) can call it: in `src/index.ts` next to `export { postgresClient } from "./postgres/client";` add `export { recallMemories } from "./exulu/memory/recall";` and `export { checkMemoryBase } from "./exulu/memory/memory-base";`.

5. Replace the return at 1109-1113 with:

```ts
    return {
        stream: result,
        originalMessages: messages,
        previousMessages: previousMessagesContent,
        recall: memoryRecall.collector,
    };
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx jest src/exulu/memory -v && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/exulu/memory/recall.ts src/exulu/memory/recall.test.ts src/exulu/generate-stream.ts src/index.ts
git commit -m "fix(memory): recall memories once per turn, user-scoped and limit-driven, injected with citations on both generation paths"
```

---

### Task 7: Recalled memories as message metadata (guest show rule)

**Files:**
- Create: `src/exulu/memory/recalled-metadata.ts`
- Create: `src/exulu/memory/recalled-metadata.test.ts`
- Modify: `src/exulu/routes.ts:65` (import), `:832-850` (`messageMetadata` finish branch)

**Interfaces:**
- Consumes: `RecallCollector.list()` (Task 3), `resolveMemoryConfig` (Task 1), `finishTurnMetadata` (`src/exulu/turn-metadata.ts`).
- Produces: `recalledMemoriesMetadata({ recall, agent, isGuest }): { recalledMemories: RecalledMemory[] } | {}`; assistant message metadata gains `recalledMemories` (spec §2.5).

- [ ] **Step 1: Write the failing test**

`src/exulu/memory/recalled-metadata.test.ts`:

```ts
import { recalledMemoriesMetadata } from "./recalled-metadata";

const memory = { id: "m1", contextId: "mem", title: "T", information: "F", rights_mode: "public", createdBy: null, createdAt: "", updatedAt: "", source: "prefetch" } as const;
const recall = { list: () => [memory] } as any;

describe("recalledMemoriesMetadata", () => {
  it("returns the list for signed-in users", () => {
    expect(recalledMemoriesMetadata({ recall, agent: { id: "a" } as any, isGuest: false })).toEqual({ recalledMemories: [memory] });
  });
  it("omits the list for guests unless guests.showRecalled is on", () => {
    expect(recalledMemoriesMetadata({ recall, agent: { id: "a" } as any, isGuest: true })).toEqual({});
    expect(recalledMemoriesMetadata({ recall, agent: { id: "a", memory_config: { guests: { showRecalled: true } } } as any, isGuest: true })).toEqual({ recalledMemories: [memory] });
  });
  it("returns {} when nothing was recalled or there is no collector", () => {
    expect(recalledMemoriesMetadata({ recall: { list: () => [] } as any, agent: { id: "a" } as any, isGuest: false })).toEqual({});
    expect(recalledMemoriesMetadata({ recall: undefined, agent: { id: "a" } as any, isGuest: false })).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/exulu/memory/recalled-metadata -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement and wire**

`src/exulu/memory/recalled-metadata.ts`:

```ts
import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import { resolveMemoryConfig } from "./config";
import type { RecallCollector, RecalledMemory } from "./recall-collector";

/** Message metadata fragment merged on the SDK `finish` part (spec §2.5). */
export function recalledMemoriesMetadata({ recall, agent, isGuest }: {
  recall: RecallCollector | undefined;
  agent: ExuluAgent;
  isGuest: boolean;
}): { recalledMemories: RecalledMemory[] } | Record<string, never> {
  const list = recall?.list() ?? [];
  if (list.length === 0) return {};
  if (isGuest && !resolveMemoryConfig(agent.memory_config).guests.showRecalled) return {};
  return { recalledMemories: list };
}
```

In `src/exulu/routes.ts`: add `import { recalledMemoriesMetadata } from "./memory/recalled-metadata";` next to line 65, and change the `finish` branch of `messageMetadata` (line ~845) to:

```ts
            if (part.type === "finish") {
              return {
                ...finishTurnMetadata({ totalUsage: part.totalUsage, startedAt: turnStartedAt }),
                ...recalledMemoriesMetadata({ recall: result.recall, agent, isGuest: !user?.id }),
              };
            }
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx jest src/exulu/memory -v && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/exulu/memory/recalled-metadata.ts src/exulu/memory/recalled-metadata.test.ts src/exulu/routes.ts
git commit -m "feat(memory): emit recalledMemories message metadata with the guest display rule"
```

---

### Task 8: GraphQL — `memoryBase` on Context, `memoryBaseStats` query, `created_by` filter check

**Files:**
- Create: `src/graphql/resolvers/memory-base-stats.ts`
- Create: `src/graphql/resolvers/memory-base-stats.test.ts`
- Modify: `src/graphql/schemas/index.ts:2785-2807` (Context type), `:678` (query defs), `:2296-2320` (contexts list resolver), `:2423-2430` (contextById resolver), `:2362` area (register the query resolver)

**Interfaces:**
- Consumes: `checkMemoryBase` (Task 1), `applyAccessControl`, `convertContextToTableDefinition`, `getTableName`, `displayName` (Task 3).
- Produces: GraphQL `type MemoryBaseCheck { ok: Boolean! missing: [String!]! }`, `Context.memoryBase: MemoryBaseCheck!`, `type MemoryBaseStats { total: Int! public: Int! private: Int! contributors: Int! lastSavedAt: String lastSavedBy: MemoryBaseUser }`, `type MemoryBaseUser { id: Int! name: String! }`, `Query.memoryBaseStats(contextId: ID!): MemoryBaseStats`; function `memoryBaseStats({ context, user, db })`.

- [ ] **Step 1: Write the failing test**

`src/graphql/resolvers/memory-base-stats.test.ts`:

```ts
jest.mock("@SRC/graphql/utilities/access-control", () => ({ applyAccessControl: jest.fn((_t: unknown, q: unknown) => q) }));

import { memoryBaseStats } from "./memory-base-stats";

function fakeDb(answers: { total: number; pub: number; priv: number; contributors: number; last?: any; user?: any }) {
  let mode: "count" | "public" | "private" | "distinct" | "last" = "count";
  const q: any = {
    whereNot: () => q,
    where: (col: string, val: string) => { if (col === "rights_mode") mode = val as any; return q; },
    count: async () => [{ c: mode === "public" ? answers.pub : mode === "private" ? answers.priv : answers.total }],
    countDistinct: async () => [{ c: answers.contributors }],
    orderBy: () => q,
    select: () => q,
    first: async () => answers.last,
    whereIn: () => ({ select: async () => (answers.user ? [answers.user] : []) }),
  };
  return Object.assign(jest.fn(() => { mode = "count"; return q; }), {});
}

describe("memoryBaseStats", () => {
  const context = { id: "mem", name: "Memory", fields: [] } as any;

  it("aggregates counts, contributors and the last save with the creator name", async () => {
    const db = fakeDb({ total: 47, pub: 31, priv: 16, contributors: 9, last: { createdAt: new Date("2026-09-29T10:00:00Z"), created_by: 9 }, user: { id: 9, firstname: "Sara", lastname: "Kraus" } });
    const r = await memoryBaseStats({ context, user: { id: 4 } as any, db });
    expect(r).toEqual({ total: 47, public: 31, private: 16, contributors: 9, lastSavedAt: "2026-09-29T10:00:00.000Z", lastSavedBy: { id: 9, name: "Sara Kraus" } });
  });

  it("returns zeros and nulls for an empty base", async () => {
    const db = fakeDb({ total: 0, pub: 0, priv: 0, contributors: 0 });
    expect(await memoryBaseStats({ context, user: undefined, db })).toEqual({ total: 0, public: 0, private: 0, contributors: 0, lastSavedAt: null, lastSavedBy: null });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/graphql/resolvers/memory-base-stats -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver function**

`src/graphql/resolvers/memory-base-stats.ts`:

```ts
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "@SRC/exulu/context";
import { getTableName } from "@SRC/exulu/table-names";
import { applyAccessControl } from "@SRC/graphql/utilities/access-control";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";
import { displayName } from "@SRC/exulu/memory/recall-collector";

export type MemoryBaseStats = {
  total: number; public: number; private: number; contributors: number;
  lastSavedAt: string | null; lastSavedBy: { id: number; name: string } | null;
};

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);

/** Counts as visible to the viewer (RBAC applied); spec §3.3. */
export async function memoryBaseStats({ context, user, db }: { context: ExuluContext; user: User | undefined; db: any }): Promise<MemoryBaseStats> {
  const table = convertContextToTableDefinition(context);
  const tableName = getTableName(context.id);
  const scoped = () => applyAccessControl(table, db(tableName).whereNot("archived", true), user);

  const [[totalRow], [publicRow], [privateRow], [contribRow], last] = await Promise.all([
    scoped().count("id as c"),
    scoped().where("rights_mode", "public").count("id as c"),
    scoped().where("rights_mode", "private").count("id as c"),
    scoped().countDistinct("created_by as c"),
    scoped().orderBy("createdAt", "desc").select("createdAt", "created_by").first(),
  ]);

  let lastSavedBy: MemoryBaseStats["lastSavedBy"] = null;
  if (last && typeof last.created_by === "number") {
    const [u] = await db("users").whereIn("id", [last.created_by]).select("id", "firstname", "lastname", "email");
    if (u) lastSavedBy = { id: u.id, name: displayName(u) };
  }
  const lastSavedAt = last?.createdAt instanceof Date ? last.createdAt.toISOString() : typeof last?.createdAt === "string" ? last.createdAt : null;

  return {
    total: num(totalRow?.c), public: num(publicRow?.c), private: num(privateRow?.c),
    contributors: num(contribRow?.c), lastSavedAt, lastSavedBy,
  };
}
```

- [ ] **Step 4: Wire the schema**

In `src/graphql/schemas/index.ts`:

1. Inside `type Context {` (line 2785) add `memoryBase: MemoryBaseCheck!` after `configuration: JSON`, and after the closing `}` of `type Context` add:

```graphql
type MemoryBaseCheck {
    ok: Boolean!
    missing: [String!]!
}
type MemoryBaseUser {
    id: Int!
    name: String!
}
type MemoryBaseStats {
    total: Int!
    public: Int!
    private: Int!
    contributors: Int!
    lastSavedAt: String
    lastSavedBy: MemoryBaseUser
}
```

2. Next to `contextById(id: ID!): Context` (line 678) add:

```ts
  typeDefs += `
    memoryBaseStats(contextId: ID!): MemoryBaseStats
    `;
```

3. Import at the top: `import { checkMemoryBase } from "@SRC/exulu/memory/memory-base";` and `import { memoryBaseStats } from "@SRC/graphql/resolvers/memory-base-stats";`

4. In the contexts list resolver return object (line ~2313, `return { id: context.id, ...aggregates, …`) add `memoryBase: checkMemoryBase(context),`; in `contextById`'s `clean` object (line ~2425) add `memoryBase: checkMemoryBase(data),`.

5. Next to `resolvers.Query["contextById"] = …` (line 2362) add:

```ts
  resolvers.Query["memoryBaseStats"] = async (_, args, context) => {
    const target = contexts.find((c) => c.id === args.contextId);
    if (!target) return null;
    return memoryBaseStats({ context: target, user: context.user, db: context.db });
  };
```

   (`context.user` / `context.db` are how the other resolvers in this file read the viewer and the knex handle — see line 934 and `mutations/index.ts:224`.)

- [ ] **Step 5: Verify the `created_by` filter on items**

Run against the dev database (backend `.env` is copied into the worktree): start the server with `npm run dev` in a second terminal, then:

```bash
curl -s http://localhost:$PORT/graphql -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"query":"{ newton_memory_context_itemsPagination(page: 1, limit: 5, filters: [{ created_by: { eq: 4 } }]) { pageInfo { itemCount } items { id created_by } } }"}'
```

(`<ctx>_itemsPagination` is the generated query the frontend's `GET_ITEMS` builder uses.) Expected: a JSON result (possibly empty `items`), not a validation error. If the response says `created_by` is not a filterable field, add `"created_by"` to the allow-list in `src/graphql/resolvers/field-allow-list.ts` (the helper `field-allow-list.test.ts` covers the list) and re-run the request.

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx jest src/graphql/resolvers src/exulu/memory -v && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/graphql/resolvers/memory-base-stats.ts src/graphql/resolvers/memory-base-stats.test.ts src/graphql/schemas/index.ts src/graphql/resolvers/field-allow-list.ts
git commit -m "feat(memory): memoryBase contract on Context and memoryBaseStats query"
```

---

### Task 8b: Newlift regression eval (acceptance gate for "recall once")

**Files (newlkiag repo, `/Users/daniel.claessen/Desktop/Projects/newlkiag`, branch `develop`):**
- Create: `scripts/memory-eval/extract-cases.ts`
- Create: `scripts/memory-eval/run-cases.ts`
- Create: `scripts/memory-eval/report.ts`
- Create: `scripts/memory-eval/README.md`
- Output (gitignored): `scripts/memory-eval/out/`

**Files (backend worktree):**
- Create: `docs/superpowers/evals/2026-09-29-newlift-memory-recall.md` (the report)

**Interfaces:**
- Consumes: the Newlift database over the local tunnel (`POSTGRES_DB_HOST=127.0.0.1`, `POSTGRES_DB_PORT=5433`, `POSTGRES_DB_USER=newton-sql-test-sa@dx-newlift.iam`, empty password, `POSTGRES_DB_NAME=exulu-test`, from newlkiag `.env`); the newlkiag dev server running the worktree build; the run endpoint `POST /agents/litellm/run/<agentId>` (`x-api-key`, `stream: true`, `session` header, body `{ message: UIMessage }`); `recalledMemories` message metadata (Task 7); LiteLLM chat completions (`LITELLM_BASE_URL`, `LITELLM_MASTER_KEY` from newlkiag `.env`) for the judge.
- Produces: `out/cases.json`, `out/results.json`, the markdown report and a go/no-go on the recall change.

Facts established at planning time (2026-09-29): 275 `feedback` rows with `score = 1`, all for agent `48ae3121-7ac7-42b1-94d7-77467b1f8be7` ("Newton v1.0 [PRODUCTION]", memory context `newton_memory_context`); 17 of those answers (15 sessions) carried memory chunks (`"chunk_id":"memory:<item_id>"` inside the search tool output); the memory base holds 113 public and 2 private items; Newton's model id is `vertex-gemini-3.8-flash`; Newton's knowledge-search memory config is `{enabled, override, filePrioritization, queryAugmentation}` all true with `topK 10`.

- [ ] **Step 1: Prepare the newlkiag side**

```bash
cd /Users/daniel.claessen/Desktop/Projects/newlkiag && git branch --show-current
ls -la node_modules/@exulu/backend            # symlink → must point at the WORKTREE for this eval
rm node_modules/@exulu/backend && ln -s /Users/daniel.claessen/Desktop/Projects/exulu/backend-agent-memory node_modules/@exulu/backend
(cd /Users/daniel.claessen/Desktop/Projects/exulu/backend-agent-memory && npm run build)
grep -n "^POSTGRES_DB_\|^LITELLM_BASE_URL\|^LITELLM_MASTER_KEY\|^EXULU_API_KEY\|^PORT" .env | sed 's/=.*/=…/'
mkdir -p scripts/memory-eval/out && grep -q "scripts/memory-eval/out" .gitignore || echo "scripts/memory-eval/out/" >> .gitignore
```

Expected: the symlink now targets the worktree (note the previous target in the README so it can be restored: it was `/Users/daniel.claessen/Desktop/Projects/exulu/backend`); the env keys exist. If there is no `EXULU_API_KEY`, create an organisation API key in the newlkiag admin UI (Administration → API keys, scoped to the Newton agent) and put it in `.env` as `EXULU_API_KEY`. Start the dev server in a second terminal (`npm run dev`, note the port, default from `PORT`) and confirm `curl -s localhost:$PORT/health` answers.

- [ ] **Step 2: Extract the cases**

`scripts/memory-eval/extract-cases.ts`:

```ts
/**
 * Builds out/cases.json from Newlift's positive feedback: for every feedback
 * row with score = 1 on the production Newton agent, the assistant message
 * closest before the feedback time, the user question before it, up to four
 * earlier user turns, and the memory item ids that answer actually used.
 */
import "dotenv/config";
import { Client } from "pg";
import { writeFileSync } from "node:fs";

const AGENT_ID = process.env.EVAL_AGENT_ID ?? "48ae3121-7ac7-42b1-94d7-77467b1f8be7";
const MEMORY_CONTEXT = "newton_memory_context";

type Msg = { id: string; createdAt: string; content: any };
type Case = {
  id: string; session: string; feedbackAt: string; user: number;
  priorUserTurns: string[]; question: string; verifiedAnswer: string;
  usedMemoryIds: string[]; memorySubset: boolean;
};

const textOf = (m: any): string =>
  (m?.parts ?? []).filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n").trim();

function memoryIdsIn(content: string): string[] {
  const ids = new Set<string>();
  for (const m of content.matchAll(/memory:([0-9a-f-]{36})/g)) ids.add(m[1]!);
  for (const m of content.matchAll(new RegExp(`item_id[\\\\"\\s:]+([0-9a-f-]{36})[^}]*${MEMORY_CONTEXT}`, "g"))) ids.add(m[1]!);
  return [...ids];
}

async function main() {
  const client = new Client({
    host: process.env.POSTGRES_DB_HOST, port: Number(process.env.POSTGRES_DB_PORT ?? 5433),
    user: process.env.POSTGRES_DB_USER, password: process.env.POSTGRES_DB_PASSWORD ?? "",
    database: process.env.POSTGRES_DB_NAME, ssl: process.env.POSTGRES_DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  const fb = await client.query(
    `select id, session, "user", "createdAt" from feedback where score = 1 and agent = $1 order by "createdAt"`, [AGENT_ID]);
  const cases: Case[] = [];
  for (const row of fb.rows) {
    const msgs = await client.query<Msg>(
      `select id, "createdAt", content::jsonb as content from agent_messages where session = $1 and "createdAt" <= $2 order by "createdAt"`,
      [String(row.session), row.createdAt]);
    const list = msgs.rows;
    let aIdx = -1;
    for (let i = list.length - 1; i >= 0; i--) if (list[i]!.content?.role === "assistant") { aIdx = i; break; }
    if (aIdx < 1) continue;
    let qIdx = -1;
    for (let i = aIdx - 1; i >= 0; i--) if (list[i]!.content?.role === "user") { qIdx = i; break; }
    if (qIdx < 0) continue;
    const question = textOf(list[qIdx]!.content);
    const verifiedAnswer = textOf(list[aIdx]!.content);
    if (!question || !verifiedAnswer) continue;
    const priorUserTurns = list.slice(0, qIdx).filter((m) => m.content?.role === "user").map((m) => textOf(m.content)).filter(Boolean).slice(-4);
    const usedMemoryIds = memoryIdsIn(JSON.stringify(list[aIdx]!.content));
    cases.push({ id: row.id, session: String(row.session), feedbackAt: row.createdAt, user: row.user,
      priorUserTurns, question, verifiedAnswer, usedMemoryIds, memorySubset: usedMemoryIds.length > 0 });
  }
  await client.end();
  writeFileSync("scripts/memory-eval/out/cases.json", JSON.stringify(cases, null, 2));
  console.log(`cases: ${cases.length}, memory subset: ${cases.filter((c) => c.memorySubset).length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

Run: `npx tsx scripts/memory-eval/extract-cases.ts`
Expected: `cases: ~275, memory subset: ~17` (numbers may have grown since planning). Spot-check two memory-subset cases in `out/cases.json`: the question reads like a technician question and the used memory ids exist in `newton_memory_context_items`.

- [ ] **Step 3: Replay the cases through the run endpoint**

`scripts/memory-eval/run-cases.ts`:

```ts
/**
 * Replays cases through the real run endpoint (stream: true) and records the
 * recalledMemories metadata plus the answer text for each. --subset limits to
 * the memory subset; --sample N adds N random non-memory cases; --limit-override
 * is NOT a thing: change Newton's memory_config in the workbench between runs.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const BASE = process.env.EVAL_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const AGENT_ID = process.env.EVAL_AGENT_ID ?? "48ae3121-7ac7-42b1-94d7-77467b1f8be7";
const API_KEY = process.env.EXULU_API_KEY!;
const subsetOnly = process.argv.includes("--subset");
const sampleArg = process.argv.indexOf("--sample");
const sampleN = sampleArg > -1 ? Number(process.argv[sampleArg + 1]) : 0;
const tag = process.argv.includes("--tag") ? process.argv[process.argv.indexOf("--tag") + 1] : "new";

type Recalled = { id: string; title: string; rights_mode: string; createdBy: { id: number; name: string } | null };

async function turn(session: string, text: string): Promise<{ answer: string; recalled: Recalled[] }> {
  const res = await fetch(`${BASE}/agents/litellm/run/${AGENT_ID}`, {
    method: "POST",
    headers: { "x-api-key": API_KEY, "content-type": "application/json", stream: "true", session },
    body: JSON.stringify({ message: { id: `msg_${randomUUID().slice(0, 12)}`, role: "user", parts: [{ type: "text", text }] } }),
  });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${await res.text()}`);
  let answer = ""; let recalled: Recalled[] = [];
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop() ?? "";
    for (const line of lines) {
      const payload = line.startsWith("data:") ? line.slice(5).trim() : line.replace(/^[0-9a-z]:/, "").trim();
      if (!payload || payload === "[DONE]") continue;
      let ev: any; try { ev = JSON.parse(payload); } catch { continue; }
      if (ev.type === "text-delta") answer += ev.delta ?? ev.textDelta ?? "";
      const meta = ev.messageMetadata ?? (ev.type === "message-metadata" ? ev.messageMetadata : undefined);
      if (Array.isArray(meta?.recalledMemories)) recalled = meta.recalledMemories;
    }
  }
  return { answer: answer.trim(), recalled };
}

async function main() {
  const cases = JSON.parse(readFileSync("scripts/memory-eval/out/cases.json", "utf8")) as any[];
  const subset = cases.filter((c) => c.memorySubset);
  const rest = cases.filter((c) => !c.memorySubset).sort(() => Math.random() - 0.5).slice(0, sampleN);
  const selected = subsetOnly ? subset : [...subset, ...rest];
  const results: any[] = [];
  for (const c of selected) {
    const session = randomUUID();
    try {
      for (const prior of c.priorUserTurns) await turn(session, prior);
      const { answer, recalled } = await turn(session, c.question);
      const recalledIds = recalled.map((r) => r.id);
      const missing = c.usedMemoryIds.filter((id: string) => !recalledIds.includes(id));
      results.push({ caseId: c.id, memorySubset: c.memorySubset, question: c.question, verifiedAnswer: c.verifiedAnswer,
        answer, recalled, usedMemoryIds: c.usedMemoryIds, missing, hit: missing.length === 0 });
      console.log(`${c.memorySubset ? "M" : "-"} ${c.id.slice(0, 8)} recalled=${recalledIds.length} missing=${missing.length}`);
    } catch (e) {
      results.push({ caseId: c.id, memorySubset: c.memorySubset, error: e instanceof Error ? e.message : String(e) });
      console.error(`x ${c.id.slice(0, 8)}`, e);
    }
  }
  writeFileSync(`scripts/memory-eval/out/results-${tag}.json`, JSON.stringify(results, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
```

Run (memory subset first, cheap): `npx tsx scripts/memory-eval/run-cases.ts --subset --tag new`
Expected: one line per case; no `x` lines. If every case shows `recalled=0`, the agent's memory or `memory_config.retrieval.enabled` is off, or the metadata is not emitted — fix before continuing (check the server log for `[EXULU] memory:` warnings).

- [ ] **Step 4: Judge and report**

`scripts/memory-eval/report.ts`:

```ts
/**
 * Stage 1: recall hit rate over the memory subset. Stage 2: LLM-as-judge score
 * of each new answer against the verified answer (0–100) on Newton's model via
 * LiteLLM. Writes the markdown report.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";

const tag = process.argv.includes("--tag") ? process.argv[process.argv.indexOf("--tag") + 1] : "new";
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? "vertex-gemini-3.8-flash";
const LITELLM = process.env.LITELLM_BASE_URL!;
const KEY = process.env.LITELLM_MASTER_KEY!;

const PROMPT = `You compare two answers from a service assistant for elevator technicians.
Score how well the ACTUAL answer preserves the correctness, completeness and the concrete guidance
(part names, menu paths, checks, order of steps) of the VERIFIED answer that a technician rated positively.
100 = same guidance and facts; 70 = same guidance with minor omissions or extra text; 50 = partly right;
0 = contradicts or misses the guidance. Output JSON only: {"score": <0-100>, "reason": "<one sentence>"}.

VERIFIED answer:
{expected_output}

ACTUAL answer:
{actual_output}`;

async function judge(expected: string, actual: string): Promise<{ score: number; reason: string }> {
  const res = await fetch(`${LITELLM}/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: JUDGE_MODEL, temperature: 0, response_format: { type: "json_object" },
      messages: [{ role: "user", content: PROMPT.replace("{expected_output}", expected).replace("{actual_output}", actual) }] }),
  });
  const json: any = await res.json();
  const text = json.choices?.[0]?.message?.content ?? "{}";
  try { const p = JSON.parse(text); return { score: Number(p.score) || 0, reason: String(p.reason ?? "") }; }
  catch { return { score: 0, reason: `unparseable: ${text.slice(0, 80)}` }; }
}

async function main() {
  const results = JSON.parse(readFileSync(`scripts/memory-eval/out/results-${tag}.json`, "utf8")) as any[];
  const ok = results.filter((r) => !r.error);
  const subset = ok.filter((r) => r.memorySubset);
  const hits = subset.filter((r) => r.hit).length;
  const hitRate = subset.length ? hits / subset.length : 1;
  for (const r of ok) r.judge = await judge(r.verifiedAnswer, r.answer);
  const mean = ok.length ? ok.reduce((s, r) => s + r.judge.score, 0) / ok.length : 0;
  const lowSubset = subset.filter((r) => r.judge.score < 50);
  const lines = [
    `# Newlift memory regression eval (${tag})`, "",
    `Date: ${new Date().toISOString().slice(0, 10)} · cases: ${ok.length} (memory subset ${subset.length}, errors ${results.length - ok.length}) · judge: ${JUDGE_MODEL}`, "",
    `## Stage 1 — recall hit rate`, "",
    `Hit rate: **${(hitRate * 100).toFixed(1)} %** (${hits}/${subset.length}). Gate ≥ 95 %: ${hitRate >= 0.95 ? "PASS" : "FAIL"}`, "",
    ...subset.filter((r) => !r.hit).map((r) => `- MISS ${r.caseId}: missing ${r.missing.join(", ")} · recalled ${r.recalled.map((m: any) => m.title).join(" | ")}`),
    "", `## Stage 2 — answer quality vs verified answers`, "",
    `Mean score: **${mean.toFixed(1)}** (gate ≥ 70: ${mean >= 70 ? "PASS" : "FAIL"}) · memory-subset cases below 50: ${lowSubset.length} (gate 0: ${lowSubset.length === 0 ? "PASS" : "FAIL"})`, "",
    `| case | subset | hit | score | reason |`, `| --- | --- | --- | --- | --- |`,
    ...ok.map((r) => `| ${r.caseId.slice(0, 8)} | ${r.memorySubset ? "M" : ""} | ${r.hit ? "✓" : "✗"} | ${r.judge.score} | ${r.judge.reason.replace(/\|/g, "/")} |`),
    "", `## Decision`, "", `${hitRate >= 0.95 && mean >= 70 && lowSubset.length === 0 ? "GO" : "NO-GO"} — see gates above.`,
  ];
  writeFileSync(`scripts/memory-eval/out/report-${tag}.md`, lines.join("\n"));
  console.log(lines.slice(0, 12).join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); });
```

Run:

```bash
npx tsx scripts/memory-eval/run-cases.ts --sample 30 --tag new      # full run: subset + 30 random
npx tsx scripts/memory-eval/report.ts --tag new
```

Expected: Stage 1 PASS at Newton's current limit. If FAIL: set Newton's "Memories per answer" to 25 in the workbench, rerun both commands with `--tag new-25`; if still FAIL, implement the keyword-variant expansion in `src/exulu/memory/recall.ts` (spec §3.1: derive variants of the question tokens with `deriveKeywordVariants` from `ee/agentic-retrieval/pipeline/text-utils.ts`, run a second `tsvector` search with them, merge before the cap), rebuild, restart, rerun.

Optional baseline: check out the primary backend checkout's `develop` build on another port (`PORT=3101` with the primary `node_modules/@exulu/backend` symlink restored) and run `run-cases.ts --sample 30 --tag develop` with `EVAL_BASE_URL=http://localhost:3101`, then `report.ts --tag develop` for a side-by-side mean.

- [ ] **Step 5: File the report and restore the symlink**

```bash
mkdir -p /Users/daniel.claessen/Desktop/Projects/exulu/backend-agent-memory/docs/superpowers/evals
cp scripts/memory-eval/out/report-new.md /Users/daniel.claessen/Desktop/Projects/exulu/backend-agent-memory/docs/superpowers/evals/2026-09-29-newlift-memory-recall.md
cat > scripts/memory-eval/README.md <<'EOF'
# Memory regression eval
Replays Newlift's positively rated answers through the run endpoint and checks (1) the memories the verified
answer used are recalled, (2) an LLM judge scores the new answer against the verified one.
Prereqs: DB tunnel on 127.0.0.1:5433, dev server on $PORT with the @exulu/backend build under test,
EXULU_API_KEY (agent-scoped org key), LITELLM_BASE_URL + LITELLM_MASTER_KEY.
Steps: extract-cases → run-cases [--subset | --sample N] [--tag t] → report [--tag t]. Output in out/ (gitignored).
Note: the @exulu/backend symlink normally points at ../exulu/backend; point it at the worktree only for the eval.
EOF
rm node_modules/@exulu/backend && ln -s /Users/daniel.claessen/Desktop/Projects/exulu/backend node_modules/@exulu/backend
git add scripts/memory-eval .gitignore && git -c commit.gpgsign=false commit -m "chore(eval): memory regression eval scripts against positive-feedback cases"
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend-agent-memory && git add docs/superpowers/evals && git -c commit.gpgsign=false commit -m "docs(evals): Newlift memory recall regression report"
```

Expected: both commits land (newlkiag on `develop`, backend on `feat/agent-memory`); the symlink points back at the primary checkout. The report's Decision line is the gate for the rest of this plan: on NO-GO, stop and report to Daniel before starting the frontend tasks.

---

### Task 9: Backend build, full test run and docs

**Files:**
- Modify: `mintlify-docs/user-guide/chat/memory.mdx` (rewrite "The private-vs-public question" and "Where memories live" for the card, the recalled block and the panel), `mintlify-docs/building/agents/workbench.mdx:66-74` (Knowledge & memory section: contract, picker, config)

- [ ] **Step 1: Full backend verification**

```bash
npx jest --silent 2>&1 | tail -6
npx tsc --noEmit -p tsconfig.json
npm run build
```
Expected: the four suites that failed on the base branch (`compact-session`, `email-inbound/intake`, `resolve-context-window`, `convert-exulu-tools-to-ai-sdk-tools`) — the last one now passes; the other three are pre-existing and unrelated (report them, do not fix here). `tsc` and `build` clean.

- [ ] **Step 2: Update the two docs pages**

In `memory.mdx` replace the "The private-vs-public question" section with:

```mdx
## The save card

When the agent finds something worth keeping it shows a **Remember this?** card instead of asking in prose. The card contains the wording (editable), the memory type, and who may see it — **Private** (only you) by default, or **Public** (everyone using this agent), with the same access control you know from knowledge items. Nothing is saved until you choose **Save**. **Don't save** tells the agent to drop it.

If the agent proposes several memories at once you can **Save all** or decide one by one.

## Corrections and forgetting

Tell the agent "that's wrong, it's …" or "forget that". It proposes an update or a deletion on a card you confirm. You can only change memories you saved yourself or have write access to; for other people's public memories the agent tells you who saved it so you can ask them.

## Seeing what was used

Answers that used memories show **Recalled N memories** under the reply, with each memory, who saved it and when. From there you can open, edit or forget your own memories. The header chip **Remembers N things about you** opens the panel with everything the agent remembers that you saved, split into Private and Public.
```

In `workbench.mdx` replace the **Long-term memory** paragraph (line 72) with:

```mdx
**Long-term memory**: pick an existing knowledge base as the memory store. A knowledge base qualifies when it has an `information` text field and a `type` enum; others are listed greyed out with the missing fields. Once on, the section shows how many memories exist, who contributes, and the retrieval behaviour: look up memories before every answer (with a per-answer limit, default 10), whether to ask for visibility every time or preselect Private, and whether guests see the recalled memories. The three knowledge-search memory options (override, file hints, query widening) are edited here too and apply only when Knowledge search is on. See [Memory](/user-guide/chat/memory) for the chat side.
```

- [ ] **Step 3: Commit**

```bash
git add mintlify-docs/user-guide/chat/memory.mdx mintlify-docs/building/agents/workbench.mdx
git commit -m "docs(memory): describe the save card, corrections, recalled memories and the workbench section"
```

---

## Frontend

All frontend tasks run in `/Users/daniel.claessen/Desktop/Projects/exulu/frontend-agent-memory`. Tests: `npx vitest run <path>`. Typecheck: `npx tsc --noEmit`. The backend from Tasks 1–8 must be running (`npm run dev` in the backend worktree) for manual checks.

### Task 10: Memory card data module (pure) — detection, decisions, resolved states, stacking

**Files:**
- Create: `app/(application)/chat/components/memory-card-data.ts`
- Create: `app/(application)/chat/components/memory-card-data.test.ts`

**Interfaces:**
- Produces: `MEMORY_TOOL_PART_TYPES`, `isMemoryToolPart(part)`, `memoryKind(part): "remember" | "update" | "forget" | null`, `MemoryDecision` (same shape as backend Task 2), `encodeMemoryDecision(d): string`, `DECLINED_REASON = "declined"`, `memoryProposalFromPart(part): MemoryProposal | null`, `memoryResolvedState(part): ResolvedState`, `groupRememberParts(parts): Array<{ kind: "single"; index: number } | { kind: "stack"; indices: number[] }>`.

- [ ] **Step 1: Write the failing tests**

`app/(application)/chat/components/memory-card-data.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DECLINED_REASON, encodeMemoryDecision, groupRememberParts, isMemoryToolPart, memoryKind,
  memoryProposalFromPart, memoryResolvedState,
} from "./memory-card-data";

const part = (type: string, extra: Record<string, unknown> = {}) => ({ type, toolCallId: "c1", state: "approval-requested", ...extra }) as any;

describe("detection", () => {
  it("recognises the three memory tool part types only", () => {
    expect(isMemoryToolPart(part("tool-memory_remember"))).toBe(true);
    expect(memoryKind(part("tool-memory_update"))).toBe("update");
    expect(memoryKind(part("tool-memory_forget"))).toBe("forget");
    expect(isMemoryToolPart(part("tool-bash"))).toBe(false);
    expect(memoryKind(part("text"))).toBeNull();
  });
});

describe("encodeMemoryDecision", () => {
  it("produces versioned JSON the backend parser accepts, round-tripping special characters", () => {
    const d = { v: 1 as const, kind: "remember" as const, title: 'He said "no"', information: "a}\nb", type: "FACT", rights_mode: "private" as const };
    expect(JSON.parse(encodeMemoryDecision(d))).toEqual(d);
    expect(DECLINED_REASON).toBe("declined");
  });
});

describe("memoryProposalFromPart", () => {
  it("reads the remember proposal from the tool input", () => {
    const p = memoryProposalFromPart(part("tool-memory_remember", { input: { title: "T", information: "I", type: "FACT", whySaved: "why", visibility: "public" } }));
    expect(p).toEqual({ kind: "remember", title: "T", information: "I", type: "FACT", whySaved: "why", visibility: "public", memoryId: null });
  });
  it("reads update/forget proposals with the memory id", () => {
    expect(memoryProposalFromPart(part("tool-memory_update", { input: { memoryId: "m1", information: "new", reason: "r" } }))).toMatchObject({ kind: "update", memoryId: "m1", information: "new" });
    expect(memoryProposalFromPart(part("tool-memory_forget", { input: { memoryId: "m1", reason: "r" } }))).toMatchObject({ kind: "forget", memoryId: "m1" });
  });
  it("returns null for non-memory parts or missing input", () => {
    expect(memoryProposalFromPart(part("tool-bash", { input: {} }))).toBeNull();
    expect(memoryProposalFromPart(part("tool-memory_remember"))).toBeNull();
  });
});

describe("memoryResolvedState", () => {
  it("maps approval and output states to the resolved line", () => {
    expect(memoryResolvedState(part("tool-memory_remember", { state: "approval-requested", approval: { id: "a" } }))).toEqual({ status: "pending" });
    expect(memoryResolvedState(part("tool-memory_remember", { state: "approval-responded", approval: { id: "a", approved: false } }))).toEqual({ status: "declined" });
    expect(memoryResolvedState(part("tool-memory_remember", { state: "approval-responded", approval: { id: "a", approved: true } }))).toEqual({ status: "working" });
    expect(memoryResolvedState(part("tool-memory_remember", { state: "output-available", output: { type: "memory_saved", contextId: "mem", itemId: "m1", title: "T", rights_mode: "users" } })))
      .toEqual({ status: "saved", contextId: "mem", itemId: "m1", title: "T", rights_mode: "users" });
    expect(memoryResolvedState(part("tool-memory_update", { state: "output-available", output: { type: "memory_updated", contextId: "mem", itemId: "m1", title: "T", rights_mode: "private" } }))).toMatchObject({ status: "updated" });
    expect(memoryResolvedState(part("tool-memory_forget", { state: "output-available", output: { type: "memory_forgotten", contextId: "mem", itemId: "m1", title: "T" } }))).toMatchObject({ status: "forgotten" });
    expect(memoryResolvedState(part("tool-memory_update", { state: "output-available", output: { type: "memory_no_access", createdBy: { id: 9, name: "Sara" } } }))).toEqual({ status: "no_access", createdBy: { id: 9, name: "Sara" } });
    expect(memoryResolvedState(part("tool-memory_remember", { state: "output-available", output: { type: "memory_error", message: "boom" } }))).toEqual({ status: "error", message: "boom" });
    expect(memoryResolvedState(part("tool-memory_remember", { state: "output-error", errorText: "x" }))).toEqual({ status: "error", message: "x" });
  });
});

describe("groupRememberParts", () => {
  it("stacks consecutive pending remember parts and leaves the rest single", () => {
    const parts = [
      part("text"),
      part("tool-memory_remember", { toolCallId: "a", approval: { id: "1" } }),
      part("tool-memory_remember", { toolCallId: "b", approval: { id: "2" } }),
      part("tool-memory_remember", { toolCallId: "c", state: "output-available", output: { type: "memory_saved" } }),
      part("tool-memory_update", { toolCallId: "d", approval: { id: "3" } }),
      part("tool-memory_remember", { toolCallId: "e", approval: { id: "4" } }),
    ];
    expect(groupRememberParts(parts)).toEqual([
      { kind: "stack", indices: [1, 2] },
      { kind: "single", index: 3 },
      { kind: "single", index: 4 },
      { kind: "single", index: 5 },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run "app/(application)/chat/components/memory-card-data.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`app/(application)/chat/components/memory-card-data.ts`:

```ts
/**
 * Pure logic for the in-chat memory cards (backend spec
 * docs/superpowers/specs/2026-09-29-agent-memory-redesign-design.md §2.3–2.4, §4.1).
 * No React, no fetch — mirrors credential-request-data.ts.
 */
import type { DynamicToolUIPart } from "ai";

export const MEMORY_TOOL_PART_TYPES = {
  remember: "tool-memory_remember",
  update: "tool-memory_update",
  forget: "tool-memory_forget",
} as const;

export type MemoryKind = keyof typeof MEMORY_TOOL_PART_TYPES;
export type RightsMode = "private" | "users" | "roles" | "teams" | "public";
export type RbacGrant = { id: number | string; rights: "read" | "write" };

export type MemoryDecision =
  | { v: 1; kind: "remember"; title: string; information: string; type: string; rights_mode: RightsMode; rbac?: { users?: RbacGrant[]; roles?: RbacGrant[]; teams?: RbacGrant[] } }
  | { v: 1; kind: "update"; information?: string; title?: string; type?: string }
  | { v: 1; kind: "forget" };

export const DECLINED_REASON = "declined";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function memoryKind(part: { type?: string } | null | undefined): MemoryKind | null {
  const type = part?.type;
  for (const kind of Object.keys(MEMORY_TOOL_PART_TYPES) as MemoryKind[]) {
    if (MEMORY_TOOL_PART_TYPES[kind] === type) return kind;
  }
  return null;
}

export const isMemoryToolPart = (part: { type?: string } | null | undefined): boolean => memoryKind(part) !== null;

export const encodeMemoryDecision = (decision: MemoryDecision): string => JSON.stringify(decision);

export type MemoryProposal = {
  kind: MemoryKind;
  memoryId: string | null;
  title: string;
  information: string;
  type: string;
  whySaved: string;
  visibility: "private" | "public" | null;
};

export function memoryProposalFromPart(part: DynamicToolUIPart | Record<string, unknown>): MemoryProposal | null {
  const kind = memoryKind(part as { type?: string });
  const input = (part as { input?: unknown }).input;
  if (!kind || !isRecord(input)) return null;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  return {
    kind,
    memoryId: typeof input.memoryId === "string" ? input.memoryId : null,
    title: str("title"),
    information: str("information"),
    type: str("type"),
    whySaved: str("whySaved"),
    visibility: input.visibility === "public" || input.visibility === "private" ? input.visibility : null,
  };
}

export type ResolvedState =
  | { status: "pending" }
  | { status: "working" }
  | { status: "declined" }
  | { status: "saved" | "updated"; contextId: string; itemId: string; title: string; rights_mode: RightsMode }
  | { status: "forgotten"; contextId: string; itemId: string; title: string }
  | { status: "no_access"; createdBy: { id: number; name: string } | null }
  | { status: "error"; message: string };

export function memoryResolvedState(part: DynamicToolUIPart | Record<string, unknown>): ResolvedState {
  const p = part as Record<string, unknown>;
  const approval = isRecord(p.approval) ? p.approval : undefined;
  if (p.state === "approval-requested") return { status: "pending" };
  if (p.state === "approval-responded") return approval?.approved === false ? { status: "declined" } : { status: "working" };
  if (p.state === "output-error") return { status: "error", message: typeof p.errorText === "string" ? p.errorText : "error" };
  if (p.state === "output-available") {
    const out = isRecord(p.output) ? p.output : {};
    const str = (k: string) => (typeof out[k] === "string" ? (out[k] as string) : "");
    switch (out.type) {
      case "memory_saved":
        return { status: "saved", contextId: str("contextId"), itemId: str("itemId"), title: str("title"), rights_mode: (str("rights_mode") || "private") as RightsMode };
      case "memory_updated":
        return { status: "updated", contextId: str("contextId"), itemId: str("itemId"), title: str("title"), rights_mode: (str("rights_mode") || "private") as RightsMode };
      case "memory_forgotten":
        return { status: "forgotten", contextId: str("contextId"), itemId: str("itemId"), title: str("title") };
      case "memory_no_access":
        return { status: "no_access", createdBy: isRecord(out.createdBy) ? { id: Number(out.createdBy.id), name: String(out.createdBy.name ?? "") } : null };
      case "memory_error":
        return { status: "error", message: str("message") || "error" };
      default:
        return { status: "error", message: "unexpected memory result" };
    }
  }
  if (approval?.approved === false) return { status: "declined" };
  return { status: "working" };
}

export type RememberGroup = { kind: "single"; index: number } | { kind: "stack"; indices: number[] };

/** Consecutive pending `memory_remember` approvals render under one "Save all" bar (spec §4.1). */
export function groupRememberParts(parts: ReadonlyArray<Record<string, unknown>>): RememberGroup[] {
  const groups: RememberGroup[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length > 1) groups.push({ kind: "stack", indices: run });
    else if (run.length === 1) groups.push({ kind: "single", index: run[0]! });
    run = [];
  };
  parts.forEach((part, index) => {
    const kind = memoryKind(part as { type?: string });
    if (!kind) { flush(); return; }
    const pending = kind === "remember" && memoryResolvedState(part).status === "pending";
    if (pending) { run.push(index); return; }
    flush();
    groups.push({ kind: "single", index });
  });
  flush();
  return groups;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run "app/(application)/chat/components/memory-card-data.test.ts"`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add "app/(application)/chat/components/memory-card-data.ts" "app/(application)/chat/components/memory-card-data.test.ts"
git commit -m "feat(memory): pure card logic — detection, decisions, resolved states, stacking"
```

---

### Task 11: Memory card component, routing from the tool-part factory, i18n

**Files:**
- Create: `app/(application)/chat/components/memory-card.tsx`
- Create: `app/(application)/chat/components/memory-stack.tsx`
- Modify: `app/(application)/chat/components/message-column.tsx:95-135` (route memory parts before the generic approval card)
- Modify: `app/(application)/chat/queries.ts:120-128` (`GetContextById` must select `id name fields`)
- Modify: `messages/en.json:1117` and `messages/de.json:1117` (add `chat.memory.*` before `"approval"`)

**Interfaces:**
- Consumes: Task 10 exports; `RBACControl` (`components/rbac.tsx`, props `initialRightsMode`, `initialUsers`, `initialRoles`, `initialTeams`, `allowedModes`, `subjectLabel`, `onChange(rights_mode, users, roles, teams)`); `ConfirmDialog` (`components/primitives/confirm-dialog.tsx`); `addToolApprovalResponse({ id, approved, reason })`; the `Card`, `Button`, `Textarea`, `Select` shadcn components.
- Produces: `<MemoryCard part agent addToolApprovalResponse guestMode />`, `<MemoryStack parts agent addToolApprovalResponse />`; a small context `MemoryEditsProvider` so "Save all" can read each card's current edits.

- [ ] **Step 1: Add the i18n keys**

In `messages/en.json` insert before `"approval": {` (line 1117, inside `"chat"`):

```json
    "memory": {
      "rememberTitle": "Remember this?",
      "rememberHint": "Nothing is saved until you choose Save.",
      "updateTitle": "Update this memory?",
      "forgetTitle": "Forget this memory?",
      "forgetDescription": "“{title}” will be deleted from {agent}'s memory.",
      "wording": "Wording",
      "type": "Type",
      "whoCanSee": "Who can see this",
      "save": "Save",
      "saveAll": "Save all ({count})",
      "dontSave": "Don't save",
      "update": "Update memory",
      "keep": "Keep as is",
      "forget": "Forget",
      "stackTitle": "Remember these?",
      "current": "Current wording",
      "proposed": "New wording",
      "working": "Saving…",
      "saved": "Saved · {mode}",
      "updated": "Memory updated",
      "forgotten": "Memory forgotten",
      "declined": "Not saved",
      "noAccess": "This memory was saved by {name}. Ask them or an admin to change it.",
      "noAccessUnknown": "This memory isn't available to you.",
      "error": "Couldn't save the memory: {message}",
      "open": "Open",
      "mode": { "private": "Private", "users": "Shared with users", "roles": "Shared with roles", "teams": "Shared with teams", "public": "Public" }
    },
```

In `messages/de.json` at the same place:

```json
    "memory": {
      "rememberTitle": "Im Gedächtnis speichern?",
      "rememberHint": "Nichts wird gespeichert, bevor du „Speichern“ wählst.",
      "updateTitle": "Diese Erinnerung aktualisieren?",
      "forgetTitle": "Diese Erinnerung vergessen?",
      "forgetDescription": "„{title}“ wird aus dem Gedächtnis von {agent} gelöscht.",
      "wording": "Wortlaut",
      "type": "Typ",
      "whoCanSee": "Wer kann das sehen",
      "save": "Speichern",
      "saveAll": "Alle speichern ({count})",
      "dontSave": "Nicht speichern",
      "update": "Erinnerung aktualisieren",
      "keep": "So lassen",
      "forget": "Vergessen",
      "stackTitle": "Diese Dinge merken?",
      "current": "Aktueller Wortlaut",
      "proposed": "Neuer Wortlaut",
      "working": "Wird gespeichert…",
      "saved": "Gespeichert · {mode}",
      "updated": "Erinnerung aktualisiert",
      "forgotten": "Erinnerung vergessen",
      "declined": "Nicht gespeichert",
      "noAccess": "Diese Erinnerung wurde von {name} gespeichert. Bitte {name} oder einen Admin, sie zu ändern.",
      "noAccessUnknown": "Diese Erinnerung ist für dich nicht verfügbar.",
      "error": "Erinnerung konnte nicht gespeichert werden: {message}",
      "open": "Öffnen",
      "mode": { "private": "Privat", "users": "Geteilt mit Nutzern", "roles": "Geteilt mit Rollen", "teams": "Geteilt mit Teams", "public": "Öffentlich" }
    },
```

- [ ] **Step 2: Make the context query expose fields**

In `app/(application)/chat/queries.ts` the `GetContextById` query (line ~120) must select `id`, `name`, `fields`, `configuration` and `memoryBase { ok missing }`. If it already selects `fields`, only add `memoryBase { ok missing }`.

- [ ] **Step 3: Write the card**

`app/(application)/chat/components/memory-card.tsx`:

```tsx
"use client";

/**
 * Memory-specific approval card (spec §4.1). Renders for tool-memory_* parts in
 * place of ToolCallApproval. Save approves the call with the edits encoded in
 * the approval reason; Don't save denies with "declined". No "Allow for this
 * chat" — the card is the consent.
 */
import { useQuery } from "@apollo/client";
import type { ChatAddToolApproveResponseFunction, DynamicToolUIPart } from "ai";
import { Bookmark, CheckCircle2, Loader2, Trash2, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import * as React from "react";

import { ConfirmDialog } from "@/components/primitives/confirm-dialog";
import { RBACControl } from "@/components/rbac";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Agent } from "@/types/models/agent";

import { GET_ITEMS, PAGINATION_POSTFIX } from "@/app/(application)/data/queries";
import { GET_CONTEXT_BY_ID } from "../queries";
import {
  DECLINED_REASON, encodeMemoryDecision, memoryProposalFromPart, memoryResolvedState,
  type MemoryDecision, type RbacGrant, type RightsMode,
} from "./memory-card-data";
import { useMemoryEdits } from "./memory-stack";

export interface MemoryCardProps {
  part: DynamicToolUIPart;
  agent: Agent;
  addToolApprovalResponse: ChatAddToolApproveResponseFunction;
  /** Rendered inside a stack: hide per-card Save (the stack's Save all approves). */
  inStack?: boolean;
}

type Edits = { title: string; information: string; type: string; rights_mode: RightsMode; users: RbacGrant[]; roles: RbacGrant[]; teams: RbacGrant[] };

const preselect = (agent: Agent, contextDefault: RightsMode | undefined, hint: "private" | "public" | null): RightsMode => {
  if (hint) return hint;
  const cfg = (agent as { memory_config?: { visibility?: string } }).memory_config;
  if (cfg?.visibility === "preselect_private") return "private";
  return contextDefault ?? "private";
};

export function MemoryCard({ part, agent, addToolApprovalResponse, inStack = false }: MemoryCardProps) {
  const t = useTranslations("chat");
  const proposal = memoryProposalFromPart(part);
  const resolved = memoryResolvedState(part);
  const approvalId = (part as { approval?: { id?: string } }).approval?.id;
  const edits = useMemoryEdits();

  const { data } = useQuery(GET_CONTEXT_BY_ID, {
    variables: { id: (agent as { memory?: string }).memory ?? "" },
    skip: !(agent as { memory?: string }).memory,
  });
  const context = data?.contextById as { fields?: { name: string; type: string; enumValues?: string[] }[]; configuration?: { defaultRightsMode?: RightsMode } } | undefined;
  const typeValues = context?.fields?.find((f) => f.name === "type")?.enumValues ?? [];

  const [state, setState] = React.useState<Edits>(() => ({
    title: proposal?.title ?? "",
    information: proposal?.information ?? "",
    type: proposal?.type ?? "",
    rights_mode: preselect(agent, context?.configuration?.defaultRightsMode, proposal?.visibility ?? null),
    users: [], roles: [], teams: [],
  }));
  const [confirmForget, setConfirmForget] = React.useState(false);

  // Register current edits with the stack so "Save all" can read them.
  React.useEffect(() => {
    if (!approvalId) return;
    edits?.register(part.toolCallId, () => decisionFor(proposal?.kind ?? "remember", state));
    return () => edits?.unregister(part.toolCallId);
  }, [approvalId, part.toolCallId, state, proposal?.kind, edits]);

  if (!proposal) return null;

  // ── Resolved line ─────────────────────────────────────────────────────────
  if (resolved.status !== "pending") {
    const tone = resolved.status === "declined" || resolved.status === "error" || resolved.status === "no_access" ? "muted" : resolved.status === "working" ? "muted" : "success";
    const Icon = resolved.status === "working" ? Loader2 : tone === "success" ? CheckCircle2 : XCircle;
    const text =
      resolved.status === "working" ? t("memory.working")
      : resolved.status === "saved" ? t("memory.saved", { mode: t(`memory.mode.${resolved.rights_mode}`) })
      : resolved.status === "updated" ? t("memory.updated")
      : resolved.status === "forgotten" ? t("memory.forgotten")
      : resolved.status === "declined" ? t("memory.declined")
      : resolved.status === "no_access" ? (resolved.createdBy ? t("memory.noAccess", { name: resolved.createdBy.name }) : t("memory.noAccessUnknown"))
      : t("memory.error", { message: resolved.message });
    return (
      <div role="status" className={cn("mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm", tone === "success" ? "border-success/30 bg-success/5 text-success" : "border-border bg-muted/40 text-muted-foreground")}>
        <Icon className={cn("size-4 shrink-0", resolved.status === "working" && "animate-spin")} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{text}</span>
        {(resolved.status === "saved" || resolved.status === "updated") && (
          <Button asChild variant="link" size="sm" className="h-auto p-0 text-xs">
            <Link href={`/data/${resolved.contextId}/items/${resolved.itemId}`}>{t("memory.open")}</Link>
          </Button>
        )}
      </div>
    );
  }

  if (!approvalId) return null;

  const decide = (approved: boolean) =>
    addToolApprovalResponse({ id: approvalId, approved, reason: approved ? encodeMemoryDecision(decisionFor(proposal.kind, state)) : DECLINED_REASON });

  // ── Forget: ConfirmDialog instead of a form ───────────────────────────────
  if (proposal.kind === "forget") {
    return (
      <Card className="mt-3 border-border bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base font-medium"><Trash2 className="size-4 text-muted-foreground" aria-hidden="true" />{t("memory.forgetTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <MemoryRef memoryId={proposal.memoryId} agent={agent} />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" className="h-11 sm:h-9 sm:flex-1" onClick={() => decide(false)}>{t("memory.keep")}</Button>
            <Button variant="destructive" className="h-11 sm:h-9 sm:flex-1" onClick={() => setConfirmForget(true)}>{t("memory.forget")}</Button>
          </div>
          <ConfirmDialog open={confirmForget} onOpenChange={setConfirmForget} variant="destructive" title={t("memory.forgetTitle")}
            description={t("memory.forgetDescription", { title: proposal.title || proposal.memoryId || "", agent: agent.name })}
            confirmLabel={t("memory.forget")} onConfirm={async () => { decide(true); }} />
        </CardContent>
      </Card>
    );
  }

  // ── Remember / update form ────────────────────────────────────────────────
  const isUpdate = proposal.kind === "update";
  return (
    <Card className="mt-3 border-border bg-card" data-demo-id="chat-memory-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <Bookmark className="size-4 text-muted-foreground" aria-hidden="true" />
          {isUpdate ? t("memory.updateTitle") : t("memory.rememberTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isUpdate && <MemoryRef memoryId={proposal.memoryId} agent={agent} label={t("memory.current")} />}
        <div className="space-y-1">
          <Label htmlFor={`mem-${part.toolCallId}`}>{isUpdate ? t("memory.proposed") : t("memory.wording")}</Label>
          <Textarea id={`mem-${part.toolCallId}`} value={state.information} rows={3} onChange={(e) => setState((s) => ({ ...s, information: e.target.value }))} />
        </div>
        {typeValues.length > 0 && (
          <div className="space-y-1">
            <Label>{t("memory.type")}</Label>
            <Select value={state.type || typeValues[0]} onValueChange={(v) => setState((s) => ({ ...s, type: v }))}>
              <SelectTrigger className="w-full sm:w-56"><SelectValue /></SelectTrigger>
              <SelectContent>{typeValues.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        )}
        {!isUpdate && (
          <div className="space-y-1">
            <Label>{t("memory.whoCanSee")}</Label>
            <RBACControl subjectLabel="memory" initialRightsMode={state.rights_mode} initialUsers={[]} initialRoles={[]} initialTeams={[]}
              onChange={(rights_mode, users, roles, teams) => setState((s) => ({ ...s, rights_mode, users, roles, teams }))} />
          </div>
        )}
        {!inStack && (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" className="h-11 sm:h-9 sm:flex-1" onClick={() => decide(false)}>{isUpdate ? t("memory.keep") : t("memory.dontSave")}</Button>
            <Button className="h-11 sm:h-9 sm:flex-1" disabled={!state.information.trim()} onClick={() => decide(true)}>{isUpdate ? t("memory.update") : t("memory.save")}</Button>
          </div>
        )}
        {!isUpdate && <p className="text-xs text-muted-foreground">{t("memory.rememberHint")}</p>}
      </CardContent>
    </Card>
  );
}

function decisionFor(kind: "remember" | "update" | "forget", s: Edits): MemoryDecision {
  if (kind === "forget") return { v: 1, kind: "forget" };
  if (kind === "update") return { v: 1, kind: "update", information: s.information, ...(s.title ? { title: s.title } : {}), ...(s.type ? { type: s.type } : {}) };
  const rbac = s.rights_mode === "users" ? { users: s.users } : s.rights_mode === "roles" ? { roles: s.roles } : s.rights_mode === "teams" ? { teams: s.teams } : undefined;
  return { v: 1, kind: "remember", title: s.title || s.information.slice(0, 80), information: s.information, type: s.type, rights_mode: s.rights_mode, ...(rbac ? { rbac } : {}) };
}

/** Shows the current wording of an existing memory (update/forget cards). */
function MemoryRef({ memoryId, agent, label }: { memoryId: string | null; agent: Agent; label?: string }) {
  const contextId = (agent as { memory?: string }).memory ?? "";
  const { data } = useQuery(GET_ITEMS(contextId, ["id", "name", "information", "rights_mode", "created_by", "createdAt"]), {
    variables: { page: 1, limit: 1, filters: [{ id: { eq: memoryId ?? "" } }] },
    skip: !memoryId || !contextId,
  });
  const item = data?.[`${contextId}${PAGINATION_POSTFIX}`]?.items?.[0] as { name?: string; information?: string } | undefined;
  if (!memoryId) return null;
  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
      {label && <p className="mb-1 text-xs text-muted-foreground">{label}</p>}
      <p className={cn(label && "line-through decoration-muted-foreground/60")}>{item?.information ?? item?.name ?? memoryId}</p>
    </div>
  );
}
```

`MemoryRef` reuses the existing items pagination builder instead of a new query. Replace the `useQuery(GET_MEMORY_ITEM(...))` line in `MemoryRef` with:

```tsx
  const { data } = useQuery(GET_ITEMS(contextId, ["id", "name", "information", "rights_mode", "created_by", "createdAt"]), {
    variables: { page: 1, limit: 1, filters: [{ id: { eq: memoryId ?? "" } }] },
    skip: !memoryId || !contextId,
  });
  const item = (data?.[`${contextId}${PAGINATION_POSTFIX}`]?.items?.[0]) as { name?: string; information?: string } | undefined;
```

with `import { GET_ITEMS, PAGINATION_POSTFIX } from "@/app/(application)/data/queries";` (export `PAGINATION_POSTFIX` from that file if it is not exported yet). The `GET_ITEMS` builder is the one `/data/[ctx]` already uses (`app/(application)/data/queries.ts:321`), so the generated `Filter<Ctx>_items` input and the `items`/`pageInfo` shape are guaranteed to match.

`app/(application)/chat/components/memory-stack.tsx`:

```tsx
"use client";

import type { ChatAddToolApproveResponseFunction, DynamicToolUIPart } from "ai";
import { Bookmark } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Button } from "@/components/ui/button";
import type { Agent } from "@/types/models/agent";

import { DECLINED_REASON, encodeMemoryDecision, type MemoryDecision } from "./memory-card-data";
import { MemoryCard } from "./memory-card";

type Registry = { register: (toolCallId: string, read: () => MemoryDecision) => void; unregister: (toolCallId: string) => void };
const EditsContext = React.createContext<Registry | null>(null);
export const useMemoryEdits = () => React.useContext(EditsContext);

/** Consecutive remember cards under one "Save all" bar (spec §4.1). */
export function MemoryStack({ parts, agent, addToolApprovalResponse }: { parts: DynamicToolUIPart[]; agent: Agent; addToolApprovalResponse: ChatAddToolApproveResponseFunction }) {
  const t = useTranslations("chat");
  const readers = React.useRef(new Map<string, () => MemoryDecision>());
  const registry = React.useMemo<Registry>(() => ({
    register: (id, read) => { readers.current.set(id, read); },
    unregister: (id) => { readers.current.delete(id); },
  }), []);

  const decideAll = (approved: boolean) => {
    for (const part of parts) {
      const approvalId = (part as { approval?: { id?: string } }).approval?.id;
      if (!approvalId) continue;
      const read = readers.current.get(part.toolCallId);
      addToolApprovalResponse({ id: approvalId, approved, reason: approved && read ? encodeMemoryDecision(read()) : DECLINED_REASON });
    }
  };

  return (
    <EditsContext.Provider value={registry}>
      <div className="mt-3 rounded-lg border border-border p-3" data-demo-id="chat-memory-stack">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-sm font-medium"><Bookmark className="size-4 text-muted-foreground" aria-hidden="true" />{t("memory.stackTitle")}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => decideAll(false)}>{t("memory.dontSave")}</Button>
            <Button size="sm" onClick={() => decideAll(true)}>{t("memory.saveAll", { count: parts.length })}</Button>
          </div>
        </div>
        {parts.map((part) => <MemoryCard key={part.toolCallId} part={part} agent={agent} addToolApprovalResponse={addToolApprovalResponse} inStack />)}
      </div>
    </EditsContext.Provider>
  );
}
```

- [ ] **Step 4: Route memory parts in the tool-part factory**

In `message-column.tsx` `makeUntypedToolPart` (line ~120), before the `approval-requested` branch add:

```tsx
    if (isMemoryToolPart(untypedToolPart)) {
      if (guestMode) return null;
      return (
        <MemoryCard key={callId} part={untypedToolPart} agent={_agent} addToolApprovalResponse={addToolApprovalResponse} />
      );
    }
```

with imports `import { isMemoryToolPart } from "./memory-card-data";` and `import { MemoryCard } from "./memory-card";`.

Stacking: `MessageRenderer` renders parts one by one, so stacks need a pre-pass. In the assistant-message render of `components/message-renderer.tsx` (the `message.parts?.map` at line 746) compute once per message `const rememberGroups = groupRememberParts(message.parts ?? [])` and, for an index that is the first of a `stack`, render `<MemoryStack parts={indices.map(i => message.parts[i])} …/>` in place of the part and return `null` for the other indices of that stack. `MemoryStack` is passed through the existing `UntypedToolPartComponent` prop mechanism: add an optional prop `MemoryStackComponent?: React.ComponentType<{ parts: DynamicToolUIPart[]; agent: Agent; addToolApprovalResponse: ChatAddToolApproveResponseFunction }>` to `MessageRendererProps` (line 106) and pass `MemoryStack` from `message-column.tsx` where `UntypedToolPartComponent` is passed (line ~329). When the prop is absent, parts render singly (no behaviour change for other consumers).

- [ ] **Step 5: Typecheck, lint and manual check**

```bash
npx tsc --noEmit && npx eslint "app/(application)/chat/components" --max-warnings 0
```
Expected: clean.

Manual (backend running, an agent with memory on a valid base): say "Merk dir: bei AZFR 2.0 prüfe ich zuerst den Encoder-Stecker X12." → the Remember this? card appears with editable wording, a type select and the RBAC control; edit the wording, choose Public, Save → the resolved line "Saved · Public" with an Open link; the item exists in `/data/<ctx>` with the edited wording and `rights_mode` public; a reload shows the resolved line, not the card. Say "Vergiss das wieder." → the forget card, confirm → "Memory forgotten". Ask for two facts in one message → a stack with Save all.

- [ ] **Step 6: Commit**

```bash
git add "app/(application)/chat/components/memory-card.tsx" "app/(application)/chat/components/memory-stack.tsx" "app/(application)/chat/components/message-column.tsx" "app/(application)/chat/queries.ts" components/message-renderer.tsx messages/en.json messages/de.json
git commit -m "feat(memory): in-chat save, update and forget cards on the tool approval flow"
```

---

### Task 12: "Recalled N memories" block under assistant answers

**Files:**
- Create: `app/(application)/chat/components/recalled-memories-data.ts`
- Create: `app/(application)/chat/components/recalled-memories-data.test.ts`
- Create: `app/(application)/chat/components/recalled-memories.tsx`
- Modify: `components/message-renderer.tsx:106-135` (new optional prop `RecalledMemoriesComponent`), `:1199` area (render it above `MessageActions` for assistant messages)
- Modify: `app/(application)/chat/components/message-column.tsx:320-335` (pass the component)
- Modify: `messages/en.json` / `messages/de.json` (`chat.memory.recalled*` keys)

**Interfaces:**
- Consumes: `message.metadata.recalledMemories` (backend Task 7 shape), `Sources`/`SourcesTrigger`/`SourcesContent` (`components/ai-elements/sources.tsx`), `RelativeTime` (`components/primitives/relative-time.tsx`, props `date`, `live?`), `ConfirmDialog`, the generated `${ctx}_itemsDelete` mutation (see `app/(application)/data/queries.ts` `DELETE_ITEM` builder), `UserContext` (`app/(application)/authenticated.tsx:62`).
- Produces: `parseRecalledMemories(metadata: unknown): RecalledMemory[]`, `canForget(memory, userId, isSuperAdmin): boolean`, `<RecalledMemories message agent />`.

- [ ] **Step 1: Write the failing tests**

`app/(application)/chat/components/recalled-memories-data.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canForget, parseRecalledMemories } from "./recalled-memories-data";

const m = { id: "m1", contextId: "mem", title: "T", information: "F", rights_mode: "private", createdBy: { id: 4, name: "Me" }, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", source: "prefetch" };

describe("parseRecalledMemories", () => {
  it("returns the list from message metadata and [] otherwise", () => {
    expect(parseRecalledMemories({ recalledMemories: [m] })).toEqual([m]);
    expect(parseRecalledMemories({ recalledMemories: [{ id: 1 }] })).toEqual([]);
    expect(parseRecalledMemories(undefined)).toEqual([]);
    expect(parseRecalledMemories({ lastStepInputTokens: 3 })).toEqual([]);
  });
});

describe("canForget", () => {
  it("allows the creator and super admins only", () => {
    expect(canForget(m as any, 4, false)).toBe(true);
    expect(canForget(m as any, 5, false)).toBe(false);
    expect(canForget(m as any, 5, true)).toBe(true);
    expect(canForget({ ...m, createdBy: null } as any, 4, false)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run "app/(application)/chat/components/recalled-memories-data.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the data module**

`app/(application)/chat/components/recalled-memories-data.ts`:

```ts
/** Pure helpers for the "Recalled N memories" block (spec §2.5, §4.2). */
export type RecalledMemory = {
  id: string; contextId: string; title: string; information: string; type?: string;
  rights_mode: "private" | "users" | "roles" | "teams" | "public";
  createdBy: { id: number; name: string } | null;
  createdAt: string; updatedAt: string; source: "prefetch" | "knowledge_search";
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const isMemory = (v: unknown): v is RecalledMemory =>
  isRecord(v) && typeof v.id === "string" && typeof v.contextId === "string" && typeof v.information === "string" && typeof v.rights_mode === "string";

export function parseRecalledMemories(metadata: unknown): RecalledMemory[] {
  if (!isRecord(metadata) || !Array.isArray(metadata.recalledMemories)) return [];
  return metadata.recalledMemories.filter(isMemory);
}

/** Forget from chat is for the creator (or a super admin); others use Open. */
export function canForget(memory: RecalledMemory, userId: number | null | undefined, isSuperAdmin: boolean): boolean {
  if (isSuperAdmin) return true;
  return !!memory.createdBy && typeof userId === "number" && memory.createdBy.id === userId;
}
```

- [ ] **Step 4: Add i18n keys**

Inside the `chat.memory` block created in Task 11 add (en):

```json
      "recalledTrigger": "Recalled {count, plural, one {# memory} other {# memories}}",
      "recalledHint": "These shaped this answer.",
      "savedBy": "{mode} · {name}",
      "savedByYou": "{mode} · you",
      "forgetConfirmTitle": "Forget this memory?",
      "forgetConfirmDescription": "“{title}” will be deleted from the memory base.",
      "forgotToast": "Memory forgotten",
      "forgetFailed": "Couldn't forget the memory"
```

and (de):

```json
      "recalledTrigger": "{count, plural, one {# Erinnerung} other {# Erinnerungen}} genutzt",
      "recalledHint": "Sie haben diese Antwort beeinflusst.",
      "savedBy": "{mode} · {name}",
      "savedByYou": "{mode} · von dir",
      "forgetConfirmTitle": "Diese Erinnerung vergessen?",
      "forgetConfirmDescription": "„{title}“ wird aus der Gedächtnis-Basis gelöscht.",
      "forgotToast": "Erinnerung vergessen",
      "forgetFailed": "Erinnerung konnte nicht vergessen werden"
```

- [ ] **Step 5: Write the component**

`app/(application)/chat/components/recalled-memories.tsx`:

```tsx
"use client";

import { useMutation } from "@apollo/client";
import type { UIMessage } from "ai";
import { Brain, Globe, Lock, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import * as React from "react";
import { toast } from "sonner";

import { UserContext } from "@/app/(application)/authenticated";
import { DELETE_ITEM } from "@/app/(application)/data/queries";
import { ConfirmDialog } from "@/components/primitives/confirm-dialog";
import { RelativeTime } from "@/components/primitives/relative-time";
import { Sources, SourcesContent, SourcesTrigger } from "@/components/ai-elements/sources";
import { Button } from "@/components/ui/button";
import type { Agent } from "@/types/models/agent";

import { canForget, parseRecalledMemories, type RecalledMemory } from "./recalled-memories-data";

export function RecalledMemories({ message }: { message: UIMessage; agent: Agent }) {
  const t = useTranslations("chat");
  const { user } = React.useContext(UserContext);
  const memories = parseRecalledMemories(message.metadata);
  const [pending, setPending] = React.useState<RecalledMemory | null>(null);
  const [forgotten, setForgotten] = React.useState<Set<string>>(new Set());
  const [deleteItem] = useMutation(DELETE_ITEM(pending?.contextId ?? memories[0]?.contextId ?? "", ["id"]));

  if (memories.length === 0) return null;
  const visible = memories.filter((m) => !forgotten.has(m.id));

  return (
    <Sources data-demo-id="chat-recalled-memories">
      <SourcesTrigger count={visible.length}>
        <Brain className="size-4" aria-hidden="true" />
        <p className="font-medium">{t("memory.recalledTrigger", { count: visible.length })}</p>
      </SourcesTrigger>
      <SourcesContent className="w-full gap-3">
        <p className="text-xs text-muted-foreground">{t("memory.recalledHint")}</p>
        <ol className="space-y-2">
          {visible.map((m, i) => {
            const Icon = m.rights_mode === "private" ? Lock : Globe;
            const mode = t(`memory.mode.${m.rights_mode}`);
            const mine = !!user?.id && m.createdBy?.id === user.id;
            return (
              <li key={m.id} className="flex items-start gap-2 text-sm text-foreground">
                <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p>{m.information}</p>
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                    <Icon className="size-3" aria-hidden="true" />
                    {mine ? t("memory.savedByYou", { mode }) : t("memory.savedBy", { mode, name: m.createdBy?.name ?? "—" })}
                    {m.createdAt && <>· <RelativeTime date={m.createdAt} /></>}
                  </p>
                </div>
                <Button asChild variant="ghost" size="sm" className="h-8 text-xs"><Link href={`/data/${m.contextId}/items/${m.id}`}>{t("memory.open")}</Link></Button>
                {canForget(m, user?.id, !!user?.super_admin) && (
                  <Button variant="ghost" size="sm" className="h-8 text-xs text-destructive hover:text-destructive" aria-label={t("memory.forget")} onClick={() => setPending(m)}>
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      </SourcesContent>
      <ConfirmDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)} variant="destructive"
        title={t("memory.forgetConfirmTitle")} description={t("memory.forgetConfirmDescription", { title: pending?.title ?? "" })} confirmLabel={t("memory.forget")}
        onConfirm={async () => {
          if (!pending) return;
          try {
            await deleteItem({ variables: { id: pending.id } });
            setForgotten((s) => new Set(s).add(pending.id));
            toast.success(t("memory.forgotToast"));
          } catch { toast.error(t("memory.forgetFailed")); throw new Error("forget failed"); }
          finally { setPending(null); }
        }} />
    </Sources>
  );
}
```

`DELETE_ITEM(context)` is the existing per-context delete mutation builder in `app/(application)/data/queries.ts` (used by `items-table.tsx:184`); if its name differs, use that name.

- [ ] **Step 6: Render it in the message renderer**

In `components/message-renderer.tsx`: add `RecalledMemoriesComponent?: React.ComponentType<{ message: UIMessage; agent: Agent }>` to `MessageRendererProps` (line ~106) and destructure it. Directly before the block at line ~1199 (`((showActions && message.role === 'assistant') || showEdit || showRemove) && …`) add:

```tsx
              {message.role === 'assistant' && RecalledMemoriesComponent && agent && (
                <RecalledMemoriesComponent message={message} agent={agent} />
              )}
```

In `message-column.tsx` where `UntypedToolPartComponent` is passed to `MessageRenderer` (line ~329) add `RecalledMemoriesComponent={guestMode && !showRecalledToGuests ? undefined : RecalledMemories}` — simpler: always pass `RecalledMemories`; the backend already omits the metadata for guests unless allowed, so the component renders nothing.

- [ ] **Step 7: Verify**

```bash
npx vitest run "app/(application)/chat/components" && npx tsc --noEmit
```
Manual: ask a question the saved memory answers → the reply shows the inline citation badge (existing) and "Recalled 1 memory" under it; expand → wording, Private · you, relative time, Open and the trash icon; Forget → ConfirmDialog → row disappears, item gone from `/data/<ctx>`. Log in as another user → no trash icon on that memory. Reload → the block persists (metadata is stored with the message).

- [ ] **Step 8: Commit**

```bash
git add "app/(application)/chat/components/recalled-memories-data.ts" "app/(application)/chat/components/recalled-memories-data.test.ts" "app/(application)/chat/components/recalled-memories.tsx" "app/(application)/chat/components/message-column.tsx" components/message-renderer.tsx messages/en.json messages/de.json
git commit -m "feat(memory): recalled memories block with open and forget actions"
```

---

### Task 13: Header chip, "What <agent> remembers" panel, and the `mine=1` library filter

**Files:**
- Create: `app/(application)/chat/components/memory-panel.tsx`
- Create: `app/(application)/chat/components/memory-panel-data.ts`
- Create: `app/(application)/chat/components/memory-panel-data.test.ts`
- Modify: `app/(application)/chat/hooks.ts:100-160` (controller: `memoryPanelOpen`, `setMemoryPanelOpen`, `myMemoriesCount`), `:960-980` (return them)
- Modify: `app/(application)/chat/queries.ts:20-60` (`AGENT_FIELDS` gains `memory_config`), add `GET_MY_MEMORIES(contextId)`
- Modify: `app/(application)/chat/components/chat-header.tsx:366-385` (chip next to the files chip)
- Modify: `app/(application)/chat/components/session-screen.tsx:136-149` (second `SidePanel`)
- Modify: `app/(application)/data/[ctx]/components/items-tab.tsx:51-75` and `app/(application)/data/hooks.ts:205-232` (`mine=1` → `created_by` filter)
- Modify: `messages/en.json` / `messages/de.json` (`chat.memory.panel*`, `chat.header.memoryChip`, `knowledge.workspace.items.mine`)

**Interfaces:**
- Consumes: generated `${ctx}_items(filters, page, limit)` query with `{ created_by: { eq: <userId> } }` (verified in backend Task 8 step 5), `SidePanel` (`components/primitives/side-panel.tsx`, props `open onOpenChange title description actions resizable storageKey mobileSize`), `UserContext`, `DELETE_ITEM`, `ConfirmDialog`, the header `CHIP` class recipe (`chat-header.tsx:78`).
- Produces: `splitByVisibility(items)`, `isNewInSession(item, savedIdsThisSession)`, `savedIdsFromMessages(messages): Set<string>`; controller fields `memoryPanelOpen: boolean`, `setMemoryPanelOpen(open)`, `myMemoriesCount: number | null`.

- [ ] **Step 1: Write the failing tests**

`app/(application)/chat/components/memory-panel-data.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { savedIdsFromMessages, splitByVisibility } from "./memory-panel-data";

const item = (id: string, rights_mode: string) => ({ id, name: id, information: "x", rights_mode, created_by: 4, createdAt: "2026-09-01" }) as any;

describe("splitByVisibility", () => {
  it("counts private vs everything else as public", () => {
    const r = splitByVisibility([item("a", "private"), item("b", "public"), item("c", "roles")]);
    expect(r.privateItems.map((i) => i.id)).toEqual(["a"]);
    expect(r.publicItems.map((i) => i.id)).toEqual(["b", "c"]);
  });
});

describe("savedIdsFromMessages", () => {
  it("collects item ids from memory_saved outputs in this session", () => {
    const messages = [{ id: "m", role: "assistant", parts: [
      { type: "tool-memory_remember", state: "output-available", output: { type: "memory_saved", itemId: "n1" } },
      { type: "tool-memory_update", state: "output-available", output: { type: "memory_updated", itemId: "n2" } },
      { type: "text", text: "hi" },
    ] }] as any;
    expect([...savedIdsFromMessages(messages)]).toEqual(["n1"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run "app/(application)/chat/components/memory-panel-data.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the data module, query and controller state**

`app/(application)/chat/components/memory-panel-data.ts`:

```ts
import type { UIMessage } from "ai";

export type MyMemory = { id: string; name: string; information: string; type?: string | null; rights_mode: string; created_by: number | null; createdAt: string };

export function splitByVisibility(items: MyMemory[]): { privateItems: MyMemory[]; publicItems: MyMemory[] } {
  return {
    privateItems: items.filter((i) => i.rights_mode === "private"),
    publicItems: items.filter((i) => i.rights_mode !== "private"),
  };
}

/** Ids saved through remember cards in the open session → "New" badge. */
export function savedIdsFromMessages(messages: UIMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    for (const part of (m.parts ?? []) as any[]) {
      if (part?.type === "tool-memory_remember" && part?.state === "output-available" && part?.output?.type === "memory_saved" && typeof part.output.itemId === "string") ids.add(part.output.itemId);
    }
  }
  return ids;
}
```

In `app/(application)/chat/queries.ts`: add `memory_config` to `AGENT_FIELDS` (after `memory`). The "my memories" query reuses the existing pagination builder from the data page — no new query:

```ts
import { GET_ITEMS, PAGINATION_POSTFIX } from "@/app/(application)/data/queries";
export const MY_MEMORY_FIELDS = ["id", "name", "information", "type", "rights_mode", "created_by", "createdAt"];
export const GET_MY_MEMORIES = (contextId: string) => GET_ITEMS(contextId, MY_MEMORY_FIELDS);
export const myMemoriesKey = (contextId: string) => `${contextId}${PAGINATION_POSTFIX}`;
```

Variables are `{ page: 1, limit, filters: [{ created_by: { eq: userId } }] }` and the result lives under `data[myMemoriesKey(contextId)]` as `{ pageInfo: { itemCount }, items }`.

In `app/(application)/chat/hooks.ts`: add to `ChatSessionController` after the files panel fields (line ~145):

```ts
  // memory panel (memory redesign spec §4.3)
  memoryPanelOpen: boolean;
  setMemoryPanelOpen: (open: boolean) => void;
  myMemoriesCount: number | null;
```

and in `useChatSession`, next to the files panel state (line ~872):

```ts
  const [memoryPanelOpen, setMemoryPanelOpen] = React.useState(false);
  const memoryContextId = (agent as { memory?: string | null }).memory ?? null;
  const { user: currentUser } = React.useContext(UserContext);
  const myMemoriesQuery = useQuery(GET_MY_MEMORIES(memoryContextId ?? "x"), {
    variables: { filters: [{ created_by: { eq: currentUser?.id } }], page: 1, limit: 1 },
    skip: !memoryContextId || !currentUser?.id || guestMode,
    fetchPolicy: "cache-and-network",
  });
  const myMemoriesCount: number | null = memoryContextId && currentUser?.id
    ? (myMemoriesQuery.data?.[myMemoriesKey(memoryContextId)]?.pageInfo?.itemCount ?? null)
    : null;
```

and return `memoryPanelOpen, setMemoryPanelOpen, myMemoriesCount` next to `filesPanelOpen`. Refetch the count when a `memory_saved`/`memory_forgotten` output appears: `React.useEffect(() => { void myMemoriesQuery.refetch(); }, [savedIdsFromMessages(messages).size])`.

- [ ] **Step 4: i18n keys**

en, inside `chat.memory`:

```json
      "panelTitle": "What {agent} remembers",
      "panelSubtitle": "{count, plural, one {# memory} other {# memories}} · {privateCount} private, {publicCount} public",
      "tabAll": "All",
      "tabPrivate": "Private",
      "tabPublic": "Public",
      "new": "New",
      "edit": "Edit",
      "changeAccess": "Change access",
      "panelTip": "Tip: say \"forget that\" in the chat.",
      "allMine": "All my memories",
      "panelEmptyTitle": "{agent} doesn't remember anything about you yet",
      "panelEmptyDescription": "Say \"remember that …\" in the chat. You'll check the wording and choose who can see it before anything is saved."
```

en, inside `chat.header`: `"memoryChip": "Remembers {count, plural, =0 {nothing about you yet} one {# thing about you} other {# things about you}}", "memoryAria": "Open what the agent remembers"`.

de, inside `chat.memory`:

```json
      "panelTitle": "Woran sich {agent} erinnert",
      "panelSubtitle": "{count, plural, one {# Erinnerung} other {# Erinnerungen}} · {privateCount} privat, {publicCount} öffentlich",
      "tabAll": "Alle",
      "tabPrivate": "Privat",
      "tabPublic": "Öffentlich",
      "new": "Neu",
      "edit": "Bearbeiten",
      "changeAccess": "Zugriff ändern",
      "panelTip": "Tipp: Sag im Chat „vergiss das“.",
      "allMine": "Alle meine Erinnerungen",
      "panelEmptyTitle": "{agent} erinnert sich noch an nichts über dich",
      "panelEmptyDescription": "Sag im Chat „merk dir …“. Du prüfst den Wortlaut und wählst, wer es sehen darf, bevor etwas gespeichert wird."
```

de, inside `chat.header`: `"memoryChip": "Merkt sich {count, plural, =0 {noch nichts über dich} one {# Sache über dich} other {# Dinge über dich}}", "memoryAria": "Öffnen, woran sich der Agent erinnert"`.

`knowledge.workspace.items` (both files): en `"mine": "Created by me"`, de `"mine": "Von mir erstellt"`.

- [ ] **Step 5: Header chip and panel**

In `chat-header.tsx`, after the files chip (line ~383) add:

```tsx
          {!guestMode && controller.myMemoriesCount !== null ? (
            <button type="button" onClick={() => controller.setMemoryPanelOpen(true)} aria-label={t("header.memoryAria")} className={cn(CHIP, "hidden sm:inline-flex")}>
              <Bookmark className="size-3" aria-hidden="true" />
              {t("header.memoryChip", { count: controller.myMemoriesCount })}
            </button>
          ) : null}
```

(`guestMode` comes from `useChatShell()` or the controller — use whichever the header already reads for the files chip; import `Bookmark` from lucide.)

`app/(application)/chat/components/memory-panel.tsx`:

```tsx
"use client";

import { useMutation, useQuery } from "@apollo/client";
import { ChevronDown, Globe, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import * as React from "react";
import { toast } from "sonner";

import { UserContext } from "@/app/(application)/authenticated";
import { DELETE_ITEM } from "@/app/(application)/data/queries";
import { ConfirmDialog } from "@/components/primitives/confirm-dialog";
import { EmptyState } from "@/components/primitives/empty-state";
import { RelativeTime } from "@/components/primitives/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Bookmark } from "lucide-react";
import type { ChatSessionController } from "../hooks";
import { GET_MY_MEMORIES, myMemoriesKey } from "../queries";
import { savedIdsFromMessages, splitByVisibility, type MyMemory } from "./memory-panel-data";

export function MemoryPanelContent({ controller }: { controller: ChatSessionController }) {
  const t = useTranslations("chat");
  const { user } = React.useContext(UserContext);
  const agent = controller.agent;
  const contextId = (agent as { memory?: string }).memory ?? "";
  const [tab, setTab] = React.useState<"all" | "private" | "public">("all");
  const [pending, setPending] = React.useState<MyMemory | null>(null);
  const { data, refetch } = useQuery(GET_MY_MEMORIES(contextId), {
    variables: { filters: [{ created_by: { eq: user?.id } }], page: 1, limit: 200 },
    skip: !contextId || !user?.id, fetchPolicy: "cache-and-network",
  });
  const [deleteItem] = useMutation(DELETE_ITEM(contextId, ["id"]));
  const items: MyMemory[] = data?.[myMemoriesKey(contextId)]?.items ?? [];
  const { privateItems, publicItems } = splitByVisibility(items);
  const shown = tab === "private" ? privateItems : tab === "public" ? publicItems : items;
  const newIds = savedIdsFromMessages(controller.messages);

  if (items.length === 0) {
    return (
      <div className="p-4">
        <EmptyState icon={Bookmark} title={t("memory.panelEmptyTitle", { agent: agent.name })} description={t("memory.panelEmptyDescription")} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-3 p-4">
        <p className="text-xs text-muted-foreground">{t("memory.panelSubtitle", { count: items.length, privateCount: privateItems.length, publicCount: publicItems.length })}</p>
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList className="w-full">
            <TabsTrigger value="all" className="flex-1">{t("memory.tabAll")} {items.length}</TabsTrigger>
            <TabsTrigger value="private" className="flex-1">{t("memory.tabPrivate")} {privateItems.length}</TabsTrigger>
            <TabsTrigger value="public" className="flex-1">{t("memory.tabPublic")} {publicItems.length}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <ul className="flex-1 divide-y overflow-y-auto">
        {shown.map((m) => {
          const Icon = m.rights_mode === "private" ? Lock : Globe;
          return (
            <li key={m.id}>
              <Collapsible>
                <CollapsibleTrigger className="flex w-full items-start gap-2 px-4 py-3 text-left text-sm hover:bg-accent">
                  <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1">{m.information || m.name}</span>
                  {newIds.has(m.id) && <Badge variant="secondary" className="text-xs">{t("memory.new")}</Badge>}
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-2 px-4 pb-3 pl-10 text-xs text-muted-foreground">
                  <p>{m.type ? `${m.type} · ` : ""}{t(`memory.mode.${m.rights_mode}`)} · <RelativeTime date={m.createdAt} /></p>
                  <div className="flex flex-wrap gap-2">
                    <Button asChild variant="outline" size="sm"><Link href={`/data/${contextId}/items/${m.id}`}>{t("memory.edit")}</Link></Button>
                    <Button asChild variant="outline" size="sm"><Link href={`/data/${contextId}/items/${m.id}#access`}>{t("memory.changeAccess")}</Link></Button>
                    <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setPending(m)}>{t("memory.forget")}</Button>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between gap-2 border-t p-3 text-xs text-muted-foreground">
        <span>{t("memory.panelTip")}</span>
        <Button asChild variant="link" size="sm" className="h-auto p-0 text-xs"><Link href={`/data/${contextId}?mine=1`}>{t("memory.allMine")}</Link></Button>
      </div>
      <ConfirmDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)} variant="destructive"
        title={t("memory.forgetConfirmTitle")} description={t("memory.forgetConfirmDescription", { title: pending?.name ?? "" })} confirmLabel={t("memory.forget")}
        onConfirm={async () => {
          if (!pending) return;
          try { await deleteItem({ variables: { id: pending.id } }); toast.success(t("memory.forgotToast")); await refetch(); }
          catch { toast.error(t("memory.forgetFailed")); throw new Error("forget failed"); }
          finally { setPending(null); }
        }} />
    </div>
  );
}
```

In `session-screen.tsx` after the files `SidePanel` (line ~149) add:

```tsx
      <SidePanel
        open={controller.memoryPanelOpen}
        onOpenChange={controller.setMemoryPanelOpen}
        title={t("memory.panelTitle", { agent: controller.agent.name })}
        resizable
        storageKey="chat-memory"
        mobileSize="full"
      >
        <MemoryPanelContent controller={controller} />
      </SidePanel>
```

- [ ] **Step 6: `mine=1` on the knowledge item list**

In `app/(application)/data/[ctx]/components/items-tab.tsx` read `const mine = params.get("mine") === "1";`, pass `mine` to `ItemsTable` (new prop `mine: boolean`), and in `app/(application)/data/hooks.ts` where `filters` are assembled (line ~209) add `...(mine && userId ? [{ created_by: { eq: userId } }] : [])` (the hook gets `mine` and the current user id from `UserContext`). Show an active-filter chip "Created by me" using the existing filters badge (`activeFiltersCount + (mine ? 1 : 0)`) and clear it in `onClearFilters` by deleting the `mine` param.

- [ ] **Step 7: Verify**

```bash
npx vitest run "app/(application)/chat/components" && npx tsc --noEmit
```
Manual: the header shows "Remembers 1 thing about you" after a save; click → panel with tabs; the just-saved memory carries "New"; expand → Edit/Change access open the item page; Forget confirms and removes it; "All my memories" opens `/data/<ctx>?mine=1` filtered to your items. Guest chat: no chip. Below `lg` the panel is a sheet.

- [ ] **Step 8: Commit**

```bash
git add "app/(application)/chat" "app/(application)/data" messages/en.json messages/de.json
git commit -m "feat(memory): header chip, what-the-agent-remembers panel and mine=1 library filter"
```

---

### Task 14: Workbench — the Knowledge & memory section rebuilt around the memory base

**Files:**
- Create: `app/(application)/agents/edit/[id]/components/memory-section.tsx`
- Create: `app/(application)/agents/edit/[id]/components/memory-section-data.ts`
- Create: `app/(application)/agents/edit/[id]/components/memory-section-data.test.ts`
- Modify: `app/(application)/agents/edit/[id]/sections/knowledge.tsx:163-245` (replace the memory card with `<MemorySection>`)
- Modify: `app/(application)/agents/edit/[id]/hooks.ts:202-203, 255-257, 283, 302, 353, 399, 420, 453, 493-494` (editor state `memoryConfig` next to `memory`)
- Modify: `app/(application)/agents/edit/[id]/queries.ts:74, 254-262, 290, 318, 348` (`memory_config` in the agent query/mutation; `GET_CONTEXTS_EDITOR` gains `fields memoryBase { ok missing }`)
- Modify: `app/(application)/agents/edit/[id]/components/knowledge-search/wizard.tsx:34-35, 136-138` and `steps/memory-step.tsx` (step becomes a pointer to the section)
- Modify: `types/models/agent.ts:83` (`memory_config`)
- Modify: `messages/en.json:454-484` / `messages/de.json` (`agents.editor.memory.*`)

**Interfaces:**
- Consumes: `memoryBaseStats(contextId)` and `Context.memoryBase` (backend Task 8), `resolveMemoryConfig` semantics (Task 1; re-implemented client-side as `normalizeMemoryConfig`), `SettingRow` (`components/primitives/setting-row.tsx`), `Switch`, `Combobox` pattern from the current `knowledge.tsx:179-244`, `ConfirmDialog`, the knowledge-search `memory` config entry (`config-schema.ts:161-168`, `MEMORY_DEFAULTS`).
- Produces: `normalizeMemoryConfig(raw): MemoryConfig`, `sortContextsForPicker(contexts, usedBy): PickerEntry[]`, `MEMORY_LIMIT_MIN/MAX`, `<MemorySection editor refs />`; editor state `memoryConfig`, `setMemoryConfig`.

- [ ] **Step 1: Write the failing tests**

`app/(application)/agents/edit/[id]/components/memory-section-data.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeMemoryConfig, sortContextsForPicker } from "./memory-section-data";

describe("normalizeMemoryConfig", () => {
  it("mirrors the backend defaults and clamps", () => {
    expect(normalizeMemoryConfig(null)).toEqual({ retrieval: { enabled: true, limit: 10 }, visibility: "ask", guests: { showRecalled: false } });
    expect(normalizeMemoryConfig('{"retrieval":{"limit":99}}').retrieval.limit).toBe(50);
    expect(normalizeMemoryConfig({ visibility: "preselect_private" }).visibility).toBe("preselect_private");
  });
});

describe("sortContextsForPicker", () => {
  const contexts = [
    { id: "docs", name: "Docs", memoryBase: { ok: false, missing: ["information", "type"] } },
    { id: "team", name: "Team memory", memoryBase: { ok: true, missing: [] } },
    { id: "mem", name: "Agent memory", memoryBase: { ok: true, missing: [] } },
  ] as any;
  it("lists valid bases used by other agents first, then valid, then invalid (disabled with missing fields)", () => {
    const r = sortContextsForPicker(contexts, { team: ["Alfredinio", "Ersatzteil-Bot"] });
    expect(r.map((e) => e.id)).toEqual(["team", "mem", "docs"]);
    expect(r[0]).toMatchObject({ usedBy: ["Alfredinio", "Ersatzteil-Bot"], disabled: false });
    expect(r[2]).toMatchObject({ disabled: true, missing: ["information", "type"] });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run "app/(application)/agents/edit/[id]/components/memory-section-data.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the data module**

`app/(application)/agents/edit/[id]/components/memory-section-data.ts`:

```ts
export type MemoryConfig = {
  retrieval: { enabled: boolean; limit: number };
  visibility: "ask" | "preselect_private";
  guests: { showRecalled: boolean };
};
export const MEMORY_LIMIT_MIN = 1;
export const MEMORY_LIMIT_MAX = 50;
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = { retrieval: { enabled: true, limit: 10 }, visibility: "ask", guests: { showRecalled: false } };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Same rules as backend src/exulu/memory/config.ts resolveMemoryConfig. */
export function normalizeMemoryConfig(raw: unknown): MemoryConfig {
  let value: unknown = raw;
  if (typeof raw === "string") { try { value = JSON.parse(raw); } catch { value = undefined; } }
  if (!isRecord(value)) return structuredClone(DEFAULT_MEMORY_CONFIG);
  const retrieval = isRecord(value.retrieval) ? value.retrieval : {};
  const guests = isRecord(value.guests) ? value.guests : {};
  const n = Number(retrieval.limit);
  return {
    retrieval: {
      enabled: typeof retrieval.enabled === "boolean" ? retrieval.enabled : true,
      limit: Number.isFinite(n) ? Math.min(MEMORY_LIMIT_MAX, Math.max(MEMORY_LIMIT_MIN, Math.round(n))) : 10,
    },
    visibility: value.visibility === "preselect_private" ? "preselect_private" : "ask",
    guests: { showRecalled: typeof guests.showRecalled === "boolean" ? guests.showRecalled : false },
  };
}

export type PickerContext = { id: string; name: string; description?: string | null; memoryBase?: { ok: boolean; missing: string[] } | null };
export type PickerEntry = PickerContext & { disabled: boolean; missing: string[]; usedBy: string[] };

/** Valid bases used by other agents first, then valid, then invalid (disabled). */
export function sortContextsForPicker(contexts: PickerContext[], usedBy: Record<string, string[]>): PickerEntry[] {
  const entries = contexts.map<PickerEntry>((c) => ({
    ...c, disabled: !(c.memoryBase?.ok ?? false), missing: c.memoryBase?.missing ?? ["information", "type"], usedBy: usedBy[c.id] ?? [],
  }));
  const rank = (e: PickerEntry) => (e.disabled ? 2 : e.usedBy.length > 0 ? 0 : 1);
  return entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: Editor state, queries and types**

- `types/models/agent.ts:83`: add `memory_config?: unknown;` after `memory?: string;`.
- `queries.ts`: add `memory_config` to the agent fields (line 74), `$memory_config: JSON` to the update mutation variables (line ~290), `memory_config: $memory_config` in the input (line ~318) and `memory_config` in the returned fields (line ~348). `GET_CONTEXTS_EDITOR` (line 254) selects `id name description fields memoryBase { ok missing }`. Add:

```ts
export const GET_MEMORY_BASE_STATS = gql`
  query MemoryBaseStats($contextId: ID!) {
    memoryBaseStats(contextId: $contextId) { total public private contributors lastSavedAt lastSavedBy { id name } }
  }
`;
export const GET_AGENTS_USING_MEMORY = gql`
  query AgentsUsingMemory { agents(page: 1, limit: 200) { items { id name memory } } }
`;
```

  (Match the `agents` list query's argument names to the one used in `app/(application)/agents/queries.ts`.)
- `hooks.ts`: mirror `memory` exactly for `memoryConfig`: state `const [memoryConfig, setMemoryConfig] = React.useState<MemoryConfig>(normalizeMemoryConfig((agent as any).memory_config));` (line 255), snapshot `memoryConfig: JSON.stringify(normalizeMemoryConfig((agent as any).memory_config))` (283), dirty check `JSON.stringify(memoryConfig) !== snapshot.memoryConfig` (302), save payload `memory_config: memory ? memoryConfig : null` (353), snapshot reset (399), deps (420), reset (453), return (493). Add `memoryConfig`/`setMemoryConfig` to the editor interface (202).

- [ ] **Step 5: i18n**

en, new block `agents.editor.memory` (next to `editor.knowledge`, line 454):

```json
      "memory": {
        "title": "Memory",
        "on": "On",
        "off": "Off",
        "intro": "Let {agent} remember what people tell it in chat – their role, preferences, fixes that worked – and use it in later conversations. People always confirm the wording and who can see it before anything is saved.",
        "step1": "Someone says “remember that …” or shares something useful.",
        "step2": "They check the wording and choose Private or Public.",
        "step3": "{agent} uses it in later answers and shows when it did.",
        "whereTitle": "Where should memories be stored?",
        "useExisting": "Use an existing memory base",
        "useExistingHint": "A knowledge base with an information field and a type field. One base can serve several agents.",
        "pickPlaceholder": "Choose a knowledge base",
        "usedBy": "used by {names}",
        "notConfigured": "Not configured correctly for memory, must include the fields: {fields}",
        "turnOn": "Turn on memory",
        "storedIn": "Stored in",
        "changeStore": "Change store",
        "turnOff": "Turn off",
        "turnOffTitle": "Turn off memory for {agent}?",
        "turnOffDescription": "The agent stops saving and recalling memories. Existing memories stay in the knowledge base.",
        "changeStoreTitle": "Change the memory store?",
        "changeStoreDescription": "Memories already saved stay in the current base and will not move.",
        "statsMemories": "Memories",
        "statsSplit": "{public} public · {private} private",
        "statsContributors": "Contributors",
        "statsLastSaved": "Last saved",
        "statsBy": "by {name}",
        "never": "never",
        "howTitle": "How {agent} uses memories",
        "howHint": "People see public memories and their own private ones – never other people's private memories.",
        "retrievalLabel": "Look up memories before every answer",
        "retrievalHint": "Finds memories that match the question and gives them to {agent} as background.",
        "usesSearch": "Uses knowledge search",
        "overrideLabel": "Let shared memories win over documents",
        "overrideHint": "If a shared memory contradicts a document, {agent} follows the memory and says so.",
        "fileLabel": "Open documents that memories point to",
        "fileHint": "When a memory names a document, {agent} reads that document first.",
        "augmentLabel": "Widen searches with terms people taught it",
        "augmentHint": "Adds synonyms from memories and the glossary so documents are found under either name.",
        "searchOff": "Turn on Knowledge search above to use this.",
        "recallOff": "Turn on “Look up memories before every answer” to use this.",
        "nestedTitle": "When knowledge search runs, recalled memories may also…",
        "limitUnit": "per answer",
        "rulesTitle": "Sharing rules",
        "visibilityLabel": "Visibility question",
        "visibilityHint": "Users can still change it on the save card.",
        "askEveryTime": "Ask every time",
        "preselectPrivate": "Preselect Private",
        "limitLabel": "Memories per answer",
        "limitHint": "More memories give more context but cost more tokens.",
        "guestsLabel": "Guest chats",
        "guestsHint": "Guests have no account, so they cannot save memories. Public memories are still used for their answers.",
        "guestsShow": "Show recalled memories to guests",
        "warningMissing": "The configured memory base “{id}” no longer exists in this deployment. Memory is off until you choose another one.",
        "warningInvalid": "“{name}” is not configured correctly for memory (missing: {fields}). Memories are still recalled, but nothing new can be saved.",
        "wizardMoved": "Memory settings moved to the Knowledge & memory section.",
        "wizardOpen": "Open memory settings"
      },
```

de, same keys:

```json
      "memory": {
        "title": "Gedächtnis",
        "on": "An",
        "off": "Aus",
        "intro": "{agent} merkt sich, was Menschen im Chat erzählen – Rolle, Vorlieben, Lösungen, die funktioniert haben – und nutzt es in späteren Gesprächen. Vor dem Speichern bestätigen die Nutzer immer Wortlaut und Sichtbarkeit.",
        "step1": "Jemand sagt „merk dir …“ oder teilt etwas Nützliches.",
        "step2": "Die Person prüft den Wortlaut und wählt Privat oder Öffentlich.",
        "step3": "{agent} nutzt es in späteren Antworten und zeigt das an.",
        "whereTitle": "Wo sollen Erinnerungen gespeichert werden?",
        "useExisting": "Bestehende Gedächtnis-Basis verwenden",
        "useExistingHint": "Eine Wissensbasis mit einem information- und einem type-Feld. Eine Basis kann mehrere Agenten bedienen.",
        "pickPlaceholder": "Wissensbasis wählen",
        "usedBy": "genutzt von {names}",
        "notConfigured": "Nicht korrekt für Gedächtnis konfiguriert, muss die Felder enthalten: {fields}",
        "turnOn": "Gedächtnis einschalten",
        "storedIn": "Gespeichert in",
        "changeStore": "Basis wechseln",
        "turnOff": "Ausschalten",
        "turnOffTitle": "Gedächtnis von {agent} ausschalten?",
        "turnOffDescription": "Der Agent speichert und nutzt keine Erinnerungen mehr. Bestehende Erinnerungen bleiben in der Wissensbasis.",
        "changeStoreTitle": "Gedächtnis-Basis wechseln?",
        "changeStoreDescription": "Bereits gespeicherte Erinnerungen bleiben in der bisherigen Basis und werden nicht verschoben.",
        "statsMemories": "Erinnerungen",
        "statsSplit": "{public} öffentlich · {private} privat",
        "statsContributors": "Beitragende",
        "statsLastSaved": "Zuletzt gespeichert",
        "statsBy": "von {name}",
        "never": "noch nie",
        "howTitle": "Wie {agent} Erinnerungen nutzt",
        "howHint": "Nutzer sehen öffentliche Erinnerungen und ihre eigenen privaten – nie die privaten Erinnerungen anderer.",
        "retrievalLabel": "Vor jeder Antwort Erinnerungen nachschlagen",
        "retrievalHint": "Findet passende Erinnerungen und gibt sie {agent} als Hintergrund.",
        "usesSearch": "Nutzt Wissenssuche",
        "overrideLabel": "Geteilte Erinnerungen gehen Dokumenten vor",
        "overrideHint": "Widerspricht eine geteilte Erinnerung einem Dokument, folgt {agent} der Erinnerung und sagt das.",
        "fileLabel": "Dokumente öffnen, auf die Erinnerungen verweisen",
        "fileHint": "Nennt eine Erinnerung ein Dokument, liest {agent} dieses zuerst.",
        "augmentLabel": "Suchen mit gelernten Begriffen erweitern",
        "augmentHint": "Ergänzt Synonyme aus Erinnerungen und Glossar, damit Dokumente unter beiden Namen gefunden werden.",
        "searchOff": "Schalte oben die Wissenssuche ein, um das zu nutzen.",
        "recallOff": "Schalte „Vor jeder Antwort Erinnerungen nachschlagen“ ein, um das zu nutzen.",
        "nestedTitle": "Wenn die Wissenssuche läuft, dürfen genutzte Erinnerungen außerdem…",
        "limitUnit": "pro Antwort",
        "rulesTitle": "Freigaberegeln",
        "visibilityLabel": "Frage nach Sichtbarkeit",
        "visibilityHint": "Nutzer können sie auf der Speicherkarte weiterhin ändern.",
        "askEveryTime": "Jedes Mal fragen",
        "preselectPrivate": "Privat vorauswählen",
        "limitLabel": "Erinnerungen pro Antwort",
        "limitHint": "Mehr Erinnerungen geben mehr Kontext, kosten aber mehr Tokens.",
        "guestsLabel": "Gast-Chats",
        "guestsHint": "Gäste haben kein Konto und können nichts speichern. Öffentliche Erinnerungen werden für ihre Antworten trotzdem genutzt.",
        "guestsShow": "Genutzte Erinnerungen Gästen anzeigen",
        "warningMissing": "Die konfigurierte Gedächtnis-Basis „{id}“ existiert in dieser Installation nicht mehr. Das Gedächtnis ist aus, bis du eine andere wählst.",
        "warningInvalid": "„{name}“ ist nicht korrekt für Gedächtnis konfiguriert (fehlt: {fields}). Erinnerungen werden weiter genutzt, aber nichts Neues kann gespeichert werden.",
        "wizardMoved": "Die Gedächtnis-Einstellungen sind jetzt im Bereich Wissen & Gedächtnis.",
        "wizardOpen": "Gedächtnis-Einstellungen öffnen"
      },
```

- [ ] **Step 6: Write the section component**

`app/(application)/agents/edit/[id]/components/memory-section.tsx` (structure; every control reads/writes editor state, saving stays with the page's Save changes):

```tsx
"use client";

import { useQuery } from "@apollo/client";
import { Bookmark, Check, ChevronsUpDown, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import * as React from "react";

import { ConfirmDialog } from "@/components/primitives/confirm-dialog";
import { RelativeTime } from "@/components/primitives/relative-time";
import { SettingRow } from "@/components/primitives/setting-row";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import { GET_AGENTS_USING_MEMORY, GET_MEMORY_BASE_STATS } from "../queries";
import type { EditorSectionProps } from "../sections/types";
import { MEMORY_DEFAULTS, parseWizardConfig, serializeWizardConfig } from "./knowledge-search/config-schema";
import type { ToolConfigEntry } from "./tool-config-fields";
import { MEMORY_LIMIT_MAX, MEMORY_LIMIT_MIN, sortContextsForPicker, type PickerEntry } from "./memory-section-data";

export function MemorySection({ editor, refs }: EditorSectionProps) {
  const t = useTranslations("agents");
  const agentName = editor.values?.name ?? "";
  const contextId = editor.memory;
  const selected = refs.contexts.find((c) => c.id === contextId);
  const memoryOn = !!contextId;

  const { data: agentsData } = useQuery(GET_AGENTS_USING_MEMORY);
  const usedBy = React.useMemo<Record<string, string[]>>(() => {
    const map: Record<string, string[]> = {};
    for (const a of agentsData?.agents?.items ?? []) if (a.memory && a.id !== editor.agentId) (map[a.memory] ??= []).push(a.name);
    return map;
  }, [agentsData, editor.agentId]);
  const entries = React.useMemo(() => sortContextsForPicker(refs.contexts as never, usedBy), [refs.contexts, usedBy]);

  const { data: statsData } = useQuery(GET_MEMORY_BASE_STATS, { variables: { contextId }, skip: !memoryOn });
  const stats = statsData?.memoryBaseStats;

  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pendingPick, setPendingPick] = React.useState<PickerEntry | null>(null);
  const [confirmOff, setConfirmOff] = React.useState(false);
  const [confirmChange, setConfirmChange] = React.useState(false);

  // Knowledge-search memory toggles live in the agentic_context_search config entry.
  const agenticTool = editor.tools.find((x) => x.id === "agentic_context_search");
  const searchOn = !!agenticTool;
  const wizardCfg = parseWizardConfig((agenticTool?.config as ToolConfigEntry[]) ?? []);
  const setSearchMemory = (patch: Partial<typeof MEMORY_DEFAULTS>) => {
    if (!agenticTool) return;
    const next = serializeWizardConfig({ ...wizardCfg, memory: { ...wizardCfg.memory, ...patch } });
    editor.setTools(editor.tools.map((x) => (x.id === "agentic_context_search" ? { ...x, config: next as never } : x)));
  };
  const cfg = editor.memoryConfig;
  const setCfg = (patch: Partial<typeof cfg>) => editor.setMemoryConfig({ ...cfg, ...patch });

  const Picker = (
    <Popover modal open={pickerOpen} onOpenChange={setPickerOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" className="w-full justify-between text-sm">
          {pendingPick?.name ?? selected?.name ?? t("editor.memory.pickPlaceholder")}
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[320px] p-0" style={{ width: "var(--radix-popover-trigger-width)" }}>
        <Command>
          <CommandInput placeholder={t("editor.knowledge.searchContexts")} />
          <CommandList>
            <CommandEmpty>{t("editor.knowledge.noContexts")}</CommandEmpty>
            <CommandGroup>
              {entries.map((e) => (
                <CommandItem key={e.id} value={e.name} disabled={e.disabled} onSelect={() => { setPendingPick(e); setPickerOpen(false); }} className={cn(e.disabled && "opacity-50")}>
                  <Check className={cn("mr-2 size-4", (pendingPick?.id ?? contextId) === e.id ? "opacity-100" : "opacity-0")} />
                  <div className="flex min-w-0 flex-col">
                    <span>{e.name}</span>
                    <span className="line-clamp-1 text-xs text-muted-foreground">
                      {e.disabled ? t("editor.memory.notConfigured", { fields: e.missing.join(", ") }) : e.usedBy.length ? t("editor.memory.usedBy", { names: e.usedBy.join(", ") }) : e.description ?? ""}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );

  if (!memoryOn) {
    return (
      <div className="space-y-4 rounded-lg border p-4" data-demo-id="agent-memory-off">
        <Header on={false} t={t} />
        <p className="text-sm text-muted-foreground">{t("editor.memory.intro", { agent: agentName })}</p>
        <ol className="grid gap-2 sm:grid-cols-3">
          {["step1", "step2", "step3"].map((k, i) => (
            <li key={k} className="flex gap-2 rounded-md bg-muted/40 p-3 text-sm"><span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-xs">{i + 1}</span>{t(`editor.memory.${k}`, { agent: agentName })}</li>
          ))}
        </ol>
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("editor.memory.whereTitle")}</p>
          <p className="text-sm">{t("editor.memory.useExisting")}</p>
          <p className="text-xs text-muted-foreground">{t("editor.memory.useExistingHint")}</p>
          {Picker}
        </div>
        <div className="flex justify-end">
          <Button disabled={!pendingPick} onClick={() => { if (pendingPick) { editor.setMemory(pendingPick.id); setPendingPick(null); } }}>
            <Bookmark className="mr-2 size-4" aria-hidden="true" />{t("editor.memory.turnOn")}
          </Button>
        </div>
      </div>
    );
  }

  const invalid = selected && selected.memoryBase && !selected.memoryBase.ok;
  return (
    <div className="space-y-4 rounded-lg border p-4" data-demo-id="agent-memory-on">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Header on t={t} />
          <p className="text-sm text-muted-foreground">
            {t("editor.memory.storedIn")} {selected ? <Link className="underline" href={`/data/${selected.id}`}>{selected.name}</Link> : <code>{contextId}</code>}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setConfirmChange(true)}>{t("editor.memory.changeStore")}</Button>
          <Button variant="outline" onClick={() => setConfirmOff(true)}>{t("editor.memory.turnOff")}</Button>
        </div>
      </div>

      {!selected && <Alert variant="destructive"><TriangleAlert className="size-4" /><AlertDescription>{t("editor.memory.warningMissing", { id: contextId })}</AlertDescription></Alert>}
      {invalid && <Alert><TriangleAlert className="size-4" /><AlertDescription>{t("editor.memory.warningInvalid", { name: selected!.name, fields: selected!.memoryBase!.missing.join(", ") })}</AlertDescription></Alert>}

      {stats && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label={t("editor.memory.statsMemories")} value={stats.total} hint={t("editor.memory.statsSplit", { public: stats.public, private: stats.private })} />
          <Stat label={t("editor.memory.statsContributors")} value={stats.contributors} />
          <Stat label={t("editor.memory.statsLastSaved")} value={stats.lastSavedAt ? <RelativeTime date={stats.lastSavedAt} /> : t("editor.memory.never")} hint={stats.lastSavedBy ? t("editor.memory.statsBy", { name: stats.lastSavedBy.name }) : undefined} />
        </div>
      )}

      <div className="space-y-1">
        <p className="text-sm font-medium">{t("editor.memory.howTitle", { agent: agentName })}</p>
        <p className="text-xs text-muted-foreground">{t("editor.memory.howHint")}</p>
      </div>
      {/* Primary switch: the ONE place memory retrieval is turned on (spec §3.1 "recall once"). */}
      <SettingRow label={t("editor.memory.retrievalLabel")} description={t("editor.memory.retrievalHint", { agent: agentName })}>
        <div className="flex items-center gap-3">
          <Input id="memory-limit" aria-label={t("editor.memory.limitLabel")} type="number" min={MEMORY_LIMIT_MIN} max={MEMORY_LIMIT_MAX} className="w-20"
            disabled={!cfg.retrieval.enabled} value={cfg.retrieval.limit}
            onChange={(e) => setCfg({ retrieval: { ...cfg.retrieval, limit: Math.min(MEMORY_LIMIT_MAX, Math.max(MEMORY_LIMIT_MIN, Number(e.target.value) || MEMORY_LIMIT_MIN)) } })} />
          <span className="text-xs text-muted-foreground">{t("editor.memory.limitUnit")}</span>
          <Switch checked={cfg.retrieval.enabled} onCheckedChange={(v) => setCfg({ retrieval: { ...cfg.retrieval, enabled: v } })} />
        </div>
      </SettingRow>
      {/* Nested: what knowledge search may additionally do with the recalled set. */}
      <div className={cn("ml-4 space-y-1 border-l pl-4", (!cfg.retrieval.enabled || !searchOn) && "opacity-60")}>
        <p className="text-xs font-medium text-muted-foreground">{t("editor.memory.nestedTitle")}</p>
        {([["override", "overrideLabel", "overrideHint"], ["filePrioritization", "fileLabel", "fileHint"], ["queryAugmentation", "augmentLabel", "augmentHint"]] as const).map(([key, label, hint]) => {
          const nestedDisabled = !cfg.retrieval.enabled || !searchOn;
          const description = !cfg.retrieval.enabled ? t("editor.memory.recallOff") : !searchOn ? t("editor.memory.searchOff") : t(`editor.memory.${hint}`, { agent: agentName });
          return (
            <SettingRow key={key} label={t(`editor.memory.${label}`)} description={description}>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="font-normal">{t("editor.memory.usesSearch")}</Badge>
                <Switch disabled={nestedDisabled} checked={!nestedDisabled && wizardCfg.memory[key]} onCheckedChange={(v) => setSearchMemory({ [key]: v })} />
              </div>
            </SettingRow>
          );
        })}
      </div>

      <p className="text-sm font-medium">{t("editor.memory.rulesTitle")}</p>
      <SettingRow label={t("editor.memory.visibilityLabel")} description={t("editor.memory.visibilityHint")}>
        <ToggleGroup type="single" value={cfg.visibility} onValueChange={(v) => v && setCfg({ visibility: v as typeof cfg.visibility })}>
          <ToggleGroupItem value="ask">{t("editor.memory.askEveryTime")}</ToggleGroupItem>
          <ToggleGroupItem value="preselect_private">{t("editor.memory.preselectPrivate")}</ToggleGroupItem>
        </ToggleGroup>
      </SettingRow>
      <SettingRow label={t("editor.memory.guestsLabel")} description={t("editor.memory.guestsHint")}>
        <div className="flex items-center gap-2 text-sm"><span>{t("editor.memory.guestsShow")}</span><Switch checked={cfg.guests.showRecalled} onCheckedChange={(v) => setCfg({ guests: { showRecalled: v } })} /></div>
      </SettingRow>

      <ConfirmDialog open={confirmOff} onOpenChange={setConfirmOff} variant="destructive" title={t("editor.memory.turnOffTitle", { agent: agentName })} description={t("editor.memory.turnOffDescription")} confirmLabel={t("editor.memory.turnOff")} onConfirm={async () => { editor.setMemory(""); }} />
      <ConfirmDialog open={confirmChange} onOpenChange={setConfirmChange} title={t("editor.memory.changeStoreTitle")} description={<div className="space-y-3"><p>{t("editor.memory.changeStoreDescription")}</p>{Picker}</div>} confirmLabel={t("editor.memory.changeStore")} onConfirm={async () => { if (pendingPick) { editor.setMemory(pendingPick.id); setPendingPick(null); } }} />
    </div>
  );
}

function Header({ on, t }: { on: boolean; t: ReturnType<typeof useTranslations> }) {
  return (
    <p className="flex items-center gap-2 text-sm font-medium">
      <Bookmark className="size-4 text-muted-foreground" aria-hidden="true" />
      {t("editor.memory.title")}
      <Badge variant={on ? "default" : "outline"} className="font-normal">{on ? t("editor.memory.on") : t("editor.memory.off")}</Badge>
    </p>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-medium">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
```

`editor.values?.name` and `editor.agentId`: use whatever the editor hook exposes for the agent's name and id (see `hooks.ts:196-230`; add `agentId: agent.id` to the editor object if absent).

- [ ] **Step 7: Replace the old card and the wizard step**

- `sections/knowledge.tsx:163-245`: delete the `{/* Memory context (item 52) */}` block and render `<MemorySection editor={editor} refs={refs} />` in its place; remove now-unused imports (`Command*`, `Popover*`, `Check`, `ChevronsUpDown`) if nothing else in the file uses them.
- `knowledge-search/steps/memory-step.tsx`: replace the body with a note + button:

```tsx
export function MemoryStep({ onOpenSection }: { onOpenSection: () => void }) {
  const t = useTranslations("agents");
  return (
    <div className="space-y-2 rounded-md border p-4">
      <p className="text-sm">{t("editor.memory.wizardMoved")}</p>
      <Button variant="outline" size="sm" onClick={onOpenSection}>{t("editor.memory.wizardOpen")}</Button>
    </div>
  );
}
```

  In `wizard.tsx:136-138` pass `onOpenSection={() => { onOpenChange(false); document.getElementById("knowledge")?.scrollIntoView({ behavior: "smooth" }); }}`. Keep `"memory"` in `WIZARD_STEPS` so deep links `?wizard=memory` still resolve. The review step keeps reading `draft.memory.enabled` unchanged.

- [ ] **Step 8: Verify**

```bash
npx vitest run "app/(application)/agents" && npx tsc --noEmit && npx eslint "app/(application)/agents/edit" --max-warnings 0
```
Manual: agent without memory → Off state, picker lists valid bases first with "used by …", invalid ones greyed with the missing-fields hint and not selectable; Turn on memory → On state with stats (counts match `/data/<ctx>`), the primary switch with the limit field, the three nested switches (disabled with the "recall off" hint when the primary switch is off, with the "knowledge search off" hint when search is off), sharing rules; Save changes persists `memory` and `memory_config` (check the agent query); Turn off → ConfirmDialog → Off state; Change store → ConfirmDialog with the picker. Wizard's Memory step shows the pointer.

- [ ] **Step 9: Commit**

```bash
git add "app/(application)/agents" types/models/agent.ts messages/en.json messages/de.json
git commit -m "feat(memory): workbench memory section with base picker, stats, retrieval and sharing rules"
```

---

### Task 15: Whole-branch verification and handoff

**Files:** none new.

- [ ] **Step 1: Backend**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend-agent-memory && git branch --show-current
npx jest --silent 2>&1 | tail -6 && npx tsc --noEmit -p tsconfig.json && npm run build
```
Expected: only the three pre-existing unrelated suites fail (`compact-session`, `email-inbound/intake`, `resolve-context-window`); build clean.

- [ ] **Step 2: Frontend**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend-agent-memory && git branch --show-current
npx vitest run 2>&1 | tail -4 && npx tsc --noEmit && npx eslint "app/(application)/chat" "app/(application)/agents/edit" "app/(application)/data" --max-warnings 0 && npm run build
```
Expected: only the pre-existing `nav-config` single-right test fails; build clean (Turbopack needs the hard-linked `node_modules`, already in place).

- [ ] **Step 3: End-to-end UAT script (both servers running, two users, one guest agent)**

1. Builder turns memory on for an agent, picks Newton's base (valid) — invalid contexts are greyed.
2. User A: "Merk dir: …" → card → edit wording → Public → Save → resolved line + Open link → item in `/data/<ctx>` with `created_by` = A.
3. User A asks a related question → citation badge + "Recalled 1 memory" (Private/Public label, "you").
4. User B asks the same → recalled block shows "Public · <A's name>", no Forget icon; B says "that's wrong" → model calls `memory_update` → no card; reply names A.
5. User A: "Das stimmt nicht mehr: …" → update card with old struck through → Update memory → "Memory updated".
6. User A: "Vergiss das." → forget card → ConfirmDialog → "Memory forgotten"; header chip count drops; panel updates.
7. Guest chat on a public agent: no chip, no cards; with `guests.showRecalled` off no recalled block; on → block visible.
8. Builder sets limit 3 and Preselect Private → the next card preselects Private; the prompt block (server log) lists at most 3 memories.
9. Reload every screen mid-flow: cards show resolved states, never re-execute.

- [ ] **Step 4: Report**

Summarise per repo: commits on `feat/agent-memory`, test totals, the pre-existing failures left untouched, the UAT results, and the Newlift eval verdict from Task 8b (link the report). Do not push or merge; Daniel decides.
