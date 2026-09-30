import {
  hydrateContextEmbedders,
  refreshContextEmbeddersIfStale,
  __resetEmbedderRefreshClock,
} from "./hydrate-embedders";

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

describe("refreshContextEmbeddersIfStale", () => {
  // hydrateContextEmbedders defaults to the real resolveContextEmbedder,
  // which hits postgres — not controllable from a unit test. The refresh
  // takes the same optional deps parameter for exactly this reason: inject
  // here rather than mocking module internals for one describe block.
  beforeEach(() => __resetEmbedderRefreshClock());

  it("refreshes on the first call", async () => {
    const ctx = context("docs");
    await refreshContextEmbeddersIfStale([ctx], 1_000_000, deps());
    expect(ctx.embedder?.model).toBeDefined();
  });

  it("skips a call inside the 30s window", async () => {
    const ctx = context("docs");
    await refreshContextEmbeddersIfStale([ctx], 1_000_000, deps());
    ctx.embedder = { model: "changed-by-hand" };
    await refreshContextEmbeddersIfStale([ctx], 1_010_000, deps());
    expect(ctx.embedder.model).toBe("changed-by-hand");
  });

  it("refreshes again once the window has passed", async () => {
    const ctx = context("docs");
    await refreshContextEmbeddersIfStale([ctx], 1_000_000, deps());
    ctx.embedder = { model: "changed-by-hand" };
    await refreshContextEmbeddersIfStale([ctx], 1_031_000, deps());
    expect(ctx.embedder.model).not.toBe("changed-by-hand");
  });
});
