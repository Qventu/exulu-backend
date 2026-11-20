import type { AccessOutcome } from "./access";
import { normalizeCode } from "./link-codes";
import { linkState, type ChannelLink, type createLinkStore } from "./links";
import type { ReplyKey, WhatsAppChannelConfig } from "./types";

export interface InboundMessage {
  channelId: string;
  threadId: string;
  /** Authenticated WhatsApp sender. Opaque: never parse it. */
  identity: string;
  messageId: string;
  text: string;
  hasAttachments: boolean;
}

export type Decision =
  | { kind: "reply"; key: ReplyKey; vars?: { linkUrl?: string; expiresAt?: Date } }
  | { kind: "silent" }
  | { kind: "run"; userId: number; newSession: boolean };

export interface DecideDeps {
  now: () => Date;
  config: WhatsAppChannelConfig;
  /** Built only when a linkRequired reply is sent; may throw ChannelSetupError (no URL configured). */
  linkUrl: () => string;
  links: Pick<ReturnType<typeof createLinkStore>, "find" | "upsert" | "revoke" | "touch">;
  consumeCode(code: string): Promise<{ channelId: string; userId: number } | null>;
  /** Counts the attempt when called: call once per code-shaped message only. */
  codeAttemptsExceeded(identity: string): Promise<boolean>;
  linkPromptAllowed(identity: string): Promise<boolean>;
  /**
   * channelAccessCheck for this channel's agent. "unavailable" (the check itself failed) is
   * never treated as "denied": no run and no reply, but the link is kept.
   */
  access(userId: number): Promise<AccessOutcome>;
  rateLimited(userId: number): boolean;
  runInFlight(identity: string): Promise<boolean>;
  markNewSession(identity: string): Promise<void>;
  takeNewSession(identity: string): Promise<boolean>;
  audit(event: {
    type: "linked" | "unlinked" | "revoked" | "code_lockout" | "access_rejected";
    identity: string;
    userId?: number;
  }): void;
}

/**
 * The backend has no deactivation rule today: sign-in (`authentication` in
 * src/auth/auth.ts) refuses only a missing user row. `users.status` exists as
 * a column but nothing reads it. So every existing row is active. This is the
 * single place to add a rule if one is introduced; keep it identical to the
 * sign-in check.
 */
export const isUserActive = (user: { status?: string | null } | undefined): boolean =>
  user !== undefined;

const NEW_SESSION_COMMANDS = new Set(["/neu", "/new"]);
const LOGOUT_COMMANDS = new Set(["/abmelden", "/logout"]);

const reply = (key: ReplyKey, vars?: { linkUrl?: string; expiresAt?: Date }): Decision =>
  vars ? { kind: "reply", key, vars } : { kind: "reply", key };

/** Step 4 outcome: ask to link, at most once per window, otherwise stay silent. */
const notLinked = async (msg: InboundMessage, deps: DecideDeps): Promise<Decision> =>
  (await deps.linkPromptAllowed(msg.identity))
    ? reply("linkRequired", { linkUrl: deps.linkUrl() })
    : { kind: "silent" };

/**
 * Spec 5.5. `decision` is set when the code settles the message: linked, or silent when the
 * access check could not be made. It is unset when the code does not settle it (locked out,
 * unknown, wrong channel, access denied); decideInbound then answers an unlinked sender with
 * silence or codeInvalid and handles a sender with a valid link as a normal message (R6).
 * `codeAttemptsExceeded` is called exactly once and `consumeCode` is skipped while locked out.
 */
const tryCode = async (
  code: string,
  msg: InboundMessage,
  deps: DecideDeps,
): Promise<{ decision?: Decision; lockedOut: boolean }> => {
  if (await deps.codeAttemptsExceeded(msg.identity)) {
    deps.audit({ type: "code_lockout", identity: msg.identity });
    return { lockedOut: true };
  }
  const consumed = await deps.consumeCode(code);
  if (!consumed || consumed.channelId !== msg.channelId) return { lockedOut: false };
  const access = await deps.access(consumed.userId);
  // could not check: the code is spent, but nothing is linked and nothing is said
  if (access === "unavailable") return { decision: { kind: "silent" }, lockedOut: false };
  if (access !== "allowed") return { lockedOut: false };
  const link = await deps.links.upsert({
    channelId: msg.channelId,
    identity: msg.identity,
    userId: consumed.userId,
    linkTtlDays: deps.config.linkTtlDays,
    now: deps.now(),
  });
  deps.audit({ type: "linked", identity: msg.identity, userId: consumed.userId });
  return { decision: reply("linked", { expiresAt: link.expires_at }), lockedOut: false };
};

export const decideInbound = async (msg: InboundMessage, deps: DecideDeps): Promise<Decision> => {
  const text = msg.text.trim();

  // 1. Not text.
  if (msg.hasAttachments || text === "") return reply("textOnly");

  // 2. Link code. A code that links is answered here and never reaches the model. A code-shaped
  // message that does not link (unknown, wrong channel, locked out, access denied) is, for a
  // sender with a valid link, handled as a normal message from step 3 on, so a short real
  // message ("Fehler 42") is not swallowed; an unlinked sender gets codeInvalid or silence.
  const code = normalizeCode(text);
  let codeLockedOut = false;
  if (code !== null) {
    const tried = await tryCode(code, msg, deps);
    if (tried.decision) return tried.decision;
    codeLockedOut = tried.lockedOut;
  }

  const now = deps.now();
  const found: ChannelLink | undefined = await deps.links.find(msg.channelId, msg.identity);
  const state = linkState(found, now);
  if (code !== null && state.state !== "valid") {
    return codeLockedOut ? { kind: "silent" } : reply("codeInvalid");
  }

  // 3. Commands, whole trimmed message. Without a usable link they fall through to step 4.
  const command = text.toLowerCase();
  if (NEW_SESSION_COMMANDS.has(command) && state.state === "valid") {
    await deps.markNewSession(msg.identity);
    return reply("newSession");
  }
  if (LOGOUT_COMMANDS.has(command) && found && (state.state === "valid" || state.state === "expired")) {
    await deps.links.revoke(found.id, now);
    deps.audit({ type: "unlinked", identity: msg.identity, userId: found.user });
    return reply("unlinked");
  }

  // 4. Resolve the link.
  if (state.state !== "valid") return notLinked(msg, deps);
  const link = state.link;

  // 5. Re-check access on every message. A failed check is not a refusal: no run, no reply,
  // and the link stays, so a transient database or agent-load error never unlinks anyone.
  const access = await deps.access(link.user);
  if (access === "unavailable") return { kind: "silent" };
  if (access !== "allowed") {
    await deps.links.revoke(link.id, now);
    deps.audit({ type: "access_rejected", identity: msg.identity, userId: link.user });
    return notLinked(msg, deps);
  }

  // 6. Rate limit.
  if (deps.rateLimited(link.user)) return reply("rateLimited");

  // 7. A run is already in flight.
  if (await deps.runInFlight(msg.identity)) return reply("stillWorking");

  // 8. Run as the linked user. The only way to "run".
  await deps.links.touch(link.id, now);
  return { kind: "run", userId: link.user, newSession: await deps.takeNewSession(msg.identity) };
};
