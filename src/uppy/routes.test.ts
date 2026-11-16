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
import { createUppyRoutes, getS3SignedUploadUrl } from "./index";

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
