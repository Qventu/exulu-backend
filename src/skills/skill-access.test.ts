import { readFileSync } from "fs";
import { join } from "path";

// RBAC rows are only read when the license grants rbac; the write-grant cases
// below need them, so the license is switched on for this file.
jest.mock("@EE/entitlements", () => ({ checkLicense: () => ({ rbac: true }) }));

import { canAccessSkill, ensureSkillWrite } from "./skill-access";

const fakeDb = (rbacRows: any[] = []) => {
  const fn: any = () => fn;
  fn.from = () => fn;
  fn.where = () => fn;
  fn.select = async () => rbacRows;
  return fn;
};

// checkRecordAccess caches per (record id, right, user id) for a minute, so
// every case uses its own skill id.
let seq = 0;
const nextId = () => `skill-${++seq}`;

const fakeRes = () => {
  const res: any = { statusCode: undefined, body: undefined };
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body: any) => {
    res.body = body;
    return res;
  });
  return res;
};

describe("canAccessSkill", () => {
  it("allows the creator to read a private skill", async () => {
    const db = fakeDb();
    const skill = { id: "s1", rights_mode: "private", created_by: 42 };
    const user = { id: 42, type: "user" } as any;
    expect(await canAccessSkill(db, skill, "read", user)).toBe(true);
  });
  it("denies a non-creator reading a private skill", async () => {
    const db = fakeDb();
    const skill = { id: "s2", rights_mode: "private", created_by: 42 };
    const user = { id: 7, type: "user" } as any;
    expect(await canAccessSkill(db, skill, "read", user)).toBe(false);
  });
  it("allows anyone to read a public skill", async () => {
    const db = fakeDb();
    const skill = { id: "s3", rights_mode: "public", created_by: 42 };
    const user = { id: 7, type: "user" } as any;
    expect(await canAccessSkill(db, skill, "read", user)).toBe(true);
  });
});

describe("ensureSkillWrite", () => {
  const user = (over: any = {}) => ({ id: 7, type: "user", super_admin: false, ...over }) as any;

  it("lets the creator through and sends nothing", async () => {
    const res = fakeRes();
    const skill = { id: nextId(), rights_mode: "private", created_by: 7 };
    expect(await ensureSkillWrite(fakeDb(), skill, user(), res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it("lets the creator through when created_by is stored as text", async () => {
    const res = fakeRes();
    const skill = { id: nextId(), rights_mode: "users", created_by: "7" };
    expect(await ensureSkillWrite(fakeDb(), skill, user(), res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("lets a user with a write grant through", async () => {
    const res = fakeRes();
    const id = nextId();
    const skill = { id, rights_mode: "users", created_by: 1 };
    const rows = [{ access_type: "User", user_id: 7, rights: "write" }];
    expect(await ensureSkillWrite(fakeDb(rows), skill, user(), res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("lets a role with a write grant through", async () => {
    const res = fakeRes();
    const skill = { id: nextId(), rights_mode: "roles", created_by: 1 };
    const rows = [{ access_type: "Role", role_id: "r1", rights: "write" }];
    expect(await ensureSkillWrite(fakeDb(rows), skill, user({ role: { id: "r1" } }), res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("lets a super admin through", async () => {
    const res = fakeRes();
    const skill = { id: nextId(), rights_mode: "private", created_by: 1 };
    expect(await ensureSkillWrite(fakeDb(), skill, user({ super_admin: true }), res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("lets an admin-mode API key through (same as the registry publish route)", async () => {
    const res = fakeRes();
    const skill = { id: nextId(), rights_mode: "private", created_by: 1 };
    expect(await ensureSkillWrite(fakeDb(), skill, user({ type: "api", scope_mode: null }), res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("keeps a public skill writable by any signed-in user (the existing skill rule)", async () => {
    const res = fakeRes();
    const skill = { id: nextId(), rights_mode: "public", created_by: 1 };
    expect(await ensureSkillWrite(fakeDb(), skill, user(), res)).toBe(true);
  });

  it("refuses a user who is not the creator of a private skill with 403", async () => {
    const res = fakeRes();
    const skill = { id: nextId(), rights_mode: "private", created_by: 1 };
    expect(await ensureSkillWrite(fakeDb(), skill, user(), res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toEqual({ detail: "You don't have write access to this skill." });
  });

  it("refuses a user who can only read the skill", async () => {
    const res = fakeRes();
    const skill = { id: nextId(), rights_mode: "users", created_by: 1 };
    const rows = [{ access_type: "User", user_id: 7, rights: "read" }];
    expect(await ensureSkillWrite(fakeDb(rows), skill, user(), res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("refuses an agents-scoped API key", async () => {
    const res = fakeRes();
    const id = nextId();
    const skill = { id, rights_mode: "private", created_by: 1 };
    const key = user({ type: "api", scope_mode: "agents", agent_ids: [id] });
    expect(await ensureSkillWrite(fakeDb(), skill, key, res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

/**
 * The skill routes live inline in routes.ts (a 6000-line module with ~160
 * imports that cannot be mounted in a unit test), so their wiring is asserted
 * on the source: every route that writes to an existing skill calls
 * ensureSkillWrite after the skill row is loaded and before anything is
 * signed, uploaded, copied, deleted or written to the database.
 */
describe("skill write routes are guarded by ensureSkillWrite", () => {
  const source = readFileSync(join(__dirname, "../exulu/routes.ts"), "utf8");

  const handlerBody = (method: string, path: string): string => {
    const start = source.indexOf(`app.${method}("${path}"`);
    expect(start).toBeGreaterThan(-1);
    const next = source.indexOf("\n  app.", start + 1);
    // drop the `app.<method>(...)` line itself, so `app.delete(` is not
    // mistaken for a `.delete(` side effect
    const bodyStart = source.indexOf("\n", start);
    return source.slice(bodyStart, next === -1 ? undefined : next);
  };

  const effects = [
    "getS3SignedUploadUrl(",
    "uploadFile(",
    "deleteS3Object(",
    "copyS3Object(",
    "listS3ObjectsByPrefix(",
    "getS3ObjectBytes(",
    "extractBundleToS3(",
    ".update(",
    ".delete(",
  ];

  const guarded: [string, string][] = [
    ["post", "/skills/:skillId/sign"],
    ["delete", "/skills/:skillId/file"],
    ["post", "/skills/:skillId/version"],
    ["post", "/skills/:skillId/rename"],
    ["post", "/skills/:skillId/init"],
    ["post", "/skills/:skillId/init-from-upload"],
  ];

  it.each(guarded)("%s %s checks write access before any side effect", (method, path) => {
    const body = handlerBody(method, path);
    const guard = body.indexOf("ensureSkillWrite(");
    expect(guard).toBeGreaterThan(-1);
    // the skill row is loaded first, so an unknown skill still answers as before
    const load = body.indexOf('db("skills").where({ id: skillId }).first()');
    expect(load).toBeGreaterThan(-1);
    expect(load).toBeLessThan(guard);
    for (const effect of effects) {
      const at = body.indexOf(effect);
      if (at !== -1) expect({ path, effect, before: at < guard }).toEqual({ path, effect, before: false });
    }
  });
});
