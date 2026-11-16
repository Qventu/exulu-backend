import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("readRegularFileInside: special files", () => {
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
});
