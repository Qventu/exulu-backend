import {
  addProjectFileCore,
  createProjectCore,
  FILE_EXISTS,
  OWNER_NOT_FOUND,
  PROJECT_NOT_FOUND,
} from "./projects-public";
import { SKIP_PROJECT_FULL, SKIP_TOO_LARGE } from "./project-create";
import { SAVE_FAILED, SAVE_INVALID_NAME } from "./session-file-write";

jest.mock("@SRC/postgres/client", () => ({ postgresClient: jest.fn() }));
jest.mock("@SRC/uppy", () => ({ uploadFile: jest.fn() }));

const fakeDb = (opts: { users?: { id: number }[]; projects?: { id: string }[] } = {}) => {
  const inserted: Record<string, unknown>[] = [];
  const rowsOf = (t: string) => (t === "users" ? opts.users ?? [] : opts.projects ?? []);
  const db: any = (table: string) => ({
    insert: (row: Record<string, unknown>) => {
      inserted.push(row);
      return { returning: async () => [{ id: row.id, name: row.name }] };
    },
  });
  db.from = (table: string) => ({
    where: (w: Record<string, unknown>) => ({
      first: async () => rowsOf(table).find((r: any) => r.id === w.id),
    }),
  });
  return Object.assign(db, { inserted });
};

describe("createProjectCore", () => {
  it("inserts a private project owned by ownerId", async () => {
    const db = fakeDb({ users: [{ id: 7 }] });
    const res = await createProjectCore(db, { name: "Pitch", ownerId: 7 });
    expect(Object.keys(res)).toEqual(["id"]);
    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0]).toMatchObject({ name: "Pitch", created_by: 7, rights_mode: "private", id: res.id });
  });
  it("throws OWNER_NOT_FOUND for an unknown owner and inserts nothing", async () => {
    const db = fakeDb({ users: [] });
    await expect(createProjectCore(db, { name: "Pitch", ownerId: 9 })).rejects.toThrow(OWNER_NOT_FOUND);
    expect(db.inserted).toHaveLength(0);
  });
  it("throws on a blank name", async () => {
    const db = fakeDb({ users: [{ id: 7 }] });
    await expect(createProjectCore(db, { name: "  ", ownerId: 7 })).rejects.toThrow(/Project name/);
    expect(db.inserted).toHaveLength(0);
  });
});

describe("addProjectFileCore", () => {
  const run = (over: Record<string, unknown> = {}) => {
    const put = jest.fn(async () => undefined);
    const args: any = {
      db: fakeDb({ projects: [{ id: "p1" }] }),
      projectId: "p1",
      name: "a.pdf",
      data: Buffer.from("x"),
      listProjectNames: async () => [],
      put,
      ...over,
    };
    return { put, result: addProjectFileCore(args) };
  };

  it("puts projects/<id>/files/<name> and returns { name }", async () => {
    const { put, result } = run();
    expect(await result).toEqual({ name: "a.pdf" });
    expect(put).toHaveBeenCalledWith("projects/p1/files/a.pdf", expect.anything(), "application/pdf");
  });
  it("sanitises the name", async () => {
    const { put, result } = run({ name: "a/b.pdf" });
    expect(await result).toEqual({ name: "a_b.pdf" });
    expect(put.mock.calls[0][0]).toBe("projects/p1/files/a_b.pdf");
  });
  it("returns PROJECT_NOT_FOUND for an unknown project", async () => {
    const { put, result } = run({ projectId: "nope" });
    expect(await result).toEqual({ error: PROJECT_NOT_FOUND });
    expect(put).not.toHaveBeenCalled();
  });
  it("returns SAVE_INVALID_NAME for ../x", async () => {
    const { put, result } = run({ name: "../x" });
    expect(await result).toEqual({ error: SAVE_INVALID_NAME });
    expect(put).not.toHaveBeenCalled();
  });
  it("returns SKIP_TOO_LARGE above 50 MB", async () => {
    const { put, result } = run({ data: { length: 50 * 1024 * 1024 + 1 } });
    expect(await result).toEqual({ error: SKIP_TOO_LARGE });
    expect(put).not.toHaveBeenCalled();
  });
  it("returns an error for empty data", async () => {
    const { put, result } = run({ data: Buffer.alloc(0) });
    expect(await result).toEqual({ error: "The file is empty." });
    expect(put).not.toHaveBeenCalled();
  });
  it("existing name, default: FILE_EXISTS", async () => {
    const { put, result } = run({ listProjectNames: async () => ["a.pdf"] });
    expect(await result).toEqual({ error: FILE_EXISTS });
    expect(put).not.toHaveBeenCalled();
  });
  it("existing name, skip: skipped", async () => {
    const { put, result } = run({ listProjectNames: async () => ["a.pdf"], ifExists: "skip" });
    expect(await result).toEqual({ name: "a.pdf", skipped: true });
    expect(put).not.toHaveBeenCalled();
  });
  const full = Array.from({ length: 200 }, (_, i) => `f${i}.txt`);
  it("existing name, skip, project at 200 files: still skipped", async () => {
    const { put, result } = run({ listProjectNames: async () => [...full, "a.pdf"].slice(-200), ifExists: "skip" });
    expect(await result).toEqual({ name: "a.pdf", skipped: true });
    expect(put).not.toHaveBeenCalled();
  });
  it("new name, project at 200 files: SKIP_PROJECT_FULL", async () => {
    const { put, result } = run({ listProjectNames: async () => full });
    expect(await result).toEqual({ error: SKIP_PROJECT_FULL });
    expect(put).not.toHaveBeenCalled();
  });
  it("a failed put returns SAVE_FAILED", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const { result } = run({ put: async () => { throw new Error("s3 down"); } });
    expect(await result).toEqual({ error: SAVE_FAILED });
  });
});
