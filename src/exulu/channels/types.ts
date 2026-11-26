export type ChannelType = "whatsapp";
export type ChannelLocale = "de" | "en";

/** Single source for the reply keys; texts.ts re-exports the type. */
export const REPLY_KEYS = [
  "linkRequired",
  "linked",
  "codeInvalid",
  "textOnly",
  "rateLimited",
  "stillWorking",
  "runFailed",
  "newSession",
  "unlinked",
] as const;
export type ReplyKey = (typeof REPLY_KEYS)[number];

export interface WhatsAppChannelConfig {
  phoneNumberId: string;
  displayNumber: string;
  linkTtlDays: number;
  sessionIdleHours: number;
  locale: ChannelLocale;
  texts: Partial<Record<ReplyKey, string>>;
}

export interface ChannelSecrets {
  accessToken: string;
  appSecret: string;
}

export interface AgentChannelRow {
  id: string;
  agent: string;
  type: ChannelType;
  enabled: boolean;
  config: unknown;
  secrets: string | null;
  verify_token: string | null;
  updatedAt: string | Date;
}

/** The ONLY projection any API may return. Never add secret material here. */
export interface ChannelView {
  id: string;
  agent: string;
  type: ChannelType;
  enabled: boolean;
  config: WhatsAppChannelConfig;
  hasSecrets: boolean;
  needsCredentials: boolean;
}
