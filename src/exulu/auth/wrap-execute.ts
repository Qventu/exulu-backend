import type { ExuluAuthConfig, ExuluOauthConfig, ExuluOauthToolContext } from "./types";
import { buildAuthorizationUrl, getValidAccessToken } from "./flow";
import { providerKeyFor } from "./provider-key";

type ExecuteFunction = (inputs: any, options?: any) => any;

/**
 * Wraps a tool's execute with the appropriate authentication flow based on authType.
 * - oauth: 3-legged OAuth 2.0 flow (execute runs with a valid access token).
 * - user_credentials: not yet supported (placeholder for Phase 2).
 */
export const wrapExecuteWithAuth = (
  toolId: string,
  config: ExuluAuthConfig,
  execute: ExecuteFunction,
): ExecuteFunction => {
  if (config.authType === "oauth") {
    return wrapExecuteWithOauthInternal(toolId, config, execute);
  }
  if (config.authType === "user_credentials") {
    throw new Error(
      `ExuluTool "${toolId}": user_credentials wrap is not yet supported (implemented in Phase 2).`,
    );
  }
  // unreachable given the union
  throw new Error(`ExuluTool "${toolId}": unknown authType`);
};

/**
 * Internal wrapper for OAuth 2.0. Wraps a tool's execute so it only runs with a valid
 * access token for the calling (providerKey, userId). Without one it short-circuits
 * with the authorization URL — as `result` text the agent can relay, plus a structured
 * `oauth.authorizationUrl` field the frontend can render as a connect button.
 * Generator-based executes pass through unchanged: the returned generator is
 * handed to the caller as-is.
 */
const wrapExecuteWithOauthInternal = (
  toolId: string,
  config: ExuluOauthConfig,
  execute: ExecuteFunction,
): ExecuteFunction => {
  return async (inputs: any, options?: any) => {
    // `user` is injected into inputs by convertExuluToolsToAiSdkTools.
    const userId = inputs?.user?.id;
    if (!userId) {
      return {
        result: `The "${toolId}" tool requires OAuth authorization, which needs a signed-in user. No user identity is available for this run.`,
      };
    }
    const providerKey = providerKeyFor(toolId, config);
    const token = await getValidAccessToken({ providerKey, userId, toolId, config });
    if (!token) {
      const authorizationUrl = buildAuthorizationUrl({ toolId, userId, config });
      return {
        result: `Authorization required. Show the user this link and ask them to run the tool again after connecting: ${authorizationUrl}`,
        oauth: { authorizationUrl },
      };
    }
    const oauth: ExuluOauthToolContext = {
      accessToken: token.accessToken,
      expiresAt: token.expiresAt ?? null,
      scopes: token.scopes ?? null,
    };
    return execute({ ...inputs, oauth }, options);
  };
};
