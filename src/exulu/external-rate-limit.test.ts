import {
  externalRateLimitExceeded,
  externalRateLimitMapSize,
  isExternalUser,
  resetExternalRateLimit,
} from "./external-rate-limit";
import type { User } from "@EXULU_TYPES/models/user";

describe("externalRateLimitExceeded", () => {
  beforeEach(() => resetExternalRateLimit());

  test("allows up to the per-minute limit, then rejects", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 30; i++) {
      expect(externalRateLimitExceeded("user-123", t0 + i)).toBe(false);
    }
    expect(externalRateLimitExceeded("user-123", t0 + 31)).toBe(true);
  });

  test("windows are per-user-id", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 30; i++) externalRateLimitExceeded("user-1", t0);
    expect(externalRateLimitExceeded("user-2", t0)).toBe(false);
  });

  test("minute window resets after 60s", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 30; i++) externalRateLimitExceeded("user-123", t0);
    expect(externalRateLimitExceeded("user-123", t0 + 61_000)).toBe(false);
  });

  test("hourly limit still applies after minute resets", () => {
    let t = 1_000_000;
    // 300 allowed calls spread over 10 minute-windows (30 each).
    for (let w = 0; w < 10; w++) {
      for (let i = 0; i < 30; i++) {
        expect(externalRateLimitExceeded("user-123", t)).toBe(false);
      }
      t += 61_000;
    }
    // 301st within the hour → hourly limit exceeded.
    expect(externalRateLimitExceeded("user-123", t)).toBe(true);
  });
});

describe("isExternalUser", () => {
  test("returns true for external role", () => {
    const user: User = {
      id: 1,
      email: "external@example.com",
      role: { id: "role-1", name: "external", agents: "read", evals: "read", workflows: "read", variables: "read", users: "read" },
    };
    expect(isExternalUser(user)).toBe(true);
  });

  test("returns false for non-external role", () => {
    const user: User = {
      id: 1,
      email: "admin@example.com",
      role: { id: "role-2", name: "admin", agents: "write", evals: "write", workflows: "write", variables: "write", users: "write" },
    };
    expect(isExternalUser(user)).toBe(false);
  });

  test("returns false for null/undefined user", () => {
    expect(isExternalUser(null)).toBe(false);
    expect(isExternalUser(undefined)).toBe(false);
  });

  test("returns false for user without role", () => {
    const user: Partial<User> = {
      id: 1,
      email: "user@example.com",
    };
    expect(isExternalUser(user as User)).toBe(false);
  });
});

describe("env-var configuration", () => {
  const origPerMinute = process.env.EXULU_EXTERNAL_RATE_PER_MINUTE;
  const origPerHour = process.env.EXULU_EXTERNAL_RATE_PER_HOUR;

  afterEach(() => {
    if (origPerMinute === undefined) {
      delete process.env.EXULU_EXTERNAL_RATE_PER_MINUTE;
    } else {
      process.env.EXULU_EXTERNAL_RATE_PER_MINUTE = origPerMinute;
    }
    if (origPerHour === undefined) {
      delete process.env.EXULU_EXTERNAL_RATE_PER_HOUR;
    } else {
      process.env.EXULU_EXTERNAL_RATE_PER_HOUR = origPerHour;
    }
    resetExternalRateLimit();
  });

  test("uses default per-minute limit when env var not set", () => {
    delete process.env.EXULU_EXTERNAL_RATE_PER_MINUTE;
    resetExternalRateLimit();
    const t0 = 1_000_000;
    // Default is 30; allow 30, reject 31st
    for (let i = 0; i < 30; i++) {
      expect(externalRateLimitExceeded("user-123", t0 + i)).toBe(false);
    }
    expect(externalRateLimitExceeded("user-123", t0 + 31)).toBe(true);
  });

  test("respects custom per-minute limit from env var", () => {
    process.env.EXULU_EXTERNAL_RATE_PER_MINUTE = "5";
    resetExternalRateLimit();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(externalRateLimitExceeded("user-123", t0 + i)).toBe(false);
    }
    expect(externalRateLimitExceeded("user-123", t0 + 6)).toBe(true);
  });

  test("uses default per-hour limit when env var not set", () => {
    delete process.env.EXULU_EXTERNAL_RATE_PER_HOUR;
    resetExternalRateLimit();
    let t = 1_000_000;
    // Default is 300; spread over 10 windows of 30 each
    for (let w = 0; w < 10; w++) {
      for (let i = 0; i < 30; i++) {
        expect(externalRateLimitExceeded("user-123", t)).toBe(false);
      }
      t += 61_000;
    }
    expect(externalRateLimitExceeded("user-123", t)).toBe(true);
  });

  test("respects custom per-hour limit from env var", () => {
    process.env.EXULU_EXTERNAL_RATE_PER_HOUR = "60";
    resetExternalRateLimit();
    let t = 1_000_000;
    // Spread 60 calls over 2 minute-windows
    for (let w = 0; w < 2; w++) {
      for (let i = 0; i < 30; i++) {
        expect(externalRateLimitExceeded("user-123", t)).toBe(false);
      }
      t += 61_000;
    }
    expect(externalRateLimitExceeded("user-123", t)).toBe(true);
  });
});

describe("externalRateLimitMapSize / hard cap eviction", () => {
  beforeEach(() => resetExternalRateLimit());

  test("hard cap evicts oldest entries when stale-prune leaves map over 10_000", () => {
    const t0 = 1_000_000;
    // Fill just above 10_000 entries with distinct user IDs at t=1000 (all "active").
    for (let i = 0; i < 10_001; i++) {
      externalRateLimitExceeded(`user-${i}`, t0 + i);
    }
    // All entries are recent so stale-prune won't remove any of them.
    // Trigger the hard cap by adding one more entry (which re-runs the prune).
    externalRateLimitExceeded("user-latest", t0 + 20_000);
    // Map must be at or under the cap.
    expect(externalRateLimitMapSize()).toBeLessThanOrEqual(10_000);
  });
});
