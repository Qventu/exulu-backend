import {
  MAX_FILTER_PATTERN_LENGTH,
  generateTriggerAddress,
  slugifyRoutineName,
  validateEmailTriggerConfig,
} from "./trigger-config";

describe("slugifyRoutineName", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slugifyRoutineName("Spare Parts Handler!")).toBe("spare-parts-handler");
  });
  it("falls back to 'routine' when nothing survives", () => {
    expect(slugifyRoutineName("!!! ???")).toBe("routine");
  });
  it("caps the slug at 30 characters without a trailing dash", () => {
    const slug = slugifyRoutineName("a".repeat(28) + " tail that gets cut");
    expect(slug.length).toBeLessThanOrEqual(30);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("generateTriggerAddress", () => {
  it("produces <slug>-<8 hex>@<domain>", () => {
    const address = generateTriggerAddress("Spare Parts Handler", "mail.client.com");
    expect(address).toMatch(/^spare-parts-handler-[0-9a-f]{8}@mail\.client\.com$/);
  });
  it("randomizes the suffix", () => {
    const a = generateTriggerAddress("X routine", "mail.client.com");
    const b = generateTriggerAddress("X routine", "mail.client.com");
    expect(a).not.toBe(b);
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
