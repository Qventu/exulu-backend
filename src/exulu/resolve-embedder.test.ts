const mockWaitForReady = jest.fn();
jest.mock("./litellm/supervisor", () => ({
  isLiteLLMEnabled: () => process.env.EXULU_USE_LITELLM === "true",
  waitForLiteLLMReady: (...args: any[]) => mockWaitForReady(...args),
}));

const mockProvisionBudget = jest.fn();
jest.mock("./litellm/budget-service", () => ({
  provisionDefaultUserBudget: (...args: any[]) => mockProvisionBudget(...args),
}));

const mockBuildTags = jest.fn(() => ["user_id_1", "context_id_ctx"]);
jest.mock("./tags", () => ({
  buildTags: (...args: any[]) => mockBuildTags(...args),
}));

// Mock getEmbeddingModelInfo so we don't need config.litellm.yaml on disk.
jest.mock("./litellm/parse-embedding-models", () => ({
  getEmbeddingModelInfo: (_modelName: string) => ({
    model_name: _modelName,
    dimensionality: 1536,
    maxChunkSize: 1024,
    maxBatchSize: 100,
  }),
}));

import { resolveEmbedder } from "./resolve-embedder";

const mockFetch = jest.fn();

beforeEach(() => {
  mockWaitForReady.mockReset().mockResolvedValue(undefined);
  mockProvisionBudget.mockReset().mockResolvedValue(undefined);
  mockBuildTags.mockClear();
  mockFetch.mockReset();
  global.fetch = mockFetch as any;
  process.env.EXULU_USE_LITELLM = "true";
  process.env.LITELLM_MASTER_KEY = "sk-test";
  process.env.LITELLM_HOST = "127.0.0.1";
  process.env.LITELLM_PORT = "4000";
});

afterEach(() => {
  delete process.env.EXULU_USE_LITELLM;
  delete process.env.LITELLM_MASTER_KEY;
  delete process.env.LITELLM_BASE_URL;
  delete process.env.EXULU_API_KEY;
});

const okEmbeddingResponse = (vectors: number[][]) => ({
  ok: true,
  status: 200,
  json: async () => ({
    data: vectors.map((embedding, index) => ({ index, embedding })),
  }),
  text: async () => "",
});

describe("resolveEmbedder", () => {
  test("local mode: uses http://host:port/v1/embeddings with Authorization header", async () => {
    mockFetch.mockResolvedValue(okEmbeddingResponse([[0.1, 0.2, 0.3]]));

    const resolved = await resolveEmbedder({ model: "gemini-embedding-001" });
    await resolved.embed(["hello world"]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:4000/v1/embeddings");
    expect(init.headers["Authorization"]).toBe("Bearer sk-test");
    expect(init.headers["exulu-api-key"]).toBeUndefined();
  });

  test("remote mode: uses LITELLM_BASE_URL + exulu-api-key header, no Authorization", async () => {
    process.env.LITELLM_BASE_URL = "https://srv.example/litellm/DEFAULT";
    process.env.EXULU_API_KEY = "sk_a_b/worker";
    delete process.env.LITELLM_MASTER_KEY;

    mockFetch.mockResolvedValue(okEmbeddingResponse([[0.1, 0.2, 0.3]]));

    const resolved = await resolveEmbedder({ model: "gemini-embedding-001" });
    await resolved.embed(["hello world"]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://srv.example/litellm/DEFAULT/v1/embeddings");
    expect(init.headers["exulu-api-key"]).toBe("sk_a_b/worker");
    expect(init.headers["Authorization"]).toBeUndefined();
  });
});
