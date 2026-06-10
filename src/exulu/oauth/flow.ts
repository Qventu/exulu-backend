import CryptoJS from "crypto-js";
import { createHash, randomBytes } from "node:crypto";
import type { ExuluOauthConfig } from "./types";
import { oauthTokenStore, type OauthTokenRecord } from "./token-store";

export const OAUTH_CALLBACK_PATH = "/oauth/callback";
const STATE_TTL_MS = 10 * 60 * 1000;
// Treat tokens about to expire as expired so they don't die mid-request.
const EXPIRY_SKEW_MS = 30 * 1000;

export const getOauthRedirectUri = () => {
  if (!process.env.BACKEND) {
    throw new Error(
      "[EXULU] The BACKEND environment variable (the backend's public base URL) is required to build the OAuth redirect URI.",
    );
  }
  return process.env.BACKEND.replace(/\/+$/, "") + OAUTH_CALLBACK_PATH;
};

export type OauthState = {
  toolId: string;
  userId: number;
  codeVerifier?: string;
  exp: number;
};

// CryptoJS emits standard base64 whose +/= characters get mangled in query
// strings; convert to base64url for transport.
const toBase64Url = (base64: string) =>
  base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (value: string) => {
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  return base64;
};

export const encryptOauthState = (state: OauthState): string =>
  toBase64Url(CryptoJS.AES.encrypt(JSON.stringify(state), process.env.NEXTAUTH_SECRET).toString());

/**
 * Decrypts and validates a state parameter. Decryptability with
 * NEXTAUTH_SECRET doubles as the authenticity check: a forged or tampered
 * state never yields valid JSON. Throws on any invalid or expired state.
 */
export const decryptOauthState = (value: string): OauthState => {
  let json = "";
  try {
    json = CryptoJS.AES.decrypt(fromBase64Url(value), process.env.NEXTAUTH_SECRET).toString(
      CryptoJS.enc.Utf8,
    );
  } catch {
    throw new Error("[EXULU] Invalid OAuth state.");
  }
  let state: OauthState;
  try {
    state = JSON.parse(json);
  } catch {
    throw new Error("[EXULU] Invalid OAuth state.");
  }
  if (!state?.toolId || !state?.userId || !state?.exp) {
    throw new Error("[EXULU] Invalid OAuth state.");
  }
  if (Date.now() > state.exp) {
    throw new Error("[EXULU] OAuth state expired.");
  }
  return state;
};

export const buildAuthorizationUrl = ({
  toolId,
  userId,
  config,
}: {
  toolId: string;
  userId: number;
  config: ExuluOauthConfig;
}): string => {
  const pkce = config.pkce !== false;
  const codeVerifier = pkce ? randomBytes(48).toString("base64url") : undefined;
  const state = encryptOauthState({
    toolId,
    userId,
    codeVerifier,
    exp: Date.now() + STATE_TTL_MS,
  });
  const url = new URL(config.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", getOauthRedirectUri());
  if (config.scopes.length) {
    url.searchParams.set("scope", config.scopes.join(" "));
  }
  url.searchParams.set("state", state);
  if (codeVerifier) {
    url.searchParams.set(
      "code_challenge",
      createHash("sha256").update(codeVerifier).digest("base64url"),
    );
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [key, value] of Object.entries(config.extraAuthParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
};

type TokenEndpointResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
};

const tokenResponseToRecord = (
  data: TokenEndpointResponse,
  config: ExuluOauthConfig,
): OauthTokenRecord => ({
  accessToken: data.access_token,
  refreshToken: data.refresh_token ?? null,
  tokenType: data.token_type ?? null,
  scopes: data.scope ?? (config.scopes.length ? config.scopes.join(" ") : null),
  expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
});

const postTokenEndpoint = async (
  config: ExuluOauthConfig,
  params: Record<string, string>,
): Promise<TokenEndpointResponse> => {
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // Some providers (e.g. GitHub) default to urlencoded responses.
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      ...params,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`[EXULU] OAuth token endpoint returned ${response.status}: ${text}`);
  }
  let data: TokenEndpointResponse;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("[EXULU] OAuth token endpoint returned a non-JSON response.");
  }
  if (!data.access_token) {
    throw new Error(`[EXULU] OAuth token endpoint response is missing access_token: ${text}`);
  }
  return data;
};

export const exchangeCodeForTokens = async ({
  config,
  code,
  codeVerifier,
}: {
  config: ExuluOauthConfig;
  code: string;
  codeVerifier?: string;
}): Promise<OauthTokenRecord> =>
  tokenResponseToRecord(
    await postTokenEndpoint(config, {
      grant_type: "authorization_code",
      code,
      redirect_uri: getOauthRedirectUri(),
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    }),
    config,
  );

export const refreshAccessToken = async ({
  config,
  refreshToken,
}: {
  config: ExuluOauthConfig;
  refreshToken: string;
}): Promise<OauthTokenRecord> =>
  tokenResponseToRecord(
    await postTokenEndpoint(config, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    config,
  );

/**
 * Returns a usable access token for (toolId, userId), transparently refreshing
 * an expired one. Returns null when the user needs to (re-)authorize — stale
 * rows are deleted so the caller falls back to the authorization path.
 */
export const getValidAccessToken = async ({
  toolId,
  userId,
  config,
}: {
  toolId: string;
  userId: number;
  config: ExuluOauthConfig;
}): Promise<OauthTokenRecord | null> => {
  const stored = await oauthTokenStore.get(toolId, userId);
  if (!stored) {
    return null;
  }
  const expired = stored.expiresAt
    ? stored.expiresAt.getTime() <= Date.now() + EXPIRY_SKEW_MS
    : false;
  if (!expired) {
    return stored;
  }
  if (!stored.refreshToken) {
    await oauthTokenStore.delete(toolId, userId);
    return null;
  }
  try {
    const refreshed = await refreshAccessToken({ config, refreshToken: stored.refreshToken });
    if (!refreshed.refreshToken) {
      refreshed.refreshToken = stored.refreshToken;
    }
    await oauthTokenStore.upsert(toolId, userId, refreshed);
    return refreshed;
  } catch (error) {
    console.error(
      `[EXULU] OAuth token refresh failed for tool "${toolId}" user ${userId}:`,
      error,
    );
    await oauthTokenStore.delete(toolId, userId);
    return null;
  }
};
