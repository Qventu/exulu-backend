import { fetchLiteLLMCatalog, __resetLiteLLMCatalogCacheForTesting } from "./catalog";

describe("fetchLiteLLMCatalog", () => {
  let savedEnv: NodeJS.ProcessEnv;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Clear all relevant env vars
    delete process.env.EXULU_USE_LITELLM;
    delete process.env.LITELLM_BASE_URL;
    delete process.env.LITELLM_HOST;
    delete process.env.LITELLM_PORT;
    delete process.env.LITELLM_MASTER_KEY;
    delete process.env.EXULU_API_KEY;

    // Reset the module-level cache
    __resetLiteLLMCatalogCacheForTesting();

    // Spy on global fetch
    fetchSpy = jest.spyOn(global, "fetch");
  });

  afterEach(() => {
    process.env = savedEnv;
    jest.restoreAllMocks();
  });

  it("remote mode: uses baseUrl from LITELLM_BASE_URL + exulu-api-key header, returns results", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    process.env.LITELLM_BASE_URL = "https://srv.example/litellm/DEFAULT";
    process.env.EXULU_API_KEY = "sk_a_b/worker";

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            model_name: "m",
            model_info: { supports_vision: true },
            litellm_params: { model: "openai/gpt-4o" },
          },
        ],
      }),
    } as any);

    const result = await fetchLiteLLMCatalog();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOptions] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe("https://srv.example/litellm/DEFAULT/model/info");
    expect(calledOptions.headers).toMatchObject({ "exulu-api-key": "sk_a_b/worker" });
    expect(calledOptions.headers).not.toHaveProperty("Authorization");
    expect(result.length).toBeGreaterThan(0);
  });

  it("local mode: uses 127.0.0.1:4000 + Authorization Bearer header", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    process.env.LITELLM_MASTER_KEY = "sk-test";

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    } as any);

    await fetchLiteLLMCatalog();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOptions] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe("http://127.0.0.1:4000/model/info");
    expect(calledOptions.headers).toMatchObject({ Authorization: "Bearer sk-test" });
  });

  it("local no master key: returns [] without calling fetch", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    // No LITELLM_MASTER_KEY, no LITELLM_BASE_URL

    const result = await fetchLiteLLMCatalog();

    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("disabled: EXULU_USE_LITELLM unset → returns [] without calling fetch", async () => {
    // EXULU_USE_LITELLM not set

    const result = await fetchLiteLLMCatalog();

    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
