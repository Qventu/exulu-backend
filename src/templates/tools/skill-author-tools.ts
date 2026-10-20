/**
 * The skill-authoring tools an agent gets when its config carries the
 * `skill_author` entry: list and read what exists, create a new skill, or
 * publish a new version of one the user may write. Storage and rows follow
 * the registry routes exactly (skills/<id>/v<N>/… in object storage, one
 * history entry per version), so the Skills page, `imp install` and the
 * sandbox all see the result as a normal skill.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import { ExuluTool } from "@SRC/exulu/tool";
import { postgresClient } from "@SRC/postgres/client";
import { canAccessSkill, filterReadableSkills, resolveSkillByName } from "@SRC/skills/skill-access";
import { parseFrontmatter } from "@SRC/skills/frontmatter";
import { copyS3Object, deleteS3Object, getS3ObjectContent, listS3ObjectsByPrefix, uploadFile } from "@SRC/uppy/index";
import { handleRBACUpdate } from "@EE/rbac-update.ts";

import type { SkillDecision } from "@SRC/exulu/skills/decisions";
import { parseSkillAuthorConfig, SKILL_AUTHOR_TOOL_ID } from "./skill-author-config";

type CreateDecision = Extract<SkillDecision, { kind: "create" }>;
type UpdateDecision = Extract<SkillDecision, { kind: "update" }>;

const MAX_FILES = 100;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_READ_BYTES = 60 * 1024;

export type SkillFileInput = { path: string; content: string };

export type SkillToolOutput =
  | { type: "skill_list"; skills: Array<{ id: string; name: string; description: string; version: number }>; result: string }
  | { type: "skill_read"; skillId: string; name: string; version: number; files: string[]; path: string; content: string; result: string }
  | { type: "skill_created"; skillId: string; name: string; version: number; rights_mode: string; files: string[]; enableOnAgent: boolean; result: string }
  | { type: "skill_updated"; skillId: string; name: string; version: number; rights_mode: string; changed: string[]; removed: string[]; enableOnAgent: boolean; result: string }
  | { type: "skill_no_access"; skill: string; result: string }
  | { type: "skill_error"; result: string };

export type SkillToolDeps = {
  db?: () => Promise<any>;
  io?: Partial<SkillIo>;
  now?: () => Date;
};

type SkillIo = {
  upload: (bytes: Buffer, key: string, config: any, contentType: string) => Promise<unknown>;
  list: (prefix: string, config: any) => Promise<Array<{ key: string }>>;
  copy: (sourceKey: string, destKey: string, config: any) => Promise<void>;
  remove: (key: string, config: any) => Promise<void>;
  read: (key: string, config: any) => Promise<string>;
};

const defaultIo = (): SkillIo => ({
  upload: (bytes, key, config, contentType) => uploadFile(bytes, key, config, { contentType }, undefined, undefined, true),
  list: (prefix, config) => listS3ObjectsByPrefix(prefix, config),
  copy: (a, b, config) => copyS3Object(a, b, config),
  remove: (key, config) => deleteS3Object(key, config),
  read: (key, config) => getS3ObjectContent(key, config),
});

const err = (result: string): SkillToolOutput => ({ type: "skill_error", result });

/** A relative path inside the bundle: forward slashes, no traversal, no absolute root, no control characters. */
export const safeSkillPath = (raw: string): string | null => {
  const p = String(raw ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "");
  if (!p || p.length > 200) return null;
  if (/[\x00-\x1f\x7f]/.test(p)) return null;
  if (p.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return p;
};

const contentTypeFor = (path: string): string => {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const types: Record<string, string> = {
    md: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    html: "text/html",
    csv: "text/csv",
    py: "text/x-python",
    sh: "text/x-shellscript",
    js: "text/javascript",
    ts: "text/typescript",
    yaml: "text/yaml",
    yml: "text/yaml",
  };
  return types[ext] ?? "text/plain";
};

const yamlString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;

/** SKILL.md must open with frontmatter naming the skill; add it when the model left it out. */
export const ensureFrontmatter = (content: string, name: string, description: string): string => {
  if (/^---\s*\n/.test(content)) return content;
  return `---\nname: ${yamlString(name)}\ndescription: ${yamlString(description)}\n---\n\n${content.replace(/^\s+/, "")}`;
};

const generalPrefix = (config: any): string =>
  config?.fileUploads?.s3prefix ? `${String(config.fileUploads.s3prefix).replace(/\/+$/, "")}/` : "";

const relativePaths = (keys: Array<{ key: string }>, config: any, prefix: string): string[] =>
  keys.map((f) => f.key.replace(generalPrefix(config) + prefix, "")).filter((p) => p && !p.endsWith("/"));

async function resolveSkill(db: any, ref: string): Promise<any | null> {
  const value = String(ref ?? "").trim();
  if (!value) return null;
  const byId = /^[0-9a-f-]{36}$/i.test(value) ? await db("skills").where({ id: value }).first() : null;
  return byId ?? (await resolveSkillByName(db, value));
}

const normalizeFiles = (raw: unknown): { files: SkillFileInput[] } | { error: string } => {
  if (!Array.isArray(raw)) return { files: [] };
  if (raw.length > MAX_FILES) return { error: `At most ${MAX_FILES} files per call.` };
  const files: SkillFileInput[] = [];
  for (const entry of raw) {
    const path = safeSkillPath((entry as any)?.path);
    const content = typeof (entry as any)?.content === "string" ? (entry as any).content : null;
    if (!path) return { error: `"${String((entry as any)?.path ?? "")}" is not a valid file path inside the skill (relative, no "..").` };
    if (content === null) return { error: `File "${path}" has no text content.` };
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) return { error: `File "${path}" is larger than ${MAX_FILE_BYTES / 1024} KB.` };
    files.push({ path, content });
  }
  return { files };
};

export const createSkillAuthorTools = (agent: ExuluAgent, deps: SkillToolDeps = {}): ExuluTool[] => {
  const config = parseSkillAuthorConfig(agent.tools as any);
  if (!config.enabled) return [];
  const io: SkillIo = { ...defaultIo(), ...(deps.io ?? {}) };
  const getDb = deps.db ?? (async () => (await postgresClient()).db);
  const now = deps.now ?? (() => new Date());
  const category = `${agent.name}_skills`;
  // Like the memory tools: when a card is wanted, it is wanted every time —
  // "approve for this chat" must not skip the visibility choice.
  const approvalFn = config.skipApproval ? undefined : async () => true;
  const tools: ExuluTool[] = [];

  tools.push(
    new ExuluTool({
      id: "skill_list",
      name: "skill_list",
      category,
      type: "function",
      config: [],
      needsApproval: false,
      description:
        "List the skills in this instance's library that the current user may read: name, description and current version. Use it before creating a skill to avoid duplicates, and before updating one.",
      inputSchema: z.object({ query: z.string().optional().describe("Optional substring to filter by name or description") }),
      execute: async (params: any): Promise<SkillToolOutput> => {
        const { user } = params;
        if (!user?.id) return err("Skills require a signed-in user.");
        const db = await getDb();
        const rows = await db("skills").select("id", "name", "description", "current_version", "rights_mode", "created_by");
        const readable = await filterReadableSkills(db, rows, user);
        const q = String(params.query ?? "").trim().toLowerCase();
        const skills = readable
          .filter((s: any) => !q || `${s.name} ${s.description ?? ""}`.toLowerCase().includes(q))
          .map((s: any) => ({ id: s.id, name: s.name, description: s.description ?? "", version: s.current_version ?? 1 }));
        return {
          type: "skill_list",
          skills,
          result: skills.length ? skills.map((s) => `${s.name} (v${s.version}): ${s.description}`).join("\n") : "No skills found.",
        };
      },
    }),
  );

  tools.push(
    new ExuluTool({
      id: "skill_read",
      name: "skill_read",
      category,
      type: "function",
      config: [],
      needsApproval: false,
      description:
        "Read a skill the user may access: its file list and the content of SKILL.md, or of one file by path. Use it before updating a skill so you change only what must change.",
      inputSchema: z.object({
        skill: z.string().describe("The skill's name or id"),
        path: z.string().optional().describe("A file path inside the skill to read instead of SKILL.md"),
      }),
      execute: async (params: any): Promise<SkillToolOutput> => {
        const { user, exuluConfig } = params;
        if (!user?.id) return err("Skills require a signed-in user.");
        const db = await getDb();
        const skill = await resolveSkill(db, params.skill);
        if (!skill || !(await canAccessSkill(db, skill, "read", user))) {
          return { type: "skill_no_access", skill: String(params.skill), result: `No skill "${params.skill}" that you can read.` };
        }
        const version = skill.current_version ?? 1;
        const prefix = `skills/${skill.id}/v${version}/`;
        const files = relativePaths(await io.list(prefix, exuluConfig), exuluConfig, prefix);
        const path = params.path ? safeSkillPath(params.path) : "SKILL.md";
        if (!path) return err(`"${params.path}" is not a valid path inside the skill.`);
        if (!files.includes(path)) return err(`The skill has no file "${path}". Files: ${files.join(", ") || "(none)"}`);
        let content = await io.read(generalPrefix(exuluConfig) + prefix + path, exuluConfig);
        if (Buffer.byteLength(content, "utf8") > MAX_READ_BYTES) content = content.slice(0, MAX_READ_BYTES) + "\n…(truncated)";
        return {
          type: "skill_read",
          skillId: skill.id,
          name: skill.name,
          version,
          files,
          path,
          content,
          result: `Skill "${skill.name}" v${version}, files: ${files.join(", ")}\n\n--- ${path} ---\n${content}`,
        };
      },
    }),
  );

  if (config.create) {
    tools.push(
      new ExuluTool({
        id: "skill_create",
        name: "skill_create",
        category,
        type: "function",
        config: [],
        needsApproval: !config.skipApproval,
        needsApprovalFn: approvalFn,
        description:
          "Propose a NEW skill from a procedure the user just completed. Give it a short name, a one-line description, and its files: a SKILL.md with frontmatter and clear steps, plus reference files only where useful. " +
          "The user confirms name, description and visibility on a card before anything is created; never claim it exists until this tool returns skill_created.",
        inputSchema: z.object({
          name: z.string().describe("Short, specific skill name (e.g. 'quarterly-report-from-crm')"),
          description: z.string().describe("One line: what the skill does and when to use it"),
          files: z
            .array(z.object({ path: z.string().describe("Relative path inside the skill, e.g. SKILL.md or references/checklist.md"), content: z.string() }))
            .min(1)
            .describe("The skill's files; SKILL.md is required"),
        }),
        execute: async (params: any): Promise<SkillToolOutput> => {
          const { user, exuluConfig } = params;
          if (!user?.id) return err("Skills require a signed-in user.");
          if (!exuluConfig?.fileUploads) return err("File uploads are not configured on this instance, so skills cannot be stored.");
          const decision: CreateDecision | undefined = params.skillDecision?.kind === "create" ? (params.skillDecision as CreateDecision) : undefined;
          const name = String(decision?.name ?? params.name ?? "").trim();
          const description = String(decision?.description ?? params.description ?? "").trim();
          if (!name || name.length > 80) return err("A skill needs a name of at most 80 characters.");
          const parsed = normalizeFiles(params.files);
          if ("error" in parsed) return err(parsed.error);
          const files = parsed.files;
          const skillMd = files.find((f) => f.path === "SKILL.md");
          if (!skillMd) return err("A skill needs a SKILL.md at its root.");
          skillMd.content = ensureFrontmatter(skillMd.content, name, description);
          const db = await getDb();
          if (await resolveSkillByName(db, name)) return err(`A skill named "${name}" already exists. Use skill_update to change it, or choose another name.`);
          const rights_mode = decision?.rights_mode ?? "private";
          const skillId = randomUUID();
          const stamp = now().toISOString();
          for (const f of files) {
            await io.upload(Buffer.from(f.content, "utf8"), `skills/${skillId}/v1/${f.path}`, exuluConfig, contentTypeFor(f.path));
          }
          await db("skills").insert({
            id: skillId,
            name,
            description: description || parseFrontmatter(skillMd.content).description || "",
            s3folder: `skills/${skillId}`,
            tags: JSON.stringify([]),
            usage_count: 0,
            favorite_count: 0,
            current_version: 1,
            history: JSON.stringify([{ version: 1, created_at: stamp, label: `Created in chat with ${agent.name}` }]),
            rights_mode,
            created_by: user.id,
          });
          if (decision?.rbac && rights_mode !== "private" && rights_mode !== "public") {
            await handleRBACUpdate(db, "skill", skillId, decision.rbac, []);
          }
          const paths = files.map((f) => f.path);
          return {
            type: "skill_created",
            skillId,
            name,
            version: 1,
            rights_mode,
            files: paths,
            enableOnAgent: decision?.enableOnAgent === true,
            result: `Created skill "${name}" (v1, ${rights_mode}) with ${paths.length} file(s): ${paths.join(", ")}. It is in the skill library at /skills/${skillId}. An agent loads it once it is enabled on that agent and the next conversation turn starts.`,
          };
        },
      }),
    );
  }

  if (config.update) {
    tools.push(
      new ExuluTool({
        id: "skill_update",
        name: "skill_update",
        category,
        type: "function",
        config: [],
        needsApproval: !config.skipApproval,
        needsApprovalFn: approvalFn,
        description:
          "Publish a new version of an existing skill the user may write: pass only the files to add or replace (full content each) and, optionally, paths to remove. Unchanged files carry over. " +
          "Read the skill first with skill_read. The user confirms on a card; never claim the change happened until this tool returns skill_updated.",
        inputSchema: z.object({
          skill: z.string().describe("The skill's name or id"),
          files: z.array(z.object({ path: z.string(), content: z.string() })).optional().describe("Files to add or replace, full content each"),
          deletePaths: z.array(z.string()).optional().describe("Paths to remove in the new version"),
          description: z.string().optional().describe("A new one-line description, if it changed"),
          label: z.string().optional().describe("A short label for this version, e.g. 'Added the review checklist'"),
        }),
        execute: async (params: any): Promise<SkillToolOutput> => {
          const { user, exuluConfig } = params;
          if (!user?.id) return err("Skills require a signed-in user.");
          if (!exuluConfig?.fileUploads) return err("File uploads are not configured on this instance, so skills cannot be stored.");
          const decision: UpdateDecision | undefined = params.skillDecision?.kind === "update" ? (params.skillDecision as UpdateDecision) : undefined;
          const db = await getDb();
          const skill = await resolveSkill(db, params.skill);
          if (!skill || !(await canAccessSkill(db, skill, "write", user))) {
            return { type: "skill_no_access", skill: String(params.skill), result: `No skill "${params.skill}" that you may change.` };
          }
          const parsed = normalizeFiles(params.files);
          if ("error" in parsed) return err(parsed.error);
          const changes = parsed.files;
          const removals: string[] = [];
          for (const raw of Array.isArray(params.deletePaths) ? params.deletePaths : []) {
            const p = safeSkillPath(raw);
            if (!p) return err(`"${String(raw)}" is not a valid path inside the skill.`);
            if (p === "SKILL.md") return err("SKILL.md cannot be removed; replace it instead.");
            removals.push(p);
          }
          const description = String(decision?.description ?? params.description ?? "").trim();
          if (changes.length === 0 && removals.length === 0 && !description) {
            return err("Nothing to change: pass files to add or replace, paths to remove, or a new description.");
          }
          const skillMd = changes.find((f) => f.path === "SKILL.md");
          if (skillMd) skillMd.content = ensureFrontmatter(skillMd.content, skill.name, description || skill.description || "");
          const currentVersion: number = skill.current_version ?? 1;
          const newVersion = currentVersion + 1;
          const currentPrefix = `skills/${skill.id}/v${currentVersion}/`;
          const newPrefix = `skills/${skill.id}/v${newVersion}/`;
          const gp = generalPrefix(exuluConfig);
          const existing = await io.list(currentPrefix, exuluConfig);
          const changedPaths = new Set(changes.map((f) => f.path));
          const removedSet = new Set(removals);
          for (const file of existing) {
            const rel = file.key.replace(gp + currentPrefix, "");
            if (!rel || rel.endsWith("/") || changedPaths.has(rel) || removedSet.has(rel)) continue;
            await io.copy(file.key, file.key.replace(gp + currentPrefix, gp + newPrefix), exuluConfig);
          }
          for (const f of changes) {
            await io.upload(Buffer.from(f.content, "utf8"), `${newPrefix}${f.path}`, exuluConfig, contentTypeFor(f.path));
          }
          const stamp = now().toISOString();
          const history = Array.isArray(skill.history) ? skill.history : [];
          const label = String(decision?.label ?? params.label ?? "").trim() || `Updated in chat with ${agent.name}`;
          await db("skills")
            .where({ id: skill.id })
            .update({
              current_version: newVersion,
              updatedAt: stamp,
              ...(description ? { description } : {}),
              history: JSON.stringify([...history, { version: newVersion, created_at: stamp, label }]),
            });
          const changed = changes.map((f) => f.path);
          return {
            type: "skill_updated",
            skillId: skill.id,
            name: skill.name,
            version: newVersion,
            rights_mode: skill.rights_mode ?? "private",
            changed,
            removed: removals,
            enableOnAgent: decision?.enableOnAgent === true,
            result: `Published v${newVersion} of skill "${skill.name}": ${changed.length} file(s) changed${removals.length ? `, ${removals.length} removed` : ""}. Agents pick up the new version when their next conversation turn starts.`,
          };
        },
      }),
    );
  }

  return tools;
};

/** The display-only entry for the agent editor's catalogue; the runtime expands it. */
export const createSkillAuthorPickerTool = (): ExuluTool =>
  new ExuluTool({
    id: SKILL_AUTHOR_TOOL_ID,
    name: "Skill author",
    category: "default",
    description:
      "Let this agent create skills and publish new versions of existing ones from the chat, with the user's consent on a card. " +
      "Adds a system-prompt hint to offer a skill only after complex, recurring, multi-step work — never for a single question or correction.",
    type: "function",
    inputSchema: z.object({}),
    config: [
      { name: "create", description: "The agent may propose new skills.", type: "boolean", default: true },
      { name: "update", description: "The agent may publish new versions of skills the user can write.", type: "boolean", default: true },
      { name: "skip_approval", description: "Create and update without the confirmation card (visibility then defaults to private).", type: "boolean", default: false },
    ],
    execute: async () => ({ result: "This entry is configuration-only; Exulu expands it into the skill tools at runtime." }),
  });

export const collectSkillAuthorTools = (agent: ExuluAgent | undefined, deps: SkillToolDeps = {}): ExuluTool[] => {
  if (!agent?.tools) return [];
  return createSkillAuthorTools(agent, deps);
};
