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
  expect(own.promoted).toEqual([{ key: "projects/p1/files/a.pdf", name: "a.pdf" }]);
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
