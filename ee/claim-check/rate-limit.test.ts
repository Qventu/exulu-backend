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
