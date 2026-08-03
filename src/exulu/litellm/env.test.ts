import { resolveLiteLLMTarget, setLiteLLMClientMode } from "./env";

describe("resolveLiteLLMTarget", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Clear all relevant vars before each test
    delete process.env.LITELLM_BASE_URL;
    delete process.env.LITELLM_HOST;
    delete process.env.LITELLM_PORT;
    delete process.env.LITELLM_MASTER_KEY;
    delete process.env.EXULU_API_KEY;
    // Default to server (non-client) mode; remote-mode tests opt in explicitly.
    setLiteLLMClientMode(false);
  });

  afterAll(() => {
    process.env = savedEnv;
    setLiteLLMClientMode(false);
  });

  it("default local mode: uses 127.0.0.1:4000 with master key Bearer token", () => {
    process.env.LITELLM_MASTER_KEY = "sk-test-master";

    const result = resolveLiteLLMTarget();

    expect(result.baseUrl).toBe("http://127.0.0.1:4000");
    expect(result.authHeaders).toEqual({ Authorization: "Bearer sk-test-master" });
    expect(result.remote).toBe(false);
  });

  it("local mode honors LITELLM_HOST and LITELLM_PORT", () => {
    process.env.LITELLM_HOST = "exulu-backend";
    process.env.LITELLM_PORT = "4001";
    process.env.LITELLM_MASTER_KEY = "sk-test-master";

    const result = resolveLiteLLMTarget();

    expect(result.baseUrl).toBe("http://exulu-backend:4001");
    expect(result.authHeaders).toEqual({ Authorization: "Bearer sk-test-master" });
    expect(result.remote).toBe(false);
  });

  it("stays local when LITELLM_BASE_URL is set but the process is NOT in client mode (server process)", () => {
    // Regression: the HTTP-server process loads a shared .env that sets
    // LITELLM_BASE_URL for the worker. The server must NOT route through the
    // passthrough — it owns its local :4000 proxy and must keep the caller's
    // identity. Remote mode is a worker/client-mode concern only.
    process.env.LITELLM_BASE_URL = "https://proxy.example.com/litellm";
    process.env.EXULU_API_KEY = "eak-secret";
    process.env.LITELLM_MASTER_KEY = "sk-test-master";

    const result = resolveLiteLLMTarget();

    expect(result.remote).toBe(false);
    expect(result.baseUrl).toBe("http://127.0.0.1:4000");
    expect(result.authHeaders).toEqual({ Authorization: "Bearer sk-test-master" });
  });

  it("remote mode: client mode + LITELLM_BASE_URL + EXULU_API_KEY → verbatim baseUrl, exulu-api-key header, remote true", () => {
    setLiteLLMClientMode(true);
    process.env.LITELLM_BASE_URL = "https://proxy.example.com/litellm";
    process.env.EXULU_API_KEY = "eak-secret";

    const result = resolveLiteLLMTarget();

    expect(result.baseUrl).toBe("https://proxy.example.com/litellm");
    expect(result.authHeaders).toEqual({ "exulu-api-key": "eak-secret" });
    expect(result.remote).toBe(true);
  });

  it("strips trailing slash(es) from LITELLM_BASE_URL", () => {
    setLiteLLMClientMode(true);
    process.env.LITELLM_BASE_URL = "https://proxy.example.com/litellm///";
    process.env.EXULU_API_KEY = "eak-secret";

    const result = resolveLiteLLMTarget();

    expect(result.baseUrl).toBe("https://proxy.example.com/litellm");
  });

  it("throws with /EXULU_API_KEY/ when in client mode with LITELLM_BASE_URL set but EXULU_API_KEY missing", () => {
    setLiteLLMClientMode(true);
    process.env.LITELLM_BASE_URL = "https://proxy.example.com/litellm";

    expect(() => resolveLiteLLMTarget()).toThrow(/EXULU_API_KEY/);
  });
});
