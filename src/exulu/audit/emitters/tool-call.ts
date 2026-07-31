import { AUDIT_EVENT_TYPES } from "../event";
import type { AuditEvent, AuditToolCallInput } from "../event";
import { sanitizeData } from "../redact";
import { describeCredentialIdentity } from "@SRC/exulu/auth/describe";

const str = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : String(v);

const isAuthShortCircuit = (output: unknown): boolean => {
  if (!output || typeof output !== "object") return false;
  const o = output as Record<string, any>;
  return !!o.credentialRequest || !!o.oauth?.authorizationUrl;
};

export const buildToolCallEvent = async (
  ctx: AuditToolCallInput,
  opts: { maxBytes: number; captureOutput: boolean; redactKeys: string[]; nowIso?: () => string },
): Promise<AuditEvent> => {
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());

  const status: AuditEvent["status"] =
    ctx.status === "error" ? "error" : isAuthShortCircuit(ctx.output) ? "auth_required" : "ok";

  const input = sanitizeData(ctx.input, { maxBytes: opts.maxBytes, redactKeys: opts.redactKeys });
  const data: Record<string, unknown> = { input: input.value };
  const truncated: Record<string, boolean> = {};
  if (input.truncated) truncated.input = true;

  if (opts.captureOutput && status !== "auth_required") {
    const output = sanitizeData(ctx.output, { maxBytes: opts.maxBytes, redactKeys: opts.redactKeys });
    data.output = output.value;
    if (output.truncated) truncated.output = true;
  }

  let credential: AuditEvent["credential"];
  if (ctx.tool.authentication && ctx.user?.id != null) {
    credential = await describeCredentialIdentity(
      ctx.tool.authentication,
      Number(ctx.user.id),
      ctx.tool.id,
    );
  }

  const err = ctx.error as any;
  return {
    v: 1,
    ts: nowIso(),
    type: AUDIT_EVENT_TYPES.TOOL_CALL,
    actor: {
      kind: "user",
      userId: str(ctx.user?.id),
      email: ctx.user?.email,
      roleId: str(ctx.user?.role?.id),
      projectId: ctx.projectId,
    },
    context: {
      sessionId: ctx.sessionID,
      agentId: ctx.agent?.id,
      agentName: ctx.agent?.name,
      toolCallId: ctx.toolCallId,
    },
    target: { kind: "tool", id: ctx.tool.id, name: ctx.tool.name, category: ctx.tool.category, builtin: ctx.builtin },
    ...(ctx.client ? { client: ctx.client } : {}),
    ...(credential ? { credential } : {}),
    status,
    ...(status === "error" ? { error: { name: err?.name, message: String(err?.message ?? err ?? "unknown error") } } : {}),
    data,
    durationMs: ctx.durationMs,
    ...(Object.keys(truncated).length ? { truncated } : {}),
  };
};
