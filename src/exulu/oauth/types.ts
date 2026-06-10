/**
 * OAuth 2.0 configuration for an {@link ExuluTool}. When a tool is constructed
 * with an `oauth` property, Exulu wraps its `execute` so it only runs when a
 * valid access token exists for the calling (toolId, userId) pair. When no
 * valid token exists the tool short-circuits and returns an authorization URL
 * the agent can show the user; the generic /oauth/callback route completes the
 * flow and persists the tokens.
 *
 * Only the standard authorization-code grant is supported. All values are
 * declared in code (source them from env vars or however you like) — none of
 * them are exposed as admin-configurable tool config.
 */
export type ExuluOauthConfig = {
  /** The provider's authorization endpoint, e.g. https://app.hubspot.com/oauth/authorize */
  authorizationUrl: string;
  /** The provider's token endpoint, e.g. https://api.hubapi.com/oauth/v1/token */
  tokenUrl: string;
  clientId: string;
  /** Never leaves the server: used only in the server-side token exchange. */
  clientSecret: string;
  /** Scopes to request; joined with spaces in the authorization URL. */
  scopes: string[];
  /** PKCE (S256). Defaults to true; set false for providers that reject PKCE. */
  pkce?: boolean;
  /**
   * Extra query params appended to the authorization URL, e.g.
   * `{ access_type: "offline", prompt: "consent" }` to make Google return a
   * refresh token.
   */
  extraAuthParams?: Record<string, string>;
};

/** The oauth context injected into an oauth-enabled tool's execute inputs. */
export type ExuluOauthToolContext = {
  accessToken: string;
  /** null when the provider did not report an expiry. */
  expiresAt: Date | null;
  /** Space-joined scopes the token was granted, when reported by the provider. */
  scopes: string | null;
};
