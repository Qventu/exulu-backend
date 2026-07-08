# Project Retrieval via the Agentic Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy per-project retrieval tool with the agentic retrieval pipeline: auto-injected with defaults when an agent has no agentic retrieval, merged as an additional source when it does.

**Architecture:** A new `projectScope` option on `createAgenticRetrievalTool` carries project identity + items; a new pure module `project-scope.ts` resolves items into rerank pins (contexts the agent already searches) and item-scoped extra sources (contexts it doesn't). `convertExuluToolsToAiSdkTools` loads the project row once and either passes `projectScope` into the configured instance or pushes a project-scoped instance built on zod defaults. The legacy tool and all three of its injection sites are removed.

**Tech Stack:** TypeScript, Zod, Jest (backend, colocated `*.test.ts`), Vitest (frontend), Vercel AI SDK, Knex/Postgres.

**Spec:** `docs/superpowers/specs/2026-07-07-project-agentic-retrieval-design.md` — read it before starting.

## Global Constraints

- Backend repo: `/Users/daniel.claessen/Desktop/Projects/exulu/backend` (branch off `develop`). Frontend repo: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend` (branch off `main` — there is NO develop branch in frontend).
- Path aliases in backend: `@SRC/*` → `src/*`, `@EE/*` → `ee/*`, `@EXULU_TYPES/*` → types. Jest resolves them; follow existing import style in each file.
- EE license gate: `createAgenticRetrievalTool` returns `undefined` without the `agentic-retrieval` entitlement (`ee/agentic-retrieval/pipeline/index.ts:118-122`). **Do not add any non-EE fallback — project retrieval becomes EE-only (user decision).**
- Pipeline error rule: a degraded pipeline still retrieves. New code paths log + skip, never throw.
- Tool-config wire conventions: booleans are the strings `"true"`/`"false"` (parse also accepts real `true`/`1`); absent or `""` means "backend default". JSON values round-trip as objects OR strings.
- The frontend serializer contract is exactly N entries asserted in `config-schema.test.ts` — this plan moves it from 12 to **13**; backend and frontend must both land.
- No DB migration, no saved-config migration (the new option defaults on).
- Backend tests: `npx jest <path>` from the backend root. Frontend tests: `npx vitest run <path>` from the frontend root (quote paths — they contain `(` and `[`).
- Commit style: conventional commits (`feat:`, `fix:`, `test:`, `refactor:`), end body with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `project_search` pipeline config option

**Files:**
- Modify: `ee/agentic-retrieval/pipeline/config.ts` (PipelineConfig type ~line 66-78, parsePipelineConfig ~line 127-142)
- Test: `ee/agentic-retrieval/pipeline/config.test.ts`

**Interfaces:**
- Consumes: existing `boolVal` helper in config.ts (`config.ts:80`).
- Produces: `PipelineConfig.projectSearch: boolean` (default `true`), parsed from raw key `"project_search"`. Task 4 reads `cfg.projectSearch`.

- [ ] **Step 1: Write the failing tests** — append to `ee/agentic-retrieval/pipeline/config.test.ts`:

```ts
describe("project_search option", () => {
  it("defaults to true when absent or empty (empty string = backend default)", () => {
    expect(parsePipelineConfig({}).projectSearch).toBe(true);
    expect(parsePipelineConfig(undefined).projectSearch).toBe(true);
    expect(parsePipelineConfig({ project_search: "" }).projectSearch).toBe(true);
  });

  it("parses explicit values", () => {
    expect(parsePipelineConfig({ project_search: "false" }).projectSearch).toBe(false);
    expect(parsePipelineConfig({ project_search: false }).projectSearch).toBe(false);
    expect(parsePipelineConfig({ project_search: "true" }).projectSearch).toBe(true);
    expect(parsePipelineConfig({ project_search: true }).projectSearch).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest ee/agentic-retrieval/pipeline/config.test.ts`
Expected: FAIL — `projectSearch` does not exist on `PipelineConfig`.

- [ ] **Step 3: Implement** — in `ee/agentic-retrieval/pipeline/config.ts`:

Add to the `PipelineConfig` type (after `logging: boolean;`):

```ts
  /** Search items attached to the chat's project as an additional source. Default true. */
  projectSearch: boolean;
```

Add to the object returned by `parsePipelineConfig` (after the `logging:` line). Note the explicit default handling — `boolVal` alone would default absent/empty to `false`, but this option defaults **on**:

```ts
    projectSearch:
      r["project_search"] === undefined || r["project_search"] === ""
        ? true
        : boolVal(r["project_search"]),
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest ee/agentic-retrieval/pipeline/config.test.ts`
Expected: PASS (all suites in the file).

- [ ] **Step 5: Commit**

```bash
git add ee/agentic-retrieval/pipeline/config.ts ee/agentic-retrieval/pipeline/config.test.ts
git commit -m "feat(retrieval): project_search pipeline config option (default on)"
```

---

### Task 2: `project-scope.ts` — gid parsing move + scope resolution

**Files:**
- Create: `ee/agentic-retrieval/pipeline/global-ids.ts`
- Create: `ee/agentic-retrieval/pipeline/project-scope.ts`
- Modify: `ee/agentic-retrieval/pipeline/index.ts` (remove the inline `parsePreselectedItems` definition at lines 24-53, re-export from global-ids)
- Test: `ee/agentic-retrieval/pipeline/project-scope.test.ts`

**Interfaces:**
- Consumes: `KbProfile` type from `./config`; `parsePreselectedItems` (moved verbatim into `./global-ids`).
- Produces (used by Tasks 4 and 5):

```ts
export type ProjectScope = {
  id: string;
  name: string;
  description?: string;
  customInstructions?: string;
  items: string[];                                  // raw project_items gids, both shapes
  kbProfileDefaults?: Record<string, KbProfile>;
};
export type ResolvedProjectScope = {
  pinsByContext: Map<string, Set<string>>;          // enabled contexts → rerank boost only
  scopedItemsByContext: Map<string, string[] | null>; // added contexts → hard item filter (null = whole context)
  addedContextIds: string[];
  allProjectContextIds: string[];
};
export function resolveProjectScope(opts: {
  scope: ProjectScope | undefined;
  enabledContextIds: Set<string>;
  availableContextIds: Set<string>;
}): ResolvedProjectScope | undefined;
export function buildProjectKbProfileDefaults(items: string[]): Record<string, KbProfile>;
```

- [ ] **Step 1: Move `parsePreselectedItems`** — create `ee/agentic-retrieval/pipeline/global-ids.ts` containing the function moved **verbatim** from `index.ts:24-53` (including its doc comment). In `index.ts`, delete the definition and add at the top:

```ts
import { parsePreselectedItems } from "./global-ids";
export { parsePreselectedItems } from "./global-ids";
```

(The re-export preserves the existing public import path `@EE/agentic-retrieval/pipeline/index`.)

- [ ] **Step 2: Verify nothing broke**

Run: `npx jest ee/agentic-retrieval/pipeline`
Expected: PASS — pure move, no behavior change.

- [ ] **Step 3: Write the failing tests** — create `ee/agentic-retrieval/pipeline/project-scope.test.ts`:

```ts
import { resolveProjectScope, buildProjectKbProfileDefaults } from "./project-scope";

const baseScope = {
  id: "p1",
  name: "Elevator Modernization",
  items: ["docs/item-1", "docs/item-2", "tickets/item-9", "wiki"],
};

describe("resolveProjectScope", () => {
  it("returns undefined for no scope or empty items", () => {
    expect(resolveProjectScope({ scope: undefined, enabledContextIds: new Set(), availableContextIds: new Set() })).toBeUndefined();
    expect(resolveProjectScope({ scope: { ...baseScope, items: [] }, enabledContextIds: new Set(), availableContextIds: new Set(["docs"]) })).toBeUndefined();
  });

  it("enabled contexts get PINS (boost), never filters", () => {
    const r = resolveProjectScope({
      scope: baseScope,
      enabledContextIds: new Set(["docs", "tickets", "wiki"]),
      availableContextIds: new Set(["docs", "tickets", "wiki"]),
    })!;
    expect(r.pinsByContext.get("docs")).toEqual(new Set(["item-1", "item-2"]));
    expect(r.pinsByContext.get("tickets")).toEqual(new Set(["item-9"]));
    expect(r.scopedItemsByContext.size).toBe(0);
    expect(r.addedContextIds).toEqual([]);
    // bare-context "wiki" is already enabled in full → no pin entry either
    expect(r.pinsByContext.has("wiki")).toBe(false);
    expect(new Set(r.allProjectContextIds)).toEqual(new Set(["docs", "tickets", "wiki"]));
  });

  it("non-enabled contexts get added item-scoped; bare-context entry scopes to whole context (null)", () => {
    const r = resolveProjectScope({
      scope: baseScope,
      enabledContextIds: new Set(["docs"]),
      availableContextIds: new Set(["docs", "tickets", "wiki"]),
    })!;
    expect(r.pinsByContext.get("docs")).toEqual(new Set(["item-1", "item-2"]));
    expect(r.scopedItemsByContext.get("tickets")).toEqual(["item-9"]);
    expect(r.scopedItemsByContext.get("wiki")).toBeNull();
    expect(new Set(r.addedContextIds)).toEqual(new Set(["tickets", "wiki"]));
  });

  it("unknown contexts are dropped with a warning, not an error", () => {
    const r = resolveProjectScope({
      scope: { ...baseScope, items: ["ghost/item-1", "docs/item-1"] },
      enabledContextIds: new Set(["docs"]),
      availableContextIds: new Set(["docs"]),
    })!;
    expect(r.allProjectContextIds).toEqual(["docs"]);
    expect(r.pinsByContext.get("docs")).toEqual(new Set(["item-1"]));
  });

  it("returns undefined when every referenced context is unknown", () => {
    expect(
      resolveProjectScope({
        scope: { ...baseScope, items: ["ghost/x"] },
        enabledContextIds: new Set(),
        availableContextIds: new Set(["docs"]),
      }),
    ).toBeUndefined();
  });
});

describe("buildProjectKbProfileDefaults", () => {
  it("maps the transcriptions context to conversations kind", () => {
    expect(buildProjectKbProfileDefaults(["transcriptions/t1", "docs/d1"])).toEqual({
      transcriptions: { enabled: true, kind: "conversations", instructions: "", overrides: {} },
    });
  });

  it("returns {} when transcriptions is not referenced", () => {
    expect(buildProjectKbProfileDefaults(["docs/d1", "wiki"])).toEqual({});
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npx jest ee/agentic-retrieval/pipeline/project-scope.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement** — create `ee/agentic-retrieval/pipeline/project-scope.ts`:

```ts
import type { KbProfile } from "./config";
import { parsePreselectedItems } from "./global-ids";

/** Identity + items of the project attached to the current chat session. */
export type ProjectScope = {
  id: string;
  name: string;
  description?: string;
  customInstructions?: string;
  /** Raw project_items gids: "<contextId>/<itemId>" or bare "<contextId>" (= whole context). */
  items: string[];
  /** Synthesized per-context profile defaults; a stored knowledge_bases profile always wins. */
  kbProfileDefaults?: Record<string, KbProfile>;
};

export type ResolvedProjectScope = {
  /** Contexts the instance already searches in full: project items only BOOST reranking. */
  pinsByContext: Map<string, Set<string>>;
  /** Contexts added for the project: hard item filter (null = whole context). */
  scopedItemsByContext: Map<string, string[] | null>;
  addedContextIds: string[];
  allProjectContextIds: string[];
};

/**
 * Split a project's items into pin vs scoped-source treatment. The invariant:
 * a project may ADD scope but must never NARROW what the agent already searches.
 */
export function resolveProjectScope(opts: {
  scope: ProjectScope | undefined;
  enabledContextIds: Set<string>;
  availableContextIds: Set<string>;
}): ResolvedProjectScope | undefined {
  const { scope, enabledContextIds, availableContextIds } = opts;
  if (!scope || scope.items.length === 0) return undefined;

  const itemsByContext = parsePreselectedItems(scope.items);
  const pinsByContext = new Map<string, Set<string>>();
  const scopedItemsByContext = new Map<string, string[] | null>();
  const addedContextIds: string[] = [];
  const allProjectContextIds: string[] = [];

  for (const [ctxId, itemIds] of itemsByContext) {
    if (!availableContextIds.has(ctxId)) {
      console.warn(
        `[EXULU pipeline] project "${scope.name}" references unknown context "${ctxId}" — skipping those items.`,
      );
      continue;
    }
    allProjectContextIds.push(ctxId);
    if (enabledContextIds.has(ctxId)) {
      if (itemIds && itemIds.length > 0) pinsByContext.set(ctxId, new Set(itemIds));
      // bare-context entry on an already-enabled context adds nothing
    } else {
      scopedItemsByContext.set(ctxId, itemIds);
      addedContextIds.push(ctxId);
    }
  }

  if (allProjectContextIds.length === 0) return undefined;
  return { pinsByContext, scopedItemsByContext, addedContextIds, allProjectContextIds };
}

const TRANSCRIPTIONS_CONTEXT_ID = "transcriptions";

/** Kind heuristic for auto-configured project sources (design spec §7.3). */
export function buildProjectKbProfileDefaults(items: string[]): Record<string, KbProfile> {
  const defaults: Record<string, KbProfile> = {};
  for (const gid of items) {
    const slashIdx = gid.indexOf("/");
    const ctxId = slashIdx === -1 ? gid : gid.slice(0, slashIdx);
    if (ctxId === TRANSCRIPTIONS_CONTEXT_ID && !defaults[ctxId]) {
      defaults[ctxId] = { enabled: true, kind: "conversations", instructions: "", overrides: {} };
    }
  }
  return defaults;
}
```

- [ ] **Step 6: Run to verify pass**

Run: `npx jest ee/agentic-retrieval/pipeline/project-scope.test.ts ee/agentic-retrieval/pipeline/index.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ee/agentic-retrieval/pipeline/global-ids.ts ee/agentic-retrieval/pipeline/project-scope.ts ee/agentic-retrieval/pipeline/project-scope.test.ts ee/agentic-retrieval/pipeline/index.ts
git commit -m "feat(retrieval): project scope resolution (pins vs scoped sources)"
```

---

### Task 3: `searchContexts` learns `scopedItemsByContext`

**Files:**
- Modify: `ee/agentic-retrieval/pipeline/search.ts` (opts type ~line 15-33, pin block ~line 76-105)
- Test: `ee/agentic-retrieval/pipeline/search.test.ts`

**Interfaces:**
- Consumes: `ResolvedProjectScope.scopedItemsByContext` shape from Task 2 (`Map<string, string[] | null>`).
- Produces: `searchContexts` accepts optional `scopedItemsByContext?: Map<string, string[] | null>`. Precedence per context: session preselection > project scoping > identifier/memory/user pins.

- [ ] **Step 1: Write the failing tests** — append to `describe("searchContexts", …)` in `search.test.ts`:

```ts
  it("project-scoped contexts hard-filter to the project's items", async () => {
    await searchContexts({
      ...base, contextIds: ["docs"],
      scopedItemsByContext: new Map([["docs", ["pj1", "pj2"]]]),
      identifierPinsByContext: new Map([["docs", new Set(["i1"])]]),
    });
    expect((multiQuerySearch as jest.Mock).mock.calls[0][0].pinnedItemIds).toEqual(["pj1", "pj2"]);
  });

  it("project-scoped whole-context entry (null) searches the context unfiltered", async () => {
    await searchContexts({
      ...base, contextIds: ["docs"],
      scopedItemsByContext: new Map([["docs", null]]),
      identifierPinsByContext: new Map([["docs", new Set(["i1"])]]),
    });
    expect((multiQuerySearch as jest.Mock).mock.calls[0][0].pinnedItemIds).toEqual([]);
  });

  it("session preselection wins over project scoping", async () => {
    await searchContexts({
      ...base, contextIds: ["docs"],
      preselectedItems: new Map([["docs", ["s1"]]]),
      scopedItemsByContext: new Map([["docs", ["pj1"]]]),
    });
    expect((multiQuerySearch as jest.Mock).mock.calls[0][0].pinnedItemIds).toEqual(["s1"]);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest ee/agentic-retrieval/pipeline/search.test.ts`
Expected: FAIL — first new test gets `["i1"]` instead of `["pj1", "pj2"]` (option ignored).

- [ ] **Step 3: Implement** — in `search.ts`:

Add to the opts type (after `preselectedItems`):

```ts
  /** Project-added sources: hard item filter per context (null = whole context). */
  scopedItemsByContext?: Map<string, string[] | null>;
```

Add `scopedItemsByContext,` to the destructuring block. Then extend the pin cascade (currently `if (hasPreselection) … else if (!skipPrefilter) … else …`) with a branch between preselection and the pin rules:

```ts
        // Rule 1: Effective pins START from preselectedItems
        const hasPreselection = preselectedItems.has(ctxId);
        let pinnedItemIds: string[];

        if (hasPreselection) {
          // null value = whole context = no filter = []
          pinnedItemIds = preselectedItems.get(ctxId) ?? [];
        } else if (scopedItemsByContext?.has(ctxId)) {
          // Project-scoped source: restrict to the project's items for this
          // context (null = whole context). Deliberately NOT unioned with
          // identifier/memory pins — those would widen a scoped source.
          pinnedItemIds = scopedItemsByContext.get(ctxId) ?? [];
        } else if (!skipPrefilter) {
```

(The rest of the cascade is unchanged.)

- [ ] **Step 4: Run to verify pass**

Run: `npx jest ee/agentic-retrieval/pipeline/search.test.ts`
Expected: PASS (all cases including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add ee/agentic-retrieval/pipeline/search.ts ee/agentic-retrieval/pipeline/search.test.ts
git commit -m "feat(retrieval): item-scoped project sources in searchContexts"
```

---

### Task 4: factory wiring — `projectScope` through the pipeline

**Files:**
- Modify: `ee/agentic-retrieval/pipeline/index.ts` (factory opts ~97-116, description ~127, config array after `max_steps` ~173, execute body: after confirmed-filter ~274, extraInstructions ~325, after subset guard ~378, searchContexts calls ~410-450, rerank pin set ~455)
- Test: `ee/agentic-retrieval/pipeline/index.test.ts`

**Interfaces:**
- Consumes: `ProjectScope`, `resolveProjectScope` (Task 2); `cfg.projectSearch` (Task 1); `scopedItemsByContext` param (Task 3).
- Produces: `createAgenticRetrievalTool(opts)` accepts `projectScope?: ProjectScope`. Task 5 passes it from convert.

- [ ] **Step 1: Write the failing tests** — append to `index.test.ts` (match the file's existing harness/mocks style; these two need only the factory surface):

```ts
describe("projectScope factory surface", () => {
  it("declares the project_search config option with default true", () => {
    const tool = createAgenticRetrievalTool({ contexts: [], user: undefined, role: undefined, model: undefined });
    const entry = tool!.config.find((c: { name: string }) => c.name === "project_search");
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("boolean");
    expect(entry!.default).toBe(true);
  });

  it("mentions the attached project in the tool description", () => {
    const tool = createAgenticRetrievalTool({
      contexts: [],
      user: undefined,
      role: undefined,
      model: undefined,
      projectScope: { id: "p1", name: "Modernization", items: ["docs/i1"] },
    });
    expect(tool!.description).toContain('project "Modernization"');
  });
});
```

(If the license mock in `index.test.ts` gates factory creation, reuse the file's existing `checkLicense` mock so the factory returns a tool.)

- [ ] **Step 2: Run to verify failure**

Run: `npx jest ee/agentic-retrieval/pipeline/index.test.ts`
Expected: FAIL — no `project_search` entry, no description suffix.

- [ ] **Step 3: Implement the factory surface** — in `index.ts`:

Imports:

```ts
import { resolveProjectScope, type ProjectScope } from "./project-scope";
```

Opts type + destructuring: add `projectScope?: ProjectScope;` after `memoryItems` in both the type and the destructuring.

Description (line ~127) — append before the closing backtick logic by changing the property to:

```ts
    description:
      `Intelligent knowledge search across the available knowledge bases: ${contexts.map((c) => c.name || c.id).join(", ")}. Routes the question to the right sources, searches them with query expansion, and returns reranked passages. Results are exhaustive for the given query: do NOT repeat the call with a rephrased version of the same question — re-call only with genuinely new information (a different product or model, an explicitly named source or document, or new details from the user).` +
      (projectScope ? ` Also searches the knowledge items attached to the project "${projectScope.name}".` : ""),
```

Config array — insert after the `max_steps` entry:

```ts
      {
        name: "project_search",
        description:
          "Automatically include items attached to the chat's project as an additional knowledge source (boosts them in shared sources, adds scoped search for others).",
        type: "boolean",
        default: true,
      },
```

- [ ] **Step 4: Implement the execute wiring** — four insertions in the `execute` generator:

**(a)** Directly after the `confirmedContextIds` filter block (after line ~274) and **before** the "Derived maps" section, insert:

```ts
      // ── Project scope: additional source, never narrows configured sources ──
      const availableContextsById = new Map(contexts.map((c) => [c.id, c]));
      const resolvedProject = cfg.projectSearch
        ? resolveProjectScope({
            scope: projectScope,
            enabledContextIds: new Set(enabledContexts.map((c) => c.id)),
            availableContextIds: new Set(availableContextsById.keys()),
          })
        : undefined;
      if (resolvedProject) {
        // Synthesized profile defaults (e.g. transcriptions → conversations kind);
        // a stored knowledge_bases profile always wins.
        if (projectScope?.kbProfileDefaults) {
          for (const [ctxId, profile] of Object.entries(projectScope.kbProfileDefaults)) {
            if (!cfg.knowledgeBases[ctxId]) cfg.knowledgeBases[ctxId] = profile;
          }
        }
        // Copy-on-write: enabledContexts may alias the factory's contexts array
        // (the restore-all branch above), so never push into it.
        enabledContexts = [
          ...enabledContexts,
          ...resolvedProject.addedContextIds
            .map((id) => availableContextsById.get(id))
            .filter((c): c is NonNullable<typeof c> => Boolean(c)),
        ];
      }
```

**(b)** extraInstructions (line ~325) becomes:

```ts
      const extraInstructions = [
        cfg.instructions,
        adminInstructions,
        projectScope?.customInstructions
          ? `Instructions for the attached project "${projectScope.name}":\n${projectScope.customInstructions}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
```

**(c)** Immediately **after** the preselection-subset guard block (after line ~378 — placement matters: appending before the guard would trip it when session preselection exists), insert:

```ts
      // ── Project sources are always-main (attaching a project is an explicit signal) ──
      let effectiveMainContexts = mainContexts;
      if (resolvedProject) {
        const mainSet = new Set(mainContexts);
        const appended = resolvedProject.allProjectContextIds.filter(
          (id) => !mainSet.has(id) && contextsById.has(id),
        );
        if (appended.length > 0) {
          effectiveMainContexts = [...mainContexts, ...appended];
          result.steps.push({
            stepNumber: 1,
            text: `Including sources from project "${projectScope!.name}": ${appended.join(", ")}`,
            toolCalls: [],
            chunks: [],
            tokens: 0,
          });
          result.reasoning.push({
            text: `Including project sources: ${appended.join(", ")}`,
            tools: [],
          });
        }
      }
```

Then change the main `searchContexts` call to use `contextIds: effectiveMainContexts` (was `mainContexts`) and add `scopedItemsByContext: resolvedProject?.scopedItemsByContext,` to **both** `searchContexts` calls (main and speculative fallback).

**(d)** Rerank pin set (the `pinnedItemIds = new Set<string>([...])` construction ~line 455): add project pins as a fourth generator:

```ts
      const pinnedItemIds = new Set<string>([
        ...memoryPinnedItemIds,
        ...(function* () {
          for (const s of exactPinsByContext.values()) yield* s;
        })(),
        ...(function* () {
          for (const s of userPinnedItemIdsByContext.values()) yield* s;
        })(),
        ...(function* () {
          if (resolvedProject) for (const s of resolvedProject.pinsByContext.values()) yield* s;
        })(),
      ]);
```

- [ ] **Step 5: Run the pipeline suite**

Run: `npx jest ee/agentic-retrieval/pipeline`
Expected: PASS — new factory tests green, all existing routing/search/memory/rerank suites untouched.

- [ ] **Step 6: Commit**

```bash
git add ee/agentic-retrieval/pipeline/index.ts ee/agentic-retrieval/pipeline/index.test.ts
git commit -m "feat(retrieval): projectScope option — pins, scoped sources, always-main routing"
```

---

### Task 5: convert — project load, Case 1/Case 2, disabledTools

**Files:**
- Modify: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts` (imports ~12, signature ~149-167, project block ~206-217, memory push ~230-236, session-items push ~240-250, session-file-read push ~252-255, agentic block ~257-285)
- Test: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts` (create)

**Interfaces:**
- Consumes: `ProjectScope`, `buildProjectKbProfileDefaults` from `@EE/agentic-retrieval/pipeline/project-scope`; factory `projectScope` opt (Task 4).
- Produces: `convertExuluToolsToAiSdkTools(…, contextWindow?, disabledTools?: string[])` — 18th positional param. Task 7 passes it from provider/gateway.

- [ ] **Step 1: Write the failing tests** — create `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts`:

```ts
import { convertExuluToolsToAiSdkTools } from "./convert-exulu-tools-to-ai-sdk-tools";
import { createAgenticRetrievalTool } from "@EE/agentic-retrieval/pipeline/index";
import { postgresClient } from "@SRC/postgres/client";

jest.mock("@EE/agentic-retrieval/pipeline/index", () => ({
  createAgenticRetrievalTool: jest.fn(() => ({
    id: "agentic_context_search",
    name: "Context Search",
    description: "d",
    type: "context",
    category: "contexts",
    needsApproval: false,
    config: [],
    tool: { execute: jest.fn() },
  })),
}));
jest.mock("./session-file-read-tool", () => ({ createSessionFileReadTool: jest.fn(() => undefined) }));
jest.mock("@SRC/postgres/client", () => ({ postgresClient: jest.fn() }));

const factory = createAgenticRetrievalTool as jest.Mock;

function mockProjectRow(row: unknown) {
  (postgresClient as jest.Mock).mockResolvedValue({
    db: { from: () => ({ where: () => ({ first: async () => row }) }) },
  });
}

const docsContext = { id: "docs", name: "Docs" } as never;
const otherContext = { id: "other", name: "Other" } as never;
const model = {} as never;

const PROJECT_ROW = {
  id: "p1",
  name: "Modernization",
  description: "desc",
  custom_instructions: "check norms",
  project_items: ["docs/i1", "docs/i2"],
};

beforeEach(() => {
  factory.mockClear();
  mockProjectRow(PROJECT_ROW);
});

const agenticEntry = {
  id: "agentic_context_search",
  name: "Context Search",
  description: "d",
  type: "context",
  category: "contexts",
  config: [],
  tool: { execute: jest.fn() },
} as never;

const call = (currentTools: unknown[], opts?: { project?: string; disabledTools?: string[] }) =>
  convertExuluToolsToAiSdkTools(
    currentTools as never, [], [], [], [], undefined,
    [docsContext, otherContext] as never, undefined, undefined, undefined, undefined,
    opts?.project, undefined, model, undefined, undefined, undefined,
    opts?.disabledTools,
  );

describe("project → agentic retrieval wiring", () => {
  it("Case 2: agent HAS the tool → factory receives projectScope, tool replaced in place", async () => {
    const tools = await call([agenticEntry], { project: "p1" });
    expect(factory).toHaveBeenCalledTimes(1);
    const opts = factory.mock.calls[0][0];
    expect(opts.projectScope).toMatchObject({
      id: "p1",
      name: "Modernization",
      customInstructions: "check norms",
      items: ["docs/i1", "docs/i2"],
    });
    expect(Object.keys(tools)).toEqual(["Context_Search"]);
  });

  it("Case 1: agent lacks the tool → project-scoped instance pushed with project items preselected", async () => {
    const tools = await call([], { project: "p1" });
    expect(factory).toHaveBeenCalledTimes(1);
    const opts = factory.mock.calls[0][0];
    expect(opts.preselected).toEqual(["docs/i1", "docs/i2"]);
    expect(opts.contexts.map((c: { id: string }) => c.id)).toEqual(["docs"]);
    expect(Object.keys(tools)).toEqual(["Context_Search"]);
  });

  it("unlicensed (factory returns undefined) → no tool at all, no legacy fallback", async () => {
    factory.mockReturnValueOnce(undefined);
    const tools = await call([], { project: "p1" });
    expect(Object.keys(tools)).toEqual([]);
  });

  it("empty project_items → no injection", async () => {
    mockProjectRow({ ...PROJECT_ROW, project_items: [] });
    const tools = await call([], { project: "p1" });
    expect(factory).not.toHaveBeenCalled();
    expect(Object.keys(tools)).toEqual([]);
  });

  it("disabledTools contains agentic_context_search → no project load, no injection", async () => {
    const tools = await call([], { project: "p1", disabledTools: ["agentic_context_search"] });
    expect(factory).not.toHaveBeenCalled();
    expect(Object.keys(tools)).toEqual([]);
  });

  it("project_items arriving as a JSON string is parsed defensively", async () => {
    mockProjectRow({ ...PROJECT_ROW, project_items: JSON.stringify(["docs/i1"]) });
    await call([], { project: "p1" });
    expect(factory.mock.calls[0][0].preselected).toEqual(["docs/i1"]);
  });
});
```

Note on `Object.keys(tools)`: `sanitizeToolName` converts `"Context Search"` → `Context_Search` (spaces to underscores, 64-char cap). If the sanitized shape differs when you run it, read `src/utils/sanitize-tool-name.ts` and fix the expected literal in the test — the assertion's point is "exactly one converted tool", not the exact spelling.

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts`
Expected: FAIL — convert still calls `createProjectItemsRetrievalTool` (which hits the mocked-away postgres differently) and never passes `projectScope` / 18th param.

- [ ] **Step 3: Implement** — in `convert-exulu-tools-to-ai-sdk-tools.ts`:

Imports — remove `import { createProjectItemsRetrievalTool } from "./project-retrieval-tool";` and add:

```ts
import {
  buildProjectKbProfileDefaults,
  type ProjectScope,
} from "@EE/agentic-retrieval/pipeline/project-scope";
```

Signature — append the 18th param after `contextWindow?: number,`:

```ts
  disabledTools?: string[],
```

Replace the legacy project block (lines ~206-217) with:

```ts
  const disabled = new Set(disabledTools ?? []);

  // Project scope: when the session belongs to a project, its items become an
  // additional source for the agentic retrieval pipeline (EE-only by design —
  // the legacy basic project tool was removed; see the 2026-07-07 design spec).
  let projectScope: ProjectScope | undefined;
  if (project && !disabled.has("agentic_context_search")) {
    const { db } = await postgresClient();
    const projectRow = await db.from("projects").where("id", project).first();
    let rawItems: unknown = projectRow?.project_items;
    if (typeof rawItems === "string") {
      try {
        rawItems = JSON.parse(rawItems);
      } catch {
        rawItems = undefined;
      }
    }
    if (projectRow && Array.isArray(rawItems) && rawItems.length > 0) {
      projectScope = {
        id: projectRow.id,
        name: projectRow.name,
        description: projectRow.description ?? undefined,
        customInstructions: projectRow.custom_instructions ?? undefined,
        items: rawItems as string[],
        kbProfileDefaults: buildProjectKbProfileDefaults(rawItems as string[]),
      };
    }
  }
```

Guard the other convert-injected pushes with the disable set (same pattern, three sites):

```ts
    if (createNewMemoryTool && !disabled.has(createNewMemoryTool.id)) {
```

```ts
    if (sessionItemsRetrievalTool && !disabled.has(sessionItemsRetrievalTool.id)) {
```

```ts
  if (sessionFileReadTool && !disabled.has(sessionFileReadTool.id)) {
```

(Drop the now-redundant inner `if (!currentTools) { currentTools = []; }` in the memory block if the linter flags it; otherwise leave it.)

Replace the agentic block (lines ~257-285) with:

```ts
  console.log("[EXULU] Creating agentic search tool", contexts?.length, model);
  if (contexts?.length && model && !disabled.has("agentic_context_search")) {
    const index = currentTools.findIndex((tool) => tool.id === "agentic_context_search");
    const memoryContext = agent?.memory
      ? contexts.find((c) => c.id === agent.memory)
      : undefined;
    if (index !== -1) {
      // Case 2: the agent has agentic retrieval configured — the project (when
      // present) rides the same instance as an additional source.
      const agenticSearchTool = createAgenticRetrievalTool({
        contexts: contexts.filter((context) => context.id !== agent?.memory), // memory is searched by the memory phase, not as a KB
        memoryContext,
        user: user,
        role: user?.role?.id,
        model: model,
        preselected: sessionItems,
        memoryItems: memoryItems,
        projectScope,
      });
      if (agenticSearchTool) {
        currentTools[index] = {
          ...currentTools[index], // important to keep the original tool config
          ...agenticSearchTool,
        };
      }
    } else if (projectScope) {
      // Case 1: no agentic retrieval configured, but the chat has a project —
      // auto-inject an instance scoped to the project's knowledge. Zod defaults
      // are the preset (no stored config exists for a pushed tool).
      const projectContextIds = new Set(
        projectScope.items.map((gid) => {
          const i = gid.indexOf("/");
          return i === -1 ? gid : gid.slice(0, i);
        }),
      );
      const scopedContexts = contexts.filter(
        (c) => projectContextIds.has(c.id) && c.id !== agent?.memory,
      );
      if (scopedContexts.length > 0) {
        const projectSearchTool = createAgenticRetrievalTool({
          contexts: scopedContexts,
          memoryContext,
          user: user,
          role: user?.role?.id,
          model: model,
          preselected: [...(sessionItems ?? []), ...projectScope.items],
          memoryItems: memoryItems,
          projectScope,
        });
        if (projectSearchTool) {
          currentTools.push(projectSearchTool);
        }
      }
    }
  } else {
    // Double check to remove the agentic search tool if it
    // was enabled but no contexts or model are available.
    const agenticSearchTool = currentTools.find((tool) => tool.id === "agentic_context_search");
    if (agenticSearchTool) {
      currentTools.splice(currentTools.indexOf(agenticSearchTool), 1);
    }
  }
```

Also delete the now-dead `let projectRetrievalTool: ExuluTool | undefined;` declaration if any remnant survives.

- [ ] **Step 4: Run to verify pass**

Run: `npx jest src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts
git commit -m "feat(retrieval): route project items through the agentic pipeline in convert"
```

---

### Task 6: display hydration + delete the legacy tool

**Files:**
- Modify: `src/graphql/utilities/sanitize-and-hydrate-fields.ts` (import line 7, project block ~244-255)
- Delete: `src/templates/tools/project-retrieval-tool.ts`

**Interfaces:**
- Consumes: `createAgenticRetrievalTool` (already imported in the file at its line ~148 usage).
- Produces: `agentById(id, project:)` returns at most one `agentic_context_search` entry; frontend contract is `{id, name}` only.

- [ ] **Step 1: Replace the hydration block** — in `sanitize-and-hydrate-fields.ts`, delete the import `import { createProjectItemsRetrievalTool } from "@SRC/templates/tools/project-retrieval-tool.ts";` and replace the `if (args.project) { … }` block (~244-255) with:

```ts
      if (args.project) {
        // Project chats surface the agentic search capability in the tool sheet.
        // When the agent already has the tool there is nothing to add (no
        // duplicate ids); when it doesn't, show the pipeline entry the runtime
        // will auto-inject (EE license permitting — unlicensed → no entry).
        const hasAgentic = result.tools.some(
          (tool: { id?: string } | null) => tool?.id === "agentic_context_search",
        );
        if (!hasAgentic) {
          const instance = createAgenticRetrievalTool({
            contexts: [],
            user: user,
            role: user.role?.id,
            model: undefined,
          });
          if (instance) {
            result.tools.unshift({
              id: instance.id,
              name: instance.name,
              description: instance.description,
              category: instance.category,
              type: instance.type,
              config: [],
            });
          }
        }
      }
```

- [ ] **Step 2: Delete the legacy tool**

```bash
git rm src/templates/tools/project-retrieval-tool.ts
```

- [ ] **Step 3: Verify zero remaining references**

Run: `grep -rn "createProjectItemsRetrievalTool\|project-retrieval-tool" src ee`
Expected: no output.

- [ ] **Step 4: Typecheck + full backend suite**

Run: `npx tsc --noEmit && npx jest`
Expected: clean compile; all suites PASS.

- [ ] **Step 5: Commit**

```bash
git add src/graphql/utilities/sanitize-and-hydrate-fields.ts
git commit -m "refactor(retrieval)!: delete legacy project retrieval tool (EE-only project search)"
```

---

### Task 7: provider — citation gate after convert + disabledTools threading

**Files:**
- Modify: `src/exulu/provider.ts` (generateSync opts ~280-315, sync convert-hoist + gate ~455-495 and generateText calls ~539-568 and ~620-655; generateStream opts ~811-840, gate block ~1014-1068, convert call ~1148-1166)
- Modify: `src/exulu/routes.ts` (generateStream call ~807-824, generateSync call ~940-961 — add `disabledTools`)
- Modify: `src/exulu/openai-gateway.ts` (convert call ~443-461 — add `disabledTools` as 18th arg)

**Interfaces:**
- Consumes: convert's 18th param `disabledTools?: string[]` (Task 5).
- Produces: `generateSync`/`generateStream` accept `disabledTools?: string[]` in their options objects; the citation-format system prompt is decided AFTER convert has injected tools.

- [ ] **Step 1: generateSync** — add `disabledTools?: string[];` to the options type and `disabledTools,` to the destructuring (both around lines 280-315). Then hoist the convert call: immediately **before** the `const includesContextSearchTool = currentTools?.some(…)` line (~455), insert:

```ts
    // Convert BEFORE deciding citation instructions: convert injects tools
    // (project-scoped agentic search, memory, session items) into currentTools,
    // and the citation gate must see them (design spec §7.1).
    const tools = await convertExuluToolsToAiSdkTools(
      currentTools,
      currentSkills,
      approvedTools,
      allExuluTools,
      toolConfigs,
      providerapikey,
      contexts,
      user,
      exuluConfig,
      session,
      req,
      project,
      sessionItems,
      model,
      agent,
      memoryItems,
      contextWindow,
      disabledTools,
    );
```

Then replace the inline `tools: await convertExuluToolsToAiSdkTools(…)` argument in **both** generateText calls (the prompt branch ~545 and the messages branch ~634) with `tools: tools,` — delete both inline call expressions entirely.

- [ ] **Step 2: generateStream** — add `disabledTools?: string[];` to the options type and destructuring (~811-840). Add `disabledTools,` as the final argument of the existing convert call (~1148-1166). Then **move** the whole gate block — from `const includesContextSearchTool = currentTools?.some(` (~1014) through the end of the `if (includesWebSearchTool) { … }` block (~1068) — to immediately after `console.log("[EXULU] Converted tools", Object.keys(tools));` (~1167), before `const result = streamText({`. The moved block appends to `system`, which is still just a string at that point; the citation text lands after the skills/session-files sections, which is fine.

- [ ] **Step 3: routes + gateway** — in `routes.ts`, the run route already computes `const disabledTools = req.body.disabledTools ? req.body.disabledTools : [];` (~732). Add `disabledTools,` to the options object of the `generateStream({ … })` call (~807-824) and the `generateSync({ … })` call (~940-961). In `openai-gateway.ts`, append `disabledTools,` as the 18th argument of the `convertExuluToolsToAiSdkTools(…)` call (after `contextWindow,` at ~460).

- [ ] **Step 4: Typecheck + suites**

Run: `npx tsc --noEmit && npx jest`
Expected: clean compile, all PASS. (Provider has no unit harness; the citation-gate behavior is covered by manual UAT in Task 10 — scenario 1 must show citation badges.)

- [ ] **Step 5: Commit**

```bash
git add src/exulu/provider.ts src/exulu/routes.ts src/exulu/openai-gateway.ts
git commit -m "fix(provider): citation gate sees convert-injected tools; thread disabledTools to convert"
```

---

### Task 8: frontend — `project_search` in the wizard config schema

**Files (frontend repo — branch off `main`):**
- Modify: `app/(application)/agents/edit/[id]/components/knowledge-search/config-schema.ts` (header comment line 5, `WizardConfig` ~41-67, `defaultWizardConfig` ~248-263, `parseWizardConfig` ~269-332, `serializeWizardConfig` ~338-357)
- Test: `app/(application)/agents/edit/[id]/components/knowledge-search/config-schema.test.ts` (length assertion line 58 + new cases)

**Interfaces:**
- Consumes: backend option name `project_search` (boolean-string convention; absent/`""` = default true).
- Produces: `WizardConfig.projectSearch: boolean`; serializer emits exactly **13** entries. Task 9 binds `draft.projectSearch` in the Behavior step.

- [ ] **Step 1: Write the failing tests** — in `config-schema.test.ts`, change the existing `expect(entries).toHaveLength(12);` to `expect(entries).toHaveLength(13);` and add:

```ts
describe("projectSearch", () => {
  it("defaults to true when the entry is absent or staged empty", () => {
    expect(parseWizardConfig([]).projectSearch).toBe(true);
    expect(
      parseWizardConfig([{ name: "project_search", variable: "", type: "boolean" }]).projectSearch,
    ).toBe(true);
  });

  it("parses explicit false and round-trips", () => {
    const cfg = { ...defaultWizardConfig(), projectSearch: false };
    const entries = serializeWizardConfig(cfg);
    expect(entries.find((e) => e.name === "project_search")?.variable).toBe("false");
    expect(parseWizardConfig(entries).projectSearch).toBe(false);
  });
});
```

(Match the file's existing import style for `parseWizardConfig`, `serializeWizardConfig`, `defaultWizardConfig`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run "app/(application)/agents/edit/[id]/components/knowledge-search/config-schema.test.ts"`
Expected: FAIL — length 12, `projectSearch` undefined.

- [ ] **Step 3: Implement** — in `config-schema.ts`:

Header comment line 5: change `(11-entry serialisation contract)` to `(13-entry serialisation contract)`.

`WizardConfig` — after `logging: boolean;`:

```ts
  /** Search items attached to the chat's project automatically. Default on. */
  projectSearch: boolean;
```

`defaultWizardConfig()` — after `logging: false,`:

```ts
    projectSearch: true,
```

`parseWizardConfig` — after the `logging` line (absent or staged-empty entry means "backend default", which is ON — plain `boolVal` would flip it off):

```ts
  const projectSearchRaw = findEntry(list, "project_search")?.variable;
  const projectSearch =
    projectSearchRaw === undefined || projectSearchRaw === "" ? true : boolVal(projectSearchRaw);
```

…and add `projectSearch,` to the returned object.

`serializeWizardConfig` — after the `logging` entry:

```ts
    { name: "project_search", variable: cfg.projectSearch ? "true" : "false", type: "boolean" },
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run "app/(application)/agents/edit/[id]/components/knowledge-search/config-schema.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit (frontend repo)**

```bash
git add "app/(application)/agents/edit/[id]/components/knowledge-search/config-schema.ts" "app/(application)/agents/edit/[id]/components/knowledge-search/config-schema.test.ts"
git commit -m "feat(agents): project_search wizard config option (13-entry contract)"
```

---

### Task 9: frontend — Behavior-step switch + locale copy

**Files (frontend repo):**
- Modify: `app/(application)/agents/edit/[id]/components/knowledge-search/steps/behavior-step.tsx` (insert after the fallback-slider block, ~line 83)
- Modify: `messages/en.json` (under `agents.editor.knowledge.wizard.behavior`, sibling of `rerankerTitle`/`topKLabel` keys — the wizard `behavior` object near line 558)
- Modify: `messages/de.json` (same key path)

**Interfaces:**
- Consumes: `draft.projectSearch` (Task 8).
- Produces: user-visible toggle; translation keys `agents.editor.knowledge.wizard.behavior.projectSearch.label` / `.hint`.

- [ ] **Step 1: Add the switch** — in `behavior-step.tsx`, insert between the fallback-slider `</div>` (~line 83) and the instructions block (~line 85):

```tsx
      <div className="flex items-start justify-between gap-3 rounded-md border p-3">
        <div className="space-y-0.5">
          <p className="text-xs font-medium">
            {t("editor.knowledge.wizard.behavior.projectSearch.label")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("editor.knowledge.wizard.behavior.projectSearch.hint")}
          </p>
        </div>
        <Switch
          checked={draft.projectSearch}
          onCheckedChange={(v) => setDraft((prev) => ({ ...prev, projectSearch: v }))}
        />
      </div>
```

- [ ] **Step 2: Locale copy** — in `messages/en.json`, inside the wizard's `behavior` object (the one containing `rerankerTitle`, near line 558), add:

```json
"projectSearch": {
  "label": "Search attached project items",
  "hint": "When a chat belongs to a project, the assistant automatically searches the items pinned to that project."
},
```

In `messages/de.json`, same position:

```json
"projectSearch": {
  "label": "Angeheftete Projektelemente durchsuchen",
  "hint": "Gehört ein Chat zu einem Projekt, durchsucht der Assistent automatisch die im Projekt angehefteten Elemente."
},
```

- [ ] **Step 3: Typecheck + tests**

Run: `npx tsc --noEmit && npx vitest run "app/(application)/agents/edit/[id]/components/knowledge-search/config-schema.test.ts"`
Expected: clean compile, tests PASS. Then open the agent editor wizard (Behavior step) in the dev server and confirm the switch renders with copy in both locales.

- [ ] **Step 4: Commit (frontend repo)**

```bash
git add "app/(application)/agents/edit/[id]/components/knowledge-search/steps/behavior-step.tsx" messages/en.json messages/de.json
git commit -m "feat(agents): project search toggle in knowledge wizard behavior step"
```

---

### Task 10: full verification + manual UAT

**Files:** none created — verification only.

- [ ] **Step 1: Full backend gate**

Run (backend root): `npx tsc --noEmit && npx jest`
Expected: clean compile, all suites PASS.

- [ ] **Step 2: Full frontend gate**

Run (frontend root): `npx tsc --noEmit && npx vitest run`
Expected: clean compile, all suites PASS.

- [ ] **Step 3: Reference sweep** — confirm the legacy tool is fully gone and the new option is declared everywhere:

```bash
grep -rn "context_search_in_knowledge_items_added_to_project\|createProjectItemsRetrievalTool" src ee || echo CLEAN
grep -rn "project_search" ee/agentic-retrieval/pipeline/config.ts ee/agentic-retrieval/pipeline/index.ts
```

Expected: first prints `CLEAN`; second shows the parse line and the config declaration.

- [ ] **Step 4: Manual UAT** (dev server, EE license active; spec §8 scenarios):

1. **Case 1** — agent WITHOUT agentic retrieval, chat in a project with items from ≥2 contexts: retrieval streams pipeline steps, answers cite project items with citation badges (validates Task 5 + Task 7's gate fix).
2. **Case 2 overlap** — agent WITH agentic retrieval whose enabled KBs include a project context: results are not narrowed to project items; project items rank visibly higher (pin boost).
3. **Case 2 extension** — project references a context the agent does not have enabled: passages from that context appear, restricted to the project's items.
4. **Entire-context entry** — project containing a bare-context ("Entire context") item: results come back from that context (the legacy silent-empty bug is gone).
5. **Toggle off** — set "Search attached project items" off in the wizard, save, re-ask in a project chat: no project sources are searched.
6. **Gateway** — one request through `POST` with `projectname/agentname` model routing: project retrieval works there too.
7. **Capability sheet** — project chat with a Case-1 agent shows a single "Context Search" entry; disabling it stops project retrieval for that message (Task 7 threading).

- [ ] **Step 5: Final commit if UAT produced fixes**

```bash
git add -A && git commit -m "fix(retrieval): UAT follow-ups for project agentic retrieval"
```

---

## Self-review notes (already applied)

- Spec §3.2 "Case 1 passes both `preselected` and `projectScope`" → Task 5 Case-1 branch passes both; the union semantics no-op under preselection (search.ts preselection branch wins; verified by Task 3's precedence test).
- Spec §3.3 gate independence → project scope enters `execute` *after* the `managedContext` / `requirePreselectedContexts` gates read `preselected`, and the always-main append sits *after* the subset guard (Task 4c placement note).
- Spec §5 approval delta → nothing to implement: the factory already sets `needsApproval: false`; convert's expression at ~line 381 honors it.
- Spec §6 "project row missing → no injection" → Task 5's `projectRow &&` guard; "config parse failure → default true" → Task 1's explicit undefined/empty handling.
- `resolve-max-steps.ts` needs no change: a Case-1 pushed instance has no `toolConfigs` entry → `DEFAULT_MAX_STEPS` 10, per spec §3.2.
