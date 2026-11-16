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
  test("role grant matches user.role as string", () => {
    expect(check({ id: 50, role: "r1" }, "read")).toBe(true);
    expect(check({ id: 50, role: "r1" }, "write")).toBe(false);
  });
  test("role grant matches a hydrated role object (what authentication puts on user.role)", () => {
    expect(check({ id: 50, role: { id: "r1", name: "Team" } }, "read")).toBe(true);
    expect(check({ id: 50, role: { id: "r1", name: "Team" } }, "write")).toBe(false);
    expect(check({ id: 50, role: { id: "r2", name: "Other" } }, "read")).toBe(false);
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
});
