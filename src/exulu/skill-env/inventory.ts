/**
 * Every environment variable this backend reads, classified. A name marked
 * `secret` is removed from the environment handed to skills (see skill-env.ts).
 *
 * The companion test in inventory.test.ts fails CI if a new environment
 * variable reference appears in src/ or ee/ without a line here. Variables
 * this codebase never reads — PYMUPDF_MESSAGE, HF_HUB_*, LANG and other
 * third-party runtime settings — are deliberately absent and pass through
 * untouched.
 */
export const ENV_CLASSIFICATION: Record<string, "secret" | "runtime"> = {
  // --- secrets: credentials, tokens, signing/verification secrets, keys.
  // Knowing the value grants access to something.
  NEXTAUTH_SECRET: "secret",
  POSTGRES_DB_PASSWORD: "secret",
  LITELLM_MASTER_KEY: "secret",
  LITELLM_DATABASE_URL: "secret",
  COMPANION_S3_SECRET: "secret",
  COMPANION_S3_KEY: "secret",
  ANTHROPIC_API_KEY: "secret",
  GEMINI_API_KEY: "secret",
  PERPLEXITY_API_KEY: "secret",
  RECALL_API_KEY: "secret",
  JIRA_CLIENT_SECRET: "secret",
  GOOGLE_CLIENT_SECRET: "secret",
  REDIS_PASSWORD: "secret",
  NPM_TOKEN: "secret",
  // Found via `rg process\.env\.[A-Z0-9_]+ src ee` (Step 3 of the task brief):
  EXULU_API_KEY: "secret", // auth header for remote LiteLLM client mode (resolve-model.ts)
  INTERNAL_SECRET: "secret", // compared against an internal-request header (src/auth/auth.ts)
  RECALL_WORKSPACE_VERIFICATION_SECRET: "secret", // verifies inbound Recall webhook signatures
  SMTP_PASSWORD: "secret",
  // EXULU_ENTERPRISE_LICENSE: the check (ee/entitlements.ts) only tests a
  // string prefix, not a cryptographic signature, so it is closer to a
  // capability token than a password — but knowing it still unlocks
  // enterprise entitlements, so classified secret per the fail-safe rule.
  EXULU_ENTERPRISE_LICENSE: "secret",

  // --- runtime: paths, locales, feature flags, hostnames, ports, log levels.
  // Only changes behaviour.
  PATH: "runtime",
  HOME: "runtime",
  LANG: "runtime",
  TZ: "runtime",
  TMPDIR: "runtime",
  NODE_ENV: "runtime",
  PORT: "runtime",
  DEBUG: "runtime",
  BACKEND: "runtime",
  FRONTEND: "runtime",
  // Found via `rg process\.env\.[A-Z0-9_]+ src ee` (Step 3 of the task brief):
  AUTH_MODE: "runtime", // "password" | "otp" mode selector, echoed by GET /config
  DISABLE_SCHEMA_UPDATE: "runtime", // LiteLLM child-process flag
  EXULU_ENTITY_EXTRACTION_MODEL: "runtime",
  EXULU_GUEST_MAX_MESSAGE_CHARS: "runtime",
  EXULU_GUEST_MAX_TOTAL_CHARS: "runtime",
  EXULU_GUEST_RATE_PER_HOUR: "runtime",
  EXULU_GUEST_RATE_PER_MINUTE: "runtime",
  EXULU_REQUIRE_SANDBOX: "runtime",
  EXULU_TRUST_PROXY: "runtime",
  EXULU_USE_LITELLM: "runtime",
  EXULU_VS_TIMING: "runtime",
  LITELLM_BASE_URL: "runtime",
  LITELLM_CONFIG_PATH: "runtime",
  LITELLM_HOST: "runtime",
  LITELLM_PORT: "runtime",
  LITELLM_UI_PATH: "runtime",
  NEXT_PUBLIC_AGENT_VISUALIZATION: "runtime",
  POSTGRES_DB_HOST: "runtime",
  POSTGRES_DB_NAME: "runtime",
  POSTGRES_DB_PORT: "runtime",
  POSTGRES_DB_SSL: "runtime",
  POSTGRES_DB_USER: "runtime", // username alone grants nothing without POSTGRES_DB_PASSWORD
  PUBLIC_API_BASE_URL: "runtime",
  RECALL_REGION: "runtime",
  RECALL_RECORDING_RETENTION_HOURS: "runtime",
  RECALL_STORE_VIDEO_LOCALLY: "runtime",
  REDIS_HOST: "runtime",
  REDIS_PORT: "runtime",
  REDIS_USER: "runtime", // username alone grants nothing without REDIS_PASSWORD
  SERVER_ROOT_PATH: "runtime",
  SMTP_FROM: "runtime",
  SMTP_HOST: "runtime",
  SMTP_PORT: "runtime",
  SMTP_SECURE: "runtime",
  SMTP_USER: "runtime", // username alone grants nothing without SMTP_PASSWORD
  TOTAL_MAX_RECORDINGS_DURATION_PER_MONTH: "runtime",
  TRANSCRIPTION_MODEL: "runtime",
  TRANSCRIPTION_SERVER: "runtime",
  TTS_MODEL: "runtime",
  TTS_VOICE: "runtime",
  WHISPER_HOST: "runtime",
  WHISPER_PORT: "runtime",
};

export const isSecretEnvName = (name: string): boolean =>
  ENV_CLASSIFICATION[name] === "secret";

const SECRET_SHAPED = /(SECRET|PASSWORD|TOKEN|_KEY|CREDENTIAL|PRIVATE)/i;

/**
 * Names present in the running environment that look like credentials but are
 * not in the inventory — i.e. set by the deployment, never read by us. Reported
 * at startup as a warning; never stripped, because stripping unknown names is
 * what breaks the document toolchain.
 */
export const findUnclassifiedSecretShaped = (env: NodeJS.ProcessEnv): string[] =>
  Object.keys(env).filter((n) => SECRET_SHAPED.test(n) && !(n in ENV_CLASSIFICATION)).sort();
