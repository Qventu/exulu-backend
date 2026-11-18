/**
 * Decision 2026-11-18: for skills, "public" grants read and use, not write.
 * The generic GraphQL write guard (validateWriteAccess in createMutations)
 * lets any signed-in user edit a rights_mode "public" row; for the skills
 * table it now applies the skill rule instead (creator, super admin,
 * admin-mode API key, explicit RBAC write grant). Every other table keeps
 * the public-is-writable behaviour, which the last block pins.
 */

// Same heavy-import mocks as validate-write-access.test.ts.
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
// RBAC grants are only read when the license grants rbac.
jest.mock("@EE/entitlements", () => ({ checkLicense: () => ({ rbac: true }) }));

import { createMutations } from "./index";
import { applyAccessControl } from "@SRC/graphql/utilities/access-control";

const skillsTable: any = {
  name: { singular: "skill", plural: "skills" },
  type: "skills",
  RBAC: true,
  fields: [],
};
const itemsTable: any = {
  name: { singular: "documents_item", plural: "documents_items" },
  type: "items",
  RBAC: true,
  fields: [],
};

// The messages validateWriteAccess (and its skills branch) refuses with.
const REFUSAL = /Only the creator|Insufficient|permissions|may not edit|owners/i;

const PAST_GUARD = "test stop: past the write guard";

let seq = 0;
const nextId = () => `sk-gql-${++seq}`;

/**
 * Knex-like mock. `first()` on the table under test returns `record`; the
 * rbac lookup (`from("rbac").where(..).select("*")`) resolves `rbacRows`.
 * `writes` records every update/delete on the table, so a test can see
 * whether the mutation got past the guard.
 */
function makeDb(tableName: string, record: any, rbacRows: any[] = []) {
  const writes: string[] = [];
  const query = (table: string) => {
    const q: any = {};
    const chain = () => q;
    for (const m of ["where", "whereIn", "andWhere", "orWhere", "returning", "limit", "orderBy"]) q[m] = chain;
    q.select = () => (table === "rbac" ? Promise.resolve(rbacRows) : q);
    q.first = async () => (table === tableName ? record : table === "rbac" ? rbacRows[0] : undefined);
    q.update = (patch: any) => {
      writes.push(`update ${table} ${JSON.stringify(patch)}`);
      return Object.assign(Promise.resolve([{ ...record, ...patch }]), q);
    };
    q.del = () => {
      writes.push(`delete ${table}`);
      return Object.assign(Promise.resolve(1), q);
    };
    q.delete = q.del;
    // The first db call UpdateOneById makes after validateWriteAccess: stop
    // there with a recognisable error, so "allowed" means "got past the guard".
    q.columnInfo = async () => {
      throw new Error(PAST_GUARD);
    };
    return q;
  };
  const db: any = Object.assign((table: string) => query(table), { from: (table: string) => query(table) });
  return { db, writes };
}

const ctx = (db: any, user: any) => ({ db, user, req: {} });
const nonOwner = (over: any = {}) => ({ id: 7, type: "user", super_admin: false, role: { id: "r1" }, ...over });

const skillMutations = createMutations(skillsTable, [], [], {} as any) as any;

async function attempt(fn: () => Promise<unknown>): Promise<{ refused: boolean; message: string }> {
  try {
    await fn();
    return { refused: false, message: "" };
  } catch (err: any) {
    const message = String(err?.message ?? err);
    return { refused: REFUSAL.test(message), message };
  }
}

describe("GraphQL skill mutations on a public skill", () => {
  const publicSkill = () => ({ id: nextId(), rights_mode: "public", created_by: "1" });

  it("refuses a non-owner without a grant updating it, and writes nothing", async () => {
    const skill = publicSkill();
    const { db, writes } = makeDb("skills", skill);
    const out = await attempt(() =>
      skillMutations.skillsUpdateOneById(null, { id: skill.id, input: { description: "x" } }, ctx(db, nonOwner()), {}),
    );
    expect(out).toEqual({ refused: true, message: "Only the owners of a public skill can change it." });
    expect(writes).toEqual([]);
  });

  it("refuses a non-owner without a grant deleting it, and deletes nothing", async () => {
    const skill = publicSkill();
    const { db, writes } = makeDb("skills", skill);
    const out = await attempt(() => skillMutations.skillsRemoveOneById(null, { id: skill.id }, ctx(db, nonOwner()), {}));
    expect(out.refused).toBe(true);
    expect(writes).toEqual([]);
  });

  it("refuses a non-owner whose explicit grant is read only", async () => {
    const skill = publicSkill();
    const { db, writes } = makeDb("skills", skill, [{ access_type: "User", user_id: "7", rights: "read" }]);
    const out = await attempt(() =>
      skillMutations.skillsUpdateOneById(null, { id: skill.id, input: { tags: ["a"] } }, ctx(db, nonOwner()), {}),
    );
    expect(out.refused).toBe(true);
    expect(writes).toEqual([]);
  });

  it.each([
    ["the creator", nonOwner({ id: 1 }), []],
    ["a super admin", nonOwner({ super_admin: true }), []],
    ["an admin-mode API key", nonOwner({ type: "api", scope_mode: "admin" }), []],
    ["a user with a write grant", nonOwner(), [{ access_type: "User", user_id: "7", rights: "write" }]],
    ["a role with a write grant", nonOwner(), [{ access_type: "Role", role_id: "r1", rights: "write" }]],
    ["a team with a write grant", nonOwner({ team: { id: "t1" } }), [{ access_type: "Team", team_id: "t1", rights: "write" }]],
  ])("lets %s update it", async (_who, user, rows) => {
    const skill = publicSkill();
    const { db } = makeDb("skills", skill, rows as any[]);
    const out = await attempt(() =>
      skillMutations.skillsUpdateOneById(null, { id: skill.id, input: { description: "x" } }, ctx(db, user), {}),
    );
    expect(out).toEqual({ refused: false, message: PAST_GUARD });
  });

  it("leaves reads alone: the skills query filter still matches every public row for a non-owner", () => {
    // applyAccessControl (the GraphQL skill queries' read filter) is not
    // touched by this change; its first clause is rights_mode = public.
    const clauses: any[] = [];
    const recorder: any = {
      where(this: any, ...args: any[]) {
        if (typeof args[0] === "function") args[0].call(recorder);
        else clauses.push(["where", ...args]);
        return recorder;
      },
      orWhere(this: any, ...args: any[]) {
        if (typeof args[0] === "function") args[0].call(recorder);
        else clauses.push(["orWhere", ...args]);
        return recorder;
      },
      whereExists: () => recorder,
    };
    applyAccessControl(skillsTable, recorder, nonOwner() as any);
    expect(clauses[0]).toEqual(["where", "rights_mode", "public"]);
  });
});

describe("GraphQL skill mutations on a private skill (unchanged)", () => {
  it("still refuses a non-owner and still lets the creator through", async () => {
    const skill = { id: nextId(), rights_mode: "private", created_by: "1" };
    const { db } = makeDb("skills", skill);
    const refused = await attempt(() =>
      skillMutations.skillsUpdateOneById(null, { id: skill.id, input: {} }, ctx(db, nonOwner()), {}),
    );
    expect(refused.refused).toBe(true);
    const creator = await attempt(() =>
      skillMutations.skillsUpdateOneById(null, { id: skill.id, input: {} }, ctx(db, nonOwner({ id: 1 })), {}),
    );
    expect(creator).toEqual({ refused: false, message: PAST_GUARD });
  });
});

describe("the change is skill-scoped: other public records stay writable by any signed-in user", () => {
  it("lets a non-owner update a public context item through the same generic guard", async () => {
    const itemMutations = createMutations(itemsTable, [], [], {} as any) as any;
    const item = { id: nextId(), rights_mode: "public", created_by: "1" };
    const { db } = makeDb("documents_items", item);
    const out = await attempt(() =>
      itemMutations.documents_itemsUpdateOneById(null, { id: item.id, input: { name: "x" } }, ctx(db, nonOwner()), {}),
    );
    expect(out).toEqual({ refused: false, message: PAST_GUARD });
  });
});
