import { dropEmptyMessages } from "./stored-messages";

describe("dropEmptyMessages — stored history must never contain a message without parts", () => {
  it("removes an assistant message whose parts array is empty and keeps the rest in order", () => {
    const history = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      { id: "a1", role: "assistant", parts: [] },
      { id: "u2", role: "user", parts: [{ type: "text", text: "again" }] },
    ] as any[];
    expect(dropEmptyMessages(history).map((m) => m.id)).toEqual(["u1", "u2"]);
  });

  it("removes messages whose parts field is missing or not an array", () => {
    const history = [
      { id: "a1", role: "assistant" },
      { id: "a2", role: "assistant", parts: null },
      { id: "u1", role: "user", parts: [{ type: "text", text: "ok" }] },
    ] as any[];
    expect(dropEmptyMessages(history).map((m) => m.id)).toEqual(["u1"]);
  });

  it("returns the same array when nothing needs dropping", () => {
    const history = [{ id: "u1", role: "user", parts: [{ type: "text", text: "ok" }] }] as any[];
    expect(dropEmptyMessages(history)).toBe(history);
  });
});
