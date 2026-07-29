/**
 * Tests for the bulk RBAC mutation (‹ctx›_itemsBulkUpdateRBAC): overwrites
 * rights_mode + grants across many items in one transaction, WITHOUT
 * re-embedding, and is atomic on a write-access failure.
 */

jest.mock("@SRC/exulu/context", () => ({
  getChunksTableName: (id: string) => `${id}_chunks`,
  getTableName: (id: string) => id,
}));
jest.mock("@SRC/exulu/entities", () => ({
  resolveEntityModel: jest.fn(),
  setEntityModelSetting: jest.fn(),
}));
jest.mock("@SRC/exulu/statistics", () => ({ updateStatistic: jest.fn() }));
jest.mock("@SRC/graphql/resolvers/utils", () => ({
  contextItemsProcessorHandler: jest.fn(),
  getRequestedFields: jest.fn(() => []),
}));
jest.mock("@SRC/graphql/utilities/access-control", () => ({
  applyAccessControl: jest.fn((_t: any, q: any) => q),
}));
jest.mock("@SRC/auth/generate-key.ts", () => ({ SALT_ROUNDS: 10 }));
jest.mock("@SRC/postgres/client", () => ({ postgresClient: jest.fn() }));
jest.mock("@SRC/graphql/resolvers/apply-filters.ts", () => ({
  applyFilters: jest.fn(),
}));
jest.mock("@SRC/graphql/utilities/validate-super-admin-update.ts", () => ({
  validateCreateOrRemoveSuperAdminPermission: jest.fn(async () => {}),
}));
jest.mock("@SRC/graphql/utilities/encrypt-sensitive-fields.ts", () => ({
  encryptSensitiveFields: (input: any) => input,
}));
jest.mock("@SRC/graphql/utilities/sanitize-and-hydrate-fields.ts", () => ({
  finalizeRequestedFields: jest.fn((f: any) => f),
}));
jest.mock("@SRC/exulu/routines/run-state.ts", () => ({
  cancelRoutineRunRow: jest.fn(),
}));
jest.mock("@EE/queues/queues", () => ({ queues: {} }));
jest.mock("@SRC/graphql/resolvers/index.ts", () => ({
  itemsPaginationRequest: jest.fn(),
  sanitizeRequestedFields: jest.fn((f: any) => f),
}));
jest.mock("@EE/rbac-update.ts", () => ({ handleRBACUpdate: jest.fn() }));

import { createMutations } from "./index";
import { handleRBACUpdate } from "@EE/rbac-update.ts";

const ID_1 = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";
const ID_2 = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb";

const itemsTable: any = {
  name: { singular: "documents_item", plural: "documents_items" },
  type: "items",
  RBAC: true,
  fields: [],
};

// Chainable knex-like mock. `db` doubles as the transaction object (handed to
// the resolver's db.transaction callback); handleRBACUpdate is mocked so the
// awaited rbac fetch value is never inspected.
function makeDb({ record }: { record?: any } = {}) {
  const captured: {
    updateIds?: any;
    updateVals?: any;
    txnCalled?: boolean;
  } = {};
  const chain = (table: string) => {
    const q: any = {
      select: () => q,
      where: () => q,
      whereIn: (_col: string, vals: any) => {
        captured.updateIds = vals;
        return q;
      },
      update: async (vals: any) => {
        captured.updateVals = vals;
        return Array.isArray(captured.updateIds) ? captured.updateIds.length : 0;
      },
      first: async () => record,
    };
    return q;
  };
  const db: any = Object.assign((table: string) => chain(table), {
    from: (table: string) => chain(table),
    transaction: jest.fn(async (cb: any) => {
      captured.txnCalled = true;
      return cb(db);
    }),
  });
  return { db, captured };
}

const makeContext = (db: any, user: any) => ({ db, user, req: {} });

const mutations = createMutations(itemsTable, [], [], [], {} as any);
const bulkUpdateRbac = mutations["documents_itemsBulkUpdateRBAC"];

beforeEach(() => {
  (handleRBACUpdate as jest.Mock).mockClear();
});

describe("‹ctx›_itemsBulkUpdateRBAC", () => {
  it("sets rights_mode on all ids and overwrites grants per item, without re-embedding", async () => {
    const { db, captured } = makeDb();
    const superAdmin = { id: 1, super_admin: true };
    const RBAC = { roles: [{ id: "role-1", rights: "write" }], users: [], teams: [] };

    const result = await bulkUpdateRbac(
      null,
      { ids: [ID_1, ID_2], rights_mode: "roles", RBAC },
      makeContext(db, superAdmin),
      {},
    );

    // one bulk rights_mode update over both ids
    expect(captured.updateIds).toEqual([ID_1, ID_2]);
    expect(captured.updateVals.rights_mode).toBe("roles");
    expect(captured.updateVals.updatedAt).toBeInstanceOf(Date);

    // grants overwritten per item with the entity = table.name.singular
    expect(handleRBACUpdate).toHaveBeenCalledTimes(2);
    expect((handleRBACUpdate as jest.Mock).mock.calls[0][1]).toBe("documents_item");
    expect((handleRBACUpdate as jest.Mock).mock.calls[0][2]).toBe(ID_1);
    expect((handleRBACUpdate as jest.Mock).mock.calls[0][3]).toBe(RBAC);
    expect((handleRBACUpdate as jest.Mock).mock.calls[1][2]).toBe(ID_2);

    // ran inside a transaction; no throw proves postprocessUpdate was skipped
    // (contexts=[] would make postprocessUpdate throw "Context not found")
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ message: "Access updated for 2 items.", itemCount: 2 });
  });

  it("rejects the whole batch and changes nothing when an item is not writable", async () => {
    // non-super-admin, private item owned by someone else → validateWriteAccess throws
    const { db, captured } = makeDb({ record: { rights_mode: "private", created_by: "999" } });
    const user = { id: 2, super_admin: false };

    await expect(
      bulkUpdateRbac(
        null,
        { ids: [ID_1], rights_mode: "public", RBAC: {} },
        makeContext(db, user),
        {},
      ),
    ).rejects.toThrow("Only the creator can edit this private record");

    expect(db.transaction).not.toHaveBeenCalled();
    expect(handleRBACUpdate).not.toHaveBeenCalled();
    expect(captured.updateVals).toBeUndefined();
  });

  it("rejects an invalid rights_mode before touching the database", async () => {
    const { db } = makeDb();
    const superAdmin = { id: 1, super_admin: true };

    await expect(
      bulkUpdateRbac(
        null,
        { ids: [ID_1], rights_mode: "bogus", RBAC: {} },
        makeContext(db, superAdmin),
        {},
      ),
    ).rejects.toThrow('Invalid rights_mode "bogus"');

    expect(db.transaction).not.toHaveBeenCalled();
    expect(handleRBACUpdate).not.toHaveBeenCalled();
  });
});
