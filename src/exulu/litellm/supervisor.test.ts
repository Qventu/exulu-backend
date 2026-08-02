import { EventEmitter } from "node:events";

const mockSpawn = jest.fn();
const mockExistsSync = jest.fn();

jest.mock("node:child_process", () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

jest.mock("node:fs", () => {
  const actual = jest.requireActual("node:fs");
  return {
    ...actual,
    existsSync: (p: string) => mockExistsSync(p),
  };
});

// Mock fetch (used for the /health readiness probe).
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import {
  isLiteLLMEnabled,
  startLiteLLMSupervisor,
  enableLiteLLMClientMode,
  waitForLiteLLMReady,
  getSupervisorState,
  __resetSupervisorForTesting,
} from "./supervisor";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  exitCode: number | null = null;
  kill(_signal?: NodeJS.Signals) {
    this.killed = true;
    this.exitCode = 0;
    setImmediate(() => this.emit("exit", 0));
  }
}

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  __resetSupervisorForTesting();
  mockSpawn.mockReset();
  mockExistsSync.mockReset();
  mockFetch.mockReset();
  delete process.env.EXULU_USE_LITELLM;
  delete process.env.LITELLM_MASTER_KEY;
  delete process.env.LITELLM_CONFIG_PATH;
  delete process.env.DEBUG;
});

describe("isLiteLLMEnabled", () => {
  test("false when env var is undefined", () => {
    expect(isLiteLLMEnabled()).toBe(false);
  });

  test("false when env var is anything but the string 'true'", () => {
    process.env.EXULU_USE_LITELLM = "1";
    expect(isLiteLLMEnabled()).toBe(false);
    process.env.EXULU_USE_LITELLM = "yes";
    expect(isLiteLLMEnabled()).toBe(false);
    process.env.EXULU_USE_LITELLM = "TRUE";
    expect(isLiteLLMEnabled()).toBe(false);
  });

  test("true only when env var is exactly 'true'", () => {
    process.env.EXULU_USE_LITELLM = "true";
    expect(isLiteLLMEnabled()).toBe(true);
  });
});

describe("startLiteLLMSupervisor", () => {
  test("returns early (no-op) when LiteLLM is disabled", async () => {
    await startLiteLLMSupervisor();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(getSupervisorState()).toBe("idle");
  });

  test("throws synchronously when LITELLM_MASTER_KEY is missing", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    await expect(startLiteLLMSupervisor()).rejects.toThrow(
      /LITELLM_MASTER_KEY is not set/,
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test("skips spawn + sets state given_up when config.yaml is missing", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    process.env.LITELLM_MASTER_KEY = "sk-test";
    // First existsSync call is for the config path → false; second is for the
    // litellm bin (never reached because we return early).
    mockExistsSync.mockReturnValueOnce(false);
    await startLiteLLMSupervisor({ packageRoot: "/fake/exulu" });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(getSupervisorState()).toBe("given_up");
  });

  test("skips spawn + sets state given_up when litellm binary is missing", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    process.env.LITELLM_MASTER_KEY = "sk-test";
    mockExistsSync
      .mockReturnValueOnce(true) // config path exists
      .mockReturnValueOnce(false); // litellm bin missing
    await startLiteLLMSupervisor({ packageRoot: "/fake/exulu" });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(getSupervisorState()).toBe("given_up");
  });

  test("spawns LiteLLM and reaches ready state when /health returns 200", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    process.env.LITELLM_MASTER_KEY = "sk-test";
    mockExistsSync.mockReturnValue(true);
    const child = new FakeChild();
    mockSpawn.mockReturnValue(child);
    mockFetch.mockResolvedValue({ ok: true });

    const startPromise = startLiteLLMSupervisor({ packageRoot: "/fake/exulu" });
    // Allow the supervisor's pollHealth loop to tick.
    await flush();
    await flush();
    await startPromise;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [bin, args] = mockSpawn.mock.calls[0]!;
    expect(bin).toMatch(/litellm$/);
    expect(args).toEqual(
      expect.arrayContaining(["--config", expect.any(String), "--port", "4000"]),
    );
    expect(getSupervisorState()).toBe("ready");
  });

  test("pins DEBUG=false in the child env so LiteLLM's click CLI never crashes on Node debug filters", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    process.env.LITELLM_MASTER_KEY = "sk-test";
    process.env.DEBUG = "http-proxy-middleware*";
    mockExistsSync.mockReturnValue(true);
    const child = new FakeChild();
    mockSpawn.mockReturnValue(child);
    mockFetch.mockResolvedValue({ ok: true });

    try {
      await startLiteLLMSupervisor({ packageRoot: "/fake/exulu" });
      const [, , opts] = mockSpawn.mock.calls[0]!;
      // load_dotenv() defaults to override=False, so a pre-set DEBUG wins
      // over any value LiteLLM's .env loader injects after spawn.
      expect(opts.env.DEBUG).toBe("false");
      // Sanity-check we didn't accidentally drop the rest of the env.
      expect(opts.env.LITELLM_MASTER_KEY).toBe("sk-test");
    } finally {
      delete process.env.DEBUG;
    }
  });

  test("respects LITELLM_PORT and LITELLM_HOST overrides", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    process.env.LITELLM_MASTER_KEY = "sk-test";
    process.env.LITELLM_PORT = "5555";
    process.env.LITELLM_HOST = "0.0.0.0";
    mockExistsSync.mockReturnValue(true);
    const child = new FakeChild();
    mockSpawn.mockReturnValue(child);
    mockFetch.mockResolvedValue({ ok: true });

    await startLiteLLMSupervisor({ packageRoot: "/fake/exulu" });
    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toEqual(
      expect.arrayContaining(["--port", "5555", "--host", "0.0.0.0"]),
    );
    delete process.env.LITELLM_PORT;
    delete process.env.LITELLM_HOST;
  });

  test("is idempotent — second call returns the same readiness promise", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    process.env.LITELLM_MASTER_KEY = "sk-test";
    mockExistsSync.mockReturnValue(true);
    const child = new FakeChild();
    mockSpawn.mockReturnValue(child);
    mockFetch.mockResolvedValue({ ok: true });

    await startLiteLLMSupervisor({ packageRoot: "/fake/exulu" });
    await startLiteLLMSupervisor({ packageRoot: "/fake/exulu" });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});

describe("waitForLiteLLMReady", () => {
  test("no-op when LiteLLM is disabled", async () => {
    await expect(waitForLiteLLMReady()).resolves.toBeUndefined();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test("uses the previously set package root when called without args", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    process.env.LITELLM_MASTER_KEY = "sk-test";
    mockExistsSync.mockReturnValue(true);
    const child = new FakeChild();
    mockSpawn.mockReturnValue(child);
    mockFetch.mockResolvedValue({ ok: true });

    const { setLiteLLMPackageRoot } = await import("./supervisor");
    setLiteLLMPackageRoot("/fake/exulu");
    await waitForLiteLLMReady();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  test("throws when LiteLLM is enabled but no package root is set", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    process.env.LITELLM_MASTER_KEY = "sk-test";
    await expect(waitForLiteLLMReady()).rejects.toThrow(/package root not set/);
  });
});

describe("enableLiteLLMClientMode", () => {
  test("client mode connects to an external proxy via health probe — never spawns", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    // Note: no LITELLM_MASTER_KEY / package root needed in client mode.
    mockFetch.mockResolvedValue({ ok: true });

    enableLiteLLMClientMode();
    await waitForLiteLLMReady();

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/health/liveliness",
      expect.objectContaining({ method: "GET" }),
    );
    expect(getSupervisorState()).toBe("ready");
  });

  test("client mode probes LITELLM_HOST / LITELLM_PORT overrides", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    process.env.LITELLM_HOST = "litellm.internal";
    process.env.LITELLM_PORT = "5555";
    mockFetch.mockResolvedValue({ ok: true });

    enableLiteLLMClientMode();
    await waitForLiteLLMReady();

    expect(mockFetch).toHaveBeenCalledWith(
      "http://litellm.internal:5555/health/liveliness",
      expect.objectContaining({ method: "GET" }),
    );
    delete process.env.LITELLM_HOST;
    delete process.env.LITELLM_PORT;
  });

  test("client mode is self-healing: re-probes until the proxy answers, then caches ready", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    // First wait: proxy not up yet (fetch rejects → probe fails fast).
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    enableLiteLLMClientMode();
    await expect(waitForLiteLLMReady()).rejects.toThrow(/not reachable/);
    expect(getSupervisorState()).not.toBe("ready");

    // Proxy comes up; a later call re-probes, resolves, and caches readiness.
    mockFetch.mockResolvedValue({ ok: true });
    await waitForLiteLLMReady();
    expect(getSupervisorState()).toBe("ready");

    // Cached: no further probes once ready.
    mockFetch.mockClear();
    await waitForLiteLLMReady();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("no-op when this process already supervises its own proxy", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    process.env.LITELLM_MASTER_KEY = "sk-test";
    mockExistsSync.mockReturnValue(true);
    const child = new FakeChild();
    mockSpawn.mockReturnValue(child);
    mockFetch.mockResolvedValue({ ok: true });

    await startLiteLLMSupervisor({ packageRoot: "/fake/exulu" });
    // A combined server+worker process: enabling client mode must not override
    // the supervisor it already owns.
    enableLiteLLMClientMode();
    mockFetch.mockClear();
    await waitForLiteLLMReady();
    // Still ready via the supervisor; no fresh client probe.
    expect(getSupervisorState()).toBe("ready");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("remote client mode probes /v1/models with exulu-api-key header", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    process.env.LITELLM_BASE_URL = "https://srv.example/litellm/DEFAULT";
    process.env.EXULU_API_KEY = "sk_a_b/worker";
    mockFetch.mockResolvedValue({ ok: true });

    enableLiteLLMClientMode();
    await waitForLiteLLMReady();

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://srv.example/litellm/DEFAULT/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "exulu-api-key": "sk_a_b/worker" }),
      }),
    );
    expect(getSupervisorState()).toBe("ready");

    delete process.env.LITELLM_BASE_URL;
    delete process.env.EXULU_API_KEY;
  });
});
