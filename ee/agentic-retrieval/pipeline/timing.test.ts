import { withTiming } from "./timing";

describe("withTiming — records how long a pipeline sub-phase took", () => {
  it("stores the elapsed milliseconds under the key and returns the awaited value", async () => {
    const timings: Record<string, number> = {};
    let now = 1000;
    const clock = () => now;
    const value = await withTiming(timings, "memory.relevanceMs", async () => { now += 250; return "ok"; }, clock);
    expect(value).toBe("ok");
    expect(timings["memory.relevanceMs"]).toBe(250);
  });

  it("still records the time when the sub-phase throws, then rethrows", async () => {
    const timings: Record<string, number> = {};
    let now = 0;
    const clock = () => now;
    await expect(withTiming(timings, "routing.classifyMs", async () => { now += 40; throw new Error("boom"); }, clock)).rejects.toThrow("boom");
    expect(timings["routing.classifyMs"]).toBe(40);
  });

  it("is a no-op passthrough when no timings sink is given", async () => {
    await expect(withTiming(undefined, "x", async () => 7)).resolves.toBe(7);
  });
});
