import type { ExuluOauthConfig } from "./types";
import { providerKeyFor } from "./provider-key";

// Populated at ExuluTool construction time (tools are instantiated at app
// startup). Two indexes: byProvider is the storage key (multiple tools may
// point at one entry); byTool answers "which config governs this toolId".
type RegistryEntry = { config: ExuluOauthConfig; toolIds: Set<string> };
const byProvider = new Map<string, RegistryEntry>();
const byTool = new Map<string, string>(); // toolId -> providerKey

const STABLE_STRING_FIELDS = [
  "authorizationUrl",
  "tokenUrl",
  "clientId",
  "clientSecret",
] as const;

const assertCompatible = (
  providerKey: string,
  toolId: string,
  existing: ExuluOauthConfig,
  next: ExuluOauthConfig,
): void => {
  for (const field of STABLE_STRING_FIELDS) {
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
};

export const oauthRegistry = {
  register: (toolId: string, config: ExuluOauthConfig): void => {
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
  getByProvider: (providerKey: string): ExuluOauthConfig | undefined =>
    byProvider.get(providerKey)?.config,
  getByTool: (toolId: string): ExuluOauthConfig | undefined => {
    const providerKey = byTool.get(toolId);
    return providerKey ? byProvider.get(providerKey)?.config : undefined;
  },
  // Deprecated alias retained until Task 4 removes the last caller.
  get: (toolId: string): ExuluOauthConfig | undefined => {
    const providerKey = byTool.get(toolId);
    return providerKey ? byProvider.get(providerKey)?.config : undefined;
  },
};

// Test-only. The registry is process-global; tests reset it in beforeEach.
export const __resetOauthRegistryForTests = (): void => {
  byProvider.clear();
  byTool.clear();
};
