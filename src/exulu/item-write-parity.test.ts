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
// Deliberately NOT mocked (Task 4 fix round 2, Critical): the whole point of
// this round's fix is that the REAL convertContextToTableDefinition must be
// what builds the table createMutations receives below -- a mock here is
// exactly what let the Critical (schema dropped on the way into the GraphQL
// path) go unnoticed in round 1's version of this file. @EE/schemas / addCoreFields
// (its own transitive deps) are plain data/constant modules with no import-time
// side effects, so no mock is needed for them either.
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
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";
import { coerceValue } from "./import/coerce";

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

  // Counts every `.first()` call across every table (Task 4 fix round 2,
  // Important 3): the behaviour-identical claim for gating the existing-row
  // fetch on `args.merge?.length` can't be proven by comparing stored
  // values -- gated and ungated produce the SAME final row when merge is
  // absent. Only counting the actual round trips proves the fetch didn't
  // happen.
  let firstCallCount = 0;

  // Both write paths JSON.stringify an object/array json-typed column
  // before handing it to knex, but `typeof null === "object"` means their
  // SAME stringify condition also turns a literal `null` into the TEXT
  // "null" (confirmed while building this fix round's tests -- a real
  // Postgres jsonb column casts that text back to genuine JSON null on
  // read, same as it casts '{"a":1}' back to an object; a naive "only
  // re-parse strings that look like {...}/[...]" check, which this fake
  // used through fix round 3, missed exactly that case and stored the
  // literal string "null" instead). Undo the round trip here the way the
  // real `pg` driver would, but ONLY for columns that are actually
  // json-typed in this file's fixtures (`felder`/`notes`/`favourite_items`)
  // -- a text column whose string value happens to look like JSON (e.g.
  // `name: "42"`) must NOT be reinterpreted; only a jsonb column gets cast
  // by Postgres at all.
  const JSON_COLUMN_NAMES = new Set(["felder", "notes", "favourite_items"]);
  const parseJsonColumns = (patch: Record<string, unknown>) => {
    const parsed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === "string" && JSON_COLUMN_NAMES.has(key)) {
        try {
          parsed[key] = JSON.parse(value);
          continue;
        } catch {
          // Not valid JSON text -- a real jsonb cast would error; this
          // fake just keeps the original string rather than simulating
          // that failure, since nothing here depends on it.
        }
      }
      parsed[key] = value;
    }
    return parsed;
  };

  let nextGeneratedId = 1;

  /**
   * Every state-setting method below (select/where/insert/onConflict/
   * merge/update/returning) just records intent and returns `api` --
   * unlike the single-purpose builder round 1 of this file used, this one
   * has to support `insert(...).returning(...)` and, separately,
   * `insert(...).onConflict(col).merge()` (CreateOne's upsert path, per the
   * coordinator's Important 1 ruling), where knex mutates the SAME
   * chainable in place rather than the caller reassigning each step. The
   * actual table mutation happens once, lazily, in `then()` -- i.e. only
   * when the chain is finally awaited -- via `execute()`.
   */
  function builder(tableName: string) {
    let whereId: string | undefined;
    let selectCols: string[] | undefined;
    let insertObj: Record<string, unknown> | undefined;
    let updatePatch: Record<string, unknown> | undefined;
    let conflictCol: string | undefined;
    let isUpsert = false;

    const execute = async (): Promise<Record<string, unknown>[]> => {
      const t = tableFor(tableName);
      if (insertObj !== undefined) {
        const row = parseJsonColumns(insertObj);
        if (isUpsert && conflictCol && row[conflictCol] !== undefined) {
          const existing = [...t.entries()].find(([, r]) => r[conflictCol as string] === row[conflictCol]);
          if (existing) {
            const [existingId, existingRow] = existing;
            const merged = { ...existingRow, ...row };
            t.set(existingId, merged);
            return [{ ...merged }];
          }
        }
        const id = row.id !== undefined ? String(row.id) : `generated-${nextGeneratedId++}`;
        const stored = { ...row, id };
        t.set(id, stored);
        return [{ ...stored }];
      }
      if (updatePatch !== undefined) {
        if (whereId === undefined) throw new Error("fake db: update with no where clause");
        const existing = t.get(whereId) ?? { id: whereId };
        const merged = { ...existing, ...parseJsonColumns(updatePatch) };
        t.set(whereId, merged);
        return [{ ...merged }];
      }
      throw new Error("fake db: awaited a builder with nothing to execute");
    };

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
        firstCallCount++;
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
        favourite_items: {},
        external_id: {},
        updatedAt: {},
        rights_mode: {},
        created_by: {},
      }),
      insert: (obj: Record<string, unknown>) => {
        insertObj = obj;
        return api;
      },
      // CreateOne's own upsert call (mutations/index.ts) calls `onConflict()`
      // with NO column -- real Postgres/knex resolve that against the
      // table's primary key; this fake does the same by defaulting to "id".
      onConflict: (col?: string) => {
        conflictCol = col ?? "id";
        return api;
      },
      merge: () => {
        isUpsert = true;
        return api;
      },
      update: (patch: Record<string, unknown>) => {
        updatePatch = patch;
        return api;
      },
      // A marker, not a terminal call -- real knex returns the same
      // chainable here too; execution happens on await, via `then` below.
      returning: (_cols: any) => api,
      then: (resolve: any, reject: any) => execute().then(resolve, reject),
    };
    return api;
  }

  const db: any = Object.assign((name: string) => builder(name), {
    from: (name: string) => builder(name),
    fn: { uuid: () => `generated-${nextGeneratedId++}` },
  });
  return {
    db,
    row: (name: string, id: string) => tableFor(name).get(id),
    firstCallCount: () => firstCallCount,
  };
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

/**
 * Builds the GraphQL-side table definition the SAME way the real server
 * does -- through the real convertContextToTableDefinition, from a real (or
 * default) ExuluContext -- rather than a hand-built table that already
 * carries `schema` (Task 4 fix round 2, Critical: that was exactly the
 * shortcut that let the converter's dropped `schema` property go unnoticed
 * by round 1's version of this file). `table.type` comes back "items" for
 * real now, so `[ctx]` is passed as `contexts` -- postprocessUpdate's
 * embedder/processor branch needs to find a context by id to decide there's
 * nothing to do (`ctx.embedder` is undefined here, so it returns early).
 */
function makeGraphqlMutations(ctx: ExuluContext = makeContext()) {
  const table = convertContextToTableDefinition(ctx);
  return createMutations(table, [ctx], [], [], {} as any);
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

  // --- Review Focus 5: two SERIALIZED merges both survive -------------------
  //
  // Wording corrected (Task 4 fix round 2, Important 5): what these two
  // tests actually prove is that two merges, run one after the other (fully
  // awaited, no overlap), both land.
  //
  // Final review, Important 7: this note used to be the ONLY place the
  // limitation was written down, while the SDL description and the
  // model-facing `merge` description both still promised "other stored keys
  // are kept" unconditionally. Both now carry it, as does item-write.ts's
  // module doc -- asserted by the three source-level tests above, because a
  // documentation surface regresses silently otherwise. That is weaker than "concurrent-safe"
  // and this file no longer claims the stronger thing. Fetch-then-write is
  // two separate statements here, with no transaction, no row lock, and no
  // SQL-side `jsonb_set` -- two GENUINELY concurrent merges (both reading
  // the row before either writes) can still race and lose one's key, the
  // same lost-update shape any read-modify-write without locking has. Not
  // fixed in this round: the coordinator's own ruling is that adding
  // locking is a deliberate, separate decision with performance
  // consequences, not something to slip into a fix round. Flagged as a
  // known limitation in the task report.
  it("two merges on different keys both survive (same path, run one after the other)", async () => {
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

  it("two merges on different keys both survive, run one after the other ACROSS the tool path and the GraphQL path", async () => {
    // The strongest form of the parity claim this file makes: not just
    // "each path's own merge is non-destructive" but "the two independent
    // implementations can edit the same row one after the other and
    // neither clobbers the other's prior edit" -- the SERIALIZED form of
    // the M&V two-analysts-editing-the-same-matrix scenario the spec names
    // (wording corrected, Task 4 fix round 2, Important 5: this is NOT a
    // test of concurrent/racing writes -- see the describe block's own
    // note above and the task report's "known limitation" section).
    // Reverting either path's routing through prepareItemWrite would turn
    // its half of this into a silent REPLACE, dropping a DIFFERENT
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

    it("SUPERSEDED by fix round 4's Critical ruling: through the GraphQL path, a plain (non-merge) null on a non-nullable schema is now accepted, not refused", async () => {
      // Formerly: refused ("the value must be a JSON object... but null
      // was sent"). Fix round 4's ruling: a schema describes the shape of
      // a value that EXISTS; whether a column may be null is `required`'s
      // question, not the schema's. A plain REPLACE's top-level null is
      // now exempt from schema validation entirely, through the GraphQL
      // path exactly like the tool path.
      const existingFelder = { budget_gesamt: { wert: "OLD", konfidenz: "low" } };
      const { db, row } = makeFakeDb({ [TABLE_NAME]: { r1: { name: "A", felder: existingFelder } } });
      sharedDb = db;

      const updateOneById = makeGraphqlMutations()[`${TABLE_NAME}UpdateOneById`];
      await updateOneById(null, { id: "r1", input: { felder: null } }, graphqlContext(), {});

      expect(row(TABLE_NAME, "r1")!.felder).toBeNull();
    });

    it("the exemption is REPLACE-only through the GraphQL path too: the identical null under merge is still refused", async () => {
      const existingFelder = { budget_gesamt: { wert: "OLD", konfidenz: "low" } };
      const { db, row } = makeFakeDb({ [TABLE_NAME]: { r1: { name: "A", felder: existingFelder } } });
      sharedDb = db;

      const updateOneById = makeGraphqlMutations()[`${TABLE_NAME}UpdateOneById`];
      await expect(
        updateOneById(null, { id: "r1", input: { felder: null }, merge: ["felder"] }, graphqlContext(), {}),
      ).rejects.toThrow(/merge/i);

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

  // --- Final review, Important 7: the claim is corrected where it is read --
  //
  // The serialized-only limitation used to be documented ONLY inside this
  // file (see the describe block below), while both places a human and a
  // model actually read the promise still stated it unconditionally. Same
  // style of source-level check as the two SDL tests above, for the same
  // reason: these are documentation surfaces, and the thing that regresses
  // is the text.
  it("every SDL merge description says merge is not concurrency-safe, and that an unmatched name is refused", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.join(__dirname, "../graphql/schemas/index.ts"), "utf8");

    const descriptions = source.match(/merge: names of json fields[\s\S]*?"""/g);
    expect(descriptions).not.toBeNull();
    // Both UpdateOne and UpdateOneById carry one.
    expect(descriptions!.length).toBe(2);
    for (const description of descriptions as string[]) {
      expect(description).toContain("NOT concurrency-safe");
      expect(description).toContain("refused, not ignored");
    }
  });

  it("the model-facing merge description says the same two things", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.join(__dirname, "../templates/tools/context-write-tools.ts"),
      "utf8",
    );
    const start = source.indexOf("Names of json fields in THIS call");
    expect(start).toBeGreaterThan(-1);
    // The description is one multi-line concatenation; slice forward from
    // its first line rather than trying to match its closing paren, which
    // appears inside the template expressions it interpolates.
    const description = source.slice(start, start + 1500);
    expect(description).toContain("refused, not ignored");
    // Phrase chosen to sit inside one source line: the description is a
    // multi-line concatenation, so a longer phrase would straddle a break.
    expect(description).toContain("Do not run two merges on the same item");
  });

  it("item-write.ts's own module doc states the concurrency limitation too", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.join(__dirname, "item-write.ts"), "utf8");
    expect(source).toContain("Merge is not concurrency-safe");
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

  // --- Important 3 (coordinator ruling): the existing-row fetch is gated --
  //
  // `prepareItemWrite` only reads `existing` inside its merge branch, so
  // with no `merge` on a call that row is never consulted. The fetch used
  // to run unconditionally -- one wasted `SELECT *` round trip per update,
  // on every table, every time. Stored values are IDENTICAL whether the
  // fetch runs or not when there's no merge (that's the point -- it's
  // dead weight, not a behaviour change), so only a call-count check can
  // actually tell the gated and ungated versions apart.
  describe("the existing-row fetch only happens when merge is actually requested", () => {
    it("UpdateOneById does not fetch the existing row at all when merge is absent, but does when merge is present", async () => {
      const seedRow = { name: "A", felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } };
      const { db, firstCallCount } = makeFakeDb({ [TABLE_NAME]: { r1: { ...seedRow } } });
      sharedDb = db;
      const updateOneById = makeGraphqlMutations()[`${TABLE_NAME}UpdateOneById`];

      const beforeNoMerge = firstCallCount();
      await updateOneById(null, { id: "r1", input: { name: "B" } }, graphqlContext(), {});
      // Only the post-write result re-fetch (unconditional, unrelated to
      // this gate) should have run -- the existing-row fetch must not have.
      expect(firstCallCount() - beforeNoMerge).toBe(1);

      const beforeWithMerge = firstCallCount();
      await updateOneById(
        null,
        { id: "r1", input: { felder: { zielgruppe: { wert: "x", konfidenz: "low" } } }, merge: ["felder"] },
        graphqlContext(),
        {},
      );
      // Now BOTH the existing-row fetch and the post-write re-fetch ran.
      expect(firstCallCount() - beforeWithMerge).toBe(2);
    });

    it("UpdateOne does not fetch the existing row at all when merge is absent, but does when merge is present", async () => {
      const seedRow = { name: "A", felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } };
      const { db, firstCallCount } = makeFakeDb({ [TABLE_NAME]: { r1: { ...seedRow } } });
      sharedDb = db;
      const updateOne = makeGraphqlMutations()[`${TABLE_NAME}UpdateOne`];

      const beforeNoMerge = firstCallCount();
      await updateOne(null, { where: [{ id: { eq: "r1" } }], input: { name: "B" } }, graphqlContext(), {});
      // Only UpdateOne's own unconditional "find the row by `where`" fetch
      // should have run -- the existing-row fetch for merge must not have.
      expect(firstCallCount() - beforeNoMerge).toBe(1);

      const beforeWithMerge = firstCallCount();
      await updateOne(
        null,
        {
          where: [{ id: { eq: "r1" } }],
          input: { felder: { zielgruppe: { wert: "x", konfidenz: "low" } } },
          merge: ["felder"],
        },
        graphqlContext(),
        {},
      );
      expect(firstCallCount() - beforeWithMerge).toBe(2);
    });
  });

  // --- Important 1 (coordinator ruling): creates validate too, no merge ---
  //
  // The design spec's own "Left to the builder" left this open; the ruling
  // closes it: validation only (there is no existing row to merge into).
  // Goal 2 has the generated CREATE tool expose the schema to the model, so
  // without this the model is SHOWN the shape on create and gets no
  // refusal for violating it, while the identical shape on update was
  // refused. `upsert: true` (`insert.onConflict().merge()`) is an update in
  // disguise that bulk import uses, so it is covered the same way.
  describe("creates validate too (no merge semantics -- there is nothing to merge into)", () => {
    it("the tool path's createItem refuses a schema violation before any insert happens", async () => {
      const { db, row } = makeFakeDb({ [TABLE_NAME]: {} });
      sharedDb = db;
      const ctx = makeContext();

      await expect(
        ctx.createItem(
          { id: "c1", name: "A", felder: { budget_gesamt: { wert: "1000", konfidenz: "sehr hoch" } } } as any,
          {} as any,
        ),
      ).rejects.toThrow(/budget_gesamt\.konfidenz/);

      expect(row(TABLE_NAME, "c1")).toBeUndefined();
    });

    it("the tool path's createItem still succeeds for a valid value (backward-compat baseline)", async () => {
      const { db, row } = makeFakeDb({ [TABLE_NAME]: {} });
      sharedDb = db;
      const ctx = makeContext();

      await ctx.createItem(
        { id: "c1", name: "A", felder: { budget_gesamt: { wert: "1000", konfidenz: "low" } } } as any,
        {} as any,
      );

      expect(row(TABLE_NAME, "c1")!.felder).toEqual({ budget_gesamt: { wert: "1000", konfidenz: "low" } });
    });

    it("the tool path's createItem with upsert:true (an update in disguise) also refuses a schema violation", async () => {
      const existingFelder = { budget_gesamt: { wert: "OLD", konfidenz: "low" } };
      const { db, row } = makeFakeDb({ [TABLE_NAME]: { c1: { name: "A", felder: existingFelder } } });
      sharedDb = db;
      const ctx = makeContext();

      await expect(
        ctx.createItem(
          { id: "c1", name: "A", felder: { budget_gesamt: { wert: "NEW", konfidenz: "sehr hoch" } } } as any,
          {} as any,
          undefined,
          undefined,
          true, // upsert
        ),
      ).rejects.toThrow(/budget_gesamt\.konfidenz/);

      // The upsert never ran -- the row that was there before is still there.
      expect(row(TABLE_NAME, "c1")!.felder).toEqual(existingFelder);
    });

    it("the GraphQL CreateOne resolver refuses a schema violation before any insert happens", async () => {
      const { db, row } = makeFakeDb({ [TABLE_NAME]: {} });
      sharedDb = db;

      const createOne = makeGraphqlMutations()[`${TABLE_NAME}CreateOne`];
      await expect(
        createOne(
          null,
          { input: { id: "c1", name: "A", felder: { budget_gesamt: { wert: "1000", konfidenz: "sehr hoch" } } } },
          graphqlContext(),
          {},
        ),
      ).rejects.toThrow(/budget_gesamt\.konfidenz/);

      expect(row(TABLE_NAME, "c1")).toBeUndefined();
    });

    it("the GraphQL CreateOne resolver with upsert:true (the door bulk import uses) also refuses a schema violation", async () => {
      const existingFelder = { budget_gesamt: { wert: "OLD", konfidenz: "low" } };
      const { db, row } = makeFakeDb({ [TABLE_NAME]: { c1: { name: "A", felder: existingFelder } } });
      sharedDb = db;

      const createOne = makeGraphqlMutations()[`${TABLE_NAME}CreateOne`];
      await expect(
        createOne(
          null,
          {
            input: { id: "c1", name: "A", felder: { budget_gesamt: { wert: "NEW", konfidenz: "sehr hoch" } } },
            upsert: true,
          },
          graphqlContext(),
          {},
        ),
      ).rejects.toThrow(/budget_gesamt\.konfidenz/);

      expect(row(TABLE_NAME, "c1")!.felder).toEqual(existingFelder);
    });
  });

  // --- Fix round 3: the actual import-pipeline bug, through the real
  // --- context.ts write paths, not a hand-built parsed object -------------
  //
  // src/exulu/import/coerce.ts validates a json cell with JSON.parse and
  // deliberately returns the STRING (confirmed by reading it, not assumed):
  // `case "json": { try { JSON.parse(trimmed); return { raw, value: trimmed
  // }; } catch { return err(raw, "json"); } }`. That string then flows,
  // completely unchanged, through rows.ts's `cellValues`/`buildCreateInput`/
  // `buildUpdateInput` into `context.createItem`/`updateItem`'s own `item`
  // object -- exactly what these tests build by hand with `JSON.stringify`,
  // never a pre-parsed object, so this exercises the real string-valued
  // path the bug report named, not a shape that only looks like it.
  describe("the import pipeline's own wire form (a JSON string, coerce.ts) now reaches the chokepoint correctly", () => {
    it("context.updateItem accepts a valid import cell string for a schema-carrying field", async () => {
      const { db, row } = makeFakeDb({
        [TABLE_NAME]: { r1: { name: "A", felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } } },
      });
      sharedDb = db;
      const ctx = makeContext();

      // Exactly coerceValue's own return shape for a json cell: `{ raw, value: trimmed }`.
      const importCellValue = JSON.stringify({ budget_gesamt: { wert: "1000", konfidenz: "low" } });
      await ctx.updateItem({ id: "r1", felder: importCellValue } as any, {} as any);

      expect(row(TABLE_NAME, "r1")!.felder).toEqual({ budget_gesamt: { wert: "1000", konfidenz: "low" } });
    });

    it("context.updateItem refuses an import cell string whose PARSED content violates the schema, with the real leaf violation -- not 'a string was sent'", async () => {
      const existingFelder = { budget_gesamt: { wert: "OLD", konfidenz: "low" } };
      const { db, row } = makeFakeDb({ [TABLE_NAME]: { r1: { name: "A", felder: existingFelder } } });
      sharedDb = db;
      const ctx = makeContext();

      // THE EXACT REPORTED REPRO, as coerceValue would actually hand it over.
      const badImportCellValue = JSON.stringify({ budget_gesamt: { wert: "1000", konfidenz: "sehr hoch" } });

      let message: string | undefined;
      try {
        await ctx.updateItem({ id: "r1", felder: badImportCellValue } as any, {} as any);
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }

      expect(message).toBeDefined();
      expect(message).toContain("budget_gesamt.konfidenz");
      expect(message).toContain("sehr hoch");
      expect(message).not.toContain("a string was sent");
      // The write never happened -- the stored row is untouched.
      expect(row(TABLE_NAME, "r1")!.felder).toEqual(existingFelder);
    });

    it("context.createItem (bulk import's create path) accepts a valid import cell string", async () => {
      const { db, row } = makeFakeDb({ [TABLE_NAME]: {} });
      sharedDb = db;
      const ctx = makeContext();

      const importCellValue = JSON.stringify({ budget_gesamt: { wert: "1000", konfidenz: "low" } });
      await ctx.createItem({ id: "c1", name: "A", felder: importCellValue } as any, {} as any);

      expect(row(TABLE_NAME, "c1")!.felder).toEqual({ budget_gesamt: { wert: "1000", konfidenz: "low" } });
    });
  });

  // --- Fix round 4, Critical: the real coerce -> createItem path, not a
  // --- hand-built { felder: null } -----------------------------------------
  //
  // The coordinator's own instruction: a hand-built null proves less than
  // the actual shape that broke. `coerceValue` (src/exulu/import/coerce.ts)
  // is the REAL function the import pipeline calls per cell; this drives
  // its own output straight into `context.createItem`/`updateItem` and the
  // GraphQL `CreateOne` resolver, exactly the way `rows.ts`'s
  // `cellValues`/`buildCreateInput`/`buildUpdateInput` would.
  describe("a blank CSV cell on a schema-carrying json column (fix round 4, Critical, real coerce.ts output)", () => {
    const blankCell = coerceValue({ name: "felder", type: "json" }, "");

    it("coerceValue itself maps a blank cell to a literal null, not '' and not an error -- confirms the actual input shape before trusting it", () => {
      expect(blankCell).toEqual({ raw: "", value: null });
      expect(blankCell.error).toBeUndefined();
    });

    it("context.createItem accepts a real blank-cell row (bulk import's create path) instead of refusing it as 'the wrong shape'", async () => {
      const { db, row } = makeFakeDb({ [TABLE_NAME]: {} });
      sharedDb = db;
      const ctx = makeContext();

      await ctx.createItem({ id: "c1", name: "A", felder: blankCell.value } as any, {} as any);

      expect(row(TABLE_NAME, "c1")!.felder).toBeNull();
    });

    it("context.updateItem accepts a real blank-cell row (bulk import's update path) on a row that already has data", async () => {
      const { db, row } = makeFakeDb({
        [TABLE_NAME]: { r1: { name: "A", felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } } },
      });
      sharedDb = db;
      const ctx = makeContext();

      await ctx.updateItem({ id: "r1", felder: blankCell.value } as any, {} as any);

      expect(row(TABLE_NAME, "r1")!.felder).toBeNull();
    });

    it("the GraphQL CreateOne resolver (the import door bulk import's worker-deps.ts doesn't use, but artifacts/API callers could) also accepts it", async () => {
      const { db, row } = makeFakeDb({ [TABLE_NAME]: {} });
      sharedDb = db;

      const createOne = makeGraphqlMutations()[`${TABLE_NAME}CreateOne`];
      await createOne(null, { input: { id: "c1", name: "A", felder: blankCell.value } }, graphqlContext(), {});

      expect(row(TABLE_NAME, "c1")!.felder).toBeNull();
    });

    it("a blank cell under merge is still refused -- the exemption is replace-only, proven through the real write path too", async () => {
      const { db, row } = makeFakeDb({
        [TABLE_NAME]: { r1: { name: "A", felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } } },
      });
      sharedDb = db;
      const ctx = makeContext();

      await expect(
        ctx.updateItem(
          { id: "r1", felder: blankCell.value } as any,
          {} as any,
          undefined,
          undefined,
          undefined,
          undefined,
          ["felder"],
        ),
      ).rejects.toThrow(/merge/i);

      expect(row(TABLE_NAME, "r1")!.felder).toEqual({ budget_gesamt: { wert: "OLD", konfidenz: "low" } });
    });
  });

  // --- Fix round 4, Important: merging onto a stored non-object, through
  // --- the real GraphQL write path (what users.favourite_items actually
  // --- uses) ----------------------------------------------------------------
  describe("merging a string patch onto a stored ARRAY is refused through the real GraphQL UpdateOne path (fix round 4, Important)", () => {
    it("THE EXACT REPORTED REPRO: a stringified-object patch merged onto a stored array column is refused, not silently replacing the list", async () => {
      const favouriteFields: ExuluContextFieldDefinition[] = [{ name: "favourite_items", type: "json" }];
      const favouriteCtx = new ExuluContext({
        id: "fav",
        name: "Fav",
        description: "",
        fields: favouriteFields,
        active: true,
        sources: [],
        configuration: { calculateVectors: "manual" },
      } as any);
      const favTable = "fav_items";
      const { db, row } = makeFakeDb({ [favTable]: { u1: { favourite_items: ["a", "b", "c"] } } });
      sharedDb = db;

      const updateOne = makeGraphqlMutations(favouriteCtx)[`${favTable}UpdateOne`];
      await expect(
        updateOne(
          null,
          {
            where: [{ id: { eq: "u1" } }],
            input: { favourite_items: JSON.stringify({ "0": "x" }) },
            merge: ["favourite_items"],
          },
          graphqlContext(),
          {},
        ),
      ).rejects.toThrow(/stored/i);

      // The list is untouched -- not silently collapsed to {"0":"x"}.
      expect(row(favTable, "u1")!.favourite_items).toEqual(["a", "b", "c"]);
    });
  });

  // --- Fix round 5, Important 1: a required json field's null replace is
  // --- refused, through both real write paths -----------------------------
  //
  // The round 4 ruling leaned on `required` already being enforced
  // elsewhere; checked, and found true for only two of four write doors
  // (bulk import's row builder, the generated tool's own input shape) --
  // NOT GraphQL/programmatic writes, where nothing stopped a `required:
  // true` json field being set to `null`, after which every read of it
  // would error against the non-nullable `JSON!` output type.
  describe("a required json field's null replace is refused through the real write paths (fix round 5, Important 1)", () => {
    const requiredFields: ExuluContextFieldDefinition[] = [
      { name: "felder", type: "json", schema: felderSchema, required: true },
    ];

    it("context.updateItem (the tool path) refuses it", async () => {
      const { db, row } = makeFakeDb({
        [TABLE_NAME]: { r1: { name: "A", felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } } },
      });
      sharedDb = db;
      const ctx = new ExuluContext({
        id: CONTEXT_ID,
        name: "Docs",
        description: "",
        fields: requiredFields,
        active: true,
        sources: [],
        configuration: { calculateVectors: "manual" },
      } as any);

      await expect(ctx.updateItem({ id: "r1", felder: null } as any, {} as any)).rejects.toThrow(/required/i);

      expect(row(TABLE_NAME, "r1")!.felder).toEqual({ budget_gesamt: { wert: "OLD", konfidenz: "low" } });
    });

    it("the GraphQL UpdateOneById resolver (what artifacts use) also refuses it -- it was the door with nothing else enforcing required at all", async () => {
      const { db, row } = makeFakeDb({
        [TABLE_NAME]: { r1: { name: "A", felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } } },
      });
      sharedDb = db;
      const requiredCtx = new ExuluContext({
        id: CONTEXT_ID,
        name: "Docs",
        description: "",
        fields: requiredFields,
        active: true,
        sources: [],
        configuration: { calculateVectors: "manual" },
      } as any);

      const updateOneById = makeGraphqlMutations(requiredCtx)[`${TABLE_NAME}UpdateOneById`];
      await expect(
        updateOneById(null, { id: "r1", input: { felder: null } }, graphqlContext(), {}),
      ).rejects.toThrow(/required/i);

      expect(row(TABLE_NAME, "r1")!.felder).toEqual({ budget_gesamt: { wert: "OLD", konfidenz: "low" } });
    });

    it("a NON-required field's null replace is unaffected, through the same real GraphQL path (FIELDS, no required)", async () => {
      const { db, row } = makeFakeDb({
        [TABLE_NAME]: { r1: { name: "A", felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } } },
      });
      sharedDb = db;

      const updateOneById = makeGraphqlMutations()[`${TABLE_NAME}UpdateOneById`];
      await updateOneById(null, { id: "r1", input: { felder: null } }, graphqlContext(), {});

      expect(row(TABLE_NAME, "r1")!.felder).toBeNull();
    });
  });
  // --- Final review, Important 1: an unmatched `merge` entry, through both
  // --- real write paths ---------------------------------------------------
  //
  // The reported repro, run through the two implementations that actually
  // ship it: `merge: ["Felder"]` (capital F) matched no field name, so the
  // value fell through to the REPLACE branch and the write succeeded having
  // deleted every stored key the patch did not mention. Each half of this
  // was confirmed by reverting the chokepoint's new check and watching the
  // stored row lose `zielgruppe` with `ok: true`.
  describe("a merge entry naming no json field in this write is refused on both paths (final review, Important 1)", () => {
    const existingFelder = {
      budget_gesamt: { wert: "OLD", konfidenz: "low" },
      zielgruppe: { wert: "UNTOUCHED", konfidenz: "medium" },
    };

    it("context.updateItem (the tool path) refuses it, and the other stored key survives", async () => {
      const { db, row } = makeFakeDb({ [TABLE_NAME]: { r1: { name: "A", felder: existingFelder } } });
      sharedDb = db;
      const ctx = makeContext();

      await expect(
        ctx.updateItem(
          { id: "r1", felder: { budget_gesamt: { wert: "NEW", konfidenz: "high" } } } as any,
          {} as any,
          undefined,
          undefined,
          undefined,
          undefined,
          ["Felder"],
        ),
      ).rejects.toThrow(/merge/i);

      expect(row(TABLE_NAME, "r1")!.felder).toEqual(existingFelder);
    });

    it("the GraphQL UpdateOneById resolver refuses it identically, and the other stored key survives", async () => {
      const { db, row } = makeFakeDb({ [TABLE_NAME]: { r1: { name: "A", felder: existingFelder } } });
      sharedDb = db;

      const updateOneById = makeGraphqlMutations()[`${TABLE_NAME}UpdateOneById`];
      await expect(
        updateOneById(
          null,
          {
            id: "r1",
            input: { felder: { budget_gesamt: { wert: "NEW", konfidenz: "high" } } },
            merge: ["Felder"],
          },
          graphqlContext(),
          {},
        ),
      ).rejects.toThrow(/merge/i);

      expect(row(TABLE_NAME, "r1")!.felder).toEqual(existingFelder);
    });

    it("the GraphQL UpdateOne resolver (the `where`-based sibling) refuses it too", async () => {
      const { db, row } = makeFakeDb({ [TABLE_NAME]: { r1: { name: "A", felder: existingFelder } } });
      sharedDb = db;

      const updateOne = makeGraphqlMutations()[`${TABLE_NAME}UpdateOne`];
      await expect(
        updateOne(
          null,
          {
            where: [{ id: { eq: "r1" } }],
            input: { felder: { budget_gesamt: { wert: "NEW", konfidenz: "high" } } },
            merge: ["Felder"],
          },
          graphqlContext(),
          {},
        ),
      ).rejects.toThrow(/merge/i);

      expect(row(TABLE_NAME, "r1")!.felder).toEqual(existingFelder);
    });

    it("the correctly-spelled entry still merges on both paths -- the check refuses typos, not merge", async () => {
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
  });

  // --- Final review, Important 2: the no-schema path is absolutely
  // --- unchanged, through the door that actually regressed ----------------
  //
  // Fix round 5 scoped its `required` rule to json and not to
  // schema-carrying json, so a `required: true` json column with NO
  // declared schema -- twelve of them across eleven live tables -- started
  // throwing on a write that clears it. GraphQL is the door those clients
  // use.
  describe("a required json field with NO schema still accepts null on both paths (final review, Important 2)", () => {
    const requiredNoSchemaFields: ExuluContextFieldDefinition[] = [
      { name: "name", type: "text" },
      { name: "notes", type: "json", required: true }, // no schema -- as every live required json column is today
    ];
    const makeNoSchemaCtx = () =>
      new ExuluContext({
        id: CONTEXT_ID,
        name: "Docs",
        description: "",
        fields: requiredNoSchemaFields,
        active: true,
        sources: [],
        configuration: { calculateVectors: "manual" },
      } as any);

    it("the GraphQL UpdateOneById resolver clears it, exactly as it did before this feature", async () => {
      const { db, row } = makeFakeDb({ [TABLE_NAME]: { r1: { name: "A", notes: { a: 1 } } } });
      sharedDb = db;

      const updateOneById = makeGraphqlMutations(makeNoSchemaCtx())[`${TABLE_NAME}UpdateOneById`];
      await updateOneById(null, { id: "r1", input: { notes: null } }, graphqlContext(), {});

      expect(row(TABLE_NAME, "r1")!.notes).toBeNull();
    });

    it("context.updateItem (the tool path) clears it too", async () => {
      const { db, row } = makeFakeDb({ [TABLE_NAME]: { r1: { name: "A", notes: { a: 1 } } } });
      sharedDb = db;

      await makeNoSchemaCtx().updateItem({ id: "r1", notes: null } as any, {} as any);

      expect(row(TABLE_NAME, "r1")!.notes).toBeNull();
    });
  });

  // --- Final review, Important 6: required top-level keys on a replace,
  // --- through both real write paths --------------------------------------
  describe("an object-rooted schema's required top-level keys are enforced on a replace (final review, Important 6)", () => {
    const objectSchema = z.object({ a: z.string(), b: z.string() });
    const objectFields: ExuluContextFieldDefinition[] = [
      { name: "name", type: "text" },
      { name: "felder", type: "json", schema: objectSchema },
    ];
    const makeObjectCtx = () =>
      new ExuluContext({
        id: CONTEXT_ID,
        name: "Docs",
        description: "",
        fields: objectFields,
        active: true,
        sources: [],
        configuration: { calculateVectors: "manual" },
      } as any);

    it("the GraphQL CreateOne resolver refuses an incomplete value before any insert happens", async () => {
      const { db, row } = makeFakeDb({ [TABLE_NAME]: {} });
      sharedDb = db;

      const createOne = makeGraphqlMutations(makeObjectCtx())[`${TABLE_NAME}CreateOne`];
      await expect(
        createOne(null, { input: { id: "c1", name: "A", felder: { a: "x" } } }, graphqlContext(), {}),
      ).rejects.toThrow(/"b"/);

      expect(row(TABLE_NAME, "c1")).toBeUndefined();
    });

    it("context.createItem (the tool path) refuses the same incomplete value", async () => {
      const { db } = makeFakeDb({ [TABLE_NAME]: {} });
      sharedDb = db;

      await expect(
        makeObjectCtx().createItem({ id: "c2", name: "A", felder: { a: "x" } } as any, {} as any),
      ).rejects.toThrow(/"b"/);
    });

    it("a non-merge UPDATE is held to the same completeness, and the stored value is untouched", async () => {
      const { db, row } = makeFakeDb({ [TABLE_NAME]: { r1: { name: "A", felder: { a: "old", b: "old" } } } });
      sharedDb = db;

      const updateOneById = makeGraphqlMutations(makeObjectCtx())[`${TABLE_NAME}UpdateOneById`];
      await expect(
        updateOneById(null, { id: "r1", input: { felder: { a: "x" } } }, graphqlContext(), {}),
      ).rejects.toThrow(/"b"/);

      expect(row(TABLE_NAME, "r1")!.felder).toEqual({ a: "old", b: "old" });
    });

    it("the SAME partial value under merge is accepted and keeps the key it omits", async () => {
      const { db, row } = makeFakeDb({ [TABLE_NAME]: { r1: { name: "A", felder: { a: "old", b: "keep" } } } });
      sharedDb = db;

      const updateOneById = makeGraphqlMutations(makeObjectCtx())[`${TABLE_NAME}UpdateOneById`];
      await updateOneById(null, { id: "r1", input: { felder: { a: "x" } }, merge: ["felder"] }, graphqlContext(), {});

      expect(row(TABLE_NAME, "r1")!.felder).toEqual({ a: "x", b: "keep" });
    });

    it("{} still clears the field -- the documented escape stays open through the real path", async () => {
      const { db, row } = makeFakeDb({ [TABLE_NAME]: { r1: { name: "A", felder: { a: "old", b: "old" } } } });
      sharedDb = db;

      const updateOneById = makeGraphqlMutations(makeObjectCtx())[`${TABLE_NAME}UpdateOneById`];
      await updateOneById(null, { id: "r1", input: { felder: {} } }, graphqlContext(), {});

      expect(row(TABLE_NAME, "r1")!.felder).toEqual({});
    });
  });
});
