import { credentialGuardrailBlock, CREDENTIAL_GUARDRAIL } from "./guardrail";

const credTool = { authentication: { authType: "user_credentials" } } as any;
const oauthTool = { authentication: { authType: "oauth" } } as any;
const plainTool = {} as any;

describe("credentialGuardrailBlock", () => {
  it("returns the guardrail when a user_credentials tool is present", () => {
    expect(credentialGuardrailBlock([plainTool, credTool])).toBe(CREDENTIAL_GUARDRAIL);
  });

  it("returns null for oauth-only, plain, empty, and undefined tool lists", () => {
    expect(credentialGuardrailBlock([oauthTool, plainTool])).toBeNull();
    expect(credentialGuardrailBlock([])).toBeNull();
    expect(credentialGuardrailBlock(undefined)).toBeNull();
  });

  it("never mentions internal machinery the model could parrot", () => {
    expect(CREDENTIAL_GUARDRAIL).not.toMatch(/nonce|submitUrl/i);
  });
});
