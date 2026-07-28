import type { AuditEvent, AuditToolCallInput } from "./event";
import { resolveAuditConfig, type ResolvedAuditConfig } from "./config";
import { createAuditS3Writer } from "./s3-writer";
import { applyRetentionLifecycle } from "./lifecycle";
import { AuditSink, createFsSpoolStore } from "./sink";
import { buildToolCallEvent } from "./emitters/tool-call";

export interface AuditLogger {
  enabled: boolean;
  failClosed: boolean;
  isBuiltin: (id: string) => boolean;
  shouldAuditTool: (id: string) => boolean;
  record: (event: AuditEvent) => void;
  recordToolCall: (ctx: AuditToolCallInput) => Promise<void>;
  flush: () => Promise<void>;
  close: () => Promise<void>;
}

const noop: AuditLogger = {
  enabled: false,
  failClosed: false,
  isBuiltin: () => false,
  shouldAuditTool: () => false,
  record: () => {},
  recordToolCall: async () => {},
  flush: async () => {},
  close: async () => {},
};

class RealAuditLogger implements AuditLogger {
  enabled = true;
  failClosed: boolean;
  private sink: AuditSink;
  constructor(private resolved: ResolvedAuditConfig, private builtinToolIds: Set<string>) {
    this.failClosed = resolved.failureMode === "closed";
    const writer = createAuditS3Writer(resolved.target);
    this.sink = new AuditSink(resolved, writer, createFsSpoolStore(resolved.spoolDir));
  }
  lifecycleWriter() { return createAuditS3Writer(this.resolved.target); }
  isBuiltin(id: string) { return this.builtinToolIds.has(id); }
  shouldAuditTool(id: string): boolean {
    const t = this.resolved.toolCalls;
    if (!t.enabled) return false;
    if (t.exclude.includes(id)) return false;
    if (t.include.length > 0) return t.include.includes(id);
    return true;
  }
  record(event: AuditEvent) { this.sink.record(event); }
  async recordToolCall(ctx: AuditToolCallInput): Promise<void> {
    const event = await buildToolCallEvent(ctx, {
      maxBytes: this.resolved.payload.maxBytes,
      captureOutput: this.resolved.payload.captureOutput,
      redactKeys: this.resolved.payload.redactKeys,
    });
    if (this.failClosed) await this.sink.recordDurable(event);
    else this.sink.record(event);
  }
  flush() { return this.sink.flush(); }
  close() { return this.sink.close(); }
  get resolvedConfig() { return this.resolved; }
}

let _instance: AuditLogger | undefined;

const build = (
  config: { audit?: any; fileUploads?: any },
  builtinToolIds: Set<string>,
): AuditLogger => {
  const resolved = resolveAuditConfig(config);
  return resolved ? new RealAuditLogger(resolved, builtinToolIds) : noop;
};

export const getAuditLogger = (config: { audit?: any; fileUploads?: any }): AuditLogger => {
  if (!_instance) _instance = build(config, new Set());
  return _instance;
};

export const initAudit = async (
  config: { audit?: any; fileUploads?: any },
  opts?: { builtinToolIds?: Set<string> },
): Promise<AuditLogger> => {
  _instance = build(config, opts?.builtinToolIds ?? new Set());
  if (_instance instanceof RealAuditLogger) {
    const r = _instance.resolvedConfig;
    await applyRetentionLifecycle(_instance.lifecycleWriter(), {
      prefix: r.target.s3prefix,
      retentionDays: r.retentionDays,
      manage: r.manageLifecycle,
    });
    const close = () => { void _instance?.close(); };
    process.on("SIGTERM", close);
    process.on("SIGINT", close);
  }
  return _instance;
};

export const __resetAuditForTests = (): void => { _instance = undefined; };
