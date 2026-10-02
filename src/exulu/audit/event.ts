import type { ExuluAuthConfig } from "@SRC/exulu/auth/types";

export type AuditClient = {
  ip?: string;
  userAgent?: string;
  referer?: string;
  origin?: string;
  forwardedFor?: string;
};

export const AUDIT_EVENT_TYPES = {
  TOOL_CALL: "tool.call",
  SKILL_SANDBOX_CREATED: "skill.sandbox.created",
} as const;

export type AuditEvent = {
  v: 1;
  ts: string; // ISO-8601 UTC
  type: string; // dotted namespace, e.g. "tool.call"
  actor: {
    kind?: "user" | "agent" | "system";
    userId?: string;
    email?: string;
    roleId?: string;
    projectId?: string;
  };
  context?: {
    sessionId?: string;
    agentId?: string;
    agentName?: string;
    toolCallId?: string;
    [k: string]: unknown;
  };
  target?: { kind?: string; id?: string; name?: string; [k: string]: unknown };
  credential?: {
    provider: string;
    authType: "oauth" | "user_credentials";
    account?: string;
    scopes?: string[];
    expiresAt?: string | null;
  };
  status: "ok" | "error" | "denied" | "auth_required";
  error?: { name?: string; message: string };
  data?: Record<string, unknown>;
  durationMs?: number;
  truncated?: Record<string, boolean>;
  client?: AuditClient;
};

// Context handed to the tool-call emitter (see emitters/tool-call.ts).
export type AuditToolCallInput = {
  durationMs: number;
  agent?: { id?: string; name?: string; slug?: string };
  tool: { id: string; name: string; category?: string; authentication?: ExuluAuthConfig };
  builtin: boolean;
  user?: { id?: unknown; email?: string; role?: { id?: unknown } };
  projectId?: string;
  sessionID?: string;
  toolCallId?: string;
  input: unknown;
  output: unknown;
  status: "ok" | "error" | "auth_required";
  error?: unknown;
  client?: AuditClient;
};

// Context handed to the skill-sandbox emitter (see emitters/skill-sandbox.ts).
export type AuditSkillSandboxInput = {
  sessionID?: string;
  agent?: { id?: string; name?: string };
  user?: { id?: unknown; email?: string; role?: { id?: unknown } };
  projectId?: string;
  skills: Array<{ id: string; name: string; version?: number }>;
  grantedNames: string[];
  withheldNames: string[];
  skippedNames: string[];
  strippedSecretCount: number;
  degradedSandbox: boolean;
  client?: AuditClient;
};
