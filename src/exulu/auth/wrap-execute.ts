import type { ExuluAuthConfig, ExuluOauthConfig, ExuluOauthToolContext, ExuluUserCredentialsConfig } from "./types";
import { buildAuthorizationUrl, getValidAccessToken } from "./flow";
import { providerKeyFor } from "./provider-key";
import { getValidUserCredentials } from "./state";
import { buildCredentialRequest } from "./credentials-request";
import { credentialRequestResult } from "./short-circuit";
import { credentialStore } from "./credential-store";
import { CredentialInvalidError } from "./errors";

type ExecuteFunction = (inputs: any, options?: any) => any;

/**
 * Wraps a tool's execute with the appropriate authentication flow based on authType.
 * - oauth: 3-legged OAuth 2.0 flow (execute runs with a valid access token).
 * - user_credentials: credential prompt / inject / invalidation flow.
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
    return wrapUserCredentials(toolId, config, execute);
  }
  // unreachable given the union
  throw new Error(`ExuluTool "${toolId}": unknown authType`);
};

/**
 * Internal wrapper for user-supplied credentials. Reads credentials from the
 * store for the calling (provider, userId) pair. If none exist, short-circuits
 * with a credential-request prompt the frontend can render as a form. On cache
 * hit, injects `credentials` into inputs and calls the inner execute. If the
 * inner execute throws CredentialInvalidError for the same provider, the stored
 * row is deleted and a fresh prompt is returned. All other errors are re-thrown.
 */
const wrapUserCredentials = (
  toolId: string,
  config: ExuluUserCredentialsConfig,
  execute: ExecuteFunction,
): ExecuteFunction => {
  return async (inputs: any, options?: any) => {
    const userId = inputs?.user?.id;
    if (!userId) {
      return {
        result: `The "${toolId}" tool requires user-supplied credentials, which needs a signed-in user. No user identity is available for this run.`,
      };
    }
    const baseUrl = (process.env.BACKEND ?? "").replace(/\/+$/, "");
    if (!baseUrl) {
      return {
        result: `The "${toolId}" tool requires the BACKEND env var to build the credential submit URL.`,
      };
    }
    const values = await getValidUserCredentials(config, userId);
    if (!values) {
      const request = buildCredentialRequest(config, { baseUrl, userId: String(userId) });
      return credentialRequestResult(request);
    }
    try {
      return await execute({ ...inputs, credentials: values }, options);
    } catch (e) {
      if (e instanceof CredentialInvalidError && e.provider === config.provider) {
        await credentialStore.delete(config.provider, userId);
        const request = buildCredentialRequest(config, { baseUrl, userId: String(userId) });
        return credentialRequestResult(request);
      }
      throw e;
    }
  };
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
