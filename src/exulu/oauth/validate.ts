import type { ExuluOauthConfig } from "./types";

const REQUIRED_STRING_FIELDS = [
  "authorizationUrl",
  "tokenUrl",
  "clientId",
  "clientSecret",
] as const;

export const validateOauthConfig = (toolId: string, config: ExuluOauthConfig) => {
  for (const field of REQUIRED_STRING_FIELDS) {
    if (!config[field] || typeof config[field] !== "string") {
      throw new Error(
        `ExuluTool "${toolId}": oauth.${field} is required and must be a non-empty string.`,
      );
    }
  }
  if (!Array.isArray(config.scopes)) {
    throw new Error(
      `ExuluTool "${toolId}": oauth.scopes must be an array of strings (use [] to request no scopes).`,
    );
  }
  if (config.provider !== undefined) {
    if (
      typeof config.provider !== "string" ||
      config.provider.length === 0 ||
      config.provider.trim() !== config.provider
    ) {
      throw new Error(
        `ExuluTool "${toolId}": oauth.provider must be a non-empty string with no leading or trailing whitespace when set.`,
      );
    }
  }
  if (!process.env.BACKEND) {
    throw new Error(
      `ExuluTool "${toolId}": oauth requires the BACKEND environment variable (the backend's public base URL) to build the redirect URI.`,
    );
  }
};
