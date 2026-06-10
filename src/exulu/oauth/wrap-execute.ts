import type { ExuluOauthConfig, ExuluOauthToolContext } from "./types";
import { buildAuthorizationUrl, getValidAccessToken } from "./flow";

type ExecuteFunction = (inputs: any, options?: any) => any;

/**
 * Wraps a tool's execute so it only runs with a valid access token for the
 * calling (toolId, userId). Without one it short-circuits with the
 * authorization URL — as `result` text the agent can relay, plus a structured
 * `oauth.authorizationUrl` field the frontend can render as a connect button.
 * Generator-based executes pass through unchanged: the returned generator is
 * handed to the caller as-is.
 */
export const wrapExecuteWithOauth = (
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
    const token = await getValidAccessToken({ toolId, userId, config });
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
