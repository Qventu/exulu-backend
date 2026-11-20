import type { Knex } from "knex";
import { evaluateGuestChatAccess } from "../public-agents";
import { isUserActive } from "./decide";
import { safeError } from "./log";

/** The agent fields evaluateGuestChatAccess reads. */
export type GuestAgent = Parameters<typeof evaluateGuestChatAccess>[0];

/**
 * May this user use this agent through a channel? Used by decide (server, every message)
 * and again by the worker right before the run. The user row exists, isUserActive, and the
 * web guest chat's gate allows this user on this agent. Any error fails closed.
 */
export const channelAccessAllowed = async (p: {
  db: Knex;
  loadAgent: (id: string) => Promise<GuestAgent | undefined>;
  agentId: string;
  channelId: string;
  userId: number;
}): Promise<boolean> => {
  try {
    const user = await p.db("users").where({ id: p.userId }).first();
    if (!isUserActive(user)) return false;
    const agent = await p.loadAgent(p.agentId);
    if (!agent) return false;
    // as the run route calls it, for a signed-in caller without a guest password
    const gate = await evaluateGuestChatAccess(agent, user.id, undefined);
    return gate.allowed;
  } catch (error) {
    console.error(`[EXULU-CHANNEL] access check failed on channel ${p.channelId}`, safeError(error));
    return false;
  }
};
