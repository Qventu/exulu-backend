import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentTypeFor,
  deleteWorkspaceFile,
  listWorkspaceFiles,
  readWorkspaceFile,
  resolveInWorkspace,
  writeWorkspaceFile,
} from "./workspace-store";

const ORIGINAL_ENV = { ...process.env };
let home: string;

const wsDir = (profileId: string) =>
  join(home, "profiles", profileId, "workspace");

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hermes-ws-"));
  process.env.HERMES_HOME = home;
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  await rm(home, { recursive: true, force: true });
});

const streamToString = async (s: NodeJS.ReadableStream): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
};

describe("contentTypeFor", () => {
  it("maps known extensions and falls back to octet-stream", () => {
    expect(contentTypeFor("a.md")).toBe("text/markdown");
    expect(contentTypeFor("a.png")).toBe("image/png");
    expect(contentTypeFor("a.unknownext")).toBe("application/octet-stream");
  });
});

describe("resolveInWorkspace", () => {
  it("rejects path traversal / absolute paths", () => {
    process.env.HERMES_HOME = "/tmp/hh";
    expect(resolveInWorkspace("a", "ok/file.txt")).toContain("workspace");
    expect(resolveInWorkspace("a", "../../etc/passwd")).toBeUndefined();
    expect(resolveInWorkspace("a", "../escape")).toBeUndefined();
  });
});

describe("list/read/write/delete", () => {
  it("lists files (recursive, dotfiles skipped, newest first)", async () => {
    const dir = wsDir("agent-1");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "a.txt"), "a");
    await new Promise((r) => setTimeout(r, 5));
    await writeFile(join(dir, "sub", "b.md"), "bb");
    await writeFile(join(dir, ".hidden"), "x"); // skipped

    const files = await listWorkspaceFiles("agent-1");
    const paths = files.map((f) => f.path);
    expect(paths).toContain("a.txt");
    expect(paths).toContain("sub/b.md");
    expect(paths).not.toContain(".hidden");
    // newest first
    expect(files[0]!.path).toBe("sub/b.md");
    expect(files.find((f) => f.path === "sub/b.md")!.contentType).toBe("text/markdown");
  });

  it("writes, reads, and deletes a file", async () => {
    await writeWorkspaceFile("agent-1", "out/report.txt", Buffer.from("hello"));
    const read = await readWorkspaceFile("agent-1", "out/report.txt");
    expect(read).toBeDefined();
    expect(read!.size).toBe(5);
    expect(await streamToString(read!.stream)).toBe("hello");

    await deleteWorkspaceFile("agent-1", "out/report.txt");
    expect(await readWorkspaceFile("agent-1", "out/report.txt")).toBeUndefined();
  });

  it("refuses to write/read outside the workspace", async () => {
    await expect(
      writeWorkspaceFile("agent-1", "../escape.txt", Buffer.from("x")),
    ).rejects.toBeDefined();
    expect(await readWorkspaceFile("agent-1", "../../etc/passwd")).toBeUndefined();
  });
});
