import { promoteSessionFiles, type PromoteS3 } from "./project-files-promote";

const SESSION = "user_7/sessions/s1/";
const fakeS3 = (over: Partial<PromoteS3> = {}, sizes: Record<string, number | null> = {}) => {
  const copies: [string, string][] = [];
  const s3: PromoteS3 = {
    listProjectNames: async () => [],
    sizeOf: async (k) => (k in sizes ? sizes[k]! : 10),
    copy: async (a, b) => void copies.push([a, b]),
    ...over,
  };
  return { s3, copies };
};
const base = { projectId: "p1", fullSessionPrefix: SESSION, overwrite: false };

it("rejects the whole batch when the sum exceeds the 50 MB total cap, though each file fits", async () => {
  const MB = 1024 * 1024;
  const keys = [`${SESSION}a.bin`, `${SESSION}b.bin`];
  const { s3, copies } = fakeS3({}, { [keys[0]!]: 30 * MB, [keys[1]!]: 30 * MB });
  const r = await promoteSessionFiles({ ...base, keys, s3 });
  expect(r.promoted).toEqual([]);
  expect(r.rejected).toHaveLength(2);
  expect(r.rejected[0]!.reason).toContain("50MB total");
  expect(copies).toEqual([]);
});

it("uses the prefix it is given: the session owner's, not the caller's", async () => {
  const { s3, copies } = fakeS3();
  // Caller is user 2, the session belongs to user 7: the route passes the OWNER's prefix.
  const own = await promoteSessionFiles({ ...base, keys: [`${SESSION}a.pdf`], s3 });
  expect(own.promoted).toEqual([{ key: "projects/p1/files/a.pdf", name: "a.pdf", sourceKey: `${SESSION}a.pdf` }]);
  const callers = await promoteSessionFiles({ ...base, keys: ["user_2/sessions/s1/a.pdf"], s3 });
  expect(callers.promoted).toEqual([]);
  expect(callers.rejected[0]!.reason).toContain("not a file of this session");
  expect(copies).toHaveLength(1);
});

it("a copy failing midway keeps the earlier files in promoted and reports the failed one", async () => {
  const keys = [`${SESSION}a.pdf`, `${SESSION}b.pdf`, `${SESSION}c.pdf`];
  const { s3 } = fakeS3({
    copy: jest.fn(async (src: string) => {
      if (src.endsWith("b.pdf")) throw new Error("S3 down");
    }),
  });
  const r = await promoteSessionFiles({ ...base, keys, s3 });
  expect(r.promoted.map((p) => p.name)).toEqual(["a.pdf", "c.pdf"]);
  expect(r.rejected).toEqual([{ key: keys[1], reason: "Copying the file into the project failed." }]);
});

describe("moveSessionFiles", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { moveSessionFiles } = require("./project-files-promote") as typeof import("./project-files-promote");
  const mk = (over: Record<string, unknown> = {}) => {
    const removed: string[] = [];
    const copies: [string, string][] = [];
    const s3 = {
      listProjectNames: async () => [],
      sizeOf: async () => 10,
      copy: async (a: string, b: string) => void copies.push([a, b]),
      remove: async (k: string) => void removed.push(k),
      ...over,
    };
    return { s3: s3 as never, removed, copies };
  };
  const batch = [`${SESSION}a.pdf`, `${SESSION}b.pdf`].map((key) => ({ key, name: key.slice(SESSION.length) }));

  it("deletes each original only after its copy succeeded", async () => {
    const order: string[] = [];
    const { s3 } = mk({
      copy: async (a: string) => void order.push(`copy ${a.slice(SESSION.length)}`),
      remove: async (k: string) => void order.push(`remove ${k.slice(SESSION.length)}`),
    });
    const r = await moveSessionFiles({ projectId: "p1", fullSessionPrefix: SESSION, batches: [batch], s3 });
    expect(r).toEqual({ moved: ["a.pdf", "b.pdf"], notMoved: [], originalsKept: [], keptForHistory: [] });
    expect(order.indexOf("remove a.pdf")).toBeGreaterThan(order.indexOf("copy a.pdf"));
    expect(order.indexOf("remove b.pdf")).toBeGreaterThan(order.indexOf("copy b.pdf"));
  });
  it("a failing copy leaves that file in the session, names it, and deletes nothing for it", async () => {
    const { s3, removed } = mk({
      copy: async (a: string) => {
        if (a.endsWith("b.pdf")) throw new Error("boom");
      },
    });
    const r = await moveSessionFiles({ projectId: "p1", fullSessionPrefix: SESSION, batches: [batch], s3 });
    expect(r.moved).toEqual(["a.pdf"]);
    expect(r.notMoved).toEqual([{ name: "b.pdf", reason: expect.any(String) }]);
    expect(removed).toEqual([`${SESSION}a.pdf`]);
  });
  it("a failing delete keeps the copy and reports the duplicate", async () => {
    const { s3 } = mk({ remove: async () => { throw new Error("denied"); } });
    const r = await moveSessionFiles({ projectId: "p1", fullSessionPrefix: SESSION, batches: [batch], s3 });
    expect(r.originalsKept).toEqual(["a.pdf", "b.pdf"]);
    expect(r.moved).toEqual([]);
  });
  it("a batch that fails as a whole leaves all its files in the session and later batches still run", async () => {
    let n = 0;
    const { s3, removed } = mk({
      listProjectNames: async () => {
        if (n++ === 0) throw new Error("s3 down");
        return [];
      },
    });
    const second = [{ key: `${SESSION}c.pdf`, name: "c.pdf" }];
    const r = await moveSessionFiles({ projectId: "p1", fullSessionPrefix: SESSION, batches: [batch, second], s3 });
    expect(r.notMoved.map((x) => x.name)).toEqual(["a.pdf", "b.pdf"]);
    expect(r.moved).toEqual(["c.pdf"]);
    expect(removed).toEqual([`${SESSION}c.pdf`]);
  });

  it("decides by source key: a name that sanitisation changes is still copied, deleted and reported once", async () => {
    const { s3, copies, removed } = mk();
    const odd = [{ key: `${SESSION}a.pdf `, name: "a.pdf " }, { key: `${SESSION}b.pdf`, name: "b.pdf" }];
    const r = await moveSessionFiles({ projectId: "p1", fullSessionPrefix: SESSION, batches: [odd], s3 });
    expect(copies.map((c) => c[1])).toEqual(["projects/p1/files/a.pdf", "projects/p1/files/b.pdf"]);
    expect(removed).toEqual([`${SESSION}a.pdf `, `${SESSION}b.pdf`]);
    expect(r.moved).toEqual(["a.pdf ", "b.pdf"]);
    expect(r.notMoved).toEqual([]);
  });
  it("every input file lands in exactly one bucket", async () => {
    const { s3 } = mk({
      copy: async (a: string) => { if (a.endsWith("b.pdf")) throw new Error("x"); },
      remove: async (k: string) => { if (k.endsWith("c.pdf")) throw new Error("y"); },
    });
    const files = ["a.pdf", "b.pdf", "c.pdf", "d.pdf"].map((n) => ({ key: `${SESSION}${n}`, name: n }));
    const r = await moveSessionFiles({ projectId: "p1", fullSessionPrefix: SESSION, batches: [files], s3, keepOriginalKeys: new Set([`${SESSION}d.pdf`]) });
    const all = [...r.moved, ...r.notMoved.map((x) => x.name), ...r.originalsKept, ...r.keptForHistory].sort();
    expect(all).toEqual(["a.pdf", "b.pdf", "c.pdf", "d.pdf"]);
    expect(r.keptForHistory).toEqual(["d.pdf"]);
  });
});
