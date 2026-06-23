// Mock heavy/ESM modules that context.ts transitively loads BEFORE importing context.
// jest.mock calls are hoisted by babel-jest/ts-jest, so these run before the import.

const acSpy = jest.fn((_t: any, q: any) => q);
jest.mock("@SRC/graphql/utilities/access-control", () => ({
  applyAccessControl: (...a: any[]) => acSpy(...a),
}));

const builder: any = {
  from: () => builder,
  select: () => builder,
  where: () => builder,
  then: (r: (x: any[]) => void) => r([{ id: "i1" }]),
};
const dbMock: any = { from: jest.fn(() => builder) };
jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({ db: dbMock })),
}));

// Mock the heavy graph that context.ts imports
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
  applyFilters: (_q: any, _f: any) => builder,
}));
jest.mock("@SRC/exulu/storage.ts", () => ({ ExuluStorage: jest.fn() }));
jest.mock("@SRC/exulu/resolve-embedder", () => ({ resolveEmbedder: jest.fn() }));
jest.mock("@SRC/exulu/statistics", () => ({ updateStatistic: jest.fn() }));
jest.mock("@SRC/exulu/chunker", () => ({
  defaultChunker: jest.fn(),
}));
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
// franc is ESM-only; mock the whole chain
jest.mock("@SRC/utils/query-preprocessing", () => ({
  preprocessQuery: jest.fn((q: string) => ({ processed: q })),
}));
jest.mock("@SRC/exulu/litellm/parse-embedding-models", () => ({
  getEmbeddingModelInfo: jest.fn(() => ({ dimensionality: 768 })),
}));
jest.mock("pgvector/knex", () => ({ toSql: jest.fn((v: any) => v) }));

import { ExuluContext } from "./context";

// Minimal context config
const ctx = new ExuluContext({
  id: "newton_memory_context",
  name: "mem",
  description: "",
  embedder: { model: "gemini-embedding-001" },
  fields: [],
  active: true,
  sources: [],
  configuration: { calculateVectors: "manual", languages: ["english"] },
} as any);

describe("ExuluContext.getItems RBAC", () => {
  beforeEach(() => {
    acSpy.mockClear();
    dbMock.from.mockClear();
  });

  it("does NOT apply access control when no user is passed (backward-compatible)", async () => {
    await ctx.getItems({ filters: [], fields: ["id"] });
    expect(acSpy).not.toHaveBeenCalled();
  });

  it("applies access control when a user is passed", async () => {
    const user = { id: 1, email: "u@x", role: { id: "r1" } } as any;
    await ctx.getItems({ filters: [{ type: { in: ["DECISION"] } }], fields: ["id"], user, role: "r1" });
    expect(dbMock.from).toHaveBeenCalled();
    expect(acSpy).toHaveBeenCalledTimes(1);
    expect(acSpy.mock.calls[0][2]).toMatchObject({ id: 1, role: { id: "r1" } });
  });
});
