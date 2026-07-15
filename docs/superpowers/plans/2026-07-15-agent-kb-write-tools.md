# Agent Knowledge-Base Write Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Exulu agents create/update items in selected knowledge bases (ExuluContexts) via dynamically-injected per-context tool pairs, configured per agent in the agent editor's Knowledge section.

**Architecture:** A `knowledge_base_editor` entry stored in the existing `agents.tools` JSON holds per-context `{create, update}` permissions + a `skip_approval` flag. At chat time, `convertExuluToolsToAiSdkTools` expands that entry into `create_<ctx>_item` / `update_<ctx>_item` ExuluTools whose zod schemas are built from each context's field definitions. Updates are additionally gated by a new `checkItemWriteAccess` helper replicating the GraphQL `validateWriteAccess` rbac-table semantics. The frontend adds a "Knowledge base editing" block to the Knowledge section of the agent editor.

**Tech Stack:** Backend: TypeScript, zod, Knex, jest (`npm test`). Frontend: Next.js, React, shadcn/ui, next-intl, zod.

**Spec:** `docs/superpowers/specs/2026-07-15-agent-kb-write-tools-design.md` (read it first — it records every decision and gotcha).

## Global Constraints

- Backend repo: `/Users/daniel.claessen/Desktop/Projects/exulu/backend` (branch `develop`). Frontend repo: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend` (branch `main`).
- Path aliases (backend): `@SRC` → `src/`, `@EE` → `ee/`, `@EXULU_TYPES` → `types/`.
- New backend code lives in core `src/`, NOT `ee/` (no EE-license coupling).
- Tool ids must match `^[a-z_][a-z0-9_]{4,79}` — the sanitized context-id segment of generated tool ids is capped at 68 chars.
- Write access is **explicit opt-in**: a context or flag missing from the stored config means NO write access (never default-enabled).
- Config parsing must NEVER throw — malformed config degrades to "no writable contexts".
- Field exclusions from tool schemas: types `file` and `uuid`, plus any field with `calculated: true` or `editable: false`. Never expose `fts` or the processor `field` artifact.
- `external_id` is lookup-only on update (never written back). Neither tool exposes `rights_mode`/visibility inputs.
- Update refusals for "row missing" and "no write access" use the SAME generic message (no existence probing).
- Backend tests: jest, co-located `*.test.ts`, run with `npm test -- <path>`.
- Backend node version is pinned to v22.18.0 (preinstall check).
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Backend config parser (`kb-editor-config.ts`)

**Files:**
- Create: `src/templates/tools/kb-editor-config.ts`
- Test: `src/templates/tools/kb-editor-config.test.ts`

**Interfaces:**
- Consumes: `ExuluAgentToolConfig` from `@EXULU_TYPES/models/exulu-agent-tool-config` (shape: `{id, type, config: [{name, variable, type, value?, default?}]}`).
- Produces (used by Tasks 3, 4, 5):
  - `KB_EDITOR_TOOL_ID = "knowledge_base_editor"` (const string)
  - `type KbWritePermissions = { create: boolean; update: boolean }`
  - `type KbEditorConfig = { enabled: boolean; knowledgeBases: Record<string, KbWritePermissions>; skipApproval: boolean }`
  - `parseKbEditorConfig(tools: ExuluAgentToolConfig[] | string | null | undefined): KbEditorConfig`

- [ ] **Step 1: Write the failing test**

Create `src/templates/tools/kb-editor-config.test.ts`:

```ts
import { parseKbEditorConfig, KB_EDITOR_TOOL_ID } from "./kb-editor-config";

const entry = (config: any[]) => [{ id: KB_EDITOR_TOOL_ID, type: "function", config }];

describe("parseKbEditorConfig", () => {
  it("returns disabled empty config when the entry is absent", () => {
    expect(parseKbEditorConfig([])).toEqual({ enabled: false, knowledgeBases: {}, skipApproval: false });
    expect(parseKbEditorConfig(undefined)).toEqual({ enabled: false, knowledgeBases: {}, skipApproval: false });
    expect(parseKbEditorConfig(null)).toEqual({ enabled: false, knowledgeBases: {}, skipApproval: false });
  });

  it("parses knowledge_bases from a JSON string in `variable`", () => {
    const result = parseKbEditorConfig(
      entry([
        {
          name: "knowledge_bases",
          type: "json",
          variable: JSON.stringify({ products: { create: true, update: true }, faq: { create: true, update: false } }),
        },
      ]) as any,
    );
    expect(result.enabled).toBe(true);
    expect(result.knowledgeBases).toEqual({
      products: { create: true, update: true },
      faq: { create: true, update: false },
    });
  });

  it("prefers hydrated `value` over `variable`", () => {
    const result = parseKbEditorConfig(
      entry([
        {
          name: "knowledge_bases",
          type: "json",
          variable: JSON.stringify({ old: { create: true, update: false } }),
          value: { fresh: { create: true, update: true } },
        },
      ]) as any,
    );
    expect(result.knowledgeBases).toEqual({ fresh: { create: true, update: true } });
  });

  it("accepts agents.tools arriving as a JSON string (legacy)", () => {
    const tools = JSON.stringify(
      entry([{ name: "knowledge_bases", type: "json", variable: JSON.stringify({ a_ctx: { create: true, update: false } }) }]),
    );
    expect(parseKbEditorConfig(tools).knowledgeBases).toEqual({ a_ctx: { create: true, update: false } });
  });

  it("degrades to empty on malformed JSON and never throws", () => {
    expect(parseKbEditorConfig("not json").enabled).toBe(false);
    const result = parseKbEditorConfig(entry([{ name: "knowledge_bases", type: "json", variable: "{broken" }]) as any);
    expect(result).toEqual({ enabled: true, knowledgeBases: {}, skipApproval: false });
  });

  it("drops contexts with malformed profiles and contexts with no permission granted (explicit opt-in)", () => {
    const result = parseKbEditorConfig(
      entry([
        {
          name: "knowledge_bases",
          type: "json",
          variable: JSON.stringify({
            good: { create: true, update: false },
            noperms: { create: false, update: false },
            weird: "yes",
          }),
        },
      ]) as any,
    );
    expect(result.knowledgeBases).toEqual({ good: { create: true, update: false } });
  });

  it("coerces non-boolean create/update flags to false", () => {
    const result = parseKbEditorConfig(
      entry([
        { name: "knowledge_bases", type: "json", variable: JSON.stringify({ ctx_a: { create: "yes", update: true } }) },
      ]) as any,
    );
    expect(result.knowledgeBases).toEqual({ ctx_a: { create: false, update: true } });
  });

  it("parses skip_approval from boolean-ish values", () => {
    expect(parseKbEditorConfig(entry([{ name: "skip_approval", type: "boolean", variable: "true" }]) as any).skipApproval).toBe(true);
    expect(parseKbEditorConfig(entry([{ name: "skip_approval", type: "boolean", variable: true }]) as any).skipApproval).toBe(true);
    expect(parseKbEditorConfig(entry([{ name: "skip_approval", type: "boolean", variable: "false" }]) as any).skipApproval).toBe(false);
    expect(parseKbEditorConfig(entry([]) as any).skipApproval).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/templates/tools/kb-editor-config.test.ts`
Expected: FAIL — `Cannot find module './kb-editor-config'`

- [ ] **Step 3: Write the implementation**

Create `src/templates/tools/kb-editor-config.ts`:

```ts
import { z } from "zod";
import type { ExuluAgentToolConfig } from "@EXULU_TYPES/models/exulu-agent-tool-config";

// The agents.tools entry that holds per-context write permissions. It is a
// config-only entry: never itself exposed to the model, but expanded into
// per-context create/update tools in convertExuluToolsToAiSdkTools.
export const KB_EDITOR_TOOL_ID = "knowledge_base_editor";

export type KbWritePermissions = { create: boolean; update: boolean };

export type KbEditorConfig = {
  /** True when the agent has the knowledge_base_editor tool entry at all. */
  enabled: boolean;
  /** Explicit opt-in: contexts absent here have NO write access. */
  knowledgeBases: Record<string, KbWritePermissions>;
  skipApproval: boolean;
};

const permissionsSchema = z.object({
  create: z.boolean().catch(false).default(false),
  update: z.boolean().catch(false).default(false),
});

const EMPTY: KbEditorConfig = { enabled: false, knowledgeBases: {}, skipApproval: false };

// Never throws. Malformed input degrades to "no writable contexts" — write
// access must never appear by accident (inverse of the retrieval pipeline's
// default-enabled semantics, on purpose).
export const parseKbEditorConfig = (
  tools: ExuluAgentToolConfig[] | string | null | undefined,
): KbEditorConfig => {
  let entries: unknown = tools;
  if (typeof entries === "string") {
    try {
      entries = JSON.parse(entries);
    } catch {
      return { ...EMPTY };
    }
  }
  if (!Array.isArray(entries)) {
    return { ...EMPTY };
  }

  const entry = (entries as ExuluAgentToolConfig[]).find((t) => t?.id === KB_EDITOR_TOOL_ID);
  if (!entry) {
    return { ...EMPTY };
  }

  const rawValue = (name: string): unknown => {
    const row = Array.isArray(entry.config)
      ? entry.config.find((c) => c?.name === name)
      : undefined;
    return row?.value ?? row?.variable ?? row?.default;
  };

  let kbsRaw: unknown = rawValue("knowledge_bases");
  if (typeof kbsRaw === "string" && kbsRaw) {
    try {
      kbsRaw = JSON.parse(kbsRaw);
    } catch {
      kbsRaw = {};
    }
  }

  const knowledgeBases: Record<string, KbWritePermissions> = {};
  if (kbsRaw && typeof kbsRaw === "object" && !Array.isArray(kbsRaw)) {
    for (const [contextId, value] of Object.entries(kbsRaw as Record<string, unknown>)) {
      const parsed = permissionsSchema.safeParse(value);
      if (parsed.success && (parsed.data.create || parsed.data.update)) {
        knowledgeBases[contextId] = parsed.data;
      }
    }
  }

  const skipRaw = rawValue("skip_approval");
  const skipApproval = skipRaw === true || skipRaw === "true" || skipRaw === 1;

  return { enabled: true, knowledgeBases, skipApproval };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/templates/tools/kb-editor-config.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/templates/tools/kb-editor-config.ts src/templates/tools/kb-editor-config.test.ts
git commit -m "feat(tools): add kb-editor config parser for agent knowledge-base writes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Row-level write gate (`check-item-write-access.ts`)

**Files:**
- Create: `src/utils/check-item-write-access.ts`
- Test: `src/utils/check-item-write-access.test.ts`
- Reference (do not modify): `src/graphql/mutations/index.ts:217-330` (`validateWriteAccess` — the semantics being replicated)

**Interfaces:**
- Consumes: `postgresClient` from `@SRC/postgres/client`; `getTableName` from `@SRC/exulu/table-names`; `User` from `@EXULU_TYPES/models/user`.
- Produces (used by Task 3): `checkItemWriteAccess(context: { id: string }, record: any, user?: User): Promise<boolean>`

**Why not `checkRecordAccess`:** it reads grants from an in-memory `record.RBAC` object which context item rows never carry (their grants live in the shared `rbac` table), so it would always deny `users`/`roles`/`teams` items. This helper replicates `validateWriteAccess` (the GraphQL write path) instead: rbac-table lookups with `entity = getTableName(context.id)`.

- [ ] **Step 1: Write the failing test**

Create `src/utils/check-item-write-access.test.ts`:

```ts
import { checkItemWriteAccess } from "./check-item-write-access";
import { postgresClient } from "@SRC/postgres/client";

jest.mock("@SRC/postgres/client", () => ({ postgresClient: jest.fn() }));

const mockRbacRow = (row: unknown) => {
  (postgresClient as jest.Mock).mockResolvedValue({
    db: { from: () => ({ where: () => ({ first: async () => row }) }) },
  });
};

const context = { id: "products" };

describe("checkItemWriteAccess", () => {
  beforeEach(() => {
    (postgresClient as jest.Mock).mockReset();
  });

  it("denies when there is no user", async () => {
    expect(await checkItemWriteAccess(context, { id: "i1", rights_mode: "public" }, undefined)).toBe(false);
  });

  it("allows super admins regardless of rights_mode", async () => {
    expect(
      await checkItemWriteAccess(context, { id: "i1", rights_mode: "users" }, { id: 7, super_admin: true } as any),
    ).toBe(true);
  });

  it("allows admin-scope api users", async () => {
    expect(
      await checkItemWriteAccess(context, { id: "i1", rights_mode: "users" }, { id: 7, type: "api" } as any),
    ).toBe(true);
    expect(
      await checkItemWriteAccess(
        context,
        { id: "i1", rights_mode: "users" },
        { id: 7, type: "api", scope_mode: "admin" } as any,
      ),
    ).toBe(true);
    // Non-admin scoped api keys get no bypass.
    mockRbacRow(undefined);
    expect(
      await checkItemWriteAccess(
        context,
        { id: "i1", rights_mode: "users" },
        { id: 7, type: "api", scope_mode: "agents" } as any,
      ),
    ).toBe(false);
  });

  it("allows anyone on public records", async () => {
    expect(await checkItemWriteAccess(context, { id: "i1", rights_mode: "public" }, { id: 7 } as any)).toBe(true);
  });

  it("private: only the creator, compared as strings", async () => {
    expect(
      await checkItemWriteAccess(context, { id: "i1", rights_mode: "private", created_by: "7" }, { id: 7 } as any),
    ).toBe(true);
    expect(
      await checkItemWriteAccess(context, { id: "i1", rights_mode: "private", created_by: "8" }, { id: 7 } as any),
    ).toBe(false);
    expect(
      await checkItemWriteAccess(context, { id: "i1", rights_mode: "private", created_by: null }, { id: 7 } as any),
    ).toBe(false);
  });

  it("users: allowed only when a write grant row exists in the rbac table", async () => {
    mockRbacRow({ id: "grant1" });
    expect(
      await checkItemWriteAccess(context, { id: "i1", rights_mode: "users" }, { id: 7 } as any),
    ).toBe(true);
    mockRbacRow(undefined);
    expect(
      await checkItemWriteAccess(context, { id: "i1", rights_mode: "users" }, { id: 7 } as any),
    ).toBe(false);
  });

  it("roles: normalizes a role object to its id and requires a grant", async () => {
    mockRbacRow({ id: "grant1" });
    expect(
      await checkItemWriteAccess(
        context,
        { id: "i1", rights_mode: "roles" },
        { id: 7, role: { id: "role-1" } } as any,
      ),
    ).toBe(true);
    // No role on the user → deny without querying.
    expect(await checkItemWriteAccess(context, { id: "i1", rights_mode: "roles" }, { id: 7 } as any)).toBe(false);
  });

  it("teams: same pattern as roles", async () => {
    mockRbacRow(undefined);
    expect(
      await checkItemWriteAccess(
        context,
        { id: "i1", rights_mode: "teams" },
        { id: 7, team: { id: "team-1" } } as any,
      ),
    ).toBe(false);
    mockRbacRow({ id: "grant1" });
    expect(
      await checkItemWriteAccess(
        context,
        { id: "i1", rights_mode: "teams" },
        { id: 7, team: { id: "team-1" } } as any,
      ),
    ).toBe(true);
  });

  it("denies unknown rights_mode values", async () => {
    expect(await checkItemWriteAccess(context, { id: "i1", rights_mode: "bogus" }, { id: 7 } as any)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/utils/check-item-write-access.test.ts`
Expected: FAIL — `Cannot find module './check-item-write-access'`

- [ ] **Step 3: Write the implementation**

Create `src/utils/check-item-write-access.ts`:

```ts
import { postgresClient } from "@SRC/postgres/client";
import { getTableName } from "@SRC/exulu/table-names";
import type { User } from "@EXULU_TYPES/models/user";

/**
 * Row-level WRITE gate for context items, replicating the GraphQL layer's
 * validateWriteAccess (src/graphql/mutations/index.ts) semantics. Context item
 * rows carry rights_mode + created_by; users/roles/teams grants live in the
 * shared `rbac` table keyed by entity = the items table name. checkRecordAccess
 * is NOT usable here — it expects an in-memory record.RBAC object that item
 * rows never have.
 */
export const checkItemWriteAccess = async (
  context: { id: string },
  record: any,
  user?: User,
): Promise<boolean> => {
  if (!user) {
    return false;
  }
  if (user.super_admin === true) {
    return true;
  }
  // Admin-mode API keys keep the legacy broad bypass (matches checkRecordAccess).
  if (user.type === "api" && (!user.scope_mode || user.scope_mode === "admin")) {
    return true;
  }
  if (record.rights_mode === "public") {
    return true;
  }
  if (record.rights_mode === "private") {
    // created_by is a text column while user.id is an integer — compare as strings.
    return record.created_by != null && String(record.created_by) === String(user.id);
  }

  const entity = getTableName(context.id);
  const { db } = await postgresClient();

  if (record.rights_mode === "users") {
    const grant = await db
      .from("rbac")
      .where({
        entity,
        target_resource_id: record.id,
        access_type: "User",
        user_id: user.id,
        rights: "write",
      })
      .first();
    return !!grant;
  }

  if (record.rights_mode === "roles") {
    const roleId = typeof user.role === "string" ? user.role : user.role?.id;
    if (!roleId) {
      return false;
    }
    const grant = await db
      .from("rbac")
      .where({
        entity,
        target_resource_id: record.id,
        access_type: "Role",
        role_id: roleId,
        rights: "write",
      })
      .first();
    return !!grant;
  }

  if (record.rights_mode === "teams") {
    const teamId = typeof user.team === "string" ? user.team : user.team?.id;
    if (!teamId) {
      return false;
    }
    const grant = await db
      .from("rbac")
      .where({
        entity,
        target_resource_id: record.id,
        access_type: "Team",
        team_id: teamId,
        rights: "write",
      })
      .first();
    return !!grant;
  }

  return false;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/utils/check-item-write-access.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/check-item-write-access.ts src/utils/check-item-write-access.test.ts
git commit -m "feat(utils): add row-level write gate for context items

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Per-context write tool factory (`context-write-tools.ts`)

**Files:**
- Create: `src/templates/tools/context-write-tools.ts`
- Test: `src/templates/tools/context-write-tools.test.ts`
- Reference (do not modify): `src/templates/tools/memory-tool.ts` (the pattern), `src/exulu/context.ts:608` (`createItem`), `:738` (`updateItem`), `:896` (`getItem`)

**Interfaces:**
- Consumes: `KB_EDITOR_TOOL_ID`, `parseKbEditorConfig`, `KbWritePermissions` from `./kb-editor-config` (Task 1); `checkItemWriteAccess` from `@SRC/utils/check-item-write-access` (Task 2); `ExuluTool` from `@SRC/exulu/tool`; `sanitizeName` from `@SRC/utils/sanitize-name`.
- Produces (used by Task 4):
  - `createContextWriteTools(context: ExuluContext, perms: KbWritePermissions, skipApproval: boolean): ExuluTool[]`
  - `collectKbWriteTools(agent: ExuluAgent | undefined, contexts: ExuluContext[] | undefined): ExuluTool[]`

**Context runtime facts the implementer must know** (verified against `src/exulu/context.ts`):
- `context.fields: { name, type, required?, editable?, calculated?, enumValues?, ... }[]`; field types: `text|longText|shortText|number|boolean|code|json|enum|markdown|file|date|uuid`.
- `createItem(item, exuluConfig, user?: number, role?: string, upsert?: boolean)` → `{ item: { id }, job? }`. Does NOT set `created_by` — the caller includes it in the item. `rights_mode` is left unset so the column default (context `defaultRightsMode ?? "private"`) applies.
- `updateItem(item, exuluConfig, user?, role?)` REQUIRES `item.id` (does not resolve `external_id`) and returns the PRE-update record — re-fetch for a fresh view.
- `getItem({ item })` accepts `id` or `external_id`, has NO access control.
- Tool execute receives runtime context spread INTO its inputs: `params.user` (full `User`), `params.exuluConfig`.
- Embeddings/processor overrides are left `undefined` — each context's `calculateVectors`/trigger config decides; async work returns a BullMQ `job` id string.

- [ ] **Step 1: Write the failing test**

Create `src/templates/tools/context-write-tools.test.ts`:

```ts
import { createContextWriteTools, collectKbWriteTools } from "./context-write-tools";
import { checkItemWriteAccess } from "@SRC/utils/check-item-write-access";
import { KB_EDITOR_TOOL_ID } from "./kb-editor-config";
import { z } from "zod";

jest.mock("@SRC/utils/check-item-write-access", () => ({
  checkItemWriteAccess: jest.fn(),
}));

const writeGate = checkItemWriteAccess as jest.Mock;

const makeContext = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "products",
    name: "Products",
    description: "Product catalog",
    fields: [
      { name: "price", type: "number", required: true },
      { name: "category", type: "enum", enumValues: ["Hardware", "Software"] },
      { name: "specs", type: "json" },
      { name: "released_at", type: "date" },
      { name: "manual", type: "file" },
      { name: "legacy_ref", type: "uuid" },
      { name: "score", type: "number", calculated: true },
      { name: "audit_note", type: "text", editable: false },
    ],
    createItem: jest.fn(async () => ({ item: { id: "new-1" }, job: undefined })),
    updateItem: jest.fn(async () => ({ item: { id: "item-1" }, job: undefined })),
    getItem: jest.fn(),
    ...overrides,
  }) as any;

const exuluConfig = {} as any;
const user = { id: 7, role: { id: "role-1" } } as any;

const shapeKeys = (tool: any): string[] => Object.keys((tool.inputSchema as z.ZodObject<any>).shape);

describe("createContextWriteTools", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns one tool per granted permission with rule-conform ids", () => {
    const both = createContextWriteTools(makeContext(), { create: true, update: true }, false);
    expect(both.map((t) => t.id)).toEqual(["create_products_item", "update_products_item"]);
    const createOnly = createContextWriteTools(makeContext(), { create: true, update: false }, false);
    expect(createOnly.map((t) => t.id)).toEqual(["create_products_item"]);
    const none = createContextWriteTools(makeContext(), { create: false, update: false }, false);
    expect(none).toEqual([]);
  });

  it("caps the context-id segment of tool ids at 68 chars", () => {
    const longId = "a".repeat(80);
    const [tool] = createContextWriteTools(makeContext({ id: longId }), { create: true, update: false }, false);
    expect(tool.id).toBe(`create_${"a".repeat(68)}_item`);
    expect(tool.id.length).toBeLessThanOrEqual(80);
  });

  it("excludes file, uuid, calculated and non-editable fields from schemas; includes date as string", () => {
    const [createTool, updateTool] = createContextWriteTools(makeContext(), { create: true, update: true }, false);
    for (const keys of [shapeKeys(createTool), shapeKeys(updateTool)]) {
      expect(keys).toEqual(expect.arrayContaining(["price", "category", "specs", "released_at"]));
      expect(keys).not.toEqual(expect.arrayContaining(["manual", "legacy_ref", "score", "audit_note", "fts", "field"]));
    }
    expect(shapeKeys(createTool)).toEqual(expect.arrayContaining(["name", "description", "tags", "external_id"]));
    expect(shapeKeys(updateTool)).toEqual(expect.arrayContaining(["id", "external_id"]));
  });

  it("requires name and required fields on create, everything optional on update", () => {
    const [createTool, updateTool] = createContextWriteTools(makeContext(), { create: true, update: true }, false);
    const createShape = (createTool.inputSchema as z.ZodObject<any>).shape;
    expect(createShape.name.isOptional()).toBe(false);
    expect(createShape.price.isOptional()).toBe(false);
    expect(createShape.category.isOptional()).toBe(true);
    const updateShape = (updateTool.inputSchema as z.ZodObject<any>).shape;
    expect(updateShape.name.isOptional()).toBe(true);
    expect(updateShape.price.isOptional()).toBe(true);
  });

  it("needsApproval follows skipApproval", () => {
    const [approved] = createContextWriteTools(makeContext(), { create: true, update: false }, false);
    expect(approved.needsApproval).toBe(true);
    const [skipped] = createContextWriteTools(makeContext(), { create: true, update: false }, true);
    expect(skipped.needsApproval).toBe(false);
  });

  describe("create execute", () => {
    const run = async (params: Record<string, unknown>, context = makeContext()) => {
      const [tool] = createContextWriteTools(context, { create: true, update: false }, false);
      const result = await (tool.tool.execute as any)({ ...params, user, exuluConfig }, { toolCallId: "t", messages: [] });
      return { result, context };
    };

    it("stamps created_by, copies only content keys, calls createItem without upsert", async () => {
      const { result, context } = await run({
        name: "Widget",
        price: 9.5,
        category: "hardware",
        junk_runtime_key: "ignore-me",
      });
      expect(context.createItem).toHaveBeenCalledWith(
        { name: "Widget", price: 9.5, category: "Hardware", created_by: "7" },
        exuluConfig,
        7,
        "role-1",
        false,
      );
      expect(result.result).toContain("new-1");
    });

    it("rejects out-of-enum values with the allowed list instead of writing", async () => {
      const { result, context } = await run({ name: "Widget", price: 1, category: "Nonsense" });
      expect(context.createItem).not.toHaveBeenCalled();
      expect(result.result).toContain("Hardware, Software");
    });

    it("reports queued jobs", async () => {
      const context = makeContext({ createItem: jest.fn(async () => ({ item: { id: "new-2" }, job: "job-9" })) });
      const { result } = await run({ name: "Widget", price: 1 }, context);
      expect(result.result).toContain("job-9");
    });

    it("returns errors as result strings", async () => {
      const context = makeContext({ createItem: jest.fn(async () => { throw new Error("boom"); }) });
      const { result } = await run({ name: "Widget", price: 1 }, context);
      expect(result.result).toContain("boom");
    });
  });

  describe("update execute", () => {
    const run = async (params: Record<string, unknown>, context = makeContext()) => {
      const [tool] = createContextWriteTools(context, { create: false, update: true }, false);
      const result = await (tool.tool.execute as any)({ ...params, user, exuluConfig }, { toolCallId: "t", messages: [] });
      return { result, context };
    };

    it("requires id or external_id", async () => {
      const { result, context } = await run({ name: "x" });
      expect(context.getItem).not.toHaveBeenCalled();
      expect(result.result).toContain("id or external_id");
    });

    it("uses the same generic message for missing rows and denied access", async () => {
      const missing = makeContext({ getItem: jest.fn(async () => undefined) });
      const { result: r1 } = await run({ id: "nope", name: "x" }, missing);

      writeGate.mockResolvedValue(false);
      const denied = makeContext({
        getItem: jest.fn(async () => ({ id: "item-1", rights_mode: "private", created_by: "8" })),
      });
      const { result: r2, context } = await run({ id: "item-1", name: "x" }, denied);

      expect(r1.result).toBe(r2.result);
      expect(context.updateItem).not.toHaveBeenCalled();
    });

    it("resolves external_id, patches only provided fields, returns the fresh row", async () => {
      writeGate.mockResolvedValue(true);
      const existing = { id: "item-1", rights_mode: "public", name: "Old", price: 1 };
      const fresh = { id: "item-1", name: "Old", price: 25, category: "Hardware" };
      const context = makeContext({
        getItem: jest
          .fn()
          .mockResolvedValueOnce(existing) // lookup by external_id
          .mockResolvedValueOnce(fresh), // re-fetch after update
      });
      const { result } = await run({ external_id: "ext-1", price: 25 }, context);
      expect(context.getItem).toHaveBeenNthCalledWith(1, { item: { id: undefined, external_id: "ext-1" } });
      // external_id is lookup-only: the patch must not write it back.
      expect(context.updateItem).toHaveBeenCalledWith({ id: "item-1", price: 25 }, exuluConfig, 7, "role-1");
      expect(result.result).toContain('"price":25');
    });

    it("refuses an empty patch", async () => {
      writeGate.mockResolvedValue(true);
      const context = makeContext({ getItem: jest.fn(async () => ({ id: "item-1", rights_mode: "public" })) });
      const { result } = await run({ id: "item-1" }, context);
      expect(context.updateItem).not.toHaveBeenCalled();
      expect(result.result).toContain("No fields");
    });
  });
});

describe("collectKbWriteTools", () => {
  const agentWith = (knowledgeBases: Record<string, unknown>, skip = false) =>
    ({
      id: "agent-1",
      tools: [
        {
          id: KB_EDITOR_TOOL_ID,
          type: "function",
          config: [
            { name: "knowledge_bases", type: "json", variable: JSON.stringify(knowledgeBases) },
            { name: "skip_approval", type: "boolean", variable: skip ? "true" : "false" },
          ],
        },
      ],
    }) as any;

  it("expands configured contexts into tools and skips vanished contexts silently", () => {
    const contexts = [makeContext(), makeContext({ id: "faq", name: "FAQ" })];
    const tools = collectKbWriteTools(
      agentWith({
        products: { create: true, update: true },
        faq: { create: true, update: false },
        removed_ctx: { create: true, update: true },
      }),
      contexts,
    );
    expect(tools.map((t) => t.id).sort()).toEqual([
      "create_faq_item",
      "create_products_item",
      "update_products_item",
    ]);
  });

  it("returns nothing without the entry, without contexts, or without an agent", () => {
    expect(collectKbWriteTools({ id: "a", tools: [] } as any, [makeContext()])).toEqual([]);
    expect(collectKbWriteTools(agentWith({ products: { create: true, update: false } }), [])).toEqual([]);
    expect(collectKbWriteTools(undefined, [makeContext()])).toEqual([]);
  });

  it("propagates skip_approval to the generated tools", () => {
    const [tool] = collectKbWriteTools(agentWith({ products: { create: true, update: false } }, true), [makeContext()]);
    expect(tool.needsApproval).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/templates/tools/context-write-tools.test.ts`
Expected: FAIL — `Cannot find module './context-write-tools'`

- [ ] **Step 3: Write the implementation**

Create `src/templates/tools/context-write-tools.ts`:

```ts
import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import type { Item } from "@EXULU_TYPES/models/item";
import type { ExuluContext } from "@SRC/exulu/context";
import { ExuluTool } from "@SRC/exulu/tool";
import { z, type ZodSchema } from "zod";
import { sanitizeName } from "@SRC/utils/sanitize-name";
import { checkItemWriteAccess } from "@SRC/utils/check-item-write-access";
import { parseKbEditorConfig, type KbWritePermissions } from "./kb-editor-config";

// Tool ids must match ^[a-z_][a-z0-9_]{4,79}: "create_" (7) + segment + "_item" (5)
// caps the sanitized context-id segment at 68 chars.
const MAX_CONTEXT_SEGMENT = 68;

type WriteMode = "create" | "update";

// Builds the zod shape for one context + mode and the list of input keys that
// map onto item columns. Update's id/external_id are lookup keys, NOT content:
// external_id must never be written back on update.
const buildWriteSchema = (
  context: ExuluContext,
  mode: WriteMode,
): { shape: Record<string, ZodSchema>; contentKeys: string[] } => {
  const shape: Record<string, ZodSchema> = {};
  const contentKeys: string[] = [];

  const addContent = (key: string, schema: ZodSchema, required: boolean) => {
    shape[key] = required && mode === "create" ? schema : schema.optional();
    contentKeys.push(key);
  };

  if (mode === "update") {
    shape["id"] = z.string().optional().describe("The id of the item to update.");
    shape["external_id"] = z
      .string()
      .optional()
      .describe("The external_id of the item to update, if the id is unknown. Lookup only — it is never changed.");
  }

  addContent("name", z.string().describe("The name of the item."), true);
  addContent("description", z.string().describe("A description of the item."), false);
  addContent("tags", z.array(z.string()).describe("Tags for the item."), false);
  if (mode === "create") {
    addContent(
      "external_id",
      z.string().describe("An optional external identifier for the item, e.g. an id from a source system."),
      false,
    );
  }

  for (const field of context.fields ?? []) {
    if (field.type === "file" || field.type === "uuid") continue;
    if (field.calculated === true || field.editable === false) continue;

    let schema: ZodSchema;
    switch (field.type) {
      case "enum":
        schema = z
          .string()
          .describe(
            `The ${field.name} of the item. Must be one of: ${(field.enumValues ?? []).join(", ")}`,
          );
        break;
      case "json":
        schema = z.string().describe(`The ${field.name} of the item, as a valid JSON string.`);
        break;
      case "markdown":
        schema = z.string().describe(`The ${field.name} of the item, as a valid Markdown string.`);
        break;
      case "date":
        schema = z.string().describe(`The ${field.name} of the item, as an ISO-8601 date string.`);
        break;
      case "number":
        schema = z.number().describe(`The ${field.name} of the item.`);
        break;
      case "boolean":
        schema = z.boolean().describe(`The ${field.name} of the item.`);
        break;
      default:
        // text | longText | shortText | code and any future string-ish type.
        schema = z.string().describe(`The ${field.name} of the item.`);
        break;
    }
    addContent(field.name, schema, field.required === true);
  }

  return { shape, contentKeys };
};

// Case-insensitive canonicalization against enumValues. Returns an error
// message (for the model to self-correct) instead of silently dropping the
// value — a dropped required enum would otherwise vanish from the write.
const canonicalizeEnumFields = (
  context: ExuluContext,
  params: Record<string, unknown>,
): string | undefined => {
  for (const field of context.fields ?? []) {
    if (field.type !== "enum" || !field.enumValues?.length) continue;
    const raw = params[field.name];
    if (raw === undefined || raw === null || raw === "") continue;
    const canonical = field.enumValues.find((v: string) => v.toUpperCase() === String(raw).toUpperCase());
    if (canonical === undefined) {
      return `Invalid value "${String(raw)}" for field "${field.name}". Allowed values: ${field.enumValues.join(", ")}.`;
    }
    params[field.name] = canonical;
  }
  return undefined;
};

const pickContent = (params: Record<string, unknown>, contentKeys: string[]): Item => {
  const item: Item = {};
  for (const key of contentKeys) {
    if (params[key] !== undefined) {
      item[key] = params[key];
    }
  }
  return item;
};

const jobNote = (job: string | undefined): string =>
  job ? ` Processing/embeddings queued (job: ${job}); changes become searchable when the job completes.` : "";

export const createContextWriteTools = (
  context: ExuluContext,
  perms: KbWritePermissions,
  skipApproval: boolean,
): ExuluTool[] => {
  const tools: ExuluTool[] = [];
  const segment = sanitizeName(context.id).slice(0, MAX_CONTEXT_SEGMENT);
  const contextLabel = context.description ? ` ${context.description}` : "";

  if (perms.create) {
    const { shape, contentKeys } = buildWriteSchema(context, "create");
    tools.push(
      new ExuluTool({
        id: `create_${segment}_item`,
        name: `Create ${context.name} item`,
        category: "knowledge_base_editing",
        description: `Create a new item in the "${context.name}" knowledge base.${contextLabel}`,
        type: "function",
        inputSchema: z.object(shape),
        config: [],
        needsApproval: !skipApproval,
        execute: async (params: any) => {
          const { user, exuluConfig } = params;
          try {
            const enumError = canonicalizeEnumFields(context, params);
            if (enumError) {
              return { result: enumError };
            }
            const item = pickContent(params, contentKeys);
            if (user?.id != null) {
              // createItem does not stamp the creator itself; created_by is a
              // text column. rights_mode is left unset so the context's
              // defaultRightsMode column default applies.
              item.created_by = String(user.id);
            }
            const { item: created, job } = await context.createItem(
              item,
              exuluConfig,
              user?.id,
              user?.role?.id,
              false,
            );
            if (!created?.id) {
              return { result: `Failed to create item in "${context.name}".` };
            }
            return {
              result: `Created item ${created.id} in knowledge base "${context.name}".${jobNote(job)}`,
            };
          } catch (error) {
            console.error(`[EXULU] Error creating item in context ${context.id}`, error);
            return {
              result: `Failed to create item in "${context.name}": ${
                error instanceof Error ? error.message : String(error)
              }`,
            };
          }
        },
      }),
    );
  }

  if (perms.update) {
    const { shape, contentKeys } = buildWriteSchema(context, "update");
    // Same message for "row missing" and "no write access" so the tool can't
    // be used to probe for rows the user can't see.
    const NOT_FOUND = `Item not found in "${context.name}" or you don't have write access to it.`;
    tools.push(
      new ExuluTool({
        id: `update_${segment}_item`,
        name: `Update ${context.name} item`,
        category: "knowledge_base_editing",
        description:
          `Update an existing item in the "${context.name}" knowledge base. ` +
          `Provide the item's id (or external_id) plus only the fields to change; omitted fields keep their values.`,
        type: "function",
        inputSchema: z.object(shape),
        config: [],
        needsApproval: !skipApproval,
        execute: async (params: any) => {
          const { user, exuluConfig } = params;
          try {
            if (!params.id && !params.external_id) {
              return { result: "Provide the id or external_id of the item to update." };
            }
            const existing = await context.getItem({
              item: { id: params.id, external_id: params.external_id },
            });
            if (!existing?.id) {
              return { result: NOT_FOUND };
            }
            const allowed = await checkItemWriteAccess(context, existing, user);
            if (!allowed) {
              return { result: NOT_FOUND };
            }
            const enumError = canonicalizeEnumFields(context, params);
            if (enumError) {
              return { result: enumError };
            }
            const patch = pickContent(params, contentKeys);
            if (Object.keys(patch).length === 0) {
              return { result: "No fields to update were provided." };
            }
            patch.id = existing.id;
            const { job } = await context.updateItem(patch, exuluConfig, user?.id, user?.role?.id);
            // updateItem returns the PRE-update record — re-fetch for a fresh view.
            const fresh = await context.getItem({ item: { id: existing.id } });
            const summary: Record<string, unknown> = { id: existing.id };
            for (const key of contentKeys) {
              if (fresh?.[key] !== undefined && fresh?.[key] !== null) {
                summary[key] = fresh[key];
              }
            }
            return {
              result:
                `Updated item ${existing.id} in knowledge base "${context.name}".${jobNote(job)}` +
                `\nCurrent item: ${JSON.stringify(summary)}`,
            };
          } catch (error) {
            console.error(`[EXULU] Error updating item in context ${context.id}`, error);
            return {
              result: `Failed to update item in "${context.name}": ${
                error instanceof Error ? error.message : String(error)
              }`,
            };
          }
        },
      }),
    );
  }

  return tools;
};

// Expands an agent's knowledge_base_editor entry into concrete per-context
// write tools. Contexts that no longer exist in code are skipped silently —
// they can disappear between deploys.
export const collectKbWriteTools = (
  agent: ExuluAgent | undefined,
  contexts: ExuluContext[] | undefined,
): ExuluTool[] => {
  if (!agent?.tools || !contexts?.length) {
    return [];
  }
  const config = parseKbEditorConfig(agent.tools as any);
  if (!config.enabled) {
    return [];
  }
  const tools: ExuluTool[] = [];
  for (const [contextId, perms] of Object.entries(config.knowledgeBases)) {
    const context = contexts.find((c) => c.id === contextId);
    if (!context) {
      continue;
    }
    tools.push(...createContextWriteTools(context, perms, config.skipApproval));
  }
  return tools;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/templates/tools/context-write-tools.test.ts`
Expected: PASS. If the create-execute test fails on the enum test with `category` rejected by zod: the schema is `z.string()` (permissive) so validation passes — the enum check happens in execute; re-check `canonicalizeEnumFields` is called before `pickContent`.

- [ ] **Step 5: Run the full backend suite**

Run: `npm test`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/templates/tools/context-write-tools.ts src/templates/tools/context-write-tools.test.ts
git commit -m "feat(tools): per-context knowledge-base create/update tool factory

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Backend wiring (converter injection + enabled-tools skip)

**Files:**
- Modify: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts` (inject after the memory-tool block, which ends around line 268)
- Modify: `src/utils/enabled-tools.ts` (skip the config-only entry)
- Test: extend `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts`

**Interfaces:**
- Consumes: `collectKbWriteTools(agent, contexts)` from `./context-write-tools` (Task 3); `KB_EDITOR_TOOL_ID` from `./kb-editor-config` (Task 1).
- Produces: generated write tools appear in the AI-SDK tool map under their sanitized names; the `knowledge_base_editor` agent.tools entry never reaches the model as a tool.

- [ ] **Step 1: Write the failing test**

Add to `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts` (append a new `describe` block at the end of the file; reuse the file's existing mocks — do NOT redefine them):

```ts
describe("knowledge base write tool injection", () => {
  const kbContext = {
    id: "products",
    name: "Products",
    description: "Product catalog",
    fields: [{ name: "price", type: "number", required: true }],
    createItem: jest.fn(async () => ({ item: { id: "new-1" } })),
    updateItem: jest.fn(async () => ({ item: { id: "i1" } })),
    getItem: jest.fn(),
  } as never;

  const kbAgent = {
    id: "agent-1",
    name: "Agent",
    tools: [
      {
        id: "knowledge_base_editor",
        type: "function",
        config: [
          {
            name: "knowledge_bases",
            type: "json",
            variable: JSON.stringify({ products: { create: true, update: true } }),
          },
          { name: "skip_approval", type: "boolean", variable: "false" },
        ],
      },
    ],
  } as never;

  it("injects create/update tools for configured contexts", async () => {
    const tools = await convertExuluToolsToAiSdkTools(
      [],
      [],
      [],
      [],
      (kbAgent as any).tools,
      undefined,
      [kbContext],
      { id: 7 } as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      kbAgent,
    );
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(["Create_Products_item", "Update_Products_item"]),
    );
  });

  it("injects nothing when the agent has no knowledge_base_editor entry", async () => {
    const tools = await convertExuluToolsToAiSdkTools(
      [],
      [],
      [],
      [],
      [],
      undefined,
      [kbContext],
      { id: 7 } as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { id: "agent-1", name: "Agent", tools: [] } as never,
    );
    expect(Object.keys(tools)).not.toEqual(expect.arrayContaining(["Create_Products_item"]));
  });

  it("respects per-message disabledTools for generated write tools", async () => {
    const tools = await convertExuluToolsToAiSdkTools(
      [],
      [],
      [],
      [],
      (kbAgent as any).tools,
      undefined,
      [kbContext],
      { id: 7 } as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      kbAgent,
      undefined,
      undefined,
      ["create_products_item"],
    );
    expect(Object.keys(tools)).not.toEqual(expect.arrayContaining(["Create_Products_item"]));
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(["Update_Products_item"]));
  });
});
```

Note on expected map keys: the converter maps each tool through `sanitizeToolName(tool.name)`; tool names are `Create Products item` → `Create_Products_item`. If the existing test file asserts keys differently (check its existing assertions first), match that style. The `disabledTools` param is the 18th positional argument — count the signature in the file, don't guess.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts`
Expected: the three new tests FAIL (tools not injected); pre-existing tests PASS.

- [ ] **Step 3: Add the injection to the converter**

In `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`:

Add the import next to the memory-tool import (line ~23):

```ts
import { collectKbWriteTools } from "./context-write-tools";
```

Insert AFTER the memory-tool block (the `if (agent?.memory && contexts?.length) { ... }` block ending ~line 268) and BEFORE the `if (sessionItems)` block:

```ts
  // Per-context knowledge-base write tools (create_<ctx>_item / update_<ctx>_item),
  // expanded from the agent's knowledge_base_editor config entry. Explicit
  // opt-in per context; vanished contexts are skipped inside the collector.
  for (const kbWriteTool of collectKbWriteTools(agent, contexts)) {
    if (!disabled.has(kbWriteTool.id)) {
      currentTools.push(kbWriteTool);
    }
  }
```

(Verify the surrounding code's variable for the disabled-tools set — it is `disabled` — and match the file's 2-space indent.)

- [ ] **Step 4: Add the skip to getEnabledTools**

In `src/utils/enabled-tools.ts`, add the import:

```ts
import { KB_EDITOR_TOOL_ID } from "@SRC/templates/tools/kb-editor-config";
```

Insert inside the `agent.tools.map` callback, directly after the `if (id === "agentic_context_search") { ... }` block (line ~33):

```ts
        if (id === KB_EDITOR_TOOL_ID) {
          // Config-only entry: it is expanded into per-context write tools in
          // convertExuluToolsToAiSdkTools (which has the agent/context closures).
          // Without this skip it would fall through to the registry lookup below.
          return null;
        }
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts`
Expected: PASS (existing + 3 new)

Run: `npm test`
Expected: PASS (full suite, no regressions)

- [ ] **Step 6: Build the backend**

Run: `npm run build`
Expected: tsup completes without type errors.

- [ ] **Step 7: Commit**

```bash
git add src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts src/utils/enabled-tools.ts
git commit -m "feat(tools): inject per-context KB write tools from agent config

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Frontend config parse/serialize layer

**Files:**
- Create: `frontend/app/(application)/agents/edit/[id]/components/kb-editing/config-schema.ts`
- Reference (do not modify): `frontend/app/(application)/agents/edit/[id]/components/knowledge-search/config-schema.ts` (the never-throw pattern), `frontend/app/(application)/agents/edit/[id]/components/tool-config-fields.tsx:21` (`ToolConfigEntry`), `frontend/types/models/agent.ts:6` (`AgentTool`)

**Interfaces:**
- Consumes: `ToolConfigEntry = { name: string; variable: string | boolean | number; type: "string" | "number" | "boolean" | "variable" | "json" }`; `AgentTool = { id, type, config: {name, variable, type}[], name, description? }`.
- Produces (used by Task 6):
  - `KB_EDITOR_TOOL_ID = "knowledge_base_editor"`
  - `type KbWritePermission = { create: boolean; update: boolean }`
  - `type KbEditingConfig = { knowledgeBases: Record<string, KbWritePermission>; skipApproval: boolean }`
  - `parseKbEditingConfig(entries: ToolConfigEntry[] | undefined): KbEditingConfig`
  - `serializeKbEditingConfig(config: KbEditingConfig): ToolConfigEntry[]` (exactly 2 entries)
  - `makeKbEditorTool(config: KbEditingConfig): AgentTool`

The frontend repo has no unit-test runner — correctness is checked by the typecheck in this task and the manual round-trip in Task 7.

- [ ] **Step 1: Write the implementation**

Create `frontend/app/(application)/agents/edit/[id]/components/kb-editing/config-schema.ts`:

```ts
/**
 * config-schema.ts — parse / serialize layer for the "Knowledge base editing"
 * block: the knowledge_base_editor entry in agent.tools (2-entry contract:
 * knowledge_bases json + skip_approval boolean). Mirrors the backend parser in
 * backend/src/templates/tools/kb-editor-config.ts. Never throws — malformed
 * config degrades to "no writable knowledge bases".
 */

import { z } from "zod";

import type { AgentTool } from "@/types/models/agent";

import type { ToolConfigEntry } from "../tool-config-fields";

export const KB_EDITOR_TOOL_ID = "knowledge_base_editor";

export type KbWritePermission = { create: boolean; update: boolean };

export type KbEditingConfig = {
  knowledgeBases: Record<string, KbWritePermission>;
  skipApproval: boolean;
};

const permissionSchema = z.object({
  create: z.boolean().catch(false).default(false),
  update: z.boolean().catch(false).default(false),
});

export const parseKbEditingConfig = (
  entries: ToolConfigEntry[] | undefined,
): KbEditingConfig => {
  const result: KbEditingConfig = { knowledgeBases: {}, skipApproval: false };
  if (!Array.isArray(entries)) return result;

  const byName = new Map(entries.map((e) => [e?.name, e] as const));

  let kbsRaw: unknown = byName.get("knowledge_bases")?.variable;
  if (typeof kbsRaw === "string" && kbsRaw) {
    try {
      kbsRaw = JSON.parse(kbsRaw);
    } catch {
      kbsRaw = {};
    }
  }
  if (kbsRaw && typeof kbsRaw === "object" && !Array.isArray(kbsRaw)) {
    for (const [id, value] of Object.entries(kbsRaw as Record<string, unknown>)) {
      const parsed = permissionSchema.safeParse(value);
      if (parsed.success && (parsed.data.create || parsed.data.update)) {
        result.knowledgeBases[id] = parsed.data;
      }
    }
  }

  const skipRaw = byName.get("skip_approval")?.variable;
  result.skipApproval = skipRaw === true || skipRaw === "true";

  return result;
};

export const serializeKbEditingConfig = (config: KbEditingConfig): ToolConfigEntry[] => [
  { name: "knowledge_bases", variable: JSON.stringify(config.knowledgeBases), type: "json" },
  { name: "skip_approval", variable: config.skipApproval ? "true" : "false", type: "boolean" },
];

export const makeKbEditorTool = (config: KbEditingConfig): AgentTool => ({
  id: KB_EDITOR_TOOL_ID,
  type: "function",
  name: "Knowledge base editor",
  config: serializeKbEditingConfig(config) as AgentTool["config"],
});
```

- [ ] **Step 2: Typecheck the frontend**

Run (from the frontend repo root): `npx tsc --noEmit`
Expected: no NEW errors (run it on a clean checkout first if unsure of the baseline).

- [ ] **Step 3: Commit (frontend repo)**

```bash
git add "app/(application)/agents/edit/[id]/components/kb-editing/config-schema.ts"
git commit -m "feat(agents): kb-editing config parse/serialize layer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Frontend UI — Knowledge-section block + i18n

**Files:**
- Create: `frontend/app/(application)/agents/edit/[id]/components/kb-editing/kb-editing-card.tsx`
- Modify: `frontend/app/(application)/agents/edit/[id]/sections/knowledge.tsx` (render the new card)
- Modify: `frontend/messages/en.json`, `frontend/messages/de.json` (new keys under `agents.editor.knowledge.editing`)
- Reference (do not modify): `sections/knowledge.tsx` current content (agentic block = the card pattern), `components/knowledge-search/steps/knowledge-bases-step.tsx` (checkbox-card pattern), `sections/types.ts` (`EditorSectionProps` provides `editor` + `refs`)

**Interfaces:**
- Consumes: Task 5's exports; `editor.tools: AgentTool[]`, `editor.setTools(tools: AgentTool[])`, `refs.contexts: { id: string; name: string; description?: string }[]` (all already on `EditorSectionProps`).
- Produces: `KbEditingCard({ editor, refs }: EditorSectionProps)` component. Enabling stages a `knowledge_base_editor` entry in `editor.tools` (the existing staged-state save path persists it — no queries.ts/hooks.ts changes needed).

Checking a context defaults it to `{ create: true, update: false }` — updating (overwrite) is opted into separately. Unchecking a context, or unchecking both boxes, removes its key entirely (explicit opt-in).

- [ ] **Step 1: Write the component**

Create `frontend/app/(application)/agents/edit/[id]/components/kb-editing/kb-editing-card.tsx`:

```tsx
"use client";

/**
 * Knowledge base editing — per-agent write access to knowledge bases. Stages a
 * knowledge_base_editor entry in editor.tools; per-context create/update
 * checkboxes are explicit opt-in (unchecking both removes the context).
 */

import { useTranslations } from "next-intl";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";

import type { ToolConfigEntry } from "../tool-config-fields";
import {
  KB_EDITOR_TOOL_ID,
  makeKbEditorTool,
  parseKbEditingConfig,
  serializeKbEditingConfig,
  type KbEditingConfig,
} from "./config-schema";
import type { EditorSectionProps } from "../../sections/types";

export function KbEditingCard({ editor, refs }: EditorSectionProps) {
  const t = useTranslations("agents");

  const entry = editor.tools.find((tool) => tool.id === KB_EDITOR_TOOL_ID);
  const enabled = !!entry;
  const config = parseKbEditingConfig(entry?.config as ToolConfigEntry[] | undefined);

  const applyConfig = (next: KbEditingConfig) => {
    editor.setTools(
      editor.tools.map((tool) =>
        tool.id === KB_EDITOR_TOOL_ID
          ? { ...tool, config: serializeKbEditingConfig(next) as never }
          : tool,
      ),
    );
  };

  const toggleEnabled = (on: boolean) => {
    if (on) {
      editor.setTools([
        ...editor.tools,
        makeKbEditorTool({ knowledgeBases: {}, skipApproval: false }),
      ]);
    } else {
      editor.setTools(editor.tools.filter((tool) => tool.id !== KB_EDITOR_TOOL_ID));
    }
  };

  const setContextEnabled = (id: string, on: boolean) => {
    const next: KbEditingConfig = {
      ...config,
      knowledgeBases: { ...config.knowledgeBases },
    };
    if (on) {
      next.knowledgeBases[id] = { create: true, update: false };
    } else {
      delete next.knowledgeBases[id];
    }
    applyConfig(next);
  };

  const setPermission = (id: string, key: "create" | "update", on: boolean) => {
    const current = config.knowledgeBases[id] ?? { create: false, update: false };
    const nextPerm = { ...current, [key]: on };
    const next: KbEditingConfig = {
      ...config,
      knowledgeBases: { ...config.knowledgeBases },
    };
    if (!nextPerm.create && !nextPerm.update) {
      delete next.knowledgeBases[id];
    } else {
      next.knowledgeBases[id] = nextPerm;
    }
    applyConfig(next);
  };

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">
            {t("editor.knowledge.editing.title")}{" "}
            <Badge variant="outline" className="ml-1 font-normal">
              {enabled ? t("editor.knowledge.enabled") : t("editor.knowledge.disabled")}
            </Badge>
          </p>
          <p className="text-sm text-muted-foreground">
            {t("editor.knowledge.editing.description")}
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={toggleEnabled}
          aria-label={t("editor.knowledge.editing.title")}
        />
      </div>

      {enabled && (
        <div className="space-y-3 border-t pt-3">
          {refs.contexts.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t("editor.knowledge.noContexts")}
            </p>
          )}
          {refs.contexts.map((ctx) => {
            const perms = config.knowledgeBases[ctx.id];
            const isOn = !!perms;
            return (
              <div key={ctx.id} className="space-y-3 rounded-md border p-3">
                <label className="flex items-start gap-3">
                  <Checkbox
                    checked={isOn}
                    onCheckedChange={(v) => setContextEnabled(ctx.id, v === true)}
                    className="mt-0.5"
                  />
                  <span className="space-y-0.5">
                    <span className="block text-sm font-medium">{ctx.name}</span>
                    {ctx.description && (
                      <span className="block text-xs text-muted-foreground">
                        {ctx.description}
                      </span>
                    )}
                  </span>
                </label>
                {isOn && (
                  <div className="flex gap-6 border-t pt-3">
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={perms.create}
                        onCheckedChange={(v) => setPermission(ctx.id, "create", v === true)}
                      />
                      {t("editor.knowledge.editing.createLabel")}
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={perms.update}
                        onCheckedChange={(v) => setPermission(ctx.id, "update", v === true)}
                      />
                      {t("editor.knowledge.editing.updateLabel")}
                    </label>
                  </div>
                )}
              </div>
            );
          })}

          <div className="flex items-start justify-between gap-3 border-t pt-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                {t("editor.knowledge.editing.skipApprovalTitle")}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("editor.knowledge.editing.skipApprovalDescription")}
              </p>
            </div>
            <Switch
              checked={config.skipApproval}
              onCheckedChange={(v) => applyConfig({ ...config, skipApproval: v })}
              aria-label={t("editor.knowledge.editing.skipApprovalTitle")}
            />
          </div>
        </div>
      )}
    </div>
  );
}
```

(If `sections/types.ts` exports `EditorSectionProps` from a different relative depth than shown, fix the import path — the component lives two levels below the section dir.)

- [ ] **Step 2: Render it in the Knowledge section**

In `frontend/app/(application)/agents/edit/[id]/sections/knowledge.tsx`:

Add the import (with the other component imports around line 33):

```tsx
import { KbEditingCard } from "../components/kb-editing/kb-editing-card";
```

Insert AFTER the memory-context `</div>` block (ends ~line 225, before `<KnowledgeSearchWizard`):

```tsx
      {/* Knowledge base editing — per-agent write access */}
      <KbEditingCard editor={editor} refs={refs} />
```

- [ ] **Step 3: Add i18n keys**

In `frontend/messages/en.json`, inside `agents.editor.knowledge` (alongside `"memoryTitle"` etc.), add:

```json
"editing": {
  "title": "Knowledge base editing",
  "description": "Let this agent create or update items in selected knowledge bases during chat.",
  "createLabel": "Create items",
  "updateLabel": "Update items",
  "skipApprovalTitle": "Skip chat approval",
  "skipApprovalDescription": "Writes run without an approval prompt in the chat. Only enable for trusted automation agents."
}
```

In `frontend/messages/de.json`, same location:

```json
"editing": {
  "title": "Wissensdatenbank-Bearbeitung",
  "description": "Erlaubt diesem Agenten, während des Chats Einträge in ausgewählten Wissensdatenbanken zu erstellen oder zu aktualisieren.",
  "createLabel": "Einträge erstellen",
  "updateLabel": "Einträge aktualisieren",
  "skipApprovalTitle": "Chat-Freigabe überspringen",
  "skipApprovalDescription": "Schreibvorgänge laufen ohne Freigabe-Abfrage im Chat. Nur für vertrauenswürdige Automatisierungs-Agenten aktivieren."
}
```

(Match the surrounding JSON structure exactly — check how `wizard` nests under `knowledge` in each file first.)

- [ ] **Step 4: Typecheck + lint**

Run (frontend root): `npx tsc --noEmit && npm run lint`
Expected: no new errors.

- [ ] **Step 5: Commit (frontend repo)**

```bash
git add "app/(application)/agents/edit/[id]/components/kb-editing/kb-editing-card.tsx" "app/(application)/agents/edit/[id]/sections/knowledge.tsx" messages/en.json messages/de.json
git commit -m "feat(agents): knowledge base editing config in agent editor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end verification

**Files:** none created — this task drives the running system. Use the `verify` skill's spirit: observe real behavior, not just green tests.

- [ ] **Step 1: Full backend test suite + build**

Run (backend root): `npm test && npm run build`
Expected: all tests pass, tsup build clean.

- [ ] **Step 2: Boot backend + frontend against a dev database**

The backend is a package consumed by a host app: rebuild `dist` (`npm run build`, or `npm run dev` for watch mode) and restart the host server that links `@exulu/backend`. Start the frontend with `npm run dev` (port 3000). Confirm boot logs show no errors from the new modules.

- [ ] **Step 3: Editor round-trip**

1. Open an agent at `/agents/edit/<id>` → Knowledge section shows the "Knowledge base editing" block, disabled.
2. Enable it, check a context, leave `Create items` on, save.
3. Reload the editor: the block re-hydrates with the same selection (parse/serialize round-trip through GraphQL works).
4. In the DB (or via GraphQL), confirm `agents.tools` now contains the `knowledge_base_editor` entry with the JSON `knowledge_bases` value.

- [ ] **Step 4: Chat write round-trip**

1. Chat with the agent: ask it to create an item in the enabled knowledge base ("Create an item called X with ...").
2. Expect the approval prompt (approval defaults on); approve it.
3. Confirm the tool result reports the new item id; verify the row exists in `<ctx>_items` with `created_by` = your user id (as string) and the context's default `rights_mode`.
4. Ask the agent to update that item (update permission must be checked for this) — verify only the provided field changed and the tool reports the fresh values.
5. Negative checks: ask it to write to a context NOT enabled in its config (the tool must not exist / the model must decline); as a non-creator user, update a `private` item (expect the generic not-found/no-access message).
6. Toggle "Skip chat approval" on, save, and confirm a write runs without the approval prompt.

- [ ] **Step 5: Record results**

Note any deviations found during verification and fix them before closing out the feature branch. If all checks pass, the feature is complete.

---

## Self-review notes (already applied)

- Spec coverage: config storage (T1), dual gate (T2 + T3 update flow), tool factory + schema rules incl. `calculated`/`editable`/file/uuid exclusions (T3), injection + enabled-tools skip + disabledTools (T4), frontend parse/serialize (T5), Knowledge-section UI + create-default + skip-approval + i18n (T6), out-of-scope items untouched. Testing section of the spec maps to T1-T4 unit tests + T7 manual.
- Type consistency: `KbWritePermissions` (backend, Task 1/3) vs `KbWritePermission` (frontend, Task 5/6) are intentionally separate types in separate repos; each repo is internally consistent.
- The converter test's positional-arg count and existing mock style MUST be re-checked against the live file before writing Task 4's test — the file has 18 positional params and pre-existing mocks that must be reused, not redefined.
