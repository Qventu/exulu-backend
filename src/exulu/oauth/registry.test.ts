import type { ExuluOauthConfig } from "./types";
import { __resetOauthRegistryForTests, oauthRegistry } from "./registry";

const baseConfig: ExuluOauthConfig = {
  authorizationUrl: "https://auth.example/authorize",
  tokenUrl: "https://auth.example/token",
  clientId: "cid",
  clientSecret: "sec",
  scopes: ["read:a", "write:b"],
};

beforeEach(() => {
  __resetOauthRegistryForTests();
});

describe("oauthRegistry.register", () => {
  it("registers a config keyed by toolId when provider is absent", () => {
    oauthRegistry.register("solo_tool", baseConfig);
    expect(oauthRegistry.getByTool("solo_tool")).toBe(baseConfig);
    expect(oauthRegistry.getByProvider("solo_tool")).toBe(baseConfig);
  });

  it("registers a config keyed by provider when set", () => {
    const cfg = { ...baseConfig, provider: "jira" };
    oauthRegistry.register("jira_search", cfg);
    expect(oauthRegistry.getByProvider("jira")).toBe(cfg);
    expect(oauthRegistry.getByTool("jira_search")).toBe(cfg);
  });

  it("shares a registry entry between two tools with the same provider and identical config", () => {
    const cfg = { ...baseConfig, provider: "jira" };
    oauthRegistry.register("jira_search", cfg);
    oauthRegistry.register("jira_get", { ...cfg });
    expect(oauthRegistry.getByTool("jira_search")).toBeDefined();
    expect(oauthRegistry.getByTool("jira_get")).toBeDefined();
    expect(oauthRegistry.getByProvider("jira")).toBeDefined();
  });

  it("throws when a second tool on the same provider disagrees on clientId", () => {
    oauthRegistry.register("jira_search", { ...baseConfig, provider: "jira" });
    expect(() =>
      oauthRegistry.register("jira_get", {
        ...baseConfig,
        provider: "jira",
        clientId: "different",
      }),
    ).toThrow(/oauth\.clientId disagrees.*provider "jira"/);
  });

  it("throws when a second tool on the same provider disagrees on clientSecret", () => {
    oauthRegistry.register("jira_search", { ...baseConfig, provider: "jira" });
    expect(() =>
      oauthRegistry.register("jira_get", {
        ...baseConfig,
        provider: "jira",
        clientSecret: "different",
      }),
    ).toThrow(/oauth\.clientSecret disagrees/);
  });

  it("throws when a second tool on the same provider disagrees on authorizationUrl", () => {
    oauthRegistry.register("jira_search", { ...baseConfig, provider: "jira" });
    expect(() =>
      oauthRegistry.register("jira_get", {
        ...baseConfig,
        provider: "jira",
        authorizationUrl: "https://other.example/authorize",
      }),
    ).toThrow(/oauth\.authorizationUrl disagrees/);
  });

  it("throws when a second tool on the same provider disagrees on tokenUrl", () => {
    oauthRegistry.register("jira_search", { ...baseConfig, provider: "jira" });
    expect(() =>
      oauthRegistry.register("jira_get", {
        ...baseConfig,
        provider: "jira",
        tokenUrl: "https://other.example/token",
      }),
    ).toThrow(/oauth\.tokenUrl disagrees/);
  });

  it("throws when a second tool on the same provider declares a different scope set", () => {
    oauthRegistry.register("jira_search", { ...baseConfig, provider: "jira" });
    expect(() =>
      oauthRegistry.register("jira_get", {
        ...baseConfig,
        provider: "jira",
        scopes: ["read:a"],
      }),
    ).toThrow(/oauth\.scopes disagrees/);
  });

  it("scope comparison is order-insensitive", () => {
    oauthRegistry.register("jira_search", {
      ...baseConfig,
      provider: "jira",
      scopes: ["read:a", "write:b"],
    });
    expect(() =>
      oauthRegistry.register("jira_get", {
        ...baseConfig,
        provider: "jira",
        scopes: ["write:b", "read:a"],
      }),
    ).not.toThrow();
  });

  it("re-registering the same toolId with identical config is a no-op", () => {
    oauthRegistry.register("jira_search", { ...baseConfig, provider: "jira" });
    expect(() =>
      oauthRegistry.register("jira_search", { ...baseConfig, provider: "jira" }),
    ).not.toThrow();
  });


});
