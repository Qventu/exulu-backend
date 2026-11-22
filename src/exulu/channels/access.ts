import type { Knex } from "knex";
import { evaluateGuestChatAccess } from "../public-agents";
import { checkApiKeyScope } from "@SRC/utils/check-api-key-scope";
import { canEnableChannel } from "./config";
import { isUserActive } from "./decide";
import { safeError } from "./log";

/** The agent fields evaluateGuestChatAccess and canEnableChannel read. */
export type GuestAgent = Parameters<typeof evaluateGuestChatAccess>[0];

/**
 * The outcome of the channel access check. "unavailable" means the check could not be made
 * (a lookup threw): no run, and no conclusion about the link either, so a caller that revokes
 * on "denied" must not revoke on "unavailable".
 */
export type AccessOutcome = "allowed" | "denied" | "unavailable";

export interface AccessCheckParams {
  db: Knex;
  loadAgent: (id: string) => Promise<GuestAgent | undefined>;
  agentId: string;
  channelId: string;
  userId: number;
}

/**
 * May this user use this agent through a channel? Used by decide (server, every message),
 * by the link-code route, and again by the worker right before the run. In order: the user
 * row exists (isUserActive); an API user's key is scoped to this agent (checkApiKeyScope,
 * as the agent run route applies it); the agent exists and can carry a channel
 * (canEnableChannel: guest access on, regular mode); the web guest chat's gate allows this
 * user. Any error is "unavailable", never "allowed".
 */
export const channelAccessCheck = async (p: AccessCheckParams): Promise<AccessOutcome> => {
  try {
    const user = await p.db("users").where({ id: p.userId }).first();
    if (!isUserActive(user)) return "denied";
    // the run route rejects a key scoped to other agents whatever the guest gate says
    if (!checkApiKeyScope(user, p.agentId).allowed) return "denied";
    const agent = await p.loadAgent(p.agentId);
    if (!agent) return "denied";
    // refused by the gate itself, not only by the (non-transactional) auto-disable
    if (!canEnableChannel(agent).ok) return "denied";
    // as the run route calls it, for a signed-in caller without a guest password
    const gate = await evaluateGuestChatAccess(agent, user.id, undefined);
    return gate.allowed ? "allowed" : "denied";
  } catch (error) {
    console.error(`[EXULU-CHANNEL] access check failed on channel ${p.channelId}`, safeError(error));
    return "unavailable";
  }
};

/** channelAccessCheck for callers that only need allow/deny: "unavailable" is not allowed. */
export const channelAccessAllowed = async (p: AccessCheckParams): Promise<boolean> =>
  (await channelAccessCheck(p)) === "allowed";
