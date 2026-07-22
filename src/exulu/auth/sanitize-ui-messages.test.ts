import type { UIMessage } from "ai";
import { sanitizeAuthPayloadsInUiMessages } from "./sanitize-ui-messages";
import { SCRUBBED_CREDENTIAL_TEXT, SCRUBBED_OAUTH_TEXT } from "./scrub-text";

const credentialPart = {
  type: "dynamic-tool",
  toolName: "moco_list_activities",
  toolCallId: "c1",
  state: "output-available",
  input: {},
  output: {
    credentialRequest: {
      provider: "moco",
      fields: [],
      submitUrl: "http://localhost:9001/credentials/submit",
      nonce: "SECRET_NONCE",
    },
    result: null,
  },
};

const messages = (parts: any[]): UIMessage[] =>
  [{ id: "m1", role: "assistant", parts }] as unknown as UIMessage[];

describe("sanitizeAuthPayloadsInUiMessages", () => {
  it("replaces credentialRequest outputs with scrub text, without mutating the input", () => {
    const input = messages([credentialPart]);
    const out = sanitizeAuthPayloadsInUiMessages(input);
    expect((out[0] as any).parts[0].output).toEqual({ result: SCRUBBED_CREDENTIAL_TEXT });
    // Original untouched — the UI/persistence copy keeps the payload.
    expect((input[0] as any).parts[0].output.credentialRequest.nonce).toBe("SECRET_NONCE");
    expect(JSON.stringify(out)).not.toContain("SECRET_NONCE");
  });

  it("replaces oauth outputs with scrub text", () => {
    const oauthPart = {
      ...credentialPart,
      output: { result: "auth at https://x", oauth: { authorizationUrl: "https://x/auth" } },
    };
    const out = sanitizeAuthPayloadsInUiMessages(messages([oauthPart]));
    expect((out[0] as any).parts[0].output).toEqual({ result: SCRUBBED_OAUTH_TEXT });
  });

  it("leaves normal tool outputs and non-assistant messages alone (same references)", () => {
    const normalPart = { ...credentialPart, output: { result: "[]" } };
    const userMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] };
    const input = [
      { id: "m1", role: "assistant", parts: [normalPart] },
      userMessage,
    ] as unknown as UIMessage[];
    const out = sanitizeAuthPayloadsInUiMessages(input);
    expect(out[0]).toBe(input[0]);
    expect(out[1]).toBe(input[1]);
  });
});
