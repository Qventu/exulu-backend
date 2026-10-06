import { parseSettingsInput } from "./transcripts-settings-input";

describe("parseSettingsInput", () => {
  it("parses a numeric retention string to a number", () => {
    expect(parseSettingsInput({ videoRetentionHours: "720" }).videoRetentionHours).toBe(720);
  });

  it('keeps the "forever" sentinel verbatim', () => {
    expect(parseSettingsInput({ videoRetentionHours: "forever" }).videoRetentionHours).toBe("forever");
  });

  it('keeps the "none" cap sentinel verbatim', () => {
    expect(parseSettingsInput({ monthlyRecordingLimitMinutes: "none" }).monthlyRecordingLimitMinutes).toBe("none");
  });

  it("passes null through as a clear", () => {
    expect(parseSettingsInput({ videoRetentionHours: null }).videoRetentionHours).toBeNull();
  });

  it("refuses a value that is neither numeric nor the sentinel", () => {
    // Storing garbage here would resolve to a nonsense retention silently.
    expect(() => parseSettingsInput({ videoRetentionHours: "soon" })).toThrow(/videoRetentionHours/);
  });

  it("refuses a negative retention", () => {
    expect(() => parseSettingsInput({ videoRetentionHours: "-5" })).toThrow(/videoRetentionHours/);
  });

  it("leaves untouched fields absent rather than nulling them", () => {
    // A section saving only its own fields must not clear the others.
    expect("botName" in parseSettingsInput({ notifyChat: false })).toBe(false);
  });
});
