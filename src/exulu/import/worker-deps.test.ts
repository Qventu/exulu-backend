// Module mocks are hoisted above imports (jest.mock factory pattern used
// across the repo, e.g. src/exulu/email-inbound/intake.test.ts).
const uploadFileSpy = jest.fn(async () => "test-bucket/imports/ctx-1/job-1-errors.csv");
jest.mock("@SRC/uppy", () => ({
  uploadFile: (...args: any[]) => uploadFileSpy(...args),
}));
// The grant writer the create closure must call after a create (C2) -- mocked
// the same way every other suite that touches it does
// (src/graphql/mutations/create-rights-mode.test.ts).
const handleRBACUpdateSpy = jest.fn(async () => undefined);
jest.mock("@EE/rbac-update.ts", () => ({
  handleRBACUpdate: (...args: any[]) => handleRBACUpdateSpy(...args),
}));

import knexFactory from "knex";
import {
  buildWorkerDeps,
  canWrite,
  finalizeCancelled,
  isCancelRequested,
  lookupExisting,
  uploadErrorReport,
  writeProgress,
} from "./worker-deps";
import type { BuildWorkerDepsInput } from "./worker-deps";
import type { ExistingRow, RunImportResult } from "./run-import";

beforeEach(() => {
  uploadFileSpy.mockClear();
  handleRBACUpdateSpy.mockClear();
});

// Connectionless real knex instance (same pattern as
// src/exulu/memory/recall-collector.rbac.test.ts): lets `db.raw(...)`
// compile genuine SQL -- via `.toString()` -- without a live database, so
// the atomic-merge raw expression can be asserted on verbatim instead of
// guessed at through a hand-rolled fake.
const k = knexFactory({ client: "pg" });

/** Fake `job_results` query builder: records every call, `db.raw` is real. */
function fakeJobResultsDb(opts: { first?: any } = {}) {
  const calls: Record<string, any[][]> = {};
  const builder: any = {};
  const record =
    (name: string) =>
    (...args: any[]) => {
      (calls[name] ||= []).push(args);
      return builder;
    };
  builder.where = record("where");
  builder.whereIn = record("whereIn");
  builder.select = record("select");
  builder.first = jest.fn(async () => opts.first);
  builder.update = jest.fn(async () => 1);
  const db: any = jest.fn(() => builder);
  db.raw = (...args: any[]) => k.raw(...args);
  return { db, calls, builder };
}

describe("canWrite", () => {
  const user = { id: 7 };

  it("grants a super_admin regardless of rights_mode", () => {
    const existing: ExistingRow = {
      id: "i1",
      external_id: null,
      rights_mode: "private",
      created_by: "99",
    };
    expect(canWrite(existing, { id: 7, super_admin: true })).toBe(true);
  });

  it("grants write on a public record to anyone", () => {
    const existing: ExistingRow = { id: "i1", external_id: null, rights_mode: "public", created_by: "99" };
    expect(canWrite(existing, user)).toBe(true);
  });

  it("grants write on a private record to its creator", () => {
    const existing: ExistingRow = { id: "i1", external_id: null, rights_mode: "private", created_by: "7" };
    expect(canWrite(existing, user)).toBe(true);
  });

  it("denies write on a private record to a non-creator", () => {
    const existing: ExistingRow = { id: "i1", external_id: null, rights_mode: "private", created_by: "99" };
    expect(canWrite(existing, user)).toBe(false);
  });

  it("lets the creator write their own record regardless of rights_mode", () => {
    const existing: ExistingRow = {
      id: "i1",
      external_id: null,
      rights_mode: "users",
      created_by: "7",
      RBAC: [],
    };
    expect(canWrite(existing, user)).toBe(true);
  });

  it("grants write via a users-RBAC write grant", () => {
    const existing: ExistingRow = {
      id: "i1",
      external_id: null,
      rights_mode: "users",
      created_by: "99",
      RBAC: [{ access_type: "User", user_id: 7, rights: "write" }],
    };
    expect(canWrite(existing, user)).toBe(true);
  });

  it("denies a users-RBAC grant that is read-only", () => {
    const existing: ExistingRow = {
      id: "i1",
      external_id: null,
      rights_mode: "users",
      created_by: "99",
      RBAC: [{ access_type: "User", user_id: 7, rights: "read" }],
    };
    expect(canWrite(existing, user)).toBe(false);
  });

  it("denies a users-RBAC grant that belongs to a different user", () => {
    const existing: ExistingRow = {
      id: "i1",
      external_id: null,
      rights_mode: "users",
      created_by: "99",
      RBAC: [{ access_type: "User", user_id: 42, rights: "write" }],
    };
    expect(canWrite(existing, user)).toBe(false);
  });

  it("grants write via a roles-RBAC write grant, matching an unhydrated role id", () => {
    const existing: ExistingRow = {
      id: "i1",
      external_id: null,
      rights_mode: "roles",
      created_by: "99",
      RBAC: [{ access_type: "Role", role_id: "role-1", rights: "write" }],
    };
    expect(canWrite(existing, { id: 7, role: "role-1" })).toBe(true);
  });

  it("grants write via a roles-RBAC write grant, matching a hydrated role object", () => {
    const existing: ExistingRow = {
      id: "i1",
      external_id: null,
      rights_mode: "roles",
      created_by: "99",
      RBAC: [{ access_type: "Role", role_id: "role-1", rights: "write" }],
    };
    expect(canWrite(existing, { id: 7, role: { id: "role-1" } })).toBe(true);
  });

  it("denies roles-shared records when the user has no role", () => {
    const existing: ExistingRow = {
      id: "i1",
      external_id: null,
      rights_mode: "roles",
      created_by: "99",
      RBAC: [{ access_type: "Role", role_id: "role-1", rights: "write" }],
    };
    expect(canWrite(existing, user)).toBe(false);
  });

  it("grants write via a teams-RBAC write grant, matching an unhydrated team id", () => {
    const existing: ExistingRow = {
      id: "i1",
      external_id: null,
      rights_mode: "teams",
      created_by: "99",
      RBAC: [{ access_type: "Team", team_id: "team-1", rights: "write" }],
    };
    expect(canWrite(existing, { id: 7, team: "team-1" })).toBe(true);
  });

  it("grants write via a teams-RBAC write grant, matching a hydrated team object", () => {
    const existing: ExistingRow = {
      id: "i1",
      external_id: null,
      rights_mode: "teams",
      created_by: "99",
      RBAC: [{ access_type: "Team", team_id: "team-1", rights: "write" }],
    };
    expect(canWrite(existing, { id: 7, team: { id: "team-1" } })).toBe(true);
  });

  it("denies teams-shared records when the user has no team", () => {
    const existing: ExistingRow = {
      id: "i1",
      external_id: null,
      rights_mode: "teams",
      created_by: "99",
      RBAC: [{ access_type: "Team", team_id: "team-1", rights: "write" }],
    };
    expect(canWrite(existing, user)).toBe(false);
  });

  it("denies a teams-RBAC grant that belongs to a different team", () => {
    const existing: ExistingRow = {
      id: "i1",
      external_id: null,
      rights_mode: "teams",
      created_by: "99",
      RBAC: [{ access_type: "Team", team_id: "team-2", rights: "write" }],
    };
    expect(canWrite(existing, { id: 7, team: "team-1" })).toBe(false);
  });
});

describe("lookupExisting", () => {
  function fakeDb() {
    const calls: Record<string, any[][]> = {};
    const builders: Record<string, any> = {};
    const builderFor = (table: string, result: any[]) => {
      const builder: any = {};
      builder.select = (...args: any[]) => {
        (calls[`${table}.select`] ||= []).push(args);
        return builder;
      };
      builder.whereIn = (...args: any[]) => {
        (calls[`${table}.whereIn`] ||= []).push(args);
        return Promise.resolve(result);
      };
      builder.where = (...args: any[]) => {
        (calls[`${table}.where`] ||= []).push(args);
        return builder;
      };
      return builder;
    };
    return { calls, builderFor };
  }

  it("fetches matching rows by id or external_id and attaches their RBAC grants in one extra query", async () => {
    const { calls, builderFor } = fakeDb();
    const items = [
      { id: "i1", external_id: "e1", rights_mode: "users", created_by: "1" },
      { id: "i2", external_id: null, rights_mode: "private", created_by: "2" },
    ];
    const grants = [{ target_resource_id: "i1", access_type: "User", user_id: 7, rights: "write" }];
    const db: any = jest.fn((table: string) => {
      if (table === "ctx_items") {
        // First call looks up by id, second by external_id -- both share the
        // same fixture rows here since the test only cares about the shape.
        return builderFor(table, items);
      }
      if (table === "rbac") {
        return builderFor(table, grants);
      }
      throw new Error(`unexpected table ${table}`);
    });

    // "i1" the query *input* must be a uuid to survive F3's PK-shape filter --
    // it is unrelated to the fixture rows' own `id` values, which the fake's
    // whereIn returns unconditionally regardless of args.
    const validUuid = "11111111-1111-1111-1111-111111111111";
    const rows = await lookupExisting(db, "ctx_items", [validUuid], ["e1"]);

    expect(rows).toEqual([
      { id: "i1", external_id: "e1", rights_mode: "users", created_by: "1", RBAC: [grants[0]] },
      { id: "i2", external_id: null, rights_mode: "private", created_by: "2", RBAC: [] },
    ]);
    expect(calls["rbac.where"]).toEqual([[{ entity: "ctx_items" }]]);
  });

  it("returns an empty array without querying when both id and external_id lists are empty", async () => {
    const db: any = jest.fn(() => {
      throw new Error("db should not be queried");
    });
    expect(await lookupExisting(db, "ctx_items", [], [])).toEqual([]);
  });

  it("filters out non-uuid CSV ids before querying the uuid primary key, keeping any valid uuid", async () => {
    const { calls, builderFor } = fakeDb();
    const validUuid = "123e4567-e89b-12d3-a456-426614174000";
    const items = [{ id: validUuid, external_id: null, rights_mode: "private", created_by: "1" }];
    const db: any = jest.fn((table: string) => builderFor(table, items));

    await lookupExisting(db, "ctx_items", ["SKU-1", validUuid], []);

    expect(calls["ctx_items.whereIn"]).toEqual([["id", [validUuid]]]);
  });

  it("issues no id query at all when every CSV id is non-uuid (e.g. a SKU code)", async () => {
    const db: any = jest.fn(() => {
      throw new Error("db should not be queried -- no uuid-shaped id and no external_id to look up");
    });

    const rows = await lookupExisting(db, "ctx_items", ["SKU-1", "SKU-2"], []);

    expect(rows).toEqual([]);
  });

  it("still queries by external_id (a text column, left unfiltered) even when every id is non-uuid", async () => {
    const { calls, builderFor } = fakeDb();
    const items = [{ id: "123e4567-e89b-12d3-a456-426614174000", external_id: "SKU-1", rights_mode: "private", created_by: "1" }];
    const db: any = jest.fn((table: string) => builderFor(table, items));

    const rows = await lookupExisting(db, "ctx_items", ["SKU-1"], ["SKU-1"]);

    expect(calls["ctx_items.whereIn"]).toEqual([["external_id", ["SKU-1"]]]);
    expect(rows).toEqual([{ ...items[0], RBAC: [] }]);
  });

  it("skips the rbac grants query entirely when no matched row needs grant-based access", async () => {
    const { calls, builderFor } = fakeDb();
    const validUuid = "22222222-2222-2222-2222-222222222222";
    const items = [{ id: validUuid, external_id: null, rights_mode: "private", created_by: "1" }];
    const db: any = jest.fn((table: string) => {
      if (table === "rbac") throw new Error("rbac should not be queried");
      return builderFor(table, items);
    });

    const rows = await lookupExisting(db, "ctx_items", [validUuid], []);

    expect(rows).toEqual([{ ...items[0], RBAC: [] }]);
    expect(calls["rbac.where"]).toBeUndefined();
  });
});

describe("writeProgress", () => {
  it("merges the new counters into metadata with a single atomic update -- no prior select/first, so a concurrent cancelRequested write can never be read-then-clobbered", async () => {
    const { db, calls, builder } = fakeJobResultsDb();
    const metadata = { total: null, processed: 5, created: 2, updated: 1, failed: 0, invalid: 0 };

    await writeProgress(db, "job-1", metadata);

    expect(calls["select"]).toBeUndefined();
    expect(builder.first).not.toHaveBeenCalled();
    expect(calls["where"]).toEqual([[{ id: "job-1" }]]);
    expect(builder.update).toHaveBeenCalledTimes(1);

    const [values] = builder.update.mock.calls[0]!;
    expect(Object.keys(values)).toEqual(["metadata"]);
    const sql = values.metadata.toString();
    expect(sql).toBe(`coalesce(metadata, '{}'::jsonb) || '${JSON.stringify(metadata)}'::jsonb`);
  });
});

describe("finalizeCancelled", () => {
  const result: RunImportResult = {
    total: 10,
    processed: 10,
    created: 4,
    updated: 3,
    failed: 2,
    invalid: 1,
    durationMs: 1234,
    errorReportKey: "test-bucket/imports/ctx-1/job-1-errors.csv",
    cancelled: true,
    errorReportTruncated: false,
  };

  it("persists state/result/metadata in one update guarded on the row still being active", async () => {
    const { db, calls, builder } = fakeJobResultsDb();

    await finalizeCancelled(db, "job-1", result);

    expect(calls["where"]).toEqual([[{ id: "job-1" }]]);
    expect(calls["whereIn"]).toEqual([["state", ["active"]]]);
    expect(builder.update).toHaveBeenCalledTimes(1);

    const [values] = builder.update.mock.calls[0]!;
    expect(values.state).toBe("cancelled");
    expect(values.result).toBe(JSON.stringify(result));
    expect(values.metadata.toString()).toBe(
      `coalesce(metadata, '{}'::jsonb) || '${JSON.stringify(result)}'::jsonb`,
    );
  });
});

describe("isCancelRequested", () => {
  it("reads metadata.cancelRequested from the row", async () => {
    const builder: any = {
      where: () => builder,
      select: () => builder,
      first: async () => ({ metadata: { cancelRequested: true } }),
    };
    const db: any = jest.fn(() => builder);
    expect(await isCancelRequested(db, "job-1")).toBe(true);
  });

  it("defaults to false when cancelRequested is absent", async () => {
    const builder: any = {
      where: () => builder,
      select: () => builder,
      first: async () => ({ metadata: {} }),
    };
    const db: any = jest.fn(() => builder);
    expect(await isCancelRequested(db, "job-1")).toBe(false);
  });

  it("defaults to false when the row itself is missing", async () => {
    const builder: any = {
      where: () => builder,
      select: () => builder,
      first: async () => undefined,
    };
    const db: any = jest.fn(() => builder);
    expect(await isCancelRequested(db, "job-1")).toBe(false);
  });
});

describe("uploadErrorReport", () => {
  it("uploads the csv under imports/<context>/<jobResultId>-errors.csv and returns uploadFile's bucket/key", async () => {
    const config = { fileUploads: {} } as any;
    const key = await uploadErrorReport("a,b\n1,2", "ctx-1", "job-1", config, 7);

    expect(uploadFileSpy).toHaveBeenCalledTimes(1);
    const [buffer, fileName, passedConfig, options, user, customBucket, global] = uploadFileSpy.mock.calls[0]!;
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.toString("utf-8")).toBe("a,b\n1,2");
    expect(fileName).toBe("imports/ctx-1/job-1-errors.csv");
    expect(passedConfig).toBe(config);
    expect(options).toEqual({ contentType: "text/csv" });
    expect(user).toBe(7);
    expect(customBucket).toBeUndefined();
    expect(global).toBe(true);
    expect(key).toBe("test-bucket/imports/ctx-1/job-1-errors.csv");
  });
});

// The one seam the branch never tested: buildWorkerDeps' create/update
// closures against a fake `context` whose createItem accepts only the real
// item-table column set (no `RBAC` column exists on item tables -- grants
// live in the shared `rbac` table) and reports back what it was handed.
describe("buildWorkerDeps", () => {
  const config = { fileUploads: {} } as any;

  /** Item-table columns an items context really has (src/exulu/context.ts createItemsTable) + this fixture's custom field. */
  const REAL_COLUMNS = new Set([
    "id",
    "external_id",
    "name",
    "description",
    "tags",
    "rights_mode",
    "created_by",
    "qty",
  ]);

  function fakeContext() {
    const createCalls: any[][] = [];
    const updateCalls: any[][] = [];
    const context = {
      createItem: async (...args: any[]) => {
        createCalls.push(args);
        // The real createItem inserts exactly the keys it is given, so a key
        // that is not a column is a Postgres error, not a silent no-op.
        for (const key of Object.keys(args[0] ?? {})) {
          if (!REAL_COLUMNS.has(key)) {
            throw new Error(`column "${key}" of relation "ctx_items" does not exist`);
          }
        }
        return { item: { id: "new-item-1" } };
      },
      updateItem: async (...args: any[]) => {
        updateCalls.push(args);
        for (const key of Object.keys(args[0] ?? {})) {
          if (!REAL_COLUMNS.has(key)) {
            throw new Error(`column "${key}" of relation "ctx_items" does not exist`);
          }
        }
        return { item: { id: args[0]?.id } };
      },
    };
    return { context, createCalls, updateCalls };
  }

  function build(overrides: Partial<BuildWorkerDepsInput> = {}) {
    const { context, createCalls, updateCalls } = fakeContext();
    const db: any = jest.fn(() => ({}));
    const input: BuildWorkerDepsInput = {
      db,
      config,
      context,
      contextId: "ctx",
      jobResultId: "job-1",
      stream: { on: () => undefined, pipe: () => undefined } as any,
      fields: [],
      access: { rights_mode: "private" },
      options: {},
      user: { id: 7, role: "role-1" },
      ...overrides,
    };
    return { deps: buildWorkerDeps(input), createCalls, updateCalls, db };
  }

  it("C1: sets created_by on the create input and never on an update", async () => {
    const { deps, createCalls, updateCalls } = build();

    await deps.createItem({ name: "Shoe", rights_mode: "private" });
    await deps.updateItem("item-9", { name: "Shoe" });

    expect(createCalls[0]![0]).toEqual({ created_by: 7, name: "Shoe", rights_mode: "private" });
    expect(updateCalls[0]![0]).toEqual({ id: "item-9", name: "Shoe" });
    expect(updateCalls[0]![0]).not.toHaveProperty("created_by");
  });

  it("C2: strips RBAC before createItem so only real columns reach the insert", async () => {
    const { deps, createCalls } = build({
      access: { rights_mode: "users", users: [{ id: 3, rights: "write" }], roles: [], teams: [] },
    });

    await deps.createItem({
      name: "Shoe",
      rights_mode: "users",
      // A stray grant payload on the column input must never reach the insert.
      RBAC: { users: [{ id: 3, rights: "write" }] },
    });

    expect(createCalls[0]![0]).not.toHaveProperty("RBAC");
    expect(createCalls[0]![0]).toEqual({ created_by: 7, name: "Shoe", rights_mode: "users" });
  });

  it("C2: writes the batch's grants with handleRBACUpdate after each create, for grant-based modes", async () => {
    const users = [{ id: 3, rights: "write" as const }];
    const roles = [{ id: "role-9", rights: "read" as const }];
    const teams: Array<{ id: string; rights: "read" | "write" }> = [];
    const { deps, db } = build({ access: { rights_mode: "users", users, roles, teams } });

    await deps.createItem({ name: "Shoe", rights_mode: "users" });

    expect(handleRBACUpdateSpy).toHaveBeenCalledTimes(1);
    expect(handleRBACUpdateSpy).toHaveBeenCalledWith(db, "ctx_items", "new-item-1", { users, roles, teams }, []);
  });

  it("N1: a null grant list still reaches handleRBACUpdate as an array it can map over", async () => {
    const { deps, db } = build({
      access: { rights_mode: "users", users: [{ id: 3, rights: "write" }], roles: null } as any,
    });

    await deps.createItem({ name: "Shoe", rights_mode: "users" });

    expect(handleRBACUpdateSpy).toHaveBeenCalledWith(
      db,
      "ctx_items",
      "new-item-1",
      { users: [{ id: 3, rights: "write" }], roles: [], teams: [] },
      [],
    );
  });

  it("C2: writes no grants for private or public batches, and none on an update", async () => {
    for (const rights_mode of ["private", "public"] as const) {
      const { deps } = build({ access: { rights_mode } });
      await deps.createItem({ name: "Shoe", rights_mode });
      expect(handleRBACUpdateSpy).not.toHaveBeenCalled();
    }

    const { deps } = build({
      access: { rights_mode: "users", users: [{ id: 3, rights: "write" }] },
    });
    await deps.updateItem("item-9", { name: "Shoe" });
    expect(handleRBACUpdateSpy).not.toHaveBeenCalled();
  });

  it("passes upsert=false always, and generateEmbeddingsOverwrite=false only when skipEmbeddings is set", async () => {
    const skipping = build({ options: { skipEmbeddings: true } });
    await skipping.deps.createItem({ name: "A" });
    await skipping.deps.updateItem("item-1", { name: "A" });
    expect(skipping.createCalls[0]![4]).toBe(false);
    expect(skipping.createCalls[0]![5]).toBe(false);
    expect(skipping.updateCalls[0]![4]).toBe(false);

    const normal = build({ options: {} });
    await normal.deps.createItem({ name: "A" });
    await normal.deps.updateItem("item-1", { name: "A" });
    expect(normal.createCalls[0]![4]).toBe(false);
    expect(normal.createCalls[0]![5]).toBeUndefined();
    expect(normal.updateCalls[0]![4]).toBeUndefined();
  });

  it("passes the acting user id and the role uuid, from a bare or a hydrated user.role", async () => {
    const bare = build({ user: { id: 7, role: "role-1" } });
    await bare.deps.createItem({ name: "A" });
    expect(bare.createCalls[0]![2]).toBe(7);
    expect(bare.createCalls[0]![3]).toBe("role-1");

    const hydrated = build({ user: { id: 7, role: { id: "role-1", name: "Admin" } } });
    await hydrated.deps.createItem({ name: "A" });
    await hydrated.deps.updateItem("item-1", { name: "A" });
    expect(hydrated.createCalls[0]![3]).toBe("role-1");
    expect(hydrated.updateCalls[0]![3]).toBe("role-1");

    const roleless = build({ user: { id: 7 } });
    await roleless.deps.createItem({ name: "A" });
    expect(roleless.createCalls[0]![3]).toBeUndefined();
  });

  it("I1: carries the row's metadata.total into the deps, ignoring 0/absent/non-numeric values", () => {
    expect(build({ total: 42000 }).deps.total).toBe(42000);
    expect(build({ total: 0 }).deps.total).toBeUndefined();
    expect(build({}).deps.total).toBeUndefined();
    expect(build({ total: null }).deps.total).toBeUndefined();
  });
});
