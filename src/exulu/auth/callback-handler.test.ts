import type { ExuluOauthConfig } from "./types";

const mockDecryptOauthState = jest.fn();
const mockExchangeCodeForTokens = jest.fn();
const mockUpsert = jest.fn();

jest.mock("./flow", () => ({
  decryptOauthState: (...args: any[]) => mockDecryptOauthState(...args),
  exchangeCodeForTokens: (...args: any[]) => mockExchangeCodeForTokens(...args),
}));

jest.mock("./credential-store", () => ({
  credentialStore: {
    upsert: (...args: any[]) => mockUpsert(...args),
  },
}));

import { handleOauthCallback } from "./callback-handler";
import { oauthRegistry } from "./registry";

const config: ExuluOauthConfig = {
  authorizationUrl: "https://provider.example.com/oauth/authorize",
  tokenUrl: "https://provider.example.com/oauth/token",
  clientId: "client-id",
  clientSecret: "client-secret",
  scopes: ["read:a"],
};

const makeRes = () => {
  const res: any = {
    statusCode: 0,
    body: "",
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    type: jest.fn(() => res),
    send: jest.fn((body: string) => {
      res.body = body;
      return res;
    }),
  };
  return res;
};

const makeReq = (query: Record<string, any>) => ({ query }) as any;

beforeEach(() => {
  jest.resetAllMocks();
  oauthRegistry.register("my_tool", config);
});

describe("handleOauthCallback", () => {
  it("renders a failure page when the provider sends an error", async () => {
    const res = makeRes();
    await handleOauthCallback(
      makeReq({ error: "access_denied", error_description: "User denied access" }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("User denied access");
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it("rejects requests missing code or state", async () => {
    const res = makeRes();
    await handleOauthCallback(makeReq({ code: "abc" }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Missing code or state");
  });

  it("renders a failure page for invalid or expired state", async () => {
    mockDecryptOauthState.mockImplementation(() => {
      throw new Error("[EXULU] OAuth state expired.");
    });
    const res = makeRes();
    await handleOauthCallback(makeReq({ code: "abc", state: "stale" }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("invalid or has expired");
  });

  it("returns 404 for a provider with no registered oauth config", async () => {
    mockDecryptOauthState.mockReturnValue({ provider: "unknown_provider", toolId: "unknown_tool", userId: 1, exp: 1 });
    const res = makeRes();
    await handleOauthCallback(makeReq({ code: "abc", state: "ok" }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("No OAuth configuration is registered for provider");
  });

  it("renders a failure page when the code exchange fails", async () => {
    mockDecryptOauthState.mockReturnValue({ provider: "my_tool", toolId: "my_tool", userId: 42, exp: 1 });
    mockExchangeCodeForTokens.mockRejectedValue(new Error("boom"));
    const res = makeRes();
    await handleOauthCallback(makeReq({ code: "abc", state: "ok" }), res);
    expect(res.statusCode).toBe(502);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("exchanges the code, persists tokens, and renders the success page", async () => {
    mockDecryptOauthState.mockReturnValue({
      provider: "my_tool",
      toolId: "my_tool",
      userId: 42,
      codeVerifier: "verifier",
      exp: 1,
    });
    const record = { accessToken: "access", refreshToken: "refresh" };
    mockExchangeCodeForTokens.mockResolvedValue(record);
    const res = makeRes();

    await handleOauthCallback(makeReq({ code: "the-code", state: "ok" }), res);

    expect(mockExchangeCodeForTokens).toHaveBeenCalledWith({
      config,
      code: "the-code",
      codeVerifier: "verifier",
    });
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "my_tool",
        userId: 42,
        authType: "oauth",
        data: expect.objectContaining({ accessToken: "access", refreshToken: "refresh" }),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Connected");
  });
});
