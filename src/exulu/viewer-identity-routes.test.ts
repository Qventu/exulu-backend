/**
 * GET /shared-artifacts/:name/access — the whole HTTP contract (status codes,
 * the row-lookup/RBAC ordering) tested with supertest and no Postgres.
 *
 * This file also covered PATCH /shared-artifacts/:name/viewer-identity, whose
 * tests went with the route: `auth_mode: "regular"` is now the capability on
 * its own, so there is no grant endpoint left to exercise. What remains is the
 * access check the frontend's identity route depends on, which is the piece
 * that still has to be right.
 */
import express from "express";
import request from "supertest";

import {
  registerViewerIdentityRoutes,
  SHARED_ARTIFACT_ACCESS_PATH,
  type ViewerIdentityRouteDeps,
} from "./viewer-identity-routes";

const REGULAR_ROW = {
  id: 42,
  name: "tender-cockpit",
  auth_mode: "regular",
  rights_mode: "private",
  created_by: 7,
  expires_at: null,
};

/**
 * A fake knex double: `.where({name}).first()` for the lookup,
 * `.where({id}).update(p).returning("*")` for the write.
 *
 * `updateResultRow` is a rest tuple for the same reason `row` is on
 * `buildApp` below: `fakeDb(row, undefined)` must leave it `undefined` (the
 * "deleted between lookup and update" case), not fall back to `lookupRow` via
 * default-parameter semantics.
 */
function fakeDb(lookupRow: any, ...updateResultArg: [any] | []) {
  const updateResultRow = updateResultArg.length > 0 ? updateResultArg[0] : lookupRow;
  const updateCalls: Record<string, unknown>[] = [];
  const db = (_table: string) => ({
    where: (_cond: any) => ({
      first: async () => lookupRow,
      update: (patch: Record<string, unknown>) => {
        updateCalls.push(patch);
        return {
          returning: async (_cols: string) =>
            updateResultRow === undefined ? [] : [{ ...updateResultRow, ...patch }],
        };
      },
    }),
  });
  return { db, updateCalls };
}

// `row` is a rest tuple rather than a plain default parameter so that
// `buildApp({}, undefined)` (the "row is gone" tests) actually produces
// `row === undefined` — a plain `row: any = REGULAR_ROW` default applies
// whenever the caller passes `undefined` explicitly, not just when the
// argument is omitted, which would make those tests unable to exercise the
// 404 path.
function buildApp(
  overrides: Partial<ViewerIdentityRouteDeps> = {},
  ...rowArg: [any] | []
) {
  const row = rowArg.length > 0 ? rowArg[0] : REGULAR_ROW;
  const { db, updateCalls } = fakeDb(row);
  const deps: ViewerIdentityRouteDeps = {
    authenticate: async () => ({ user: { id: 99, super_admin: true, type: "user" } as any }),
    getDb: async () => db as any,
    RBACResolver: async () => ({ type: "private", users: [], roles: [], teams: [] }),
    checkRecordAccess: async () => true,
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  registerViewerIdentityRoutes(app, deps);
  return { app, updateCalls };
}

describe(SHARED_ARTIFACT_ACCESS_PATH, () => {
  const access = (app: express.Express) =>
    request(app).get("/shared-artifacts/tender-cockpit/access");

  test("204s when RBAC allows", async () => {
    const { app } = buildApp({ checkRecordAccess: async () => true });
    const res = await access(app);
    expect(res.status).toBe(204);
  });

  test("403s when RBAC denies", async () => {
    const { app } = buildApp({ checkRecordAccess: async () => false });
    const res = await access(app);
    expect(res.status).toBe(403);
  });

  test("400s a non-regular row", async () => {
    const { app } = buildApp({}, { ...REGULAR_ROW, auth_mode: "public" });
    const res = await access(app);
    expect(res.status).toBe(400);
  });

  test("404s an unknown share name", async () => {
    const { app } = buildApp({}, undefined);
    const res = await access(app);
    expect(res.status).toBe(404);
  });

  test("410s an expired share", async () => {
    const { app } = buildApp(
      {},
      { ...REGULAR_ROW, expires_at: new Date(Date.now() - 1000).toISOString() },
    );
    const res = await access(app);
    expect(res.status).toBe(410);
  });

  test("401s an unauthenticated caller", async () => {
    const { app } = buildApp({ authenticate: async () => ({}) });
    const res = await access(app);
    expect(res.status).toBe(401);
  });
});
