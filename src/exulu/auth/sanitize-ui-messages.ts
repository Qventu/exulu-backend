import type { UIMessage } from "ai";
import { SCRUBBED_CREDENTIAL_TEXT, SCRUBBED_OAUTH_TEXT } from "./scrub-text";

/**
 * History-replay scrub (spec 2026-07-22-tool-credentials-chat-ui §1.2
 * piece 2): auth short-circuit payloads persisted in earlier turns must
 * never reach the model again. Applied to the COPY handed to
 * convertToModelMessages — the stored/UI messages keep the raw payload.
 * Pure and non-mutating; untouched messages keep their references.
 */
export const sanitizeAuthPayloadsInUiMessages = (messages: UIMessage[]): UIMessage[] =>
  messages.map((message) => {
    if (message.role !== "assistant" || !Array.isArray((message as any).parts)) {
      return message;
    }
    let changed = false;
    const parts = (message as any).parts.map((part: any) => {
      const output = part?.output;
      if (output && typeof output === "object" && output.credentialRequest) {
        changed = true;
        return { ...part, output: { result: SCRUBBED_CREDENTIAL_TEXT } };
      }
      if (output && typeof output === "object" && output.oauth?.authorizationUrl) {
        changed = true;
        return { ...part, output: { result: SCRUBBED_OAUTH_TEXT } };
      }
      return part;
    });
    return changed ? ({ ...message, parts } as UIMessage) : message;
  });
