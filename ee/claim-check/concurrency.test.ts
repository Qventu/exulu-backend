// ee/claim-check/concurrency.test.ts
import { mapWithConcurrency } from "./concurrency";

describe("mapWithConcurrency", () => {
  it("never exceeds the limit and preserves input order in the results", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const results = await mapWithConcurrency(items, 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
  });

  it("reports a rejection per item instead of failing the whole batch", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });

  it("returns an empty array for no items and treats a limit below 1 as 1", async () => {
    expect(await mapWithConcurrency([], 4, async (n) => n)).toEqual([]);
    const results = await mapWithConcurrency([1, 2], 0, async (n) => n);
    expect(results).toHaveLength(2);
  });
});
