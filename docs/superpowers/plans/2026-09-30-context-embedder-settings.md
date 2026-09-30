# Admin-Configurable Per-Context Embedder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a context's embedding model an admin setting — the in-code `embedder` becomes a default, a stored override wins, and changing it orchestrates the rebuild the storage layer forces.

**Architecture:** Storage and resolution mirror the proven entity-model override (`platform_configurations`, code-default / DB-override / effective-value). The resolved value is **hydrated onto `context.embedder`** rather than resolved per read, because that property has 30 read sites and several are synchronous by construction. Changing an embedder runs one orchestrated mutation: validate, delete chunks, rebuild the table when the vector dimension differs, persist, queue regeneration.

**Tech Stack:** Backend — TypeScript, knex, pgvector, BullMQ, hand-rolled GraphQL schema builder, jest + ts-jest. Frontend — Next.js 16 App Router, Apollo Client, shadcn/ui, vitest (node environment only).

**Spec:** `docs/superpowers/specs/2026-09-30-context-embedder-settings-design.md`

**Repos:** backend worktree `../backend-context-embedder` (branch `feat/context-embedder-settings`, off `develop` @ cdbdeca). The frontend worktree is created in Task 6 — see that task. **Never edit one repo from the other's directory.**

## Global Constraints

- **Config key:** `context_embedder:<contextId>`, alongside the existing `entity_extraction_model:<contextId>`.
- **`config_value` is a `json` column.** Postgres may return it already parsed or as raw text — every read must tolerate both, exactly as `getEntityModelSetting` (`src/exulu/entities/config.ts:127-140`) and `budget-service` do.
- **Never break boot.** Hydration runs inside `initExuluDb`. Any failure in it — an unreadable setting, a model no longer in the catalogue, an unresolvable queue — must log and fall back, never throw. An exception here means the application does not start.
- **Persist after DDL, never before.** If a rebuild fails, the stored setting must still name the old model, so the context keeps working instead of pointing at a column that does not exist.
- **Regeneration is always required on a model change**, even at identical dimensions — vectors from a different model are not comparable. Only *table surgery* is dimension-dependent.
- **Admin-gated:** every mutation requires an authenticated user, mirroring `${tableNameSingular}SetEntityModel` (`src/graphql/mutations/index.ts:1231-1242`).
- Commit messages: conventional prefix, and end every message with the trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **Measured baselines on this branch — already failing, NOT regressions.** Backend: `npx tsc --noEmit` = 9 errors; `npx jest` = 4 failed suites / 12 failed tests. Lint: one eslint parse error per NEW `.test.ts` file is structural (the config cannot resolve test files into the tsconfig project); you regress only on findings outside that class. Measure before and after.
- Never `git add -A` or `git add .` — stage the files the task names.

## Review Focus

Failure modes the spec implies but no feature step naturally exercises. Each has its test assigned to the task that owns the code.

1. **A stored override naming a model that has since been removed from `config.litellm.yaml`.** At boot, hydration assigns it, then `contextDatabases` → `createChunksTable` → `getEmbeddingModelInfo` **throws and the application does not start.** This is the most destructive failure in the whole design. Hydration must validate the model resolves and fall back to the code default with a loud log. [Task 2]
2. **A stored queue name that no longer resolves** (queue renamed or removed). Must degrade to inline embedding with a warning, never make the context unwritable. [Task 2]
3. **A change requested for a context whose chunks table does not exist** (every context configured for the first time, including `transcriptions`). Case selection must not assume the table is there — reading its column dimension has no row to find. [Task 3]
4. **`platform_configurations` unreadable** (DB hiccup, table missing on a very first boot). Reads must degrade to the code default rather than throwing. [Task 1]
5. **Two admins changing the same context concurrently.** Last write wins on the setting, but the destructive steps must be idempotent — delete-all, drop-if-exists, create — so the loser does not error on a table the winner already dropped. [Task 3]

---

### Task 1: Settings storage and resolution

**Files:**
- Create: `src/exulu/embedder-settings.ts`
- Create: `src/exulu/embedder-settings.test.ts`

**Interfaces:**
- Consumes: `ExuluContext` (type only), `postgresClient`.
- Produces — Tasks 2, 3 and 4 all consume these:

```ts
export type EmbedderSource = "database" | "code";
export type StoredEmbedder = { model: string; queue: string | null };
export interface ContextEmbedderInfo {
  effectiveModel: string | null;
  source: EmbedderSource | null;
  databaseModel: string | null;
  codeModel: string | null;
  databaseQueue: string | null;
}
export const embedderKey: (contextId: string) => string;
export const getEmbedderSetting: (contextId: string) => Promise<StoredEmbedder | null>;
export const setEmbedderSetting: (contextId: string, model: string, queue: string | null) => Promise<void>;
export const clearEmbedderSetting: (contextId: string) => Promise<void>;
export const resolveContextEmbedder: (context: Pick<ExuluContext, "id" | "embedder">) => Promise<ContextEmbedderInfo>;
```

Note `resolveContextEmbedder` takes `Pick<ExuluContext, "id" | "embedder">`, not the full class — that is what makes it testable with a plain object.

- [ ] **Step 1: Write the failing tests**

Create `src/exulu/embedder-settings.test.ts`:

```ts
import {
  embedderKey,
  getEmbedderSetting,
  resolveContextEmbedder,
  setEmbedderSetting,
  clearEmbedderSetting,
} from "./embedder-settings";

const first = jest.fn();
const del = jest.fn();
const insert = jest.fn();
const merge = jest.fn();

jest.mock("@SRC/postgres/client", () => ({
  postgresClient: async () => ({
    db: {
      from: () => ({
        where: () => ({ first, del }),
        insert: () => ({ onConflict: () => ({ merge }) }),
      }),
    },
  }),
}));

beforeEach(() => {
  first.mockReset();
  del.mockReset();
  insert.mockReset();
  merge.mockReset();
});

const ctx = (embedder?: { model: string }) => ({ id: "docs", embedder });

describe("embedderKey", () => {
  it("namespaces by context, matching the entity-model key shape", () => {
    expect(embedderKey("docs")).toBe("context_embedder:docs");
  });
});

describe("getEmbedderSetting", () => {
  it("parses config_value when pg returns raw JSON text", async () => {
    first.mockResolvedValue({ config_value: '{"model":"text-embedding-3-large","queue":"embed"}' });
    expect(await getEmbedderSetting("docs")).toEqual({
      model: "text-embedding-3-large",
      queue: "embed",
    });
  });

  it("accepts config_value when pg already parsed it into an object", async () => {
    first.mockResolvedValue({ config_value: { model: "e5", queue: null } });
    expect(await getEmbedderSetting("docs")).toEqual({ model: "e5", queue: null });
  });

  it("returns null when there is no row", async () => {
    first.mockResolvedValue(undefined);
    expect(await getEmbedderSetting("docs")).toBeNull();
  });

  it("returns null rather than throwing when the read fails", async () => {
    // A database hiccup must degrade a context to its code default, never
    // take the app down — this function is called during boot.
    first.mockRejectedValue(new Error("connection terminated"));
    expect(await getEmbedderSetting("docs")).toBeNull();
  });

  it("returns null when the stored value has no usable model", async () => {
    first.mockResolvedValue({ config_value: '{"queue":"embed"}' });
    expect(await getEmbedderSetting("docs")).toBeNull();
  });
});

describe("resolveContextEmbedder", () => {
  it("prefers the stored override over the code default", async () => {
    first.mockResolvedValue({ config_value: '{"model":"override-model","queue":null}' });
    expect(await resolveContextEmbedder(ctx({ model: "code-model" }))).toEqual({
      effectiveModel: "override-model",
      source: "database",
      databaseModel: "override-model",
      codeModel: "code-model",
      databaseQueue: null,
    });
  });

  it("falls back to the code default when there is no override", async () => {
    first.mockResolvedValue(undefined);
    expect(await resolveContextEmbedder(ctx({ model: "code-model" }))).toEqual({
      effectiveModel: "code-model",
      source: "code",
      databaseModel: null,
      codeModel: "code-model",
      databaseQueue: null,
    });
  });

  it("reports no embedder at all when neither exists (the transcriptions case)", async () => {
    first.mockResolvedValue(undefined);
    expect(await resolveContextEmbedder(ctx(undefined))).toEqual({
      effectiveModel: null,
      source: null,
      databaseModel: null,
      codeModel: null,
      databaseQueue: null,
    });
  });

  it("carries the stored queue name through", async () => {
    first.mockResolvedValue({ config_value: '{"model":"m","queue":"embeddings"}' });
    const info = await resolveContextEmbedder(ctx(undefined));
    expect(info.databaseQueue).toBe("embeddings");
  });
});

describe("setEmbedderSetting / clearEmbedderSetting", () => {
  it("stores the model and queue as a JSON object literal", async () => {
    await setEmbedderSetting("docs", "m", "embeddings");
    expect(merge).toHaveBeenCalledWith(
      expect.objectContaining({ config_value: '{"model":"m","queue":"embeddings"}' }),
    );
  });

  it("stores a null queue explicitly rather than omitting it", async () => {
    await setEmbedderSetting("docs", "m", null);
    expect(merge).toHaveBeenCalledWith(
      expect.objectContaining({ config_value: '{"model":"m","queue":null}' }),
    );
  });

  it("clearing deletes the row so the code default takes over again", async () => {
    await clearEmbedderSetting("docs");
    expect(del).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/embedder-settings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/exulu/embedder-settings.ts`. Read `src/exulu/entities/config.ts:104-170` first and mirror its structure, comments and defensive style — this is deliberately the same pattern with a different payload.

```ts
/**
 * The admin-configurable embedding model for a context.
 *
 * Shaped after src/exulu/entities/config.ts: the value declared in code is a
 * default, a row in platform_configurations overrides it, and callers get an
 * "effective" value plus where it came from. The payload here is an object
 * ({ model, queue }) rather than a bare string, because an embedder also needs
 * the queue its jobs run on (spec §6).
 *
 * Every read is failure-tolerant on purpose: these run during boot, and an
 * unreadable setting must degrade a context to its code default rather than
 * stop the application from starting.
 *
 * Design doc: docs/superpowers/specs/2026-09-30-context-embedder-settings-design.md §1
 */
import { postgresClient } from "@SRC/postgres/client";
import type { ExuluContext } from "./context";

export type EmbedderSource = "database" | "code";

export type StoredEmbedder = { model: string; queue: string | null };

export interface ContextEmbedderInfo {
  /** The model embedding will actually use, or null when the context has none. */
  effectiveModel: string | null;
  /** Where the effective model came from; null when there is none. */
  source: EmbedderSource | null;
  /** The UI-configured override in platform_configurations. */
  databaseModel: string | null;
  /** `context.embedder.model` declared in code, if any. */
  codeModel: string | null;
  /** Queue name stored with the override; null means inline embedding. */
  databaseQueue: string | null;
}

export const embedderKey = (contextId: string) => `context_embedder:${contextId}`;

export const getEmbedderSetting = async (
  contextId: string,
): Promise<StoredEmbedder | null> => {
  try {
    const { db } = await postgresClient();
    const row = await db
      .from("platform_configurations")
      .where({ config_key: embedderKey(contextId) })
      .first();
    if (!row?.config_value) return null;
    // config_value is a `json` column. pg may hand it back already parsed or
    // as raw JSON text — handle both, mirroring getEntityModelSetting.
    const raw = row.config_value;
    let value: unknown = raw;
    if (typeof raw === "string") {
      try {
        value = JSON.parse(raw);
      } catch {
        return null;
      }
    }
    if (!value || typeof value !== "object") return null;
    const { model, queue } = value as { model?: unknown; queue?: unknown };
    if (typeof model !== "string" || !model.trim()) return null;
    return {
      model: model.trim(),
      queue: typeof queue === "string" && queue.trim() ? queue.trim() : null,
    };
  } catch (err) {
    console.warn(
      `[EXULU] Could not read the embedder setting for "${contextId}":`,
      (err as Error).message,
    );
    return null;
  }
};

export const setEmbedderSetting = async (
  contextId: string,
  model: string,
  queue: string | null,
): Promise<void> => {
  const { db } = await postgresClient();
  const value = JSON.stringify({ model: model.trim(), queue: queue?.trim() || null });
  await db
    .from("platform_configurations")
    .insert({
      config_key: embedderKey(contextId),
      config_value: value,
      description: `Embedding model for context ${contextId}`,
    })
    .onConflict("config_key")
    .merge({ config_value: value });
};

export const clearEmbedderSetting = async (contextId: string): Promise<void> => {
  const { db } = await postgresClient();
  await db
    .from("platform_configurations")
    .where({ config_key: embedderKey(contextId) })
    .del();
};

export const resolveContextEmbedder = async (
  context: Pick<ExuluContext, "id" | "embedder">,
): Promise<ContextEmbedderInfo> => {
  const stored = await getEmbedderSetting(context.id);
  const codeModel = context.embedder?.model ?? null;
  const databaseModel = stored?.model ?? null;
  const databaseQueue = stored?.queue ?? null;

  if (databaseModel) {
    return { effectiveModel: databaseModel, source: "database", databaseModel, codeModel, databaseQueue };
  }
  if (codeModel) {
    return { effectiveModel: codeModel, source: "code", databaseModel, codeModel, databaseQueue };
  }
  return { effectiveModel: null, source: null, databaseModel, codeModel, databaseQueue };
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/exulu/embedder-settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` — expect 9 (baseline).

```bash
git add src/exulu/embedder-settings.ts src/exulu/embedder-settings.test.ts
git commit -m "feat(contexts): store and resolve a per-context embedder override

Mirrors the entity-model pattern: code default, platform_configurations
override, and an effective value that says where it came from. Reads are
failure-tolerant because they run during boot — an unreadable setting must
degrade a context to its code default, not stop the app from starting.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Hydration onto `context.embedder`

**Files:**
- Create: `src/exulu/hydrate-embedders.ts`
- Create: `src/exulu/hydrate-embedders.test.ts`
- Modify: `src/postgres/init-exulu-db.ts` (insert the call between the core-schema loop at `:160` and `await contextDatabases(contexts)` at `:356` — find both with `grep -n "addMissingFields(knex, schema.name.plural\|await contextDatabases" src/postgres/init-exulu-db.ts`)

**Interfaces:**
- Consumes: `resolveContextEmbedder`, `ContextEmbedderInfo` (Task 1); `getEmbeddingModelInfo` from `src/exulu/litellm/parse-embedding-models.ts`; `exuluApp` from `src/exulu/app/singleton`.
- Produces — Task 3 and Task 4 consume `hydrateContextEmbedders`:

```ts
export type HydrateDeps = {
  resolve: (context: Pick<ExuluContext, "id" | "embedder">) => Promise<ContextEmbedderInfo>;
  /** Throws when the model is absent from config.litellm.yaml or lacks dimensionality. */
  modelInfo: (model: string) => { dimensionality: number };
  /** Registered queues, from exuluApp.get().queues(). */
  queues: () => { queue: { name: string } }[];
};
export const hydrateContextEmbedders: (
  contexts: ExuluContext[],
  deps?: Partial<HydrateDeps>,
) => Promise<void>;
```

`deps` is optional and defaults to the real collaborators, so production callers write `hydrateContextEmbedders(contexts)` while tests inject.

- [ ] **Step 1: Write the failing tests**

Create `src/exulu/hydrate-embedders.test.ts`:

```ts
import { hydrateContextEmbedders } from "./hydrate-embedders";

const context = (id: string, embedder?: any) => ({ id, embedder }) as any;

const deps = (over: Partial<Parameters<typeof hydrateContextEmbedders>[1]> = {}) => ({
  resolve: async (c: any) => ({
    effectiveModel: "override-model",
    source: "database" as const,
    databaseModel: "override-model",
    codeModel: c.embedder?.model ?? null,
    databaseQueue: null,
  }),
  modelInfo: () => ({ dimensionality: 1024 }),
  queues: () => [{ queue: { name: "embeddings" } }],
  ...over,
});

describe("hydrateContextEmbedders", () => {
  it("assigns the override onto the instance", async () => {
    const ctx = context("docs");
    await hydrateContextEmbedders([ctx], deps());
    expect(ctx.embedder.model).toBe("override-model");
  });

  it("leaves the code default in place when there is no override", async () => {
    const ctx = context("docs", { model: "code-model" });
    await hydrateContextEmbedders([ctx], deps({
      resolve: async () => ({
        effectiveModel: "code-model",
        source: "code",
        databaseModel: null,
        codeModel: "code-model",
        databaseQueue: null,
      }),
    }));
    expect(ctx.embedder.model).toBe("code-model");
  });

  it("leaves a context with no embedder anywhere undefined", async () => {
    const ctx = context("transcriptions");
    await hydrateContextEmbedders([ctx], deps({
      resolve: async () => ({
        effectiveModel: null,
        source: null,
        databaseModel: null,
        codeModel: null,
        databaseQueue: null,
      }),
    }));
    expect(ctx.embedder).toBeUndefined();
  });

  it("IGNORES an override whose model is gone from the catalogue, keeping the code default", async () => {
    // The whole-application failure this guards: hydration assigns a stale
    // model, then contextDatabases -> createChunksTable -> getEmbeddingModelInfo
    // throws, and the app never starts.
    const ctx = context("docs", { model: "code-model" });
    await hydrateContextEmbedders([ctx], deps({
      modelInfo: () => {
        throw new Error("Embedding model \"override-model\" was not found");
      },
    }));
    expect(ctx.embedder.model).toBe("code-model");
  });

  it("never throws when the catalogue lookup fails and there is no code default", async () => {
    const ctx = context("transcriptions");
    await expect(
      hydrateContextEmbedders([ctx], deps({
        modelInfo: () => {
          throw new Error("not found");
        },
      })),
    ).resolves.toBeUndefined();
    expect(ctx.embedder).toBeUndefined();
  });

  it("never throws when resolving the setting itself fails", async () => {
    const ctx = context("docs", { model: "code-model" });
    await expect(
      hydrateContextEmbedders([ctx], deps({
        resolve: async () => {
          throw new Error("connection terminated");
        },
      })),
    ).resolves.toBeUndefined();
    expect(ctx.embedder.model).toBe("code-model");
  });

  it("attaches the stored queue when it resolves against the registry", async () => {
    const ctx = context("docs");
    await hydrateContextEmbedders([ctx], deps({
      resolve: async () => ({
        effectiveModel: "m",
        source: "database",
        databaseModel: "m",
        codeModel: null,
        databaseQueue: "embeddings",
      }),
    }));
    expect(await ctx.embedder.queue).toEqual({ queue: { name: "embeddings" } });
  });

  it("degrades to inline when the stored queue name no longer resolves", async () => {
    // A renamed queue must not make the context unwritable.
    const ctx = context("docs");
    await hydrateContextEmbedders([ctx], deps({
      resolve: async () => ({
        effectiveModel: "m",
        source: "database",
        databaseModel: "m",
        codeModel: null,
        databaseQueue: "deleted-queue",
      }),
    }));
    expect(ctx.embedder.queue).toBeUndefined();
  });

  it("keeps the code embedder's queue when the override names none", async () => {
    const codeQueue = Promise.resolve({ queue: { name: "code-queue" } });
    const ctx = context("docs", { model: "code-model", queue: codeQueue });
    await hydrateContextEmbedders([ctx], deps());
    expect(await ctx.embedder.queue).toEqual({ queue: { name: "code-queue" } });
  });

  it("hydrates every context even if one of them fails", async () => {
    const bad = context("bad");
    const good = context("good");
    let call = 0;
    await hydrateContextEmbedders([bad, good], deps({
      resolve: async (c: any) => {
        call += 1;
        if (c.id === "bad") throw new Error("boom");
        return {
          effectiveModel: "good-model",
          source: "database",
          databaseModel: "good-model",
          codeModel: null,
          databaseQueue: null,
        };
      },
    }));
    expect(call).toBe(2);
    expect(good.embedder.model).toBe("good-model");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/hydrate-embedders.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/exulu/hydrate-embedders.ts`:

```ts
/**
 * Applies each context's stored embedder override onto the live instance.
 *
 * `context.embedder` stays the single SYNCHRONOUS source of truth everywhere
 * (30 read sites across 8 files, several of which — the knex createTable
 * callback, GraphQL schema generation, the bullmq validators — cannot be
 * async). Rather than resolve the override at each read, we resolve it once
 * and assign it here.
 *
 * Nothing in this module may throw. It runs inside initExuluDb; an exception
 * means the application does not start. Every failure path logs and leaves
 * the context on whatever it already had.
 *
 * Design doc: docs/superpowers/specs/2026-09-30-context-embedder-settings-design.md §2
 */
import { exuluApp } from "@SRC/exulu/app/singleton";
import type { ExuluContext } from "./context";
import { resolveContextEmbedder, type ContextEmbedderInfo } from "./embedder-settings";
import { getEmbeddingModelInfo } from "./litellm/parse-embedding-models";

export type HydrateDeps = {
  resolve: (context: Pick<ExuluContext, "id" | "embedder">) => Promise<ContextEmbedderInfo>;
  modelInfo: (model: string) => { dimensionality: number };
  queues: () => { queue: { name: string } }[];
};

const defaultDeps = (): HydrateDeps => ({
  resolve: resolveContextEmbedder,
  modelInfo: getEmbeddingModelInfo,
  queues: () => {
    try {
      return exuluApp.get().queues() as { queue: { name: string } }[];
    } catch {
      // The app singleton is not initialised in every context (e.g. early
      // boot, tests). No registry means no queue — inline is a valid answer.
      return [];
    }
  },
});

export const hydrateContextEmbedders = async (
  contexts: ExuluContext[],
  deps: Partial<HydrateDeps> = {},
): Promise<void> => {
  const { resolve, modelInfo, queues } = { ...defaultDeps(), ...deps };

  for (const context of contexts) {
    try {
      const info = await resolve(context);

      // No override: whatever the constructor set already stands.
      if (info.source !== "database" || !info.databaseModel) continue;

      // A stored model that has since been removed from config.litellm.yaml
      // would make createChunksTable throw during boot. Refuse the override
      // instead and leave the code default (or nothing) in place.
      try {
        modelInfo(info.databaseModel);
      } catch (err) {
        console.error(
          `[EXULU] Context "${context.id}" has a stored embedder "${info.databaseModel}" that is ` +
            `not a usable embedding model (${(err as Error).message.split("\n")[0]}). ` +
            `Ignoring the override and falling back to the model declared in code` +
            `${info.codeModel ? ` ("${info.codeModel}")` : " (none)"}.`,
        );
        continue;
      }

      const queueName = info.databaseQueue;
      let queue = context.embedder?.queue;
      if (queueName) {
        const found = queues().find((q) => q.queue?.name === queueName);
        if (found) {
          queue = Promise.resolve(found as never);
        } else {
          queue = undefined;
          console.warn(
            `[EXULU] Context "${context.id}" names embedder queue "${queueName}", which is not ` +
              `registered. Embedding will run inline.`,
          );
        }
      }

      context.embedder = { model: info.databaseModel, queue };
    } catch (err) {
      console.error(
        `[EXULU] Could not hydrate the embedder for context "${context.id}":`,
        (err as Error).message,
      );
    }
  }
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/exulu/hydrate-embedders.test.ts`
Expected: PASS, all eleven.

- [ ] **Step 5: Add the TTL refresh**

Boot-time hydration alone leaves a second replica on the old model after an admin changes it — and that is not a stale read, it is a hard pgvector error, because the replica would embed queries at the old dimensionality against a column the first replica just rebuilt. Append to `src/exulu/hydrate-embedders.ts`:

```ts
const REFRESH_INTERVAL_MS = 30_000;
let lastRefresh = 0;

/**
 * Re-hydrates at most every 30 seconds. Called from the async entry points
 * that already await, so the synchronous read sites stay untouched and are
 * at worst 30 seconds stale. Bounds the window in which a replica that did
 * not serve the change keeps embedding at the old dimensionality.
 */
export const refreshContextEmbeddersIfStale = async (
  contexts: ExuluContext[],
  now: number = Date.now(),
): Promise<void> => {
  if (now - lastRefresh < REFRESH_INTERVAL_MS) return;
  lastRefresh = now;
  await hydrateContextEmbedders(contexts);
};

/** Test seam — forces the next call to refresh. */
export const __resetEmbedderRefreshClock = () => {
  lastRefresh = 0;
};
```

Add tests for it in the same file, before implementing:

```ts
import {
  refreshContextEmbeddersIfStale,
  __resetEmbedderRefreshClock,
} from "./hydrate-embedders";

describe("refreshContextEmbeddersIfStale", () => {
  beforeEach(() => __resetEmbedderRefreshClock());

  it("refreshes on the first call", async () => {
    const ctx = context("docs");
    await refreshContextEmbeddersIfStale([ctx], 1_000_000);
    expect(ctx.embedder?.model).toBeDefined();
  });

  it("skips a call inside the 30s window", async () => {
    const ctx = context("docs");
    await refreshContextEmbeddersIfStale([ctx], 1_000_000);
    ctx.embedder = { model: "changed-by-hand" };
    await refreshContextEmbeddersIfStale([ctx], 1_010_000);
    expect(ctx.embedder.model).toBe("changed-by-hand");
  });

  it("refreshes again once the window has passed", async () => {
    const ctx = context("docs");
    await refreshContextEmbeddersIfStale([ctx], 1_000_000);
    ctx.embedder = { model: "changed-by-hand" };
    await refreshContextEmbeddersIfStale([ctx], 1_031_000);
    expect(ctx.embedder.model).not.toBe("changed-by-hand");
  });
});
```

Note these tests call the real `hydrateContextEmbedders` (no injected deps), so give the describe block its own mock of `resolveContextEmbedder` — or export the refresh with the same optional-deps parameter as `hydrateContextEmbedders` and inject, whichever reads cleaner once you see the file. Either is acceptable; a test that cannot control the resolve is not.

Then call it from the two async entry points in `src/exulu/context.ts` — at the top of `public search` (`:395`) and of `embeddings.generate.one` (`:1001`) — passing the app's contexts via `exuluApp.get().contexts()` inside a try/catch that no-ops when the singleton is unavailable. Read how neighbouring code reaches the context list before writing this; if no such accessor exists, skip the call sites, say so in your report, and leave boot-time plus in-process hydration as the only paths — do not invent an accessor.

- [ ] **Step 6: Wire it into boot**

In `src/postgres/init-exulu-db.ts`, import at the top:

```ts
import { hydrateContextEmbedders } from "@SRC/exulu/hydrate-embedders";
```

and insert immediately **before** `await contextDatabases(contexts);`:

```ts
  // Apply stored embedder overrides before context tables are touched: a
  // context whose embedder exists only as an override must already have it
  // when contextDatabases decides whether to create its chunks table.
  // platform_configurations is created by the core-schema loop above, so
  // this is the earliest point the setting can be read.
  await hydrateContextEmbedders(contexts);
```

- [ ] **Step 7: Verify and commit**

Run: `npx jest src/exulu/` and `npx tsc --noEmit 2>&1 | grep -c "error TS"` — expect 9.

```bash
git add src/exulu/hydrate-embedders.ts src/exulu/hydrate-embedders.test.ts \
        src/postgres/init-exulu-db.ts src/exulu/context.ts
git commit -m "feat(contexts): hydrate stored embedder overrides onto contexts at boot

context.embedder stays the synchronous source of truth for its 30 read
sites; the override is resolved once and assigned. Runs before
contextDatabases so a context configured only by override still gets its
chunks table. A stored model missing from the catalogue is refused with a
loud log rather than assigned — assigning it would make createChunksTable
throw and the application fail to start.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The rebuild orchestration

**Files:**
- Create: `src/exulu/embedder-change.ts`
- Create: `src/exulu/embedder-change.test.ts`

**Interfaces:**
- Consumes: `setEmbedderSetting`, `clearEmbedderSetting` (Task 1); `hydrateContextEmbedders` (Task 2); `getEmbeddingModelInfo`.
- Produces — Task 4 consumes:

```ts
export type RebuildCase = "create" | "truncate" | "recreate" | "cleared";
export type ChangeEmbedderDeps = {
  /** vector(n) dimension of the existing chunks column, or null when the table is absent/unreadable. */
  currentDimensionality: (contextId: string) => Promise<number | null>;
  modelInfo: (model: string) => { dimensionality: number };
  chunksTableExists: (context: ExuluContext) => Promise<boolean>;
  dropChunksTable: (context: ExuluContext) => Promise<void>;
  createChunksTable: (context: ExuluContext) => Promise<void>;
  deleteAllChunks: (context: ExuluContext) => Promise<void>;
  persist: (contextId: string, model: string | null, queue: string | null) => Promise<void>;
  hydrate: (contexts: ExuluContext[]) => Promise<void>;
  queueRegeneration: (context: ExuluContext) => Promise<{ jobs: string[]; items: number }>;
};
export const decideRebuildCase: (
  existing: number | null,
  next: number,
  tableExists: boolean,
) => RebuildCase;
export const changeContextEmbedder: (
  context: ExuluContext,
  model: string | null,
  queue: string | null,
  deps: ChangeEmbedderDeps,
) => Promise<{ case: RebuildCase; items: number; jobs: string[] }>;
```

- [ ] **Step 1: Write the failing tests**

Create `src/exulu/embedder-change.test.ts`:

```ts
import { changeContextEmbedder, decideRebuildCase } from "./embedder-change";

describe("decideRebuildCase", () => {
  it("creates when the chunks table does not exist yet", () => {
    expect(decideRebuildCase(null, 1024, false)).toBe("create");
  });

  it("truncates when the table exists at the same dimensionality", () => {
    expect(decideRebuildCase(1024, 1024, true)).toBe("truncate");
  });

  it("recreates when the dimensionality differs", () => {
    expect(decideRebuildCase(1536, 3072, true)).toBe("recreate");
  });

  it("recreates when the existing dimensionality cannot be determined", () => {
    // Rebuilding unnecessarily costs time; skipping a needed rebuild leaves a
    // column that rejects every insert. Bias to the safe side.
    expect(decideRebuildCase(null, 1024, true)).toBe("recreate");
  });
});

describe("changeContextEmbedder", () => {
  const ctx = { id: "docs" } as any;

  const deps = (over: Partial<Parameters<typeof changeContextEmbedder>[3]> = {}) => ({
    currentDimensionality: jest.fn(async () => 1024),
    modelInfo: jest.fn(() => ({ dimensionality: 1024 })),
    chunksTableExists: jest.fn(async () => true),
    dropChunksTable: jest.fn(async () => {}),
    createChunksTable: jest.fn(async () => {}),
    deleteAllChunks: jest.fn(async () => {}),
    persist: jest.fn(async () => {}),
    hydrate: jest.fn(async () => {}),
    queueRegeneration: jest.fn(async () => ({ jobs: ["j1"], items: 7 })),
    ...over,
  });

  it("validates the model BEFORE touching anything", async () => {
    const d = deps({
      modelInfo: jest.fn(() => {
        throw new Error("Embedding model \"nope\" was not found");
      }),
    });
    await expect(changeContextEmbedder(ctx, "nope", null, d)).rejects.toThrow("was not found");
    expect(d.deleteAllChunks).not.toHaveBeenCalled();
    expect(d.dropChunksTable).not.toHaveBeenCalled();
    expect(d.persist).not.toHaveBeenCalled();
  });

  it("create: builds the table, persists, hydrates, then queues regeneration", async () => {
    const d = deps({ chunksTableExists: jest.fn(async () => false), currentDimensionality: jest.fn(async () => null) });
    const result = await changeContextEmbedder(ctx, "m", null, d);
    expect(result.case).toBe("create");
    expect(d.createChunksTable).toHaveBeenCalled();
    expect(d.dropChunksTable).not.toHaveBeenCalled();
    expect(d.deleteAllChunks).not.toHaveBeenCalled();
    expect(result.items).toBe(7);
  });

  it("truncate: empties the table without dropping it", async () => {
    const d = deps();
    const result = await changeContextEmbedder(ctx, "m", null, d);
    expect(result.case).toBe("truncate");
    expect(d.deleteAllChunks).toHaveBeenCalled();
    expect(d.dropChunksTable).not.toHaveBeenCalled();
    expect(d.createChunksTable).not.toHaveBeenCalled();
  });

  it("recreate: drops and rebuilds when the dimensionality differs", async () => {
    const d = deps({ modelInfo: jest.fn(() => ({ dimensionality: 3072 })) });
    const result = await changeContextEmbedder(ctx, "m", null, d);
    expect(result.case).toBe("recreate");
    expect(d.dropChunksTable).toHaveBeenCalled();
    expect(d.createChunksTable).toHaveBeenCalled();
  });

  it("PERSISTS ONLY AFTER the DDL succeeds", async () => {
    // If the rebuild fails, the stored setting must still name the old model
    // so the context keeps working instead of pointing at a missing column.
    const order: string[] = [];
    const d = deps({
      modelInfo: jest.fn(() => ({ dimensionality: 3072 })),
      dropChunksTable: jest.fn(async () => {
        order.push("drop");
      }),
      createChunksTable: jest.fn(async () => {
        order.push("create");
      }),
      persist: jest.fn(async () => {
        order.push("persist");
      }),
    });
    await changeContextEmbedder(ctx, "m", null, d);
    expect(order).toEqual(["drop", "create", "persist"]);
  });

  it("does not persist when the DDL throws", async () => {
    const d = deps({
      modelInfo: jest.fn(() => ({ dimensionality: 3072 })),
      createChunksTable: jest.fn(async () => {
        throw new Error("disk full");
      }),
    });
    await expect(changeContextEmbedder(ctx, "m", null, d)).rejects.toThrow("disk full");
    expect(d.persist).not.toHaveBeenCalled();
  });

  it("clearing (model null) drops the table and clears the setting", async () => {
    const d = deps();
    const result = await changeContextEmbedder(ctx, null, null, d);
    expect(result.case).toBe("cleared");
    expect(d.dropChunksTable).toHaveBeenCalled();
    expect(d.createChunksTable).not.toHaveBeenCalled();
    expect(d.persist).toHaveBeenCalledWith("docs", null, null);
    expect(d.queueRegeneration).not.toHaveBeenCalled();
  });

  it("is idempotent about a table a concurrent change already dropped", async () => {
    // Two admins changing the same context: the loser must not error on a
    // drop that already happened.
    const d = deps({
      chunksTableExists: jest.fn(async () => false),
      currentDimensionality: jest.fn(async () => null),
      modelInfo: jest.fn(() => ({ dimensionality: 3072 })),
    });
    await expect(changeContextEmbedder(ctx, "m", null, d)).resolves.toBeTruthy();
    expect(d.dropChunksTable).not.toHaveBeenCalled();
    expect(d.createChunksTable).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/embedder-change.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/exulu/embedder-change.ts`:

```ts
/**
 * Changing a context's embedder, as one orchestrated operation.
 *
 * The chunks table bakes the vector dimension into its column
 * (`vector(n)`, context.ts:1319), so a model with a different dimensionality
 * needs the table rebuilt, not just emptied. A model change ALWAYS needs
 * regeneration, even at identical dimensions — vectors from a different
 * model occupy a different space.
 *
 * Built from injected deps so the decision table and the ordering are
 * testable without a database.
 *
 * Design doc: docs/superpowers/specs/2026-09-30-context-embedder-settings-design.md §3
 */
import type { ExuluContext } from "./context";

export type RebuildCase = "create" | "truncate" | "recreate" | "cleared";

export type ChangeEmbedderDeps = {
  currentDimensionality: (contextId: string) => Promise<number | null>;
  modelInfo: (model: string) => { dimensionality: number };
  chunksTableExists: (context: ExuluContext) => Promise<boolean>;
  dropChunksTable: (context: ExuluContext) => Promise<void>;
  createChunksTable: (context: ExuluContext) => Promise<void>;
  deleteAllChunks: (context: ExuluContext) => Promise<void>;
  persist: (contextId: string, model: string | null, queue: string | null) => Promise<void>;
  hydrate: (contexts: ExuluContext[]) => Promise<void>;
  queueRegeneration: (context: ExuluContext) => Promise<{ jobs: string[]; items: number }>;
};

/**
 * `existing` is the dimension actually found on the column, not the one the
 * previously-configured model claims — that model may since have been removed
 * from config.litellm.yaml. Unknown means rebuild: rebuilding when we did not
 * need to costs time, while skipping a needed rebuild leaves a column that
 * rejects every insert.
 */
export const decideRebuildCase = (
  existing: number | null,
  next: number,
  tableExists: boolean,
): RebuildCase => {
  if (!tableExists) return "create";
  if (existing === null) return "recreate";
  return existing === next ? "truncate" : "recreate";
};

export const changeContextEmbedder = async (
  context: ExuluContext,
  model: string | null,
  queue: string | null,
  deps: ChangeEmbedderDeps,
): Promise<{ case: RebuildCase; items: number; jobs: string[] }> => {
  const tableExists = await deps.chunksTableExists(context);

  // Clearing the override: the context may end up with no embedder at all, so
  // its chunks cannot be regenerated and the table has no valid shape.
  if (!model) {
    if (tableExists) await deps.dropChunksTable(context);
    await deps.persist(context.id, null, null);
    await deps.hydrate([context]);
    return { case: "cleared", items: 0, jobs: [] };
  }

  // Validate first — this throws with an actionable message naming the exact
  // config.litellm.yaml entry to add, and nothing has been touched yet.
  const { dimensionality } = deps.modelInfo(model);

  const existing = await deps.currentDimensionality(context.id);
  const rebuild = decideRebuildCase(existing, dimensionality, tableExists);

  // Destructive work. Ordered so that a failure here leaves the persisted
  // setting untouched and the context still on its previous embedder.
  if (rebuild === "recreate") {
    if (tableExists) await deps.dropChunksTable(context);
    await deps.createChunksTable(context);
  } else if (rebuild === "create") {
    await deps.createChunksTable(context);
  } else {
    await deps.deleteAllChunks(context);
  }

  await deps.persist(context.id, model, queue);
  await deps.hydrate([context]);

  const { jobs, items } = await deps.queueRegeneration(context);
  return { case: rebuild, items, jobs };
};
```

Note the `recreate` branch calls `createChunksTable` **after** hydration would have run in production — but hydration happens after persist. `createChunksTable` reads `context.embedder.model` for its dimensionality, so the caller in Task 4 assigns `context.embedder = { model, queue }` *before* invoking this function. That assignment is the caller's job and is stated in Task 4's step.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/exulu/embedder-change.test.ts`
Expected: PASS, all ten.

- [ ] **Step 5: Commit**

```bash
git add src/exulu/embedder-change.ts src/exulu/embedder-change.test.ts
git commit -m "feat(contexts): orchestrate an embedder change as one operation

Validates the model before touching anything, picks create/truncate/recreate
from the dimension actually on the column, and persists only after the DDL
succeeds so a failed rebuild leaves the context on its previous embedder.
Regeneration always runs; table surgery only when the dimension differs.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: GraphQL surface

**Files:**
- Create: `src/exulu/chunks-dimensionality.ts`
- Create: `src/exulu/chunks-dimensionality.test.ts`
- Modify: `src/graphql/schemas/index.ts` (type + query + mutation defs, beside the entity-model ones at `:403`, `:425`, `:572`)
- Modify: `src/graphql/resolvers/index.ts` (query, beside `${tableNameSingular}EntityModel` at `:380`)
- Modify: `src/graphql/mutations/index.ts` (mutation, beside `${tableNameSingular}SetEntityModel` at `:1231`)

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: GraphQL operations Task 6 consumes —
  - `${tableNameSingular}EmbedderInfo: ${tableNameSingular}ContextEmbedderInfo`
  - `${tableNameSingular}SetEmbedder(model: String, queue: String): ${tableNameSingular}SetEmbedderPayload`
  - `availableEmbeddingModels: [EmbeddingModelOption!]!`
  - `availableEmbedderQueues: [AvailableQueue!]!` (reuses the existing `AvailableQueue` type if one is already declared — `grep -n "type AvailableQueue" src/graphql/schemas/index.ts` first and reuse rather than redeclare)

- [ ] **Step 1: Write the failing test for the dimensionality reader**

Create `src/exulu/chunks-dimensionality.test.ts`:

```ts
import { parseVectorDimensionality } from "./chunks-dimensionality";

describe("parseVectorDimensionality", () => {
  it("reads the dimension out of a pgvector column type", () => {
    expect(parseVectorDimensionality("vector(1536)")).toBe(1536);
  });

  it("handles whitespace", () => {
    expect(parseVectorDimensionality("vector( 3072 )")).toBe(3072);
  });

  it("returns null for a non-vector type", () => {
    expect(parseVectorDimensionality("text")).toBeNull();
  });

  it("returns null for an unsized vector", () => {
    expect(parseVectorDimensionality("vector")).toBeNull();
  });

  it("returns null for null/empty input (column or table absent)", () => {
    expect(parseVectorDimensionality(null)).toBeNull();
    expect(parseVectorDimensionality("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/exulu/chunks-dimensionality.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the dimensionality reader**

Create `src/exulu/chunks-dimensionality.ts`:

```ts
/**
 * The dimension actually stored on a chunks table's `embedding` column.
 *
 * Read from the database rather than inferred from the configured model:
 * that model may since have been removed from config.litellm.yaml, and we
 * still need to classify the change correctly.
 *
 * format_type() is used instead of raw atttypmod so the value is
 * self-describing ("vector(1536)") and the parsing is testable.
 */
import { postgresClient } from "@SRC/postgres/client";
import { getChunksTableName } from "@SRC/exulu/context";

export const parseVectorDimensionality = (formatted: string | null): number | null => {
  if (!formatted) return null;
  const match = /^vector\(\s*(\d+)\s*\)$/.exec(formatted.trim());
  return match ? Number(match[1]) : null;
};

export const currentChunksDimensionality = async (
  contextId: string,
): Promise<number | null> => {
  try {
    const { db } = await postgresClient();
    const result = await db.raw(
      `SELECT format_type(a.atttypid, a.atttypmod) AS type
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = ?
          AND a.attname = 'embedding'
          AND a.attnum > 0
          AND NOT a.attisdropped`,
      [getChunksTableName(contextId)],
    );
    return parseVectorDimensionality(result?.rows?.[0]?.type ?? null);
  } catch (err) {
    console.warn(
      `[EXULU] Could not read the chunk vector dimensionality for "${contextId}":`,
      (err as Error).message,
    );
    return null;
  }
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest src/exulu/chunks-dimensionality.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the schema definitions**

In `src/graphql/schemas/index.ts`, beside the entity-model equivalents:

At the query defs (near `:403`):
```
      ${tableNameSingular}EmbedderInfo: ${tableNameSingular}ContextEmbedderInfo
```

At the mutation defs (near `:425`):
```
    ${tableNameSingular}SetEmbedder(model: String, queue: String): ${tableNameSingular}SetEmbedderPayload
```

At the model defs (near `:572`, next to `${tableNameSingular}EntityModelInfo`):
```
    type ${tableNameSingular}ContextEmbedderInfo {
        effectiveModel: String
        source: String
        databaseModel: String
        codeModel: String
        databaseQueue: String
        dimensionality: Int
        chunkCount: Int
    }

    type ${tableNameSingular}SetEmbedderPayload {
        info: ${tableNameSingular}ContextEmbedderInfo!
        rebuild: String!
        itemsQueued: Int!
    }
```

And once globally (not per context), beside the other shared types:
```
    type EmbeddingModelOption {
      model: String!
      dimensionality: Int!
      maxChunkSize: Int!
      maxBatchSize: Int!
    }
```
plus the top-level query `availableEmbeddingModels: [EmbeddingModelOption!]!`. For queues, `grep -n "AvailableQueue" src/graphql/schemas/index.ts` and reuse the existing type and query if present; only add `availableEmbedderQueues` if no equivalent already exists.

- [ ] **Step 6: Implement the query resolver**

In `src/graphql/resolvers/index.ts`, beside `${tableNameSingular}EntityModel` (`:380`):

```ts
    queries[`${tableNameSingular}EmbedderInfo`] = async (_, _args, _context) => {
      const ctx = contexts.find((c) => c.id === table.id);
      if (!ctx) {
        throw new Error(`Context ${table.id} not found.`);
      }
      const info = await resolveContextEmbedder(ctx);

      // A stale model must not break the very query whose job is to report
      // that it is stale — that would leave the admin unable to see, let
      // alone fix, the misconfiguration.
      let dimensionality: number | null = null;
      if (info.effectiveModel) {
        try {
          dimensionality = getEmbeddingModelInfo(info.effectiveModel).dimensionality;
        } catch {
          dimensionality = null;
        }
      }

      let chunkCount = 0;
      try {
        const { db } = await postgresClient();
        const [row] = await db.from(getChunksTableName(ctx.id)).count({ count: "*" });
        chunkCount = Number(row?.count ?? 0);
      } catch {
        // No chunks table yet — the common case for a context being
        // configured for the first time.
        chunkCount = 0;
      }

      return { ...info, dimensionality, chunkCount };
    };
```

And once, not per context, register the catalogue query:

```ts
    queries["availableEmbeddingModels"] = async () => {
      try {
        return parseEmbeddingModels(resolveLiteLLMConfigPath());
      } catch (err) {
        console.warn("[EXULU] Could not read embedding models:", (err as Error).message);
        return [];
      }
    };
```

`parseEmbeddingModels` returns `{ model_name, dimensionality, maxChunkSize, maxBatchSize }`, but the GraphQL type declares the field as `model`. Map it (`model: m.model_name`) rather than renaming either side.

- [ ] **Step 7: Implement the mutation resolver**

In `src/graphql/mutations/index.ts`, beside `${tableNameSingular}SetEntityModel` (`:1231`), following its exact shape for context lookup and the auth check:

```ts
    mutations[`${tableNameSingular}SetEmbedder`] = async (_, args, context) => {
      const ctx = contexts.find((c) => c.id === table.id);
      if (!ctx) {
        throw new Error(`Context ${table.id} not found.`);
      }
      if (!context.user) {
        throw new Error("Authentication required to set the embedding model.");
      }

      const model = args.model?.trim() || null;
      const queue = args.queue?.trim() || null;

      // createChunksTable reads context.embedder.model for its dimensionality,
      // so the instance must already carry the new model before the rebuild.
      // hydrate() inside changeContextEmbedder re-derives it from the
      // persisted value afterwards, so this assignment is only a bridge.
      const previous = ctx.embedder;
      if (model) ctx.embedder = { model, queue: previous?.queue };

      try {
        const result = await changeContextEmbedder(ctx, model, queue, {
          currentDimensionality: currentChunksDimensionality,
          modelInfo: getEmbeddingModelInfo,
          chunksTableExists: (c) => c.chunksTableExists(),
          dropChunksTable: async (c) => {
            const { db } = await postgresClient();
            await db.schema.dropTableIfExists(getChunksTableName(c.id));
          },
          createChunksTable: (c) => c.createChunksTable(),
          deleteAllChunks: async (c) => {
            const { db } = await postgresClient();
            await db.from(getChunksTableName(c.id)).delete();
          },
          persist: async (id, m, q) =>
            m ? setEmbedderSetting(id, m, q) : clearEmbedderSetting(id),
          hydrate: (cs) => hydrateContextEmbedders(cs),
          queueRegeneration: (c) => c.embeddings.generate.all(config),
        });
        return {
          info: await resolveContextEmbedder(ctx),
          rebuild: result.case,
          itemsQueued: result.items,
        };
      } catch (err) {
        // The rebuild failed; put the instance back so this replica keeps
        // serving on the previous embedder (the setting was never persisted).
        ctx.embedder = previous;
        throw err;
      }
    };
```

Resolve `config` the same way neighbouring mutations in this file do — read one nearby before writing this.

- [ ] **Step 8: Verify and commit**

Run: `npx jest src/exulu/` then `npx tsc --noEmit 2>&1 | grep -c "error TS"` — expect 9.

```bash
git add src/exulu/chunks-dimensionality.ts src/exulu/chunks-dimensionality.test.ts \
        src/graphql/schemas/index.ts src/graphql/resolvers/index.ts src/graphql/mutations/index.ts
git commit -m "feat(contexts): GraphQL surface for reading and changing a context embedder

Per-context EmbedderInfo and SetEmbedder alongside the entity-model pair,
plus availableEmbeddingModels from the LiteLLM catalogue. The mutation
restores the previous in-memory embedder if the rebuild throws, matching the
persist-after-DDL rule.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: One honest failure for an unconfigured context

**Files:**
- Create: `src/exulu/embedder-not-configured.ts`
- Create: `src/exulu/embedder-not-configured.test.ts`
- Modify: `src/graphql/resolvers/vector-search.ts:155`
- Modify: `ee/agentic-retrieval/pipeline/search.ts:186`
- Modify: `src/templates/tools/session-items-retrieval-tool.ts`

**Interfaces:**
- Produces: `ContextEmbedderNotConfiguredError` (class, with `contextId`) and `embedderNotConfiguredMessage(contextId: string): string`.

- [ ] **Step 1: Write the failing tests**

Create `src/exulu/embedder-not-configured.test.ts`:

```ts
import {
  ContextEmbedderNotConfiguredError,
  embedderNotConfiguredMessage,
  isEmbedderNotConfigured,
} from "./embedder-not-configured";

describe("ContextEmbedderNotConfiguredError", () => {
  it("names the context and says what to do about it", () => {
    const message = embedderNotConfiguredMessage("transcriptions");
    expect(message).toContain("transcriptions");
    expect(message.toLowerCase()).toContain("embedding model");
    // Actionable: it must point at where to fix it, not just state a fact.
    expect(message.toLowerCase()).toMatch(/configure|settings|admin/);
  });

  it("carries the context id for callers that branch on it", () => {
    const err = new ContextEmbedderNotConfiguredError("docs");
    expect(err.contextId).toBe("docs");
    expect(err).toBeInstanceOf(Error);
  });

  it("is recognisable after crossing an async boundary", () => {
    // searchContexts catches everything; it must be able to tell this apart
    // from a transport failure without string-matching.
    expect(isEmbedderNotConfigured(new ContextEmbedderNotConfiguredError("docs"))).toBe(true);
    expect(isEmbedderNotConfigured(new Error("connection reset"))).toBe(false);
    expect(isEmbedderNotConfigured(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest src/exulu/embedder-not-configured.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/exulu/embedder-not-configured.ts`:

```ts
/**
 * The one error a context without an embedder produces.
 *
 * Before this, the same misconfiguration failed three different ways: a raw
 * throw from vectorSearch, a silent empty result from the agentic pipeline,
 * and an unhandled tool error from the session-items tool. A permanent
 * misconfiguration that nobody is told about is the worst of those.
 */
export const embedderNotConfiguredMessage = (contextId: string): string =>
  `The knowledge base "${contextId}" has no embedding model configured, so it cannot be ` +
  `searched. An admin can configure one in its pipeline settings.`;

export class ContextEmbedderNotConfiguredError extends Error {
  public readonly contextId: string;
  constructor(contextId: string) {
    super(embedderNotConfiguredMessage(contextId));
    this.name = "ContextEmbedderNotConfiguredError";
    this.contextId = contextId;
  }
}

/** Structural check — survives module duplication and async boundaries. */
export const isEmbedderNotConfigured = (
  err: unknown,
): err is ContextEmbedderNotConfiguredError =>
  !!err && (err as Error).name === "ContextEmbedderNotConfiguredError";
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx jest src/exulu/embedder-not-configured.test.ts`
Expected: PASS.

- [ ] **Step 5: Use it at the three call sites**

In `src/graphql/resolvers/vector-search.ts:155`, replace the bare throw:

```ts
  if (!embedder) {
    throw new ContextEmbedderNotConfiguredError(id);
  }
```

In `ee/agentic-retrieval/pipeline/search.ts:186`, keep catching — one misconfigured context must not break a multi-context search — but distinguish it:

```ts
      } catch (err) {
        if (isEmbedderNotConfigured(err)) {
          console.warn(
            `[EXULU pipeline] context "${ctxId}" is not searchable: ${(err as Error).message}`,
          );
        } else {
          console.warn(`[EXULU pipeline] searchContexts failed for context "${ctxId}":`, err);
        }
        return [];
      }
```

In `src/templates/tools/session-items-retrieval-tool.ts`, wrap the per-context `context.search(...)` call in a `try/catch` that returns the message as the tool's result for that context instead of throwing, so the model can tell the user knowledge was unavailable rather than the tool call erroring. Read the surrounding `Promise.all(...)` block first and keep its shape.

- [ ] **Step 6: Verify and commit**

Run: `npx jest` — expect the 4 pre-existing failed suites / 12 failed tests, nothing new. `npx tsc --noEmit 2>&1 | grep -c "error TS"` — expect 9.

```bash
git add src/exulu/embedder-not-configured.ts src/exulu/embedder-not-configured.test.ts \
        src/graphql/resolvers/vector-search.ts ee/agentic-retrieval/pipeline/search.ts \
        src/templates/tools/session-items-retrieval-tool.ts
git commit -m "fix(contexts): one actionable error when a context has no embedder

Replaces a raw throw, a silent empty result and an unhandled tool error with
a single named error that says which knowledge base is unconfigured and who
can fix it. The agentic pipeline still catches per context — one
misconfiguration must not break a multi-context search — but logs it
distinctly instead of folding it in with transport failures.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Frontend data layer

**Files (frontend worktree — create it in Step 1):**
- Modify: `app/(application)/data/queries.ts`
- Modify: `app/(application)/data/hooks.ts`

**Interfaces:**
- Consumes: the GraphQL operations from Task 4.
- Produces: `GET_EMBEDDER_INFO(context)`, `SET_EMBEDDER(context)`, `GET_AVAILABLE_EMBEDDING_MODELS`, and a `useEmbedderSettings(contextId)` hook returning `{ info, models, queues, loading, error, setEmbedder }`. Task 7 consumes these.

- [ ] **Step 1: Create the frontend worktree**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend
git worktree add -b feat/context-embedder-settings ../frontend-context-embedder main
cp -al node_modules ../frontend-context-embedder/node_modules
```

`cp -al` hard-links rather than symlinks — Turbopack's build breaks on a symlinked `node_modules`. Verify with `ls ../frontend-context-embedder/node_modules | wc -l` (expect >1000).

Measure the frontend baseline before changing anything: `npx vitest run`, `npx eslint .`. Record both numbers.

- [ ] **Step 2: Add the operations**

Append to `app/(application)/data/queries.ts`, following the existing per-context factory style (`GET_ITEMS`, `GENERATE_CHUNKS` at `:403` — read them first and match):

```ts
export const GET_EMBEDDER_INFO = (context: string) => gql`
  query EmbedderInfo${context} {
    ${context}_itemsEmbedderInfo {
      effectiveModel
      source
      databaseModel
      codeModel
      databaseQueue
      dimensionality
      chunkCount
    }
  }
`;

export const SET_EMBEDDER = (context: string) => gql`
  mutation SetEmbedder${context}($model: String, $queue: String) {
    ${context}_itemsSetEmbedder(model: $model, queue: $queue) {
      info {
        effectiveModel
        source
        databaseModel
        codeModel
        databaseQueue
        dimensionality
        chunkCount
      }
      rebuild
      itemsQueued
    }
  }
`;

export const GET_AVAILABLE_EMBEDDING_MODELS = gql`
  query AvailableEmbeddingModels {
    availableEmbeddingModels {
      model
      dimensionality
      maxChunkSize
      maxBatchSize
    }
  }
`;
```

**The field names above are verified, not guessed.** For a context, the generated `tableNameSingular`
is `<ctx>_items` (plural) — confirmed against the shipped entity-model caller, which reads
`modelData?.[\`${context}_itemsEntityModel\`]` at
`app/(application)/data/components/entity-types.tsx:114`. So it is `${context}_itemsEmbedderInfo` and
`${context}_itemsSetEmbedder`, with the `s`. A missing `s` fails only at runtime.

- [ ] **Step 3: Add the hook**

Append to `app/(application)/data/hooks.ts`, following `useContextItems`' structure for fetch policy and error surfacing:

```ts
export interface EmbedderInfo {
  effectiveModel: string | null;
  source: "database" | "code" | null;
  databaseModel: string | null;
  codeModel: string | null;
  databaseQueue: string | null;
  dimensionality: number | null;
  chunkCount: number;
}

export interface EmbeddingModelOption {
  model: string;
  dimensionality: number;
  maxChunkSize: number;
  maxBatchSize: number;
}

export function useEmbedderSettings(contextId: string): {
  info?: EmbedderInfo;
  models: EmbeddingModelOption[];
  loading: boolean;
  error?: Error;
  setEmbedder: (model: string | null, queue: string | null) => Promise<{ rebuild: string; itemsQueued: number }>;
} {
  const infoQuery = useQuery<{ [key: string]: EmbedderInfo }>(GET_EMBEDDER_INFO(contextId), {
    fetchPolicy: "cache-and-network",
  });
  const modelsQuery = useQuery<{ availableEmbeddingModels: EmbeddingModelOption[] }>(
    GET_AVAILABLE_EMBEDDING_MODELS,
  );
  const [mutate] = useMutation(SET_EMBEDDER(contextId));

  return {
    info: Object.values(infoQuery.data ?? {})[0],
    models: modelsQuery.data?.availableEmbeddingModels ?? [],
    loading: infoQuery.loading && !infoQuery.data,
    error: infoQuery.error as Error | undefined,
    setEmbedder: async (model, queue) => {
      const result = await mutate({ variables: { model, queue } });
      await infoQuery.refetch();
      const payload = Object.values(result.data ?? {})[0] as {
        rebuild: string;
        itemsQueued: number;
      };
      return payload;
    },
  };
}
```

**Index by the literal key, not `Object.values(...)[0]`.** The key is known —
`` `${contextId}_itemsEmbedderInfo` `` and `` `${contextId}_itemsSetEmbedder` `` — and that is how the
shipped entity-model caller does it (`entity-types.tsx:114`). Replace the two `Object.values(...)[0]`
reads above with typed index reads before you commit; they are written that way only so the snippet
compiles in isolation.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run`, `npx eslint .`, `npx tsc --noEmit` — all at the baseline you recorded.

```bash
git add "app/(application)/data/queries.ts" "app/(application)/data/hooks.ts"
git commit -m "feat(knowledge): data layer for the per-context embedder setting

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The embedder picker UI

**Files (frontend worktree):**
- Move: `app/(application)/data/[ctx]/components/stage-embedder.tsx` → `components/widgets/stage-embedder.tsx` (use `git mv`)
- Modify: `app/(application)/data/[ctx]/components/pipeline-tab.tsx` (its import)
- Create: `components/widgets/embedder-change-dialog.tsx`
- Modify: `messages/en.json`, `messages/de.json`

**Interfaces:**
- Consumes: `useEmbedderSettings` (Task 6).
- Produces:

```tsx
export interface EmbedderChangeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contextId: string;
  /** Current state, so the dialog can state what will be destroyed. */
  info: { effectiveModel: string | null; dimensionality: number | null; chunkCount: number };
  onConfirmed: () => void;
}
```

- [ ] **Step 1: Promote `StageEmbedder`**

`git mv` it to `components/widgets/` and update the one importer. The move is required, not cosmetic: this repo enforces feature isolation in lint (`no-restricted-imports`, `eslint.config.mjs:125`), and its exemption file states "THIS LIST MAY ONLY SHRINK. Never add entries." A later surface (Transcript settings) must render this same component rather than a copy. `QueuePanel` and `FilePicker` were promoted the same way — see `design/codebase-structure.md:373-374`.

If the moved file trips the widgets tier's own import rules, **report it rather than adding a tier exemption**; the fix is to invert the dependency (pass what it needs as props), exactly as `BulkAccessDialog` did when it was promoted.

- [ ] **Step 2: Add the Not-configured state**

When `info.effectiveModel` is null, `StageEmbedder` renders as **Not configured**: an explanatory line that search and Ask do not work for this knowledge base until a model is chosen, with the picker as the card's primary action. This is the state `transcriptions` is in today.

- [ ] **Step 3: Add the Change action and the dialog**

A "Change" action on the card opens `EmbedderChangeDialog`: a model select (from `availableEmbeddingModels`, each option showing its dimensionality), an optional queue select, and — before the confirm button — a plain statement of consequences derived from the current state:

- which model and dimensionality is being set;
- whether the table is **rebuilt** (dimensionality differs, or no table yet) or **emptied** (same dimensionality);
- **how many chunks will be deleted** (`info.chunkCount`) and that every item must be re-embedded;
- that search over this knowledge base returns nothing until regeneration finishes;
- when no queue is selected: that embedding runs inline and will slow saves on large items.

Destructive confirmation goes through the shared `ConfirmDialog`. Clearing back to the code default uses the same warning text.

- [ ] **Step 4: Test the consequence derivation**

The dialog's warning text is the only thing standing between an admin and an unintended wipe, so the derivation is a pure function with its own test. Create `components/widgets/embedder-change-summary.ts`:

```ts
export type ChangeSummary = {
  action: "create" | "truncate" | "recreate" | "cleared";
  chunksDeleted: number;
  willRunInline: boolean;
};

export function summariseEmbedderChange(args: {
  nextModel: string | null;
  nextDimensionality: number | null;
  currentDimensionality: number | null;
  chunkCount: number;
  queue: string | null;
}): ChangeSummary {
  const { nextModel, nextDimensionality, currentDimensionality, chunkCount, queue } = args;
  if (!nextModel) return { action: "cleared", chunksDeleted: chunkCount, willRunInline: false };
  const action =
    chunkCount === 0 && currentDimensionality === null
      ? "create"
      : currentDimensionality !== null && currentDimensionality === nextDimensionality
        ? "truncate"
        : "recreate";
  return { action, chunksDeleted: chunkCount, willRunInline: !queue };
}
```

and `components/widgets/embedder-change-summary.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { summariseEmbedderChange } from "./embedder-change-summary";

const base = {
  nextModel: "m",
  nextDimensionality: 1024,
  currentDimensionality: 1024,
  chunkCount: 500,
  queue: "embeddings",
};

describe("summariseEmbedderChange", () => {
  it("creates when nothing exists yet", () => {
    expect(
      summariseEmbedderChange({ ...base, currentDimensionality: null, chunkCount: 0 }).action,
    ).toBe("create");
  });

  it("truncates at the same dimensionality", () => {
    expect(summariseEmbedderChange(base).action).toBe("truncate");
  });

  it("recreates at a different dimensionality", () => {
    expect(summariseEmbedderChange({ ...base, nextDimensionality: 3072 }).action).toBe("recreate");
  });

  it("always reports how many chunks are destroyed", () => {
    // The number is the whole point of the warning.
    expect(summariseEmbedderChange(base).chunksDeleted).toBe(500);
  });

  it("warns about inline embedding only when no queue is chosen", () => {
    expect(summariseEmbedderChange({ ...base, queue: null }).willRunInline).toBe(true);
    expect(summariseEmbedderChange(base).willRunInline).toBe(false);
  });

  it("treats clearing as its own action", () => {
    const summary = summariseEmbedderChange({ ...base, nextModel: null });
    expect(summary.action).toBe("cleared");
    expect(summary.chunksDeleted).toBe(500);
  });
});
```

Run `npx vitest run components/widgets/embedder-change-summary.test.ts` — write the test first and watch it fail.

- [ ] **Step 5: i18n**

Add every new key to BOTH `messages/en.json` and `messages/de.json`. Run `node scripts/check-messages.js` — it must report no missing keys. Note it checks *parity between locales*, not that keys the code calls exist, so also grep each new key to confirm it is spelled identically in code and JSON.

- [ ] **Step 6: Verify**

Run: `npx vitest run`, `npx eslint .`, `node scripts/check-messages.js`, `npx tsc --noEmit`, `npx next build` — all at the recorded baseline; the build must succeed.

Then by hand against a running backend: open a context with an embedder and confirm the card is unchanged; open `/data/transcriptions` and confirm Not-configured; set a model and confirm the chunks table appears and regeneration jobs queue.

- [ ] **Step 7: Commit**

```bash
git add components/widgets/stage-embedder.tsx components/widgets/embedder-change-dialog.tsx \
        components/widgets/embedder-change-summary.ts components/widgets/embedder-change-summary.test.ts \
        "app/(application)/data/[ctx]/components/pipeline-tab.tsx" messages/en.json messages/de.json
git commit -m "feat(knowledge): choose a context's embedder from the pipeline tab

Promotes StageEmbedder to the shared widgets tier so a second surface renders
the same component rather than a copy, adds the Not-configured state, and
states plainly what a change destroys before it runs.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Whole-branch verification

**Files:** none — this task runs things and reports.

- [ ] **Step 1: Backend**

In `../backend-context-embedder`: `npx tsc --noEmit`, `npm run lint`, `npx jest`. Compare against 9 tsc errors and 4 failed suites / 12 failed tests, allowing one structural lint error per new `.test.ts` file. Any other increase is a regression to fix before this task passes.

- [ ] **Step 2: Frontend**

In `../frontend-context-embedder`: `npx vitest run`, `npx eslint .`, `node scripts/check-messages.js`, `npx tsc --noEmit`, `npx next build`. Compare against the baseline recorded in Task 6 Step 1.

- [ ] **Step 3: End-to-end by hand**

Deploy backend before frontend. Then, on a live deployment:
1. Configure `transcriptions` with an embedding model. Confirm the chunks table is created and regeneration runs.
2. **Confirm "Ask about this transcript" now returns grounded answers in BOTH retrieval paths** — an agent with Transcriptions in its knowledge config (agentic pipeline), and an agent without it, where the transcript is attached as a session item. These are different code paths and only one is exercised by the other.
3. Change an existing context's embedder to one with a **different dimensionality**; confirm the table is rebuilt and search works after regeneration.
4. Change one to a model with the **same dimensionality**; confirm the table is emptied, not rebuilt.
5. Restart the app and confirm the override survives and no boot error appears.
6. Point a stored override at a model, remove that model from `config.litellm.yaml`, restart, and **confirm the app still starts** with the fallback logged.

- [ ] **Step 4: Report**

Write the outcome — what passed, what failed, what was deferred — before requesting review.

## Notes for the executor

- **Two repos, one branch name.** Check `pwd` and `git branch --show-current` in the same command as any commit. Never commit from `../backend` or `../frontend`.
- **The backend is a library** (`@exulu/backend`) with no standalone server, so backend changes are only smoke-testable through a consuming project — rebuild `dist` and restart that server.
- **Do not add entries to `eslint.tier-exemptions.mjs`.** That list may only shrink. If something trips a tier rule, report it.
