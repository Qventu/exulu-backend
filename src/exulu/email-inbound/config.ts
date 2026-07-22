// Platform-level inbound email settings (spec §3.5): platform_configurations
// key "email_inbound". The Mailgun HTTP webhook signing key is AES-encrypted
// at rest with the same crypto as oauth_tokens and is write-only via the API
// (GraphQL only ever exposes has_signing_key).
import { decrypt, encrypt } from "@SRC/exulu/auth/credential-store";

export const EMAIL_INBOUND_CONFIG_KEY = "email_inbound";

export interface EmailInboundConfig {
  provider: string | null;
  inbound_domain: string | null;
  enabled: boolean;
  last_webhook_at: string | null;
  /** Decrypted signing key — internal use only; NEVER return via the API. */
  signing_key: string | null;
}

const parseValue = (value: unknown): Record<string, unknown> => {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return value as Record<string, unknown>;
};

const readRawValue = async (db: any): Promise<Record<string, unknown>> => {
  const row = await db
    .from("platform_configurations")
    .where({ config_key: EMAIL_INBOUND_CONFIG_KEY })
    .first();
  return parseValue(row?.config_value);
};

const writeRawValue = async (db: any, value: Record<string, unknown>): Promise<void> => {
  await db
    .from("platform_configurations")
    .insert({
      config_key: EMAIL_INBOUND_CONFIG_KEY,
      config_value: JSON.stringify(value),
      description: "Inbound email settings for email-triggered routines (signing key AES-encrypted)",
    })
    .onConflict("config_key")
    .merge({ config_value: JSON.stringify(value) });
};

const toConfig = (raw: Record<string, unknown>): EmailInboundConfig => ({
  provider: typeof raw.provider === "string" ? raw.provider : null,
  inbound_domain: typeof raw.inbound_domain === "string" ? raw.inbound_domain : null,
  enabled: raw.enabled === true,
  last_webhook_at: typeof raw.last_webhook_at === "string" ? raw.last_webhook_at : null,
  signing_key: typeof raw.signing_key === "string" && raw.signing_key.length > 0
    ? decrypt(raw.signing_key)
    : null,
});

export async function getEmailInboundConfig(db: any): Promise<EmailInboundConfig> {
  return toConfig(await readRawValue(db));
}

export async function updateEmailInboundConfig(
  db: any,
  patch: { provider?: string; inbound_domain?: string; enabled?: boolean; signing_key?: string },
): Promise<EmailInboundConfig> {
  const raw = await readRawValue(db);
  const next: Record<string, unknown> = {
    ...raw,
    ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
    ...(patch.inbound_domain !== undefined ? { inbound_domain: patch.inbound_domain } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    // Key rotation = overwrite (spec §3.5); empty/omitted keeps the stored key.
    ...(patch.signing_key ? { signing_key: encrypt(patch.signing_key) } : {}),
  };
  await writeRawValue(db, next);
  return toConfig(next);
}

/** Setup debugging aid (spec §3.5): stamped on every VERIFIED webhook. */
export async function bumpLastWebhookAt(db: any): Promise<void> {
  const raw = await readRawValue(db);
  await writeRawValue(db, { ...raw, last_webhook_at: new Date().toISOString() });
}
