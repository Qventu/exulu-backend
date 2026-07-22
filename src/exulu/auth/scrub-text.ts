/**
 * Model-facing replacement text for auth short-circuit payloads (spec
 * 2026-07-22-tool-credentials-chat-ui §1.2). The model may know WHICH
 * provider/fields the form asks for — never the nonce or submitUrl.
 */
export const credentialScrubText = (provider: string, fieldLabels: string[]): string =>
  `A secure credential form for provider "${provider}"` +
  (fieldLabels.length ? ` (fields: ${fieldLabels.join(", ")})` : "") +
  ` is shown to the user in the chat UI. Never ask for these values in chat.` +
  ` After the user confirms saving, call the tool again.`;

export const SCRUBBED_CREDENTIAL_TEXT =
  "A secure credential form was shown to the user in the chat UI. " +
  "Never ask for credential values in chat. After the user confirms saving, call the tool again.";

export const SCRUBBED_OAUTH_TEXT =
  "Authorization is required. A Connect button was shown to the user in the chat UI. " +
  "Do not relay any URL in chat. After the user confirms connecting, call the tool again.";
