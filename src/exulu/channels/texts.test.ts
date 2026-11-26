import { replyText } from "./texts";
import { REPLY_KEYS, type WhatsAppChannelConfig } from "./types";

const config = (over: Partial<WhatsAppChannelConfig> = {}): WhatsAppChannelConfig => ({
  phoneNumberId: "1",
  displayNumber: "+49 1",
  linkTtlDays: 7,
  sessionIdleHours: 8,
  locale: "de",
  texts: {},
  ...over,
});

describe("replyText", () => {
  it.each(["de", "en"] as const)("has a non-empty default for every key in %s", (locale) => {
    for (const key of REPLY_KEYS) {
      const text = replyText(key, config({ locale }));
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThan(400);
    }
  });

  it("differs between de and en", () => {
    expect(replyText("textOnly", config({ locale: "de" }))).not.toBe(
      replyText("textOnly", config({ locale: "en" })),
    );
  });

  it("puts the link url into linkRequired", () => {
    const url = "https://app.example/public/agents/1/link/whatsapp";
    expect(replyText("linkRequired", config(), { linkUrl: url })).toContain(url);
    expect(replyText("linkRequired", config({ locale: "en" }), { linkUrl: url })).toContain(url);
  });

  it("formats the expiry per locale, in UTC", () => {
    const expiresAt = new Date("2026-11-23T23:30:00Z");
    expect(replyText("linked", config(), { expiresAt })).toContain("23.11.2026");
    expect(replyText("linked", config({ locale: "en" }), { expiresAt })).toContain("2026-11-23");
  });

  it("lets an override win and substitutes placeholders in it", () => {
    const text = replyText("linked", config({ texts: { linked: "Bis {expiresAt}, {linkUrl}" } }), {
      linkUrl: "u",
      expiresAt: new Date("2026-01-05T00:00:00Z"),
    });
    expect(text).toBe("Bis 05.01.2026, u");
  });

  it("falls back to the default for an empty override", () => {
    expect(replyText("textOnly", config({ texts: { textOnly: "" } }))).toBe(
      replyText("textOnly", config()),
    );
  });

  it("leaves unknown placeholders as typed", () => {
    expect(replyText("textOnly", config({ texts: { textOnly: "Hi {name}" } }))).toBe("Hi {name}");
  });

  it("leaves a placeholder as typed when its variable is not given", () => {
    expect(replyText("textOnly", config({ texts: { textOnly: "{linkUrl}" } }))).toBe("{linkUrl}");
  });
});
