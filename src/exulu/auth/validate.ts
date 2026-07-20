import type { ExuluAuthConfig } from "./types";

const OAUTH_REQUIRED_STRING_FIELDS = [
  "authorizationUrl",
  "tokenUrl",
  "clientId",
  "clientSecret",
] as const;

export const validateAuthConfig = (toolId: string, config: ExuluAuthConfig): void => {
  if (config.authType === "oauth") {
    // oauth: required string fields
    for (const field of OAUTH_REQUIRED_STRING_FIELDS) {
      const value = (config as any)[field];
      if (!value || typeof value !== "string") {
        throw new Error(
          `ExuluTool "${toolId}": oauth.${field} is required and must be a non-empty string.`,
        );
      }
    }

    // oauth: scopes must be an array
    if (!Array.isArray(config.scopes)) {
      throw new Error(
        `ExuluTool "${toolId}": oauth.scopes must be an array of strings (use [] to request no scopes).`,
      );
    }

    // oauth: provider must be non-empty trimmed string (when set)
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

    // oauth: BACKEND env var required
    if (!process.env.BACKEND) {
      throw new Error(
        `ExuluTool "${toolId}": oauth requires the BACKEND environment variable (the backend's public base URL) to build the redirect URI.`,
      );
    }

    return;
  }

  if (config.authType === "user_credentials") {
    // user_credentials: provider required, non-empty, no whitespace
    if (
      typeof config.provider !== "string" ||
      config.provider.length === 0 ||
      config.provider.trim() !== config.provider
    ) {
      throw new Error(
        `ExuluTool "${toolId}": user_credentials.provider must be a non-empty string with no leading or trailing whitespace.`,
      );
    }

    // user_credentials: fields must be a non-empty array
    if (!Array.isArray(config.fields) || config.fields.length === 0) {
      throw new Error(
        `ExuluTool "${toolId}": user_credentials.fields must contain at least one field.`,
      );
    }

    // user_credentials: each field name must be non-empty trimmed string
    // and field type must be 'text' or 'password', with no duplicate names
    const seenNames = new Set<string>();
    for (let i = 0; i < config.fields.length; i++) {
      const field = config.fields[i];
      const name = field.name;

      // Check name is non-empty trimmed string
      if (
        typeof name !== "string" ||
        name.length === 0 ||
        name.trim() !== name
      ) {
        throw new Error(
          `ExuluTool "${toolId}": user_credentials.fields[${i}].name must be a non-empty string with no leading or trailing whitespace.`,
        );
      }

      // Check for duplicates
      if (seenNames.has(name)) {
        throw new Error(
          `ExuluTool "${toolId}": user_credentials.fields has duplicate field name '${name}'.`,
        );
      }
      seenNames.add(name);

      // Check field type is valid
      const type = field.type;
      if (type !== "text" && type !== "password") {
        throw new Error(
          `ExuluTool "${toolId}": user_credentials.fields[${i}].type must be 'text' or 'password' (got '${type}').`,
        );
      }
    }

    // user_credentials: BACKEND env var required
    if (!process.env.BACKEND) {
      throw new Error(
        `ExuluTool "${toolId}": user_credentials requires the BACKEND environment variable (the backend's public base URL) to build the credential submit URL.`,
      );
    }

    return;
  }

  // Unreachable branch (TypeScript should narrow, but defensive runtime guard)
  throw new Error(
    `ExuluTool "${toolId}": auth.authType '${(config as any).authType}' is not supported.`,
  );
};
