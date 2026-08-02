import { isLiteLLMPassthroughPathAllowed } from "./passthrough-allowlist";

describe("isLiteLLMPassthroughPathAllowed", () => {
  it("allows /v1/embeddings", () => {
    expect(isLiteLLMPassthroughPathAllowed("/v1/embeddings")).toBe(true);
  });

  it("allows /v1/chat/completions", () => {
    expect(isLiteLLMPassthroughPathAllowed("/v1/chat/completions")).toBe(true);
  });

  it("allows /v1/models", () => {
    expect(isLiteLLMPassthroughPathAllowed("/v1/models")).toBe(true);
  });

  it("allows /v1/rerank", () => {
    expect(isLiteLLMPassthroughPathAllowed("/v1/rerank")).toBe(true);
  });

  it("allows exactly /model/info", () => {
    expect(isLiteLLMPassthroughPathAllowed("/model/info")).toBe(true);
  });

  it("rejects /model/new", () => {
    expect(isLiteLLMPassthroughPathAllowed("/model/new")).toBe(false);
  });

  it("rejects /model/info/extra", () => {
    expect(isLiteLLMPassthroughPathAllowed("/model/info/extra")).toBe(false);
  });

  it("rejects /health/liveliness", () => {
    expect(isLiteLLMPassthroughPathAllowed("/health/liveliness")).toBe(false);
  });

  it("rejects /key/generate", () => {
    expect(isLiteLLMPassthroughPathAllowed("/key/generate")).toBe(false);
  });

  it("rejects /", () => {
    expect(isLiteLLMPassthroughPathAllowed("/")).toBe(false);
  });

  it("rejects /models (no /v1)", () => {
    expect(isLiteLLMPassthroughPathAllowed("/models")).toBe(false);
  });
});
