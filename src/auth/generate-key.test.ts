jest.mock("../postgres/client", () => ({ postgresClient: jest.fn() }));
// bcrypt is slow; stub it so tests are fast and deterministic:
jest.mock("bcryptjs", () => ({ hash: jest.fn(async (s: string) => `hash(${s})`) }));

import { postgresClient } from "../postgres/client";
import { generateApiKey } from "./generate-key";

type Captures = { existingRole?: any; existingUser?: any; rolesInsert?: any; usersInsert?: any };

function makeDb(c: Captures) {
  const db = (table: string) => {
    const chain: any = {
      where: () => chain,
      first: async () =>
        table === "roles" ? c.existingRole : table === "users" ? c.existingUser : undefined,
      insert: (row: any) => {
        if (table === "roles") c.rolesInsert = row;
        if (table === "users") c.usersInsert = row;
        // roles path calls .returning(); users path is awaited directly.
        const p: any = Promise.resolve([{ id: "role-new" }]);
        p.returning = () => Promise.resolve([{ id: "role-new" }]);
        return p;
      },
      delete: async () => 1,
    };
    return chain;
  };
  return { from: db };
}

beforeEach(() => {
  jest.clearAllMocks();
});

it("creates a scoped, non-super-admin api user with a read-only role", async () => {
  const c: Captures = {};
  (postgresClient as jest.Mock).mockResolvedValue({ db: makeDb(c) });

  const { key } = await generateApiKey("worker", "worker-test@newton.internal", {
    superAdmin: false,
    roleName: "worker",
    rolePermissions: { agents: "read", workflows: "read", variables: "read", users: "read" },
  });

  expect(key).toMatch(/\/worker$/);
  expect(c.rolesInsert).toEqual({ name: "worker", agents: "read", workflows: "read", variables: "read", users: "read" });
  expect(c.usersInsert.super_admin).toBe(false);
  expect(c.usersInsert.type).toBe("api");
  expect(c.usersInsert.role).toBe("role-new");
});

it("defaults to a super_admin admin user when no options (backwards compat)", async () => {
  const c: Captures = {};
  (postgresClient as jest.Mock).mockResolvedValue({ db: makeDb(c) });

  await generateApiKey("legacy", "legacy@exulu.com");

  expect(c.rolesInsert).toEqual({ name: "admin", agents: "write", workflows: "write", variables: "write", users: "write" });
  expect(c.usersInsert.super_admin).toBe(true);
});

it("reuses an existing role instead of inserting", async () => {
  const c: Captures = { existingRole: { id: "role-existing" } };
  (postgresClient as jest.Mock).mockResolvedValue({ db: makeDb(c) });

  await generateApiKey("worker", "w2@newton.internal", { superAdmin: false, roleName: "worker" });

  expect(c.rolesInsert).toBeUndefined();
  expect(c.usersInsert.role).toBe("role-existing");
});
