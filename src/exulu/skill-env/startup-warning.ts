import { findUnclassifiedSecretShaped } from "./inventory";

export const skillEnvStartupWarning = (env: NodeJS.ProcessEnv): string | null => {
  const unknown = findUnclassifiedSecretShaped(env);
  if (!unknown.length) return null;
  return `[SKILLS] ${unknown.length} credential-shaped environment variable(s) are not in the secret inventory and will be visible to skills: ${unknown.join(", ")}. Classify them in src/exulu/skill-env/inventory.ts.`;
};
