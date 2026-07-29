jest.mock("@SRC/exulu/auth/describe", () => ({
  describeCredentialIdentity: jest.fn(async () => ({ provider: "google", authType: "oauth", account: "42", scopes: ["a"] })),
}));

import { buildToolCallEvent } from "./tool-call";
import { describeCredentialIdentity } from "@SRC/exulu/auth/describe";

const opts = { maxBytes: 10_000, captureOutput: true, redactKeys: [], nowIso: () => "2026-07-28T00:00:00.000Z" };

const baseCtx = {
  durationMs: 12,
  agent: { id: "ag1", name: "Support" },
  tool: { id: "my_tool", name: "my_tool", category: "default" },
  builtin: false,
  user: { id: 42, email: "u@x.com", role: { id: 3 } },
  sessionID: "sess1",
  toolCallId: "tc1",
  input: { query: "hi", oauth: { accessToken: "SECRET" } },
  output: { result: "done" },
  status: "ok" as const,
};

describe("buildToolCallEvent", () => {
  it("builds a tool.call event with redacted input and no credential block for unauth tools", async () => {
    const ev = await buildToolCallEvent(baseCtx, opts);
    expect(ev.type).toBe("tool.call");
    expect(ev.status).toBe("ok");
    expect(ev.durationMs).toBe(12);
    expect(ev.target).toMatchObject({ kind: "tool", id: "my_tool", builtin: false });
    expect(ev.actor).toMatchObject({ userId: "42", email: "u@x.com", roleId: "3" });
    expect(ev.context).toMatchObject({ sessionId: "sess1", agentId: "ag1", toolCallId: "tc1" });
    expect(ev.credential).toBeUndefined();
    expect(JSON.stringify(ev)).not.toContain("SECRET");
  });

  it("includes credential identity for authenticated tools", async () => {
    const ev = await buildToolCallEvent(
      { ...baseCtx, tool: { ...baseCtx.tool, authentication: { authType: "oauth", provider: "google" } as any } },
      opts,
    );
    expect(ev.credential).toEqual({ provider: "google", authType: "oauth", account: "42", scopes: ["a"] });
  });

  it("maps error and auth-short-circuit outputs to the right status", async () => {
    const errEv = await buildToolCallEvent({ ...baseCtx, status: "error", error: new Error("nope") }, opts);
    expect(errEv.status).toBe("error");
    expect(errEv.error?.message).toBe("nope");

    const authEv = await buildToolCallEvent({ ...baseCtx, output: { credentialRequest: { provider: "google" } } }, opts);
    expect(authEv.status).toBe("auth_required");
    expect(authEv.data?.output).toBeUndefined();
  });

  it("oauth.authorizationUrl short-circuit yields auth_required and suppresses output", async () => {
    const ev = await buildToolCallEvent(
      { ...baseCtx, output: { oauth: { authorizationUrl: "https://x/authorize?state=NONCE" } } },
      opts,
    );
    expect(ev.status).toBe("auth_required");
    expect(ev.data?.output).toBeUndefined();
  });

  it("omits credential key when describeCredentialIdentity returns undefined", async () => {
    jest.mocked(describeCredentialIdentity).mockResolvedValueOnce(undefined as any);
    const ev = await buildToolCallEvent(
      { ...baseCtx, tool: { ...baseCtx.tool, authentication: { authType: "oauth", provider: "google" } as any } },
      opts,
    );
    expect("credential" in ev).toBe(false);
  });

  it("omits output when captureOutput is false", async () => {
    const ev = await buildToolCallEvent(baseCtx, { ...opts, captureOutput: false });
    expect(ev.data?.output).toBeUndefined();
    expect(ev.data?.input).toBeDefined();
  });

  it("includes the client section when ctx.client is set, and omits it otherwise", async () => {
    const base = {
      durationMs: 1,
      tool: { id: "t1", name: "Tool 1" },
      user: { id: 1 },
      input: {},
      output: {},
      status: "ok" as const,
    };
    const withClient = await buildToolCallEvent(
      { ...base, client: { ip: "203.0.113.7", userAgent: "UA" } } as any,
      { maxBytes: 1000, captureOutput: true, redactKeys: [] },
    );
    expect(withClient.client).toEqual({ ip: "203.0.113.7", userAgent: "UA" });

    const withoutClient = await buildToolCallEvent(base as any, {
      maxBytes: 1000,
      captureOutput: true,
      redactKeys: [],
    });
    expect("client" in withoutClient).toBe(false);
  });
});
