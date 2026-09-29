import type { UIMessage } from "ai";
import { VALID_RIGHTS_MODES, type ExuluRightsMode } from "@EXULU_TYPES/rbac-rights-modes";

export const MEMORY_TOOL_IDS = ["memory_remember", "memory_update", "memory_forget"] as const;
export type MemoryToolId = (typeof MEMORY_TOOL_IDS)[number];

export const isMemoryToolId = (id: string): id is MemoryToolId =>
  (MEMORY_TOOL_IDS as readonly string[]).includes(id);

/** UI part types are "tool-<toolId>". */
export const isMemoryToolPartType = (type: string): boolean =>
  type.startsWith("tool-") && isMemoryToolId(type.slice("tool-".length));

export type RbacGrant = { id: number | string; rights: "read" | "write" };
export type MemoryRbacInput = { users?: RbacGrant[]; roles?: RbacGrant[]; teams?: RbacGrant[] };

export type MemoryDecision =
  | { v: 1; kind: "remember"; title: string; information: string; type: string; rights_mode: ExuluRightsMode; rbac?: MemoryRbacInput }
  | { v: 1; kind: "update"; information?: string; title?: string; type?: string }
  | { v: 1; kind: "forget" };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const optString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const isValidRbacGrant = (v: unknown): v is RbacGrant =>
  isRecord(v) &&
  (v.rights === "read" || v.rights === "write") &&
  (typeof v.id === "number" || (typeof v.id === "string" && v.id.length > 0));

const normalizeRbacList = (raw: unknown): RbacGrant[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const valid = raw.filter(isValidRbacGrant);
  return valid.length > 0 ? valid : undefined;
};

/**
 * Model-authored `rbac` blobs are untrusted input carried through JSON in an
 * approval's `reason` string — only "is an object" was checked before this,
 * so a non-array `users`/`roles`/`teams` (or a junk entry inside one) reached
 * handleRBACUpdate raw, where a non-array throws on `.map` and a malformed
 * entry is inserted as-is. Keeps only well-shaped grants; drops an empty or
 * entirely-invalid key; returns undefined when nothing valid survives so
 * callers can treat "no rbac" and "malformed rbac" identically.
 */
export function normalizeRbac(raw: unknown): MemoryRbacInput | undefined {
  if (!isRecord(raw)) return undefined;
  const out: MemoryRbacInput = {};
  const users = normalizeRbacList(raw.users);
  const roles = normalizeRbacList(raw.roles);
  const teams = normalizeRbacList(raw.teams);
  if (users) out.users = users;
  if (roles) out.roles = roles;
  if (teams) out.teams = teams;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseMemoryDecision(reason: unknown): MemoryDecision | undefined {
  if (typeof reason !== "string") return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(reason); } catch { return undefined; }
  if (!isRecord(parsed) || parsed.v !== 1) return undefined;
  switch (parsed.kind) {
    case "remember": {
      const title = optString(parsed.title);
      const information = optString(parsed.information);
      const type = optString(parsed.type);
      const rights_mode = optString(parsed.rights_mode);
      if (title === undefined || information === undefined || type === undefined) return undefined;
      if (!rights_mode || !(VALID_RIGHTS_MODES as readonly string[]).includes(rights_mode)) return undefined;
      const rbac = normalizeRbac(parsed.rbac);
      return { v: 1, kind: "remember", title, information, type, rights_mode: rights_mode as ExuluRightsMode, ...(rbac ? { rbac } : {}) };
    }
    case "update": {
      const out: MemoryDecision = { v: 1, kind: "update" };
      const information = optString(parsed.information);
      const title = optString(parsed.title);
      const type = optString(parsed.type);
      if (information !== undefined) out.information = information;
      if (title !== undefined) out.title = title;
      if (type !== undefined) out.type = type;
      return out;
    }
    case "forget":
      return { v: 1, kind: "forget" };
    default:
      return undefined;
  }
}

/**
 * Approved memory tool parts carry the user's edits in approval.reason.
 * Scans assistant messages only; keyed by toolCallId. The SDK only executes
 * still-pending approvals, so stale entries are harmless.
 */
export function collectMemoryDecisions(messages: UIMessage[]): Map<string, MemoryDecision> {
  const out = new Map<string, MemoryDecision>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of (message.parts ?? []) as unknown[]) {
      if (!isRecord(part) || typeof part.type !== "string" || !isMemoryToolPartType(part.type)) continue;
      const approval = isRecord(part.approval) ? part.approval : undefined;
      if (!approval || approval.approved !== true) continue;
      const toolCallId = optString(part.toolCallId);
      const decision = parseMemoryDecision(approval.reason);
      if (toolCallId && decision) out.set(toolCallId, decision);
    }
  }
  return out;
}
