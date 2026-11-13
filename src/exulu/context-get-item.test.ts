// Mock the heavy/ESM module graph context.ts pulls in BEFORE importing it.
// jest.mock calls are hoisted, so these run before the import below.
// (Same mock set as get-items-rbac.test.ts — context.ts cannot be imported
// without them.)
jest.mock("@SRC/graphql/utilities/access-control", () => ({
  applyAccessControl: (_t: any, q: any) => q,
}));
jest.mock("@SRC/graphql/resolvers/vector-search", () => ({
  vectorSearch: jest.fn(async () => ({ chunks: [], itemFilters: [], chunkFilters: [] })),
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
jest.mock("@SRC/graphql/resolvers/apply-filters", () => ({
  applyFilters: (q: any) => q,
  applyFiltersGrouped: (q: any) => q,
}));
jest.mock("@SRC/exulu/storage.ts", () => ({ ExuluStorage: jest.fn() }));
jest.mock("@SRC/exulu/resolve-embedder", () => ({ resolveEmbedder: jest.fn() }));
jest.mock("@SRC/exulu/statistics", () => ({ updateStatistic: jest.fn() }));
jest.mock("@SRC/exulu/chunker", () => ({ defaultChunker: jest.fn() }));
jest.mock("@EE/queues/decorator", () => ({ bullmqDecorator: jest.fn() }));
jest.mock("@SRC/exulu/entities", () => ({
  captureEntitiesBeforeReembed: jest.fn(async () => []),
  detachEntitiesForItem: jest.fn(async () => 0),
  extractAndIngestEntities: jest.fn(async () => 0),
  hydrateEntityTypes: jest.fn(async () => []),
  computeTypesSignature: jest.fn(() => "sig"),
  entitiesEnabled: jest.fn(async () => false),
  entitiesTableExists: jest.fn(async () => false),
  getEntitiesTableName: jest.fn((id: string) => `${id}_entities`),
}));
jest.mock("@SRC/utils/query-preprocessing", () => ({
  preprocessQuery: jest.fn((q: string) => ({ processed: q })),
}));
jest.mock("@SRC/exulu/litellm/parse-embedding-models", () => ({
  getEmbeddingModelInfo: jest.fn(() => ({ dimensionality: 768 })),
}));
jest.mock("pgvector/knex", () => ({ toSql: jest.fn((v: any) => v) }));

const tables: string[] = [];
const row: Record<string, unknown> = { id: "item-1", name: "Widget" };
const dbMock: any = {
  from: jest.fn((table: string) => {
    tables.push(table);
    const builder: any = {
      where: () => builder,
      first: async () => ({ ...row }),
      count: async () => [{ count: "3" }],
    };
    return builder;
  }),
};
jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({ db: dbMock })),
}));

import { ExuluContext, getChunksTableName, getTableName } from "./context";

const makeContext = (embedder?: { model: string }) =>
  new ExuluContext({
    id: "mv_pitches",
    name: "Pitches",
    description: "",
    ...(embedder ? { embedder } : {}),
    fields: [],
    active: true,
    sources: [],
    configuration: { calculateVectors: "manual" },
  } as any);

describe("ExuluContext.getItem chunk count", () => {
  beforeEach(() => {
    tables.length = 0;
    dbMock.from.mockClear();
  });

  // The M&V failure (2026-11-12): a context without an embedder has no
  // chunks table, so counting chunks on every read blew up with
  // `relation "mv_pitches_chunks" does not exist` — which took the
  // agent's whole read with it.
  it("does not touch the chunks table for a context without an embedder", async () => {
    const result = await makeContext().getItem({ item: { id: "item-1" } });
    expect(tables).toEqual([getTableName("mv_pitches")]);
    expect(tables).not.toContain(getChunksTableName("mv_pitches"));
    expect(result.chunksCount).toBe(0);
  });

  it("still counts chunks for a context with an embedder", async () => {
    const result = await makeContext({ model: "gemini-embedding-001" }).getItem({
      item: { id: "item-1" },
    });
    expect(tables).toEqual([getTableName("mv_pitches"), getChunksTableName("mv_pitches")]);
    expect(result.chunksCount).toBe(3);
  });
});
