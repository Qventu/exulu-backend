import type { InboundEmail } from "./types";

export type IntakeWarning = "attachment_mentioned_but_none_received";

/**
 * German + English phrasings that announce an attachment in the body.
 * Deliberately NOT the bare word "Anlage": in ALGI's mails it almost always
 * means the elevator installation ("unsere Anlage 1622223", "keine echte
 * Anlage"), which produced a false warning on 2026-10-28; only the phrase
 * "als Anlage" announces an attachment.
 */
const MENTIONS_ATTACHMENT =
  /\b(anbei|anliegend|beigef[üu]gt|im anhang|als anhang|anhang|als anlage|attached|attachment|enclosed)\b/i;

export const INTAKE_WARNING_TEXTS: Record<IntakeWarning, string> = {
  attachment_mentioned_but_none_received:
    "Die E-Mail erwähnt einen Anhang, es wurde aber kein Anhang übermittelt (0 Dateien im Payload). " +
    "Nicht raten, welches Teil gemeint ist: um den Anhang oder die konkreten Positionen bitten.",
};

/**
 * Soft problems with an inbound mail that do not justify failing the run but
 * that the agent and the reviewer must see: today only "the sender announced
 * an attachment and the payload carried none" (ALGI, 2026-10-13 and
 * 2026-10-23 — the agent then guessed a part and sent a wrong offer to the ERP).
 */
export function detectIntakeWarnings(email: Pick<InboundEmail, "text" | "attachments">): IntakeWarning[] {
  const warnings: IntakeWarning[] = [];
  if (email.attachments.length === 0 && MENTIONS_ATTACHMENT.test(email.text ?? "")) {
    warnings.push("attachment_mentioned_but_none_received");
  }
  return warnings;
}
