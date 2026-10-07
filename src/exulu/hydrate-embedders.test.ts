import {
  hydrateContextEmbedders,
  refreshContextEmbeddersIfStale,
  __resetEmbedderRefreshClock,
  captureCodeEmbedder,
  codeEmbedderFor,
  contextEmbedderInfoFor,
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

  it("RESTORES the code default when the override is cleared", async () => {
    // The replica that did not serve the mutation only learns about a cleared
    // override through hydration. If hydration merely skips "no override", it
    // keeps a model whose chunks table has already been dropped.
    const codeQueue = Promise.resolve({ queue: { name: "code-queue" } });
    const ctx = context("docs", { model: "code-model", queue: codeQueue });

    await hydrateContextEmbedders([ctx], deps());
    expect(ctx.embedder.model).toBe("override-model");

    await hydrateContextEmbedders([ctx], deps({
      resolve: async (c: any) => ({
        effectiveModel: c.embedder?.model ?? null,
        source: c.embedder?.model ? ("code" as const) : null,
        databaseModel: null,
        codeModel: c.embedder?.model ?? null,
        databaseQueue: null,
      }),
    }));
    expect(ctx.embedder.model).toBe("code-model");
    expect(await ctx.embedder.queue).toEqual({ queue: { name: "code-queue" } });
  });

  it("UNSETS the embedder when the override is cleared and code declares none", async () => {
    const ctx = context("transcriptions");

    await hydrateContextEmbedders([ctx], deps());
    expect(ctx.embedder.model).toBe("override-model");

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

  it("re-reads the code default from construction, not from the previous hydration", async () => {
    // resolveContextEmbedder derives codeModel from context.embedder, which a
    // previous hydration has already overwritten. Hydration must resolve
    // against what code declared or the override becomes self-perpetuating.
    const ctx = context("docs", { model: "code-model" });
    await hydrateContextEmbedders([ctx], deps());

    const seen: (string | null)[] = [];
    await hydrateContextEmbedders([ctx], deps({
      resolve: async (c: any) => {
        seen.push(c.embedder?.model ?? null);
        return {
          effectiveModel: "override-model",
          source: "database" as const,
          databaseModel: "override-model",
          codeModel: c.embedder?.model ?? null,
          databaseQueue: null,
        };
      },
    }));
    expect(seen).toEqual(["code-model"]);
  });

  it("falls back to the code default when a rejected override is re-hydrated", async () => {
    const ctx = context("docs", { model: "code-model" });
    await hydrateContextEmbedders([ctx], deps());
    expect(ctx.embedder.model).toBe("override-model");

    await hydrateContextEmbedders([ctx], deps({
      modelInfo: () => {
        throw new Error("Embedding model \"override-model\" was not found");
      },
    }));
    expect(ctx.embedder.model).toBe("code-model");
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

describe("captureCodeEmbedder", () => {
  // SetEmbedder bridges ctx.embedder to the incoming value before
  // changeContextEmbedder's hydrate() runs. If nothing captured the
  // constructor embedder before that bridge, hydrate's own (non-capturing)
  // read would freeze the bridged override in as the "code default" forever
  // for a context this process has never hydrated before — exactly the bug
  // the WeakMap was added to fix, reinstated. captureCodeEmbedder exists so
  // the mutation can capture first and make that impossible.

  it("captures the constructor embedder once and ignores later mutations", () => {
    const ctx = context("docs", { model: "constructor-model" });
    expect(captureCodeEmbedder(ctx)).toEqual({ model: "constructor-model" });

    // Simulate the SetEmbedder bridge landing after the capture.
    ctx.embedder = { model: "bridged-override" };
    expect(captureCodeEmbedder(ctx)).toEqual({ model: "constructor-model" });
  });

  it("keeps the constructor embedder through a bridge assignment and a hydration pass", async () => {
    // Reproduces the SetEmbedder ordering on a context that has never been
    // hydrated in this process (like the built-in "transcriptions" context,
    // which declares no code embedder at all).
    const ctx = context("transcriptions");
    captureCodeEmbedder(ctx);
    ctx.embedder = { model: "bridged-override", queue: undefined };

    await hydrateContextEmbedders([ctx], deps());

    expect(codeEmbedderFor(ctx)).toBeUndefined();
  });

  it("keeps a captured undefined code embedder distinguishable from a context that was never captured", () => {
    const captured = context("transcriptions");
    captureCodeEmbedder(captured); // records "no code embedder" explicitly
    captured.embedder = { model: "bridged-later" };
    expect(codeEmbedderFor(captured)).toBeUndefined();

    const neverCaptured = context("other");
    neverCaptured.embedder = { model: "bridged-later" };
    // Nothing has captured this instance yet, so codeEmbedderFor must fall
    // back to the live value rather than assume "no entry" means "none".
    expect(codeEmbedderFor(neverCaptured)).toEqual({ model: "bridged-later" });
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

describe("contextEmbedderInfoFor", () => {
  it("reports the captured code default, not the override hydration assigned", async () => {
    // resolveContextEmbedder derives codeModel from whatever `embedder` the
    // caller hands it. Passing the live context after hydration therefore
    // reports the override as the code default, which is what the settings UI
    // showed: the framework transcripts base declares no embedder in code, yet
    // its EmbedderInfo claimed codeModel "gemini-embedding-001".
    const ctx = context("transcriptions"); // no code-declared embedder
    await hydrateContextEmbedders([ctx], deps());
    expect(ctx.embedder.model).toBe("override-model"); // hydration ran

    const info = await contextEmbedderInfoFor(ctx, { resolve: deps().resolve });
    expect(info.codeModel).toBeNull();
    expect(info.databaseModel).toBe("override-model");
  });

  it("still reports a genuine code default", async () => {
    const ctx = context("docs", { model: "code-model" });
    await hydrateContextEmbedders([ctx], deps());
    const info = await contextEmbedderInfoFor(ctx, { resolve: deps().resolve });
    expect(info.codeModel).toBe("code-model");
  });
});
