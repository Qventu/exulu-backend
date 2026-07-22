import type { ExuluTool } from "../tool";

/**
 * System-prompt block appended when a user_credentials tool is active
 * (spec 2026-07-22-tool-credentials-chat-ui §1.2 piece 3). Appended as its
 * own `system +=` block — agent instructions REPLACE the default preamble,
 * so a guardrail inside the default string would vanish for configured
 * agents.
 */
export const CREDENTIAL_GUARDRAIL = `Credential safety:
Some tools collect credentials (API keys, passwords, tokens) through a secure form shown directly to the user in the chat UI. Credentials are never entered in the conversation itself.
- Never ask the user to type credential values into the chat.
- If the user pastes a credential value into the chat anyway, do not repeat it, do not store it, and do not pass it to any tool. Tell them to use the secure form instead (calling the tool again shows the form if it is no longer visible).
- After the user confirms they submitted the form, call the tool again.`;

export const credentialGuardrailBlock = (currentTools?: ExuluTool[]): string | null =>
  currentTools?.some((t) => t.authentication?.authType === "user_credentials")
    ? CREDENTIAL_GUARDRAIL
    : null;
