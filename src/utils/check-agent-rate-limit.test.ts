import type { Request } from "express";

const mockRedis = {
  client: null as null | {
    get: jest.Mock;
    incrBy: jest.Mock;
    expire: jest.Mock;
    ttl: jest.Mock;
  },
};

jest.mock("../redis/client.ts", () => ({
  redisClient: jest.fn(async () => mockRedis),
}));

import {
  preCheckAgentRateLimit,
  recordAgentTokenUsage,
  resolveCallerId,
} from "./check-agent-rate-limit";

const makeClient = () => ({
  get: jest.fn(),
  incrBy: jest.fn(),
  expire: jest.fn(),
  ttl: jest.fn(),
});

beforeEach(() => {
  mockRedis.client = null;
});

describe("resolveCallerId", () => {
  const reqFor = (h: Record<string, string | undefined> = {}, ip?: string): Request =>
    ({ headers: h as any, ip } as unknown as Request);

  test("returns user:<id> when userId present", () => {
    expect(resolveCallerId(reqFor(), 42)).toBe("user:42");
    expect(resolveCallerId(reqFor(), "abc")).toBe("user:abc");
  });

  test("returns ip:<x-forwarded-for-first> when set", () => {
    expect(
      resolveCallerId(reqFor({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }), undefined),
    ).toBe("ip:1.2.3.4");
  });

  test("returns ip:<req.ip> when no x-forwarded-for", () => {
    expect(resolveCallerId(reqFor({}, "9.9.9.9"), undefined)).toBe("ip:9.9.9.9");
  });

  test("returns ip:unknown last", () => {
    expect(resolveCallerId(reqFor({}, undefined), undefined)).toBe("ip:unknown");
  });

  test("treats empty string userId as missing", () => {
    expect(resolveCallerId(reqFor({}, "1.1.1.1"), "")).toBe("ip:1.1.1.1");
  });
});

describe("preCheckAgentRateLimit", () => {
  test("returns ok when limits is null", async () => {
    expect(await preCheckAgentRateLimit({ agentId: "a", callerId: "c", limits: null })).toEqual({
      ok: true,
    });
  });

  test("returns ok when Redis is unavailable (fail-open)", async () => {
    mockRedis.client = null;
    expect(
      await preCheckAgentRateLimit({
        agentId: "a",
        callerId: "c",
        limits: { requests: { limit: 1, window_seconds: 60 } },
      }),
    ).toEqual({ ok: true });
  });

  test("increments requests counter and allows up to limit, denies over limit", async () => {
    const c = makeClient();
    mockRedis.client = c;
    c.get.mockResolvedValue(null);
    c.incrBy.mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    c.ttl.mockResolvedValue(60);

    const limits = { requests: { limit: 2, window_seconds: 60 } };
    expect(await preCheckAgentRateLimit({ agentId: "a", callerId: "c", limits })).toEqual({
      ok: true,
    });
    expect(c.expire).toHaveBeenCalledWith(expect.any(String), 60);
    expect(await preCheckAgentRateLimit({ agentId: "a", callerId: "c", limits })).toEqual({
      ok: true,
    });
    const denied = await preCheckAgentRateLimit({ agentId: "a", callerId: "c", limits });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.metric).toBe("requests");
      expect(denied.retryAfter).toBeGreaterThanOrEqual(1);
    }
  });

  test("denies on input_tokens when counter already at/over limit", async () => {
    const c = makeClient();
    mockRedis.client = c;
    c.get.mockImplementation(async (key: string) => {
      if (key.endsWith("/input_tokens")) return "1000";
      return null;
    });
    c.ttl.mockResolvedValue(120);

    const denied = await preCheckAgentRateLimit({
      agentId: "a",
      callerId: "c",
      limits: { input_tokens: { limit: 1000, window_seconds: 3600 } },
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.metric).toBe("input_tokens");
      expect(denied.retryAfter).toBe(120);
    }
  });

  test("denies on output_tokens when counter already at/over limit", async () => {
    const c = makeClient();
    mockRedis.client = c;
    c.get.mockImplementation(async (key: string) => {
      if (key.endsWith("/output_tokens")) return "500";
      return null;
    });
    c.ttl.mockResolvedValue(60);

    const denied = await preCheckAgentRateLimit({
      agentId: "a",
      callerId: "c",
      limits: { output_tokens: { limit: 500, window_seconds: 3600 } },
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.metric).toBe("output_tokens");
  });
});

describe("recordAgentTokenUsage", () => {
  test("is no-op when limits is null", async () => {
    const c = makeClient();
    mockRedis.client = c;
    await recordAgentTokenUsage({
      agentId: "a",
      callerId: "c",
      limits: null,
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(c.incrBy).not.toHaveBeenCalled();
  });

  test("is no-op when Redis unavailable", async () => {
    mockRedis.client = null;
    await expect(
      recordAgentTokenUsage({
        agentId: "a",
        callerId: "c",
        limits: { input_tokens: { limit: 1000, window_seconds: 60 } },
        inputTokens: 10,
      }),
    ).resolves.toBeUndefined();
  });

  test("is no-op when token count is zero or undefined", async () => {
    const c = makeClient();
    mockRedis.client = c;
    await recordAgentTokenUsage({
      agentId: "a",
      callerId: "c",
      limits: { input_tokens: { limit: 1000, window_seconds: 60 } },
      inputTokens: 0,
    });
    await recordAgentTokenUsage({
      agentId: "a",
      callerId: "c",
      limits: { input_tokens: { limit: 1000, window_seconds: 60 } },
    });
    expect(c.incrBy).not.toHaveBeenCalled();
  });

  test("increments configured metrics and sets TTL on first increment", async () => {
    const c = makeClient();
    mockRedis.client = c;
    c.incrBy.mockResolvedValueOnce(50).mockResolvedValueOnce(25); // first-increment values

    await recordAgentTokenUsage({
      agentId: "a",
      callerId: "c",
      limits: {
        input_tokens: { limit: 1000, window_seconds: 3600 },
        output_tokens: { limit: 500, window_seconds: 3600 },
      },
      inputTokens: 50,
      outputTokens: 25,
    });
    expect(c.incrBy).toHaveBeenCalledWith(
      expect.stringMatching(/input_tokens$/),
      50,
    );
    expect(c.incrBy).toHaveBeenCalledWith(
      expect.stringMatching(/output_tokens$/),
      25,
    );
    expect(c.expire).toHaveBeenCalledTimes(2);
  });

  test("does not set TTL when not first increment", async () => {
    const c = makeClient();
    mockRedis.client = c;
    c.incrBy.mockResolvedValueOnce(150); // not equal to count → existing window

    await recordAgentTokenUsage({
      agentId: "a",
      callerId: "c",
      limits: { input_tokens: { limit: 1000, window_seconds: 3600 } },
      inputTokens: 50,
    });
    expect(c.expire).not.toHaveBeenCalled();
  });

  test("only increments the metric whose config is present", async () => {
    const c = makeClient();
    mockRedis.client = c;
    c.incrBy.mockResolvedValueOnce(10);

    await recordAgentTokenUsage({
      agentId: "a",
      callerId: "c",
      limits: { input_tokens: { limit: 1000, window_seconds: 3600 } },
      inputTokens: 10,
      outputTokens: 99,
    });
    expect(c.incrBy).toHaveBeenCalledTimes(1);
    expect(c.incrBy).toHaveBeenCalledWith(
      expect.stringMatching(/input_tokens$/),
      10,
    );
  });
});
