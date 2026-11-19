/**
 * Real kernel enforcement of the read-only skills/ folder, macOS only: every command the
 * session runs is wrapped by the REAL @anthropic-ai/sandbox-runtime (seatbelt via
 * sandbox-exec) with the per-session policy createSessionSandbox builds. jest maps the
 * runtime to a stub (it is ESM-only), so each wrap runs in a short-lived plain-node child
 * that initializes the runtime, wraps, prints the command and resets (no process is left).
 *
 * Skipped, with the reason logged, where that sandbox is unavailable (Linux CI: bwrap is
 * checked by hand in the backend image instead). S3 mocked, persistence on (userId 7).
 */
jest.mock("@anthropic-ai/sandbox-runtime", () => {
  const { execFileSync } = require("node:child_process");
  const { join } = require("node:path");
  const runtime = join(__dirname, "../../node_modules/@anthropic-ai/sandbox-runtime/dist/index.js");
  const child = `
    const [runtime, command, policy] = process.argv.slice(1);
    const { SandboxManager } = await import(runtime);
    await SandboxManager.initialize({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: ["~"], allowRead: [], allowWrite: [], denyWrite: [] },
    });
    try {
      process.stdout.write(await SandboxManager.wrapWithSandbox(command, undefined, JSON.parse(policy)));
    } finally {
      await SandboxManager.reset();
    }`;
  // Bounded: a stalled initialize/reset in the child must not block jest's event loop
  // (a sync call that never returns would outlive every jest timeout).
  const wrapReal = (command: string, policy: unknown): string =>
    execFileSync(process.execPath, ["--input-type=module", "-e", child, runtime, command, JSON.stringify(policy)], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
  return {
    // Test-only export: the skip check below wraps with exactly this path.
    __wrapReal: wrapReal,
    SandboxManager: {
      initialize: jest.fn(async () => {}),
      reset: jest.fn(async () => {}),
      wrapWithSandbox: jest.fn(async (command: string, _shell: unknown, policy: unknown) => wrapReal(command, policy)),
    },
  };
});
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

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as runtimeMock from "@anthropic-ai/sandbox-runtime";
import { getS3ObjectBytes, listS3ObjectsByPrefix, uploadFile } from "@SRC/uppy/index.ts";
import { createSessionSandbox, refreshSessionSkills, type SessionSandboxHandle } from "./create-sandbox";

/**
 * The real sandbox is in effect only where (a) createSessionSandbox's probe picks the
 * sandboxed path — on macOS it always does (create-sandbox.ts probeSandboxSupport) —
 * and (b) the real runtime can wrap AND run a command with a session-shaped policy
 * (fails e.g. inside another seatbelt sandbox). Both are checked here, bounded in time;
 * beforeEach additionally confirms each handle really wraps (inEffect).
 */
const unavailable = ((): string | null => {
  if (process.platform !== "darwin") return `platform is ${process.platform}; this test drives seatbelt (macOS)`;
  const dir = mkdtempSync(join(tmpdir(), "exulu-sbx-probe-"));
  try {
    const sess = realpathSync(dir);
    const wrapped = (runtimeMock as any).__wrapReal(`cd '${sess}' && echo ok > probe.txt && cat probe.txt`, {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: ["~"], allowRead: [sess], allowWrite: [sess], denyWrite: [] },
    }) as string;
    const out = execFileSync("/bin/bash", ["-c", wrapped], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    return out.trim() === "ok" ? null : `the real sandbox ran but printed ${JSON.stringify(out)}`;
  } catch (err) {
    return `the real sandbox cannot wrap and run a command here: ${(err as Error).message.split("\n")[0]}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
const hasPython = (() => {
  try {
    execFileSync("python3", ["-c", "pass"]);
    return true;
  } catch {
    return false;
  }
})();
if (unavailable) {
  // eslint-disable-next-line no-console
  console.warn(`[create-sandbox.readonly-skills.sandbox.test] skipped: ${unavailable}`);
}

const config = { fileUploads: { s3Bucket: "bucket" } } as any;
const skill = (v: number) => ({ id: "sk-real", name: "demo", s3folder: "skills/sk-real", current_version: v });
const V1 = { "SKILL.md": "# v1", "run.py": "import helper\nprint('ran', helper.X)\n", "helper.py": "X = 1\n" };

let store: Map<string, Buffer>;
const put = (v: number, files: Record<string, string>) => {
  for (const [rel, text] of Object.entries(files)) store.set(`skills/sk-real/v${v}/${rel}`, Buffer.from(text));
};

(unavailable ? describe.skip : describe)("skills/ under the real macOS sandbox", () => {
  jest.setTimeout(60_000);
  let id: string;
  let h: SessionSandboxHandle | undefined;
  let wraps = false;
  /** False (and logged) when this handle runs commands unwrapped: the test then checks nothing. */
  const inEffect = () => {
    if (!wraps) console.info("[create-sandbox.readonly-skills.sandbox.test] skipped: the session runs in degraded mode here");
    return wraps;
  };
  const skillFile = (name: string) => join(h!.sessionDir, "skills", "demo", name);
  const bash = (command: string) =>
    (h!.tools.bash as any).execute({ command }, { toolCallId: "t", messages: [] }) as Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>;
  const expectSkillIntact = async () => {
    expect(await readFile(skillFile("helper.py"), "utf8")).toBe(V1["helper.py"]);
    expect((await readdir(join(h!.sessionDir, "skills", "demo"))).sort()).toEqual(["SKILL.md", "helper.py", "run.py"]);
    expect(await readdir(join(h!.sessionDir, "skills"))).toEqual(["demo"]);
  };

  beforeEach(async () => {
    h = undefined;
    wraps = false;
    store = new Map();
    (listS3ObjectsByPrefix as jest.Mock).mockImplementation(async (prefix: string) =>
      [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
    );
    (getS3ObjectBytes as jest.Mock).mockImplementation(async (key: string) => store.get(key)!);
    (uploadFile as jest.Mock).mockClear();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    put(1, V1);
    id = `jest-roskills-real-${process.pid}-${Math.random().toString(36).slice(2)}`;
    h = await createSessionSandbox(id, [skill(1)], config, 7, undefined, { projectId: null });
    wraps = (await h.wrapCommand("true")) !== "true";
  });
  afterEach(async () => {
    await h?.cleanup();
    jest.restoreAllMocks();
  });

  it("bash: writing, deleting and renaming under skills/ fail; the session dir stays writable", async () => {
    if (!inEffect()) return;
    const attempts = [
      "echo evil > skills/demo/helper.py",
      "echo evil >> skills/demo/helper.py",
      "echo evil > skills/demo/new.py",
      "echo evil > skills/new.txt",
      "rm skills/demo/helper.py",
      "mv skills/demo/helper.py skills/demo/moved.py",
      "echo e > in.py && mv in.py skills/demo/helper.py",
      "mv skills/demo skills/demo2",
      "mv skills skills_old",
      "rm -rf skills",
      "ln -sf skills/demo/helper.py link.py && echo evil > link.py",
      "ln -sfn skills/demo ldir && echo evil > ldir/new.py",
      "ln skills/demo/helper.py hard.py && echo evil > hard.py",
      "chmod 777 skills/demo/helper.py",
      "touch skills/demo/helper.py",
    ];
    for (const command of attempts) {
      const r = await bash(command);
      expect({ command, failed: r.exitCode !== 0 }).toEqual({ command, failed: true });
      await expectSkillIntact();
    }
    const ok = await bash("mkdir -p out && echo fine > out/a.txt && cat out/a.txt");
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("fine");
    expect(await readFile(join(h!.sessionDir, "out", "a.txt"), "utf8")).toBe("fine\n");
  });

  it("runCommand (skill actions): the same writes fail, a session write succeeds", async () => {
    if (!inEffect()) return;
    for (const command of ["echo evil > skills/demo/helper.py", "rm skills/demo/helper.py", "mv skills/demo x"]) {
      const r = await h!.runCommand(command);
      expect({ command, exitCode: r.exitCode === 0 ? 0 : "failed" }).toEqual({ command, exitCode: "failed" });
      await expectSkillIntact();
    }
    const ok = await h!.runCommand("echo y > result.txt");
    expect(ok.exitCode).toBe(0);
    expect(ok.artifacts.map((a) => a.relativePath)).toEqual(["result.txt"]);
  });

  (hasPython ? it : it.skip)("a Python script importing a module next to it still runs (no __pycache__ written)", async () => {
    if (!inEffect()) return;
    const r = await h!.runCommand('cd "skills/demo" && python3 run.py');
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("ran 1");
    expect(existsSync(skillFile("__pycache__"))).toBe(false);
  });

  it("a new version still replaces the files, and the reload route still re-downloads", async () => {
    if (!inEffect()) return;
    expect((await bash("echo evil > skills/demo/SKILL.md")).exitCode).not.toBe(0);
    put(2, { "SKILL.md": "# v2" });
    await createSessionSandbox(id, [skill(2)], config, 7, undefined, { projectId: null });
    expect(await readFile(skillFile("SKILL.md"), "utf8")).toBe("# v2");
    expect(existsSync(skillFile("helper.py"))).toBe(false);
    expect((await bash("echo evil > skills/demo/SKILL.md")).exitCode).not.toBe(0);

    put(2, { "SKILL.md": "# v2 reloaded" });
    expect(await refreshSessionSkills(id, [skill(2)], config)).toEqual({ refreshed: 1, sandbox: true });
    expect(await readFile(skillFile("SKILL.md"), "utf8")).toBe("# v2 reloaded");
    expect((await bash("cat skills/demo/SKILL.md")).stdout).toContain("# v2 reloaded");
  });
});
