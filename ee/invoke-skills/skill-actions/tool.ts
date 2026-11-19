import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ExuluAgentToolConfig } from "@EXULU_TYPES/models/exulu-agent-tool-config";
import type { ExuluContext } from "@SRC/exulu/context";
import { ExuluTool } from "@SRC/exulu/tool";
import { findContextItems, readContextItem } from "@SRC/templates/tools/context-read-tools";
import { contextToolSegment } from "@SRC/templates/tools/context-write-tools";
import { ACTION_INPUTS_DIR, splitArtifactsBlock } from "../artifact-filter";
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
  /** Cuts `text` to about `charLimit` characters (plus a truncation marker). */
  truncate: (text: string, kind: "stdout" | "stderr", charLimit: number) => string;
  /**
   * The generic tool-output guard's cap in characters (serialized result). The result is
   * kept under it, so the guard never collapses it to a preview that drops the links.
   */
  resultCharLimit: number;
}): ExuluTool => {
  const { handle, loaded, contexts, connectedContextIds, truncate, resultCharLimit } = deps;

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
        const fixed = [`exit_code: ${outcome.exitCode}`];
        if (outcome.timedOut) fixed.push(`timed out after ${action.timeoutSeconds}s`);
        fixed.push(...warnings);
        const { output, block } = splitArtifactsBlock(
          outcome.stdout ?? "",
          (outcome.artifacts ?? []).some((a) => a.url),
        );
        return {
          result: fitResult({
            fixed,
            stdout: output,
            artifactsBlock: block,
            stderr: outcome.stderr ?? "",
            truncate,
            limit: resultCharLimit,
          }),
        };
      } finally {
        await removeEntryInside(sessionDir, runRelative).catch((err) =>
          console.error(`[SKILLS] Could not remove the action inputs directory ${runRelative}:`, err),
        );
      }
    },
  });
};

/** Room left for JSON escaping estimates and rounding below the guard's cap. */
const RESULT_MARGIN_CHARS = 256;
const STDERR_SHARE = 0.3;

/**
 * Assembles the result text so that `{ result }`, serialized as the generic guard does,
 * stays under `limit`: the fixed lines and the artifacts block are kept whole, only the
 * script's own stdout and stderr are truncated, against budgets that sum to what is left.
 * Output that already fits is returned unchanged.
 */
export const fitResult = (p: {
  fixed: string[];
  stdout: string;
  artifactsBlock: string;
  stderr: string;
  truncate: (text: string, kind: "stdout" | "stderr", charLimit: number) => string;
  limit: number;
}): string => {
  const assemble = (out: string, err: string) =>
    [...p.fixed, `stdout:\n${out}${p.artifactsBlock}`, `stderr:\n${err}`].join("\n");
  // Measured as the guard measures: the serialized tool result.
  const size = (text: string) => JSON.stringify({ result: text }).length;
  const full = assemble(p.stdout, p.stderr);
  if (size(full) <= p.limit) return full;

  const room = p.limit - size(assemble("", "")) - RESULT_MARGIN_CHARS;
  if (room <= 0) return assemble("", ""); // the fixed lines and links alone fill the cap
  // Split the room; a stream shorter than its share hands the rest to the other one.
  let errBudget = Math.min(p.stderr.length, Math.floor(room * STDERR_SHARE));
  let outBudget = Math.min(p.stdout.length, room - errBudget);
  errBudget = Math.min(p.stderr.length, room - outBudget);
  for (let attempt = 0; attempt < 6; attempt++) {
    const out = p.stdout.length <= outBudget ? p.stdout : p.truncate(p.stdout, "stdout", Math.max(1, outBudget));
    const err = p.stderr.length <= errBudget ? p.stderr : p.truncate(p.stderr, "stderr", Math.max(1, errBudget));
    const text = assemble(out, err);
    const over = size(text) - p.limit;
    if (over <= 0) return text;
    // Truncation markers and JSON escaping (newlines, quotes) cost more than the raw
    // count; shrink the budgets of the streams being cut by the overshoot and try again.
    // A stream that fits whole keeps its budget, so it is never cut for nothing.
    const outCut = out !== p.stdout;
    const errCut = err !== p.stderr;
    const total = (outCut ? outBudget : 0) + (errCut ? errBudget : 0);
    const scale = Math.max(0, (total - over - RESULT_MARGIN_CHARS) / Math.max(1, total)) * 0.9;
    if (outCut) outBudget = Math.floor(outBudget * scale);
    if (errCut) errBudget = Math.floor(errBudget * scale);
  }
  return assemble("", "");
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
 *  1. the contexts of its knowledge_base_editor config (they carry get/find
 *     tools), unless BOTH of a context's read tools (get_<ctx>_item,
 *     find_<ctx>_items) are disabled this turn — then its own tools cannot
 *     read it, whatever its write tools may do,
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
  /** Tool ids disabled for this turn; an editor context whose two read tools are both in it does not count. */
  disabledToolIds?: ReadonlySet<string>;
  /** Present when the agent's own agentic_context_search is active this turn; its raw agent tool config entry. */
  agenticSearch?: { config?: ExuluAgentToolConfig };
  /** Contexts handed to the project search, when that search (not the agent's own) was built. */
  projectSearchContextIds?: string[];
}): Set<string> => {
  const ids = new Set<string>();
  for (const id of args.editorContextIds) {
    const segment = contextToolSegment({ id });
    const readToolIds = [`get_${segment}_item`, `find_${segment}_items`];
    if (readToolIds.some((toolId) => !args.disabledToolIds?.has(toolId))) ids.add(id);
  }
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
