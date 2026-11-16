import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, lstat, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

jest.mock("@SRC/uppy/index.ts", () => ({
  listS3ObjectsByPrefix: jest.fn(),
  getS3ObjectBytes: jest.fn(),
}));

import { listS3ObjectsByPrefix, getS3ObjectBytes } from "@SRC/uppy/index.ts";
import {
  planProjectSync,
  syncProjectDir,
  projectSyncMarkerPath,
  resolveSandboxProjectId,
  removeTreeSafely,
} from "./project-sync";

const list = listS3ObjectsByPrefix as jest.Mock;
const bytes = getS3ObjectBytes as jest.Mock;
const config = { fileUploads: { s3Bucket: "b", s3prefix: "pre" } } as any;

describe("planProjectSync", () => {
  it("downloads new and size-changed files, removes files gone remotely, leaves identical ones alone", () => {
    const plan = planProjectSync(
      [
        { name: "same.pdf", size: 10 },
        { name: "changed.pdf", size: 20 },
        { name: "new.pdf", size: 5 },
      ],
      [
        { name: "same.pdf", size: 10 },
        { name: "changed.pdf", size: 19 },
        { name: "gone.pdf", size: 7 },
      ],
    );
    expect(plan.download.sort()).toEqual(["changed.pdf", "new.pdf"]);
    expect(plan.remove).toEqual(["gone.pdf"]);
  });

  it("is a no-op when both sides match", () => {
    expect(planProjectSync([{ name: "a", size: 1 }], [{ name: "a", size: 1 }])).toEqual({ download: [], remove: [] });
  });
});

describe("syncProjectDir", () => {
  let root: string;
  let sessionDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "project-sync-"));
    sessionDir = join(root, "sess-1");
    await mkdir(sessionDir, { recursive: true });
    list.mockReset();
    bytes.mockReset();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const remoteObj = (name: string, size: number) => ({
    key: `pre/projects/p1/files/${name}`,
    size,
    lastModified: new Date(),
  });

  it("projectId null removes a project/ dir this sync created earlier", async () => {
    list.mockResolvedValue([remoteObj("a.pdf", 3)]);
    bytes.mockResolvedValue(Buffer.from("abc"));
    await syncProjectDir({ sessionDir, projectId: "p1", config });
    expect(existsSync(join(sessionDir, "project", "a.pdf"))).toBe(true);

    await syncProjectDir({ sessionDir, projectId: null, config });
    expect(existsSync(join(sessionDir, "project"))).toBe(false);
    expect(existsSync(projectSyncMarkerPath(sessionDir))).toBe(false);
  });

  it("projectId null leaves a project/ dir alone that never came from a project (session without project)", async () => {
    await mkdir(join(sessionDir, "project"), { recursive: true });
    await writeFile(join(sessionDir, "project", "x.txt"), "agent file");
    await syncProjectDir({ sessionDir, projectId: null, config });
    expect(await readFile(join(sessionDir, "project", "x.txt"), "utf8")).toBe("agent file");
    expect(list).not.toHaveBeenCalled();
  });

  it("downloads remote files, removes local ones gone remotely, keeps identical ones", async () => {
    const dir = join(sessionDir, "project");
    // An earlier sync of the same project left same.txt (marker + folder).
    list.mockResolvedValue([remoteObj("same.txt", 3)]);
    bytes.mockResolvedValue(Buffer.from("123"));
    await syncProjectDir({ sessionDir, projectId: "p1", config });
    bytes.mockReset();
    await writeFile(join(dir, "gone.txt"), "x");
    await mkdir(join(dir, "agent-subdir"));
    list.mockResolvedValue([remoteObj("same.txt", 3), remoteObj("new.txt", 2)]);
    bytes.mockImplementation(async (key: string) => Buffer.from(key.endsWith("new.txt") ? "hi" : "ZZZ"));

    await syncProjectDir({ sessionDir, projectId: "p1", config });

    expect(list).toHaveBeenCalledWith("projects/p1/files/", config);
    expect((await readdir(dir)).sort()).toEqual(["new.txt", "same.txt"]);
    expect(await readFile(join(dir, "same.txt"), "utf8")).toBe("123"); // not re-downloaded
    expect(await readFile(join(dir, "new.txt"), "utf8")).toBe("hi");
    expect(bytes).toHaveBeenCalledTimes(1);
  });

  it("one failing download does not abort the others", async () => {
    list.mockResolvedValue([remoteObj("bad.txt", 1), remoteObj("good.txt", 2)]);
    bytes.mockImplementation(async (key: string) => {
      if (key.endsWith("bad.txt")) throw new Error("boom");
      return Buffer.from("ok");
    });
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    await syncProjectDir({ sessionDir, projectId: "p1", config });
    err.mockRestore();
    expect(await readFile(join(sessionDir, "project", "good.txt"), "utf8")).toBe("ok");
    expect(existsSync(join(sessionDir, "project", "bad.txt"))).toBe(false);
  });

  it("a failing listing keeps the local copy as it is", async () => {
    await mkdir(join(sessionDir, "project"), { recursive: true });
    await writeFile(join(sessionDir, "project", "a.txt"), "a");
    list.mockRejectedValue(new Error("s3 down"));
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    await syncProjectDir({ sessionDir, projectId: "p1", config });
    err.mockRestore();
    expect(existsSync(join(sessionDir, "project", "a.txt"))).toBe(true);
  });

  it("switching to another project starts from an empty folder", async () => {
    list.mockResolvedValueOnce([remoteObj("a.txt", 1)]);
    bytes.mockResolvedValue(Buffer.from("A"));
    await syncProjectDir({ sessionDir, projectId: "p1", config });

    list.mockResolvedValueOnce([{ key: "pre/projects/p2/files/a.txt", size: 1, lastModified: new Date() }]);
    bytes.mockResolvedValue(Buffer.from("B"));
    await syncProjectDir({ sessionDir, projectId: "p2", config });
    // same name and size, but a different project: must not keep p1's bytes
    expect(await readFile(join(sessionDir, "project", "a.txt"), "utf8")).toBe("B");
  });

  it("ignores remote keys that are not flat file names", async () => {
    list.mockResolvedValue([
      { key: "pre/projects/p1/files/", size: 0, lastModified: new Date() },
      { key: "pre/projects/p1/files/sub/x.txt", size: 1, lastModified: new Date() },
      remoteObj("ok.txt", 1),
    ]);
    bytes.mockResolvedValue(Buffer.from("k"));
    await syncProjectDir({ sessionDir, projectId: "p1", config });
    expect(await readdir(join(sessionDir, "project"))).toEqual(["ok.txt"]);
  });

  it("a project symlink is replaced by a real directory and its target is left untouched", async () => {
    const victim = join(root, "victim");
    await mkdir(join(victim, "sub"), { recursive: true });
    await writeFile(join(victim, "keep.txt"), "victim");
    await writeFile(join(victim, "sub", "deep.txt"), "deep");
    // a first sync writes the marker, so the next one is the "marker matches" case
    list.mockResolvedValue([remoteObj("a.txt", 1)]);
    bytes.mockResolvedValue(Buffer.from("A"));
    await syncProjectDir({ sessionDir, projectId: "p1", config });
    await rm(join(sessionDir, "project"), { recursive: true, force: true });
    await symlink(victim, join(sessionDir, "project"));

    await syncProjectDir({ sessionDir, projectId: "p1", config });

    expect(await readFile(join(victim, "keep.txt"), "utf8")).toBe("victim");
    expect(await readFile(join(victim, "sub", "deep.txt"), "utf8")).toBe("deep");
    expect((await readdir(victim)).sort()).toEqual(["keep.txt", "sub"]);
    const st = await lstat(join(sessionDir, "project"));
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isDirectory()).toBe(true);
    expect(await readFile(join(sessionDir, "project", "a.txt"), "utf8")).toBe("A");
  });

  it("a regular file named project is replaced by the directory", async () => {
    await writeFile(join(sessionDir, "project"), "not a dir");
    list.mockResolvedValue([remoteObj("a.txt", 1)]);
    bytes.mockResolvedValue(Buffer.from("A"));
    await syncProjectDir({ sessionDir, projectId: "p1", config });
    expect((await lstat(join(sessionDir, "project"))).isDirectory()).toBe(true);
    expect(await readFile(join(sessionDir, "project", "a.txt"), "utf8")).toBe("A");
  });

  it("a symlink planted at a download name after the scan is not written through", async () => {
    const victim = join(root, "victim.txt");
    await writeFile(victim, "victim");
    list.mockResolvedValue([remoteObj("a.txt", 1)]);
    // Plant the link while the bytes are being fetched, i.e. after readdir/plan.
    bytes.mockImplementation(async () => {
      await mkdir(join(sessionDir, "project"), { recursive: true });
      await symlink(victim, join(sessionDir, "project", "a.txt"));
      return Buffer.from("A");
    });
    await syncProjectDir({ sessionDir, projectId: "p1", config });
    expect(await readFile(victim, "utf8")).toBe("victim");
    expect((await lstat(join(sessionDir, "project", "a.txt"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(sessionDir, "project", "a.txt"), "utf8")).toBe("A");
    expect((await readdir(join(sessionDir, "project"))).sort()).toEqual(["a.txt"]);
  });

  const snapshotTree = async (d: string): Promise<string[]> => {
    const out: string[] = [];
    const walk = async (x: string, rel: string) => {
      for (const e of await readdir(x, { withFileTypes: true })) {
        const r = `${rel}${e.name}`;
        if (e.isDirectory()) { out.push(`${r}/`); await walk(join(x, e.name), `${r}/`); }
        else out.push(`${r}=${await readFile(join(x, e.name), "utf8")}`);
      }
    };
    await walk(d, "");
    return out.sort();
  };
  const makeVictim = async () => {
    const victim = join(root, "victim");
    await mkdir(join(victim, "sub"), { recursive: true });
    await writeFile(join(victim, "keep.txt"), "victim");
    await writeFile(join(victim, "sub", "deep.txt"), "deep");
    await writeFile(join(victim, "gone.txt"), "would be removed by plan");
    return victim;
  };

  it("a project link swapped in while the sync runs is never followed", async () => {
    const victim = await makeVictim();
    const before = await snapshotTree(victim);
    // first sync: marker matches and a local copy exists, like a real later turn
    list.mockResolvedValue([remoteObj("a.txt", 1)]);
    bytes.mockResolvedValue(Buffer.from("A"));
    await syncProjectDir({ sessionDir, projectId: "p1", config });
    await writeFile(join(sessionDir, "project", "gone.txt"), "x");

    list.mockResolvedValue([remoteObj("a.txt", 2), remoteObj("b.txt", 1)]);
    bytes.mockImplementation(async (key: string) => {
      // the agent's loop wins the race during the S3 await
      await rm(join(sessionDir, "project"), { recursive: true, force: true });
      await symlink(victim, join(sessionDir, "project"));
      return Buffer.from(key.endsWith("a.txt") ? "AA" : "B");
    });
    await syncProjectDir({ sessionDir, projectId: "p1", config });

    expect(await snapshotTree(victim)).toEqual(before);
    const st = await lstat(join(sessionDir, "project")).catch(() => null);
    if (st) {
      expect(st.isSymbolicLink()).toBe(false);
      expect(st.isDirectory()).toBe(true);
      expect(await snapshotTree(join(sessionDir, "project"))).toEqual(["a.txt=AA", "b.txt=B"]);
    }
  });

  it("detach while project/sub is a link to a victim leaves the victim untouched", async () => {
    const victim = await makeVictim();
    const before = await snapshotTree(victim);
    list.mockResolvedValue([remoteObj("a.txt", 1)]);
    bytes.mockResolvedValue(Buffer.from("A"));
    await syncProjectDir({ sessionDir, projectId: "p1", config });
    await symlink(victim, join(sessionDir, "project", "sub"));

    await syncProjectDir({ sessionDir, projectId: null, config });
    expect(existsSync(join(sessionDir, "project"))).toBe(false);
    expect(await snapshotTree(victim)).toEqual(before);
  });

  it("unchanged files are reused without a download", async () => {
    list.mockResolvedValue([remoteObj("a.txt", 1), remoteObj("b.txt", 2)]);
    bytes.mockImplementation(async (key: string) => Buffer.from(key.endsWith("a.txt") ? "A" : "BB"));
    await syncProjectDir({ sessionDir, projectId: "p1", config });
    bytes.mockClear();
    await syncProjectDir({ sessionDir, projectId: "p1", config });
    expect(bytes).not.toHaveBeenCalled();
    expect(await snapshotTree(join(sessionDir, "project"))).toEqual(["a.txt=A", "b.txt=BB"]);
  });

  it("leaves no staging or trash directories behind", async () => {
    list.mockResolvedValue([remoteObj("a.txt", 1)]);
    bytes.mockResolvedValue(Buffer.from("A"));
    await syncProjectDir({ sessionDir, projectId: "p1", config });
    await syncProjectDir({ sessionDir, projectId: "p1", config });
    await syncProjectDir({ sessionDir, projectId: null, config });
    for (const d of [".project-staging", ".project-trash"]) {
      const p = join(root, d);
      if (existsSync(p)) expect(await readdir(p)).toEqual([]);
    }
  });

  it("removeTreeSafely refuses anything outside the two helper roots", async () => {
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    await writeFile(join(sessionDir, "keep.txt"), "k");
    for (const p of [
      sessionDir,
      join(sessionDir, "keep.txt"),
      join(root, ".project-trash"),
      join(root, ".project-trash", "..", "sess-1"),
      join(root, ".project-trashX", "a"),
      "/",
    ]) {
      expect(await removeTreeSafely(p, sessionDir)).toBe(false);
    }
    err.mockRestore();
    expect(await readFile(join(sessionDir, "keep.txt"), "utf8")).toBe("k");
  });

  it("removeTreeSafely deletes a trash dir holding a link without touching the link's target", async () => {
    const victim = await makeVictim();
    const before = await snapshotTree(victim);
    const trash = join(root, ".project-trash", "sess-1-abc");
    await mkdir(join(trash, "nested"), { recursive: true });
    await writeFile(join(trash, "f.txt"), "f");
    await symlink(victim, join(trash, "link"));
    await symlink(victim, join(trash, "nested", "link2"));
    expect(await removeTreeSafely(trash, sessionDir)).toBe(true);
    expect(existsSync(trash)).toBe(false);
    expect(await snapshotTree(victim)).toEqual(before);
  });

  it("sweeps this session's trash older than a day on the next sync", async () => {
    const old = join(root, ".project-trash", "sess-1-old");
    const fresh = join(root, ".project-trash", "sess-1-fresh");
    const other = join(root, ".project-trash", "sess-2-old");
    for (const d of [old, fresh, other]) await mkdir(d, { recursive: true });
    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000);
    await utimes(old, twoDaysAgo, twoDaysAgo);
    await utimes(other, twoDaysAgo, twoDaysAgo);
    list.mockResolvedValue([]);
    await syncProjectDir({ sessionDir, projectId: "p1", config });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it("keeps the marker outside the session directory, so the sandbox cannot write it", () => {
    const marker = projectSyncMarkerPath(sessionDir);
    expect(marker.startsWith(sessionDir + "/")).toBe(false);
    expect(marker.startsWith(sessionDir)).toBe(false);
  });
});

describe("resolveSandboxProjectId", () => {
  const project = { id: "p1", created_by: 1, rights_mode: "private" };
  const deps = (over: Partial<Parameters<typeof resolveSandboxProjectId>[1]> = {}) => ({
    getProject: jest.fn(async () => project),
    getRbac: jest.fn(async () => ({ type: "private", users: [], roles: [] })),
    getUser: jest.fn(async (id: number | string) => ({ id: Number(id), role: null })),
    ...over,
  });

  it("returns null without a project", async () => {
    const d = deps();
    expect(await resolveSandboxProjectId({ projectId: undefined, ownerId: 1 }, d)).toBeNull();
    expect(d.getProject).not.toHaveBeenCalled();
  });

  it("returns the id when the owner can read the project", async () => {
    expect(await resolveSandboxProjectId({ projectId: "p1", ownerId: 1 }, deps())).toBe("p1");
  });

  it("returns null when the owner has no read access", async () => {
    expect(await resolveSandboxProjectId({ projectId: "p1", ownerId: 2 }, deps())).toBeNull();
  });

  it("returns null when the project no longer exists", async () => {
    expect(
      await resolveSandboxProjectId({ projectId: "p1", ownerId: 1 }, deps({ getProject: jest.fn(async () => undefined) })),
    ).toBeNull();
  });

  it("returns null when the owner cannot be loaded", async () => {
    expect(
      await resolveSandboxProjectId({ projectId: "p1", ownerId: 1 }, deps({ getUser: jest.fn(async () => undefined) })),
    ).toBeNull();
  });

  it("matches a role grant when the owner's role is a hydrated role object", async () => {
    const d = deps({
      getRbac: jest.fn(async () => ({ type: "roles", users: [], roles: [{ id: "r1", rights: "read" }] })),
    });
    const owner = { id: 2, role: { id: "r1", name: "Team" } };
    expect(await resolveSandboxProjectId({ projectId: "p1", ownerId: 2, owner }, d)).toBe("p1");
    expect(d.getUser).not.toHaveBeenCalled();
  });

  it("logs and returns null when resolving throws", async () => {
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({ getRbac: jest.fn(async () => { throw new Error("db"); }) });
    expect(await resolveSandboxProjectId({ projectId: "p1", ownerId: 1 }, d)).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
