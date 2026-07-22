import type { ExuluTool } from "@SRC/exulu/tool";
import { credentialScrubText, SCRUBBED_OAUTH_TEXT } from "@SRC/exulu/auth/scrub-text";

type ModelOutput = { type: "text"; value: string } | { type: "json"; value: any };

/**
 * toModelOutput for auth-wrapped tools (spec §1.2 piece 1): the raw
 * credentialRequest / oauth short-circuit payload streams to the frontend
 * unchanged, but the MODEL sees only scrub text. Normal results keep the
 * AI SDK's default JSON encoding.
 */
export const buildAuthToolModelOutput =
  (tool: ExuluTool) =>
  ({ output }: { toolCallId: string; input: unknown; output: any }): ModelOutput => {
    if (output && typeof output === "object" && output.credentialRequest) {
      const auth = tool.authentication;
      const labels =
        auth?.authType === "user_credentials" ? auth.fields.map((f) => f.label) : [];
      const provider =
        output.credentialRequest.provider ??
        (auth && "provider" in auth ? auth.provider : "unknown");
      return { type: "text", value: credentialScrubText(provider, labels) };
    }
    if (output && typeof output === "object" && output.oauth?.authorizationUrl) {
      return { type: "text", value: SCRUBBED_OAUTH_TEXT };
    }
    return { type: "json", value: output ?? null };
  };
