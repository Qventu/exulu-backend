import { memoryBaseContributors } from "./memory-base-contributors";

type Answers = { createdBy?: any[]; users?: any[]; hasTable?: boolean; throwOnQuery?: boolean };

function fakeDb(a: Answers) {
  const calls: { table: string; ids?: unknown[] }[] = [];
  const db: any = jest.fn((table: string) => {
    calls.push({ table });
    if (table === "users") {
      return {
        whereIn: (_col: string, ids: unknown[]) => {
          calls[calls.length - 1].ids = ids;
          return { select: async () => a.users ?? [] };
        },
      };
    }
    const q: any = {
      whereNot: () => q,
      distinct: () => q,
      select: async () => {
        if (a.throwOnQuery) throw new Error("boom");
        return a.createdBy ?? [];
      },
    };
    return q;
  });
  db.schema = { hasTable: async () => a.hasTable ?? true };
  db.__calls = calls;
  return db;
}

const context = { id: "mem", name: "Memory", fields: [] } as any;

describe("memoryBaseContributors", () => {
  it("resolves the distinct creator ids to display names ordered by name", async () => {
    const db = fakeDb({
      createdBy: [{ created_by: 9 }, { created_by: 4 }, { created_by: 9 }],
      users: [{ id: 9, firstname: "Sara", lastname: "Kraus" }, { id: 4, firstname: "Anton", lastname: "Bauer" }],
    });
    expect(await memoryBaseContributors({ context, db })).toEqual([
      { id: 4, name: "Anton Bauer" },
      { id: 9, name: "Sara Kraus" },
    ]);
    // distinct ids only, asked once
    expect(db.__calls.filter((c: any) => c.table === "users")).toEqual([{ table: "users", ids: [9, 4] }]);
  });

  it("ignores null created_by and never queries users when nothing is left", async () => {
    const db = fakeDb({ createdBy: [{ created_by: null }, { created_by: undefined }], users: [{ id: 1, firstname: "No" }] });
    expect(await memoryBaseContributors({ context, db })).toEqual([]);
    expect(db.__calls.some((c: any) => c.table === "users")).toBe(false);
  });

  it("returns [] for a missing items table or a failing query", async () => {
    expect(await memoryBaseContributors({ context, db: fakeDb({ createdBy: [{ created_by: 1 }], hasTable: false }) })).toEqual([]);
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await memoryBaseContributors({ context, db: fakeDb({ throwOnQuery: true }) })).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("falls back to the email and then the id when there is no name", async () => {
    const db = fakeDb({
      createdBy: [{ created_by: 3 }, { created_by: 7 }],
      users: [{ id: 3, firstname: null, lastname: "  ", email: "zoe@example.com" }, { id: 7, firstname: "", lastname: null, email: null }],
    });
    expect(await memoryBaseContributors({ context, db })).toEqual([
      { id: 7, name: "User 7" },
      { id: 3, name: "zoe@example.com" },
    ]);
  });

  it("accepts numeric-string ids (text column) and de-duplicates them with numbers", async () => {
    const db = fakeDb({ createdBy: [{ created_by: "9" }, { created_by: "4" }, { created_by: 9 }, { created_by: "x" }], users: [{ id: 9, firstname: "Sara", lastname: "Kraus" }, { id: 4, firstname: "Anton", lastname: "Bauer" }] });
    expect(await memoryBaseContributors({ context, db })).toEqual([{ id: 4, name: "Anton Bauer" }, { id: 9, name: "Sara Kraus" }]);
    expect(db.__calls.filter((c: any) => c.table === "users")).toEqual([{ table: "users", ids: [9, 4] }]);
  });
});
