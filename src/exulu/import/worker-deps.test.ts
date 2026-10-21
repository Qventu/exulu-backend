// Module mocks are hoisted above imports (jest.mock factory pattern used
// across the repo, e.g. src/exulu/email-inbound/intake.test.ts).
const uploadFileSpy = jest.fn(async () => "test-bucket/imports/ctx-1/job-1-errors.csv");
jest.mock("@SRC/uppy", () => ({
  uploadFile: (...args: any[]) => uploadFileSpy(...args),
}));

import { canWrite, isCancelRequested, lookupExisting, uploadErrorReport, writeProgress } from "./worker-deps";
import type { ExistingRow } from "./run-import";

beforeEach(() => {
  uploadFileSpy.mockClear();
});

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

  it("denies teams-shared records -- import jobs carry no team membership", () => {
    const existing: ExistingRow = {
      id: "i1",
      external_id: null,
      rights_mode: "teams",
      created_by: "99",
      RBAC: [{ access_type: "Team", team_id: "team-1", rights: "write" }],
    };
    expect(canWrite(existing, user)).toBe(false);
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

    const rows = await lookupExisting(db, "ctx_items", ["i1"], ["e1"]);

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

  it("skips the rbac grants query entirely when no matched row needs grant-based access", async () => {
    const { calls, builderFor } = fakeDb();
    const items = [{ id: "i1", external_id: null, rights_mode: "private", created_by: "1" }];
    const db: any = jest.fn((table: string) => {
      if (table === "rbac") throw new Error("rbac should not be queried");
      return builderFor(table, items);
    });

    const rows = await lookupExisting(db, "ctx_items", ["i1"], []);

    expect(rows).toEqual([{ ...items[0], RBAC: [] }]);
    expect(calls["rbac.where"]).toBeUndefined();
  });
});

describe("writeProgress", () => {
  it("merges new counters over the existing metadata, keeping cancelRequested", async () => {
    const updateSpy = jest.fn(async () => 1);
    const builder: any = {
      where: () => builder,
      select: () => builder,
      first: async () => ({ metadata: { cancelRequested: true, processed: 1 } }),
      update: updateSpy,
    };
    const db: any = jest.fn(() => builder);

    await writeProgress(db, "job-1", {
      total: null,
      processed: 5,
      created: 2,
      updated: 1,
      failed: 0,
      invalid: 0,
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const written = JSON.parse(updateSpy.mock.calls[0]![0].metadata);
    expect(written).toEqual({
      cancelRequested: true,
      total: null,
      processed: 5,
      created: 2,
      updated: 1,
      failed: 0,
      invalid: 0,
    });
  });

  it("tolerates metadata stored as a JSON string, and a row with no prior metadata", async () => {
    const updateSpy = jest.fn(async () => 1);
    const builder: any = {
      where: () => builder,
      select: () => builder,
      first: async () => ({ metadata: JSON.stringify({ cancelRequested: true }) }),
      update: updateSpy,
    };
    const db: any = jest.fn(() => builder);

    await writeProgress(db, "job-1", {
      total: null,
      processed: 1,
      created: 0,
      updated: 0,
      failed: 0,
      invalid: 0,
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const written = JSON.parse(updateSpy.mock.calls[0]![0].metadata);
    expect(written).toEqual({
      cancelRequested: true,
      total: null,
      processed: 1,
      created: 0,
      updated: 0,
      failed: 0,
      invalid: 0,
    });
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
