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
import { existsSync } from "node:fs";
import { uploadFile, listS3ObjectsByPrefix, getS3ObjectBytes } from "@SRC/uppy/index.ts";
import { createSessionSandbox, downloadKeyIntoSandbox, refreshSessionSkills } from "./create-sandbox";
import { readRegularFileInside, writeFileInside } from "./safe-fs";

const upload = uploadFile as jest.Mock;
const list = listS3ObjectsByPrefix as jest.Mock;
const bytes = getS3ObjectBytes as jest.Mock;
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
  list.mockReset();
  list.mockImplementation(async () => []);
  bytes.mockReset();
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

/** S3 holds `files` (name -> body) under the session prefix and `skills` under skill prefixes. */
function s3(id: string, files: Record<string, string>, skills: Record<string, string> = {}) {
  const sessionPrefix = `user_7/sessions/${id}/`;
  const all: Record<string, string> = {};
  for (const [n, b] of Object.entries(files)) all[`${sessionPrefix}${n}`] = b;
  for (const [k, b] of Object.entries(skills)) all[k] = b;
  list.mockImplementation(async (prefix: string) =>
    Object.entries(all)
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, body]) => ({ key, size: body.length, lastModified: new Date() })),
  );
  bytes.mockImplementation(async (key: string) => Buffer.from(all[key] ?? ""));
}

const victim = () => readFile(join(victimDir, "secret.txt"), "utf8");

describe("session restore does not write through agent-planted links", () => {
  it("a symlink planted at the destination is replaced, the victim untouched", async () => {
    const id = sid();
    const h = await open(id);
    await symlink(join(victimDir, "secret.txt"), join(h.sessionDir, "doc.txt"));
    s3(id, { "doc.txt": "uploaded by the user" });
    await open(id); // cache hit: re-sync of missing session files
    expect(await victim()).toBe("TOP SECRET");
    expect((await lstat(join(h.sessionDir, "doc.txt"))).isFile()).toBe(true);
    expect(await readFile(join(h.sessionDir, "doc.txt"), "utf8")).toBe("uploaded by the user");
  });

  it("a symlinked parent directory is not written through", async () => {
    const id = sid();
    const h = await open(id);
    await symlink(victimDir, join(h.sessionDir, "sub"));
    s3(id, { "sub/secret.txt": "overwritten!", "sub/new.txt": "planted" });
    await open(id);
    expect(await victim()).toBe("TOP SECRET");
    expect(existsSync(join(victimDir, "new.txt"))).toBe(false);
  });

  it("without links, restore behaves as before", async () => {
    const id = sid();
    const h = await open(id);
    s3(id, { "a/b/c.txt": "deep", "top.txt": "top" });
    await open(id);
    expect(await readFile(join(h.sessionDir, "a", "b", "c.txt"), "utf8")).toBe("deep");
    expect(await readFile(join(h.sessionDir, "top.txt"), "utf8")).toBe("top");
  });
});

describe("downloadKeyIntoSandbox", () => {
  it("refuses a key suffix containing .. and writes nothing outside", async () => {
    const id = sid();
    const h = await open(id);
    const escape = `../${id}-escaped.txt`;
    bytes.mockResolvedValue(Buffer.from("x"));
    await expect(
      downloadKeyIntoSandbox({ sessionId: id, userId: 7, fullS3Key: `bkt/user_7/sessions/${id}/${escape}`, config }),
    ).rejects.toThrow(/\.\./);
    expect(existsSync(join(h.sessionDir, escape))).toBe(false);
  });

  it("does not write through a symlinked parent or a planted destination link", async () => {
    const id = sid();
    const h = await open(id);
    await symlink(victimDir, join(h.sessionDir, "sub"));
    await symlink(join(victimDir, "secret.txt"), join(h.sessionDir, "f.txt"));
    bytes.mockResolvedValue(Buffer.from("overwritten!"));
    await expect(
      downloadKeyIntoSandbox({ sessionId: id, userId: 7, fullS3Key: `bkt/user_7/sessions/${id}/sub/secret.txt`, config }),
    ).rejects.toThrow();
    const ok = await downloadKeyIntoSandbox({ sessionId: id, userId: 7, fullS3Key: `bkt/user_7/sessions/${id}/f.txt`, config });
    expect(ok.written).toBe(true);
    expect(await victim()).toBe("TOP SECRET");
    expect((await lstat(join(h.sessionDir, "f.txt"))).isFile()).toBe(true);
  });
});

describe("skills/ replaced by a link", () => {
  const skill = (v: number) => ({ id: "sk1", name: "Review", current_version: v }) as any;
  const skillFiles = (v: number) => ({ [`skills/sk1/v${v}/SKILL.md`]: `v${v}` });

  it("an upgrade leaves the victim directory untouched and recreates skills/", async () => {
    const id = sid();
    s3(id, {}, skillFiles(1));
    const h = await createSessionSandbox(id, [skill(1)], config, 7, undefined, { projectId: null });
    handles.push(h);
    expect(await readFile(join(h.sessionDir, "skills", "Review", "SKILL.md"), "utf8")).toBe("v1");

    await mkdir(join(victimDir, "Review"));
    await writeFile(join(victimDir, "Review", "keep.txt"), "keep");
    await rm(join(h.sessionDir, "skills"), { recursive: true, force: true });
    await symlink(victimDir, join(h.sessionDir, "skills"));

    s3(id, {}, skillFiles(2));
    await createSessionSandbox(id, [skill(2)], config, 7, undefined, { projectId: null });
    expect(await readFile(join(victimDir, "Review", "keep.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(victimDir, "Review", "SKILL.md"))).toBe(false);
    expect((await lstat(join(h.sessionDir, "skills"))).isDirectory()).toBe(true);
    expect(await readFile(join(h.sessionDir, "skills", "Review", "SKILL.md"), "utf8")).toBe("v2");
  });

  it("a reload with skills/<name> replaced by a link removes only the link", async () => {
    const id = sid();
    s3(id, {}, skillFiles(1));
    const h = await createSessionSandbox(id, [skill(1)], config, 7, undefined, { projectId: null });
    handles.push(h);
    await mkdir(join(victimDir, "inner"));
    await writeFile(join(victimDir, "inner", "keep.txt"), "keep");
    await rm(join(h.sessionDir, "skills", "Review"), { recursive: true, force: true });
    await symlink(join(victimDir, "inner"), join(h.sessionDir, "skills", "Review"));

    await refreshSessionSkills(id, [skill(1)], config);
    expect(await readFile(join(victimDir, "inner", "keep.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(victimDir, "inner", "SKILL.md"))).toBe(false);
    expect((await lstat(join(h.sessionDir, "skills", "Review"))).isDirectory()).toBe(true);
    expect(await readFile(join(h.sessionDir, "skills", "Review", "SKILL.md"), "utf8")).toBe("v1");
  });
});

describe("writeFileInside", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "exulu-session-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each(["../x", "a/../../x", "/etc/x", "", "a/.."])("refuses %p", async (p) => {
    await expect(writeFileInside(dir, p, "x")).rejects.toThrow();
  });

  it("creates parents and replaces an existing regular file", async () => {
    await writeFileInside(dir, "a/b/c.txt", "one");
    await writeFileInside(dir, "a/b/c.txt", "two");
    expect(await readFile(join(dir, "a", "b", "c.txt"), "utf8")).toBe("two");
  });
});
