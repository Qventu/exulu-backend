/**
 * The backend must not follow links the agent plants in its session directory:
 * reads (artifact mirroring after bash) and writes (restore, upload sync, skills)
 * run with the backend's rights, not the sandbox's. Real (direct-exec) sandbox,
 * S3 mocked, as in create-sandbox.project-session.test.ts.
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
// node:fs/promises cannot be spied on (non-configurable exports); route `stat`
// through a hook the tests can set instead.
let mockStatHook: ((path: string) => Promise<void>) | null = null;
jest.mock("node:fs/promises", () => {
  const actual = jest.requireActual("node:fs/promises");
  return {
    ...actual,
    stat: async (p: any, ...rest: any[]) => {
      const st = await actual.stat(p, ...rest);
      if (mockStatHook) await mockStatHook(String(p));
      return st;
    },
  };
});

import { mkdtemp, readFile, rm, symlink, unlink, writeFile, mkdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadFile } from "@SRC/uppy/index.ts";
import { createSessionSandbox } from "./create-sandbox";
import { readRegularFileInside } from "./safe-fs";

const upload = uploadFile as jest.Mock;
const config = { fileUploads: { s3Bucket: "bucket" } } as any;
const uploadedKeys = () => upload.mock.calls.map((c) => c[1] as string);
const uploadedBodies = () => upload.mock.calls.map((c) => String(c[0]));

let handles: Array<{ cleanup: () => Promise<void> }> = [];
let victimDir: string;
const sid = () => `jest-symlink-${process.pid}-${Math.random().toString(36).slice(2)}`;
const open = async (id: string) => {
  const h = await createSessionSandbox(id, [], config, 7, undefined, { projectId: null });
  handles.push(h);
  return h;
};
const run = (h: any, command: string) => h.tools.bash.execute({ command }, { toolCallId: "t", messages: [] });

beforeEach(async () => {
  upload.mockClear();
  victimDir = await mkdtemp(join(tmpdir(), "exulu-victim-"));
  await writeFile(join(victimDir, "secret.txt"), "TOP SECRET");
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  for (const h of handles) await h.cleanup();
  handles = [];
  jest.restoreAllMocks();
  mockStatHook = null;
  await rm(victimDir, { recursive: true, force: true });
});

/**
 * Swap `relPath` for a link right after the after-command snapshot stats it —
 * what a process the agent left running could do between snapshot and read.
 */
function swapAfterSnapshot(sessionDir: string, relPath: string, makeLink: () => Promise<void>) {
  const target = join(sessionDir, relPath);
  let seen = 0;
  mockStatHook = async (p) => {
    if (p !== target) return;
    seen++;
    // 1st stat: before-snapshot; 2nd: after-snapshot — swap right after it.
    if (seen === 2) await makeLink();
  };
}

describe("bash artifact mirroring does not follow agent-planted links", () => {
  it("a changed file replaced by a symlink to a victim file is not uploaded", async () => {
    const h = await open(sid());
    await run(h, "echo old > out.txt");
    upload.mockClear();
    swapAfterSnapshot(h.sessionDir, "out.txt", async () => {
      await unlink(join(h.sessionDir, "out.txt"));
      await symlink(join(victimDir, "secret.txt"), join(h.sessionDir, "out.txt"));
    });
    await run(h, "sleep 0.05 && echo new > out.txt");
    expect(uploadedKeys()).not.toContain(expect.stringContaining("out.txt"));
    expect(uploadedBodies().join("")).not.toContain("TOP SECRET");
  });

  it("a file whose parent directory was swapped for a link to a victim dir is not uploaded", async () => {
    const h = await open(sid());
    await run(h, "mkdir -p d && echo old > d/secret.txt");
    upload.mockClear();
    swapAfterSnapshot(h.sessionDir, "d/secret.txt", async () => {
      await rm(join(h.sessionDir, "d"), { recursive: true, force: true });
      await symlink(victimDir, join(h.sessionDir, "d"));
    });
    await run(h, "sleep 0.05 && echo new > d/secret.txt");
    expect(uploadedBodies().join("")).not.toContain("TOP SECRET");
  });

  it("ordinary changed files are still uploaded", async () => {
    const h = await open(sid());
    await run(h, "mkdir -p out && echo hi > out/a.txt");
    expect(uploadedKeys()).toEqual([expect.stringMatching(/\/out\/a\.txt$/)]);
    expect(uploadedBodies()).toEqual(["hi\n"]);
  });
});

describe("readRegularFileInside", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "exulu-session-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a regular file inside the session directory", async () => {
    await mkdir(join(dir, "a"));
    await writeFile(join(dir, "a", "f.txt"), "ok");
    expect(String(await readRegularFileInside(dir, join(dir, "a", "f.txt")))).toBe("ok");
  });

  it("returns null for a symlink, a symlinked parent, a directory and a missing file", async () => {
    await symlink(join(victimDir, "secret.txt"), join(dir, "link.txt"));
    await symlink(victimDir, join(dir, "linkdir"));
    await mkdir(join(dir, "sub"));
    expect(await readRegularFileInside(dir, join(dir, "link.txt"))).toBeNull();
    expect(await readRegularFileInside(dir, join(dir, "linkdir", "secret.txt"))).toBeNull();
    expect(await readRegularFileInside(dir, join(dir, "sub"))).toBeNull();
    expect(await readRegularFileInside(dir, join(dir, "missing.txt"))).toBeNull();
    expect((await lstat(join(victimDir, "secret.txt"))).isFile()).toBe(true);
    expect(await readFile(join(victimDir, "secret.txt"), "utf8")).toBe("TOP SECRET");
  });
});
