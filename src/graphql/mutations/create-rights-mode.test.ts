/**
 * CreateOne rights_mode behavior: an explicitly provided, valid rights_mode
 * is persisted; an invalid one throws; absent still defaults to "private".
 * (Bulk-import batch access — spec 2026-07-21-bulk-import-rights-mode.)
 */

// Mock the heavy graph mutations/index.ts imports (same approach as
// validate-write-access.test.ts) — jest.mock calls are hoisted above the import.
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

import { handleRBACUpdate } from "@EE/rbac-update.ts";
import { createMutations } from "./index";

// Neutral RBAC table: none of the special-cased singulars (user/agent), and
// type !== "items" so postprocessUpdate skips the embedder/processor branch.
const presetsTable: any = {
  name: { singular: "preset", plural: "presets" },
  type: "presets",
  RBAC: true,
  fields: [
    { name: "name", type: "text" },
    { name: "rights_mode", type: "text" },
  ],
};

// Chainable knex-like mock for the CreateOne path: captures the inserted row.
function makeCreateDb() {
  const captured: { inserted?: any } = {};
  const builder = () => ({
    columnInfo: async () => ({ id: {}, name: {}, rights_mode: {}, created_by: {} }),
    insert: (obj: any) => {
      captured.inserted = obj;
      return { returning: async () => [{ ...obj }] };
    },
  });
  const db: any = Object.assign(() => builder(), {
    from: () => builder(),
    fn: { uuid: () => "00000000-0000-4000-8000-000000000001" },
  });
  return { db, captured };
}

function makeContext(db: any) {
  return { db, user: { id: 7, super_admin: true, role: { id: "role-1" } }, req: {} };
}

const mutations = createMutations(presetsTable, [], [], [], {} as any);
const createPreset = mutations["presetsCreateOne"];

beforeEach(() => jest.clearAllMocks());

describe("CreateOne rights_mode", () => {
  it("persists an explicitly provided valid rights_mode and keeps grant handling", async () => {
    const { db, captured } = makeCreateDb();
    const rbac = { teams: [{ id: "t1", rights: "read" }] };
    await createPreset(
      null,
      { input: { name: "X", rights_mode: "teams", RBAC: rbac } },
      makeContext(db),
      {},
    );
    expect(captured.inserted.rights_mode).toBe("teams");
    expect(handleRBACUpdate).toHaveBeenCalledWith(
      db,
      "preset",
      captured.inserted.id,
      rbac,
      [],
    );
  });

  it("rejects an invalid rights_mode without inserting", async () => {
    const { db, captured } = makeCreateDb();
    await expect(
      createPreset(
        null,
        { input: { name: "X", rights_mode: "everyone" } },
        makeContext(db),
        {},
      ),
    ).rejects.toThrow(/Invalid rights_mode/);
    expect(captured.inserted).toBeUndefined();
  });

  it("still defaults to private when rights_mode is absent", async () => {
    const { db, captured } = makeCreateDb();
    await createPreset(null, { input: { name: "X" } }, makeContext(db), {});
    expect(captured.inserted.rights_mode).toBe("private");
  });
});
