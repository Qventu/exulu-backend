// Fix round 1, F1 — the access-control bypass, asserted on the SQL that
// actually reaches Postgres, from the `find_<ctx>_items` tool all the way down.
//
// Everything on this path is REAL except the database: applyFilters,
// applyAccessControl, convertContextToTableDefinition and the generated read
// tool. `postgresClient` hands out a Knex pg builder (no connection) whose
// `then` records the compiled SQL instead of executing it. A filter that
// compiles to an OR (`lte: 0` is the only one) must not be able to OR past the
// access predicate that is applied after it.
import Knex from "knex";

jest.mock("@SRC/graphql/resolvers/vector-search", () => ({
  vectorSearch: jest.fn(async () => ({ chunks: [], itemFilters: [], chunkFilters: [] })),
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

const knex = Knex({ client: "pg" });
let lastSql = "";
jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({
    db: {
      from: (table: string) => {
        const builder: any = knex(table);
        // Record instead of execute: assigning `then` on the instance shadows
        // Knex's own, so awaiting the builder never opens a connection.
        builder.then = (resolve: (rows: any[]) => unknown) => {
          lastSql = builder.toString().toLowerCase();
          return Promise.resolve([]).then(resolve);
        };
        return builder;
      },
    },
  })),
}));

import { ExuluContext } from "./context";
import { createContextReadTools } from "@SRC/templates/tools/context-read-tools";

const context = new ExuluContext({
  id: "products",
  name: "Products",
  description: "",
  fields: [{ name: "price", type: "number" }] as any,
  active: true,
  sources: [],
  configuration: { calculateVectors: "manual", languages: ["english"] },
} as any);

// A plain member: no super_admin bypass, no api scope — access control applies.
const user = { id: 7, email: "u@x", role: { id: "role-1" } } as any;

const findSql = async (input: Record<string, unknown>): Promise<string> => {
  const [, find] = createContextReadTools(context);
  await (find!.tool.execute as any)(
    { user, exuluConfig: {}, ...input },
    { toolCallId: "t", messages: [] },
  );
  return lastSql;
};

describe("ExuluContext.getItems — a filter can never OR past access control", () => {
  beforeEach(() => {
    lastSql = "";
  });

  it("keeps the access predicate AND-ed when find filters with the OR-compiling lte: 0", async () => {
    const sql = await findSql({ where: { price: { lte: 0 } } });
    // The filter is one self-contained group...
    expect(sql).toContain('(("price" is null or "price" = 0))');
    // ...and the access control follows it with AND, never inside the OR.
    expect(sql).toMatch(/\(\("price" is null or "price" = 0\)\) and \(/);
    expect(sql).toContain('"rights_mode" = \'public\'');
    expect(sql).not.toMatch(/"price" is null or "price" = 0 and "rights_mode"/);
  });

  it("still applies access control for an ordinary filter, and caps the rows", async () => {
    const sql = await findSql({ where: { price: { gte: 5 } }, limit: 7 });
    expect(sql).toContain('"price" >= 5');
    expect(sql).toContain('"rights_mode" = \'public\'');
    expect(sql).toContain("limit 7");
  });

  it("adds no empty filter group when there is nothing to filter", async () => {
    const sql = await findSql({});
    expect(sql).not.toContain("where ()");
    expect(sql).toContain('"rights_mode" = \'public\'');
  });
});
