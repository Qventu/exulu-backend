import type { User } from "@EXULU_TYPES/models/user";

export type ScopeCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string; code: 401 | 403 };

export function checkApiKeyScope(
  user: User | undefined,
  agentId: string,
): ScopeCheckResult {
  if (!user || user.type !== "api") return { allowed: true };
  if (!user.scope_mode || user.scope_mode === "admin") return { allowed: true };

  if (user.scope_mode === "agents") {
    const ids: string[] = Array.isArray(user.agent_ids) ? user.agent_ids : [];
    if (!ids.includes(agentId)) {
      return {
        allowed: false,
        reason: `API key is not scoped to agent ${agentId}.`,
        code: 403,
      };
    }
    return { allowed: true };
  }

  return { allowed: false, reason: "Unknown scope_mode.", code: 401 };
}
