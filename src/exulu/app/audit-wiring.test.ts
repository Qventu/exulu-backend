import { computeBuiltinToolIds } from "./audit-wiring-helpers";

describe("computeBuiltinToolIds", () => {
  it("collects ids from the built-in tool arrays only", () => {
    const ids = computeBuiltinToolIds({
      todoTools: [{ id: "todo_a" }],
      questionTools: [{ id: "ask" }],
      perplexityTools: [],
      emailTool: { id: "email" },
      imageGenerationTools: [{ id: "img" }],
    } as any);
    expect(ids.has("todo_a")).toBe(true);
    expect(ids.has("ask")).toBe(true);
    expect(ids.has("email")).toBe(true);
    expect(ids.has("img")).toBe(true);
    expect(ids.size).toBe(4);
  });
});
