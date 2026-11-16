/**
 * The generic /s3/* routes, mounted through createUppyRoutes with the auth,
 * database and S3 layers mocked: the refusals the project-files feature relies
 * on are asserted at the HTTP level, not only through mayUseGenericS3Route.
 */
import express from "express";
import request from "supertest";
import { S3Client } from "@aws-sdk/client-s3";

jest.mock("../auth/auth", () => ({ authentication: jest.fn() }));
jest.mock("../auth/get-token", () => ({ getToken: jest.fn(async () => null) }));
jest.mock("../postgres/client", () => ({ postgresClient: jest.fn(async () => ({ db: {} })) }));
jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn(async () => "https://s3.example/signed"),
}));

import { authentication } from "../auth/auth";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createUppyRoutes, getS3SignedUploadUrl, mayReadGenericS3Key, multipartKeyBelongsTo } from "./index";

const config: any = {
  fileUploads: {
    s3region: "eu-central-1",
    s3key: "k",
    s3secret: "s",
    s3Bucket: "bkt",
    s3endpoint: "https://minio.example",
    s3prefix: undefined,
  },
};

const authAs = (user: any) =>
  (authentication as jest.Mock).mockResolvedValue(
    user ? { user } : { error: true, code: 401, message: "Not authenticated." },
  );

let send: jest.SpyInstance;
let app: express.Express;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  await createUppyRoutes(app, config);
});

beforeEach(() => {
  jest.clearAllMocks();
  send = jest.spyOn(S3Client.prototype, "send").mockImplementation(async () => ({ Contents: [] }) as any);
});

afterEach(() => send.mockRestore());

const normalUser = { id: 1, type: "user", super_admin: false };
const projectKey = "bkt/projects/x/files/a";

describe("/s3/* refuse project files for a normal user", () => {
  it("GET /s3/download answers 403 and signs nothing", async () => {
    authAs(normalUser);
    const res = await request(app).get("/s3/download").query({ key: projectKey });
    expect(res.status).toBe(403);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it("DELETE /s3/delete answers 403 and deletes nothing", async () => {
    authAs(normalUser);
    const res = await request(app).delete("/s3/delete").query({ key: projectKey });
    expect(res.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it("POST /s3/object answers 403 and sends no HeadObject", async () => {
    authAs(normalUser);
    const res = await request(app).post("/s3/object").send({ key: projectKey });
    expect(res.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("GET /s3/sts", () => {
  it("answers 401 unauthenticated", async () => {
    authAs(null);
    const res = await request(app).get("/s3/sts");
    expect(res.status).toBe(401);
  });
});

describe("GET /s3/list", () => {
  it.each([
    [1, "user_1/"],
    [10, "user_10/"],
  ])("user %s lists only under %s (user 1 must not see users 10-19)", async (id, prefix) => {
    authAs({ id, type: "user" });
    const res = await request(app).get("/s3/list");
    expect(res.status).toBe(200);
    const input = send.mock.calls[0][0].input;
    expect(input.Prefix).toBe(prefix);
  });
});

describe("getS3SignedUploadUrl", () => {
  it("signs for a day by default and for the given expiry when one is passed", async () => {
    await getS3SignedUploadUrl("user_1/a.pdf", "application/pdf", config);
    expect((getSignedUrl as jest.Mock).mock.calls[0][2]).toEqual({ expiresIn: 86400 });
    await getS3SignedUploadUrl("projects/p/files/a.pdf", "application/pdf", config, { expiresIn: 300 });
    expect((getSignedUrl as jest.Mock).mock.calls[1][2]).toEqual({ expiresIn: 300 });
  });
});

describe("/s3/multipart/:uploadId sub-routes are authenticated and bound to the caller's own keys", () => {
  // The multipart routes use the callback form of client.send.
  const callbackSend = (data: any = {}) =>
    send.mockImplementation((_cmd: any, cb?: any) => {
      if (typeof cb === "function") {
        cb(null, data);
        return undefined as any;
      }
      return Promise.resolve(data);
    });

  const own = "user_1/0b7d-_EXULU_a.pdf";
  const routes: Array<[string, (key: string) => request.Test]> = [
    ["GET sign part", (key) => request(app).get("/s3/multipart/up1/1").query({ key })],
    ["GET list parts", (key) => request(app).get("/s3/multipart/up1").query({ key })],
    [
      "POST complete",
      (key) =>
        request(app)
          .post("/s3/multipart/up1/complete")
          .query({ key })
          .send({ parts: [{ PartNumber: 1, ETag: "e" }] }),
    ],
    ["DELETE abort", (key) => request(app).delete("/s3/multipart/up1").query({ key })],
  ];

  it.each(routes)("%s answers 401 unauthenticated and touches no S3", async (_label, call) => {
    authAs(null);
    callbackSend();
    const res = await call(own);
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it.each(routes)("%s answers 403 for another user's key", async (_label, call) => {
    authAs(normalUser);
    callbackSend();
    for (const key of ["user_2/x-_EXULU_a.pdf", "user_10/x", "projects/p/files/a", "items/a.pdf", "user_1/../user_2/x"]) {
      const res = await call(key);
      expect(res.status).toBe(403);
    }
    expect(send).not.toHaveBeenCalled();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it.each(routes)("%s passes the caller's own key (and global/) to S3", async (_label, call) => {
    authAs(normalUser);
    callbackSend({ Parts: [], Location: "loc" });
    for (const key of [own, "global/x-_EXULU_a.png"]) {
      const res = await call(key);
      expect(res.status).toBe(200);
    }
    const inputs = [
      ...send.mock.calls.map((c) => c[0].input),
      ...(getSignedUrl as jest.Mock).mock.calls.map((c) => c[1].input),
    ];
    expect(inputs.map((i) => i.Key)).toEqual([own, "global/x-_EXULU_a.png"]);
    expect(inputs.every((i) => i.Bucket === "bkt")).toBe(true);
  });

  it("an API user's own prefix is user_api/", async () => {
    authAs({ id: 5, type: "api" });
    callbackSend({ Parts: [] });
    expect((await request(app).get("/s3/multipart/up1").query({ key: "user_api/x" })).status).toBe(200);
    expect((await request(app).get("/s3/multipart/up1").query({ key: "user_5/x" })).status).toBe(403);
  });
});

describe("multipartKeyBelongsTo", () => {
  const u = { id: 1, type: "user" };
  it("strips the general prefix and requires the caller's own prefix or global/", () => {
    expect(multipartKeyBelongsTo("tenant/user_1/a", u, "tenant/")).toBe(true);
    expect(multipartKeyBelongsTo("tenant/global/a", u, "tenant")).toBe(true);
    expect(multipartKeyBelongsTo("user_1/a", u, "tenant")).toBe(false);
    expect(multipartKeyBelongsTo("tenant/user_10/a", u, "tenant")).toBe(false);
    expect(multipartKeyBelongsTo("tenant/user_1/../user_2/a", u, "tenant")).toBe(false);
    expect(multipartKeyBelongsTo("", u, undefined)).toBe(false);
  });
});

describe("POST /s3/object", () => {
  const head = {
    ContentLength: 2048,
    ContentType: "application/pdf",
    LastModified: new Date("2026-11-01T10:00:00Z"),
    ETag: '"abc"',
    Metadata: { originalname: "a.pdf" },
    // Fields that must not be passed through.
    $metadata: { httpStatusCode: 200, requestId: "r1" },
    ServerSideEncryption: "AES256",
    VersionId: "v1",
  };

  it("answers 403 for another user's user_X/ key and sends no HeadObject", async () => {
    authAs(normalUser);
    const res = await request(app).post("/s3/object").send({ key: "bkt/user_2/x-_EXULU_a.pdf" });
    expect(res.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it("answers 200 for an own key with only the whitelisted fields", async () => {
    authAs(normalUser);
    send.mockResolvedValue(head as any);
    const res = await request(app).post("/s3/object").send({ key: "bkt/user_1/x-_EXULU_a.pdf" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ContentLength: 2048,
      ContentType: "application/pdf",
      LastModified: "2026-11-01T10:00:00.000Z",
      ETag: '"abc"',
      Metadata: { originalname: "a.pdf" },
    });
    expect(send.mock.calls[0][0].input).toEqual({ Bucket: "bkt", Key: "user_1/x-_EXULU_a.pdf" });
  });

  it("keeps working for keys outside user_ prefixes (global, knowledge-base item files)", async () => {
    authAs(normalUser);
    send.mockResolvedValue(head as any);
    expect((await request(app).post("/s3/object").send({ key: "bkt/global/x.png" })).status).toBe(200);
    expect((await request(app).post("/s3/object").send({ key: "bkt/items/ctx/a.pdf" })).status).toBe(200);
  });

  it.each([[undefined], [42], [""], [["bkt/user_1/a"]], [{ a: 1 }]])("answers 400 for key %p", async (key) => {
    authAs(normalUser);
    const res = await request(app).post("/s3/object").send({ key });
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("answers 404 JSON for a missing object", async () => {
    authAs(normalUser);
    const notFound = Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
    send.mockRejectedValue(notFound);
    const res = await request(app).post("/s3/object").send({ key: "bkt/user_1/gone.pdf" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Object not found." });
  });
});

describe("mayReadGenericS3Key — the user_ rule applies to the first path segment only", () => {
  const u1 = { id: 1, type: "user", super_admin: false };
  it("refuses a nested user_<caller>/ under another user's prefix", () => {
    expect(mayReadGenericS3Key("user_2/x/user_1/y", u1)).toBe(false);
  });
  it("allows a user_ substring in a filename or deeper segment", () => {
    expect(mayReadGenericS3Key("items/report_user_1.pdf", u1)).toBe(true);
    expect(mayReadGenericS3Key("items/user_2.pdf", u1)).toBe(true);
  });
  it("keeps own and foreign first-segment decisions", () => {
    expect(mayReadGenericS3Key("user_1/a.pdf", u1)).toBe(true);
    expect(mayReadGenericS3Key("user_10/a.pdf", u1)).toBe(false);
    expect(mayReadGenericS3Key("user_api/a.pdf", u1)).toBe(false);
    expect(mayReadGenericS3Key("global/a.png", u1)).toBe(true);
  });
  it("looks past the general prefix", () => {
    expect(mayReadGenericS3Key("tenant/user_1/a.pdf", u1, "tenant/")).toBe(true);
    expect(mayReadGenericS3Key("tenant/user_2/a.pdf", u1, "tenant")).toBe(false);
    expect(mayReadGenericS3Key("tenant/user_2/user_1/a.pdf", u1, "tenant")).toBe(false);
  });
  it("API users and super admins read anything", () => {
    expect(mayReadGenericS3Key("user_2/a", { id: 9, type: "api" })).toBe(true);
    expect(mayReadGenericS3Key("user_2/a", { id: 9, super_admin: true })).toBe(true);
  });
});

describe("GET /s3/download uses the first-segment rule", () => {
  it("refuses user_2/x/user_1/y for user 1 and allows items/report_user_1.pdf", async () => {
    authAs(normalUser);
    expect((await request(app).get("/s3/download").query({ key: "bkt/user_2/x/user_1/y" })).status).toBe(405);
    expect((await request(app).get("/s3/download").query({ key: "bkt/items/report_user_1.pdf" })).status).toBe(200);
  });
});
