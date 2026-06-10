import type { ExuluOauthConfig } from "./types";

// Populated at ExuluTool construction time (tools are instantiated at app
// startup), read by the /oauth/callback route to resolve the config for the
// toolId carried in the encrypted state parameter.
const registry = new Map<string, ExuluOauthConfig>();

export const oauthRegistry = {
  register: (toolId: string, config: ExuluOauthConfig) => {
    registry.set(toolId, config);
  },
  get: (toolId: string): ExuluOauthConfig | undefined => registry.get(toolId),
};
