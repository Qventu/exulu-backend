import type { ChannelLocale, ReplyKey, WhatsAppChannelConfig } from "./types";

export type { ReplyKey } from "./types";

export interface ReplyVars {
  linkUrl?: string;
  expiresAt?: Date;
}

const DEFAULTS: Record<ChannelLocale, Record<ReplyKey, string>> = {
  de: {
    linkRequired:
      "Hallo! Bevor ich dir antworten kann, musst du deine Nummer verknüpfen. Öffne diesen Link, melde dich an und sende mir den Code, den du dort bekommst:\n{linkUrl}",
    linked:
      "Deine Nummer ist verknüpft, und zwar bis zum {expiresAt}. Du kannst mir jetzt deine Frage stellen.",
    codeInvalid:
      "Dieser Code ist falsch oder abgelaufen. Öffne den Link erneut, um einen neuen Code zu bekommen, und sende ihn mir.",
    textOnly:
      "Ich kann im Moment nur Textnachrichten verarbeiten. Bitte schreib mir deine Frage als Text.",
    rateLimited:
      "Du hast gerade sehr viele Anfragen gestellt. Bitte versuche es später noch einmal.",
    stillWorking:
      "Ich bin noch mit deiner vorherigen Frage beschäftigt. Bitte warte einen Moment, bis ich geantwortet habe.",
    runFailed: "Leider ist etwas schiefgelaufen. Bitte versuche es noch einmal.",
    newSession: "Alles klar, wir starten ein neues Gespräch. Was möchtest du wissen?",
    unlinked:
      "Deine Nummer wurde getrennt. Wenn du mir wieder schreibst, bekommst du einen neuen Link zum Verknüpfen.",
  },
  en: {
    linkRequired:
      "Hello! Before I can answer, you need to link your number. Open this link, sign in and send me the code you get there:\n{linkUrl}",
    linked: "Your number is linked until {expiresAt}. You can ask your question now.",
    codeInvalid:
      "That code is wrong or has expired. Open the link again to get a new code and send it to me.",
    textOnly: "I can only handle text messages at the moment. Please write your question as text.",
    rateLimited: "You have sent a lot of requests just now. Please try again later.",
    stillWorking:
      "I am still answering your previous question. Please wait a moment until I have replied.",
    runFailed: "Sorry, something went wrong. Please try again.",
    newSession: "Okay, we are starting a new conversation. What would you like to know?",
    unlinked:
      "Your number has been disconnected. When you write to me again, you will get a new link to connect it.",
  },
};

const pad = (n: number): string => String(n).padStart(2, "0");

const formatDate = (date: Date, locale: ChannelLocale): string => {
  const d = pad(date.getUTCDate());
  const m = pad(date.getUTCMonth() + 1);
  const y = String(date.getUTCFullYear());
  return locale === "de" ? `${d}.${m}.${y}` : `${y}-${m}-${d}`;
};

export const replyText = (
  key: ReplyKey,
  config: WhatsAppChannelConfig,
  vars: ReplyVars = {},
): string => {
  const override = config.texts?.[key];
  const template = override ? override : DEFAULTS[config.locale][key];
  const values: Record<string, string | undefined> = {
    linkUrl: vars.linkUrl,
    expiresAt: vars.expiresAt ? formatDate(vars.expiresAt, config.locale) : undefined,
  };
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
};
