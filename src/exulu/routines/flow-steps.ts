import type { UIMessage } from "ai";
import { isPendingApprovalToolPart } from "@SRC/exulu/auto-decline-stale-approvals";

/**
 * Variables auto-provided by the email intake pipeline (spec §4.5). An empty
 * subject or body is legal for an email, so these are empty-safe: only
 * undefined/null count as "not provided". User-provided variables keep the
 * legacy strict (truthy) validation.
 */
export const EMAIL_RUN_VARIABLES: Set<string> = new Set([
  "email_from",
  "email_subject",
  "email_body",
]);

/**
 * In-place `{variable_name}` substitution into a step message's text parts.
 * Extracted verbatim from processUiMessagesFlow (ee/workers.ts) with the
 * empty-safe email-variable rule added. Throws the pre-existing error text
 * when a value is missing so callers/tests relying on it keep working.
 */
export const substituteVariablesInMessage = (
  message: UIMessage,
  variables?: Record<string, any>,
): void => {
  for (const part of message.parts) {
    if (part.type !== "text") {
      continue;
    }
    const variableNames = [...part.text.matchAll(/{([^}]+)}/g)].map((match) => match[1]);
    for (const variableName of variableNames) {
      if (!variableName) {
        continue;
      }
      const variableValue = variables?.[variableName];
      const provided = EMAIL_RUN_VARIABLES.has(variableName)
        ? variableValue !== undefined && variableValue !== null
        : Boolean(variableValue);
      if (!provided) {
        throw new Error(
          `Value for variable ${variableName} not provided in variables for processing message flow. Either remove it from the messages, or provide it as an argument.`,
        );
      }
      part.text = part.text.replaceAll(`{${variableName}}`, String(variableValue));
    }
  }
};

/**
 * True when the (final) message of a step ended on an approval-requested tool
 * part — the pause signal for session-backed routine runs (spec §5.3).
 */
export const messageHasPendingApproval = (message: UIMessage | undefined): boolean =>
  !!message?.parts?.some((part) => isPendingApprovalToolPart(part));
