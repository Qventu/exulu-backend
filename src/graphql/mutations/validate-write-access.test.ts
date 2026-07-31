/**
 * Regression test for the rbac write-access check in createMutations.
 *
 * auth.ts hydrates `user.role` / `user.team` into full row objects, but
 * validateWriteAccess passed them verbatim as `role_id` / `team_id` into the
 * rbac lookup — Postgres then fails with `invalid input syntax for type uuid:
 * "{...serialized role...}"` for every non-super-admin editing a record with
 * rights_mode "roles" or "teams" (e.g. saving an agent's Lottie avatar).
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

const ROLE_UUID = "e82f56d0-8897-4222-8b08-7a25f5aaca8a";
const TEAM_UUID = "11111111-2222-4333-8444-555555555555";
const AGENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const agentsTable: any = {
  name: { singular: "agent", plural: "agents" },
  type: "agents",
  RBAC: true,
  fields: [],
};

// Chainable knex-like mock: the agents lookup returns the record under test,
// the rbac lookup returns no row (so the mutation rejects after the check)
// while capturing the where clause we assert on.
function makeDb(record: { rights_mode: string; created_by?: string }) {
  const captured: { rbacWhere?: any } = {};
  const query = (table: string) => {
    const q: any = {
      select: () => q,
      where: (arg: any) => {
        if (table === "rbac") captured.rbacWhere = arg;
        return q;
      },
      first: async () => (table === "agents" ? record : undefined),
    };
    return q;
  };
  const db: any = Object.assign((table: string) => query(table), {
    from: (table: string) => query(table),
  });
  return { db, captured };
}

function makeContext(db: any, user: any) {
  return { db, user, req: {} };
}

const mutations = createMutations(agentsTable, [], [], [], {} as any);
const updateAgent = mutations["agentsUpdateOneById"];

describe("validateWriteAccess rbac lookups", () => {
  it("queries role-based rbac by the role's id, not the hydrated role object", async () => {
    const { db, captured } = makeDb({ rights_mode: "roles" });
    const user = {
      id: 2,
      super_admin: false,
      role: { id: ROLE_UUID, name: "admin", agents: "write" },
    };

    await expect(
      updateAgent(null, { id: AGENT_ID, input: {} }, makeContext(db, user), {}),
    ).rejects.toThrow("Insufficient role permissions");

    expect(captured.rbacWhere).toEqual({
      entity: "agent",
      target_resource_id: AGENT_ID,
      access_type: "Role",
      role_id: ROLE_UUID,
      rights: "write",
    });
  });

  it("falls back to the raw value when auth could not hydrate the role", async () => {
    // auth.ts only replaces user.role when the roles row still exists;
    // otherwise it stays the uuid string from the users table. The agents
    // table never reaches the rbac branch with a string role (the entity-type
    // gate needs role.agents), so use a non-gated RBAC table.
    const itemsTable: any = {
      name: { singular: "documents_item", plural: "documents_items" },
      type: "items",
      RBAC: true,
      fields: [],
    };
    const itemsMutations = createMutations(itemsTable, [], [], [], {} as any);
    const updateItem = itemsMutations["documents_itemsUpdateOneById"];

    const captured: { rbacWhere?: any } = {};
    const query = (table: string) => {
      const q: any = {
        select: () => q,
        where: (arg: any) => {
          if (table === "rbac") captured.rbacWhere = arg;
          return q;
        },
        first: async () =>
          table === "documents_items" ? { rights_mode: "roles" } : undefined,
      };
      return q;
    };
    const db: any = Object.assign((table: string) => query(table), {
      from: (table: string) => query(table),
    });

    const user = { id: 2, super_admin: false, role: ROLE_UUID };

    await expect(
      updateItem(null, { id: AGENT_ID, input: {} }, makeContext(db, user), {}),
    ).rejects.toThrow("Insufficient role permissions");

    expect(captured.rbacWhere?.role_id).toBe(ROLE_UUID);
  });

  it("queries team-based rbac by the team's id, not the hydrated team object", async () => {
    const { db, captured } = makeDb({ rights_mode: "teams" });
    const user = {
      id: 2,
      super_admin: false,
      role: { id: ROLE_UUID, name: "admin", agents: "write" },
      team: { id: TEAM_UUID, name: "Team A" },
    };

    await expect(
      updateAgent(null, { id: AGENT_ID, input: {} }, makeContext(db, user), {}),
    ).rejects.toThrow("Insufficient team permissions");

    expect(captured.rbacWhere).toEqual({
      entity: "agent",
      target_resource_id: AGENT_ID,
      access_type: "Team",
      team_id: TEAM_UUID,
      rights: "write",
    });
  });

  it("lets the creator edit their own record shared via users, without an rbac grant", async () => {
    const { db, captured } = makeDb({ rights_mode: "users", created_by: "2" });
    const user = {
      id: 2,
      super_admin: false,
      role: { id: ROLE_UUID, name: "default", agents: "write" },
    };

    let err: any;
    try {
      await updateAgent(null, { id: AGENT_ID, input: {} }, makeContext(db, user), {});
    } catch (e) {
      err = e;
    }
    // The write gate must not reject the creator with a permission error...
    expect(String(err?.message ?? "")).not.toContain("Insufficient user permissions");
    // ...and must short-circuit before ever consulting the rbac table.
    expect(captured.rbacWhere).toBeUndefined();
  });
});
