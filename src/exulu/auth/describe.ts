import { credentialStore } from "./credential-store";
import { providerKeyFor } from "./provider-key";
import type { ExuluAuthConfig } from "./types";

// Narrow read type — deliberately omits accessToken/refreshToken so they
// never enter scope here (defense-in-depth against leaking secrets).
type OauthNonSecret = { scopes?: string | null; expiresAt?: string | null };

export type CredentialIdentity = {
  provider: string;
  authType: "oauth" | "user_credentials";
  account: string;
  scopes?: string[];
  expiresAt?: string | null;
};

export const describeCredentialIdentity = async (
  auth: ExuluAuthConfig,
  userId: number,
  toolId?: string,
): Promise<CredentialIdentity | undefined> => {
  const provider = providerKeyFor(toolId ?? auth.provider, auth);
  const base: CredentialIdentity = {
    provider,
    authType: auth.authType,
    account: String(userId),
  };
  if (auth.authType !== "oauth") return base;
  try {
    const row = await credentialStore.get(provider, userId);
    if (!row || row.authType !== "oauth") return base;
    const { scopes, expiresAt } = row.data as OauthNonSecret;
    return {
      ...base,
      ...(scopes ? { scopes: scopes.split(" ").filter(Boolean) } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
  } catch (error) {
    console.error(`[EXULU] describeCredentialIdentity failed for provider "${provider}":`, error);
    return base;
  }
};
