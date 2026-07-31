import { checkItemWriteAccess } from "./check-item-write-access";
import { postgresClient } from "@SRC/postgres/client";

jest.mock("@SRC/postgres/client", () => ({ postgresClient: jest.fn() }));

const mockRbacRow = (row: unknown) => {
  (postgresClient as jest.Mock).mockResolvedValue({
    db: { from: () => ({ where: () => ({ first: async () => row }) }) },
  });
};

const context = { id: "products" };

describe("checkItemWriteAccess", () => {
  beforeEach(() => {
    (postgresClient as jest.Mock).mockReset();
  });

  it("denies when there is no user", async () => {
    expect(await checkItemWriteAccess(context, { id: "i1", rights_mode: "public" }, undefined)).toBe(false);
  });

  it("allows super admins regardless of rights_mode", async () => {
    expect(
      await checkItemWriteAccess(context, { id: "i1", rights_mode: "users" }, { id: 7, super_admin: true } as any),
    ).toBe(true);
  });

  it("allows admin-scope api users", async () => {
    expect(
      await checkItemWriteAccess(context, { id: "i1", rights_mode: "users" }, { id: 7, type: "api" } as any),
    ).toBe(true);
    expect(
      await checkItemWriteAccess(
        context,
        { id: "i1", rights_mode: "users" },
        { id: 7, type: "api", scope_mode: "admin" } as any,
      ),
    ).toBe(true);
    // Non-admin scoped api keys get no bypass.
    mockRbacRow(undefined);
    expect(
      await checkItemWriteAccess(
        context,
        { id: "i1", rights_mode: "users" },
        { id: 7, type: "api", scope_mode: "agents" } as any,
      ),
    ).toBe(false);
  });

  it("allows anyone on public records", async () => {
    expect(await checkItemWriteAccess(context, { id: "i1", rights_mode: "public" }, { id: 7 } as any)).toBe(true);
  });

  it("private: only the creator, compared as strings", async () => {
    expect(
      await checkItemWriteAccess(context, { id: "i1", rights_mode: "private", created_by: "7" }, { id: 7 } as any),
    ).toBe(true);
    expect(
      await checkItemWriteAccess(context, { id: "i1", rights_mode: "private", created_by: "8" }, { id: 7 } as any),
    ).toBe(false);
    expect(
      await checkItemWriteAccess(context, { id: "i1", rights_mode: "private", created_by: null }, { id: 7 } as any),
    ).toBe(false);
  });

  it("users: allowed only when a write grant row exists in the rbac table", async () => {
    mockRbacRow({ id: "grant1" });
    expect(
      await checkItemWriteAccess(context, { id: "i1", rights_mode: "users" }, { id: 7 } as any),
    ).toBe(true);
    mockRbacRow(undefined);
    expect(
      await checkItemWriteAccess(context, { id: "i1", rights_mode: "users" }, { id: 7 } as any),
    ).toBe(false);
  });

  it("roles: normalizes a role object to its id and requires a grant", async () => {
    mockRbacRow({ id: "grant1" });
    expect(
      await checkItemWriteAccess(
        context,
        { id: "i1", rights_mode: "roles" },
        { id: 7, role: { id: "role-1" } } as any,
      ),
    ).toBe(true);
    // No role on the user → deny without querying.
    expect(await checkItemWriteAccess(context, { id: "i1", rights_mode: "roles" }, { id: 7 } as any)).toBe(false);
  });

  it("teams: same pattern as roles", async () => {
    mockRbacRow(undefined);
    expect(
      await checkItemWriteAccess(
        context,
        { id: "i1", rights_mode: "teams" },
        { id: 7, team: { id: "team-1" } } as any,
      ),
    ).toBe(false);
    mockRbacRow({ id: "grant1" });
    expect(
      await checkItemWriteAccess(
        context,
        { id: "i1", rights_mode: "teams" },
        { id: 7, team: { id: "team-1" } } as any,
      ),
    ).toBe(true);
  });

  it("allows the creator in shared modes without any rbac grant", async () => {
    // No rbac row is mocked — the creator must be allowed without one.
    for (const rights_mode of ["users", "roles", "teams"] as const) {
      expect(
        await checkItemWriteAccess(
          context,
          { id: "i1", rights_mode, created_by: "7" },
          { id: 7, role: { id: "role-1" }, team: { id: "team-1" } } as any,
        ),
      ).toBe(true);
    }
  });

  it("does not treat a non-creator as the creator in shared modes", async () => {
    mockRbacRow(undefined);
    expect(
      await checkItemWriteAccess(
        context,
        { id: "i1", rights_mode: "users", created_by: "8" },
        { id: 7 } as any,
      ),
    ).toBe(false);
  });

  it("denies unknown rights_mode values", async () => {
    expect(await checkItemWriteAccess(context, { id: "i1", rights_mode: "bogus" }, { id: 7 } as any)).toBe(false);
  });
});
