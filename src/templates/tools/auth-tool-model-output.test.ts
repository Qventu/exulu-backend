import { buildAuthToolModelOutput } from "./auth-tool-model-output";

const credentialTool = {
  authentication: {
    authType: "user_credentials",
    provider: "moco",
    fields: [
      { name: "subdomain", label: "Moco subdomain", type: "text" },
      { name: "apiKey", label: "Personal API key", type: "password" },
    ],
  },
} as any;

const oauthTool = {
  authentication: { authType: "oauth", provider: "google" },
} as any;

describe("buildAuthToolModelOutput", () => {
  it("replaces credentialRequest payloads with text naming provider and labels, never nonce/submitUrl", () => {
    const toModelOutput = buildAuthToolModelOutput(credentialTool);
    const result = toModelOutput({
      toolCallId: "c1",
      input: {},
      output: {
        credentialRequest: {
          provider: "moco",
          fields: [],
          submitUrl: "http://localhost:9001/credentials/submit",
          nonce: "SECRET_NONCE_VALUE",
        },
        result: null,
      },
    }) as { type: string; value: string };
    expect(result.type).toBe("text");
    expect(result.value).toContain("moco");
    expect(result.value).toContain("Moco subdomain");
    expect(result.value).toContain("Personal API key");
    expect(result.value).not.toContain("SECRET_NONCE_VALUE");
    expect(result.value).not.toContain("/credentials/submit");
  });

  it("replaces oauth short-circuits with text that omits the URL", () => {
    const toModelOutput = buildAuthToolModelOutput(oauthTool);
    const result = toModelOutput({
      toolCallId: "c1",
      input: {},
      output: {
        result: "Authorization required: https://accounts.google.com/o/oauth2/auth?x=1",
        oauth: { authorizationUrl: "https://accounts.google.com/o/oauth2/auth?x=1" },
      },
    }) as { type: string; value: string };
    expect(result.type).toBe("text");
    expect(result.value).not.toContain("accounts.google.com");
  });

  it("passes normal outputs through as json (the AI SDK default)", () => {
    const toModelOutput = buildAuthToolModelOutput(credentialTool);
    const output = { result: JSON.stringify({ activities: [] }) };
    const result = toModelOutput({ toolCallId: "c1", input: {}, output }) as {
      type: string;
      value: unknown;
    };
    expect(result).toEqual({ type: "json", value: output });
  });

  it("handles null output", () => {
    const toModelOutput = buildAuthToolModelOutput(credentialTool);
    expect(toModelOutput({ toolCallId: "c1", input: {}, output: null })).toEqual({
      type: "json",
      value: null,
    });
  });
});
