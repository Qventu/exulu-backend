/**
 * POST /shared-artifacts — a share may only point at an object the caller
 * uploaded (ownsObjectKey), so the content route can never be used to read a
 * project file or another user's file. Supertest, no Postgres.
 */
import express from "express";
import request from "supertest";

import { registerCreateShareRoute, type CreateShareRouteDeps } from "./shared-artifact-create-route";

function buildApp(over: Partial<CreateShareRouteDeps> = {}) {
  const inserts: Record<string, unknown>[] = [];
  const db = (_table: string) => ({
    where: (_cond: any) => ({ first: async () => undefined }),
    insert: (row: Record<string, unknown>) => {
      inserts.push(row);
      return { returning: async () => [{ id: 1, ...row }] };
    },
  });
  const deps: CreateShareRouteDeps = {
    authenticate: async (req) => {
      const id = req.headers["x-user"];
      if (!id) return { code: 401, message: "no auth" };
      return { user: { id: Number(id), super_admin: req.headers["x-super"] === "1" } as any };
    },
    getDb: async () => db as any,
    bucket: "bkt",
    s3prefix: "imp",
    handleRBACUpdate: jest.fn(async () => {}),
    ...over,
  };
  const app = express();
  app.use(express.json());
  registerCreateShareRoute(app, deps);
  return { app, inserts };
}

const body = (s3key: string) => ({ s3key, name: "my-share", auth_mode: "public" });

describe("POST /shared-artifacts — ownership of the shared object", () => {
  it("creates a share for the caller's own upload (bucket and general prefix tolerated)", async () => {
    const { app, inserts } = buildApp();
    const res = await request(app).post("/shared-artifacts").set("x-user", "7").send(body("bkt/imp/user_7/abc-_EXULU_a.html"));
    expect(res.status).toBe(201);
    expect(inserts[0]).toMatchObject({ s3key: "imp/user_7/abc-_EXULU_a.html", created_by: 7 });
  });

  it("refuses another user's file with 403 and writes nothing", async () => {
    const { app, inserts } = buildApp();
    const res = await request(app).post("/shared-artifacts").set("x-user", "7").send(body("bkt/imp/user_8/abc-_EXULU_a.html"));
    expect(res.status).toBe(403);
    expect(inserts).toEqual([]);
  });

  it("refuses a project file with 403 and writes nothing", async () => {
    const { app, inserts } = buildApp();
    const res = await request(app).post("/shared-artifacts").set("x-user", "7").send(body("bkt/imp/projects/p1/files/x.pdf"));
    expect(res.status).toBe(403);
    expect(inserts).toEqual([]);
  });

  it("lets a super admin share any object (ownsObjectKey's bypass)", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post("/shared-artifacts")
      .set("x-user", "7")
      .set("x-super", "1")
      .send(body("bkt/imp/projects/p1/files/x.pdf"));
    expect(res.status).toBe(201);
  });

  it("still answers 401 unauthenticated and 400 on an invalid body", async () => {
    const { app } = buildApp();
    expect((await request(app).post("/shared-artifacts").send(body("bkt/imp/user_7/a.html"))).status).toBe(401);
    expect((await request(app).post("/shared-artifacts").set("x-user", "7").send({ name: "x" })).status).toBe(400);
  });
});
