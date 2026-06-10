import { createHash } from "node:crypto";
import type { ExuluOauthConfig } from "./types";

const mockTokenStore = {
  get: jest.fn(),
  upsert: jest.fn(),
  delete: jest.fn(),
};

jest.mock("./token-store", () => ({
  oauthTokenStore: {
    get: (...args: any[]) => mockTokenStore.get(...args),
    upsert: (...args: any[]) => mockTokenStore.upsert(...args),
    delete: (...args: any[]) => mockTokenStore.delete(...args),
  },
}));

import {
  buildAuthorizationUrl,
  decryptOauthState,
  encryptOauthState,
  exchangeCodeForTokens,
  getOauthRedirectUri,
  getValidAccessToken,
  refreshAccessToken,
} from "./flow";

const config: ExuluOauthConfig = {
  authorizationUrl: "https://provider.example.com/oauth/authorize",
  tokenUrl: "https://provider.example.com/oauth/token",
  clientId: "client-id",
  clientSecret: "client-secret",
  scopes: ["read:a", "write:b"],
};

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = "test-secret";
  process.env.BACKEND = "https://api.example.com/";
});

beforeEach(() => {
  jest.resetAllMocks();
});

describe("getOauthRedirectUri", () => {
  it("joins BACKEND and the callback path, stripping trailing slashes", () => {
    expect(getOauthRedirectUri()).toBe("https://api.example.com/oauth/callback");
  });
});

describe("oauth state", () => {
  it("round-trips through encrypt/decrypt", () => {
    const state = {
      toolId: "my_tool",
      userId: 42,
      codeVerifier: "verifier",
      exp: Date.now() + 60_000,
    };
    expect(decryptOauthState(encryptOauthState(state))).toEqual(state);
  });

  it("produces URL-safe output", () => {
    const encrypted = encryptOauthState({ toolId: "my_tool", userId: 1, exp: Date.now() + 60_000 });
    expect(encrypted).not.toMatch(/[+/=]/);
  });

  it("rejects expired state", () => {
    const encrypted = encryptOauthState({ toolId: "my_tool", userId: 1, exp: Date.now() - 1 });
    expect(() => decryptOauthState(encrypted)).toThrow(/expired/);
  });

  it("rejects garbled state", () => {
    expect(() => decryptOauthState("not-a-real-state")).toThrow(/Invalid/);
  });

  it("rejects state encrypted with a different secret", () => {
    const encrypted = encryptOauthState({ toolId: "my_tool", userId: 1, exp: Date.now() + 60_000 });
    const original = process.env.NEXTAUTH_SECRET;
    process.env.NEXTAUTH_SECRET = "other-secret";
    try {
      expect(() => decryptOauthState(encrypted)).toThrow(/Invalid/);
    } finally {
      process.env.NEXTAUTH_SECRET = original;
    }
  });
});

describe("buildAuthorizationUrl", () => {
  it("includes the standard authorization-code params", () => {
    const url = new URL(buildAuthorizationUrl({ toolId: "my_tool", userId: 42, config }));
    expect(url.origin + url.pathname).toBe("https://provider.example.com/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.example.com/oauth/callback");
    expect(url.searchParams.get("scope")).toBe("read:a write:b");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("derives the PKCE challenge from the verifier carried in state", () => {
    const url = new URL(buildAuthorizationUrl({ toolId: "my_tool", userId: 42, config }));
    const state = decryptOauthState(url.searchParams.get("state")!);
    expect(state.toolId).toBe("my_tool");
    expect(state.userId).toBe(42);
    expect(state.codeVerifier).toBeTruthy();
    const expectedChallenge = createHash("sha256")
      .update(state.codeVerifier!)
      .digest("base64url");
    expect(url.searchParams.get("code_challenge")).toBe(expectedChallenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("omits PKCE params when pkce is false", () => {
    const url = new URL(
      buildAuthorizationUrl({ toolId: "my_tool", userId: 42, config: { ...config, pkce: false } }),
    );
    expect(url.searchParams.get("code_challenge")).toBeNull();
    expect(decryptOauthState(url.searchParams.get("state")!).codeVerifier).toBeUndefined();
  });

  it("appends extraAuthParams", () => {
    const url = new URL(
      buildAuthorizationUrl({
        toolId: "my_tool",
        userId: 42,
        config: { ...config, extraAuthParams: { access_type: "offline", prompt: "consent" } },
      }),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });
});

describe("token endpoint exchanges", () => {
  const mockFetch = jest.fn();

  beforeEach(() => {
    global.fetch = mockFetch as any;
  });

  const jsonResponse = (body: any, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });

  it("exchanges a code and maps the response to a token record", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        access_token: "access",
        refresh_token: "refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read:a",
      }),
    );
    const before = Date.now();
    const record = await exchangeCodeForTokens({ config, code: "the-code", codeVerifier: "v" });

    expect(mockFetch).toHaveBeenCalledWith(config.tokenUrl, expect.objectContaining({ method: "POST" }));
    const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("code_verifier")).toBe("v");
    expect(body.get("client_id")).toBe("client-id");
    expect(body.get("client_secret")).toBe("client-secret");
    expect(body.get("redirect_uri")).toBe("https://api.example.com/oauth/callback");

    expect(record.accessToken).toBe("access");
    expect(record.refreshToken).toBe("refresh");
    expect(record.tokenType).toBe("Bearer");
    expect(record.scopes).toBe("read:a");
    expect(record.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000);
  });

  it("falls back to configured scopes and null expiry when the provider omits them", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ access_token: "access" }));
    const record = await exchangeCodeForTokens({ config, code: "the-code" });
    expect(record.scopes).toBe("read:a write:b");
    expect(record.expiresAt).toBeNull();
    expect(record.refreshToken).toBeNull();
  });

  it("throws on a non-2xx response", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400));
    await expect(exchangeCodeForTokens({ config, code: "bad" })).rejects.toThrow(/400/);
  });

  it("throws when access_token is missing", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ token_type: "Bearer" }));
    await expect(exchangeCodeForTokens({ config, code: "x" })).rejects.toThrow(/access_token/);
  });

  it("sends a refresh_token grant", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ access_token: "new-access" }));
    await refreshAccessToken({ config, refreshToken: "the-refresh" });
    const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("the-refresh");
  });
});

describe("getValidAccessToken", () => {
  const mockFetch = jest.fn();

  beforeEach(() => {
    global.fetch = mockFetch as any;
  });

  it("returns null when no token is stored", async () => {
    mockTokenStore.get.mockResolvedValue(null);
    expect(await getValidAccessToken({ toolId: "t", userId: 1, config })).toBeNull();
  });

  it("returns the stored token when not expired", async () => {
    const stored = { accessToken: "a", expiresAt: new Date(Date.now() + 3600_000) };
    mockTokenStore.get.mockResolvedValue(stored);
    expect(await getValidAccessToken({ toolId: "t", userId: 1, config })).toBe(stored);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("treats a null expiry as non-expiring", async () => {
    const stored = { accessToken: "a", expiresAt: null };
    mockTokenStore.get.mockResolvedValue(stored);
    expect(await getValidAccessToken({ toolId: "t", userId: 1, config })).toBe(stored);
  });

  it("refreshes an expired token, preserving the refresh token", async () => {
    mockTokenStore.get.mockResolvedValue({
      accessToken: "old",
      refreshToken: "the-refresh",
      expiresAt: new Date(Date.now() - 1000),
    });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: "new", expires_in: 3600 }),
    });
    const result = await getValidAccessToken({ toolId: "t", userId: 1, config });
    expect(result!.accessToken).toBe("new");
    expect(result!.refreshToken).toBe("the-refresh");
    expect(mockTokenStore.upsert).toHaveBeenCalledWith("t", 1, result);
  });

  it("deletes the row and returns null when expired with no refresh token", async () => {
    mockTokenStore.get.mockResolvedValue({
      accessToken: "old",
      refreshToken: null,
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await getValidAccessToken({ toolId: "t", userId: 1, config })).toBeNull();
    expect(mockTokenStore.delete).toHaveBeenCalledWith("t", 1);
  });

  it("deletes the row and returns null when the refresh fails", async () => {
    mockTokenStore.get.mockResolvedValue({
      accessToken: "old",
      refreshToken: "revoked",
      expiresAt: new Date(Date.now() - 1000),
    });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "invalid_grant" }),
    });
    expect(await getValidAccessToken({ toolId: "t", userId: 1, config })).toBeNull();
    expect(mockTokenStore.delete).toHaveBeenCalledWith("t", 1);
  });
});
