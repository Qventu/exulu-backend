process.env.NEXTAUTH_SECRET = "test-secret";

import {
  ChannelConfigError,
  canEnableChannel,
  channelView,
  linkPageUrl,
  maskIdentity,
  parseChannelConfig,
  readSecrets,
  sealSecrets,
} from "./config";
import type { AgentChannelRow } from "./types";

const base = { phoneNumberId: "1", displayNumber: "+49 30 1" };
const row: AgentChannelRow = {
  id: "c1",
  agent: "a1",
  type: "whatsapp",
  enabled: true,
  config: base,
  secrets: null,
  verify_token: null,
  updatedAt: new Date(),
};

describe("parseChannelConfig", () => {
  it("applies the defaults", () => {
    expect(parseChannelConfig(base)).toMatchObject({
      linkTtlDays: 7,
      sessionIdleHours: 8,
      locale: "de",
      texts: {},
    });
  });
  it("accepts a JSON string", () => {
    expect(parseChannelConfig('{"phoneNumberId":"1","displayNumber":"+1"}').linkTtlDays).toBe(7);
  });
  it.each([[0], [366], [1.5], ["7"]])("rejects linkTtlDays %p", (v) => {
    expect(() => parseChannelConfig({ ...base, linkTtlDays: v })).toThrow(ChannelConfigError);
  });
  it.each([[0], [169], [2.5], ["8"]])("rejects sessionIdleHours %p", (v) => {
    expect(() => parseChannelConfig({ ...base, sessionIdleHours: v })).toThrow(ChannelConfigError);
  });
  it("accepts the bounds", () => {
    expect(parseChannelConfig({ ...base, linkTtlDays: 365, sessionIdleHours: 1, locale: "en" }))
      .toMatchObject({ linkTtlDays: 365, sessionIdleHours: 1, locale: "en" });
  });
  it("rejects a missing phoneNumberId, an unknown locale, and an unknown text key", () => {
    expect(() => parseChannelConfig({ displayNumber: "+1" })).toThrow(ChannelConfigError);
    expect(() => parseChannelConfig({ ...base, locale: "fr" })).toThrow(ChannelConfigError);
    expect(() => parseChannelConfig({ ...base, texts: { bogus: "x" } })).toThrow(ChannelConfigError);
  });
  it("keeps known text overrides and reports the failing field", () => {
    expect(parseChannelConfig({ ...base, texts: { linked: "ok" } }).texts).toEqual({ linked: "ok" });
    try {
      parseChannelConfig({ ...base, locale: "fr" });
    } catch (e) {
      expect((e as ChannelConfigError).field).toBe("locale");
    }
  });
});

describe("secrets", () => {
  it("readSecrets returns null for garbage instead of throwing", () => {
    expect(readSecrets({ ...row, secrets: "not-encrypted" })).toBeNull();
    expect(readSecrets({ ...row, secrets: null })).toBeNull();
  });
  it("seal/read round-trips", () => {
    expect(
      readSecrets({ ...row, secrets: sealSecrets({ accessToken: "a", appSecret: "b" }) }),
    ).toEqual({ accessToken: "a", appSecret: "b" });
  });
});

describe("channelView", () => {
  it("never carries secrets or the verify token", () => {
    const json = JSON.stringify(
      channelView({
        ...row,
        secrets: sealSecrets({ accessToken: "TOKEN", appSecret: "SECRET" }),
        verify_token: "VT",
      }),
    );
    expect(json).not.toMatch(/TOKEN|SECRET|VT/);
  });
  it("needsCredentials when secrets are missing or unreadable", () => {
    expect(channelView({ ...row, secrets: null })).toMatchObject({
      hasSecrets: false,
      needsCredentials: true,
    });
    expect(channelView({ ...row, secrets: "garbage" }).needsCredentials).toBe(true);
    expect(
      channelView({ ...row, secrets: sealSecrets({ accessToken: "a", appSecret: "b" }) }),
    ).toMatchObject({ hasSecrets: true, needsCredentials: false });
  });
});

it("canEnableChannel only for guest access in regular mode", () => {
  expect(canEnableChannel({ guest_access: true, guest_auth_mode: "regular" })).toEqual({ ok: true });
  expect(canEnableChannel({ guest_access: false, guest_auth_mode: "regular" })).toEqual({
    ok: false,
    reason: "guest_access_off",
  });
  expect(canEnableChannel({ guest_access: true, guest_auth_mode: "public" })).toEqual({
    ok: false,
    reason: "guest_mode_not_regular",
  });
  expect(canEnableChannel({ guest_access: true, guest_auth_mode: null })).toEqual({ ok: true });
});

it("maskIdentity shows only the last four characters", () => {
  expect(maskIdentity("4915112345678")).toMatch(/5678$/);
  expect(maskIdentity("4915112345678")).not.toContain("49151");
  expect(maskIdentity("ab")).not.toContain("ab");
});

describe("linkPageUrl", () => {
  const original = { link: process.env.CHANNEL_LINK_BASE_URL, auth: process.env.NEXTAUTH_URL };
  const set = (link?: string, auth?: string) => {
    if (link === undefined) delete process.env.CHANNEL_LINK_BASE_URL;
    else process.env.CHANNEL_LINK_BASE_URL = link;
    if (auth === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = auth;
  };
  afterEach(() => set(original.link, original.auth));

  it("uses CHANNEL_LINK_BASE_URL (the customer hostname) when set", () => {
    set("https://kunden.example.de//", "https://newton.example.de");
    expect(linkPageUrl("agent-1")).toBe("https://kunden.example.de/public/agents/agent-1/link/whatsapp");
  });

  it("falls back to NEXTAUTH_URL, trailing slash trimmed, agent id encoded", () => {
    set(undefined, "https://newton.example.de/");
    expect(linkPageUrl("a b")).toBe("https://newton.example.de/public/agents/a%20b/link/whatsapp");
  });

  it("throws naming both variables when neither is set", () => {
    set(undefined, undefined);
    expect(() => linkPageUrl("agent-1")).toThrow(/CHANNEL_LINK_BASE_URL.*NEXTAUTH_URL/);
    set("", "  ");
    expect(() => linkPageUrl("agent-1")).toThrow(/CHANNEL_LINK_BASE_URL.*NEXTAUTH_URL/);
  });
});
