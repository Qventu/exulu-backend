import type { ExuluAuthConfig } from "./types";
import { providerKeyFor } from "./provider-key";

// Populated at ExuluTool construction time (tools are instantiated at app
// startup). Two indexes: byProvider is the storage key (multiple tools may
// point at one entry); byTool answers "which config governs this toolId".
type RegistryEntry = { config: ExuluAuthConfig; toolIds: Set<string> };
const byProvider = new Map<string, RegistryEntry>();
const byTool = new Map<string, string>(); // toolId -> providerKey

const STABLE_OAUTH_STRING_FIELDS = [
  "authorizationUrl",
  "tokenUrl",
  "clientId",
  "clientSecret",
] as const;

const assertCompatible = (
  providerKey: string,
  toolId: string,
  existing: ExuluAuthConfig,
  next: ExuluAuthConfig,
): void => {
  if (existing.authType !== next.authType) {
    throw new Error(
      `ExuluTool "${toolId}": auth.authType '${next.authType}' disagrees with another tool that shares provider "${providerKey}" using authType '${existing.authType}'.`,
    );
  }

  if (existing.authType === "oauth" && next.authType === "oauth") {
    for (const field of STABLE_OAUTH_STRING_FIELDS) {
      if (existing[field] !== next[field]) {
        throw new Error(
          `ExuluTool "${toolId}": oauth.${field} disagrees with another tool that shares provider "${providerKey}". ` +
            `Every tool on the same provider must use identical authorizationUrl/tokenUrl/clientId/clientSecret.`,
        );
      }
    }
    const a = new Set(existing.scopes);
    const b = new Set(next.scopes);
    if (a.size !== b.size || [...a].some((s) => !b.has(s))) {
      throw new Error(
        `ExuluTool "${toolId}": oauth.scopes disagrees with another tool that shares provider "${providerKey}". ` +
          `Every tool on the same provider must declare the same scope superset. ` +
          `Existing: [${[...a].sort().join(", ")}]. This tool: [${[...b].sort().join(", ")}].`,
      );
    }
    return;
  }

  if (existing.authType === "user_credentials" && next.authType === "user_credentials") {
    if (JSON.stringify(existing.fields) !== JSON.stringify(next.fields)) {
      throw new Error(
        `ExuluTool "${toolId}": user_credentials.fields disagrees with another tool that shares provider "${providerKey}". ` +
          `Every tool on the same provider must declare structurally identical fields (same names, types, and order).`,
      );
    }
    return;
  }
};

export const authRegistry = {
  register: (toolId: string, config: ExuluAuthConfig): void => {
    const providerKey = providerKeyFor(toolId, config);
    const existing = byProvider.get(providerKey);
    if (existing) {
      assertCompatible(providerKey, toolId, existing.config, config);
      existing.toolIds.add(toolId);
      byTool.set(toolId, providerKey);
      return;
    }
    byProvider.set(providerKey, { config, toolIds: new Set([toolId]) });
    byTool.set(toolId, providerKey);
  },
  getByProvider: (providerKey: string): ExuluAuthConfig | undefined =>
    byProvider.get(providerKey)?.config,
  getByTool: (toolId: string): ExuluAuthConfig | undefined => {
    const providerKey = byTool.get(toolId);
    return providerKey ? byProvider.get(providerKey)?.config : undefined;
  },
};

// Test-only. The registry is process-global; tests reset it in beforeEach.
export const __resetAuthRegistryForTests = (): void => {
  byProvider.clear();
  byTool.clear();
};
