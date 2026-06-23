// --- mock must be hoisted before module import ---
const tableExistsResult = { exists: false };
const mockDb = {
  raw: jest.fn(async () => ({ rows: [{ exists: tableExistsResult.exists }] })),
};
jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({ db: mockDb })),
}));

import { ExuluReadApi } from "./read-api";

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
    mockDb.raw.mockClear();
  });

  it("is false when the context declares no entities config", async () => {
    expect(await ExuluReadApi.entitiesAvailable({ id: "tech_doc" })).toBe(false);
    expect(mockDb.raw).not.toHaveBeenCalled(); // short-circuits before hitting the DB
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
