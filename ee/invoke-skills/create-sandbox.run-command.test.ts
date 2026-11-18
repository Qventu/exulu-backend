/**
 * runCommand: the programmatic runner used by skill actions. Real (direct-exec) sandbox,
 * S3 mocked, persistence enabled (userId 7), same harness as create-sandbox.symlink.test.ts.
 */
jest.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    initialize: jest.fn(async () => {}),
    wrapWithSandbox: jest.fn(async (cmd: string) => cmd),
    reset: jest.fn(async () => {}),
  },
}));
jest.mock("@SRC/uppy/index.ts", () => ({
  listS3ObjectsByPrefix: jest.fn(async () => []),
  getS3ObjectBytes: jest.fn(),
  uploadFile: jest.fn(async (_c: Buffer, key: string) => `bucket/user_7/${key}`),
  getPresignedUrl: jest.fn(async () => "https://signed"),
}));
jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({ db: { from: () => ({ select: async () => [] }) } })),
}));
jest.mock("@SRC/exulu/system-dependencies.ts", () => ({ getNpmGlobalRoot: jest.fn(async () => null) }));
jest.mock("@SRC/utils/python-setup.ts", () => ({ getPythonVenvPath: () => undefined }));

import { realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { uploadFile } from "@SRC/uppy/index.ts";
import { createSessionSandbox, type SessionSandboxHandle } from "./create-sandbox";

const upload = uploadFile as jest.Mock;
const config = { fileUploads: { s3Bucket: "bucket" } } as any;
let handle: SessionSandboxHandle;

beforeEach(async () => {
  upload.mockClear();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
  handle = await createSessionSandbox(
    `jest-runcmd-${process.pid}-${Math.random().toString(36).slice(2)}`,
    [],
    config,
    7,
    undefined,
    { projectId: null },
  );
});
afterEach(async () => {
  await handle.cleanup();
  jest.restoreAllMocks();
});

test("extraEnv reaches the command and does not leak into the next call", async () => {
  const a = await handle.runCommand('printf %s "$EXULU_INPUTS_DIR"', { extraEnv: { EXULU_INPUTS_DIR: "/x" } });
  expect(a.stdout.startsWith("/x")).toBe(true);
  const b = await handle.runCommand('printf %s "${EXULU_INPUTS_DIR:-none}"');
  expect(b.stdout.startsWith("none")).toBe(true);
});

test("the command runs in the session directory and reports its exit code", async () => {
  const r = await handle.runCommand("pwd; echo oops >&2; exit 3");
  expect(realpathSync(r.stdout.trim().split("\n")[0]!)).toBe(realpathSync(handle.sessionDir));
  expect(r.stderr).toContain("oops");
  expect(r.exitCode).toBe(3);
  expect(r.timedOut).toBe(false);
});

test("timeout kills the whole process group", async () => {
  const r = await handle.runCommand("sleep 5; echo done", { timeoutMs: 200 });
  expect(r.timedOut).toBe(true);
  expect(r.exitCode).toBe(124);
  expect(r.stdout).not.toContain("done");
});

test("a file created by the command is mirrored, .exulu-inputs is not", async () => {
  const r = await handle.runCommand(
    "mkdir -p .exulu-inputs/r1 && echo x > .exulu-inputs/r1/a.json && echo y > out.txt",
  );
  expect(r.artifacts.map((a) => a.relativePath)).toEqual(["out.txt"]);
  expect(r.stdout).toContain("[exulu-artifacts]");
  expect(r.stdout).toContain("out.txt: https://signed");
  expect(upload.mock.calls.map((c) => c[1] as string).some((k) => k.includes(".exulu-inputs"))).toBe(false);
});

test("the bash tool still returns stdout, exit code and the artifacts block", async () => {
  const r: any = await (handle.tools.bash as any).execute(
    { command: "echo hello; echo y > made.txt" },
    { toolCallId: "t", messages: [] },
  );
  expect(r.stdout).toContain("hello");
  expect(r.exitCode).toBe(0);
  expect(r.artifacts.map((a: any) => a.relativePath)).toEqual(["made.txt"]);
  expect(r.stdout).toContain("[exulu-artifacts]");
  expect(r.stdout).toContain("made.txt: https://signed");
  expect(r.artifactsOmitted).toBeUndefined();
});

test("pwd prints the session dir", async () => {
  const r = await handle.runCommand("pwd");
  expect(realpathSync(r.stdout.trim())).toBe(realpathSync(handle.sessionDir));
});

test("the command gets the constructed env, not the backend's process.env (declared secret is stripped)", async () => {
  process.env.POSTGRES_DB_PASSWORD = "leaked";
  try {
    const h2 = await createSessionSandbox(
      `jest-runcmd-env-${process.pid}-${Math.random().toString(36).slice(2)}`,
      [], config, 7, undefined, { projectId: null },
    );
    try {
      const r = await h2.runCommand('printf %s "${POSTGRES_DB_PASSWORD:-none}"');
      expect(r.stdout.startsWith("none")).toBe(true);
    } finally {
      await h2.cleanup();
    }
  } finally {
    delete process.env.POSTGRES_DB_PASSWORD;
  }
});

test("writeFile into .exulu-inputs is neither uploaded nor given a URL, but exists on disk", async () => {
  const r: any = await (handle.tools.writeFile as any).execute(
    { path: ".exulu-inputs/r1/x.json", content: "{}" },
    { toolCallId: "t", messages: [] },
  );
  expect(upload).not.toHaveBeenCalled();
  expect(r.url).toBeUndefined();
  expect(existsSync(join(handle.sessionDir, ".exulu-inputs/r1/x.json"))).toBe(true);
});
