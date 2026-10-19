/**
 * Tables with `apiWrites: "super_admin"` (shared_artifacts) reserve every
 * generic write for super admins: the rbac write check would otherwise let
 * any logged-in user edit a rights_mode "public" row, and for shares that
 * value is the sentinel of public/password links, not an invitation.
 */

// Mock the heavy graph mutations/index.ts imports (same approach as
// get-items-rbac.test.ts) — jest.mock calls are hoisted above the import.
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

const sharesTable: any = {
  name: { singular: "shared_artifact", plural: "shared_artifacts" },
  type: "shared_artifacts",
  RBAC: true,
  apiWrites: "super_admin",
  fields: [],
};

function makeDb() {
  const q: any = {
    select: () => q,
    where: () => q,
    first: async () => ({ rights_mode: "public", created_by: 1 }),
  };
  return Object.assign(() => q, { from: () => q });
}

const mutations = createMutations(sharesTable, [], [], [], {} as any);
const GENERIC_WRITES = [
  "shared_artifactsCreateOne",
  "shared_artifactsCopyOneById",
  "shared_artifactsUpdateOne",
  "shared_artifactsUpdateOneById",
  "shared_artifactsRemoveOneById",
  "shared_artifactsRemoveOne",
  "shared_artifactsBulkUpdateRBAC",
];

describe("apiWrites: super_admin", () => {
  it.each(GENERIC_WRITES)("%s rejects a logged-in non-admin even on a public row", async (key) => {
    const resolver = (mutations as any)[key];
    // BulkUpdateRBAC is only registered for item tables; a key the generator
    // never produced cannot be called, so there is nothing to guard.
    if (!resolver) return;
    const context = { db: makeDb(), user: { id: 2, super_admin: false, role: { id: "r" } }, req: {} };
    await expect(resolver(null, { id: "x", where: {}, ids: ["x"], rights_mode: "public", input: {} }, context, {})).rejects.toThrow(
      "reserved for super admins",
    );
  });

  it("leaves tables without the flag alone", () => {
    const itemsTable: any = { name: { singular: "doc", plural: "docs" }, type: "items", RBAC: true, fields: [] };
    const plain = createMutations(itemsTable, [], [], [], {} as any) as any;
    expect(String(plain["docsUpdateOneById"])).not.toContain("reserved for super admins");
  });
});
