/**
 * PATCH /shared-artifacts/:name/viewer-identity and
 * GET /shared-artifacts/:name/access — the whole HTTP contract (status
 * codes, JSON shapes, the authorization-before-row-lookup ordering) tested
 * with supertest and no Postgres. authorizeIdentityGrant and
 * parseIdentityGrantBody are imported for real (not mocked) — these tests
 * exercise the genuine B1 security decision through the route, which is the
 * point: shared-artifacts.test.ts proves the decision in isolation, this
 * file proves the wiring.
 */
import express from "express";
import request from "supertest";

import {
  registerViewerIdentityRoutes,
  SHARED_ARTIFACT_ACCESS_PATH,
  VIEWER_IDENTITY_PATCH_PATH,
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

describe(VIEWER_IDENTITY_PATCH_PATH, () => {
  const patch = (app: express.Express, body: unknown = { grant_viewer_identity: true }) =>
    request(app).patch("/shared-artifacts/tender-cockpit/viewer-identity").send(body);

  // The spec's own required test (§ "Testing"): 403 for a non-super-admin,
  // including for the row's own creator. created_by on REGULAR_ROW is 7;
  // authenticate here returns that same id, proving creatorship grants
  // nothing.
  test("403s a non-super-admin, including the row's own creator", async () => {
    const { app } = buildApp({
      authenticate: async () => ({ user: { id: 7, super_admin: false, type: "user" } }),
    });
    const res = await patch(app);
    expect(res.status).toBe(403);
  });

  // Wiring proof for B1: generateApiKey defaults superAdmin to true, so an
  // API user can carry super_admin: true. The route must still refuse it.
  test("403s an API user even when super_admin is true", async () => {
    const { app } = buildApp({
      authenticate: async () => ({ user: { id: 192837465, super_admin: true, type: "api" } }),
    });
    const res = await patch(app);
    expect(res.status).toBe(403);
    expect(res.body.detail).toMatch(/interactive administrator session/i);
  });

  test("409s a public-mode row", async () => {
    const { app } = buildApp({}, { ...REGULAR_ROW, auth_mode: "public" });
    const res = await patch(app);
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/regular-mode/i);
  });

  test("409s a password-mode row", async () => {
    const { app } = buildApp({}, { ...REGULAR_ROW, auth_mode: "password" });
    const res = await patch(app);
    expect(res.status).toBe(409);
  });

  test("succeeds for a human super-admin and persists the flag, recording who and when", async () => {
    const { app, updateCalls } = buildApp({
      authenticate: async () => ({ user: { id: 11, super_admin: true, type: "user" } }),
    });
    const res = await patch(app, { grant_viewer_identity: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: "tender-cockpit",
      grant_viewer_identity: true,
      auth_mode: "regular",
      rights_mode: "private",
    });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({
      grant_viewer_identity: true,
      identity_granted_by: 11,
    });
    expect(updateCalls[0]!.identity_granted_at).toBeInstanceOf(Date);
  });

  // A regular share with rights_mode "public" passes checkRecordAccess for
  // every authenticated user — the administrator must see that in the
  // response, not just "it worked".
  test("echoes auth_mode and rights_mode so a public regular-mode grant is visible", async () => {
    const { app } = buildApp({}, { ...REGULAR_ROW, rights_mode: "public" });
    const res = await patch(app);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ auth_mode: "regular", rights_mode: "public" });
  });

  test("clears granted_by/granted_at (to null) on revoke", async () => {
    const { app, updateCalls } = buildApp({}, { ...REGULAR_ROW, grant_viewer_identity: true });
    const res = await patch(app, { grant_viewer_identity: false });
    expect(res.status).toBe(200);
    expect(res.body.grant_viewer_identity).toBe(false);
    expect(updateCalls[0]).toMatchObject({
      grant_viewer_identity: false,
      identity_granted_by: null,
      identity_granted_at: null,
    });
  });

  test("401s an anonymous caller", async () => {
    const { app } = buildApp({ authenticate: async () => ({}) });
    const res = await patch(app);
    expect(res.status).toBe(401);
  });

  test("400s a non-boolean body", async () => {
    const { app } = buildApp();
    const res = await patch(app, { grant_viewer_identity: "true" });
    expect(res.status).toBe(400);
  });

  test("404s an unknown share name", async () => {
    const { app } = buildApp({}, undefined);
    const res = await patch(app);
    expect(res.status).toBe(404);
  });

  // The row existed at lookup time but is gone by the time the update runs —
  // this response is the administrator's only feedback, so it must not echo
  // the request body as if it had taken effect.
  test("404s when the row is deleted between lookup and update", async () => {
    const { db } = fakeDb(REGULAR_ROW, undefined);
    const { app } = buildApp({ getDb: async () => db as any });
    const res = await patch(app);
    expect(res.status).toBe(404);
  });
});

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
