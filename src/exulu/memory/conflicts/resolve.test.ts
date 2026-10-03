jest.mock("@SRC/exulu/memory/access", () => ({ canEditMemory: jest.fn(async (_c: unknown, row: any, user: any) => user.super_admin === true || row.created_by === user.id) }));
jest.mock("@SRC/exulu/table-names", () => ({ getTableName: (id: string) => `${id}_items` }));

import { resolveConflict } from "./resolve";

function fakeDb(state: { group: any; items: any[] }) {
  const writes: any[] = [];
  const db: any = jest.fn((table: string) => {
    const chain: any = { __where: {} };
    chain.where = (...a: any[]) => { if (typeof a[0] === "object") Object.assign(chain.__where, a[0]); else chain.__where[a[0]] = a[a.length - 1]; return chain; };
    chain.whereIn = (col: string, v: any[]) => { chain.__where[`${col}__in`] = v; return chain; };
    chain.whereNot = () => chain; chain.select = () => chain; chain.whereRaw = (sql: string, b: any[]) => { chain.__raw = { sql, b }; return chain; };
    chain.first = async () => (table === "memory_conflicts" ? state.group : undefined);
    chain.update = async (patch: any) => { writes.push({ table, op: "update", where: chain.__where, patch }); return 1; };
    chain.del = async () => { writes.push({ table, op: "delete", where: chain.__where, raw: chain.__raw }); return 1; };
    chain.then = (res: any) => Promise.resolve(table.endsWith("_items") ? state.items.filter((i) => (chain.__where.id__in ?? state.items.map((x: any) => x.id)).includes(i.id)) : []).then(res);
    return chain;
  });
  db.__writes = writes;
  return db;
}
const config: any = {};
const items = [
  { id: "a", information: "A", type: "FACT", rights_mode: "public", created_by: 4, archived: false },
  { id: "b", information: "B", type: "FACT", rights_mode: "public", created_by: 9, archived: false },
  { id: "c", information: "C", type: "FACT", rights_mode: "public", created_by: 4, archived: true },
];
const group = { id: "g1", context: "mem", kind: "duplicate", members: JSON.stringify(["a", "b", "c"]), status: "open" };
const makeContext = () => ({
  id: "mem", name: "Memory", fields: [],
  updateItem: jest.fn(async (item: any) => ({ item })),
  createItem: jest.fn(async (item: any) => ({ item: { id: "merged-1", ...item } })),
}) as any;
const admin = { id: 1, super_admin: true, role: { id: "r1", agents: "write" } } as any;
const author = { id: 4, role: { id: "r1", agents: "write" } } as any;

describe("resolveConflict", () => {
  it("KEEP archives every other non-archived member without re-embedding and resolves the group", async () => {
    const context = makeContext(); const db = fakeDb({ group, items });
    const out = await resolveConflict({ db, context, config, user: admin, id: "g1", action: "KEEP", keepId: "a" });
    expect(context.updateItem.mock.calls.map((c: any[]) => c[0])).toEqual([{ id: "b", archived: true }]);   // c already archived
    expect(context.updateItem.mock.calls[0].slice(1)).toEqual([config, 1, "r1", false, false]);
    expect(db.__writes).toContainEqual(expect.objectContaining({ table: "memory_conflicts", op: "update", patch: expect.objectContaining({ status: "resolved", resolution: "keep", resolved_by: 1 }) }));
    expect(db.__writes).toContainEqual(expect.objectContaining({ table: "memory_judgements", op: "delete" }));
    expect(out.status).toBe("resolved");
  });
  it("MERGE creates the public merged memory, archives members, re-points usage and records merged_into", async () => {
    const context = makeContext(); const db = fakeDb({ group, items });
    await resolveConflict({ db, context, config, user: admin, id: "g1", action: "MERGE", merged: { information: "A and B", type: "FACT" } });
    expect(context.createItem.mock.calls[0][0]).toMatchObject({ name: "A and B", information: "A and B", type: "FACT", rights_mode: "public", created_by: 1 });
    expect(context.createItem.mock.calls[0][0].description).toMatch(/Merged from 3 memories/);
    expect(context.updateItem.mock.calls.map((c: any[]) => c[0].id).sort()).toEqual(["a", "b"]);
    const usage = db.__writes.filter((w: any) => w.table === "memory_usages");
    expect(usage.map((w: any) => w.op)).toEqual(["delete", "update"]);
    expect(usage[1].patch).toEqual({ memory_id: "merged-1" });
    expect(usage[1].where).toMatchObject({ context: "mem", memory_id__in: ["a", "b", "c"] });
    expect(db.__writes).toContainEqual(expect.objectContaining({ table: "memory_conflicts", patch: expect.objectContaining({ resolution: "merge", merged_into: "merged-1" }) }));
  });
  it("NOT_CONFLICT dismisses without touching memories", async () => {
    const context = makeContext(); const db = fakeDb({ group, items });
    await resolveConflict({ db, context, config, user: admin, id: "g1", action: "NOT_CONFLICT" });
    expect(context.updateItem).not.toHaveBeenCalled();
    expect(db.__writes).toContainEqual(expect.objectContaining({ patch: expect.objectContaining({ status: "dismissed", resolution: "not_conflict" }) }));
  });
  it("rejects when the user may not change a member, naming it; rejects MERGE on contradictions and KEEP without a member keepId", async () => {
    await expect(resolveConflict({ db: fakeDb({ group, items }), context: makeContext(), config, user: author, id: "g1", action: "KEEP", keepId: "a" })).rejects.toThrow(/b/);
    await expect(resolveConflict({ db: fakeDb({ group: { ...group, kind: "contradiction" }, items }), context: makeContext(), config, user: admin, id: "g1", action: "MERGE", merged: { information: "x" } })).rejects.toThrow(/duplicate/);
    await expect(resolveConflict({ db: fakeDb({ group, items }), context: makeContext(), config, user: admin, id: "g1", action: "KEEP", keepId: "zzz" })).rejects.toThrow(/keepId/);
  });
  it("refuses groups that are not open", async () => {
    await expect(resolveConflict({ db: fakeDb({ group: { ...group, status: "dismissed" }, items }), context: makeContext(), config, user: admin, id: "g1", action: "KEEP", keepId: "a" })).rejects.toThrow(/open/);
  });
});
