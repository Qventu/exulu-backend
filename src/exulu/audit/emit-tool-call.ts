import type { AuditLogger } from "./logger";
import type { AuditToolCallInput } from "./event";

// Thin adapter: applies the audit gate, sets `builtin` from the logger, and
// fire-and-forgets in open mode (awaits only in fail-closed). Never throws in
// open mode — audit must not break a tool call.
export const emitToolCallAudit = async (
  logger: AuditLogger,
  ctx: Omit<AuditToolCallInput, "builtin">,
): Promise<void> => {
  if (!logger.shouldAuditTool(ctx.tool.id)) return;
  const full: AuditToolCallInput = { ...ctx, builtin: logger.isBuiltin(ctx.tool.id) };
  if (logger.failClosed) {
    await logger.recordToolCall(full);
    return;
  }
  logger.recordToolCall(full).catch((error) =>
    console.error(`[EXULU] audit: recordToolCall failed for tool "${ctx.tool.id}":`, error),
  );
};
