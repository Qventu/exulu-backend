import express from "express";
import request from "supertest";

import { registerProjectFileRoutes, registerProjectFileRoutesUnconfigured, type ProjectFileRouteDeps } from "./project-file-routes";
import { makeLoadAuthedProject } from "./project-file-handlers";
import { hasProjectAccess } from "./project-access";
import { createOriginResolver } from "./file-origin";
import { MAX_PROJECT_FILES } from "./project-files";

const PROJECT = { id: "p1", created_by: 1, rights_mode: "users" };
const RBAC = { type: "users", users: [{ id: "2", rights: "read" }], roles: [] };
const PP = "projects/p1/files/";
const sessionPrefix = (owner: number, sid: string) => `user_${owner}/sessions/${sid}/`;

function setup(
  over: {
    head?: (key: string) => Promise<Record<string, string> | undefined>;
    s3prefix?: string;
    failCopyOf?: string;
    failSign?: boolean;
  } = {},
) {
  // key -> { lastModified, meta }
  const store = new Map<string, { lastModified: Date; meta?: Record<string, string> }>();
  const put = (key: string, meta?: Record<string, string>) =>
    store.set(key, { lastModified: new Date("2026-11-01T10:00:00Z"), meta });
  const copies: [string, string][] = [];

  const loadAuthedProject = makeLoadAuthedProject({
    authenticate: async (req) => {
      const id = req.headers["x-user"];
      return id ? { user: { id: Number(id), role: null } } : { code: 401, message: "no auth" };
    },
    getProject: async (id) => (id === PROJECT.id ? PROJECT : undefined),
    getRbac: async () => RBAC,
  });

  const deps: ProjectFileRouteDeps = {
    s3prefix: over.s3prefix ?? null,
    loadAuthedProject,
    canWrite: async (user, project) => hasProjectAccess({ project, rbac: RBAC, user, want: "write" }),
    loadAuthedSession: async (req, res, sid) => {
      const user = { id: Number(req.headers["x-user"]) };
      const session = { id: sid, user: sid === "s-user1" ? 1 : 9 };
      if (session.user !== user.id && sid !== "s-shared") {
        res.status(403).json({ detail: "no session access" });
        return null;
      }
      return { user, session };
    },
    buildSessionPrefixes: (uid, sid) => ({
      fullSessionPrefix: `${over.s3prefix ? `${over.s3prefix}/` : ""}${sessionPrefix(Number(uid), sid)}`,
    }),
    s3: {
      list: async (prefix) =>
        [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, v]) => ({ key, size: 10, lastModified: v.lastModified })),
      presign: async (key) => `https://s3/${key}`,
      signUpload: async (key) => {
        if (over.failSign) throw new Error("sts down");
        return `https://s3/put/${key}`;
      },
      remove: async (key) => void store.delete(key),
      etag: async (key) => (store.has(key) ? "etag" : null),
      listProjectNames: async (prefix) =>
        [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.split("/").pop()!),
      sizeOf: async (key) => (store.has(key) ? 10 : null),
      copy: async (src, dest) => {
        if (over.failCopyOf && src.endsWith(over.failCopyOf)) throw new Error("S3 down");
        copies.push([src, dest]);
        store.set(dest, { ...store.get(src)!, lastModified: new Date() });
      },
    },
    resolveOrigin: createOriginResolver(
      over.head ?? (async (key) => store.get(key)?.meta),
    ),
    inferContentType: () => "application/pdf",
    previewPdf: async () => Buffer.from("%PDF"),
    isPreviewError: () => false,
  };
  const app = express();
  app.use(express.json());
  registerProjectFileRoutes(app, deps);
  return { app, store, put, copies };
}

const as = (r: request.Test, u: number) => r.set("x-user", String(u));

describe("project file routes", () => {
  it("list: creator 200 (canWrite), reader 200 (read-only), outsider 403, anonymous 401, unknown 404", async () => {
    const { app, put } = setup();
    put(`${PP}a.pdf`, { "exulu-origin": "agent" });
    const creator = await as(request(app).get("/projects/p1/files"), 1);
    expect(creator.status).toBe(200);
    expect(creator.body.canWrite).toBe(true);
    expect(creator.body.files[0]).toMatchObject({ name: "a.pdf", origin: "agent" });
    const reader = await as(request(app).get("/projects/p1/files"), 2);
    expect(reader.status).toBe(200);
    expect(reader.body.canWrite).toBe(false);
    expect((await as(request(app).get("/projects/p1/files"), 3)).status).toBe(403);
    expect((await request(app).get("/projects/p1/files")).status).toBe(401);
    expect((await as(request(app).get("/projects/nope/files"), 1)).status).toBe(404);
  });

  it("list: a failing HEAD still lists the file as origin user", async () => {
    const { app, put } = setup({ head: async () => Promise.reject(new Error("boom")) });
    put(`${PP}a.pdf`);
    const res = await as(request(app).get("/projects/p1/files"), 1);
    expect(res.status).toBe(200);
    expect(res.body.files[0].origin).toBe("user");
  });

  it("upload-sign: creator 200, reader and outsider 403", async () => {
    const { app } = setup();
    const body = { filename: "n.pdf", contentType: "application/pdf" };
    const ok = await as(request(app).post("/projects/p1/files/upload-sign").send(body), 1);
    expect(ok.status).toBe(200);
    expect(ok.body.key).toBe(`${PP}n.pdf`);
    expect((await as(request(app).post("/projects/p1/files/upload-sign").send(body), 2)).status).toBe(403);
    expect((await as(request(app).post("/projects/p1/files/upload-sign").send(body), 3)).status).toBe(403);
  });

  it("upload-sign: existing name is 409 with lastModified, overwrite lets it through", async () => {
    const { app, put } = setup();
    put(`${PP}a.pdf`);
    const body = { filename: "a.pdf", contentType: "application/pdf" };
    const clash = await as(request(app).post("/projects/p1/files/upload-sign").send(body), 1);
    expect(clash.status).toBe(409);
    expect(clash.body).toEqual({ error: "exists", lastModified: "2026-11-01T10:00:00.000Z" });
    const over = await as(request(app).post("/projects/p1/files/upload-sign").send({ ...body, overwrite: true }), 1);
    expect(over.status).toBe(200);
  });

  it("upload-sign: the 201st file is project_full, but overwriting at 200 is fine", async () => {
    const { app, put } = setup();
    for (let i = 0; i < MAX_PROJECT_FILES; i++) put(`${PP}f${i}.pdf`);
    const full = await as(
      request(app).post("/projects/p1/files/upload-sign").send({ filename: "new.pdf", contentType: "application/pdf" }),
      1,
    );
    expect(full.status).toBe(400);
    expect(full.body).toEqual({ error: "project_full", max: MAX_PROJECT_FILES });
    const over = await as(
      request(app)
        .post("/projects/p1/files/upload-sign")
        .send({ filename: "f1.pdf", contentType: "application/pdf", overwrite: true }),
      1,
    );
    expect(over.status).toBe(200);
  });

  it("delete: key outside the project prefix is 403, inside is deleted, reader is 403", async () => {
    const { app, put, store } = setup();
    put(`${PP}a.pdf`);
    put("user_1/sessions/s-user1/b.pdf");
    expect((await as(request(app).delete("/projects/p1/files").query({ key: "user_1/sessions/s-user1/b.pdf" }), 1)).status).toBe(403);
    expect((await as(request(app).delete("/projects/p1/files").query({ key: `${PP}../x` }), 1)).status).toBe(403);
    expect((await as(request(app).delete("/projects/p1/files").query({ key: `${PP}a.pdf` }), 2)).status).toBe(403);
    expect(store.has(`${PP}a.pdf`)).toBe(true);
    expect((await as(request(app).delete("/projects/p1/files").query({ key: `${PP}a.pdf` }), 1)).status).toBe(200);
    expect(store.has(`${PP}a.pdf`)).toBe(false);
  });

  it("preview-pdf: reader may read, outsider and foreign keys are 403", async () => {
    const { app, put } = setup();
    put(`${PP}a.pdf`);
    put("user_1/sessions/s-user1/b.pdf");
    const ok = await as(request(app).get("/projects/p1/file/preview-pdf").query({ key: `${PP}a.pdf` }), 2);
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toContain("application/pdf");
    expect((await as(request(app).get("/projects/p1/file/preview-pdf").query({ key: `${PP}a.pdf` }), 3)).status).toBe(403);
    expect((await as(request(app).get("/projects/p1/file/preview-pdf").query({ key: "user_1/sessions/s-user1/b.pdf" }), 1)).status).toBe(403);
  });

  it("promote: copies, keeps the source, preserves what was accepted", async () => {
    const { app, put, store, copies } = setup();
    const src = `${sessionPrefix(1, "s-user1")}report.pdf`;
    put(src, { "exulu-origin": "agent" });
    const res = await as(request(app).post("/projects/p1/files/promote").send({ sessionId: "s-user1", keys: [src] }), 1);
    expect(res.status).toBe(200);
    expect(res.body.promoted).toEqual([{ key: `${PP}report.pdf`, name: "report.pdf" }]);
    expect(copies).toEqual([[src, `${PP}report.pdf`]]);
    expect(store.has(src)).toBe(true);
  });

  it("promote: a clash copies nothing and answers 409; overwrite then proceeds", async () => {
    const { app, put, copies } = setup();
    const a = `${sessionPrefix(1, "s-user1")}a.pdf`;
    const b = `${sessionPrefix(1, "s-user1")}b.pdf`;
    put(a);
    put(b);
    put(`${PP}a.pdf`);
    const clash = await as(request(app).post("/projects/p1/files/promote").send({ sessionId: "s-user1", keys: [a, b] }), 1);
    expect(clash.status).toBe(409);
    expect(clash.body.clashes).toEqual(["a.pdf"]);
    expect(copies).toEqual([]);
    const over = await as(
      request(app).post("/projects/p1/files/promote").send({ sessionId: "s-user1", keys: [a, b], overwrite: true }),
      1,
    );
    expect(over.status).toBe(200);
    expect(copies).toHaveLength(2);
  });

  it("promote: foreign session 403, reader 403, key from another session rejected", async () => {
    const { app, put, copies } = setup();
    const foreign = `${sessionPrefix(9, "s-other")}x.pdf`;
    put(foreign);
    expect((await as(request(app).post("/projects/p1/files/promote").send({ sessionId: "s-other", keys: [foreign] }), 1)).status).toBe(403);
    expect((await as(request(app).post("/projects/p1/files/promote").send({ sessionId: "s-user1", keys: [] }), 2)).status).toBe(403);
    const res = await as(request(app).post("/projects/p1/files/promote").send({ sessionId: "s-user1", keys: [foreign] }), 1);
    expect(res.status).toBe(200);
    expect(res.body.promoted).toEqual([]);
    expect(res.body.rejected).toHaveLength(1);
    expect(copies).toEqual([]);
  });

  it("promote: a copy failing midway answers 200 with promoted and rejected", async () => {
    const { app, put } = setup({ failCopyOf: "b.pdf" });
    const a = `${sessionPrefix(1, "s-user1")}a.pdf`;
    const b = `${sessionPrefix(1, "s-user1")}b.pdf`;
    put(a);
    put(b);
    const res = await as(request(app).post("/projects/p1/files/promote").send({ sessionId: "s-user1", keys: [a, b] }), 1);
    expect(res.status).toBe(200);
    expect(res.body.promoted).toEqual([{ key: `${PP}a.pdf`, name: "a.pdf" }]);
    expect(res.body.rejected).toHaveLength(1);
    expect(res.body.rejected[0].key).toBe(b);
  });

  it("promote: every copy failing answers 500 with the body; a partial success stays 200", async () => {
    const { app, put } = setup({ failCopyOf: "a.pdf" });
    const a = `${sessionPrefix(1, "s-user1")}a.pdf`;
    put(a);
    const res = await as(request(app).post("/projects/p1/files/promote").send({ sessionId: "s-user1", keys: [a] }), 1);
    expect(res.status).toBe(500);
    expect(res.body.promoted).toEqual([]);
    expect(res.body.rejected).toHaveLength(1);
  });

  it("promote: with an s3prefix the destination and the owner's session prefix both carry it", async () => {
    const { app, put, copies } = setup({ s3prefix: "exulu" });
    const src = `exulu/${sessionPrefix(1, "s-user1")}a.pdf`;
    put(src);
    const res = await as(request(app).post("/projects/p1/files/promote").send({ sessionId: "s-user1", keys: [src] }), 1);
    expect(res.status).toBe(200);
    expect(res.body.promoted).toEqual([{ key: `exulu/${PP}a.pdf`, name: "a.pdf" }]);
    expect(copies).toEqual([[src, `exulu/${PP}a.pdf`]]);
    // A key without the prefix is not this session's file.
    const bare = await as(
      request(app).post("/projects/p1/files/promote").send({ sessionId: "s-user1", keys: [`${sessionPrefix(1, "s-user1")}a.pdf`] }),
      1,
    );
    expect(bare.body.promoted).toEqual([]);
  });

  it("promote: in a shared session the OWNER's prefix applies, not the caller's", async () => {
    // s-shared belongs to user 9 but user 1 (project writer) may write to it.
    const { app, put, copies } = setup();
    const owners = `${sessionPrefix(9, "s-shared")}a.pdf`;
    const callers = `${sessionPrefix(1, "s-shared")}a.pdf`;
    put(owners);
    put(callers);
    const res = await as(
      request(app).post("/projects/p1/files/promote").send({ sessionId: "s-shared", keys: [owners, callers] }),
      1,
    );
    expect(res.status).toBe(200);
    expect(res.body.promoted).toEqual([{ key: `${PP}a.pdf`, name: "a.pdf" }]);
    expect(res.body.rejected.map((r: { key: string }) => r.key)).toEqual([callers]);
    expect(copies).toEqual([[owners, `${PP}a.pdf`]]);
  });

  it("a sibling project whose id starts with this id (p10 vs p1) fails the prefix check", async () => {
    const { app, put, store } = setup();
    put("projects/p10/files/x.pdf");
    expect((await as(request(app).delete("/projects/p1/files").query({ key: "projects/p10/files/x.pdf" }), 1)).status).toBe(403);
    expect(store.has("projects/p10/files/x.pdf")).toBe(true);
    expect((await as(request(app).get("/projects/p1/file/preview-pdf").query({ key: "projects/p10/files/x.pdf" }), 1)).status).toBe(403);
  });

  it("upload-sign: a signing failure answers the JSON error shape, not an unhandled rejection", async () => {
    const { app } = setup({ failSign: true });
    const res = await as(
      request(app).post("/projects/p1/files/upload-sign").send({ filename: "n.pdf", contentType: "application/pdf" }),
      1,
    );
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ detail: "Failed to sign the upload." });
  });

  it("promote: missing source fails the batch before anything is copied", async () => {
    const { app, copies } = setup();
    const res = await as(
      request(app).post("/projects/p1/files/promote").send({ sessionId: "s-user1", keys: [`${sessionPrefix(1, "s-user1")}gone.pdf`] }),
      1,
    );
    expect(res.body.promoted).toEqual([]);
    expect(res.body.rejected[0].reason).toContain("not found");
    expect(copies).toEqual([]);
  });
});

describe("project file routes without file uploads", () => {
  it("answer 500 with the session routes' detail instead of a 404", async () => {
    const app = express();
    app.use(express.json());
    registerProjectFileRoutesUnconfigured(app);
    for (const res of [
      await request(app).get("/projects/p1/files"),
      await request(app).post("/projects/p1/files/upload-sign").send({}),
      await request(app).delete("/projects/p1/files").query({ key: "k" }),
      await request(app).get("/projects/p1/file/preview-pdf").query({ key: "k" }),
      await request(app).post("/projects/p1/files/promote").send({}),
    ]) {
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ detail: "File uploads are not configured." });
    }
  });
});
