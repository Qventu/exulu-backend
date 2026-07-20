import {
  extractClientIp,
  guestMessageTooLong,
  guestRateLimitExceeded,
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
});

describe("extractClientIp", () => {
  test("prefers first x-forwarded-for entry", () => {
    expect(
      extractClientIp({ headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" } }),
    ).toBe("9.9.9.9");
  });
  test("falls back to req.ip then socket", () => {
    expect(extractClientIp({ headers: {}, ip: "5.5.5.5" })).toBe("5.5.5.5");
    expect(
      extractClientIp({ headers: {}, socket: { remoteAddress: "6.6.6.6" } }),
    ).toBe("6.6.6.6");
    expect(extractClientIp({ headers: {} })).toBe("unknown");
  });
});
