const store = {
  loadRunWorkStatus: jest.fn(),
  loadRoutineWorkStatusConfig: jest.fn(),
  setRunWorkStatus: jest.fn(),
};
jest.mock("./work-status-store", () => store);

import { resolveRoutineHandleFactory } from "./routine-handle";

const db: any = {};
const RUN = { id: "jr-1", workflow: "wf-1", work_status: "neu", work_status_updated_at: null, work_status_updated_by: { kind: "default" } };
const ROUTINE = {
  id: "wf-1",
  name: "Angebote",
  config: { statuses: [{ key: "neu", label: "Neu" }, { key: "angebot_im_erp", label: "Angebot im ERP" }, { key: "erledigt", label: "Erledigt", done: true }], default: "neu" },
};
const runSession = { routine_id: "wf-1", job_result_id: "jr-1", trigger: "email" };

beforeEach(() => {
  jest.resetAllMocks();
  store.loadRunWorkStatus.mockResolvedValue(RUN);
  store.loadRoutineWorkStatusConfig.mockResolvedValue(ROUTINE);
  store.setRunWorkStatus.mockResolvedValue({ action: "write", status: "angebot_im_erp" });
});

describe("resolveRoutineHandleFactory", () => {
  it("is undefined for a turn that is not part of a routine run", async () => {
    expect(await resolveRoutineHandleFactory(db, { sessionId: "s1", sessionMetadata: {} })).toBeUndefined();
    expect(await resolveRoutineHandleFactory(db, { sessionId: "s1", sessionMetadata: null })).toBeUndefined();
    expect(await resolveRoutineHandleFactory(db, {})).toBeUndefined();
    expect(store.loadRunWorkStatus).not.toHaveBeenCalled();
  });

  it("worker run: resolves by jobResultId and writes with origin worker and the tool as actor", async () => {
    const factory = await resolveRoutineHandleFactory(db, { jobResultId: "jr-1", sessionId: "s1", sessionMetadata: runSession, actingUser: 11 });
    const routine = factory!({ kind: "tool", id: "generate_offer_xml" });
    expect(routine.id).toBe("wf-1");
    expect(routine.name).toBe("Angebote");
    expect(routine.statuses).toEqual([{ key: "neu", label: "Neu" }, { key: "angebot_im_erp", label: "Angebot im ERP" }, { key: "erledigt", label: "Erledigt", done: true }]);
    expect(routine.runs.current.id).toBe("jr-1");
    expect(routine.runs.current.status).toBe("neu");
    expect(store.loadRunWorkStatus).toHaveBeenCalledWith(db, "jr-1");

    await routine.runs.current.update({ status: "angebot_im_erp" });
    expect(store.setRunWorkStatus).toHaveBeenCalledWith(db, {
      jobResultId: "jr-1",
      status: "angebot_im_erp",
      actor: { kind: "tool", id: "generate_offer_xml" },
      origin: "worker",
    });
    expect(routine.runs.current.status).toBe("angebot_im_erp");
  });

  it("chat on a run session: resolves the run from the session metadata, origin chat, actor carries the acting user", async () => {
    const factory = await resolveRoutineHandleFactory(db, { sessionId: "s1", sessionMetadata: JSON.stringify(runSession), actingUser: 14 });
    expect(store.loadRunWorkStatus).toHaveBeenCalledWith(db, "jr-1");
    await factory!({ kind: "tool", id: "generate_offer_xml" }).runs.current.update({ status: "angebot_im_erp" });
    expect(store.setRunWorkStatus).toHaveBeenCalledWith(db, expect.objectContaining({ origin: "chat", actor: { kind: "tool", id: "generate_offer_xml", user: 14 } }));
    await factory!({ kind: "agent" }).runs.current.update({ status: "erledigt" });
    expect(store.setRunWorkStatus).toHaveBeenLastCalledWith(db, expect.objectContaining({ actor: { kind: "agent", user: 14 } }));
  });

  it("is undefined when the run row or its routine is gone, and when the lookup throws", async () => {
    store.loadRunWorkStatus.mockResolvedValueOnce(undefined);
    expect(await resolveRoutineHandleFactory(db, { sessionId: "s1", sessionMetadata: runSession })).toBeUndefined();
    store.loadRoutineWorkStatusConfig.mockResolvedValueOnce(undefined);
    expect(await resolveRoutineHandleFactory(db, { sessionId: "s1", sessionMetadata: runSession })).toBeUndefined();
    store.loadRunWorkStatus.mockRejectedValueOnce(new Error("db down"));
    expect(await resolveRoutineHandleFactory(db, { sessionId: "s1", sessionMetadata: runSession })).toBeUndefined();
  });

  it("update rejects unknown fields and writes nothing", async () => {
    const routine = (await resolveRoutineHandleFactory(db, { jobResultId: "jr-1" }))!({ kind: "tool", id: "t" });
    await expect(routine.runs.current.update({ state: "completed" } as any)).rejects.toThrow("Unknown routine run field(s): state. Allowed: status");
    expect(store.setRunWorkStatus).not.toHaveBeenCalled();
  });

  it("an empty patch is a no-op", async () => {
    const routine = (await resolveRoutineHandleFactory(db, { jobResultId: "jr-1" }))!({ kind: "tool", id: "t" });
    await expect(routine.runs.current.update({})).resolves.toBeUndefined();
    expect(store.setRunWorkStatus).not.toHaveBeenCalled();
  });

  it("a skipped write (person set the status) keeps the handle's status and reports the decision", async () => {
    store.setRunWorkStatus.mockResolvedValueOnce({ action: "skip", reason: "human_set" });
    const routine = (await resolveRoutineHandleFactory(db, { jobResultId: "jr-1" }))!({ kind: "agent" });
    expect(await routine.runs.current.updateWithResult({ status: "erledigt" })).toEqual({ action: "skip", reason: "human_set" });
    expect(routine.runs.current.status).toBe("neu");
  });

  it("a routine without statuses still yields a handle with an empty list", async () => {
    store.loadRoutineWorkStatusConfig.mockResolvedValueOnce({ ...ROUTINE, config: { statuses: [], default: null } });
    const routine = (await resolveRoutineHandleFactory(db, { jobResultId: "jr-1" }))!({ kind: "tool", id: "t" });
    expect(routine.statuses).toEqual([]);
  });
});
