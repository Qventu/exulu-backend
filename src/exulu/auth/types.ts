/**
 * OAuth 2.0 configuration for an {@link ExuluTool}. When a tool is constructed
 * with an `oauth` property, Exulu wraps its `execute` so it only runs when a
 * valid access token exists for the calling (providerKey, userId) pair — where
 * providerKey defaults to the tool's id but can be shared across tools by
 * setting the "provider" field below. When no valid token exists the tool
 * short-circuits and returns an authorization URL the agent can show the user;
 * the generic /oauth/callback route completes the flow and persists the tokens.
 *
 * Only the standard authorization-code grant is supported. All values are
 * declared in code (source them from env vars or however you like) — none of
 * them are exposed as admin-configurable tool config.
 */
export interface ExuluOauthConfig {
  authType: "oauth";
  /**
   * Identifier for the OAuth provider (e.g., "google", "jira", "github").
   * Tools sharing the same provider share tokens under (provider, userId) —
   * one consent screen per provider per user instead of per tool. When
   * omitted, defaults to the tool's `id`, preserving per-tool behavior for
   * tools that don't opt in.
   */
  provider: string;
  /** The provider's authorization endpoint, e.g. https://app.hubspot.com/oauth/authorize */
  authorizationUrl: string;
  /** The provider's token endpoint, e.g. https://api.hubapi.com/oauth/v1/token */
  tokenUrl: string;
  clientId: string;
  /** Never leaves the server: used only in the server-side token exchange. */
  clientSecret: string;
  /** Scopes to request; joined with spaces in the authorization URL. */
  scopes: readonly string[];
  /** PKCE (S256). Defaults to true; set false for providers that reject PKCE. */
  pkce?: boolean;
  /**
   * Extra query params appended to the authorization URL, e.g.
   * `{ access_type: "offline", prompt: "consent" }` to make Google return a
   * refresh token.
   */
  extraAuthParams?: Record<string, string>;
}

export interface CredentialField {
  name: string;
  label: string;
  type: "text" | "password";
  placeholder?: string;
  help?: string;
}

export interface ExuluUserCredentialsConfig {
  authType: "user_credentials";
  provider: string;
  fields: CredentialField[];
  validate?: (values: Record<string, string>) => Promise<void>;
}

export type ExuluAuthConfig = ExuluOauthConfig | ExuluUserCredentialsConfig;

export interface ExuluCredentialsToolContext {
  userId: string;
  provider: string;
  credentials: Record<string, string>;
}

/** The oauth context injected into an oauth-enabled tool's execute inputs. */
export type ExuluOauthToolContext = {
  accessToken: string;
  /** null when the provider did not report an expiry. */
  expiresAt: Date | null;
  /** Space-joined scopes the token was granted, when reported by the provider. */
  scopes: string | null;
};
