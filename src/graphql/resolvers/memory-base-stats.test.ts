jest.mock("@SRC/graphql/utilities/access-control", () => ({
  applyAccessControl: jest.fn((_t: unknown, q: any) => { q.__scoped = true; return q; }),
}));

import { memoryBaseStats } from "./memory-base-stats";

type Answers = { total: number; pub: number; priv: number; contributors: number; visible: number; last?: any; user?: any; hasTable?: boolean; throwOnCount?: boolean };

function fakeDb(a: Answers) {
  const make = () => {
    let mode: "count" | "public" | "private" = "count";
    const q: any = {
      __scoped: false,
      whereNot: () => q,
      where: (col: string, val: string) => { if (col === "rights_mode") mode = val as any; return q; },
      count: async () => {
        if (a.throwOnCount) throw new Error("boom");
        if (q.__scoped) return [{ c: a.visible }];
        return [{ c: mode === "public" ? a.pub : mode === "private" ? a.priv : a.total }];
      },
      countDistinct: async () => [{ c: a.contributors }],
      orderBy: () => q, select: () => q,
      first: async () => a.last,
      whereIn: () => ({ select: async () => (a.user ? [a.user] : []) }),
    };
    return q;
  };
  const db: any = jest.fn(() => make());
  db.schema = { hasTable: async () => a.hasTable ?? true };
  return db;
}

const context = { id: "mem", name: "Memory", fields: [] } as any;

describe("memoryBaseStats", () => {
  it("counts all rows for totals and the viewer's rows for visible", async () => {
    const db = fakeDb({ total: 47, pub: 31, priv: 16, contributors: 9, visible: 33, last: { createdAt: new Date("2026-09-29T10:00:00Z"), created_by: 9 }, user: { id: 9, firstname: "Sara", lastname: "Kraus" } });
    expect(await memoryBaseStats({ context, user: { id: 4 } as any, db })).toEqual({
      total: 47, public: 31, private: 16, contributors: 9, visible: 33,
      lastSavedAt: "2026-09-29T10:00:00.000Z", lastSavedBy: { id: 9, name: "Sara Kraus" },
    });
  });
  it("returns zeros for an empty base, a missing table, or a failing query", async () => {
    const zero = { total: 0, public: 0, private: 0, contributors: 0, visible: 0, lastSavedAt: null, lastSavedBy: null };
    expect(await memoryBaseStats({ context, user: undefined, db: fakeDb({ total: 0, pub: 0, priv: 0, contributors: 0, visible: 0 }) })).toEqual(zero);
    expect(await memoryBaseStats({ context, user: undefined, db: fakeDb({ total: 5, pub: 5, priv: 0, contributors: 1, visible: 5, hasTable: false }) })).toEqual(zero);
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await memoryBaseStats({ context, user: undefined, db: fakeDb({ total: 5, pub: 5, priv: 0, contributors: 1, visible: 5, throwOnCount: true }) })).toEqual(zero);
    expect(spy).toHaveBeenCalledTimes(1); spy.mockRestore();
  });
  it("leaves lastSavedBy null when created_by is null or the user row is gone", async () => {
    const a = { total: 1, pub: 1, priv: 0, contributors: 1, visible: 1 };
    expect((await memoryBaseStats({ context, user: undefined, db: fakeDb({ ...a, last: { createdAt: "2026-09-01T00:00:00.000Z", created_by: null } }) })).lastSavedBy).toBeNull();
    expect((await memoryBaseStats({ context, user: undefined, db: fakeDb({ ...a, last: { createdAt: "2026-09-01T00:00:00.000Z", created_by: 9 } }) })).lastSavedBy).toBeNull();
  });
});
