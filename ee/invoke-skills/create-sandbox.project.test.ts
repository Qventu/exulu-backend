jest.mock("@SRC/uppy/index.ts", () => ({
  listS3ObjectsByPrefix: jest.fn(),
  getS3ObjectBytes: jest.fn(),
  uploadFile: jest.fn(async () => "bucket/pre/user_7/sessions/s1/out.txt"),
  getPresignedUrl: jest.fn(),
}));
jest.mock("@SRC/postgres/client", () => ({ postgresClient: jest.fn() }));

import { uploadFile } from "@SRC/uppy/index.ts";
import { isArtifactPath, uploadAgentArtifact } from "./create-sandbox";

const sessionDir = "/tmp/exulu-sessions/s1";

describe("isArtifactPath and project/", () => {
  it("project/ is not an artifact in a project session", () => {
    expect(isArtifactPath(`${sessionDir}/project/a.pdf`, sessionDir, { hasProject: true })).toBe(false);
    expect(isArtifactPath(`${sessionDir}/project`, sessionDir, { hasProject: true })).toBe(false);
  });

  it("project/ is an ordinary artifact in a session without a project", () => {
    expect(isArtifactPath(`${sessionDir}/project/a.pdf`, sessionDir, { hasProject: false })).toBe(true);
    expect(isArtifactPath(`${sessionDir}/project/a.pdf`, sessionDir)).toBe(true);
  });

  it("other paths are unaffected by the project flag", () => {
    expect(isArtifactPath(`${sessionDir}/projects/a.pdf`, sessionDir, { hasProject: true })).toBe(true);
    expect(isArtifactPath(`${sessionDir}/out/a.pdf`, sessionDir, { hasProject: true })).toBe(true);
    expect(isArtifactPath(`${sessionDir}/skills/x/SKILL.md`, sessionDir, { hasProject: true })).toBe(false);
    expect(isArtifactPath(`/tmp/elsewhere/a.pdf`, sessionDir, { hasProject: false })).toBe(false);
  });
});

describe("uploadAgentArtifact", () => {
  it("marks the upload as written by the agent", async () => {
    const content = Buffer.from("x");
    const config = { fileUploads: { s3Bucket: "bucket" } } as any;
    const key = await uploadAgentArtifact(content, "sessions/s1/out.txt", config, 7);
    expect(key).toBe("bucket/pre/user_7/sessions/s1/out.txt");
    expect(uploadFile).toHaveBeenCalledWith(
      content,
      "sessions/s1/out.txt",
      config,
      { metadata: { "exulu-origin": "agent" } },
      7,
    );
  });
});
