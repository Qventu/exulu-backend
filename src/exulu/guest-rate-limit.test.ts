import {
  extractClientIp,
  guestMessageTooLong,
  guestRateLimitExceeded,
  guestRateLimitMapSize,
  resetGuestRateLimit,
} from "./guest-rate-limit";

describe("guestRateLimitExceeded", () => {
  beforeEach(() => resetGuestRateLimit());

  test("allows up to the per-minute limit, then rejects", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) {
      expect(guestRateLimitExceeded("1.2.3.4", t0 + i)).toBe(false);
    }
    expect(guestRateLimitExceeded("1.2.3.4", t0 + 11)).toBe(true);
  });

  test("windows are per-IP", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) guestRateLimitExceeded("1.1.1.1", t0);
    expect(guestRateLimitExceeded("2.2.2.2", t0)).toBe(false);
  });

  test("minute window resets after 60s", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) guestRateLimitExceeded("1.2.3.4", t0);
    expect(guestRateLimitExceeded("1.2.3.4", t0 + 61_000)).toBe(false);
  });

  test("hourly limit still applies after minute resets", () => {
    let t = 1_000_000;
    // 60 allowed calls spread over 6 minute-windows (10 each).
    for (let w = 0; w < 6; w++) {
      for (let i = 0; i < 10; i++) {
        expect(guestRateLimitExceeded("1.2.3.4", t)).toBe(false);
      }
      t += 61_000;
    }
    // 61st within the hour → hourly limit exceeded.
    expect(guestRateLimitExceeded("1.2.3.4", t)).toBe(true);
  });
});

describe("guestMessageTooLong", () => {
  const part = (text: string) => ({ type: "text", text });

  test("accepts a normal message", () => {
    expect(
      guestMessageTooLong({ message: { parts: [part("hello")] } }),
    ).toBe(false);
  });

  test("rejects an over-cap text part in message", () => {
    expect(
      guestMessageTooLong({ message: { parts: [part("x".repeat(8001))] } }),
    ).toBe(true);
  });

  test("rejects an over-cap part anywhere in messages[]", () => {
    expect(
      guestMessageTooLong({
        messages: [
          { parts: [part("fine")] },
          { parts: [part("y".repeat(9000))] },
        ],
      }),
    ).toBe(true);
  });

  test("null/malformed bodies are not 'too long'", () => {
    expect(guestMessageTooLong(null)).toBe(false);
    expect(guestMessageTooLong({})).toBe(false);
  });

  test("rejects when many small parts exceed the cumulative total-chars cap", () => {
    // 4 messages × 1 part × 9000 chars = 36000 > 32000 default
    const manyMessages = Array.from({ length: 4 }, () => ({
      parts: [part("z".repeat(9000))],
    }));
    expect(guestMessageTooLong({ messages: manyMessages })).toBe(true);
  });

  test("accepts many small parts that stay within the cumulative cap", () => {
    // 3 messages × 1 part × 9000 chars = 27000 < 32000, each part < 8000? No —
    // each part is 9000 which already exceeds the per-part cap.
    // Use 5 parts × 6000 chars = 30000 < 32000 and each part < 8000.
    const manyMessages = Array.from({ length: 5 }, () => ({
      parts: [part("a".repeat(6000))],
    }));
    expect(guestMessageTooLong({ messages: manyMessages })).toBe(false);
  });

  test("rejects a part-count bomb (>100 parts)", () => {
    // 101 parts each with 1 char — total chars well within cap, but count over 100
    const parts = Array.from({ length: 101 }, () => part("x"));
    expect(guestMessageTooLong({ message: { parts } })).toBe(true);
  });

  test("accepts exactly 100 parts", () => {
    const parts = Array.from({ length: 100 }, () => part("x"));
    expect(guestMessageTooLong({ message: { parts } })).toBe(false);
  });
});

describe("extractClientIp", () => {
  const origEnv = process.env.EXULU_TRUST_PROXY;

  afterEach(() => {
    // Restore env after each test.
    if (origEnv === undefined) {
      delete process.env.EXULU_TRUST_PROXY;
    } else {
      process.env.EXULU_TRUST_PROXY = origEnv;
    }
  });

  test("ignores x-forwarded-for by default (spoofable)", () => {
    delete process.env.EXULU_TRUST_PROXY;
    // XFF present but trust proxy not set → falls back to req.ip
    expect(
      extractClientIp({ headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" }, ip: "5.5.5.5" }),
    ).toBe("5.5.5.5");
  });

  test("ignores x-forwarded-for when EXULU_TRUST_PROXY is not 'true'", () => {
    process.env.EXULU_TRUST_PROXY = "false";
    expect(
      extractClientIp({ headers: { "x-forwarded-for": "9.9.9.9" }, ip: "1.2.3.4" }),
    ).toBe("1.2.3.4");
  });

  test("uses LAST x-forwarded-for entry when EXULU_TRUST_PROXY=true", () => {
    process.env.EXULU_TRUST_PROXY = "true";
    expect(
      extractClientIp({ headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" } }),
    ).toBe("10.0.0.1");
  });

  test("uses single XFF entry when EXULU_TRUST_PROXY=true", () => {
    process.env.EXULU_TRUST_PROXY = "true";
    expect(
      extractClientIp({ headers: { "x-forwarded-for": "7.7.7.7" } }),
    ).toBe("7.7.7.7");
  });

  test("falls back to req.ip then socket when EXULU_TRUST_PROXY=true and no XFF", () => {
    process.env.EXULU_TRUST_PROXY = "true";
    expect(extractClientIp({ headers: {}, ip: "5.5.5.5" })).toBe("5.5.5.5");
    expect(
      extractClientIp({ headers: {}, socket: { remoteAddress: "6.6.6.6" } }),
    ).toBe("6.6.6.6");
    expect(extractClientIp({ headers: {} })).toBe("unknown");
  });

  test("falls back to req.ip then socket when trust proxy disabled", () => {
    delete process.env.EXULU_TRUST_PROXY;
    expect(extractClientIp({ headers: {}, ip: "5.5.5.5" })).toBe("5.5.5.5");
    expect(
      extractClientIp({ headers: {}, socket: { remoteAddress: "6.6.6.6" } }),
    ).toBe("6.6.6.6");
    expect(extractClientIp({ headers: {} })).toBe("unknown");
  });
});

describe("guestRateLimitMapSize / hard cap eviction", () => {
  beforeEach(() => resetGuestRateLimit());

  test("hard cap evicts oldest entries when stale-prune leaves map over 10_000", () => {
    // Fill just above 10_000 entries with distinct IPs at t=1000 (all "active").
    const t0 = 1_000_000;
    for (let i = 0; i < 10_001; i++) {
      guestRateLimitExceeded(`192.168.${Math.floor(i / 256)}.${i % 256}`, t0 + i);
    }
    // All entries are recent so stale-prune won't remove any of them.
    // Trigger the hard cap by adding one more entry (which re-runs the prune).
    guestRateLimitExceeded("10.0.0.1", t0 + 20_000);
    // Map must be at or under the cap.
    expect(guestRateLimitMapSize()).toBeLessThanOrEqual(10_000);
  });
});
