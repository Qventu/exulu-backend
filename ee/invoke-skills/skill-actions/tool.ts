import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ExuluAgentToolConfig } from "@EXULU_TYPES/models/exulu-agent-tool-config";
import type { ExuluContext } from "@SRC/exulu/context";
import { ExuluTool } from "@SRC/exulu/tool";
import { findContextItems, readContextItem } from "@SRC/templates/tools/context-read-tools";
import { ACTION_INPUTS_DIR } from "../artifact-filter";
import type { SessionSandboxHandle } from "../create-sandbox";
import { ensureRealDirectory, removeEntryInside, writeFileInside } from "../safe-fs";
import { describeActions, type LoadedSkillActions } from "./load";
import type { ActionInput } from "./schema";

export const RUN_SKILL_ACTION_TOOL_ID = "run_skill_action";

const TEXT_MAX_CHARS = 10_000;
const ITEMS_DEFAULT_LIMIT = 50;
const ITEMS_MAX_LIMIT = 500;
const ARGS_FILE_STEM = "args";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const listOrNone = (names: string[]) => (names.length ? names.join(", ") : "(none)");

type Resolved =
  | { name: string; type: "item"; context: ExuluContext; input: ActionInput & { type: "item" }; ref: { id?: string; external_id?: string } }
  | { name: string; type: "items"; context: ExuluContext; input: ActionInput & { type: "items" }; where?: Record<string, unknown>; limit?: number }
  | { name: string; type: "text"; value: string };

/**
 * The one tool through which the agent starts a skill action (actions.yaml).
 *
 * Caller-supplied values never reach the shell: the command is exactly
 * `action.run` from the file. Ids, filters and text reach the script only as
 * files in a per-run directory (`$EXULU_INPUTS_DIR`), which the backend writes
 * itself with the link-refusing safe-fs helpers and removes when the command
 * ends, whatever the outcome. Every input is resolved before anything is
 * written or run; any refusal means nothing runs.
 */
export const createRunSkillActionTool = (deps: {
  handle: Pick<SessionSandboxHandle, "sessionDir" | "runCommand">;
  loaded: LoadedSkillActions;
  contexts: ExuluContext[];
  connectedContextIds: Set<string>;
  truncate: (text: string, kind: "stdout" | "stderr") => string;
}): ExuluTool => {
  const { handle, loaded, contexts, connectedContextIds, truncate } = deps;

  const description =
    "Run a declared action of a skill. The platform reads the knowledge-base items the action needs " +
    "with the current user's rights, hands them to the skill's script as files, runs the script in the " +
    "session sandbox and returns its exit code and output (files it creates come back as download links). " +
    "Pass ids, filters and text only in `inputs`. Item inputs take an id string or { external_id }; " +
    `items inputs take { where?, limit? } (default ${ITEMS_DEFAULT_LIMIT}, max ${ITEMS_MAX_LIMIT}); ` +
    `text inputs take a string (max ${TEXT_MAX_CHARS} characters). Available actions:\n` +
    describeActions(loaded);

  return new ExuluTool({
    id: RUN_SKILL_ACTION_TOOL_ID,
    name: RUN_SKILL_ACTION_TOOL_ID,
    category: "skills",
    description,
    type: "function",
    inputSchema: z.object({
      skill: z.string().describe("The skill's name, as listed in this description."),
      action: z.string().describe("The action's name within that skill."),
      inputs: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("The action's inputs by name, as listed in this description."),
    }),
    config: [],
    needsApproval: false,
    execute: async (params: any) => {
      const refuse = (message: string) => ({ result: `Not run: ${message}` });
      const skillName = params?.skill;
      const actionName = params?.action;

      // ── Skill and action (own properties only: "__proto__" must not resolve) ──
      if (typeof skillName !== "string" || !Object.hasOwn(loaded.bySkill, skillName)) {
        return refuse(
          `unknown skill "${String(skillName)}". Available: ${listOrNone(Object.keys(loaded.bySkill))}.`,
        );
      }
      const skill = loaded.bySkill[skillName]!;
      if (typeof actionName !== "string" || !Object.hasOwn(skill.actions, actionName)) {
        return refuse(
          `unknown action "${String(actionName)}" for skill "${skillName}". Available: ${listOrNone(Object.keys(skill.actions))}.`,
        );
      }
      const action = skill.actions[actionName]!;
      const label = `${skillName} / ${actionName}`;
      const declaredNames = Object.keys(action.inputs);
      const inputList = `Inputs of ${label}: ${listOrNone(declaredNames)}.`;

      // ── Input names ──
      const given = params?.inputs === undefined || params?.inputs === null ? {} : params.inputs;
      if (!isPlainObject(given)) {
        return refuse(`inputs must be an object keyed by input name. ${inputList}`);
      }
      for (const key of Object.keys(given)) {
        if (!Object.hasOwn(action.inputs, key)) {
          return refuse(`unknown input "${key}". ${inputList}`);
        }
      }
      const argsInput = Object.hasOwn(action.inputs, ARGS_FILE_STEM) ? action.inputs[ARGS_FILE_STEM] : undefined;
      if (argsInput && argsInput.type !== "text") {
        return refuse(
          `${label} cannot run: its ${argsInput.type} input is named "${ARGS_FILE_STEM}", which collides with ` +
            `${ARGS_FILE_STEM}.json (the file of the text inputs). The skill's actions.yaml must rename it.`,
        );
      }

      // ── Shapes ──
      const resolved: Resolved[] = [];
      for (const [name, input] of Object.entries(action.inputs)) {
        const value = Object.hasOwn(given, name) ? given[name] : undefined;
        if (input.type === "text") {
          if (value === undefined || value === null) {
            if (input.required) return refuse(`input "${name}" is required. ${inputList}`);
            continue;
          }
          if (typeof value !== "string") return refuse(`input "${name}" must be a string.`);
          if (value.length > TEXT_MAX_CHARS) {
            return refuse(`input "${name}" is ${value.length} characters long; the maximum is ${TEXT_MAX_CHARS}.`);
          }
          resolved.push({ name, type: "text", value });
          continue;
        }

        const context = contexts.find((c) => c.id === input.context);
        if (!connectedContextIds.has(input.context) || !context) {
          return refuse(
            `input "${name}" reads the knowledge base "${input.context}", which is not connected to this agent.`,
          );
        }

        if (input.type === "item") {
          if (value === undefined || value === null) return refuse(`input "${name}" is required. ${inputList}`);
          if (typeof value === "string" && value.trim() !== "") {
            resolved.push({ name, type: "item", context, input, ref: { id: value } });
          } else if (
            isPlainObject(value) &&
            Object.keys(value).length === 1 &&
            typeof value.external_id === "string" &&
            value.external_id.trim() !== ""
          ) {
            resolved.push({ name, type: "item", context, input, ref: { external_id: value.external_id } });
          } else {
            return refuse(`input "${name}" must be an item id (a non-empty string) or { "external_id": "<id>" }.`);
          }
          continue;
        }

        // items
        if (value !== undefined && value !== null && !isPlainObject(value)) {
          return refuse(`input "${name}" must be { "where"?: {...}, "limit"?: number } or omitted.`);
        }
        const spec = (value ?? {}) as Record<string, unknown>;
        const surplus = Object.keys(spec).filter((k) => k !== "where" && k !== "limit");
        if (surplus.length) {
          return refuse(`input "${name}" has unknown key "${surplus[0]}"; it takes only "where" and "limit".`);
        }
        if (spec.where !== undefined && !isPlainObject(spec.where)) {
          return refuse(`input "${name}": "where" must be an object of field filters.`);
        }
        if (spec.limit !== undefined && !(typeof spec.limit === "number" && Number.isInteger(spec.limit) && spec.limit >= 1)) {
          return refuse(`input "${name}": "limit" must be a whole number of at least 1 (maximum ${ITEMS_MAX_LIMIT}).`);
        }
        // The yaml's fixed `where` is AND-ed with the caller's: one object,
        // and a field named by both is refused rather than letting one win.
        const fixed = input.where ?? {};
        const callerWhere = (spec.where ?? {}) as Record<string, unknown>;
        const clash = Object.keys(callerWhere).find((k) => Object.hasOwn(fixed, k));
        if (clash) {
          return refuse(
            `input "${name}": the field "${clash}" is already filtered by the action itself and cannot be filtered again.`,
          );
        }
        const where = { ...fixed, ...callerWhere };
        resolved.push({
          name,
          type: "items",
          context,
          input,
          where: Object.keys(where).length ? where : undefined,
          limit: spec.limit as number | undefined,
        });
      }

      // ── Read every input as the speaking user, before anything is written ──
      const caller = { user: params?.user, req: params?.req };
      const files: Array<{ file: string; content: unknown }> = [];
      const warnings: string[] = [];
      const textArgs: Record<string, string> = {};
      for (const r of resolved) {
        if (r.type === "text") {
          textArgs[r.name] = r.value;
          continue;
        }
        if (r.type === "item") {
          const outcome = await readContextItem(r.context, { ...r.ref, fields: r.input.fields }, caller);
          if (!outcome.ok) return refuse(`input "${r.name}": ${outcome.message}`);
          files.push({ file: `${r.name}.json`, content: outcome.item });
          continue;
        }
        const outcome = await findContextItems(
          r.context,
          { where: r.where, limit: r.limit ?? ITEMS_DEFAULT_LIMIT, maxLimit: ITEMS_MAX_LIMIT, fields: r.input.fields },
          caller,
        );
        if (!outcome.ok) return refuse(`input "${r.name}": ${outcome.message}`);
        files.push({
          file: `${r.name}.json`,
          content: { items: outcome.items, limit: outcome.limit, truncated: outcome.truncated },
        });
        if (outcome.truncated) warnings.push(`warning: input "${r.name}" was cut at ${outcome.limit} items`);
      }
      if (resolved.some((r) => r.type === "text")) {
        files.push({ file: `${ARGS_FILE_STEM}.json`, content: textArgs });
      }

      // ── Write, run, always clean up ──
      const sessionDir = handle.sessionDir;
      const runId = randomUUID();
      const runRelative = `${ACTION_INPUTS_DIR}/${runId}`;
      try {
        const parent = await ensureRealDirectory(sessionDir, ACTION_INPUTS_DIR);
        await mkdir(join(parent, runId), { mode: 0o700 });
        for (const { file, content } of files) {
          await writeFileInside(sessionDir, `${runRelative}/${file}`, JSON.stringify(content));
        }
        const outcome = await handle.runCommand(action.run, {
          extraEnv: {
            EXULU_INPUTS_DIR: join(sessionDir, runRelative),
            EXULU_SKILL_DIR: skill.skillDir,
          },
          timeoutMs: action.timeoutSeconds * 1000,
        });
        const lines = [`exit_code: ${outcome.exitCode}`];
        if (outcome.timedOut) lines.push(`timed out after ${action.timeoutSeconds}s`);
        lines.push(...warnings);
        lines.push(`stdout:\n${truncate(outcome.stdout ?? "", "stdout")}`);
        lines.push(`stderr:\n${truncate(outcome.stderr ?? "", "stderr")}`);
        return { result: lines.join("\n") };
      } finally {
        await removeEntryInside(sessionDir, runRelative).catch((err) =>
          console.error(`[SKILLS] Could not remove the action inputs directory ${runRelative}:`, err),
        );
      }
    },
  });
};

/**
 * The agentic search's `knowledge_bases` config as it stands BEFORE the audit
 * loop hydrates it, read with the same rules hydrateVariables applies to a
 * json option. Returns the context ids switched off, or null = unusable.
 * Only rows of type json or string carry their value inline; any other type
 * holding a `variable` is resolved from the variables table during hydration,
 * which has not happened yet here, so it counts as unusable.
 */
const disabledSearchContexts = (searchConfig: ExuluAgentToolConfig | undefined): Set<string> | null => {
  const row = Array.isArray(searchConfig?.config)
    ? searchConfig!.config.find((c) => c?.name === "knowledge_bases")
    : undefined;
  let raw: unknown;
  if (row?.variable) {
    if (row.type !== "json" && row.type !== "string") return null;
    raw = row.variable;
  } else {
    raw = row?.value;
  }
  if (raw === undefined || raw === null) return new Set();
  if (typeof raw === "string") {
    if (raw.trim() === "") return new Set();
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isPlainObject(raw)) return null;
  const disabled = new Set<string>();
  for (const [contextId, profile] of Object.entries(raw)) {
    if (!isPlainObject(profile)) return null;
    if (profile.enabled !== undefined && typeof profile.enabled !== "boolean") return null;
    if (profile.enabled === false) disabled.add(contextId);
  }
  return disabled;
};

/**
 * Which contexts a skill action may read this turn.
 *
 * Principle (design anti-goal): an action must not read a context the agent
 * could not read with its own tools in the same turn. So the set is exactly
 * what the agent's own tools reach:
 *  1. the contexts of its knowledge_base_editor config (they carry get/find tools),
 *  2. when its configured agentic_context_search is active this turn: every
 *     context except those whose `knowledge_bases` entry has enabled === false,
 *  3. otherwise, when a project search was built for this turn: the contexts of
 *     the project's items (the set that search is handed).
 * The agent's memory context is never in the set.
 *
 * Two deliberate differences from the search pipeline:
 *  - Every context disabled → the search contributes nothing (the pipeline
 *    falls back to searching all of them).
 *  - A `knowledge_bases` value present but not usable as an object of
 *    profiles → the search contributes nothing (fail closed; the pipeline
 *    falls back to defaults = everything). Absent or empty means "all enabled".
 */
export const deriveConnectedContextIds = (args: {
  /** Every context available this turn (the `contexts` argument of the conversion). */
  contextIds: string[];
  memoryContextId?: string;
  /** Contexts of the agent's knowledge_base_editor config (already limited to existing contexts). */
  editorContextIds: string[];
  /** Present when the agent's own agentic_context_search is active this turn; its raw agent tool config entry. */
  agenticSearch?: { config?: ExuluAgentToolConfig };
  /** Contexts handed to the project search, when that search (not the agent's own) was built. */
  projectSearchContextIds?: string[];
}): Set<string> => {
  const ids = new Set<string>(args.editorContextIds);
  if (args.agenticSearch) {
    const disabled = disabledSearchContexts(args.agenticSearch.config);
    if (disabled) {
      for (const id of args.contextIds) if (!disabled.has(id)) ids.add(id);
    }
  } else if (args.projectSearchContextIds) {
    for (const id of args.projectSearchContextIds) ids.add(id);
  }
  if (args.memoryContextId) ids.delete(args.memoryContextId);
  return ids;
};
