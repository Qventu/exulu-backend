import type { ExuluOauthConfig } from "./types";

const mockGetValidAccessToken = jest.fn();
const mockBuildAuthorizationUrl = jest.fn();

jest.mock("./flow", () => ({
  getValidAccessToken: (...args: any[]) => mockGetValidAccessToken(...args),
  buildAuthorizationUrl: (...args: any[]) => mockBuildAuthorizationUrl(...args),
}));

import { wrapExecuteWithOauth } from "./wrap-execute";

const config: ExuluOauthConfig = {
  authorizationUrl: "https://provider.example.com/oauth/authorize",
  tokenUrl: "https://provider.example.com/oauth/token",
  clientId: "client-id",
  clientSecret: "client-secret",
  scopes: ["read:a"],
};

beforeEach(() => {
  jest.resetAllMocks();
});

describe("wrapExecuteWithOauth", () => {
  it("short-circuits without a user identity", async () => {
    const execute = jest.fn();
    const wrapped = wrapExecuteWithOauth("my_tool", config, execute);
    const response = await wrapped({ query: "x" });
    expect(response.result).toMatch(/signed-in user/);
    expect(execute).not.toHaveBeenCalled();
    expect(mockGetValidAccessToken).not.toHaveBeenCalled();
  });

  it("returns the authorization URL when no valid token exists", async () => {
    mockGetValidAccessToken.mockResolvedValue(null);
    mockBuildAuthorizationUrl.mockReturnValue("https://provider.example.com/authorize?state=abc");
    const execute = jest.fn();
    const wrapped = wrapExecuteWithOauth("my_tool", config, execute);

    const response = await wrapped({ query: "x", user: { id: 42 } });

    expect(mockGetValidAccessToken).toHaveBeenCalledWith({ providerKey: "my_tool", userId: 42, toolId: "my_tool", config });
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
    const wrapped = wrapExecuteWithOauth("my_tool", config, execute);

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
    const wrapped = wrapExecuteWithOauth("my_tool", config, generatorExecute);

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
    const wrapped = wrapExecuteWithOauth(
      "jira_search",
      {
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
