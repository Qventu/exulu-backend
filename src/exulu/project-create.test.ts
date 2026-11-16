import { createProjectForUser, attachSessionToProject, createProjectAndAttach, canWriteSession, planMove } from "./project-create";
import { RBACResolver } from "@EE/rbac-resolver.ts";

jest.mock("@EE/rbac-resolver.ts", () => ({ RBACResolver: jest.fn() }));
const rbac = RBACResolver as jest.Mock;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const fakeDb = (rows: { agent_sessions?: any; projects?: any }, updated = 1) => {
  const calls: any = { inserted: [], updates: [] };
  const db: any = (table: string) => ({
    insert: (row: any) => {
      calls.inserted.push({ table, row });
      return { returning: async () => [{ id: row.id, name: row.name }] };
    },
    where: () => ({
      whereNull: (col: string) => ({
        update: async (patch: any) => {
          calls.updates.push({ table, col, patch });
          return updated;
        },
      }),
    }),
  });
  db.from = (table: string) => ({ where: () => ({ first: async () => (rows as any)[table] }) });
  return { db, calls };
};

describe("createProjectForUser", () => {
  it("inserts a private project owned by the caller with a uuid and nothing else shared", async () => {
    const { db, calls } = fakeDb({});
    const out = await createProjectForUser(db, { id: 7 }, { name: "  Alpha ", description: "d" });
    expect(out.name).toBe("Alpha");
    expect(out.id).toMatch(UUID);
    expect(calls.inserted).toHaveLength(1);
    expect(calls.inserted[0].table).toBe("projects");
    expect(calls.inserted[0].row).toEqual({
      name: "Alpha",
      description: "d",
      id: out.id,
      created_by: 7,
      rights_mode: "private",
    });
  });
  it("refuses an empty or over-long name and an over-long description before touching the db", async () => {
    const { db, calls } = fakeDb({});
    await expect(createProjectForUser(db, { id: 7 }, { name: "   " })).rejects.toThrow();
    await expect(createProjectForUser(db, { id: 7 }, { name: "x".repeat(121) })).rejects.toThrow();
    await expect(createProjectForUser(db, { id: 7 }, { name: "a", description: "x".repeat(2001) })).rejects.toThrow();
    expect(calls.inserted).toEqual([]);
  });
  it("goes through the same schema validation as projectsCreateOne (prepareItemWrite)", async () => {
    const itemWrite = require("./item-write");
    const spy = jest.spyOn(itemWrite, "prepareItemWrite");
    const { db } = fakeDb({});
    await createProjectForUser(db, { id: 7 }, { name: "Alpha" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].existing).toBeNull();
    expect(spy.mock.calls[0]![0].fields.some((f: any) => f.name === "name")).toBe(true);
    spy.mockRestore();
  });
});

describe("attachSessionToProject", () => {
  const session = { id: "s1", user: 7, created_by: 7, rights_mode: "private", project: null };
  const project = { id: "p1", created_by: 7, rights_mode: "private" };
  beforeEach(() => rbac.mockReset().mockResolvedValue({ type: "private", users: [], roles: [], teams: [] }));

  it("sets the project on a session the user owns, guarded on 'no project yet'", async () => {
    const { db, calls } = fakeDb({ agent_sessions: session, projects: project });
    await attachSessionToProject(db, { sessionId: "s1", projectId: "p1", user: { id: 7 } });
    expect(calls.updates).toEqual([{ table: "agent_sessions", col: "project", patch: { project: "p1" } }]);
    // session rbac is looked up under the singular entity name, project rbac under "project"
    expect(rbac.mock.calls.map((c) => c[1])).toEqual(["agent_session", "project"]);
  });
  it("refuses a session the user cannot write", async () => {
    const { db, calls } = fakeDb({ agent_sessions: { ...session, user: 99, created_by: 7 }, projects: project });
    await expect(attachSessionToProject(db, { sessionId: "s1", projectId: "p1", user: { id: 7 } })).rejects.toThrow(/write access to this session/);
    expect(calls.updates).toEqual([]);
  });
  it("a read-only session grant is not enough", async () => {
    rbac.mockResolvedValueOnce({ type: "users", users: [{ id: "7", rights: "read" }], roles: [], teams: [] });
    const { db } = fakeDb({ agent_sessions: { ...session, user: 99, created_by: 99, rights_mode: "users" }, projects: project });
    await expect(attachSessionToProject(db, { sessionId: "s1", projectId: "p1", user: { id: 7 } })).rejects.toThrow(/write access/);
  });
  it("the owner is session.user, not created_by: the two columns differ", async () => {
    const row = { ...session, user: 7, created_by: 99 };
    await attachSessionToProject(fakeDb({ agent_sessions: row, projects: project }).db, { sessionId: "s1", projectId: "p1", user: { id: 7 } });
    await expect(
      attachSessionToProject(fakeDb({ agent_sessions: row, projects: { ...project, created_by: 99, rights_mode: "public" } }).db, { sessionId: "s1", projectId: "p1", user: { id: 99 } }),
    ).rejects.toThrow(/write access to this session/);
  });
  it("a write grantee may attach", async () => {
    rbac.mockResolvedValueOnce({ type: "users", users: [{ id: "7", rights: "write" }], roles: [], teams: [] });
    const { db } = fakeDb({ agent_sessions: { ...session, user: 99, created_by: 99, rights_mode: "users" }, projects: project });
    await attachSessionToProject(db, { sessionId: "s1", projectId: "p1", user: { id: 7 } });
  });
  it("a super admin who is not the owner is refused (no bypass)", async () => {
    const { db } = fakeDb({ agent_sessions: { ...session, user: 99, created_by: 99 }, projects: project });
    await expect(attachSessionToProject(db, { sessionId: "s1", projectId: "p1", user: { id: 7, super_admin: true } })).rejects.toThrow(/write access to this session/);
  });
  it("without the RBAC licence (resolver says public) a non-owner is refused", async () => {
    rbac.mockResolvedValueOnce({ type: "public", users: [], roles: [], teams: [] });
    const { db } = fakeDb({ agent_sessions: { ...session, user: 99, created_by: 99, rights_mode: "public" }, projects: project });
    await expect(attachSessionToProject(db, { sessionId: "s1", projectId: "p1", user: { id: 7 } })).rejects.toThrow(/write access to this session/);
  });
  it("canWriteSession: role and team grants, admin-mode API keys", () => {
    const s = { user: 99 };
    expect(canWriteSession(s, { type: "roles", roles: [{ id: "r1", rights: "write" }] }, { id: 7, role: { id: "r1" } })).toBe(true);
    expect(canWriteSession(s, { type: "teams", teams: [{ id: "t1", rights: "read" }] }, { id: 7, team: "t1" })).toBe(false);
    expect(canWriteSession(s, { type: "private" }, { id: 7, type: "api" })).toBe(true);
    expect(canWriteSession(s, { type: "private" }, { id: 7, type: "api", scope_mode: "agents" })).toBe(false);
  });
  it("refuses a project the user cannot read", async () => {
    const { db, calls } = fakeDb({ agent_sessions: session, projects: { ...project, created_by: 99 } });
    await expect(attachSessionToProject(db, { sessionId: "s1", projectId: "p1", user: { id: 7 } })).rejects.toThrow(/read access to this project/);
    expect(calls.updates).toEqual([]);
  });
  it("refuses a session that already has a project, also when a racing call won", async () => {
    await expect(
      attachSessionToProject(fakeDb({ agent_sessions: { ...session, project: "x" }, projects: project }).db, { sessionId: "s1", projectId: "p1", user: { id: 7 } }),
    ).rejects.toThrow(/already belongs/);
    await expect(
      attachSessionToProject(fakeDb({ agent_sessions: session, projects: project }, 0).db, { sessionId: "s1", projectId: "p1", user: { id: 7 } }),
    ).rejects.toThrow(/already belongs/);
  });
  it("refuses unknown session or project", async () => {
    await expect(attachSessionToProject(fakeDb({ projects: project }).db, { sessionId: "s1", projectId: "p1", user: { id: 7 } })).rejects.toThrow(/Session not found/);
    await expect(attachSessionToProject(fakeDb({ agent_sessions: session }).db, { sessionId: "s1", projectId: "p1", user: { id: 7 } })).rejects.toThrow(/Project not found/);
  });
});

describe("createProjectAndAttach (one transaction)", () => {
  const mkTx = (updated: number) => {
    const committed: any[] = [];
    const db: any = {
      transaction: async (fn: (trx: any) => Promise<unknown>) => {
        const staged: any[] = [];
        const trx: any = (table: string) => ({
          insert: (row: any) => ({ returning: async () => { staged.push(row); return [{ id: row.id, name: row.name }]; } }),
          where: () => ({ whereNull: () => ({ update: async () => updated }) }),
        });
        trx.from = (table: string) => ({
          where: () => ({
            first: async () =>
              table === "agent_sessions"
                ? { id: "s1", user: 7, created_by: 7, rights_mode: "private", project: null }
                : { id: staged[0]?.id, created_by: 7, rights_mode: "private" },
          }),
        });
        const out = await fn(trx);
        committed.push(...staged); // only reached when fn did not throw
        return out;
      },
    };
    return { db, committed };
  };
  beforeEach(() => rbac.mockReset().mockResolvedValue({ type: "private", users: [], roles: [], teams: [] }));
  it("commits the project when the attach succeeds", async () => {
    const { db, committed } = mkTx(1);
    const out = await createProjectAndAttach(db, { id: 7 }, { sessionId: "s1", name: "Alpha" });
    expect(committed).toHaveLength(1);
    expect(committed[0].id).toBe(out.id);
  });
  it("an attach that affects 0 rows rolls the insert back: no project row remains", async () => {
    const { db, committed } = mkTx(0);
    await expect(createProjectAndAttach(db, { id: 7 }, { sessionId: "s1", name: "Alpha" })).rejects.toThrow(/already belongs/);
    expect(committed).toEqual([]);
  });
});

describe("planMove", () => {
  const f = (name: string, size = 10) => ({ key: `u/${name}`, name, size });
  it("moves the default set: no ignored paths, nested files or tool-output-*", () => {
    const r = planMove({ files: [f("a.pdf"), f("sub/b.pdf"), f("tool-output-1.txt"), f("venv/x.py"), f("c.docx")] });
    expect(r.batches).toEqual([[{ key: "u/a.pdf", name: "a.pdf" }, { key: "u/c.docx", name: "c.docx" }]]);
    expect(r.skipped).toEqual([]);
  });
  it("batches by 20 keys", () => {
    const files = Array.from({ length: 45 }, (_, i) => f(`f${i}.txt`));
    expect(planMove({ files }).batches.map((b) => b.length)).toEqual([20, 20, 5]);
  });
  it("batches by 50 MB and skips a single file above it", () => {
    const MB = 1024 * 1024;
    const r = planMove({ files: [f("a", 30 * MB), f("b", 30 * MB), f("c", 10 * MB), f("huge", 51 * MB)] });
    expect(r.batches.map((b) => b.map((x) => x.name))).toEqual([["a"], ["b", "c"]]);
    expect(r.skipped).toEqual([{ name: "huge", reason: expect.stringContaining("50 MB") }]);
  });
  it("stops at 200 files and reports the rest", () => {
    const files = Array.from({ length: 205 }, (_, i) => f(`f${i}.txt`));
    const r = planMove({ files });
    expect(r.batches.flat()).toHaveLength(200);
    expect(r.skipped.map((s) => s.name)).toEqual(["f200.txt", "f201.txt", "f202.txt", "f203.txt", "f204.txt"]);
  });
  it("reports a clash of sanitised names and moves neither", () => {
    const r = planMove({ files: [f(" a.txt"), f("a.txt"), f("ok.txt")] });
    expect(r.batches.flat().map((x) => x.name)).toEqual(["ok.txt"]);
    expect(r.skipped.map((s) => s.name).sort()).toEqual([" a.txt", "a.txt"]);
    expect(r.skipped[0]!.reason).toMatch(/clashes/);
  });
  it("reports unknown and nested requested names and ignores duplicates", () => {
    const r = planMove({ files: [f("ok.txt")], requested: ["ok.txt", "ghost.txt", "x/y.txt", "ok.txt"] });
    expect(r.batches.flat().map((x) => x.name)).toEqual(["ok.txt"]);
    expect(r.skipped.map((s) => s.name).sort()).toEqual(["ghost.txt", "x/y.txt"]);
    expect(r.skipped.find((s) => s.name === "ghost.txt")!.reason).toMatch(/No session file/);
  });
  it("an explicit request may name a file the default set would leave out", () => {
    const r = planMove({ files: [f("tool-output-1.txt")], requested: ["tool-output-1.txt"] });
    expect(r.batches.flat()).toHaveLength(1);
  });
});
