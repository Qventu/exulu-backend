import {
  ContextEmbedderNotConfiguredError,
  embedderNotConfiguredMessage,
  isEmbedderNotConfigured,
} from "./embedder-not-configured";

describe("ContextEmbedderNotConfiguredError", () => {
  it("names the context and says what to do about it", () => {
    const message = embedderNotConfiguredMessage("transcriptions");
    expect(message).toContain("transcriptions");
    expect(message.toLowerCase()).toContain("embedding model");
    // Actionable: it must point at where to fix it, not just state a fact.
    expect(message.toLowerCase()).toMatch(/configure|settings|admin/);
  });

  it("carries the context id for callers that branch on it", () => {
    const err = new ContextEmbedderNotConfiguredError("docs");
    expect(err.contextId).toBe("docs");
    expect(err).toBeInstanceOf(Error);
  });

  it("is recognisable after crossing an async boundary", () => {
    // searchContexts catches everything; it must be able to tell this apart
    // from a transport failure without string-matching.
    expect(isEmbedderNotConfigured(new ContextEmbedderNotConfiguredError("docs"))).toBe(true);
    expect(isEmbedderNotConfigured(new Error("connection reset"))).toBe(false);
    expect(isEmbedderNotConfigured(null)).toBe(false);
  });
});
