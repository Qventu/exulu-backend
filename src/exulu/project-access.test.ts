import { hasProjectAccess } from "./project-access";

const project = { created_by: 7, rights_mode: "users" };
const rbac = {
  type: "users",
  users: [
    { id: "2", rights: "write" },
    { id: "3", rights: "read" },
  ],
  roles: [{ id: "r1", rights: "read" }],
};
const check = (user: any, want: "read" | "write", over: any = {}) =>
  hasProjectAccess({ project, rbac, user, want, ...over });

describe("hasProjectAccess", () => {
  test("creator passes read and write (string vs number)", () => {
    expect(check({ id: "7" }, "read")).toBe(true);
    expect(check({ id: 7 }, "write")).toBe(true);
  });
  test("super admin passes", () => {
    expect(check({ id: 99, super_admin: true }, "write")).toBe(true);
  });
  test("public project passes", () => {
    const p = { created_by: 1, rights_mode: "public" };
    expect(check({ id: 99 }, "write", { project: p })).toBe(true);
  });
  test("write grant satisfies read and write", () => {
    expect(check({ id: 2 }, "read")).toBe(true);
    expect(check({ id: 2 }, "write")).toBe(true);
  });
  test("read grant satisfies read only", () => {
    expect(check({ id: 3 }, "read")).toBe(true);
    expect(check({ id: 3 }, "write")).toBe(false);
  });
  // Role grants count only in "roles" mode (as in checkRecordAccess).
  const roles = { type: "roles", users: [], roles: [{ id: "r1", rights: "read" }] };
  test("role grant matches user.role as string", () => {
    expect(check({ id: 50, role: "r1" }, "read", { rbac: roles })).toBe(true);
    expect(check({ id: 50, role: "r1" }, "write", { rbac: roles })).toBe(false);
  });
  test("role grant matches a hydrated role object (what authentication puts on user.role)", () => {
    expect(check({ id: 50, role: { id: "r1", name: "Team" } }, "read", { rbac: roles })).toBe(true);
    expect(check({ id: 50, role: { id: "r1", name: "Team" } }, "write", { rbac: roles })).toBe(false);
    expect(check({ id: 50, role: { id: "r2", name: "Other" } }, "read", { rbac: roles })).toBe(false);
  });
  test("role grant matches a plain numeric role id", () => {
    const r = { type: "roles", users: [], roles: [{ id: "5", rights: "write" }] };
    expect(check({ id: 50, role: 5 }, "write", { rbac: r })).toBe(true);
  });
  test("outsider fails both", () => {
    expect(check({ id: 50 }, "read")).toBe(false);
    expect(check({ id: 50 }, "write")).toBe(false);
  });
  test("rbac.type public (no licence) passes both", () => {
    expect(check({ id: 50 }, "write", { rbac: { type: "public" } })).toBe(true);
    expect(check({ id: 50 }, "read", { rbac: { type: "public" } })).toBe(true);
  });

  describe("only the grants of the active rights mode count", () => {
    const leftovers = {
      users: [{ id: "2", rights: "write" }],
      roles: [{ id: "r1", rights: "write" }],
      teams: [{ id: "t1", rights: "write" }],
    };
    const member = { id: 2, role: "r1", team: "t1" };
    test("private mode with leftover user, role and team rows denies every non-creator", () => {
      const r = { type: "private", ...leftovers };
      expect(check(member, "read", { rbac: r, project: { created_by: 7, rights_mode: "private" } })).toBe(false);
      expect(check({ id: 7 }, "write", { rbac: r, project: { created_by: 7, rights_mode: "private" } })).toBe(true);
    });
    test("users mode ignores role and team grants", () => {
      const r = { type: "users", ...leftovers };
      expect(check({ id: 2 }, "write", { rbac: r })).toBe(true);
      expect(check({ id: 50, role: "r1", team: "t1" }, "read", { rbac: r })).toBe(false);
    });
    test("roles mode ignores user and team grants", () => {
      const r = { type: "roles", ...leftovers };
      expect(check({ id: 50, role: "r1" }, "write", { rbac: r })).toBe(true);
      expect(check({ id: 2, team: "t1" }, "read", { rbac: r })).toBe(false);
    });
    test("teams mode honours team grants (bare id or hydrated team) and ignores the others", () => {
      const r = { type: "teams", users: leftovers.users, roles: leftovers.roles, teams: [{ id: "t1", rights: "read" }] };
      expect(check({ id: 50, team: "t1" }, "read", { rbac: r })).toBe(true);
      expect(check({ id: 50, team: { id: "t1", name: "Ops" } }, "read", { rbac: r })).toBe(true);
      expect(check({ id: 50, team: "t1" }, "write", { rbac: r })).toBe(false);
      expect(check({ id: 50, team: "t2" }, "read", { rbac: r })).toBe(false);
      expect(check({ id: 2, role: "r1" }, "read", { rbac: r })).toBe(false);
    });
    test("a team write grant satisfies read", () => {
      const r = { type: "teams", users: [], roles: [], teams: [{ id: "t1", rights: "write" }] };
      expect(check({ id: 50, team: "t1" }, "read", { rbac: r })).toBe(true);
    });
  });

  describe("API keys (as checkRecordAccess)", () => {
    const priv = { type: "private", users: [], roles: [], teams: [] };
    test("an admin API key passes (no scope_mode or scope_mode admin)", () => {
      expect(check({ id: 26, type: "api" }, "write", { rbac: priv })).toBe(true);
      expect(check({ id: 26, type: "api", scope_mode: "admin" }, "read", { rbac: priv })).toBe(true);
    });
    test("an agents-scoped API key does not", () => {
      expect(check({ id: 26, type: "api", scope_mode: "agents" }, "read", { rbac: priv })).toBe(false);
    });
  });
});
