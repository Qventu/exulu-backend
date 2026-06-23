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
