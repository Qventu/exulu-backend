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

  it("takes the create path, without attempting a drop, when the chunks table is absent", async () => {
    const d = deps({
      chunksTableExists: jest.fn(async () => false),
      currentDimensionality: jest.fn(async () => null),
      modelInfo: jest.fn(() => ({ dimensionality: 3072 })),
    });
    const result = await changeContextEmbedder(ctx, "m", null, d);
    expect(result.case).toBe("create");
    expect(d.dropChunksTable).not.toHaveBeenCalled();
    expect(d.createChunksTable).toHaveBeenCalled();
  });
});
