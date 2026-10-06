import { AUDIT_EVENT_TYPES } from "../event";
import type { AuditEvent, AuditSkillSandboxInput } from "../event";

const str = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : String(v);

/**
 * One event per sandbox creation. The grant set is fixed when the sandbox is
 * built, so per-command events would be noise. Names and counts only — no
 * credential value is ever read into this event.
 */
export const buildSkillSandboxEvent = (
  ctx: AuditSkillSandboxInput,
  opts: { nowIso?: () => string } = {},
): AuditEvent => {
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  return {
    v: 1,
    ts: nowIso(),
    type: AUDIT_EVENT_TYPES.SKILL_SANDBOX_CREATED,
    actor: {
      kind: "agent",
      userId: str(ctx.user?.id),
      email: ctx.user?.email,
      roleId: str(ctx.user?.role?.id),
      projectId: ctx.projectId,
    },
    context: {
      sessionId: ctx.sessionID,
      agentId: ctx.agent?.id,
      agentName: ctx.agent?.name,
    },
    target: { kind: "skill_sandbox", id: ctx.sessionID },
    status: "ok",
    data: {
      skills: ctx.skills.map((s) => ({ id: s.id, name: s.name, version: s.version })),
      grantedVariableNames: ctx.grantedNames,
      withheldVariableNames: ctx.withheldNames,
      skippedVariableNames: ctx.skippedNames,
      strippedSecretCount: ctx.strippedSecretCount,
      degradedSandbox: ctx.degradedSandbox,
    },
    client: ctx.client,
  };
};
