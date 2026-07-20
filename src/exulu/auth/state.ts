import { credentialStore } from "./credential-store";
import type { ExuluUserCredentialsConfig } from "./types";

export async function getValidUserCredentials(
  cfg: ExuluUserCredentialsConfig,
  userId: number,
): Promise<Record<string, string> | null> {
  const row = await credentialStore.get(cfg.provider, userId);
  if (!row || row.authType !== "user_credentials") return null;
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(row.data)) {
    if (typeof v !== "string") return null;
    values[k] = v;
  }
  return values;
}
