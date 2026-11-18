/**
 * Skill folders are read-only inside the session sandbox: the per-session policy
 * denies writes under <sessionDir>/skills, and the writeFile tool refuses such a path
 * itself, before touching disk, in sandboxed and in degraded (direct-exec) mode.
 * Runtime mocked (wrapWithSandbox = identity), S3 mocked, persistence on (userId 7).
 * The real kernel enforcement is in create-sandbox.readonly-skills.sandbox.test.ts.
 */
jest.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    initialize: jest.fn(async () => {}),
    wrapWithSandbox: jest.fn(async (cmd: string) => cmd),
    reset: jest.fn(async () => {}),
  },
}));
jest.mock("@SRC/uppy/index.ts", () => ({
  listS3ObjectsByPrefix: jest.fn(),
  getS3ObjectBytes: jest.fn(),
  uploadFile: jest.fn(async (_c: Buffer, key: string) => `bucket/user_7/${key}`),
  getPresignedUrl: jest.fn(async () => "https://signed"),
}));
jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({ db: { from: () => ({ select: async () => [] }) } })),
}));
jest.mock("@SRC/exulu/system-dependencies.ts", () => ({ getNpmGlobalRoot: jest.fn(async () => null) }));
jest.mock("@SRC/utils/python-setup.ts", () => ({ getPythonVenvPath: () => undefined }));

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";

type CreateSandboxModule = typeof import("./create-sandbox");
type Handle = Awaited<ReturnType<CreateSandboxModule["createSessionSandbox"]>>;

const config = { fileUploads: { s3Bucket: "bucket" } } as any;
const skill = (v: number) => ({ id: "sk-ro", name: "demo", s3folder: "skills/sk-ro", current_version: v });

/** S3 key -> bytes; skill files under skills/<id>/v<version>/. */
let store: Map<string, Buffer>;
const put = (v: number, files: Record<string, string>) => {
  for (const [rel, text] of Object.entries(files)) store.set(`skills/sk-ro/v${v}/${rel}`, Buffer.from(text));
};

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

/**
 * A fresh create-sandbox module (its sandbox probe is memoized per module) seen on
 * `platform`: "darwin" probes as sandbox-capable without spawning anything, any
 * platform other than darwin/linux probes as unsupported, i.e. degraded mode. The
 * probe runs on the first createSessionSandbox, so the platform stays overridden
 * until afterEach restores it.
 */
async function loadOn(platform: string) {
  Object.defineProperty(process, "platform", { value: platform });
  let mod!: CreateSandboxModule;
  let runtime!: { SandboxManager: { wrapWithSandbox: jest.Mock } };
  let uppy!: { listS3ObjectsByPrefix: jest.Mock; getS3ObjectBytes: jest.Mock; uploadFile: jest.Mock };
  await jest.isolateModulesAsync(async () => {
    runtime = await import("@anthropic-ai/sandbox-runtime") as any;
    uppy = await import("@SRC/uppy/index.ts") as any;
    mod = await import("./create-sandbox");
  });
  uppy.listS3ObjectsByPrefix.mockImplementation(async (prefix: string) =>
    [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: store.get(key)!.length })),
  );
  uppy.getS3ObjectBytes.mockImplementation(async (key: string) => {
    const bytes = store.get(key);
    if (!bytes) throw new Error(`no object ${key}`);
    return bytes;
  });
  return { mod, wrap: runtime.SandboxManager.wrapWithSandbox, upload: uppy.uploadFile };
}

let handles: Handle[] = [];
const sid = () => `jest-roskills-${process.pid}-${Math.random().toString(36).slice(2)}`;
const write = (h: Handle, path: string, content: string) =>
  (h.tools.writeFile as any).execute({ path, content }, { toolCallId: "t", messages: [] });

beforeEach(() => {
  store = new Map();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  Object.defineProperty(process, "platform", realPlatform);
  for (const h of handles) await h.cleanup();
  handles = [];
  jest.restoreAllMocks();
});

describe("the per-session sandbox policy", () => {
  it("denies writes under <sessionDir>/skills and still allows the session dir", async () => {
    const { mod, wrap } = await loadOn("darwin");
    put(1, { "SKILL.md": "# demo" });
    const h = await mod.createSessionSandbox(sid(), [skill(1)], config, 7, undefined, { projectId: null });
    handles.push(h);
    await (h.tools.bash as any).execute({ command: "echo hi > out.txt" }, { toolCallId: "t", messages: [] });
    await h.runCommand("true");
    await h.wrapCommand("true");

    expect(wrap.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of wrap.mock.calls) {
      const fsPolicy = call[2]?.filesystem;
      expect(fsPolicy.allowWrite).toEqual([h.sessionDir]);
      expect(fsPolicy.denyWrite).toEqual([join(h.sessionDir, "skills")]);
    }
  });

  it("creates skills/ before the first command even without skills, so the deny path exists", async () => {
    const { mod } = await loadOn("darwin");
    const h = await mod.createSessionSandbox(sid(), [], config, 7, undefined, { projectId: null });
    handles.push(h);
    expect(existsSync(join(h.sessionDir, "skills"))).toBe(true);
  });
});

describe.each([
  ["sandboxed", "darwin"],
  ["degraded (direct exec)", "freebsd"],
])("writeFile under skills/ is refused, %s", (_label, platform) => {
  let h: Handle;
  let wrap: jest.Mock;
  let upload: jest.Mock;
  beforeEach(async () => {
    const loaded = await loadOn(platform);
    wrap = loaded.wrap;
    upload = loaded.upload;
    put(1, { "SKILL.md": "# demo", "run.py": "print('v1')\n" });
    h = await loaded.mod.createSessionSandbox(sid(), [skill(1)], config, 7, undefined, { projectId: null });
    handles.push(h);
    await mkdir(join(h.sessionDir, "work"));
    await symlink(join(h.sessionDir, "skills", "demo"), join(h.sessionDir, "work", "into-skill"));
    await symlink(join(h.sessionDir, "skills"), join(h.sessionDir, "skills-link"));
    wrap.mockClear();
    upload.mockClear();
  });

  const refused = [
    "skills/demo/run.py",
    "skills/demo/new.py",
    "skills/new.txt",
    "./skills/x",
    "/skills/demo/run.py",
    "skills/../skills/x",
    "work/../skills/demo/run.py",
    "work/into-skill/run.py",
    "work/into-skill/planted.py",
    "skills-link/demo/run.py",
  ];

  it.each(refused)("%p: refused with a clear message, nothing written, no upload", async (path) => {
    await expect(write(h, path, "evil")).rejects.toThrow(/read-only/);
    expect(await readFile(join(h.sessionDir, "skills", "demo", "run.py"), "utf8")).toBe("print('v1')\n");
    expect(existsSync(join(h.sessionDir, "skills", "demo", "new.py"))).toBe(false);
    expect(existsSync(join(h.sessionDir, "skills", "demo", "planted.py"))).toBe(false);
    expect(existsSync(join(h.sessionDir, "skills", "new.txt"))).toBe(false);
    expect(existsSync(join(h.sessionDir, "skills", "x"))).toBe(false);
    expect(wrap).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("an absolute path into the skills dir is refused", async () => {
    await expect(write(h, join(h.sessionDir, "skills", "demo", "run.py"), "evil")).rejects.toThrow(/read-only/);
    expect(await readFile(join(h.sessionDir, "skills", "demo", "run.py"), "utf8")).toBe("print('v1')\n");
  });

  it("the message says how a skill changes", async () => {
    await expect(write(h, "skills/demo/run.py", "evil")).rejects.toThrow(/new version/);
  });

  it("a normal path is written and uploaded as before", async () => {
    const r = await write(h, "out/report.txt", "ok");
    expect(r).toMatchObject({ success: true, url: "https://signed" });
    expect(await readFile(join(h.sessionDir, "out", "report.txt"), "utf8")).toBe("ok");
    expect(upload).toHaveBeenCalledTimes(1);
    // The mode under test is the one claimed: degraded mode never wraps.
    expect(wrap).toHaveBeenCalledTimes(platform === "darwin" ? 1 : 0);
  });

  it("a file whose name only starts with skills is not refused", async () => {
    await write(h, "skills.md", "ok");
    expect(await readFile(join(h.sessionDir, "skills.md"), "utf8")).toBe("ok");
  });
});

it("the writeFile description says skills are read-only and change by saving a new version", async () => {
  const { mod } = await loadOn("darwin");
  const h = await mod.createSessionSandbox(sid(), [], config, 7, undefined, { projectId: null });
  handles.push(h);
  const description = (h.tools.writeFile as any).description as string;
  expect(description).not.toContain("skills/<Skill name>/SKILL.md");
  expect(description).toMatch(/skills\/.*read-only/);
  expect(description).toMatch(/new version/);
});

describe("the platform still writes skill folders", () => {
  it("a version change replaces the files, and the policy still denies the sandbox", async () => {
    const { mod, wrap } = await loadOn("darwin");
    put(1, { "SKILL.md": "# v1", "old.py": "old" });
    put(2, { "SKILL.md": "# v2" });
    const id = sid();
    const h = await mod.createSessionSandbox(id, [skill(1)], config, 7, undefined, { projectId: null });
    handles.push(h);
    await expect(write(h, "skills/demo/SKILL.md", "# planted")).rejects.toThrow(/read-only/);
    await mod.createSessionSandbox(id, [skill(2)], config, 7, undefined, { projectId: null });
    expect(await readFile(join(h.sessionDir, "skills", "demo", "SKILL.md"), "utf8")).toBe("# v2");
    expect(existsSync(join(h.sessionDir, "skills", "demo", "old.py"))).toBe(false);
    wrap.mockClear();
    await h.runCommand("true");
    expect(wrap.mock.calls[0][2].filesystem.denyWrite).toEqual([join(h.sessionDir, "skills")]);
  });

  it("the reload route re-downloads into the folder", async () => {
    const { mod } = await loadOn("darwin");
    put(1, { "SKILL.md": "# v1" });
    const id = sid();
    const h = await mod.createSessionSandbox(id, [skill(1)], config, 7, undefined, { projectId: null });
    handles.push(h);
    put(1, { "SKILL.md": "# v1 reloaded" });
    expect(await mod.refreshSessionSkills(id, [skill(1)], config)).toEqual({ refreshed: 1, sandbox: true });
    expect(await readFile(join(h.sessionDir, "skills", "demo", "SKILL.md"), "utf8")).toBe("# v1 reloaded");
  });
});

describe("session files from storage never land in skills/", () => {
  const SCRIPT = "print('v1')\n";
  const sessionKey = (id: string, rel: string) => `user_7/sessions/${id}/${rel}`;
  // Each would land in skills/ (the case variants only on a case-insensitive file system).
  const planted = ["skills/demo/run.py", "skills/demo/new.py", "./skills/demo/dot.py", "a/../skills/demo/up.py", "SKILLS/demo/run.py", "Skills/demo/case.py", "skills"];
  const plant = (id: string) => {
    for (const rel of planted) store.set(sessionKey(id, rel), Buffer.from("print('evil, longer than the real script')\n"));
    store.set(sessionKey(id, "note.txt"), Buffer.from("hello"));
  };
  const expectSkillIntact = async (h: Handle) => {
    expect(await readFile(join(h.sessionDir, "skills", "demo", "run.py"), "utf8")).toBe(SCRIPT);
    expect((await readdir(join(h.sessionDir, "skills", "demo"))).sort()).toEqual(["SKILL.md", "run.py"]);
    expect(await readdir(join(h.sessionDir, "skills"))).toEqual(["demo"]);
  };

  it("cold start: planted keys are skipped (and logged), a normal session file is restored", async () => {
    const { mod } = await loadOn("darwin");
    const id = sid();
    put(1, { "SKILL.md": "# demo", "run.py": SCRIPT });
    plant(id);
    const h = await mod.createSessionSandbox(id, [skill(1)], config, 7, undefined, { projectId: null });
    handles.push(h);
    await expectSkillIntact(h);
    expect(await readFile(join(h.sessionDir, "note.txt"), "utf8")).toBe("hello");
    const logged = (console.warn as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes(sessionKey(id, "skills/demo/run.py")) && l.includes("skills/"))).toBe(true);
    expect(logged.join("\n")).not.toContain("evil");
  });

  it("restart (directory on disk, sizes differ): planted keys are still skipped", async () => {
    const first = await loadOn("darwin");
    const id = sid();
    put(1, { "SKILL.md": "# demo", "run.py": SCRIPT });
    const h1 = await first.mod.createSessionSandbox(id, [skill(1)], config, 7, undefined, { projectId: null });
    handles.push(h1);
    plant(id);
    Object.defineProperty(process, "platform", realPlatform);
    // A fresh module = a restarted process: empty cache, the session dir survives.
    const second = await loadOn("darwin");
    const h2 = await second.mod.createSessionSandbox(id, [skill(1)], config, 7, undefined, { projectId: null });
    handles.push(h2);
    expect(h2).not.toBe(h1);
    await expectSkillIntact(h2);
    expect(await readFile(join(h2.sessionDir, "note.txt"), "utf8")).toBe("hello");
  });

  it("downloadKeyIntoSandbox reports a planted key as not written and still writes a normal one", async () => {
    const { mod } = await loadOn("darwin");
    const id = sid();
    put(1, { "SKILL.md": "# demo", "run.py": SCRIPT });
    const h = await mod.createSessionSandbox(id, [skill(1)], config, 7, undefined, { projectId: null });
    handles.push(h);
    plant(id);
    // On a case-sensitive file system SKILLS/ is simply another folder.
    const caseInsensitive = existsSync(join(h.sessionDir, "SKILLS"));
    const caseVariant = (r: string) => /^S(KILLS|kills)\//.test(r);
    for (const rel of planted.filter((r) => caseInsensitive || !caseVariant(r))) {
      expect(await mod.downloadKeyIntoSandbox({ sessionId: id, userId: 7, fullS3Key: sessionKey(id, rel), config })).toEqual({
        written: false,
      });
    }
    await expectSkillIntact(h);
    const ok = await mod.downloadKeyIntoSandbox({ sessionId: id, userId: 7, fullS3Key: sessionKey(id, "note.txt"), config });
    expect(ok.written).toBe(true);
    expect(await readFile(join(h.sessionDir, "note.txt"), "utf8")).toBe("hello");
  });
});
