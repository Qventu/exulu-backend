import {
  MAX_FILTER_PATTERN_LENGTH,
  generateTriggerSecret,
  generateSigningSecret,
  validateEmailTriggerConfig,
} from "./trigger-config";

describe("generateTriggerSecret", () => {
  it("produces a URL-safe ~43-char base64url string, unique per call", () => {
    const a = generateTriggerSecret();
    const b = generateTriggerSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes -> 43 base64url chars
    expect(a).not.toEqual(b);
  });
  it("generateSigningSecret has the same shape", () => {
    expect(generateSigningSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("validateEmailTriggerConfig", () => {
  it("accepts a full valid config and normalizes senders to lowercase", () => {
    const config = validateEmailTriggerConfig({
      allowed_senders: ["Service@KONE.com", "*@kone.com"],
      filters: [{ field: "subject", pattern: "Ersatzteil|spare part" }],
      filtered_run_retention: 200,
      rate_limit_per_hour: 60,
      sender_rate_limit_per_hour: 10,
    });
    expect(config.allowed_senders).toEqual(["service@kone.com", "*@kone.com"]);
    expect(config.filters).toEqual([{ field: "subject", pattern: "Ersatzteil|spare part" }]);
    expect(config.filtered_run_retention).toBe(200);
  });

  it("accepts an empty object (all fields optional)", () => {
    expect(validateEmailTriggerConfig({})).toEqual({});
  });

  it("rejects non-object configs", () => {
    expect(() => validateEmailTriggerConfig(null)).toThrow(/JSON object/);
    expect(() => validateEmailTriggerConfig([1])).toThrow(/JSON object/);
  });

  it("rejects allowlist entries that are not address-shaped", () => {
    expect(() => validateEmailTriggerConfig({ allowed_senders: ["not-an-address"] })).toThrow(
      /allowed_senders/,
    );
    expect(() => validateEmailTriggerConfig({ allowed_senders: [42] })).toThrow(
      /allowed_senders/,
    );
  });

  it("rejects unknown filter fields", () => {
    expect(() =>
      validateEmailTriggerConfig({ filters: [{ field: "headers", pattern: "x" }] }),
    ).toThrow(/filter field/);
  });

  it("rejects patterns over the 200 character cap", () => {
    expect(() =>
      validateEmailTriggerConfig({
        filters: [{ field: "subject", pattern: "a".repeat(MAX_FILTER_PATTERN_LENGTH + 1) }],
      }),
    ).toThrow(/200/);
  });

  it("rejects syntactically invalid regexes", () => {
    expect(() =>
      validateEmailTriggerConfig({ filters: [{ field: "subject", pattern: "(" }] }),
    ).toThrow(/Invalid regex/);
  });

  it("rejects ReDoS-prone regexes via safe-regex", () => {
    expect(() =>
      validateEmailTriggerConfig({ filters: [{ field: "body", pattern: "(a+)+$" }] }),
    ).toThrow(/Unsafe regex/);
  });

  it("validates limits: rates strictly positive, retention non-negative (0 = keep none)", () => {
    expect(() => validateEmailTriggerConfig({ rate_limit_per_hour: 0 })).toThrow(/positive/);
    expect(() => validateEmailTriggerConfig({ filtered_run_retention: 1.5 })).toThrow(/integer/);
    expect(() => validateEmailTriggerConfig({ filtered_run_retention: -1 })).toThrow(/integer/);
    expect(() => validateEmailTriggerConfig({ sender_rate_limit_per_hour: "10" })).toThrow(/positive/);
    expect(validateEmailTriggerConfig({ filtered_run_retention: 0 })).toEqual({
      filtered_run_retention: 0,
    });
  });
});
