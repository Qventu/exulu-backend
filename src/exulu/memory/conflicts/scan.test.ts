jest.mock("@SRC/exulu/table-names", () => ({ getTableName: (id: string) => `${id}_items`, getChunksTableName: (id: string) => `${id}_chunks` }));

import { runScan, type Judge } from "./scan";

type Row = Record<string, any>;
function fakeDb(state: { pairs: Row[]; items: Row[]; conflicts?: Row[]; judgements?: Row[]; hasTable?: (t: string) => boolean; itemCount?: number }) {
  const writes: any[] = [];
  const conflicts = state.conflicts ?? [];
  const judgements = state.judgements ?? [];
  const db: any = jest.fn((table: string) => {
    const chain: any = { __table: table, __where: {} };
    const ret = (v: any) => { chain.__ret = v; return chain; };
    chain.where = (...args: any[]) => { if (typeof args[0] === "object") Object.assign(chain.__where, args[0]); else chain.__where[args[0]] = args[args.length - 1]; return chain; };
    chain.whereIn = (col: string, vals: any[]) => { chain.__where[`${col}__in`] = vals; return chain; };
    chain.whereNot = () => chain; chain.whereRaw = () => chain; chain.select = () => chain; chain.first = async () => chain.__ret?.[0];
    chain.count = async () => [{ c: String(state.itemCount ?? state.items.length) }];
    chain.insert = (rows: any) => { writes.push({ table, op: "insert", rows }); return { onConflict: () => ({ ignore: async () => undefined, merge: async () => undefined }) }; };
    chain.update = async (patch: any) => { writes.push({ table, op: "update", where: chain.__where, patch }); return 1; };
    chain.del = async () => { writes.push({ table, op: "delete", where: chain.__where }); return 1; };
    chain.then = (resolve: any, reject: any) => {
      const rows = table === "memory_conflicts" ? conflicts : table === "memory_judgements" ? judgements : table.endsWith("_items") ? state.items : [];
      return Promise.resolve(rows).then(resolve, reject);
    };
    return chain;
  });
  db.raw = async (_sql: string, _bindings?: any[]) => ({ rows: state.pairs });
  db.schema = { hasTable: async (t: string) => (state.hasTable ? state.hasTable(t) : true) };
  db.__writes = writes;
  return db;
}

const context = { id: "mem", name: "Memory" } as any;
const NOW = new Date("2026-10-03T10:00:00.000Z");
const stubJudge = (answers: Record<string, { verdict: "same" | "contradict" | "compatible"; reason: string }>): Judge =>
  jest.fn(async (a: string, b: string) => answers[`${a}|${b}`] ?? { verdict: "compatible", reason: "" });

describe("runScan", () => {
  it("writes nothing and reports zeros for a base without pairs", async () => {
    const db = fakeDb({ pairs: [], items: [{ id: "a" }] });
    const out = await runScan({ db, context, user: { id: 1 } as any, judge: stubJudge({}), now: NOW });
    expect(out).toMatchObject({ open: 0, duplicateGroups: 0, contradictionGroups: 0, judged: 0, unjudged: 0 });
    expect(db.__writes.filter((w: any) => w.op === "insert")).toEqual([]);
  });

  it("groups duplicates, judges the band once, stores judgements and upserts groups", async () => {
    const db = fakeDb({
      pairs: [{ a_id: "a", b_id: "b", similarity: 0.95 }, { a_id: "c", b_id: "d", similarity: 0.8 }, { a_id: "e", b_id: "f", similarity: 0.75 }],
      // wording == id so the stub judge can key on what it receives
      items: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, information: id })),
    });
    const judge = stubJudge({ "c|d": { verdict: "contradict", reason: "c says X, d says not X" }, "e|f": { verdict: "compatible", reason: "" } });
    const out = await runScan({ db, context, user: { id: 1 } as any, judge, now: NOW });
    expect(judge).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ open: 2, duplicateGroups: 1, contradictionGroups: 1, judged: 2, unjudged: 0 });
    const inserts = db.__writes.filter((w: any) => w.op === "insert");
    expect(inserts.find((w: any) => w.table === "memory_judgements").rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "mem:c,d", verdict: "contradict" }), expect.objectContaining({ key: "mem:e,f", verdict: "compatible" }),
    ]));
    const groups = inserts.find((w: any) => w.table === "memory_conflicts").rows;
    expect(groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "mem:duplicate:a,b", kind: "duplicate", members: JSON.stringify(["a", "b"]), similarity: 0.95, status: "open" }),
      expect.objectContaining({ key: "mem:contradiction:c,d", kind: "contradiction", reason: "c says X, d says not X", status: "open" }),
    ]));
  });

  it("reuses stored judgements, never reopens dismissed groups and closes open groups the scan did not produce", async () => {
    const db = fakeDb({
      pairs: [{ a_id: "c", b_id: "d", similarity: 0.8 }],
      items: [{ id: "c" }, { id: "d" }],
      judgements: [{ key: "mem:c,d", verdict: "contradict", reason: "stored" }],
      conflicts: [
        { id: "g1", key: "mem:contradiction:c,d", status: "dismissed" },
        { id: "g2", key: "mem:duplicate:x,y", status: "open" },
      ],
    });
    const judge = stubJudge({});
    const out = await runScan({ db, context, user: { id: 1 } as any, judge, now: NOW });
    expect(judge).not.toHaveBeenCalled();
    expect(out.judged).toBe(0);
    const inserts = db.__writes.filter((w: any) => w.op === "insert" && w.table === "memory_conflicts");
    expect(inserts).toEqual([]);                       // dismissed key is not re-inserted/reopened
    const closes = db.__writes.filter((w: any) => w.op === "update" && w.table === "memory_conflicts");
    expect(closes).toEqual([expect.objectContaining({ where: expect.objectContaining({ id__in: ["g2"] }), patch: expect.objectContaining({ status: "resolved", resolution: null }) })]);
  });

  it("caps judge calls per scan and reports the rest as unjudged; a failing judge leaves the pair unjudged", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pairs = Array.from({ length: 45 }, (_, i) => ({ a_id: `p${i}`, b_id: `q${i}`, similarity: 0.8 - i * 0.001 }));
      const items = pairs.flatMap((x) => [{ id: x.a_id, information: x.a_id }, { id: x.b_id, information: x.b_id }]);
      const judge: Judge = jest.fn(async (a: string) => { if (a === "p3") throw new Error("boom"); return { verdict: "compatible", reason: "" }; });
      const out = await runScan({ db: fakeDb({ pairs, items }), context, user: { id: 1 } as any, judge, now: NOW });
      expect(judge).toHaveBeenCalledTimes(40);
      expect(out.judged).toBe(39);
      expect(out.unjudged).toBe(6);  // 5 beyond the cap + 1 failed
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("refuses bases above the size cap", async () => {
    await expect(runScan({ db: fakeDb({ pairs: [], items: [], itemCount: 2001 }), context, user: { id: 1 } as any, judge: stubJudge({}), now: NOW })).rejects.toThrow(/too large/);
  });
});
