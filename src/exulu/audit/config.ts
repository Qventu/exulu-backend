import os from "os";
import path from "path";

export type S3Target = {
  s3region: string; s3key: string; s3secret: string; s3Bucket: string;
  s3endpoint?: string; s3prefix?: string;
};

export type AuditConfig = {
  enabled: boolean;
  s3?: S3Target;
  retentionDays: number;
  manageLifecycle?: boolean;
  spoolDir?: string;
  flush?: { maxRecords?: number; maxIntervalMs?: number };
  payload?: { maxBytes?: number; captureOutput?: boolean; redactKeys?: string[] };
  failureMode?: "open" | "closed";
  sources?: { toolCalls?: { enabled?: boolean; include?: string[]; exclude?: string[] } };
};

export type ResolvedAuditConfig = {
  target: Required<Pick<S3Target, "s3region" | "s3key" | "s3secret" | "s3Bucket" | "s3prefix">> &
    Pick<S3Target, "s3endpoint">;
  retentionDays: number;
  manageLifecycle: boolean;
  usingSharedFileUploadsBucket: boolean;
  spoolDir: string;
  flush: { maxRecords: number; maxIntervalMs: number };
  payload: { maxBytes: number; captureOutput: boolean; redactKeys: string[] };
  failureMode: "open" | "closed";
  toolCalls: { enabled: boolean; include: string[]; exclude: string[] };
};

const normalizePrefix = (p?: string): string => {
  const raw = (p ?? "audit").trim().replace(/^\/+|\/+$/g, "");
  return `${raw || "audit"}/`;
};

const hasAllS3Fields = (t?: S3Target): t is S3Target =>
  !!t && !!t.s3region && !!t.s3key && !!t.s3secret && !!t.s3Bucket;

export const resolveAuditConfig = (
  config: { audit?: AuditConfig; fileUploads?: S3Target },
): ResolvedAuditConfig | null => {
  const a = config.audit;
  if (!a || a.enabled !== true) return null;

  const dedicated = hasAllS3Fields(a.s3);
  const source = dedicated ? a.s3! : config.fileUploads;
  if (!hasAllS3Fields(source)) {
    throw new Error(
      "[EXULU] audit.enabled is true but no S3 target is configured. Set config.audit.s3 or config.fileUploads.",
    );
  }
  if (!Number.isInteger(a.retentionDays) || a.retentionDays <= 0) {
    throw new Error(`[EXULU] audit.retentionDays must be a positive integer, got ${a.retentionDays}.`);
  }

  const usingSharedFileUploadsBucket = !dedicated;
  return {
    target: {
      s3region: source.s3region,
      s3key: source.s3key,
      s3secret: source.s3secret,
      s3Bucket: source.s3Bucket,
      s3prefix: normalizePrefix(source.s3prefix),
      ...(source.s3endpoint ? { s3endpoint: source.s3endpoint } : {}),
    },
    retentionDays: a.retentionDays,
    manageLifecycle: a.manageLifecycle ?? !usingSharedFileUploadsBucket,
    usingSharedFileUploadsBucket,
    spoolDir: a.spoolDir ?? path.join(os.tmpdir(), "exulu-audit-spool"),
    flush: {
      maxRecords: a.flush?.maxRecords ?? 100,
      maxIntervalMs: a.flush?.maxIntervalMs ?? 5000,
    },
    payload: {
      maxBytes: a.payload?.maxBytes ?? 32_768,
      captureOutput: a.payload?.captureOutput ?? true,
      redactKeys: a.payload?.redactKeys ?? [],
    },
    failureMode: a.failureMode ?? "open",
    toolCalls: {
      enabled: a.sources?.toolCalls?.enabled ?? true,
      include: a.sources?.toolCalls?.include ?? [],
      exclude: a.sources?.toolCalls?.exclude ?? [],
    },
  };
};
