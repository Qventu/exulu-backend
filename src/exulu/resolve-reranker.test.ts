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

import { resolveReranker, ResolveRerankerError } from "./resolve-reranker";

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
});

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe("resolveReranker", () => {
  test("throws when LiteLLM is disabled", async () => {
    delete process.env.EXULU_USE_LITELLM;
    await expect(resolveReranker({ model: "rerank-v4.0-pro" })).rejects.toThrow(
      ResolveRerankerError,
    );
  });

  test("throws when master key is missing", async () => {
    delete process.env.LITELLM_MASTER_KEY;
    await expect(resolveReranker({ model: "rerank-v4.0-pro" })).rejects.toMatchObject(
      { code: "LITELLM_NOT_CONFIGURED" },
    );
  });

  const chunks = [
    { chunk_id: "a", item_name: "Doc A", chunk_content: "alpha" },
    { chunk_id: "b", item_name: "Doc B", chunk_content: "beta" },
  ];

  test("builds item_name: chunk_content documents and sends tags", async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.2 },
        ],
      }),
    );

    const resolved = await resolveReranker({ model: "rerank-v4.0-pro" });
    await resolved.rerank("q", chunks);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:4000/v1/rerank");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: "rerank-v4.0-pro",
      query: "q",
      documents: ["Doc A: alpha", "Doc B: beta"],
      top_n: 2,
      metadata: { tags: ["user_id_1", "context_id_ctx"] },
    });
  });

  test("maps scores back onto chunks, sorted desc, with rerank_score", async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        results: [
          { index: 0, relevance_score: 0.2 },
          { index: 1, relevance_score: 0.9 },
        ],
      }),
    );
    const resolved = await resolveReranker({ model: "m" });
    const out = await resolved.rerank("q", chunks);
    expect(out).toEqual([
      { chunk_id: "b", item_name: "Doc B", chunk_content: "beta", rerank_score: 0.9 },
      { chunk_id: "a", item_name: "Doc A", chunk_content: "alpha", rerank_score: 0.2 },
    ]);
  });

  test("forwards an explicit topN", async () => {
    mockFetch.mockResolvedValue(okResponse({ results: [] }));
    const resolved = await resolveReranker({ model: "m" });
    await resolved.rerank("q", chunks, { topN: 1 });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).top_n).toBe(1);
  });

  test("skips out-of-range indices defensively", async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        results: [
          { index: 5, relevance_score: 0.99 },
          { index: 0, relevance_score: 0.1 },
        ],
      }),
    );
    const resolved = await resolveReranker({ model: "m" });
    const out = await resolved.rerank("q", chunks);
    expect(out.map((c) => c.chunk_id)).toEqual(["a"]);
  });

  test("short-circuits on empty chunks without calling the proxy", async () => {
    const resolved = await resolveReranker({ model: "m" });
    expect(await resolved.rerank("q", [])).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("returns [] on a non-ok proxy response (errors are swallowed, retrieval degrades)", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "bad gateway",
    });
    const resolved = await resolveReranker({ model: "m" });
    await expect(resolved.rerank("q", chunks)).resolves.toEqual([]);
  });
});
