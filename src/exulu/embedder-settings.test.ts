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
