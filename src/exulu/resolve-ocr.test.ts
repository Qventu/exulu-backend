jest.mock("./litellm/supervisor", () => ({
  isLiteLLMEnabled: jest.fn(() => true),
  waitForLiteLLMReady: jest.fn(() => Promise.resolve()),
}));
jest.mock("./litellm/budget-service", () => ({ provisionDefaultUserBudget: jest.fn(() => Promise.resolve()) }));
jest.mock("./tags", () => ({ buildTags: jest.fn(() => []) }));
jest.mock("./litellm/env", () => ({
  resolveLiteLLMTarget: jest.fn(() => ({ baseUrl: "http://litellm", authHeaders: {} })),
}));

import { resolveOcr } from "./resolve-ocr";

afterEach(() => jest.restoreAllMocks());

describe("OCR call time limit", () => {
  it("without timeoutMs no abort signal is created or handed to fetch (knowledge-base behaviour)", async () => {
    const timeout = jest.spyOn(AbortSignal, "timeout");
    const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ pages: [] }) }));
    global.fetch = fetchMock as never;
    const { ocr } = await resolveOcr({ model: "vertex-ocr" });
    await ocr({ type: "document_url", document_url: "data:application/pdf;base64,AA==" });
    expect(timeout).not.toHaveBeenCalled();
    expect((fetchMock.mock.calls[0] as unknown as [string, { signal?: unknown }])[1].signal).toBeUndefined();
  });

  it("with timeoutMs a stalled provider is aborted by the timeout signal", async () => {
    const controller = new AbortController();
    const timeout = jest.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    global.fetch = jest.fn((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted due to timeout")));
      }),
    ) as never;
    const { ocr } = await resolveOcr({ model: "vertex-ocr", timeoutMs: 180_000 });
    const pending = ocr({ type: "document_url", document_url: "data:application/pdf;base64,AA==" });
    expect(timeout).toHaveBeenCalledWith(180_000);
    controller.abort();
    await expect(pending).rejects.toThrow(/timeout/);
  });
});
