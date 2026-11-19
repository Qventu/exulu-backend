import { readFileSync } from "fs";
import { join } from "path";

// RBAC rows are only read when the license grants rbac; the write-grant cases
// below need them, so the license is switched on for this file.
jest.mock("@EE/entitlements", () => ({ checkLicense: () => ({ rbac: true }) }));

import { canAccessSkill, ensureSkillRead, ensureSkillWrite } from "./skill-access";
import { checkRecordAccess } from "@SRC/utils/check-record-access";

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

// checkRecordAccess and validateWriteAccess log every refusal; keep the
// refusing cases quiet.
let errorSpy: jest.SpyInstance;
beforeEach(() => {
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

/**
 * Controller ruling 2026-11-19: for skills, write access satisfies a read
 * check. The RBAC editor gives each subject one right, so a "write" grantee
 * has no "read" row, and checkRecordAccess alone refuses them a read.
 */
describe("canAccessSkill: write access also lets you read", () => {
  const user = (over: any = {}) => ({ id: 7, type: "user", super_admin: false, ...over }) as any;

  it("a users-mode write grant can read", async () => {
    const skill = { id: nextId(), rights_mode: "users", created_by: 1 };
    const rows = [{ access_type: "User", user_id: 7, rights: "write" }];
    expect(await canAccessSkill(fakeDb(rows), skill, "read", user())).toBe(true);
    expect(await canAccessSkill(fakeDb(rows), skill, "write", user())).toBe(true);
  });
  it("a roles-mode write grant can read", async () => {
    const skill = { id: nextId(), rights_mode: "roles", created_by: 1 };
    const rows = [{ access_type: "Role", role_id: "r1", rights: "write" }];
    expect(await canAccessSkill(fakeDb(rows), skill, "read", user({ role: { id: "r1" } }))).toBe(true);
  });
  it("a teams-mode write grant can read", async () => {
    const skill = { id: nextId(), rights_mode: "teams", created_by: 1 };
    const rows = [{ access_type: "Team", team_id: "t1", rights: "write" }];
    expect(await canAccessSkill(fakeDb(rows), skill, "read", user({ team: { id: "t1" } }))).toBe(true);
  });
  it("a read grant can read but not write (unchanged)", async () => {
    const skill = { id: nextId(), rights_mode: "users", created_by: 1 };
    const rows = [{ access_type: "User", user_id: 7, rights: "read" }];
    expect(await canAccessSkill(fakeDb(rows), skill, "read", user())).toBe(true);
    expect(await canAccessSkill(fakeDb(rows), skill, "write", user())).toBe(false);
  });
  it("no grant can neither read nor write (unchanged)", async () => {
    const skill = { id: nextId(), rights_mode: "users", created_by: 1 };
    const rows = [{ access_type: "User", user_id: 99, rights: "write" }];
    expect(await canAccessSkill(fakeDb(rows), skill, "read", user())).toBe(false);
    expect(await canAccessSkill(fakeDb(rows), skill, "write", user())).toBe(false);
  });
  it("another creator's private skill stays refused (unchanged)", async () => {
    const skill = { id: nextId(), rights_mode: "private", created_by: 1 };
    expect(await canAccessSkill(fakeDb(), skill, "read", user())).toBe(false);
    expect(await canAccessSkill(fakeDb(), skill, "write", user())).toBe(false);
  });
  it("a public skill: a non-owner reads, but still cannot write (unchanged)", async () => {
    const skill = { id: nextId(), rights_mode: "public", created_by: 1 };
    expect(await canAccessSkill(fakeDb(), skill, "read", user())).toBe(true);
    expect(await canAccessSkill(fakeDb(), skill, "write", user())).toBe(false);
  });
  it("is skill-scoped: checkRecordAccess still refuses a read to a write-only grant on a non-skill record", async () => {
    const record = {
      id: `agent-${nextId()}`,
      rights_mode: "users",
      created_by: 1,
      RBAC: { users: [{ id: 7, rights: "write" }], roles: [], teams: [] },
    };
    expect(await checkRecordAccess(record, "read", user())).toBe(false);
    expect(await checkRecordAccess(record, "write", user())).toBe(true);
  });
});

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

/**
 * Decision 2026-11-18: for skills, "public" grants read and use, not write.
 * A public skill is writable by its creator, a super admin, an admin-mode API
 * key and anyone with an explicit RBAC write grant (user / role / team).
 */
describe("canAccessSkill on a public skill", () => {
  const user = (over: any = {}) => ({ id: 7, type: "user", super_admin: false, ...over }) as any;
  const publicSkill = () => ({ id: nextId(), rights_mode: "public", created_by: 1 });

  it("lets a signed-in non-owner without a grant read it", async () => {
    expect(await canAccessSkill(fakeDb(), publicSkill(), "read", user())).toBe(true);
  });
  it("refuses a signed-in non-owner without a grant writing it", async () => {
    expect(await canAccessSkill(fakeDb(), publicSkill(), "write", user())).toBe(false);
  });
  it("refuses a non-owner whose explicit grant is read only", async () => {
    const rows = [{ access_type: "User", user_id: 7, rights: "read" }];
    expect(await canAccessSkill(fakeDb(rows), publicSkill(), "write", user())).toBe(false);
  });
  it("refuses a caller without a user", async () => {
    expect(await canAccessSkill(fakeDb(), publicSkill(), "write", undefined)).toBe(false);
  });
  it("lets the creator write it (numeric and text created_by)", async () => {
    expect(await canAccessSkill(fakeDb(), { ...publicSkill(), created_by: 7 }, "write", user())).toBe(true);
    expect(await canAccessSkill(fakeDb(), { ...publicSkill(), created_by: "7" }, "write", user())).toBe(true);
  });
  it("lets a super admin write it", async () => {
    expect(await canAccessSkill(fakeDb(), publicSkill(), "write", user({ super_admin: true }))).toBe(true);
  });
  it("lets an admin-mode API key write it", async () => {
    expect(await canAccessSkill(fakeDb(), publicSkill(), "write", user({ type: "api", scope_mode: null }))).toBe(true);
    expect(await canAccessSkill(fakeDb(), publicSkill(), "write", user({ type: "api", scope_mode: "admin" }))).toBe(true);
  });
  it("lets a user with an explicit RBAC write grant write it (user id stored as text)", async () => {
    const rows = [{ access_type: "User", user_id: "7", rights: "write" }];
    expect(await canAccessSkill(fakeDb(rows), publicSkill(), "write", user())).toBe(true);
  });
  it("lets a role with an explicit RBAC write grant write it", async () => {
    const rows = [{ access_type: "Role", role_id: "r1", rights: "write" }];
    expect(await canAccessSkill(fakeDb(rows), publicSkill(), "write", user({ role: { id: "r1" } }))).toBe(true);
    expect(await canAccessSkill(fakeDb(rows), publicSkill(), "write", user({ role: { id: "r2" } }))).toBe(false);
  });
  it("lets a team with an explicit RBAC write grant write it", async () => {
    const rows = [{ access_type: "Team", team_id: "t1", rights: "write" }];
    expect(await canAccessSkill(fakeDb(rows), publicSkill(), "write", user({ team: { id: "t1" } }))).toBe(true);
    expect(await canAccessSkill(fakeDb(rows), publicSkill(), "write", user({ team: { id: "t2" } }))).toBe(false);
  });
  it("lets an agents-scoped API key read it but not write it", async () => {
    const skill = publicSkill();
    const key = user({ type: "api", scope_mode: "agents", agent_ids: [skill.id] });
    expect(await canAccessSkill(fakeDb(), skill, "read", key)).toBe(true);
    expect(await canAccessSkill(fakeDb(), skill, "write", key)).toBe(false);
  });
  it("answers the same on a repeated call (no stale access cache from a read)", async () => {
    const skill = publicSkill();
    expect(await canAccessSkill(fakeDb(), skill, "read", user())).toBe(true);
    expect(await canAccessSkill(fakeDb(), skill, "write", user())).toBe(false);
    expect(await canAccessSkill(fakeDb(), skill, "write", user())).toBe(false);
  });
});

describe("the public-write change is skill-scoped", () => {
  it("checkRecordAccess still lets any signed-in user write a public NON-skill record", async () => {
    const user = { id: 7, type: "user", super_admin: false } as any;
    const agent = { id: `agent-${nextId()}`, rights_mode: "public", created_by: 1 };
    expect(await checkRecordAccess(agent, "write", user)).toBe(true);
    expect(await checkRecordAccess(agent, "read", user)).toBe(true);
  });
});

describe("ensureSkillRead", () => {
  const user = (over: any = {}) => ({ id: 7, type: "user", super_admin: false, ...over }) as any;

  it("lets a reader of a public skill through and sends nothing", async () => {
    const res = fakeRes();
    const skill = { id: nextId(), rights_mode: "public", created_by: 1 };
    expect(await ensureSkillRead(fakeDb(), skill, user(), res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it("lets the creator of a private skill through", async () => {
    const res = fakeRes();
    const skill = { id: nextId(), rights_mode: "private", created_by: 7 };
    expect(await ensureSkillRead(fakeDb(), skill, user(), res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("lets a user with a read grant through", async () => {
    const res = fakeRes();
    const skill = { id: nextId(), rights_mode: "users", created_by: 1 };
    const rows = [{ access_type: "User", user_id: 7, rights: "read" }];
    expect(await ensureSkillRead(fakeDb(rows), skill, user(), res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("answers an unreadable skill exactly like an unknown one (404, the routes' not-found body)", async () => {
    const res = fakeRes();
    const skill = { id: nextId(), rights_mode: "private", created_by: 1 };
    expect(await ensureSkillRead(fakeDb(), skill, user(), res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body).toEqual({ detail: "Skill not found." });
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

  it("refuses a signed-in non-owner writing a public skill with 403 (public grants read, not write)", async () => {
    const res = fakeRes();
    const skill = { id: nextId(), rights_mode: "public", created_by: 1 };
    expect(await ensureSkillWrite(fakeDb(), skill, user(), res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toEqual({ detail: "You don't have write access to this skill." });
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
    "getS3ObjectContent(",
    "getPresignedUrl(",
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
    ["post", "/skills/:skillId/upload-sign"],
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

/**
 * Same source-order pinning for the routes that read an existing skill's
 * files: each calls ensureSkillRead after the skill row is loaded (so an
 * unknown id still answers 404 as before) and before any S3 call or presigned
 * URL.
 */
describe("skill read routes are guarded by ensureSkillRead", () => {
  const source = readFileSync(join(__dirname, "../exulu/routes.ts"), "utf8");

  const handlerBody = (method: string, path: string): string => {
    const start = source.indexOf(`app.${method}("${path}"`);
    expect(start).toBeGreaterThan(-1);
    const next = source.indexOf("\n  app.", start + 1);
    const bodyStart = source.indexOf("\n", start);
    return source.slice(bodyStart, next === -1 ? undefined : next);
  };

  const effects = [
    "listS3ObjectsByPrefix(",
    "getS3ObjectBytes(",
    "getS3ObjectContent(",
    "getPresignedUrl(",
    "getS3SignedUploadUrl(",
  ];

  const guarded: [string, string][] = [
    ["get", "/skills/:skillId/files"],
    ["get", "/skills/:skillId/download"],
    ["get", "/skills/:skillId/file"],
    ["get", "/skills/:skillId/diff"],
  ];

  it.each(guarded)("%s %s checks read access before any S3 call", (method, path) => {
    const body = handlerBody(method, path);
    const guard = body.indexOf("ensureSkillRead(");
    expect(guard).toBeGreaterThan(-1);
    const load = body.indexOf('db("skills").where({ id: skillId }).first()');
    expect(load).toBeGreaterThan(-1);
    expect(load).toBeLessThan(guard);
    // the existing 404 for an unknown id stays in front of the guard
    const notFound = body.indexOf('res.status(404).json({ detail: "Skill not found." })');
    expect(notFound).toBeGreaterThan(-1);
    expect(notFound).toBeLessThan(guard);
    let effectsSeen = 0;
    for (const effect of effects) {
      const at = body.indexOf(effect);
      if (at !== -1) {
        effectsSeen += 1;
        expect({ path, effect, before: at < guard }).toEqual({ path, effect, before: false });
      }
    }
    expect(effectsSeen).toBeGreaterThan(0);
  });
});
