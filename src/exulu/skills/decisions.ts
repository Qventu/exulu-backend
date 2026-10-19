/**
 * The skill-authoring tools follow the memory tools' consent pattern: the
 * model proposes, the user confirms on a card, and the card's choices (final
 * name, description, who may see the skill, whether to enable it on this
 * agent) travel back to the tool inside the approval response's `reason`.
 * This module is the shared contract of that payload.
 */
import type { UIMessage } from "ai";

import { VALID_RIGHTS_MODES, type ExuluRightsMode } from "@EXULU_TYPES/rbac-rights-modes";
import { normalizeRbac, type MemoryRbacInput } from "../memory/decisions";

export const SKILL_TOOL_IDS = ["skill_create", "skill_update"] as const;
export type SkillToolId = (typeof SKILL_TOOL_IDS)[number];
export const isSkillToolId = (id: string): id is SkillToolId => (SKILL_TOOL_IDS as readonly string[]).includes(id);
export const isSkillToolPartType = (type: string): boolean => type.startsWith("tool-") && isSkillToolId(type.slice("tool-".length));

export type SkillDecision =
  | { v: 1; kind: "create"; name: string; description: string; rights_mode: ExuluRightsMode; rbac?: MemoryRbacInput; enableOnAgent?: boolean }
  | { v: 1; kind: "update"; label?: string; description?: string; enableOnAgent?: boolean };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const optString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function parseSkillDecision(reason: unknown): SkillDecision | undefined {
  if (typeof reason !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reason);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.v !== 1) return undefined;
  const enableOnAgent = parsed.enableOnAgent === true ? true : undefined;
  switch (parsed.kind) {
    case "create": {
      const name = optString(parsed.name)?.trim();
      const description = optString(parsed.description)?.trim() ?? "";
      const rights_mode = optString(parsed.rights_mode);
      if (!name) return undefined;
      if (!rights_mode || !(VALID_RIGHTS_MODES as readonly string[]).includes(rights_mode)) return undefined;
      const rbac = normalizeRbac(parsed.rbac);
      return {
        v: 1,
        kind: "create",
        name,
        description,
        rights_mode: rights_mode as ExuluRightsMode,
        ...(rbac ? { rbac } : {}),
        ...(enableOnAgent ? { enableOnAgent } : {}),
      };
    }
    case "update": {
      const out: SkillDecision = { v: 1, kind: "update", ...(enableOnAgent ? { enableOnAgent } : {}) };
      const label = optString(parsed.label);
      const description = optString(parsed.description);
      if (label !== undefined) out.label = label;
      if (description !== undefined) out.description = description;
      return out;
    }
    default:
      return undefined;
  }
}

/** Approved skill cards → decisions keyed by toolCallId, read from the assistant's parts. */
export function collectSkillDecisions(messages: UIMessage[]): Map<string, SkillDecision> {
  const out = new Map<string, SkillDecision>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of (message.parts ?? []) as unknown[]) {
      if (!isRecord(part) || typeof part.type !== "string" || !isSkillToolPartType(part.type)) continue;
      const approval = isRecord(part.approval) ? part.approval : undefined;
      if (!approval || approval.approved !== true) continue;
      const toolCallId = optString(part.toolCallId);
      const decision = parseSkillDecision(approval.reason);
      if (toolCallId && decision) out.set(toolCallId, decision);
    }
  }
  return out;
}
