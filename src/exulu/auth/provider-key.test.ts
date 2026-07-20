import type { ExuluOauthConfig } from "./types";
import { providerKeyFor } from "./provider-key";

const baseConfig: ExuluOauthConfig = {
  authorizationUrl: "https://p.example/authorize",
  tokenUrl: "https://p.example/token",
  clientId: "cid",
  clientSecret: "sec",
  scopes: [],
};

describe("providerKeyFor", () => {
  it("returns config.provider when set", () => {
    expect(providerKeyFor("some_tool", { ...baseConfig, provider: "acme" })).toBe("acme");
  });

  it("falls back to toolId when provider is undefined", () => {
    expect(providerKeyFor("google_calendar", baseConfig)).toBe("google_calendar");
  });

  it("falls back to toolId when provider is an empty string", () => {
    expect(providerKeyFor("google_calendar", { ...baseConfig, provider: "" })).toBe("google_calendar");
  });
});
