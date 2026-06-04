import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  exuluMcpUrlFor,
  getExuluMcpKey,
  getLiteLLMBaseUrl,
  getProfileDir,
} from "./config";

/**
 * Materializes a Hermes *profile* directory for an Exulu agent.
 *
 * A profile is an isolated HERMES_HOME containing the agent's durable identity:
 *   - config.yaml : model block (pointed at the LiteLLM proxy), plus MCP and
 *                   skills sections (added in Phases 3 & 4).
 *   - SOUL.md     : the agent's personality / system-prompt identity, seeded
 *                   from the Exulu agent's `instructions`. Hermes never
 *                   overwrites an existing SOUL.md, so Exulu owns this file and
 *                   rewrites it whenever instructions change.
 *   - .env        : profile-local secrets referenced by ${VAR} in config.yaml
 *                   (currently just LITELLM_MASTER_KEY), written 0600.
 *
 * Runtime API-server params (port, key, host) are intentionally NOT written
 * here — the supervisor injects them via the child env so a profile dir is
 * portable across ports and restarts.
 *
 * Provisioning is idempotent and content-hashed: we only rewrite when an input
 * that affects the profile changed, recorded in `.exulu-hash`.
 *
 * Design doc: docs/superpowers/specs/2026-06-03-hermes-agent-mode-design.md
 */

/** Bump when the generated file *format* changes, to force a re-provision. */
const PROVISION_FORMAT_VERSION = 5;

const HASH_FILE = ".exulu-hash";

/**
 * Tool-approval policy written to config.yaml. `smart` auto-approves low-risk
 * actions and emits an approval event (requiring a decision) for destructive
 * ones. Overridable via HERMES_APPROVALS_MODE.
 */
const getApprovalsMode = (): string =>
  process.env.HERMES_APPROVALS_MODE?.trim() || "smart";

/**
 * Terminal backend that runs the agent's native shell/file tools. Defaults to
 * `docker` so isolation is identical everywhere (Docker Desktop on macOS, the
 * Docker daemon on Linux) and does NOT depend on unprivileged user namespaces
 * (which our deploy hosts lack — the reason bwrap-style sandboxes fell back).
 * `local` (no isolation) and Hermes' other backends (ssh/modal/daytona/
 * singularity) remain selectable via HERMES_TERMINAL_BACKEND.
 */
const getTerminalBackend = (): string =>
  process.env.HERMES_TERMINAL_BACKEND?.trim() || "docker";

/** Image for the docker terminal backend (needs python + node for tools). */
const getDockerImage = (): string =>
  process.env.HERMES_DOCKER_IMAGE?.trim() ||
  "nikolaik/python-nodejs:python3.11-nodejs20";

/** The agent id keying the MCP endpoint — explicit, or the profileId's first segment. */
const agentIdOf = (input: ProvisionInput): string =>
  input.agentId ?? input.profileId.split("/")[0]!;

export type ProvisionInput = {
  /** `<agentId>` (shared) or `<agentId>/<userId>` (private). */
  profileId: string;
  /**
   * The Exulu agent id — keys the agent's MCP tool endpoint (/mcp/<agentId>).
   * Optional: defaults to the first segment of profileId, which is always the
   * agent id.
   */
  agentId?: string;
  /** Agent instructions → SOUL.md. */
  instructions: string | undefined;
  /** LiteLLM model_name this agent should use (resolved by the caller). */
  modelName: string;
  /** Enabled skills (id + version) — affects the hash now, synced in Phase 4. */
  skills?: Array<{ id: string; version?: number }>;
  /** Enabled tool ids — affects the hash now, exposed via MCP in Phase 3. */
  toolIds?: string[];
};

/** Serialize the inputs that determine profile contents into a stable hash. */
const computeHash = (input: ProvisionInput): string => {
  const canonical = JSON.stringify({
    v: PROVISION_FORMAT_VERSION,
    instructions: input.instructions ?? "",
    modelName: input.modelName,
    litellm: getLiteLLMBaseUrl(),
    approvals: getApprovalsMode(),
    terminal: getTerminalBackend(),
    dockerImage: getDockerImage(),
    mcp: exuluMcpUrlFor(agentIdOf(input)),
    skills: (input.skills ?? [])
      .map((s) => `${s.id}@${s.version ?? 1}`)
      .sort(),
    toolIds: [...(input.toolIds ?? [])].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
};

const DEFAULT_SOUL = `You are a helpful, capable assistant.`;

/** YAML-safe double-quoted scalar (handles the limited set of chars we emit). */
const yamlString = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const renderConfigYaml = (
  input: ProvisionInput,
  workspaceDir: string,
  exuluSkillsDir: string,
): string => {
  const hasSkills = (input.skills?.length ?? 0) > 0;
  // Hermes calls model.base_url directly when set, authenticating with
  // model.api_key. We point it at the LiteLLM proxy so every model call still
  // flows through the single model gateway. ${LITELLM_MASTER_KEY} is resolved
  // by Hermes from the profile .env (and the inherited process env).
  // NOTE: the model-name key is `default`, not `model`.
  return [
    "# Generated by Exulu — do not edit by hand.",
    "# Regenerated whenever the agent's instructions / model / skills / tools change.",
    "# Design doc: docs/superpowers/specs/2026-06-03-hermes-agent-mode-design.md",
    "model:",
    `  default: ${yamlString(input.modelName)}`,
    "  provider: custom",
    `  base_url: ${yamlString(getLiteLLMBaseUrl())}`,
    '  api_key: "${LITELLM_MASTER_KEY}"',
    "  api_mode: chat_completions",
    "",
    "# Tool-approval policy: `smart` auto-approves low-risk actions and emits an",
    "# approval event (requiring a decision) before destructive ones.",
    "approvals:",
    `  mode: ${getApprovalsMode()}`,
    "",
    // Native shell/file tools run via this backend. `docker` isolates them in a
    // hardened, Hermes-managed container (cap-drop ALL, no-new-privileges) that
    // works without host user namespaces. Volumes are bind-mounted host->same
    // path so the absolute cwd and skills.external_dirs below resolve inside the
    // container; secrets (config.yaml/.env) are NOT mounted. cwd MUST be
    // absolute — Hermes treats '.' as the launch dir, not the profile dir.
    "terminal:",
    `  backend: ${getTerminalBackend()}`,
    `  cwd: ${yamlString(workspaceDir)}`,
    ...(getTerminalBackend() === "docker"
      ? [
          `  docker_image: ${yamlString(getDockerImage())}`,
          "  docker_volumes:",
          `    - ${yamlString(`${workspaceDir}:${workspaceDir}`)}`,
          ...((input.skills?.length ?? 0) > 0
            ? [`    - ${yamlString(`${exuluSkillsDir}:${exuluSkillsDir}:ro`)}`]
            : []),
        ]
      : []),
    "",
    "# ExuluTools exposed over HTTP MCP. These ADD to Hermes' native tools",
    "# (bash, filesystem, …) — they do not replace them. The key is resolved",
    "# from the profile .env.",
    "mcp_servers:",
    "  exulu:",
    `    url: ${yamlString(exuluMcpUrlFor(agentIdOf(input)))}`,
    "    headers:",
    '      Authorization: "Bearer ${EXULU_MCP_KEY}"',
    "",
    // Exulu skills synced from S3 (Anthropic Agent Skills format) into a
    // dedicated dir, ADDED to Hermes' own skills home (learned/bundled skills).
    ...(hasSkills
      ? [
          "skills:",
          "  external_dirs:",
          `    - ${yamlString(exuluSkillsDir)}`,
          "",
        ]
      : ["# skills: no Exulu skills enabled for this agent.", ""]),
  ].join("\n");
};

const renderEnv = (): string => {
  const masterKey = process.env.LITELLM_MASTER_KEY ?? "";
  return [
    "# Generated by Exulu — profile-local secrets referenced by config.yaml.",
    `LITELLM_MASTER_KEY=${masterKey}`,
    `EXULU_MCP_KEY=${getExuluMcpKey()}`,
    "",
  ].join("\n");
};

const renderSoul = (instructions: string | undefined): string => {
  const body = instructions?.trim();
  return body && body.length > 0 ? `${body}\n` : `${DEFAULT_SOUL}\n`;
};

/** In-flight provisioning per profile, so concurrent requests don't race. */
const inFlight = new Map<string, Promise<void>>();

/**
 * Ensure the profile directory for `input.profileId` exists and is current.
 * Returns once the profile is ready for a gateway to launch against.
 */
export const ensureProfile = async (input: ProvisionInput): Promise<void> => {
  const existing = inFlight.get(input.profileId);
  if (existing) return existing;

  const task = (async () => {
    const dir = getProfileDir(input.profileId);
    // The agent's shell/file tools are bound here (terminal.cwd). Creating it
    // also creates the profile dir (recursive).
    const workspaceDir = join(dir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    // Where syncProfileSkills downloads enabled Exulu skills; referenced by
    // config.yaml skills.external_dirs. The files themselves are synced
    // separately (the provisioner is S3-free).
    const exuluSkillsDir = join(dir, "exulu-skills");

    const hash = computeHash(input);
    const hashPath = join(dir, HASH_FILE);
    const current = await readFile(hashPath, "utf8").catch(() => undefined);
    if (current?.trim() === hash) return; // up to date

    await writeFile(
      join(dir, "config.yaml"),
      renderConfigYaml(input, workspaceDir, exuluSkillsDir),
      "utf8",
    );
    // SOUL.md is owned by Exulu (Hermes won't overwrite an existing one), so we
    // always rewrite it to propagate instruction edits.
    await writeFile(join(dir, "SOUL.md"), renderSoul(input.instructions), "utf8");
    await writeFile(join(dir, ".env"), renderEnv(), { encoding: "utf8", mode: 0o600 });

    // Write the hash last so a crash mid-write leaves a stale-but-detected
    // state that re-provisions next time, rather than a false "up to date".
    await writeFile(hashPath, hash, "utf8");
  })().finally(() => {
    inFlight.delete(input.profileId);
  });

  inFlight.set(input.profileId, task);
  return task;
};

/** Derive the profile id for an agent + (optional) user, honoring scope. */
export const profileIdFor = (
  agentId: string,
  scope: "shared" | "private",
  userId?: number | string,
): string => {
  if (scope === "private") {
    if (userId === undefined || userId === null || `${userId}`.length === 0) {
      throw new Error(
        `Private-scope agent ${agentId} requires a user id to derive its profile.`,
      );
    }
    return `${agentId}/${userId}`;
  }
  return agentId;
};

export { getProfileDir };
