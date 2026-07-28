import { emitToolCallAudit } from "@SRC/exulu/audit/emit-tool-call";

describe("emitToolCallAudit", () => {
  it("does nothing when the tool is not audited", async () => {
    const logger = { shouldAuditTool: () => false, isBuiltin: () => false, failClosed: false, recordToolCall: jest.fn() };
    await emitToolCallAudit(logger as any, { durationMs: 1, tool: { id: "t", name: "t" }, user: { id: 1 }, input: {}, output: {}, status: "ok" } as any);
    expect(logger.recordToolCall).not.toHaveBeenCalled();
  });

  it("records once and sets builtin from the logger, awaiting only in fail-closed", async () => {
    const calls: any[] = [];
    const logger = { shouldAuditTool: () => true, isBuiltin: (id: string) => id === "todo", failClosed: false, recordToolCall: async (c: any) => { calls.push(c); } };
    await emitToolCallAudit(logger as any, { durationMs: 1, tool: { id: "todo", name: "todo" }, user: { id: 1 }, input: {}, output: {}, status: "ok" } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0].builtin).toBe(true);
  });

  it("never throws even if recordToolCall rejects (open mode)", async () => {
    const logger = { shouldAuditTool: () => true, isBuiltin: () => false, failClosed: false, recordToolCall: async () => { throw new Error("x"); } };
    await expect(emitToolCallAudit(logger as any, { durationMs: 1, tool: { id: "t", name: "t" }, user: { id: 1 }, input: {}, output: {}, status: "ok" } as any)).resolves.toBeUndefined();
  });
});
