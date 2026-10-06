/**
 * Every environment variable this backend reads — plus the deployment
 * credentials the consumer app reads on its behalf — classified. A name marked
 * `secret` is removed from the environment handed to skills (see skill-env.ts).
 *
 * Two companion tests fail CI when something is left unclassified:
 *
 *  - inventory.test.ts scans `src/` and `ee/` for `process.env.<NAME>`. That catches
 *    what this codebase reads directly.
 *  - inventory.docs.test.ts reconciles this map against the Server/Worker rows
 *    of mintlify-docs/self-hosting/environment-variables.mdx. `@exulu/backend`
 *    is a library: the consumer app reads a credential from the environment and
 *    passes it in as a config value (SIGNOZ_ACCESS_TOKEN via ExuluOtel,
 *    VERTEX_CREDENTIALS_PATH via config.litellm.yaml), so the code scan
 *    structurally cannot see those. The documentation page is where the
 *    platform's real secret set is written down, so that is what we test
 *    against.
 *
 * A third mechanism closes the open-ended provider-credential class at runtime
 * rather than by enumeration: every `os.environ/NAME` directive in the resolved
 * config.litellm.yaml is stripped as well (see
 * src/exulu/litellm/os-environ-names.ts, wired in create-sandbox.ts). That is
 * best-effort and non-fatal — a sandbox must still build if the config cannot
 * be read.
 *
 * Variables this codebase never reads — PYMUPDF_MESSAGE, HF_HUB_*, LANG and
 * other third-party runtime settings — are deliberately absent and pass
 * through untouched. This is a declared denylist, not an allowlist, precisely
 * so the document-generation toolchain keeps the runtime variables it needs.
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
  // POSTGRES_DB_USER / REDIS_USER / SMTP_USER: a username alone grants
  // nothing without its paired password. Classified secret anyway — the
  // design's claim is "a skill never sees the platform's own credentials",
  // and a username is half of one. No skill has a legitimate need for the
  // platform's database, cache, or mail identity; an admin can expose one
  // deliberately as a platform variable if that ever changes.
  POSTGRES_DB_USER: "secret",
  REDIS_USER: "secret",
  SMTP_USER: "secret",

  // --- deployment credentials the consumer app reads on our behalf.
  // `@exulu/backend` is a library: these never appear as `process.env.<NAME>` in
  // src/ or ee/, so the code scan cannot see them — they come from the
  // Server/Worker rows of mintlify-docs/self-hosting/environment-variables.mdx
  // and from config.litellm.yaml's `os.environ/` directives. They were reaching
  // every skill until this block existed.
  //
  // VERTEX_CREDENTIALS_PATH is worse than a leaked string: it is a filesystem
  // path to a GCP service-account JSON, and in bwrap mode the sandbox binds /
  // read-only with only ~ denied, so a skill can read the key file at the
  // documented ./vertex-auth.json. Stripping the path does not make that file
  // unreadable — it removes the pointer every tool follows, which is as far as
  // this layer reaches.
  VERTEX_CREDENTIALS_PATH: "secret",
  GOOGLE_VERTEX_CREDENTIALS_JSON: "secret", // inline service-account JSON, same credential without the file
  // A GCP project id is not a password, but it is half of the Vertex identity
  // and no skill has a legitimate need for it — same reasoning as
  // POSTGRES_DB_USER above.
  GOOGLE_VERTEX_PROJECT: "secret",
  COHERE_API_KEY: "secret", // reranker provider key (os.environ/COHERE_API_KEY)
  OPENAI_API_KEY: "secret", // TTS / model provider key
  AZURE_API_KEY_EU: "secret", // image-generation provider key
  SIGNOZ_ACCESS_TOKEN: "secret", // OTLP ingest token; read via ExuluOtel's parameter object, invisible to the code scan
  HF_AUTH_TOKEN: "secret", // HuggingFace token for pyannote diarization; documented as Whisper-container-only, stripped here fail-safe
  LITELLM_API_KEY: "secret", // supervisor-populated proxy key handed to the bundled LiteLLM UI

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
  // Request-rate ceilings for external users, classified exactly as their
  // guest counterparts below: a number of requests is a setting, not a
  // credential. Arrived with the external-rate-limit PR, which predates this
  // inventory and so could not have classified them itself.
  EXULU_EXTERNAL_RATE_PER_HOUR: "runtime",
  EXULU_EXTERNAL_RATE_PER_MINUTE: "runtime",
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
  PUBLIC_API_BASE_URL: "runtime",
  RECALL_REGION: "runtime",
  RECALL_RECORDING_RETENTION_HOURS: "runtime",
  RECALL_STORE_VIDEO_LOCALLY: "runtime",
  REDIS_HOST: "runtime",
  REDIS_PORT: "runtime",
  SERVER_ROOT_PATH: "runtime",
  // OTLP endpoints, not credentials — the token above is the credential. They
  // are credential-SHAPED (`_URL`), so they need a line here for the
  // documentation reconciliation test to pass; `runtime` is the honest answer.
  SIGNOZ_TRACES_URL: "runtime",
  SIGNOZ_LOGS_URL: "runtime",
  SMTP_FROM: "runtime",
  SMTP_HOST: "runtime",
  SMTP_PORT: "runtime",
  SMTP_SECURE: "runtime",
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

/**
 * Shape heuristic for "this name looks like it holds a credential".
 *
 * Feeds the startup WARNING and the documentation reconciliation test only. It
 * must never drive a strip: a name matching this but absent from the inventory
 * passes through to skills by design (§5 of the design — fail open, because an
 * allowlist breaks the document toolchain).
 *
 * `_URL|_URI|_DSN` are in because a connection string carries an embedded
 * password — `DATABASE_URL` / `LITELLM_DATABASE_URL` is the common case and the
 * narrower earlier regex missed it entirely.
 */
export const SECRET_SHAPED_ENV_NAME =
  /(SECRET|PASSWORD|TOKEN|_KEY|CREDENTIAL|PRIVATE|_URL|_URI|_DSN|_PASS\b|PWD|APIKEY|LICENSE)/i;

export const isSecretShapedEnvName = (name: string): boolean =>
  SECRET_SHAPED_ENV_NAME.test(name);

/**
 * Names present in the running environment that look like credentials but are
 * not in the inventory — i.e. set by the deployment, never read by us. Reported
 * at startup as a warning; never stripped, because stripping unknown names is
 * what breaks the document toolchain.
 */
export const findUnclassifiedSecretShaped = (env: NodeJS.ProcessEnv): string[] =>
  Object.keys(env)
    .filter((n) => isSecretShapedEnvName(n) && !(n in ENV_CLASSIFICATION))
    .sort();
