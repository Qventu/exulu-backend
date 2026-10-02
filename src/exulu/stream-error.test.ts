import { onChatStreamError } from "./stream-error";

describe("onChatStreamError — what happens when the model call fails mid-stream", () => {
  const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  afterAll(() => consoleError.mockRestore());

  it("logs and returns instead of throwing: a throw here became an unhandled rejection that took the whole API process down (budget-exceeded reply from LiteLLM, 2026-09-11)", () => {
    expect(() => onChatStreamError({ error: new Error("Budget has been exceeded! Tag=user_id_47") })).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith("[EXULU] chat stream error.", "Budget has been exceeded! Tag=user_id_47");
  });

  it("copes with non-Error payloads", () => {
    expect(() => onChatStreamError({ error: { code: 400, detail: "bad" } })).not.toThrow();
    expect(() => onChatStreamError({ error: undefined })).not.toThrow();
  });
});
