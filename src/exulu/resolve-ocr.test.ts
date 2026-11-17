jest.mock("./litellm/supervisor", () => ({
  isLiteLLMEnabled: jest.fn(() => true),
  waitForLiteLLMReady: jest.fn(() => Promise.resolve()),
}));
jest.mock("./litellm/budget-service", () => ({ provisionDefaultUserBudget: jest.fn(() => Promise.resolve()) }));
jest.mock("./tags", () => ({ buildTags: jest.fn(() => []) }));
jest.mock("./litellm/env", () => ({
  resolveLiteLLMTarget: jest.fn(() => ({ baseUrl: "http://litellm", authHeaders: {} })),
}));

import { resolveOcr, OCR_CALL_TIMEOUT_MS } from "./resolve-ocr";

afterEach(() => jest.restoreAllMocks());

describe("OCR call time limit", () => {
  it("is 180 seconds", () => {
    expect(OCR_CALL_TIMEOUT_MS).toBe(180_000);
  });

  it("a stalled provider is aborted by the timeout signal instead of pinning the caller", async () => {
    const controller = new AbortController();
    const timeout = jest.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    global.fetch = jest.fn((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted due to timeout")));
      }),
    ) as never;
    const { ocr } = await resolveOcr({ model: "vertex-ocr" });
    const pending = ocr({ type: "document_url", document_url: "data:application/pdf;base64,AA==" });
    expect(timeout).toHaveBeenCalledWith(180_000);
    controller.abort();
    await expect(pending).rejects.toThrow(/timeout/);
  });
});
