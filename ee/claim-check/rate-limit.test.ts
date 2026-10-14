// ee/claim-check/rate-limit.test.ts
import { claimCheckRateLimiter } from "./rate-limit";

describe("claimCheckRateLimiter", () => {
  it("allows up to the per-minute budget per user and then refuses", () => {
    const limiter = claimCheckRateLimiter({ perMinute: 2, perHour: 100, maxInFlight: 10 });
    expect(limiter.take("u1").ok).toBe(true);
    limiter.release();
    expect(limiter.take("u1").ok).toBe(true);
    limiter.release();
    const third = limiter.take("u1");
    expect(third.ok).toBe(false);
    expect(third.reason).toContain("per-minute");
    // A different user has their own budget.
    expect(limiter.take("u2").ok).toBe(true);
  });

  // Finding 8: the per-user map used to grow for the lifetime of the process.
  // external-rate-limit.ts prunes and hard-caps at 10,000; so does this one.
  it("bounds the tracked-user map, evicting the least recently seen", () => {
    const limiter = claimCheckRateLimiter({ perMinute: 100, perHour: 1000, maxInFlight: 100_000 });
    for (let i = 0; i < 10_050; i += 1) {
      limiter.take(`u${i}`);
      limiter.release();
    }
    expect(limiter.trackedUsers()).toBeLessThanOrEqual(10_000);
    // The most recent users survived; the oldest were evicted.
    expect(limiter.take("u10049").ok).toBe(true);
  });

  it("refuses when the global in-flight cap is reached and recovers after release", () => {
    const limiter = claimCheckRateLimiter({ perMinute: 100, perHour: 100, maxInFlight: 1 });
    expect(limiter.take("u1").ok).toBe(true);
    const blocked = limiter.take("u2");
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toContain("in flight");
    limiter.release();
    expect(limiter.take("u2").ok).toBe(true);
  });
});
