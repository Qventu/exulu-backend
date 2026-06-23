// --- mock must be hoisted before module import ---
const tableExistsResult = { exists: false };

const embedSpy = jest.fn(async (_inputs: string[], _opts?: any) => [[0.1, 0.2, 0.3]]);
const resolveEmbedderSpy = jest.fn(async () => ({
  model: "gemini-embedding-001",
  dimensions: 3,
  maxChunkSize: 1000,
  maxBatchSize: 96,
  embed: embedSpy,
}));
jest.mock("@SRC/exulu/resolve-embedder", () => ({
  resolveEmbedder: (...a: any[]) => resolveEmbedderSpy(...a),
}));

// Spy for applyAccessControl
const acSpy = jest.fn((_table: any, query: any) => query); // pass-through, records call
jest.mock("@SRC/graphql/utilities/access-control", () => ({
  applyAccessControl: (...args: any[]) => acSpy(...args),
}));
jest.mock("@SRC/graphql/utilities/convert-context-to-table-definition", () => ({
  convertContextToTableDefinition: (ctx: any) => ({
    id: ctx.id,
    name: { singular: ctx.id + "_items", plural: ctx.id + "_items" },
    type: "items",
    RBAC: true,
    fields: [],
  }),
}));

// Chainable builder whose terminal `then` resolves to canned rows; records calls.
const builderCalls: Record<string, any[]> = {};
const cannedRows = [{ chunk_id: "c1", item_id: "i1", chunk_content: "hello", chunk_index: 3 }];
const makeBuilder = () => {
  const record = (name: string) =>
    (...args: any[]) => {
      (builderCalls[name] ||= []).push(args);
      return builder;
    };
  const builder: any = {
    select: record("select"),
    leftJoin: record("leftJoin"),
    whereIn: record("whereIn"),
    where: record("where"),
    orderBy: record("orderBy"),
    then: (resolve: (rows: any[]) => void) => resolve(cannedRows),
  };
  return builder;
};
const dbFn: any = jest.fn(() => makeBuilder());
dbFn.raw = jest.fn(async () => ({ rows: [{ exists: tableExistsResult.exists }] }));

jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({ db: dbFn })),
}));

import { ExuluReadApi } from "./read-api";

beforeEach(() => {
  for (const k in builderCalls) delete builderCalls[k];
  dbFn.mockClear();
  acSpy.mockClear();
});

describe("ExuluReadApi table-name resolvers", () => {
  it("derives _items/_chunks names and sanitizes the id", () => {
    expect(ExuluReadApi.getTableName("tech_doc")).toBe("tech_doc_items");
    expect(ExuluReadApi.getChunksTableName("tech_doc")).toBe("tech_doc_chunks");
    // sanitizeName lowercases + replaces spaces with underscores + trims
    expect(ExuluReadApi.getChunksTableName("Tech Doc")).toBe("tech_doc_chunks");
  });

  it("derives entity table names", () => {
    expect(ExuluReadApi.getEntitiesTableName("tech_doc")).toBe("tech_doc_entities");
    expect(ExuluReadApi.getChunkEntitiesTableName("tech_doc")).toBe("tech_doc_chunk_entities");
  });
});

describe("ExuluReadApi.entitiesAvailable", () => {
  beforeEach(() => {
    tableExistsResult.exists = false;
    dbFn.mockClear();
    acSpy.mockClear();
  });

  it("is false when the context declares no entities config", async () => {
    expect(await ExuluReadApi.entitiesAvailable({ id: "tech_doc" })).toBe(false);
    expect(dbFn.raw).not.toHaveBeenCalled(); // short-circuits before hitting the DB
  });

  it("is false when entities are configured but the table is absent", async () => {
    tableExistsResult.exists = false;
    expect(
      await ExuluReadApi.entitiesAvailable({ id: "tech_doc", entities: { types: ["Product"] } }),
    ).toBe(false);
  });

  it("is true when entities are configured and the table exists", async () => {
    tableExistsResult.exists = true;
    expect(
      await ExuluReadApi.entitiesAvailable({ id: "tech_doc", entities: { types: ["Product"] } }),
    ).toBe(true);
  });
});

describe("ExuluReadApi.embedQuery", () => {
  const ctx = { id: "tech_doc", embedder: { model: "gemini-embedding-001" } } as any;
  beforeEach(() => { embedSpy.mockClear(); resolveEmbedderSpy.mockClear(); });

  it("resolves the context embedder and returns a single vector with inputType=query", async () => {
    const vec = await ExuluReadApi.embedQuery(ctx, "wie kommt der Fehler 0xFF0C", {
      role: "r1",
    });
    expect(resolveEmbedderSpy).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-embedding-001", contextId: "tech_doc", roleId: "r1" }),
    );
    expect(embedSpy).toHaveBeenCalledWith(["wie kommt der Fehler 0xFF0C"], { inputType: "query" });
    expect(vec).toEqual([0.1, 0.2, 0.3]);
  });
});

describe("ExuluReadApi.authorizedRead", () => {
  const ctx = { id: "tech_doc", fields: [] } as any;
  const user = { id: 1, email: "u@x.com", role: { id: "r1", name: "r1" } } as any;

  it("throws when neither itemIds nor externalIds is provided", async () => {
    await expect(ExuluReadApi.authorizedRead(ctx, user, "r1", {})).rejects.toThrow(
      /requires itemIds or externalIds/,
    );
  });

  it("queries the chunks table, filters by itemIds, and applies access control on 'items'", async () => {
    const rows = await ExuluReadApi.authorizedRead(ctx, user, "r1", { itemIds: ["i1"] });
    expect(dbFn).toHaveBeenCalledWith("tech_doc_chunks as chunks");
    expect(builderCalls.leftJoin?.[0]?.[0]).toBe("tech_doc_items as items");
    expect(builderCalls.whereIn).toContainEqual(["items.id", ["i1"]]);
    // applyAccessControl invoked with (tableDef, query, user, "items")
    expect(acSpy).toHaveBeenCalledTimes(1);
    expect(acSpy.mock.calls[0][3]).toBe("items");
    expect(acSpy.mock.calls[0][2]).toBe(user);
    expect(rows).toEqual(cannedRows);
  });

  it("applies a chunk_index range when given", async () => {
    await ExuluReadApi.authorizedRead(ctx, user, "r1", {
      externalIds: ["EXT-1"],
      chunkIndexRange: { from: 2, to: 5 },
    });
    expect(builderCalls.whereIn).toContainEqual(["items.external_id", ["EXT-1"]]);
    expect(builderCalls.where).toContainEqual(["chunks.chunk_index", ">=", 2]);
    expect(builderCalls.where).toContainEqual(["chunks.chunk_index", "<=", 5]);
    expect(acSpy).toHaveBeenCalledTimes(1);
    expect(acSpy.mock.calls[0][3]).toBe("items");
  });
});
