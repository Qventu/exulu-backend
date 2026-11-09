/**
 * Task 4's own test: the tool path (context.updateItem, src/exulu/context.ts)
 * and the GraphQL path (the generated `<table>UpdateOneById` resolver,
 * src/graphql/mutations/index.ts) are two INDEPENDENT implementations that
 * both now route through the one chokepoint, prepareItemWrite
 * (src/exulu/item-write.ts). This file drives BOTH real implementations --
 * a real `ExuluContext` instance and the real resolver `createMutations`
 * returns -- against a SHARED in-memory fake "table", so "both paths agree"
 * is proven by actually running both, not by re-implementing one of them
 * (which would prove nothing -- see the plan's own note on this).
 *
 * Getting both modules to load for real means mocking every HEAVY
 * transitive dependency either one pulls in (storage, vector search,
 * embedders, entities, bullmq, the franc-based query preprocessor, ...) --
 * the same set `src/exulu/get-items-rbac.test.ts` and
 * `src/graphql/mutations/validate-write-access.test.ts` already prove works
 * for each module separately; this file is their union. `prepareItemWrite`
 * and `json-field-schema.ts` are deliberately NOT mocked -- they are the
 * thing under test.
 */

// --- context.ts's heavy transitive deps (see get-items-rbac.test.ts) ------
jest.mock("@SRC/exulu/storage.ts", () => ({ ExuluStorage: jest.fn() }));
jest.mock("@SRC/exulu/resolve-embedder", () => ({ resolveEmbedder: jest.fn() }));
jest.mock("@SRC/graphql/resolvers/vector-search", () => ({
  vectorSearch: jest.fn(async () => ({ chunks: [], itemFilters: [], chunkFilters: [] })),
}));
jest.mock("@SRC/graphql/utilities/convert-context-to-table-definition", () => ({
  convertContextToTableDefinition: (ctx: any) => ({
    id: ctx.id,
    name: { singular: ctx.id + "_item", plural: ctx.id + "_items" },
    type: "items",
    RBAC: false,
    fields: ctx.fields,
  }),
}));
jest.mock("@SRC/exulu/chunker", () => ({ defaultChunker: jest.fn() }));
jest.mock("@EE/queues/decorator", () => ({ bullmqDecorator: jest.fn() }));
jest.mock("@SRC/utils/query-preprocessing", () => ({
  preprocessQuery: jest.fn((q: string) => ({ processed: q })),
}));
jest.mock("@SRC/exulu/litellm/parse-embedding-models", () => ({
  getEmbeddingModelInfo: jest.fn(() => ({ dimensionality: 768 })),
}));
jest.mock("pgvector/knex", () => ({ toSql: jest.fn((v: any) => v) }));

// --- shared between context.ts and mutations/index.ts ---------------------
// Both modules import from "entities" (context.ts: "./entities", relative;
// mutations/index.ts: "@SRC/exulu/entities", aliased) -- same file, one mock
// combining every export either consumer needs.
jest.mock("@SRC/exulu/entities", () => ({
  captureEntitiesBeforeReembed: jest.fn(async () => []),
  detachEntitiesForItem: jest.fn(async () => 0),
  extractAndIngestEntities: jest.fn(async () => 0),
  hydrateEntityTypes: jest.fn(async () => []),
  computeTypesSignature: jest.fn(() => "sig"),
  entitiesEnabled: jest.fn(async () => false),
  entitiesTableExists: jest.fn(async () => false),
  getEntitiesTableName: jest.fn((id: string) => `${id}_entities`),
  resolveEntityModel: jest.fn(),
  setEntityModelSetting: jest.fn(),
}));
jest.mock("@SRC/exulu/statistics", () => ({ updateStatistic: jest.fn() }));
jest.mock("@SRC/graphql/utilities/access-control", () => ({
  applyAccessControl: jest.fn((_t: any, q: any) => q),
}));
// UpdateOne (unlike UpdateOneById) resolves its target row through `where`,
// GraphQL's [FilterX] shape -- a minimal real translator for the one shape
// this file's UpdateOne tests send (`[{ id: { eq: "..." } }]`), not a
// no-op: a no-op would make `itemQuery.first()` return the WRONG row (or
// none), which is exactly the kind of mock that would make a parity test
// pass for the wrong reason.
const applyIdFilter = (query: any, where: any) => {
  const idFilter = Array.isArray(where) ? where.find((w: any) => w && w.id) : undefined;
  const idValue = idFilter?.id?.eq;
  return idValue !== undefined ? query.where({ id: idValue }) : query;
};
jest.mock("@SRC/graphql/resolvers/apply-filters.ts", () => ({
  applyFilters: (query: any, where: any) => applyIdFilter(query, where),
}));
jest.mock("@SRC/graphql/resolvers/apply-filters", () => ({
  applyFilters: (query: any, where: any) => applyIdFilter(query, where),
}));

// postgresClient is shared: both the tool path (context.ts's updateItem)
// and the in-test db construction below resolve to the SAME underlying
// fake db, via this one mock -- that is what lets a tool-path write and a
// GraphQL-path write land on the literal same in-memory row.
let sharedDb: any;
jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({ db: sharedDb })),
}));

// --- mutations/index.ts's own remaining heavy/irrelevant deps -------------
jest.mock("@SRC/graphql/resolvers/utils", () => ({
  contextItemsProcessorHandler: jest.fn(),
  // Real sanitizeRequestedFields always keeps "id" in the select list
  // (downstream code depends on it); this mock does the same rather than
  // the bare `[]` an identity mock would produce, which would make
  // UpdateOne's own existence-check row come back as `{}`.
  getRequestedFields: jest.fn(() => ["id"]),
}));
jest.mock("@SRC/auth/generate-key.ts", () => ({ SALT_ROUNDS: 10 }));
jest.mock("@SRC/graphql/utilities/validate-super-admin-update.ts", () => ({
  validateCreateOrRemoveSuperAdminPermission: jest.fn(async () => {}),
}));
jest.mock("@SRC/graphql/utilities/encrypt-sensitive-fields.ts", () => ({
  encryptSensitiveFields: (input: any) => input,
}));
jest.mock("@SRC/graphql/utilities/sanitize-and-hydrate-fields.ts", () => ({
  finalizeRequestedFields: jest.fn((f: any) => f),
}));
jest.mock("@SRC/exulu/routines/run-state.ts", () => ({ cancelRoutineRunRow: jest.fn() }));
jest.mock("@EE/queues/queues", () => ({ queues: {} }));
jest.mock("@SRC/graphql/resolvers/index.ts", () => ({
  itemsPaginationRequest: jest.fn(),
  sanitizeRequestedFields: jest.fn((f: any) => f),
}));
jest.mock("@EE/rbac-update.ts", () => ({ handleRBACUpdate: jest.fn() }));

import { z } from "zod";
import { ExuluContext, type ExuluContextFieldDefinition } from "./context";
import { createMutations } from "@SRC/graphql/mutations/index";

// Same M&V fixture used throughout json-field-schema.test.ts/item-write.test.ts.
const feld = z.object({ wert: z.string(), konfidenz: z.enum(["low", "medium", "high"]) });
const felderSchema = z.record(z.string(), feld);

const FIELDS: ExuluContextFieldDefinition[] = [
  { name: "name", type: "text" },
  { name: "felder", type: "json", schema: felderSchema },
  { name: "notes", type: "json" }, // no schema -- opaque, as today
];

const CONTEXT_ID = "docs";
const TABLE_NAME = "docs_items"; // getTableName("docs") === "docs_items"

/**
 * A minimal in-memory knex-shaped fake, keyed by table name then row id.
 * Both write paths run against the SAME instance (via `sharedDb`), which is
 * what makes "both paths produce the same stored row" an actual assertion
 * about behaviour rather than two isolated mocks that happen to agree.
 */
function makeFakeDb(seed: Record<string, Record<string, unknown>>) {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  for (const [table, rows] of Object.entries(seed)) {
    const t = new Map<string, Record<string, unknown>>();
    for (const [id, row] of Object.entries(rows)) t.set(id, { id, ...(row as object) });
    tables.set(table, t);
  }
  const tableFor = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };

  function builder(tableName: string) {
    let whereId: string | undefined;
    let selectCols: string[] | undefined;
    const api: any = {
      select: (cols: any) => {
        selectCols = Array.isArray(cols) ? cols : undefined;
        return api;
      },
      where: (clause: any) => {
        if (clause && clause.id !== undefined) whereId = String(clause.id);
        return api;
      },
      first: async () => {
        const row = whereId !== undefined ? tableFor(tableName).get(whereId) : undefined;
        if (!row) return undefined;
        if (!selectCols) return { ...row };
        const picked: Record<string, unknown> = {};
        for (const c of selectCols) picked[c] = row[c];
        return picked;
      },
      columnInfo: async () => ({
        id: {},
        name: {},
        felder: {},
        notes: {},
        updatedAt: {},
        rights_mode: {},
        created_by: {},
      }),
      update: (patch: Record<string, unknown>) => {
        if (whereId === undefined) throw new Error("fake db: update with no where clause");
        const t = tableFor(tableName);
        const existing = t.get(whereId) ?? { id: whereId };
        // Both write paths JSON.stringify a json-typed column's object/array
        // value before handing it to knex (jsonb columns bind as text) --
        // mirror the other half of that round trip here, the same way the
        // real `pg` driver parses a jsonb column back into a JS value on
        // read, so assertions compare objects rather than JSON text.
        const parsed: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(patch)) {
          parsed[key] = typeof value === "string" && /^[{[]/.test(value) ? JSON.parse(value) : value;
        }
        t.set(whereId, { ...existing, ...parsed });
        const thenable: any = {
          returning: async (_cols: any) => [{ ...t.get(whereId) }],
          then: (resolve: any, reject: any) => Promise.resolve().then(resolve, reject),
        };
        return thenable;
      },
    };
    return api;
  }

  const db: any = Object.assign((name: string) => builder(name), {
    from: (name: string) => builder(name),
  });
  return { db, row: (name: string, id: string) => tableFor(name).get(id) };
}

function makeContext(overrides: Record<string, unknown> = {}) {
  return new ExuluContext({
    id: CONTEXT_ID,
    name: "Docs",
    description: "",
    fields: FIELDS,
    active: true,
    sources: [],
    configuration: { calculateVectors: "manual" },
    ...overrides,
  } as any);
}

const presetsLikeTable: any = {
  name: { singular: "docs_item", plural: TABLE_NAME },
  type: "presets", // deliberately not "items": postprocessUpdate's embedder/processor
  // branch is out of scope for this task and not touched by it.
  RBAC: false,
  fields: FIELDS,
};

function makeGraphqlMutations() {
  return createMutations(presetsLikeTable, [], [], [], {} as any);
}

function graphqlContext() {
  return { db: sharedDb, user: { id: 9, super_admin: true, role: { id: "role-1" } }, req: {} };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("item-write parity: the tool path and the GraphQL path agree", () => {
  it("a REPLACE produces the identical stored value on both paths", async () => {
    const { db, row } = makeFakeDb({
      [TABLE_NAME]: {
        "row-tool": { name: "A", felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } },
        "row-gql": { name: "A", felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } },
      },
    });
    sharedDb = db;

    const ctx = makeContext();
    await ctx.updateItem(
      { id: "row-tool", felder: { zielgruppe: { wert: "NEW", konfidenz: "high" } } } as any,
      {} as any,
    );

    const updateOneById = makeGraphqlMutations()[`${TABLE_NAME}UpdateOneById`];
    await updateOneById(
      null,
      { id: "row-gql", input: { felder: { zielgruppe: { wert: "NEW", konfidenz: "high" } } } },
      graphqlContext(),
      {},
    );

    expect(row(TABLE_NAME, "row-tool")!.felder).toEqual({ zielgruppe: { wert: "NEW", konfidenz: "high" } });
    expect(row(TABLE_NAME, "row-gql")!.felder).toEqual(row(TABLE_NAME, "row-tool")!.felder);
  });

  it("a MERGE keeps the keys the patch omits, identically on both paths", async () => {
    const existingFelder = {
      budget_gesamt: { wert: "OLD", konfidenz: "low" },
      zielgruppe: { wert: "UNTOUCHED", konfidenz: "medium" },
    };
    const { db, row } = makeFakeDb({
      [TABLE_NAME]: {
        "row-tool": { name: "A", felder: existingFelder },
        "row-gql": { name: "A", felder: existingFelder },
      },
    });
    sharedDb = db;

    const ctx = makeContext();
    await ctx.updateItem(
      { id: "row-tool", felder: { budget_gesamt: { wert: "NEW", konfidenz: "high" } } } as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      ["felder"],
    );

    const updateOneById = makeGraphqlMutations()[`${TABLE_NAME}UpdateOneById`];
    await updateOneById(
      null,
      { id: "row-gql", input: { felder: { budget_gesamt: { wert: "NEW", konfidenz: "high" } } }, merge: ["felder"] },
      graphqlContext(),
      {},
    );

    const expected = {
      budget_gesamt: { wert: "NEW", konfidenz: "high" },
      zielgruppe: { wert: "UNTOUCHED", konfidenz: "medium" },
    };
    expect(row(TABLE_NAME, "row-tool")!.felder).toEqual(expected);
    expect(row(TABLE_NAME, "row-gql")!.felder).toEqual(expected);
  });

  it("a REFUSED write (schema violation) is refused identically on both paths, and neither row changes", async () => {
    const existingFelder = { budget_gesamt: { wert: "OLD", konfidenz: "low" } };
    const { db, row } = makeFakeDb({
      [TABLE_NAME]: {
        "row-tool": { name: "A", felder: existingFelder },
        "row-gql": { name: "A", felder: existingFelder },
      },
    });
    sharedDb = db;

    const badInput = { felder: { budget_gesamt: { wert: "1000", konfidenz: "sehr hoch" } } };

    const ctx = makeContext();
    let toolMessage: string | undefined;
    try {
      await ctx.updateItem({ id: "row-tool", ...badInput } as any, {} as any);
    } catch (e) {
      toolMessage = e instanceof Error ? e.message : String(e);
    }

    const updateOneById = makeGraphqlMutations()[`${TABLE_NAME}UpdateOneById`];
    let gqlMessage: string | undefined;
    try {
      await updateOneById(null, { id: "row-gql", input: { ...badInput } }, graphqlContext(), {});
    } catch (e) {
      gqlMessage = e instanceof Error ? e.message : String(e);
    }

    expect(toolMessage).toBeDefined();
    expect(gqlMessage).toBeDefined();
    expect(toolMessage).toBe(gqlMessage);
    expect(toolMessage).toContain("budget_gesamt.konfidenz");

    // Neither row actually changed -- the refusal happened before any write.
    expect(row(TABLE_NAME, "row-tool")!.felder).toEqual(existingFelder);
    expect(row(TABLE_NAME, "row-gql")!.felder).toEqual(existingFelder);
  });

  // --- Review Focus 5: the concurrency claim -------------------------------
  it("two merges on different keys both survive (same path, sequential)", async () => {
    const { db, row } = makeFakeDb({
      [TABLE_NAME]: { r1: { name: "A", felder: {} } },
    });
    sharedDb = db;
    const ctx = makeContext();

    await ctx.updateItem(
      { id: "r1", felder: { a: { wert: "1", konfidenz: "low" } } } as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      ["felder"],
    );
    await ctx.updateItem(
      { id: "r1", felder: { b: { wert: "2", konfidenz: "high" } } } as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      ["felder"],
    );

    expect(row(TABLE_NAME, "r1")!.felder).toEqual({
      a: { wert: "1", konfidenz: "low" },
      b: { wert: "2", konfidenz: "high" },
    });
  });

  it("two merges on different keys both survive, INTERLEAVED ACROSS the tool path and the GraphQL path", async () => {
    // The strongest form of the parity claim: not just "each path's own
    // merge is non-destructive" but "the two independent implementations
    // can take turns editing the same row and neither clobbers the other" --
    // exactly the M&V two-analysts-editing-the-same-matrix scenario the spec
    // names. Reverting either path's routing through prepareItemWrite would
    // turn its half of this into a silent REPLACE, dropping a DIFFERENT
    // existing key -- this test would then fail on the final `toEqual`.
    //
    // Seeded non-empty on purpose (confirmed by reverting each wiring in
    // turn while building this test): starting from `{}`, a broken REPLACE
    // and a correct MERGE produce the same first-step result, which would
    // let a broken tool-path wiring hide behind the second, correctly-wired
    // call. `existing0` has no reason to be touched by either edit, so its
    // survival is what actually pins each half of the chain down.
    const { db, row } = makeFakeDb({
      [TABLE_NAME]: { r1: { name: "A", felder: { existing0: { wert: "0", konfidenz: "medium" } } } },
    });
    sharedDb = db;

    const ctx = makeContext();
    await ctx.updateItem(
      { id: "r1", felder: { a: { wert: "1", konfidenz: "low" } } } as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      ["felder"],
    );
    // Pin the tool-path half independently: if its merge silently became a
    // replace, existing0 would already be gone here.
    expect(row(TABLE_NAME, "r1")!.felder).toEqual({
      existing0: { wert: "0", konfidenz: "medium" },
      a: { wert: "1", konfidenz: "low" },
    });

    const updateOneById = makeGraphqlMutations()[`${TABLE_NAME}UpdateOneById`];
    await updateOneById(
      null,
      { id: "r1", input: { felder: { b: { wert: "2", konfidenz: "high" } } }, merge: ["felder"] },
      graphqlContext(),
      {},
    );

    expect(row(TABLE_NAME, "r1")!.felder).toEqual({
      existing0: { wert: "0", konfidenz: "medium" },
      a: { wert: "1", konfidenz: "low" },
      b: { wert: "2", konfidenz: "high" },
    });
  });

  // --- Concern 2 (coordinator ruling, fix round 1): the processor sees the
  // --- MERGED result, not the raw patch ------------------------------------
  //
  // Before merge existed, the incoming patch WAS the full value being
  // written, so "what the processor receives" and "what gets stored" were
  // the same object by construction. With merge they diverge, and
  // `mv_pitches` (trigger: "always") is named as the first real consumer of
  // a merge-listed json field -- so a processor seeing only the fragment
  // someone just changed, rather than the item that will actually exist, is
  // live, not latent.
  describe("the tool path's processor receives the full merged object, not the incoming patch", () => {
    it("a merge-listed field's processor payload carries every stored key, not just the ones in this call's patch", async () => {
      const { db } = makeFakeDb({
        [TABLE_NAME]: {
          r1: {
            name: "A",
            felder: {
              budget_gesamt: { wert: "OLD", konfidenz: "low" },
              zielgruppe: { wert: "UNTOUCHED", konfidenz: "medium" },
            },
          },
        },
      });
      sharedDb = db;

      const ctx = makeContext({ processor: { config: { trigger: "always" } } });
      const processFieldSpy = jest
        .spyOn(ctx, "processField")
        .mockResolvedValue({ result: undefined, job: undefined });

      await ctx.updateItem(
        { id: "r1", felder: { budget_gesamt: { wert: "NEW", konfidenz: "high" } } } as any,
        {} as any,
        undefined,
        undefined,
        undefined,
        undefined,
        ["felder"],
      );

      expect(processFieldSpy).toHaveBeenCalledTimes(1);
      const payload = processFieldSpy.mock.calls[0]![1] as Record<string, unknown>;
      // Reverting Task 4's "pass `values`, not `item`" fix would make this
      // see ONLY `{ budget_gesamt: {...} }` -- the bare patch -- dropping
      // `zielgruppe`, which is still stored but was never part of this call.
      // The chokepoint's own json-stringify step (both write paths run it
      // before a jsonb column write) already ran on `values` by this point,
      // so the processor payload carries the STRINGIFIED value, same as the
      // row written to the db -- parse it back to compare as data.
      expect(JSON.parse(payload.felder as string)).toEqual({
        budget_gesamt: { wert: "NEW", konfidenz: "high" },
        zielgruppe: { wert: "UNTOUCHED", konfidenz: "medium" },
      });
    });

    it("a plain replace (no merge) is unaffected -- patch and result are already the same object there", async () => {
      const { db } = makeFakeDb({
        [TABLE_NAME]: { r1: { name: "A", felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } } },
      });
      sharedDb = db;

      const ctx = makeContext({ processor: { config: { trigger: "always" } } });
      const processFieldSpy = jest
        .spyOn(ctx, "processField")
        .mockResolvedValue({ result: undefined, job: undefined });

      await ctx.updateItem(
        { id: "r1", felder: { zielgruppe: { wert: "NEW", konfidenz: "high" } } } as any,
        {} as any,
      );

      const payload = processFieldSpy.mock.calls[0]![1] as Record<string, unknown>;
      expect(JSON.parse(payload.felder as string)).toEqual({ zielgruppe: { wert: "NEW", konfidenz: "high" } });
    });
  });

  // --- Decision 1: the route to clearing a field is a replace -------------
  describe("clearing a schema-carrying field: null is refused, {} via replace works", () => {
    it("through the GraphQL path (what artifacts use): a top-level null under merge is refused, not a silent clear", async () => {
      const existingFelder = {
        budget_gesamt: { wert: "OLD", konfidenz: "low" },
        zielgruppe: { wert: "KEEP", konfidenz: "medium" },
      };
      const { db, row } = makeFakeDb({ [TABLE_NAME]: { r1: { name: "A", felder: existingFelder } } });
      sharedDb = db;

      const updateOneById = makeGraphqlMutations()[`${TABLE_NAME}UpdateOneById`];
      await expect(
        updateOneById(null, { id: "r1", input: { felder: null }, merge: ["felder"] }, graphqlContext(), {}),
      ).rejects.toThrow(/merge/i);

      // Refused before any write -- the row is untouched, not nulled.
      expect(row(TABLE_NAME, "r1")!.felder).toEqual(existingFelder);
    });

    it("through the GraphQL path: replacing with {} (no merge) clears every stored key", async () => {
      const existingFelder = {
        budget_gesamt: { wert: "OLD", konfidenz: "low" },
        zielgruppe: { wert: "KEEP", konfidenz: "medium" },
      };
      const { db, row } = makeFakeDb({ [TABLE_NAME]: { r1: { name: "A", felder: existingFelder } } });
      sharedDb = db;

      const updateOneById = makeGraphqlMutations()[`${TABLE_NAME}UpdateOneById`];
      await updateOneById(null, { id: "r1", input: { felder: {} } }, graphqlContext(), {});

      expect(row(TABLE_NAME, "r1")!.felder).toEqual({});
    });

    it("through the GraphQL path: a plain (non-merge) null is still refused for a non-nullable schema", async () => {
      const existingFelder = { budget_gesamt: { wert: "OLD", konfidenz: "low" } };
      const { db, row } = makeFakeDb({ [TABLE_NAME]: { r1: { name: "A", felder: existingFelder } } });
      sharedDb = db;

      const updateOneById = makeGraphqlMutations()[`${TABLE_NAME}UpdateOneById`];
      await expect(
        updateOneById(null, { id: "r1", input: { felder: null } }, graphqlContext(), {}),
      ).rejects.toThrow();

      expect(row(TABLE_NAME, "r1")!.felder).toEqual(existingFelder);
    });
  });

  // --- Decision 2: what knex.update({x: undefined}) actually does ---------
  it("decision 2: knex compiles update({x: undefined}) to the identical SQL as omitting x -- it is already a safe no-op, not a null-out", () => {
    // Checked against the REAL installed knex, not assumed -- a .default()/
    // .optional() json schema can make prepareItemWrite write an own key
    // whose value is `undefined` (see item-write.test.ts's "New 2" cases),
    // and both write paths spread that key straight into `.update(...)`.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const knex = require("knex")({ client: "pg" });
    const withUndefined = knex("items").where({ id: 1 }).update({ a: 1, b: undefined, c: "x" }).toSQL();
    const withoutKey = knex("items").where({ id: 1 }).update({ a: 1, c: "x" }).toSQL();
    expect(withUndefined.sql).toBe(withoutKey.sql);
    expect(withUndefined.bindings).toEqual(withoutKey.bindings);
  });

  // --- Decision 3: an attacker-controlled prototype upstream of the chokepoint
  describe("decision 3: a value whose prototype was swapped (zod .passthrough()'s own __proto__ quirk) is handled safely", () => {
    it("prepareItemWrite reads only OWN keys off such a value -- no inherited data leaks into the stored value or the chokepoint's decision", async () => {
      // Reproduces exactly what loosenForTransport + the AI SDK's own
      // zod safeParseAsync hands back for a model-supplied __proto__ key
      // nested under a passthrough object (confirmed empirically while
      // investigating this decision): zod's object parsing does NOT keep
      // __proto__ as an own data key -- it is consumed to set the parsed
      // object's actual [[Prototype]], the same way `{...spread, __proto__: x}`
      // or `obj.__proto__ = x` would. The object below recreates that
      // SHAPE directly (no zod/AI-SDK dependency needed to assert the
      // chokepoint's own behaviour against it).
      const corrupted: Record<string, unknown> = Object.create({ pwned: true });
      corrupted.wert = "x";
      corrupted.konfidenz = "low";
      expect(Object.getPrototypeOf(corrupted)).not.toBe(Object.prototype);

      const { prepareItemWrite } = await import("./item-write");
      const result = prepareItemWrite({
        fields: FIELDS,
        existing: null,
        input: { felder: { entry1: corrupted } },
      });

      // Valid by the declared shape (wert/konfidenz are both fine) -- this
      // must succeed, not refuse for an unrelated reason.
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success, got: " + result.message);

      // The stored value is the SAME reference (never-strip), and nothing
      // this module did read/wrote the inherited "pwned" property.
      const storedEntry = (result.values.felder as any).entry1;
      expect(storedEntry).toBe(corrupted);
      expect(Object.prototype.hasOwnProperty.call(storedEntry, "pwned")).toBe(false);
      // Serializing it (what both write paths do before it reaches Postgres)
      // only ever walks OWN enumerable keys -- the inherited "pwned" data
      // never reaches storage, exactly as if the attacker's __proto__ key
      // had simply been dropped before this module ever saw it.
      expect(JSON.parse(JSON.stringify(storedEntry))).toEqual({ wert: "x", konfidenz: "low" });
      // And the one thing that would be an actual vulnerability -- global
      // prototype pollution -- did not happen.
      expect(({} as any).pwned).toBeUndefined();
    });
  });

  // --- The wire: merge is actually reachable, not just handled once it
  // --- arrives -----------------------------------------------------------
  //
  // Everything above calls the resolver function directly, bypassing
  // graphql-js's own argument validation -- so none of it would notice if
  // `merge` were missing from the SDL that the real server actually serves
  // (createSDL, src/graphql/schemas/index.ts). That function builds a full
  // cross-table schema and isn't practically callable in isolation (it
  // requires every generic cross-table type to resolve, not just this one
  // table's), so this is deliberately a narrower, HONEST check: the actual
  // source line is present, and it is syntactically valid SDL -- not a
  // substitute for executing createSDL end-to-end.
  it("the SDL source declares merge: [String] on UpdateOneById, and the declaration is syntactically valid SDL", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.join(__dirname, "../graphql/schemas/index.ts"),
      "utf8",
    );
    const match = source.match(/\$\{tableNamePlural\}UpdateOneById\([^)]*\)/);
    expect(match).not.toBeNull();
    expect(match![0]).toContain("merge: [String]");

    const { parse } = require("graphql");
    const snippet = (match![0] as string)
      .replace(/\$\{tableNamePlural\}/g, "docs")
      .replace(/\$\{tableNameSingular\}/g, "Doc");
    const sdl = `
      type Query { x: String }
      type Mutation { ${snippet}: DocMutationPayload }
      type DocMutationPayload { id: ID! }
      input DocInput { id: ID }
    `;
    expect(() => parse(sdl)).not.toThrow();
  });

  it("the SDL source ALSO declares merge: [String] on UpdateOne (not just its ById sibling)", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.join(__dirname, "../graphql/schemas/index.ts"), "utf8");
    // `UpdateOne\(` (immediately followed by the arg list's open paren)
    // cannot match inside "UpdateOneById(" -- "ById" sits between the two
    // in that line -- so this is unambiguous, not a prefix-collision risk.
    const match = source.match(/\$\{tableNamePlural\}UpdateOne\([^)]*\)/);
    expect(match).not.toBeNull();
    expect(match![0]).toContain("merge: [String]");
  });

  // --- Concern 1 (coordinator ruling): UpdateOne is a third live door ------
  //
  // usersUpdateOne writes json fields in production today (the favourites
  // list, per the coordinator's own grep of the frontend), with no schema
  // declared on any of them yet -- harmless now, reachable the moment one
  // is. A chokepoint with an unwired third door isn't a chokepoint, so this
  // routes it through the exact same prepareItemWrite call as UpdateOneById.
  describe("UpdateOne (the where-based sibling of UpdateOneById) also routes through the chokepoint", () => {
    it("a MERGE via UpdateOne keeps the keys the patch omits -- same chokepoint, same result as UpdateOneById", async () => {
      const existingFelder = {
        budget_gesamt: { wert: "OLD", konfidenz: "low" },
        zielgruppe: { wert: "UNTOUCHED", konfidenz: "medium" },
      };
      const { db, row } = makeFakeDb({ [TABLE_NAME]: { r1: { name: "A", felder: existingFelder } } });
      sharedDb = db;

      const updateOne = makeGraphqlMutations()[`${TABLE_NAME}UpdateOne`];
      await updateOne(
        null,
        {
          where: [{ id: { eq: "r1" } }],
          input: { felder: { budget_gesamt: { wert: "NEW", konfidenz: "high" } } },
          merge: ["felder"],
        },
        graphqlContext(),
        {},
      );

      expect(row(TABLE_NAME, "r1")!.felder).toEqual({
        budget_gesamt: { wert: "NEW", konfidenz: "high" },
        zielgruppe: { wert: "UNTOUCHED", konfidenz: "medium" },
      });
    });

    it("a REFUSED write via UpdateOne actually refuses -- the write never happens, not just 'the merge also works'", async () => {
      // The half that silently does nothing if the wiring is wrong: a
      // happy-path merge test alone wouldn't catch "UpdateOne still spreads
      // input straight into .update() AND happens to merge correctly by
      // coincidence" -- only a refusal proves prepareItemWrite's verdict is
      // actually consulted, not bypassed.
      const existingFelder = { budget_gesamt: { wert: "OLD", konfidenz: "low" } };
      const { db, row } = makeFakeDb({ [TABLE_NAME]: { r1: { name: "A", felder: existingFelder } } });
      sharedDb = db;

      const updateOne = makeGraphqlMutations()[`${TABLE_NAME}UpdateOne`];
      await expect(
        updateOne(
          null,
          {
            where: [{ id: { eq: "r1" } }],
            input: { felder: { budget_gesamt: { wert: "1000", konfidenz: "sehr hoch" } } },
          },
          graphqlContext(),
          {},
        ),
      ).rejects.toThrow(/budget_gesamt\.konfidenz/);

      expect(row(TABLE_NAME, "r1")!.felder).toEqual(existingFelder);
    });

    it("a top-level null under merge is refused via UpdateOne too (Decision 1, third door)", async () => {
      const existingFelder = { budget_gesamt: { wert: "OLD", konfidenz: "low" } };
      const { db, row } = makeFakeDb({ [TABLE_NAME]: { r1: { name: "A", felder: existingFelder } } });
      sharedDb = db;

      const updateOne = makeGraphqlMutations()[`${TABLE_NAME}UpdateOne`];
      await expect(
        updateOne(
          null,
          { where: [{ id: { eq: "r1" } }], input: { felder: null }, merge: ["felder"] },
          graphqlContext(),
          {},
        ),
      ).rejects.toThrow(/merge/i);

      expect(row(TABLE_NAME, "r1")!.felder).toEqual(existingFelder);
    });
  });
});
