import type { ExuluAuthConfig, ExuluOauthConfig, ExuluUserCredentialsConfig } from "./types";

const mockGetValidAccessToken = jest.fn();
const mockBuildAuthorizationUrl = jest.fn();

jest.mock("./flow", () => ({
  getValidAccessToken: (...args: any[]) => mockGetValidAccessToken(...args),
  buildAuthorizationUrl: (...args: any[]) => mockBuildAuthorizationUrl(...args),
}));

const mockGetValidUserCredentials = jest.fn();
jest.mock("./state", () => ({
  getValidUserCredentials: (...args: any[]) => mockGetValidUserCredentials(...args),
}));

const mockCredentialStoreDelete = jest.fn();
jest.mock("./credential-store", () => ({
  credentialStore: {
    get: jest.fn(),
    upsert: jest.fn(),
    delete: (...args: any[]) => mockCredentialStoreDelete(...args),
  },
  // encrypt/decrypt are used by credentials-request — provide no-op stubs
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ""),
}));

import { wrapExecuteWithAuth } from "./wrap-execute";
import { CredentialInvalidError } from "./errors";

const config: ExuluOauthConfig = {
  authType: "oauth",
  provider: "test-provider",
  authorizationUrl: "https://provider.example.com/oauth/authorize",
  tokenUrl: "https://provider.example.com/oauth/token",
  clientId: "client-id",
  clientSecret: "client-secret",
  scopes: ["read:a"],
};

beforeEach(() => {
  jest.resetAllMocks();
});

describe("wrapExecuteWithAuth", () => {
  it("short-circuits without a user identity", async () => {
    const execute = jest.fn();
    const wrapped = wrapExecuteWithAuth("my_tool", config, execute);
    const response = await wrapped({ query: "x" });
    expect(response.result).toMatch(/signed-in user/);
    expect(execute).not.toHaveBeenCalled();
    expect(mockGetValidAccessToken).not.toHaveBeenCalled();
  });

  it("returns the authorization URL when no valid token exists", async () => {
    mockGetValidAccessToken.mockResolvedValue(null);
    mockBuildAuthorizationUrl.mockReturnValue("https://provider.example.com/authorize?state=abc");
    const execute = jest.fn();
    const wrapped = wrapExecuteWithAuth("my_tool", config, execute);

    const response = await wrapped({ query: "x", user: { id: 42 } });

    expect(mockGetValidAccessToken).toHaveBeenCalledWith({ providerKey: "test-provider", userId: 42, toolId: "my_tool", config });
    expect(response.oauth.authorizationUrl).toBe("https://provider.example.com/authorize?state=abc");
    expect(response.result).toContain("https://provider.example.com/authorize?state=abc");
    expect(execute).not.toHaveBeenCalled();
  });

  it("injects inputs.oauth and runs execute when a valid token exists", async () => {
    const expiresAt = new Date(Date.now() + 3600_000);
    mockGetValidAccessToken.mockResolvedValue({
      accessToken: "the-token",
      refreshToken: "refresh",
      scopes: "read:a",
      expiresAt,
    });
    const execute = jest.fn().mockResolvedValue({ result: "did the thing" });
    const wrapped = wrapExecuteWithAuth("my_tool", config, execute);

    const options = { toolCallId: "call-1" };
    const response = await wrapped({ query: "x", user: { id: 42 } }, options);

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "x",
        user: { id: 42 },
        oauth: { accessToken: "the-token", expiresAt, scopes: "read:a" },
      }),
      options,
    );
    expect(response).toEqual({ result: "did the thing" });
  });

  it("passes a generator-based execute's generator through unchanged", async () => {
    mockGetValidAccessToken.mockResolvedValue({ accessToken: "t", expiresAt: null, scopes: null });
    async function* generatorExecute() {
      yield { result: "chunk-1" };
      yield { result: "chunk-2" };
    }
    const wrapped = wrapExecuteWithAuth("my_tool", config, generatorExecute);

    const response = await wrapped({ user: { id: 1 } });
    const chunks = [];
    for await (const chunk of response) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([{ result: "chunk-1" }, { result: "chunk-2" }]);
  });

  it("uses config.provider as the token-store key when set", async () => {
    mockGetValidAccessToken.mockResolvedValueOnce({
      accessToken: "t",
      refreshToken: null,
      tokenType: "Bearer",
      scopes: null,
      expiresAt: null,
    });
    const inner = jest.fn().mockResolvedValue({ result: "ok" });
    const wrapped = wrapExecuteWithAuth(
      "jira_search",
      {
        authType: "oauth",
        provider: "jira",
        authorizationUrl: "https://auth.example/authorize",
        tokenUrl: "https://auth.example/token",
        clientId: "c",
        clientSecret: "s",
        scopes: [],
      },
      inner,
    );
    await wrapped({ user: { id: 3 }, x: 1 });
    expect(mockGetValidAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ providerKey: "jira", toolId: "jira_search" }),
    );
  });

});

const credentialsCfg: ExuluUserCredentialsConfig = {
  authType: "user_credentials",
  provider: "wrap-test",
  fields: [{ name: "k", label: "K", type: "password" }],
};

describe("wrapExecuteWithAuth — user_credentials branch", () => {
  beforeAll(() => {
    process.env.BACKEND = "http://x";
  });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("returns a friendly result when no signed-in user", async () => {
    const inner = jest.fn(async () => "ok");
    const wrapped = wrapExecuteWithAuth("t", credentialsCfg, inner);
    const out = await wrapped({}, undefined);
    expect(out.result).toMatch(/signed-in user/i);
    expect(inner).not.toHaveBeenCalled();
  });

  it("short-circuits with credentialRequest when no credentials stored", async () => {
    mockGetValidUserCredentials.mockResolvedValue(null);
    const inner = jest.fn(async () => "should-not-run");
    const wrapped = wrapExecuteWithAuth("t", credentialsCfg, inner);
    const out = await wrapped({ user: { id: 1 } }, undefined);
    expect(inner).not.toHaveBeenCalled();
    expect(out).toHaveProperty("credentialRequest.provider", "wrap-test");
  });

  it("injects credentials into inputs on cache hit", async () => {
    mockGetValidUserCredentials.mockResolvedValue({ k: "v" });
    let seenInputs: any;
    const inner = jest.fn(async (inputs: any) => { seenInputs = inputs; return "ok"; });
    const wrapped = wrapExecuteWithAuth("t", credentialsCfg, inner);
    const out = await wrapped({ user: { id: 1 }, extra: "x" }, undefined);
    expect(out).toBe("ok");
    expect(seenInputs.credentials).toEqual({ k: "v" });
    expect(seenInputs.extra).toBe("x");
  });

  it("re-prompts and deletes stored row on CredentialInvalidError for same provider", async () => {
    mockGetValidUserCredentials.mockResolvedValue({ k: "old" });
    mockCredentialStoreDelete.mockResolvedValue(undefined);
    const inner = jest.fn(async () => { throw new CredentialInvalidError("wrap-test", "401"); });
    const wrapped = wrapExecuteWithAuth("t", credentialsCfg, inner);
    const out = await wrapped({ user: { id: 1 } }, undefined);
    expect(out).toHaveProperty("credentialRequest.provider", "wrap-test");
    expect(mockCredentialStoreDelete).toHaveBeenCalledWith("wrap-test", 1);
  });

  it("rethrows CredentialInvalidError from a different provider (not swallowed)", async () => {
    mockGetValidUserCredentials.mockResolvedValue({ k: "v" });
    const inner = jest.fn(async () => { throw new CredentialInvalidError("other-provider", "401 from elsewhere"); });
    const wrapped = wrapExecuteWithAuth("t", credentialsCfg, inner);
    await expect(wrapped({ user: { id: 1 } }, undefined)).rejects.toThrow(CredentialInvalidError);
    await expect(wrapped({ user: { id: 1 } }, undefined)).rejects.toThrow(/other-provider/);
    // credentialStore.delete MUST NOT have been called — the error was for a different provider
    expect(mockCredentialStoreDelete).not.toHaveBeenCalled();
  });
});
