import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Shared configuration, paths, and env-var resolution for the Hermes Agent
 * integration ("advanced agent mode").
 *
 * Hermes is an external agent harness (Nous Research). Unlike LiteLLM, it is
 * not pip-installed into our venv — it ships as a standalone binary via the
 * official installer (typically ~/.local/bin/hermes). Each Exulu agent maps to
 * an isolated Hermes *profile* (a HERMES_HOME directory), and each profile that
 * is in use runs its own `hermes gateway` process on its own port.
 *
 * The whole feature is gated by ENABLE_HERMES_AGENT — when unset, none of this
 * code path is reachable and Exulu behaves exactly as before.
 *
 * Design doc: docs/superpowers/specs/2026-06-03-hermes-agent-mode-design.md
 */

/**
 * Whether advanced (Hermes) agent mode is enabled for this Exulu instance.
 * This is the global gate; individual agents additionally opt in via their
 * `advanced_mode` column.
 */
export const isHermesEnabled = (): boolean =>
  process.env.ENABLE_HERMES_AGENT === "true";

/**
 * Root directory under which all Hermes profile homes live. Each profile is a
 * subdirectory of `${HERMES_HOME}/profiles/<profileId>` selected by setting the
 * child process's HERMES_HOME to that subdirectory.
 *
 * Defaults to ~/.hermes (Hermes' own default) but is overridable so deployments
 * can place it on a writable volume.
 */
export const getHermesHome = (): string => {
  const raw = process.env.HERMES_HOME?.trim();
  if (raw && raw.length > 0) {
    return raw.startsWith("~")
      ? join(homedir(), raw.slice(1))
      : resolve(raw);
  }
  return join(homedir(), ".hermes");
};

/**
 * Absolute path to a profile's HERMES_HOME directory.
 *
 * `profileId` is either `<agentId>` (shared scope) or `<agentId>/<userId>`
 * (private scope). The latter contains a slash and resolves to a nested
 * directory, which is intentional and harmless on every supported platform.
 */
export const getProfileDir = (profileId: string): string =>
  join(getHermesHome(), "profiles", profileId);

/**
 * Resolve the `hermes` binary. The official installer drops it in ~/.local/bin
 * (user install) or /usr/local/bin (root install); operators can override with
 * HERMES_BIN. We deliberately do NOT fall back to a bare `hermes` on PATH for
 * spawning unless nothing else resolves, so behaviour is deterministic across
 * cron/headless environments where PATH may be minimal.
 */
export const resolveHermesBin = (): string | undefined => {
  const override = process.env.HERMES_BIN?.trim();
  if (override && existsSync(override)) return override;

  const candidates = [
    join(homedir(), ".local", "bin", "hermes"),
    "/usr/local/bin/hermes",
    "/opt/homebrew/bin/hermes",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Last resort: let spawn resolve it via PATH. Returns the bare command so the
  // caller can still attempt a launch and surface a clear error if PATH lacks it.
  return undefined;
};

export type HermesPortRange = { start: number; end: number };

/**
 * Parse HERMES_PORT_RANGE (e.g. "8642-8700") into an inclusive range the
 * gateway pool allocates from. Defaults to 8642-8700 (Hermes' default API
 * server port is 8642). Throws on a malformed value so misconfiguration fails
 * fast at boot rather than at first agent request.
 */
export const getPortRange = (): HermesPortRange => {
  const raw = process.env.HERMES_PORT_RANGE?.trim() ?? "8642-8700";
  const match = /^(\d{2,5})-(\d{2,5})$/.exec(raw);
  if (!match) {
    throw new Error(
      `Invalid HERMES_PORT_RANGE="${raw}". Expected "<start>-<end>", e.g. "8642-8700".`,
    );
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > end || end > 65535) {
    throw new Error(
      `Invalid HERMES_PORT_RANGE="${raw}". Start must be <= end and within 1-65535.`,
    );
  }
  return { start, end };
};

/**
 * Maximum number of gateway processes kept alive at once (LRU cap). When the
 * pool is full and a new profile needs a gateway, the least-recently-used idle
 * gateway is evicted to make room. Defaults to 20.
 */
export const getMaxGateways = (): number => {
  const raw = process.env.HERMES_MAX_GATEWAYS?.trim();
  const n = raw ? Number(raw) : 20;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
};

/**
 * Idle timeout (ms) after which an unused gateway is shut down by the sweeper.
 * Defaults to 15 minutes.
 */
export const getIdleTimeoutMs = (): number => {
  const raw = process.env.HERMES_IDLE_TIMEOUT_MS?.trim();
  const n = raw ? Number(raw) : 15 * 60 * 1000;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 15 * 60 * 1000;
};

export const HERMES_HOST = "127.0.0.1";

/**
 * The base URL the LiteLLM proxy is reachable at from a Hermes gateway. Hermes
 * profiles point their `model.base_url` here so every model call still flows
 * through LiteLLM (the single model gateway). Mirrors the LiteLLM supervisor's
 * host/port resolution.
 */
export const getLiteLLMBaseUrl = (): string => {
  const host = process.env.LITELLM_HOST ?? "127.0.0.1";
  const port = process.env.LITELLM_PORT ?? "4000";
  return `http://${host}:${port}/v1`;
};

/** Resolve a path that may be relative to the package root. */
export const resolveFromRoot = (root: string, p: string): string =>
  isAbsolute(p) ? p : join(root, p);

/**
 * Bearer token guarding the ExuluTools MCP endpoint (and written into each
 * profile's config.yaml `mcp_servers` header via the .env). Defaults to
 * LITELLM_MASTER_KEY so no new secret is required; override with EXULU_MCP_KEY.
 */
export const getExuluMcpKey = (): string =>
  process.env.EXULU_MCP_KEY?.trim() || process.env.LITELLM_MASTER_KEY || "";

/**
 * Base URL a Hermes gateway uses to reach Exulu's MCP endpoint. Exulu is a
 * library (the host app binds the port), so this is configured, not inferred.
 * Defaults to 127.0.0.1:<EXULU_PORT|PORT|3000> since the gateway is co-located.
 */
export const getExuluMcpBaseUrl = (): string => {
  const explicit = process.env.BACKEND?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const host = process.env.EXULU_MCP_HOST ?? "127.0.0.1";
  const port = process.env.EXULU_PORT ?? process.env.PORT ?? "3000";
  return `http://${host}:${port}`;
};

/** Full MCP URL for a given agent, written into the profile config.yaml. */
export const exuluMcpUrlFor = (agentId: string): string =>
  `${getExuluMcpBaseUrl()}/mcp/${agentId}`;

/**
 * Validate Hermes configuration at boot when ENABLE_HERMES_AGENT=true.
 *
 * Hermes gateways are lazy-started (nothing spawns at boot), so this only
 * surfaces misconfiguration early: a malformed port range fails fast, and a
 * missing binary / missing LiteLLM master key warn loudly (advanced-mode
 * requests will error clearly until fixed, but Exulu keeps booting).
 */
export const validateHermesAtBoot = (): void => {
  if (!isHermesEnabled()) return;
  const log = (line: string) => console.log(`[EXULU-HERMES] ${line}`);

  // Fail fast on a malformed range (throws).
  const range = getPortRange();

  const bin = resolveHermesBin();
  if (!bin) {
    console.warn(
      "[EXULU-HERMES] ENABLE_HERMES_AGENT=true but the 'hermes' binary was not found " +
        "(~/.local/bin/hermes, /usr/local/bin/hermes, or HERMES_BIN). Advanced agent mode " +
        "requests will fail until it is installed. Install: " +
        "https://hermes-agent.nousresearch.com/docs/getting-started/installation",
    );
  } else {
    log(`Advanced agent mode enabled. Binary: ${bin}. Port pool: ${range.start}-${range.end}.`);
  }

  if (!process.env.LITELLM_MASTER_KEY) {
    console.warn(
      "[EXULU-HERMES] LITELLM_MASTER_KEY is not set; Hermes profiles point at LiteLLM and " +
        "will fail to authenticate model calls until it is configured.",
    );
  }

  // Native tools run via the configured terminal backend. `docker` (default)
  // isolates them without host user namespaces but requires Docker to be
  // reachable by the host process.
  const backend = process.env.HERMES_TERMINAL_BACKEND?.trim() || "docker";
  if (backend === "docker") {
    log(
      "Tool isolation: docker backend. Ensure Docker is available to this process " +
        "(set HERMES_TERMINAL_BACKEND=local to disable, but the agent's shell/file tools " +
        "then run unsandboxed on the host).",
    );
  } else if (backend === "local") {
    console.warn(
      "[EXULU-HERMES] HERMES_TERMINAL_BACKEND=local: the agent's native shell/file tools run " +
        "UNSANDBOXED on the host. Use 'docker' (default) for isolation in shared/production deployments.",
    );
  } else {
    log(`Tool isolation: ${backend} backend.`);
  }
};
