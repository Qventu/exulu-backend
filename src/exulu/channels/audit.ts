import { maskIdentity } from "./config";
import { safeError } from "./log";
import type { DecideDeps } from "./decide";
import { getAuditLogger, type AuditLogger } from "../audit/logger";
import type { AuditEvent } from "../audit/event";

export type ChannelAuditEvent = Parameters<DecideDeps["audit"]>[0];

/** The slice of the key-value store the de-duplication needs (node-redis v4 `set`). */
export interface AuditDedupStore {
  set(key: string, value: string, opts: { EX: number; NX?: true }): Promise<string | null>;
}

/** decideInbound reports a lockout on every attempt; the audit trail keeps one per window. */
export const CODE_LOCKOUT_AUDIT_WINDOW_SECONDS = 3600;

const lockoutKey = (channelId: string, identity: string) => `channel-audit:code_lockout:${channelId}:${identity}`;

/** The slice of the audit logger used here; `enabled` is false when audit logging is not configured. */
export type ChannelAuditLogger = Pick<AuditLogger, "enabled" | "record">;

// Post-startup access: the app initialises the logger once (initAudit), after which the
// config argument is ignored. Unconfigured, this is the logger's no-op.
const defaultLogger = (): ChannelAuditLogger => getAuditLogger({});

const buildAuditEvent = (channelId: string, agentId: string | undefined, event: ChannelAuditEvent): AuditEvent => ({
  v: 1,
  ts: new Date().toISOString(),
  type: `channel.${event.type}`,
  actor: event.userId != null ? { kind: "user", userId: String(event.userId) } : { kind: "system" },
  ...(agentId ? { context: { agentId } } : {}),
  target: { kind: "channel", id: channelId },
  status: event.type === "access_rejected" || event.type === "code_lockout" ? "denied" : "ok",
  data: { identity: maskIdentity(event.identity) },
});

/**
 * Channel events for the audit trail (spec §7): one structured log line per event, the
 * identity masked, and the same event forwarded to the audit logger when one is configured
 * (type `channel.<type>`, masked identity). The forward is fire-and-forget, like the open
 * mode of emitToolCallAudit: a slow or failing sink never delays or breaks a message.
 * Never throws and never rejects: auditing must not change how a message is handled.
 */
export const createChannelAuditor =
  (deps: {
    channelId: string;
    kv: AuditDedupStore;
    /** for the audit event's context, when the caller already has it */
    agentId?: string;
    logger?: () => ChannelAuditLogger;
  }) =>
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
      console.error(`[EXULU-CHANNEL] audit ${event.type} on channel ${deps.channelId} failed`, safeError(error));
      return;
    }
    try {
      const logger = (deps.logger ?? defaultLogger)();
      if (logger.enabled) logger.record(buildAuditEvent(deps.channelId, deps.agentId, event));
    } catch (error) {
      console.error(`[EXULU-CHANNEL] audit forward of ${event.type} on channel ${deps.channelId} failed`, safeError(error));
    }
  };
