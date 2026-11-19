import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ADOPT_UPLOAD_BYTES } from "@SRC/exulu/session-file-adopt";
import { readRegularFileInside } from "./safe-fs";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "exulu-safefs-"));
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  jest.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const canMkfifo = (() => {
  try {
    execFileSync("mkfifo", [join(tmpdir(), `exulu-fifo-probe-${process.pid}`)]);
    execFileSync("rm", ["-f", join(tmpdir(), `exulu-fifo-probe-${process.pid}`)]);
    return true;
  } catch {
    return false;
  }
})();

describe("readRegularFileInside: special files and size", () => {
  (canMkfifo ? it : it.skip)(
    "a FIFO at the path returns null at once instead of blocking a threadpool thread",
    async () => {
      const fifo = join(dir, "f");
      execFileSync("mkfifo", [fifo]);
      const result = await Promise.race([
        readRegularFileInside(dir, fifo),
        new Promise((r) => setTimeout(() => r("still blocked"), 1500)),
      ]);
      // Release a reader that a regression left blocked, so the suite can still exit.
      try {
        closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
      } catch {
        // no reader waiting: nothing to release
      }
      expect(result).toBeNull();
    },
    5000,
  );

  it("skips a (sparse) file just over the upload cap and reads one just under it", async () => {
    const over = join(dir, "over.bin");
    const under = join(dir, "under.bin");
    await writeFile(over, "");
    await writeFile(under, "");
    await truncate(over, MAX_ADOPT_UPLOAD_BYTES + 1);
    await truncate(under, MAX_ADOPT_UPLOAD_BYTES - 1);
    expect(await readRegularFileInside(dir, over)).toBeNull();
    expect((await readRegularFileInside(dir, under))?.length).toBe(MAX_ADOPT_UPLOAD_BYTES - 1);
  }, 20000);
});

describe("readRegularFileInside: small and empty files", () => {
  it("reads a small file exactly and an empty file as an empty buffer", async () => {
    await writeFile(join(dir, "small.txt"), "hello");
    await writeFile(join(dir, "empty.txt"), "");
    expect(String(await readRegularFileInside(dir, join(dir, "small.txt")))).toBe("hello");
    expect((await readRegularFileInside(dir, join(dir, "empty.txt")))?.length).toBe(0);
  });
});

describe("landsInside", () => {
  // Imported here so a missing export fails only this block.
  const { landsInside } = jest.requireActual("./safe-fs") as typeof import("./safe-fs");
  let skills: string;
  beforeEach(async () => {
    skills = join(dir, "skills");
    await mkdir(join(skills, "demo"), { recursive: true });
  });

  it.each([
    "skills",
    "skills/demo/run.py",
    "skills/new/deep/file.txt",
  ])("%p lands in skills/", async (rel) => {
    expect(await landsInside(dir, join(dir, rel), "skills")).toBe(true);
  });

  it.each(["out.txt", "skillsx/a.txt", "a/skills/b.txt", "."])("%p does not land in skills/", async (rel) => {
    expect(await landsInside(dir, join(dir, rel), "skills")).toBe(false);
  });

  it("follows a link in the session dir that points into skills/, also a dangling one", async () => {
    await symlink(join(skills, "demo"), join(dir, "ldir"));
    await symlink(join(skills, "demo", "missing.py"), join(dir, "dangling.py"));
    await symlink("skills/demo/run.py", join(dir, "relative.py"));
    expect(await landsInside(dir, join(dir, "ldir", "x.py"), "skills")).toBe(true);
    expect(await landsInside(dir, join(dir, "ldir"), "skills")).toBe(true);
    expect(await landsInside(dir, join(dir, "dangling.py"), "skills")).toBe(true);
    expect(await landsInside(dir, join(dir, "relative.py"), "skills")).toBe(true);
  });

  it("a link out of skills/ is judged by its target", async () => {
    await mkdir(join(dir, "elsewhere"));
    await symlink(join(dir, "elsewhere"), join(dir, "out"));
    expect(await landsInside(dir, join(dir, "out", "a.txt"), "skills")).toBe(false);
  });

  it("works when the session dir is reached through a link and when skills/ does not exist", async () => {
    const alias = join(dir, "..", `alias-${process.pid}-${Math.random().toString(36).slice(2)}`);
    await symlink(dir, alias);
    try {
      expect(await landsInside(alias, join(alias, "skills", "demo", "a"), "skills")).toBe(true);
      expect(await landsInside(dir, join(alias, "skills", "demo", "a"), "skills")).toBe(true);
      await rm(skills, { recursive: true, force: true });
      expect(await landsInside(dir, join(dir, "skills", "a"), "skills")).toBe(true);
      expect(await landsInside(dir, join(dir, "b"), "skills")).toBe(false);
    } finally {
      await rm(alias, { force: true });
    }
  });

  it("a link cycle is treated as landing inside (refuse rather than guess)", async () => {
    await symlink(join(dir, "loop2"), join(dir, "loop1"));
    await symlink(join(dir, "loop1"), join(dir, "loop2"));
    expect(await landsInside(dir, join(dir, "loop1", "x"), "skills")).toBe(true);
  });
});
