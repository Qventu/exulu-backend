import { isGeminiChatTranscriptionModel, cleanTranscript } from "./transcribe";

describe("isGeminiChatTranscriptionModel", () => {
  it("is true for a vertex gemini upstream", () => {
    expect(isGeminiChatTranscriptionModel({ upstream_model: "vertex_ai/gemini-2.5-flash" })).toBe(true);
  });
  it("is false for whisper", () => {
    expect(isGeminiChatTranscriptionModel({ upstream_model: "whisper-1" })).toBe(false);
  });
  it("is false for vertex chirp (not a chat model)", () => {
    expect(isGeminiChatTranscriptionModel({ upstream_model: "vertex_ai/chirp-3" })).toBe(false);
  });
  it("is false for a non-gemini vertex model", () => {
    expect(isGeminiChatTranscriptionModel({ upstream_model: "vertex_ai/qwen/qwen3-235b" })).toBe(false);
  });
  it("is false for undefined / null upstream", () => {
    expect(isGeminiChatTranscriptionModel(undefined)).toBe(false);
    expect(isGeminiChatTranscriptionModel({ upstream_model: null })).toBe(false);
  });
});

describe("cleanTranscript", () => {
  it("trims whitespace", () => {
    expect(cleanTranscript("  hallo welt \n")).toBe("hallo welt");
  });
  it("strips a single pair of surrounding quotes", () => {
    expect(cleanTranscript('"hallo welt"')).toBe("hallo welt");
    expect(cleanTranscript("`hallo`")).toBe("hallo");
  });
  it("returns empty string for null/undefined/blank", () => {
    expect(cleanTranscript(null)).toBe("");
    expect(cleanTranscript(undefined)).toBe("");
    expect(cleanTranscript("   ")).toBe("");
  });
});
