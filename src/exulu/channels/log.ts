/**
 * What the channel code may log about an error: its class and, if present, a short
 * string `code` (Postgres SQLSTATE, Node errno names). Never `message`, `stack`,
 * `detail` or `cause`: knex inlines bindings (phone numbers, message text) into the
 * message, and Graph API errors can quote the recipient.
 */
export interface SafeError {
  name: string;
  code?: string;
  /** only for ChannelSetupError */
  message?: string;
}

/**
 * An error whose message is written by this module and never contains user data
 * (configuration problems, unavailable infrastructure). safeError keeps its message,
 * so the operator can see the cause.
 */
export class ChannelSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelSetupError";
  }
}

const CODE = /^[A-Za-z0-9_.-]{1,32}$/;

export const safeError = (error: unknown): SafeError => {
  const name =
    error instanceof Error
      ? error.constructor?.name && error.constructor.name !== "Object"
        ? error.constructor.name
        : "Error"
      : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  const safe: SafeError = typeof code === "string" && CODE.test(code) ? { name, code } : { name };
  if (error instanceof ChannelSetupError) safe.message = error.message;
  return safe;
};

/** A plain Error carrying only the safe parts, for errors that leave the channel code (BullMQ stores failedReason). */
export const sanitizedError = (context: string, error: unknown): Error => {
  const safe = safeError(error);
  return new Error(`${context} (${safe.name}${safe.code ? ` ${safe.code}` : ""}${safe.message ? `: ${safe.message}` : ""})`);
};
