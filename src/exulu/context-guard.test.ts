import { contextGuard, composePrepareSteps } from "./context-guard";

const toolMsg = (text: string) => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: "c1", toolName: "web_search", output: { type: "text", value: text } }],
});

describe("contextGuard", () => {
  it("returns undefined while the step messages fit", async () => {
    const guard = contextGuard(128_000);
    await expect(guard({ stepNumber: 1, messages: [toolMsg("small")] })).resolves.toBeUndefined();
  });

  it("collapses older tool results but keeps the last two tool messages intact", async () => {
    const guard = contextGuard(1_000); // usable 800 tokens → tiny
    const big = "x".repeat(5_000);
    const messages = [toolMsg(big), toolMsg(big), toolMsg(big), { role: "user", content: "q" }];
    const result = (await guard({ stepNumber: 2, messages })) as { messages: typeof messages };
    expect(result).toBeDefined();
    const outputs = result.messages
      .filter((m) => m.role === "tool")
      .map((m) => (m.content as Array<{ output: { value: string } }>)[0]!.output.value);
    expect(outputs[0]!.length).toBeLessThan(600);
    expect(outputs[0]).toContain("collapsed mid-response");
    expect(outputs[1]).toBe(big);
    expect(outputs[2]).toBe(big);
  });

  it("returns undefined when there is nothing collapsible", async () => {
    const guard = contextGuard(1_000);
    const messages = [toolMsg("x".repeat(5_000)), { role: "user", content: "q" }];
    await expect(guard({ stepNumber: 1, messages })).resolves.toBeUndefined();
  });
});

describe("composePrepareSteps", () => {
  it("threads messages between guards and merges overrides", async () => {
    const first = () => ({ messages: [{ role: "user", content: "rewritten" }] });
    const second = (opts: { messages?: unknown[] }) => ({
      toolChoice: "none",
      seen: (opts.messages as Array<{ content: string }>)[0]!.content,
    });
    const composed = composePrepareSteps(first, second);
    const result = (await composed({ stepNumber: 0, messages: [{ role: "user", content: "orig" }] })) as Record<string, unknown>;
    expect(result.toolChoice).toBe("none");
    expect(result.seen).toBe("rewritten");
    expect((result.messages as Array<{ content: string }>)[0]!.content).toBe("rewritten");
  });

  it("returns undefined when no guard fires", async () => {
    const composed = composePrepareSteps(() => undefined, () => undefined);
    await expect(composed({ stepNumber: 0, messages: [] })).resolves.toBeUndefined();
  });
});
