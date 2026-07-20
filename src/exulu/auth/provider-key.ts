import type { ExuluAuthConfig } from "./types";

/**
 * Resolves the token-storage key for a tool: the explicit provider name when
 * declared, otherwise the tool's own id (preserves legacy per-tool behavior).
 * Centralized here so no callsite forgets the fallback rule.
 */
export const providerKeyFor = (toolId: string, config: ExuluAuthConfig): string =>
  config.provider && config.provider.length > 0 ? config.provider : toolId;
