import { resolveBotIdentity } from "./bot-identity";

const settings = (over: Partial<Parameters<typeof resolveBotIdentity>[1]> = {}) => ({
  botName: "IMP Notetaker",
  notifyChat: true,
  recordersMayOverrideBot: true,
  ...over,
});

describe("resolveBotIdentity", () => {
  it("uses the workspace values when the request supplies none", () => {
    expect(resolveBotIdentity({}, settings())).toEqual({
      botName: "IMP Notetaker",
      notifyChat: true,
    });
  });

  it("a per-request name wins when recorders may override", () => {
    expect(resolveBotIdentity({ bot_name: "Standup bot" }, settings()).botName).toBe("Standup bot");
  });

  it("a per-request name is IGNORED when recorders may not override", () => {
    // Otherwise the setting would be advisory only, which is not a setting.
    expect(
      resolveBotIdentity({ bot_name: "Standup bot" }, settings({ recordersMayOverrideBot: false }))
        .botName,
    ).toBe("IMP Notetaker");
  });

  it("a per-request notify:false wins when recorders may override", () => {
    expect(resolveBotIdentity({ notify_chat: false }, settings()).notifyChat).toBe(false);
  });

  it("a per-request notify:false is IGNORED when they may not", () => {
    expect(
      resolveBotIdentity({ notify_chat: false }, settings({ recordersMayOverrideBot: false }))
        .notifyChat,
    ).toBe(true);
  });

  it("treats a blank or whitespace request name as absent", () => {
    expect(resolveBotIdentity({ bot_name: "   " }, settings()).botName).toBe("IMP Notetaker");
  });

  it("never emits the retired default", () => {
    expect(resolveBotIdentity({}, settings()).botName).not.toBe("Company Notetaker");
  });
});
