import { createRoutineStatusTool, SET_ROUTINE_STATUS_TOOL_ID } from "./routine-status-tool";

const makeHandle = (statuses: { key: string; label: string; done?: boolean }[], decision: unknown = { action: "write", status: "rueckfrage" }) => {
  const updateWithResult = jest.fn(async () => decision);
  return {
    updateWithResult,
    handle: { id: "wf-1", name: "Ersatzteil Angebot", statuses, runs: { current: { id: "jr-1", status: "neu", update: jest.fn(), updateWithResult } } } as never,
  };
};
const STATUSES = [{ key: "neu", label: "Neu" }, { key: "rueckfrage", label: "Rückfrage vorbereitet" }, { key: "erledigt", label: "Erledigt", done: true }];

describe("createRoutineStatusTool", () => {
  it("is not offered outside a routine run or for a routine without statuses", () => {
    expect(createRoutineStatusTool(undefined)).toBeUndefined();
    expect(createRoutineStatusTool(makeHandle([]).handle)).toBeUndefined();
  });

  it("offers exactly the configured keys and names each with its label", () => {
    const tool = createRoutineStatusTool(makeHandle(STATUSES).handle)!;
    expect(tool.id).toBe(SET_ROUTINE_STATUS_TOOL_ID);
    expect(tool.needsApproval).toBe(false);
    expect(tool.inputSchema!.safeParse({ status: "rueckfrage" }).success).toBe(true);
    expect(tool.inputSchema!.safeParse({ status: "erfunden" }).success).toBe(false);
    expect(tool.description).toContain("rueckfrage — Rückfrage vorbereitet");
    expect(tool.description).toContain("erledigt — Erledigt");
  });

  it("sets the status through the run handle and names the label", async () => {
    const { handle, updateWithResult } = makeHandle(STATUSES);
    const out = await (createRoutineStatusTool(handle)!.tool as any).execute({ status: "rueckfrage" }, {});
    expect(updateWithResult).toHaveBeenCalledWith({ status: "rueckfrage" });
    expect(JSON.stringify(out)).toContain('Status set to \\"Rückfrage vorbereitet\\".');
  });

  it("says so when a person already set the status", async () => {
    const { handle } = makeHandle(STATUSES, { action: "skip", reason: "human_set" });
    const out = await (createRoutineStatusTool(handle)!.tool as any).execute({ status: "rueckfrage" }, {});
    expect(JSON.stringify(out)).toContain("A person already set the status");
    expect(JSON.stringify(out)).toContain("left unchanged");
  });

  it("reports an unchanged status as set", async () => {
    const { handle } = makeHandle(STATUSES, { action: "skip", reason: "unchanged" });
    const out = await (createRoutineStatusTool(handle)!.tool as any).execute({ status: "neu" }, {});
    expect(JSON.stringify(out)).toContain('Status is already \\"Neu\\".');
  });
});
