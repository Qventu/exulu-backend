jest.mock("@SRC/postgres/client", () => ({ postgresClient: jest.fn(async () => ({ db: mockDb })) }));
jest.mock("@EE/rbac-update.ts", () => ({ handleRBACUpdate: jest.fn(async () => undefined) }));
jest.mock("./recall-collector", () => ({
  ...jest.requireActual("./recall-collector"),
  loadVisibleMemoryRows: jest.fn(),
}));

import { handleRBACUpdate } from "@EE/rbac-update.ts";
import { createMemoryTools } from "./tools";
import { loadVisibleMemoryRows } from "./recall-collector";

// Table-aware knex fake: users → creator lookup, rbac → write grants (set per test).
const mockRbacRows: any[] = [];
const mockChain = (table: string) => {
  const c: any = {
    where: () => c, whereIn: () => c,
    select: async () => (table === "users" ? [{ id: 9, firstname: "Sara", lastname: "Kraus" }] : table === "rbac" ? mockRbacRows : []),
  };
  return c;
};
const mockDb: any = jest.fn((table: string) => mockChain(table));

const createItem = jest.fn(async (item: any) => ({ item: { id: "new-1", ...item }, job: undefined }));
const updateItem = jest.fn(async (item: any) => ({ item, job: undefined }));
const deleteItem = jest.fn(async () => ({ id: "m1" }));
const context: any = {
  id: "newton_memory_context", name: "Newton memory",
  fields: [{ name: "information", type: "text" }, { name: "type", type: "enum", enumValues: ["FACT", "PREFERENCE"] }],
  createItem, updateItem, deleteItem,
};
const agent: any = { id: "agent-1", name: "Newton", memory: "newton_memory_context" };
const me = { id: 4, role: { id: "r1" } } as any;
const other = { id: 5, role: { id: "r1" } } as any;
const visible = loadVisibleMemoryRows as jest.Mock;

const tools = () => Object.fromEntries(createMemoryTools({ agent, context, user: me }).map((t) => [t.id, t]));
const base = { title: "Encoder first", information: "Check X12 before valves", type: "fact", whySaved: "Question about AZFR" };

beforeEach(() => { createItem.mockClear(); updateItem.mockClear(); deleteItem.mockClear(); (handleRBACUpdate as jest.Mock).mockClear(); visible.mockReset(); mockRbacRows.length = 0; });

describe("memory_remember", () => {
  it("registers three approval-gated tools with fixed ids", () => {
    const created = createMemoryTools({ agent, context, user: me });
    const ids = created.map((t) => t.id);
    expect(ids).toEqual(["memory_remember", "memory_update", "memory_forget"]);
    expect(tools().memory_remember.needsApproval).toBe(true);
    expect(typeof tools().memory_update.needsApprovalFn).toBe("function");
    expect(typeof tools().memory_forget.needsApprovalFn).toBe("function");
  });

  it("names every tool with its id, so the AI SDK's sanitized-name keying (which drops the display name) still routes to tool-memory_*", () => {
    for (const t of createMemoryTools({ agent, context, user: me })) {
      expect(t.name).toBe(t.id);
    }
  });

  it("writes the decision's wording, type and rights over the model input and applies rbac grants", async () => {
    const decision = { v: 1, kind: "remember", title: "Encoder first!", information: "Edited wording", type: "PREFERENCE", rights_mode: "users", rbac: { users: [{ id: 5, rights: "read" }] } };
    const out: any = await tools().memory_remember.tool.execute!({ ...base, user: me, exuluConfig: {}, memoryDecision: decision } as any, {} as any);
    expect(createItem).toHaveBeenCalledWith(
      { name: "Encoder first!", information: "Edited wording", type: "PREFERENCE", description: "Question about AZFR", rights_mode: "users" },
      {}, 4, "r1", false,
    );
    expect(handleRBACUpdate).toHaveBeenCalledWith(mockDb, expect.any(String), "new-1", decision.rbac, []);
    expect(out).toMatchObject({ type: "memory_saved", itemId: "new-1", contextId: "newton_memory_context", rights_mode: "users", information: "Edited wording" });
  });

  it("falls back to the model input and the context default when there is no decision, normalising the enum", async () => {
    const out: any = await tools().memory_remember.tool.execute!({ ...base, user: me, exuluConfig: {} } as any, {} as any);
    expect(createItem.mock.calls[0][0]).toEqual({ name: "Encoder first", information: "Check X12 before valves", type: "FACT", description: "Question about AZFR" });
    expect(handleRBACUpdate).not.toHaveBeenCalled();
    expect(out.type).toBe("memory_saved");
  });

  it("re-validates a stale decision type against the current enum (drops it, letting the column default apply)", async () => {
    const decision = { v: 1, kind: "remember", title: "T", information: "I", type: "DECISION", rights_mode: "private" };
    await tools().memory_remember.tool.execute!({ ...base, user: me, exuluConfig: {}, memoryDecision: decision } as any, {} as any);
    expect(createItem.mock.calls[0][0]).not.toHaveProperty("type");
  });

  it("saves the memory even when applying rbac grants fails, and warns instead of erroring", async () => {
    const decision = { v: 1, kind: "remember", title: "T", information: "I", type: "FACT", rights_mode: "users", rbac: { users: [{ id: 5, rights: "read" }] } };
    (handleRBACUpdate as jest.Mock).mockRejectedValueOnce(new Error("rbac fail"));
    const out: any = await tools().memory_remember.tool.execute!({ ...base, user: me, exuluConfig: {}, memoryDecision: decision } as any, {} as any);
    expect(createItem).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ type: "memory_saved", itemId: "new-1", warning: expect.stringContaining("rbac fail") });
  });

  it("refuses without a signed-in user and reports write failures as memory_error", async () => {
    const guest: any = await tools().memory_remember.tool.execute!({ ...base, exuluConfig: {} } as any, {} as any);
    expect(guest.type).toBe("memory_error");
    createItem.mockRejectedValueOnce(new Error("boom"));
    const failed: any = await tools().memory_remember.tool.execute!({ ...base, user: me, exuluConfig: {} } as any, {} as any);
    expect(failed).toMatchObject({ type: "memory_error", message: "boom" });
  });
});

describe("memory_update / memory_forget", () => {
  const mine = { id: "m1", name: "Old", information: "Old fact", type: "FACT", rights_mode: "private", created_by: 4 };
  const theirs = { id: "m2", name: "Theirs", information: "Their fact", type: "FACT", rights_mode: "public", created_by: 9 };

  it("needs approval when the item is visible and writable, not otherwise", async () => {
    visible.mockResolvedValueOnce([mine]);
    expect(await tools().memory_update.needsApprovalFn!({ memoryId: "m1" }, { toolCallId: "c", messages: [] })).toBe(true);
    visible.mockResolvedValueOnce([theirs]);
    expect(await tools().memory_update.needsApprovalFn!({ memoryId: "m2" }, { toolCallId: "c", messages: [] })).toBe(false);
    visible.mockResolvedValueOnce([]);
    expect(await tools().memory_forget.needsApprovalFn!({ memoryId: "nope" }, { toolCallId: "c", messages: [] })).toBe(false);
  });

  it("resolves needsApproval to false (not throw) when the visibility lookup rejects", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    visible.mockRejectedValueOnce(new Error("db down"));
    await expect(tools().memory_update.needsApprovalFn!({ memoryId: "m1" }, { toolCallId: "c", messages: [] })).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("m1"), expect.anything());
    warn.mockRestore();
  });

  it("update merges the decision over the input and patches through updateItem", async () => {
    visible.mockResolvedValue([mine]);
    const out: any = await tools().memory_update.tool.execute!({ memoryId: "m1", information: "Model wording", reason: "user corrected", user: me, exuluConfig: {}, memoryDecision: { v: 1, kind: "update", information: "User wording" } } as any, {} as any);
    expect(updateItem).toHaveBeenCalledWith({ id: "m1", information: "User wording" }, {}, 4, "r1");
    expect(out).toMatchObject({ type: "memory_updated", itemId: "m1", information: "User wording" });
  });

  it("update leaves the type unchanged when the requested type no longer matches the enum", async () => {
    visible.mockResolvedValue([mine]);
    const out: any = await tools().memory_update.tool.execute!({ memoryId: "m1", information: "still valid", reason: "r", type: "DECISION", user: me, exuluConfig: {} } as any, {} as any);
    expect(updateItem).toHaveBeenCalledWith({ id: "m1", information: "still valid" }, {}, 4, "r1");
    expect(updateItem.mock.calls[0][0]).not.toHaveProperty("type");
    expect(out.type).toBe("memory_updated");
  });

  it("update on someone else's PUBLIC memory returns memory_no_access with the creator, and never writes (public = read for everyone)", async () => {
    visible.mockResolvedValue([theirs]);
    const out: any = await tools().memory_update.tool.execute!({ memoryId: "m2", information: "x", reason: "r", user: me, exuluConfig: {} } as any, {} as any);
    expect(updateItem).not.toHaveBeenCalled();
    expect(out).toMatchObject({ type: "memory_no_access", itemId: "m2", createdBy: { id: 9, name: "Sara Kraus" } });
  });

  it("an explicit write grant on someone else's memory allows the update", async () => {
    visible.mockResolvedValue([theirs]);
    mockRbacRows.push({ access_type: "User", user_id: 4, rights: "write" });
    expect(await tools().memory_update.needsApprovalFn!({ memoryId: "m2" }, { toolCallId: "c", messages: [] })).toBe(true);
    const out: any = await tools().memory_update.tool.execute!({ memoryId: "m2", information: "granted edit", reason: "r", user: me, exuluConfig: {} } as any, {} as any);
    expect(updateItem).toHaveBeenCalledWith({ id: "m2", information: "granted edit" }, {}, 4, "r1");
    expect(out.type).toBe("memory_updated");
  });

  it("update on an invisible memory returns memory_no_access without wording or creator", async () => {
    visible.mockResolvedValue([]);
    const out: any = await tools().memory_update.tool.execute!({ memoryId: "secret", information: "x", reason: "r", user: me, exuluConfig: {} } as any, {} as any);
    expect(out).toEqual({ type: "memory_no_access", contextId: "newton_memory_context", itemId: "secret", title: null, createdBy: null, result: expect.any(String) });
  });

  it("forget deletes an own memory and refuses someone else's", async () => {
    visible.mockResolvedValue([mine]);
    const ok: any = await tools().memory_forget.tool.execute!({ memoryId: "m1", reason: "r", user: me, exuluConfig: {} } as any, {} as any);
    expect(deleteItem).toHaveBeenCalledWith({ id: "m1" }, 4, "r1");
    expect(ok).toMatchObject({ type: "memory_forgotten", itemId: "m1", title: "Old" });
    visible.mockResolvedValue([theirs]);
    const no: any = await tools().memory_forget.tool.execute!({ memoryId: "m2", reason: "r", user: other, exuluConfig: {} } as any, {} as any);
    expect(no.type).toBe("memory_no_access");
  });
});
