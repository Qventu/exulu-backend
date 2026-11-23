import { decrypt, encrypt } from "@SRC/exulu/auth/credential-store";
import { ChannelSetupError } from "./log";
import {
  REPLY_KEYS,
  type AgentChannelRow,
  type ChannelSecrets,
  type ChannelView,
  type ReplyKey,
  type WhatsAppChannelConfig,
} from "./types";

export class ChannelConfigError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "ChannelConfigError";
    this.field = field;
  }
}

const DEFAULTS = { linkTtlDays: 7, sessionIdleHours: 8, locale: "de" as const };

/** json columns arrive as objects (pg jsonb) or strings — normalize either. */
const parseMaybeJson = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new ChannelConfigError("config", "config is not valid JSON");
  }
};

const nonEmptyString = (field: string, value: unknown): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ChannelConfigError(field, `${field} must be a non-empty string`);
  }
  return value;
};

const boundedInt = (field: string, value: unknown, fallback: number, max: number): number => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new ChannelConfigError(field, `${field} must be an integer between 1 and ${max}`);
  }
  return value;
};

export const parseChannelConfig = (raw: unknown): WhatsAppChannelConfig => {
  const value = parseMaybeJson(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ChannelConfigError("config", "config must be an object");
  }
  const c = value as Record<string, unknown>;

  const locale = c.locale === undefined ? DEFAULTS.locale : c.locale;
  if (locale !== "de" && locale !== "en") {
    throw new ChannelConfigError("locale", 'locale must be "de" or "en"');
  }

  const texts: Partial<Record<ReplyKey, string>> = {};
  if (c.texts !== undefined) {
    if (c.texts === null || typeof c.texts !== "object" || Array.isArray(c.texts)) {
      throw new ChannelConfigError("texts", "texts must be an object");
    }
    for (const [key, text] of Object.entries(c.texts)) {
      if (!(REPLY_KEYS as readonly string[]).includes(key)) {
        throw new ChannelConfigError("texts", `unknown text key "${key}"`);
      }
      if (typeof text !== "string") {
        throw new ChannelConfigError("texts", `text "${key}" must be a string`);
      }
      texts[key as ReplyKey] = text;
    }
  }

  return {
    phoneNumberId: nonEmptyString("phoneNumberId", c.phoneNumberId),
    displayNumber: nonEmptyString("displayNumber", c.displayNumber),
    linkTtlDays: boundedInt("linkTtlDays", c.linkTtlDays, DEFAULTS.linkTtlDays, 365),
    sessionIdleHours: boundedInt("sessionIdleHours", c.sessionIdleHours, DEFAULTS.sessionIdleHours, 168),
    locale,
    texts,
  };
};

export const sealSecrets = (s: ChannelSecrets): string =>
  encrypt(JSON.stringify({ accessToken: s.accessToken, appSecret: s.appSecret }));

export const readSecrets = (row: AgentChannelRow): ChannelSecrets | null => {
  if (!row.secrets) {
    return null;
  }
  try {
    const parsed = JSON.parse(decrypt(row.secrets));
    if (
      typeof parsed?.accessToken === "string" &&
      parsed.accessToken !== "" &&
      typeof parsed?.appSecret === "string" &&
      parsed.appSecret !== ""
    ) {
      return { accessToken: parsed.accessToken, appSecret: parsed.appSecret };
    }
    return null;
  } catch {
    return null;
  }
};

export const canEnableChannel = (agent: {
  guest_access?: boolean | null;
  guest_auth_mode?: string | null;
}): { ok: true } | { ok: false; reason: "guest_access_off" | "guest_mode_not_regular" } => {
  if (!agent.guest_access) {
    return { ok: false, reason: "guest_access_off" };
  }
  // null/undefined means regular, as in publicAgentView
  if (agent.guest_auth_mode != null && agent.guest_auth_mode !== "regular") {
    return { ok: false, reason: "guest_mode_not_regular" };
  }
  return { ok: true };
};

export const channelView = (row: AgentChannelRow): ChannelView => ({
  id: row.id,
  agent: row.agent,
  type: row.type,
  enabled: row.enabled,
  config: parseChannelConfig(row.config),
  hasSecrets: !!row.secrets,
  needsCredentials: readSecrets(row) === null,
});

/** Identity is opaque: only the last four characters are shown. */
export const maskIdentity = (identity: string): string =>
  identity.length < 4 ? "••••" : `•••• ${identity.slice(-4)}`;

/**
 * The page where a signed-in user gets a link code (the `linkRequired` reply and the link
 * route). FRONTEND, the installation's public web address, is the normal source.
 * CHANNEL_LINK_BASE_URL overrides it where customers use a hostname of their own;
 * NEXTAUTH_URL is the last fallback.
 */
export const linkPageUrl = (agentId: string): string => {
  const base = [process.env.CHANNEL_LINK_BASE_URL, process.env.FRONTEND, process.env.NEXTAUTH_URL]
    .map((v) => (v ?? "").trim())
    .find((v) => v !== "");
  if (!base) {
    throw new ChannelSetupError("None of CHANNEL_LINK_BASE_URL, FRONTEND and NEXTAUTH_URL is set; the channel link page has no URL");
  }
  return `${base.replace(/\/+$/, "")}/public/agents/${encodeURIComponent(agentId)}/link/whatsapp`;
};
