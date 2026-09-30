jest.mock("@SRC/graphql/utilities/access-control", () => ({ applyAccessControl: jest.fn((_t: unknown, q: unknown) => q) }));

import { memoryBaseStats } from "./memory-base-stats";

function fakeDb(answers: {
  total: number; pub: number; priv: number; contributors: number; last?: any; user?: any;
  hasTable?: boolean; throwOnCount?: boolean;
}) {
  let mode: "count" | "public" | "private" | "distinct" | "last" = "count";
  const q: any = {
    whereNot: () => q,
    where: (col: string, val: string) => { if (col === "rights_mode") mode = val as any; return q; },
    count: async () => {
      if (answers.throwOnCount) throw new Error("boom");
      return [{ c: mode === "public" ? answers.pub : mode === "private" ? answers.priv : answers.total }];
    },
    countDistinct: async () => [{ c: answers.contributors }],
    orderBy: () => q,
    select: () => q,
    first: async () => answers.last,
    whereIn: () => ({ select: async () => (answers.user ? [answers.user] : []) }),
  };
  return Object.assign(jest.fn(() => { mode = "count"; return q; }), {
    schema: { hasTable: jest.fn(async () => answers.hasTable ?? true) },
  });
}

describe("memoryBaseStats", () => {
  const context = { id: "mem", name: "Memory", fields: [] } as any;

  it("aggregates counts, contributors and the last save with the creator name", async () => {
    const db = fakeDb({ total: 47, pub: 31, priv: 16, contributors: 9, last: { createdAt: new Date("2026-09-29T10:00:00Z"), created_by: 9 }, user: { id: 9, firstname: "Sara", lastname: "Kraus" } });
    const r = await memoryBaseStats({ context, user: { id: 4 } as any, db });
    expect(r).toEqual({ total: 47, public: 31, private: 16, contributors: 9, lastSavedAt: "2026-09-29T10:00:00.000Z", lastSavedBy: { id: 9, name: "Sara Kraus" } });
  });

  it("returns zeros and nulls for an empty base", async () => {
    const db = fakeDb({ total: 0, pub: 0, priv: 0, contributors: 0 });
    expect(await memoryBaseStats({ context, user: undefined, db })).toEqual({ total: 0, public: 0, private: 0, contributors: 0, lastSavedAt: null, lastSavedBy: null });
  });

  it("returns zeros without querying when the items table does not exist", async () => {
    const db = fakeDb({ total: 47, pub: 31, priv: 16, contributors: 9, hasTable: false });
    const r = await memoryBaseStats({ context, user: undefined, db });
    expect(r).toEqual({ total: 0, public: 0, private: 0, contributors: 0, lastSavedAt: null, lastSavedBy: null });
    expect(db).not.toHaveBeenCalled();
  });

  it("returns zeros when a query throws", async () => {
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const db = fakeDb({ total: 47, pub: 31, priv: 16, contributors: 9, throwOnCount: true });
    const r = await memoryBaseStats({ context, user: { id: 4 } as any, db });
    expect(r).toEqual({ total: 0, public: 0, private: 0, contributors: 0, lastSavedAt: null, lastSavedBy: null });
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it("leaves lastSavedBy null when created_by is null or the user row is gone", async () => {
    const nullCreator = fakeDb({
      total: 1, pub: 1, priv: 0, contributors: 1,
      last: { createdAt: new Date("2026-09-01T00:00:00Z"), created_by: null },
    });
    expect(await memoryBaseStats({ context, user: undefined, db: nullCreator })).toEqual({
      total: 1, public: 1, private: 0, contributors: 1, lastSavedAt: "2026-09-01T00:00:00.000Z", lastSavedBy: null,
    });

    const missingUserRow = fakeDb({
      total: 1, pub: 1, priv: 0, contributors: 1,
      last: { createdAt: new Date("2026-09-01T00:00:00Z"), created_by: 9 },
      // no `user` entry: the users lookup resolves empty, so the row is "gone".
    });
    expect(await memoryBaseStats({ context, user: undefined, db: missingUserRow })).toEqual({
      total: 1, public: 1, private: 0, contributors: 1, lastSavedAt: "2026-09-01T00:00:00.000Z", lastSavedBy: null,
    });
  });
});
