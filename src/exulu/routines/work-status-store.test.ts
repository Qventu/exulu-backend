import { defaultWorkStatusColumns, loadRunBySession, loadRunWorkStatus, loadRoutineWorkStatusConfig, setRunWorkStatus } from "./work-status-store";

const CONFIG = { statuses: [{ key: "neu", label: "Neu" }, { key: "erledigt", label: "Erledigt", done: true }], default: "neu" };

/** Minimal knex stand-in: db(table) → chainable builder over in-memory rows. */
function makeDb(tables: Record<string, any[]>) {
  const updates: { table: string; where: any; values: any }[] = [];
  const db: any = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    let whereObj: any = {};
    const builder: any = {
      where(cond: any) { whereObj = { ...whereObj, ...cond }; rows = rows.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return builder; },
      whereNotNull(col: string) { rows = rows.filter((r) => r[col] != null); return builder; },
      orderBy(col: string, dir: string) { rows.sort((a, b) => (a[col] < b[col] ? -1 : 1) * (dir === "desc" ? -1 : 1)); return builder; },
      select() { return builder; },
      async first() { return rows[0]; },
      async update(values: any) { updates.push({ table, where: whereObj, values }); return rows.length; },
    };
    return builder;
  };
  return { db, updates };
}

const routine = { id: "wf-1", name: "Ersatzteil Angebot", work_statuses: JSON.stringify(CONFIG) };
const run = (over: any = {}) => ({ id: "jr-1", workflow: "wf-1", session: "sess-1", createdAt: 1, work_status: "neu", work_status_updated_at: null, work_status_updated_by: JSON.stringify({ kind: "default" }), ...over });

describe("work-status-store reads", () => {
  it("loadRunWorkStatus parses updated_by whether it is a string or an object", async () => {
    const a = makeDb({ job_results: [run()] });
    expect((await loadRunWorkStatus(a.db, "jr-1"))?.work_status_updated_by).toEqual({ kind: "default" });
    const b = makeDb({ job_results: [run({ work_status_updated_by: { kind: "user", id: 14 } })] });
    expect((await loadRunWorkStatus(b.db, "jr-1"))?.work_status_updated_by).toEqual({ kind: "user", id: 14 });
    expect(await loadRunWorkStatus(a.db, "nope")).toBeUndefined();
  });
  it("loadRunBySession returns the newest routine run of the session and ignores rows without a workflow", async () => {
    const { db } = makeDb({ job_results: [run({ id: "old", createdAt: 1 }), run({ id: "new", createdAt: 5 }), run({ id: "eval", workflow: null, createdAt: 9 })] });
    expect((await loadRunBySession(db, "sess-1"))?.id).toBe("new");
    expect(await loadRunBySession(db, "other")).toBeUndefined();
  });
  it("loadRoutineWorkStatusConfig returns the parsed config, also for a routine without one", async () => {
    const { db } = makeDb({ workflow_templates: [routine, { id: "wf-2", name: "Ohne", work_statuses: null }] });
    expect(await loadRoutineWorkStatusConfig(db, "wf-1")).toEqual({ id: "wf-1", name: "Ersatzteil Angebot", config: CONFIG });
    expect((await loadRoutineWorkStatusConfig(db, "wf-2"))?.config).toEqual({ statuses: [], default: null });
    expect(await loadRoutineWorkStatusConfig(db, "nope")).toBeUndefined();
  });
});

describe("setRunWorkStatus", () => {
  it("writes status, timestamp and actor on a valid change", async () => {
    const { db, updates } = makeDb({ job_results: [run()], workflow_templates: [routine] });
    const decision = await setRunWorkStatus(db, { jobResultId: "jr-1", status: "erledigt", actor: { kind: "user", id: 14 }, origin: "manual" });
    expect(decision).toEqual({ action: "write", status: "erledigt" });
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe("job_results");
    expect(updates[0].where).toEqual({ id: "jr-1" });
    expect(updates[0].values.work_status).toBe("erledigt");
    expect(updates[0].values.work_status_updated_at).toBeInstanceOf(Date);
    expect(JSON.parse(updates[0].values.work_status_updated_by)).toEqual({ kind: "user", id: 14 });
  });
  it("does not write when a worker write meets a human-set status", async () => {
    const { db, updates } = makeDb({ job_results: [run({ work_status: "erledigt", work_status_updated_by: JSON.stringify({ kind: "user", id: 14 }) })], workflow_templates: [routine] });
    expect(await setRunWorkStatus(db, { jobResultId: "jr-1", status: "neu", actor: { kind: "tool", id: "generate_offer_xml" }, origin: "worker" })).toEqual({ action: "skip", reason: "human_set" });
    expect(updates).toEqual([]);
  });
  it("throws the rule's message for an unknown status and writes nothing", async () => {
    const { db, updates } = makeDb({ job_results: [run()], workflow_templates: [routine] });
    await expect(setRunWorkStatus(db, { jobResultId: "jr-1", status: "fertig", actor: { kind: "agent" }, origin: "worker" })).rejects.toThrow(/Unknown work status "fertig".*Allowed: neu, erledigt/);
    expect(updates).toEqual([]);
  });
  it("throws when the run or its routine is gone", async () => {
    const a = makeDb({ job_results: [], workflow_templates: [routine] });
    await expect(setRunWorkStatus(a.db, { jobResultId: "jr-1", status: "neu", actor: { kind: "agent" }, origin: "worker" })).rejects.toThrow("Run jr-1 not found");
    const b = makeDb({ job_results: [run()], workflow_templates: [] });
    await expect(setRunWorkStatus(b.db, { jobResultId: "jr-1", status: "neu", actor: { kind: "agent" }, origin: "worker" })).rejects.toThrow(/routine .* not found/i);
  });
});

describe("defaultWorkStatusColumns", () => {
  it("returns the default status, a timestamp and the default actor", async () => {
    const { db } = makeDb({ workflow_templates: [routine] });
    const cols = await defaultWorkStatusColumns(db, "wf-1");
    expect(cols.work_status).toBe("neu");
    expect(cols.work_status_updated_at).toBeInstanceOf(Date);
    expect(JSON.parse(cols.work_status_updated_by!)).toEqual({ kind: "default" });
  });
  it("returns {} without statuses, without a default, for an unknown routine, and when the lookup fails", async () => {
    const { db } = makeDb({ workflow_templates: [{ id: "wf-2", name: "Ohne", work_statuses: null }, { id: "wf-3", name: "x", work_statuses: { statuses: [{ key: "neu", label: "Neu" }], default: null } }] });
    expect(await defaultWorkStatusColumns(db, "wf-2")).toEqual({});
    expect(await defaultWorkStatusColumns(db, "wf-3")).toEqual({});
    expect(await defaultWorkStatusColumns(db, "nope")).toEqual({});
    const broken: any = () => { throw new Error("db down"); };
    expect(await defaultWorkStatusColumns(broken, "wf-1")).toEqual({});
  });
});
