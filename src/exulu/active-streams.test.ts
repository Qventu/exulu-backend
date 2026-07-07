import { markStreamActive, clearStreamActive, isStreamActive } from "./active-streams";

describe("active-streams", () => {
  it("tracks per-session stream activity idempotently", () => {
    expect(isStreamActive("s1")).toBe(false);
    markStreamActive("s1");
    markStreamActive("s1");
    expect(isStreamActive("s1")).toBe(true);
    expect(isStreamActive("s2")).toBe(false);
    clearStreamActive("s1");
    clearStreamActive("s1");
    expect(isStreamActive("s1")).toBe(false);
  });
});
