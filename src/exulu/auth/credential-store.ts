import CryptoJS from "crypto-js";
import { postgresClient } from "@SRC/postgres/client";

const TABLE = "user_credentials";

// Same at-rest encryption pattern as the variables table (see ExuluVariables
// in src/index.ts). Exported for reuse by other secret-at-rest stores
// (email-inbound signing key).
export const encrypt = (value: string) =>
  CryptoJS.AES.encrypt(value, process.env.NEXTAUTH_SECRET).toString();
export const decrypt = (value: string) =>
  CryptoJS.AES.decrypt(value, process.env.NEXTAUTH_SECRET).toString(CryptoJS.enc.Utf8);

export type AuthType = "oauth" | "user_credentials";

export interface CredentialRecord {
  provider: string;
  userId: number;
  authType: AuthType;
  data: Record<string, unknown>;
}

async function get(provider: string, userId: number): Promise<CredentialRecord | null> {
  const { db } = await postgresClient();
  const row = await db
    .from(TABLE)
    .where({ provider, user_id: String(userId) })
    .first();
  if (!row) {
    return null;
  }
  return {
    provider,
    userId,
    authType: row.auth_type as AuthType,
    data: JSON.parse(decrypt(row.data)) as Record<string, unknown>,
  };
}

async function upsert(record: CredentialRecord): Promise<void> {
  const { db } = await postgresClient();
  const encrypted = encrypt(JSON.stringify(record.data));
  // Atomic — the previous read-then-insert raced concurrent first-time
  // submits into unique-constraint 500s (spec §1.1).
  await db
    .from(TABLE)
    .insert({
      provider: record.provider,
      user_id: String(record.userId),
      auth_type: record.authType,
      data: encrypted,
      updated_at: new Date(),
    })
    .onConflict(["provider", "user_id"])
    .merge({ auth_type: record.authType, data: encrypted, updated_at: new Date() });
}

/** Metadata only — values never leave the store through this path. */
async function listByUser(
  userId: number,
): Promise<{ provider: string; authType: AuthType; createdAt: Date; updatedAt: Date }[]> {
  const { db } = await postgresClient();
  const list = await db
    .from(TABLE)
    .where({ user_id: String(userId) })
    .orderBy("provider");
  return list.map((row: any) => ({
    provider: row.provider,
    authType: row.auth_type as AuthType,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function del(provider: string, userId: number): Promise<void> {
  const { db } = await postgresClient();
  await db.from(TABLE).where({ provider, user_id: String(userId) }).del();
}

export const credentialStore = { get, upsert, listByUser, delete: del };
