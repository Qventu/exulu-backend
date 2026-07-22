import type { ExuluAuthConfig } from "./types";
import { __resetAuthRegistryForTests, authRegistry } from "./registry";

const baseConfig: ExuluAuthConfig = {
  authType: "oauth",
  authorizationUrl: "https://auth.example/authorize",
  tokenUrl: "https://auth.example/token",
  clientId: "cid",
  clientSecret: "sec",
  scopes: ["read:a", "write:b"],
};

beforeEach(() => {
  __resetAuthRegistryForTests();
});

describe("authRegistry.register", () => {
  it("registers a config keyed by toolId when provider is absent", () => {
    authRegistry.register("solo_tool", baseConfig);
    expect(authRegistry.getByTool("solo_tool")).toBe(baseConfig);
    expect(authRegistry.getByProvider("solo_tool")).toBe(baseConfig);
  });

  it("registers a config keyed by provider when set", () => {
    const cfg: ExuluAuthConfig = { ...baseConfig, provider: "jira" };
    authRegistry.register("jira_search", cfg);
    expect(authRegistry.getByProvider("jira")).toBe(cfg);
    expect(authRegistry.getByTool("jira_search")).toBe(cfg);
  });

  it("shares a registry entry between two tools with the same provider and identical config", () => {
    const cfg: ExuluAuthConfig = { ...baseConfig, provider: "jira" };
    authRegistry.register("jira_search", cfg);
    authRegistry.register("jira_get", { ...cfg });
    expect(authRegistry.getByTool("jira_search")).toBeDefined();
    expect(authRegistry.getByTool("jira_get")).toBeDefined();
    expect(authRegistry.getByProvider("jira")).toBeDefined();
  });

  it("throws when a second tool on the same provider disagrees on clientId", () => {
    authRegistry.register("jira_search", { ...baseConfig, provider: "jira" });
    expect(() =>
      authRegistry.register("jira_get", {
        ...baseConfig,
        provider: "jira",
        clientId: "different",
      }),
    ).toThrow(/oauth\.clientId disagrees.*provider "jira"/);
  });

  it("throws when a second tool on the same provider disagrees on clientSecret", () => {
    authRegistry.register("jira_search", { ...baseConfig, provider: "jira" });
    expect(() =>
      authRegistry.register("jira_get", {
        ...baseConfig,
        provider: "jira",
        clientSecret: "different",
      }),
    ).toThrow(/oauth\.clientSecret disagrees/);
  });

  it("throws when a second tool on the same provider disagrees on authorizationUrl", () => {
    authRegistry.register("jira_search", { ...baseConfig, provider: "jira" });
    expect(() =>
      authRegistry.register("jira_get", {
        ...baseConfig,
        provider: "jira",
        authorizationUrl: "https://other.example/authorize",
      }),
    ).toThrow(/oauth\.authorizationUrl disagrees/);
  });

  it("throws when a second tool on the same provider disagrees on tokenUrl", () => {
    authRegistry.register("jira_search", { ...baseConfig, provider: "jira" });
    expect(() =>
      authRegistry.register("jira_get", {
        ...baseConfig,
        provider: "jira",
        tokenUrl: "https://other.example/token",
      }),
    ).toThrow(/oauth\.tokenUrl disagrees/);
  });

  it("throws when a second tool on the same provider declares a different scope set", () => {
    authRegistry.register("jira_search", { ...baseConfig, provider: "jira" });
    expect(() =>
      authRegistry.register("jira_get", {
        ...baseConfig,
        provider: "jira",
        scopes: ["read:a"],
      }),
    ).toThrow(/oauth\.scopes disagrees/);
  });

  it("scope comparison is order-insensitive", () => {
    authRegistry.register("jira_search", {
      ...baseConfig,
      provider: "jira",
      scopes: ["read:a", "write:b"],
    });
    expect(() =>
      authRegistry.register("jira_get", {
        ...baseConfig,
        provider: "jira",
        scopes: ["write:b", "read:a"],
      }),
    ).not.toThrow();
  });

  it("re-registering the same toolId with identical config is a no-op", () => {
    authRegistry.register("jira_search", { ...baseConfig, provider: "jira" });
    expect(() =>
      authRegistry.register("jira_search", { ...baseConfig, provider: "jira" }),
    ).not.toThrow();
  });

  // user_credentials: two tools sharing a provider with identical fields
  it("shares a registry entry between two user_credentials tools with the same provider and identical fields", () => {
    const fields = [{ name: "api_key", label: "API Key", type: "password" as const }];
    const cfg1: ExuluAuthConfig = { authType: "user_credentials", provider: "moco", fields };
    const cfg2: ExuluAuthConfig = { authType: "user_credentials", provider: "moco", fields: [...fields] };
    authRegistry.register("moco_projects", cfg1);
    authRegistry.register("moco_activities", cfg2);
    expect(authRegistry.getByTool("moco_projects")).toBe(cfg1);
    expect(authRegistry.getByTool("moco_activities")).toBe(cfg1); // shared entry — returns first registered
    expect(authRegistry.getByProvider("moco")).toBe(cfg1);
  });

  it("throws when a user_credentials tool registers with different fields than the existing provider entry", () => {
    const fields = [{ name: "api_key", label: "API Key", type: "password" as const }];
    authRegistry.register("moco_projects", { authType: "user_credentials", provider: "moco", fields });
    expect(() =>
      authRegistry.register("moco_extra", {
        authType: "user_credentials",
        provider: "moco",
        fields: [{ name: "api_key", label: "API Key", type: "password" }, { name: "subdomain", label: "Subdomain", type: "text" }],
      }),
    ).toThrow(/user_credentials\.fields disagrees.*provider "moco"/);
  });

  // authType mismatch: one oauth, one user_credentials on the same provider
  it("throws when two tools on the same provider disagree on authType", () => {
    authRegistry.register("shared_oauth", { ...baseConfig, provider: "mixed_provider" });
    expect(() =>
      authRegistry.register("shared_creds", {
        authType: "user_credentials",
        provider: "mixed_provider",
        fields: [{ name: "key", label: "Key", type: "password" }],
      }),
    ).toThrow(/auth\.authType 'user_credentials' disagrees.*authType 'oauth'/);
  });
});
