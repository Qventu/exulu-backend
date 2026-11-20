import { maskIdentity } from "./config";
import type { DecideDeps } from "./decide";

export type ChannelAuditEvent = Parameters<DecideDeps["audit"]>[0];

/** The slice of the key-value store the de-duplication needs (node-redis v4 `set`). */
export interface AuditDedupStore {
  set(key: string, value: string, opts: { EX: number; NX?: true }): Promise<string | null>;
}

/** decideInbound reports a lockout on every attempt; the audit trail keeps one per window. */
export const CODE_LOCKOUT_AUDIT_WINDOW_SECONDS = 3600;

const lockoutKey = (channelId: string, identity: string) => `channel-audit:code_lockout:${channelId}:${identity}`;

/**
 * Channel events for the audit trail (spec §7): one structured log line per event, the
 * identity masked. This is the single place to forward them to the audit logger.
 * Never throws and never rejects: auditing must not change how a message is handled.
 */
export const createChannelAuditor =
  (deps: { channelId: string; kv: AuditDedupStore }) =>
  async (event: ChannelAuditEvent): Promise<void> => {
    try {
      if (event.type === "code_lockout") {
        const first = await deps.kv.set(lockoutKey(deps.channelId, event.identity), "1", {
          EX: CODE_LOCKOUT_AUDIT_WINDOW_SECONDS,
          NX: true,
        });
        if (first === null) return;
      }
      console.info(
        "[EXULU-CHANNEL] audit",
        JSON.stringify({
          event: event.type,
          channel: deps.channelId,
          identity: maskIdentity(event.identity),
          user: event.userId ?? null,
        }),
      );
    } catch (error) {
      console.error(`[EXULU-CHANNEL] audit ${event.type} on channel ${deps.channelId} failed`, error);
    }
  };
