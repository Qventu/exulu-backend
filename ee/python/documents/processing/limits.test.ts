import { ocrConcurrency, ocrLimiter, visionLimiter, PROCESS_WIDE_LIMIT } from "./limits";

describe("ocrConcurrency", () => {
  it("defaults to 3", () => {
    expect(ocrConcurrency(undefined)).toBe(3);
    expect(ocrConcurrency({})).toBe(3);
    expect(ocrConcurrency({ ocr: {} })).toBe(3);
  });
  it("reads documentProcessor.ocr.concurrency and clamps to 1..8", () => {
    expect(ocrConcurrency({ ocr: { concurrency: 5 } })).toBe(5);
    expect(ocrConcurrency({ ocr: { concurrency: 0 } })).toBe(1);
    expect(ocrConcurrency({ ocr: { concurrency: 99 } })).toBe(8);
    expect(ocrConcurrency({ ocr: { concurrency: 2.7 } })).toBe(3);
    expect(ocrConcurrency({ ocr: { concurrency: Number.NaN } })).toBe(3);
  });
});

describe("process-wide limiters", () => {
  it.each([["ocr", ocrLimiter], ["vision", visionLimiter]] as const)("%s limiter queues beyond 8 slots instead of refusing", async (_n, limiter) => {
    expect(PROCESS_WIDE_LIMIT).toBe(8);
    let running = 0;
    let max = 0;
    await Promise.all(
      Array.from({ length: 30 }, () =>
        limiter(async () => {
          running++;
          max = Math.max(max, running);
          await new Promise((r) => setTimeout(r, 5));
          running--;
        }),
      ),
    );
    expect(max).toBe(8);
  });
});
