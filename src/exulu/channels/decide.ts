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
  linkUrl: string;
  links: Pick<ReturnType<typeof createLinkStore>, "find" | "upsert" | "revoke" | "touch">;
  consumeCode(code: string): Promise<{ channelId: string; userId: number } | null>;
  /** Counts the attempt when called: call once per code-shaped message only. */
  codeAttemptsExceeded(identity: string): Promise<boolean>;
  linkPromptAllowed(identity: string): Promise<boolean>;
  /** User exists, isUserActive, and evaluateGuestChatAccess allows. */
  accessAllowed(userId: number): Promise<boolean>;
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
    ? reply("linkRequired", { linkUrl: deps.linkUrl })
    : { kind: "silent" };

/** Spec 5.5. Called exactly once per code-shaped message. */
const handleCode = async (
  code: string,
  msg: InboundMessage,
  deps: DecideDeps,
): Promise<Decision> => {
  if (await deps.codeAttemptsExceeded(msg.identity)) {
    deps.audit({ type: "code_lockout", identity: msg.identity });
    return { kind: "silent" };
  }
  const consumed = await deps.consumeCode(code);
  if (!consumed || consumed.channelId !== msg.channelId) return reply("codeInvalid");
  if (!(await deps.accessAllowed(consumed.userId))) return reply("codeInvalid");
  const link = await deps.links.upsert({
    channelId: msg.channelId,
    identity: msg.identity,
    userId: consumed.userId,
    linkTtlDays: deps.config.linkTtlDays,
    now: deps.now(),
  });
  deps.audit({ type: "linked", identity: msg.identity, userId: consumed.userId });
  return reply("linked", { expiresAt: link.expires_at });
};

export const decideInbound = async (msg: InboundMessage, deps: DecideDeps): Promise<Decision> => {
  const text = msg.text.trim();

  // 1. Not text.
  if (msg.hasAttachments || text === "") return reply("textOnly");

  // 2. Link code: never forwarded to the model, linked or not.
  const code = normalizeCode(text);
  if (code !== null) return handleCode(code, msg, deps);

  const now = deps.now();
  const found: ChannelLink | undefined = await deps.links.find(msg.channelId, msg.identity);
  const state = linkState(found, now);

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

  // 5. Re-check access on every message.
  if (!(await deps.accessAllowed(link.user))) {
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
