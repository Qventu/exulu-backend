import CryptoJS from "crypto-js";
import { postgresClient } from "@SRC/postgres/client";

export type OauthTokenRecord = {
  accessToken: string;
  refreshToken?: string | null;
  tokenType?: string | null;
  /** Space-joined scopes as reported by the provider. */
  scopes?: string | null;
  /** null = the provider reported no expiry; treated as non-expiring. */
  expiresAt?: Date | null;
};

const TABLE = "oauth_tokens";

// Same at-rest encryption pattern as the variables table (see ExuluVariables
// in src/index.ts).
const encrypt = (value: string) =>
  CryptoJS.AES.encrypt(value, process.env.NEXTAUTH_SECRET).toString();
const decrypt = (value: string) =>
  CryptoJS.AES.decrypt(value, process.env.NEXTAUTH_SECRET).toString(CryptoJS.enc.Utf8);

export const oauthTokenStore = {
  get: async (toolId: string, userId: number): Promise<OauthTokenRecord | null> => {
    const { db } = await postgresClient();
    const row = await db.from(TABLE).where({ tool_id: toolId, user_id: userId }).first();
    if (!row) {
      return null;
    }
    return {
      accessToken: decrypt(row.access_token),
      refreshToken: row.refresh_token ? decrypt(row.refresh_token) : null,
      tokenType: row.token_type ?? null,
      scopes: row.scopes ?? null,
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    };
  },

  upsert: async (toolId: string, userId: number, record: OauthTokenRecord) => {
    const { db } = await postgresClient();
    const existing = await db.from(TABLE).where({ tool_id: toolId, user_id: userId }).first();
    const values = {
      access_token: encrypt(record.accessToken),
      // Providers like Google only send a refresh_token on first consent;
      // never overwrite a stored one with nothing.
      refresh_token: record.refreshToken
        ? encrypt(record.refreshToken)
        : (existing?.refresh_token ?? null),
      token_type: record.tokenType ?? null,
      scopes: record.scopes ?? null,
      expires_at: record.expiresAt ?? null,
      updatedAt: new Date(),
    };
    if (existing) {
      await db.from(TABLE).where({ tool_id: toolId, user_id: userId }).update(values);
    } else {
      await db.from(TABLE).insert({ tool_id: toolId, user_id: userId, ...values });
    }
  },

  delete: async (toolId: string, userId: number) => {
    const { db } = await postgresClient();
    await db.from(TABLE).where({ tool_id: toolId, user_id: userId }).del();
  },
};
