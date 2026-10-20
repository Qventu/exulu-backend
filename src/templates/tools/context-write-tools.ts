import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import type { Item } from "@EXULU_TYPES/models/item";
import type { ExuluContext } from "@SRC/exulu/context";
import { ExuluTool } from "@SRC/exulu/tool";
import { z, type ZodSchema } from "zod";
import { randomUUID } from "node:crypto";
import type { ExuluConfig } from "@SRC/exulu/app/index.ts";
import { sessionFilePrefix } from "@SRC/exulu/session-files";
import { copyS3Object } from "@SRC/uppy/index";
import { sanitizeName } from "@SRC/utils/sanitize-name";
import { checkItemWriteAccess } from "@SRC/utils/check-item-write-access";
import { KB_EDITOR_TOOL_ID, parseKbEditorConfig, type KbWritePermissions } from "./kb-editor-config";

// Tool ids must match ^[a-z_][a-z0-9_]{4,79}: "create_" (7) + segment + "_item" (5)
// caps the sanitized context-id segment at 68 chars.
const MAX_CONTEXT_SEGMENT = 68;

type WriteMode = "create" | "update";

/**
 * A `file` field as the tool exposes it: the model passes the bare name of a
 * session file under the field's own name; the write stores the copied
 * object's key in the `<name>_s3key` column, exactly as the UI's uploader does.
 */
type FileField = { input: string; column: string; allowed: string[] };

export type WriteToolDeps = {
  /** The session's owner when the session is shared — session files live under the owner's prefix. */
  sessionOwnerId?: number | string;
  /** Injectable for tests; defaults to the S3 copy. */
  copyObject?: (sourceKey: string, destKey: string, config: ExuluConfig) => Promise<void>;
};

// Keys the AI-SDK execute wrapper injects into tool inputs at runtime
// (convert-exulu-tools-to-ai-sdk-tools.ts). A context field with one of
// these names would be silently overwritten by the injected value, so it
// cannot be exposed as a tool input.
const RESERVED_INPUT_KEYS = new Set([
  "model", "user", "contexts", "memory", "req", "upload", "sessionID",
  "sessionItems", "providerapikey", "allExuluTools", "currentTools",
  "exuluConfig", "toolVariablesConfig", "oauth",
]);

// Builds the zod shape for one context + mode and the list of input keys that
// map onto item columns. Update's id/external_id are lookup keys, NOT content:
// external_id must never be written back on update.
const buildWriteSchema = (
  context: ExuluContext,
  mode: WriteMode,
): { shape: Record<string, ZodSchema>; contentKeys: string[]; fileFields: FileField[] } => {
  const shape: Record<string, ZodSchema> = {};
  const contentKeys: string[] = [];
  const fileFields: FileField[] = [];

  const addContent = (key: string, schema: ZodSchema, required: boolean) => {
    shape[key] = required && mode === "create" ? schema : schema.optional();
    contentKeys.push(key);
  };

  if (mode === "update") {
    shape["id"] = z.string().optional().describe("The id of the item to update.");
    shape["external_id"] = z
      .string()
      .optional()
      .describe("The external_id of the item to update, if the id is unknown. Lookup only — it is never changed.");
  }

  addContent("name", z.string().describe("The name of the item."), true);
  addContent("description", z.string().describe("A description of the item."), false);
  addContent("tags", z.array(z.string()).describe("Tags for the item."), false);
  if (mode === "create") {
    addContent(
      "external_id",
      z.string().describe("An optional external identifier for the item, e.g. an id from a source system."),
      false,
    );
  }

  for (const field of context.fields ?? []) {
    if (field.type === "uuid") continue;
    if (field.calculated === true || field.editable === false) continue;
    if (field.hidden === true) continue;
    if (RESERVED_INPUT_KEYS.has(field.name)) continue;

    if (field.type === "file") {
      // Exposed under the logical name; stored under the `_s3key` column.
      const allowed = (field.allowedFileTypes ?? []).map((ext: string) => ext.toLowerCase());
      const column = `${field.name}_s3key`;
      const allowedNote = allowed.length ? ` Allowed types: ${allowed.join(", ")}.` : "";
      shape[field.name] = (field.required === true && mode === "create"
        ? z.string()
        : z.string().optional()
      ).describe(
        `The ${field.name} file: the bare name of a file from this session's files (as listed there, no path).${allowedNote}` +
          (mode === "update" ? " Omit to keep the current file." : ""),
      );
      contentKeys.push(column);
      fileFields.push({ input: field.name, column, allowed });
      continue;
    }

    let schema: ZodSchema;
    switch (field.type) {
      case "enum":
        schema = z
          .string()
          .describe(
            `The ${field.name} of the item. Must be one of: ${(field.enumValues ?? []).join(", ")}`,
          );
        break;
      case "json":
        schema = z.string().describe(`The ${field.name} of the item, as a valid JSON string.`);
        break;
      case "markdown":
        schema = z.string().describe(`The ${field.name} of the item, as a valid Markdown string.`);
        break;
      case "date":
        schema = z.string().describe(`The ${field.name} of the item, as an ISO-8601 date string.`);
        break;
      case "number":
        schema = z.number().describe(`The ${field.name} of the item.`);
        break;
      case "boolean":
        schema = z.boolean().describe(`The ${field.name} of the item.`);
        break;
      default:
        // text | longText | shortText | code and any future string-ish type.
        schema = z.string().describe(`The ${field.name} of the item.`);
        break;
    }
    addContent(field.name, schema, field.required === true);
  }

  return { shape, contentKeys, fileFields };
};

const BARE_FILENAME = /^[^/\\]+$/;

/**
 * Turns every file-field input into a stored object key: validates the name
 * and the type, copies the session file to the user's upload prefix under the
 * `<uuid>-_EXULU_<name>` shape the UI's uploader produces, and sets the
 * `_s3key` column. The copy is what makes the knowledge-base object outlive
 * the session. Returns an error message for the model, or undefined.
 */
export const attachSessionFiles = async (
  params: Record<string, any>,
  fileFields: FileField[],
  deps: WriteToolDeps,
): Promise<string | undefined> => {
  const wanted = fileFields.filter((f) => typeof params[f.input] === "string" && params[f.input].trim() !== "");
  if (wanted.length === 0) return undefined;
  const { user, sessionID, exuluConfig } = params as {
    user?: { id: number; type?: string };
    sessionID?: string;
    exuluConfig?: ExuluConfig;
  };
  const uploads = exuluConfig?.fileUploads;
  if (!uploads?.s3Bucket) {
    return "File uploads are not configured on this instance, so files cannot be attached to items.";
  }
  if (!sessionID) {
    return "Files can only be attached from a chat session's files.";
  }
  const copy = deps.copyObject ?? copyS3Object;
  const general = uploads.s3prefix ? `${uploads.s3prefix.replace(/\/+$/, "")}/` : "";
  const owner = user?.type === "api" ? "api" : user?.id;
  for (const field of wanted) {
    const name = String(params[field.input]).trim();
    if (!BARE_FILENAME.test(name) || name === "." || name === "..") {
      return `"${name}" is not a session file name. Pass the bare file name exactly as listed in the session files, without a path.`;
    }
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
    if (field.allowed.length && !field.allowed.includes(ext)) {
      return `"${name}" has type "${ext || "none"}", but the ${field.input} field only accepts ${field.allowed.join(", ")}.`;
    }
    const sourceKey = `${sessionFilePrefix(deps.sessionOwnerId ?? owner ?? "api", sessionID, uploads.s3prefix)}${name}`;
    const destKey = `${general}user_${owner}/${randomUUID()}-_EXULU_${name}`;
    try {
      await copy(sourceKey, destKey, exuluConfig!);
    } catch (error) {
      console.error(`[EXULU] KB editor: copying session file "${name}" failed`, error);
      return `"${name}" is not among this session's files. Upload it to the session (or ask the user to attach it) and try again.`;
    }
    params[field.column] = destKey;
    delete params[field.input];
  }
  return undefined;
};

// Case-insensitive canonicalization against enumValues. Returns an error
// message (for the model to self-correct) instead of silently dropping the
// value — a dropped required enum would otherwise vanish from the write.
export const canonicalizeEnumFields = (
  context: ExuluContext,
  params: Record<string, unknown>,
): string | undefined => {
  for (const field of context.fields ?? []) {
    if (field.type !== "enum" || !field.enumValues?.length) continue;
    const raw = params[field.name];
    if (raw === undefined || raw === null || raw === "") continue;
    // raw is unknown (params is Record<string, unknown>); String() is a safe
    // best-effort stringification for the error message / comparison below.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const rawStr = String(raw);
    const canonical = field.enumValues.find((v: string) => v.toUpperCase() === rawStr.toUpperCase());
    if (canonical === undefined) {
      return `Invalid value "${rawStr}" for field "${field.name}". Allowed values: ${field.enumValues.join(", ")}.`;
    }
    params[field.name] = canonical;
  }
  return undefined;
};

const pickContent = (params: Record<string, unknown>, contentKeys: string[]): Item => {
  const item: Item = {};
  for (const key of contentKeys) {
    if (params[key] !== undefined) {
      item[key] = params[key];
    }
  }
  return item;
};

const jobNote = (job: string | undefined): string =>
  job ? ` Processing/embeddings queued (job: ${job}); changes become searchable when the job completes.` : "";

export const createContextWriteTools = (
  context: ExuluContext,
  perms: KbWritePermissions,
  skipApproval: boolean,
  deps: WriteToolDeps = {},
): ExuluTool[] => {
  const tools: ExuluTool[] = [];
  const segment = sanitizeName(context.id).slice(0, MAX_CONTEXT_SEGMENT);
  const contextLabel = context.description ? ` ${context.description}` : "";

  if (perms.create) {
    const { shape, contentKeys, fileFields } = buildWriteSchema(context, "create");
    const fileNote = fileFields.length ? " File fields take the name of a file from this session's files." : "";
    tools.push(
      new ExuluTool({
        id: `create_${segment}_item`,
        name: `Create ${context.name} item`,
        category: "knowledge_base_editing",
        description: `Create a new item in the "${context.name}" knowledge base.${contextLabel}${fileNote}`,
        type: "function",
        inputSchema: z.object(shape),
        config: [],
        needsApproval: !skipApproval,
        execute: async (params: any) => {
          const { user, exuluConfig } = params;
          if (!user?.id) {
            return { result: "Knowledge base writes require an authenticated user." };
          }
          try {
            const enumError = canonicalizeEnumFields(context, params);
            if (enumError) {
              return { result: enumError };
            }
            const fileError = await attachSessionFiles(params, fileFields, deps);
            if (fileError) {
              return { result: fileError };
            }
            const item = pickContent(params, contentKeys);
            // createItem does not stamp the creator itself; created_by is a
            // text column. rights_mode is left unset so the context's
            // defaultRightsMode column default applies.
            item.created_by = String(user.id);
            const { item: created, job } = await context.createItem(
              item,
              exuluConfig,
              user?.id,
              user?.role?.id,
              false,
            );
            if (!created?.id) {
              return { result: `Failed to create item in "${context.name}".` };
            }
            return {
              result: `Created item ${created.id} in knowledge base "${context.name}".${jobNote(job)}`,
            };
          } catch (error) {
            console.error(`[EXULU] Error creating item in context ${context.id}`, error);
            return {
              result: `Failed to create item in "${context.name}": ${
                error instanceof Error ? error.message : String(error)
              }`,
            };
          }
        },
      }),
    );
  }

  if (perms.update) {
    const { shape, contentKeys, fileFields } = buildWriteSchema(context, "update");
    const fileNote = fileFields.length ? " File fields take the name of a file from this session's files; omit them to keep the current file." : "";
    // Same message for "row missing" and "no write access" so the tool can't
    // be used to probe for rows the user can't see.
    const NOT_FOUND = `Item not found in "${context.name}" or you don't have write access to it.`;
    tools.push(
      new ExuluTool({
        id: `update_${segment}_item`,
        name: `Update ${context.name} item`,
        category: "knowledge_base_editing",
        description:
          `Update an existing item in the "${context.name}" knowledge base. ` +
          `Provide the item's id (or external_id) plus only the fields to change; omitted fields keep their values.${fileNote}`,
        type: "function",
        inputSchema: z.object(shape),
        config: [],
        needsApproval: !skipApproval,
        execute: async (params: any) => {
          const { user, exuluConfig } = params;
          if (!user?.id) {
            return { result: "Knowledge base writes require an authenticated user." };
          }
          try {
            if (!params.id && !params.external_id) {
              return { result: "Provide the id or external_id of the item to update." };
            }
            const existing = await context.getItem({
              item: { id: params.id, external_id: params.external_id },
            });
            if (!existing?.id) {
              return { result: NOT_FOUND };
            }
            const allowed = await checkItemWriteAccess(context, existing, user);
            if (!allowed) {
              return { result: NOT_FOUND };
            }
            const enumError = canonicalizeEnumFields(context, params);
            if (enumError) {
              return { result: enumError };
            }
            const fileError = await attachSessionFiles(params, fileFields, deps);
            if (fileError) {
              return { result: fileError };
            }
            const patch = pickContent(params, contentKeys);
            if (Object.keys(patch).length === 0) {
              return { result: "No fields to update were provided." };
            }
            patch.id = existing.id;
            const { job } = await context.updateItem(patch, exuluConfig, user?.id, user?.role?.id);
            // updateItem returns the PRE-update record — re-fetch for a fresh view.
            const fresh = await context.getItem({ item: { id: existing.id } });
            const summary: Record<string, unknown> = { id: existing.id };
            for (const key of contentKeys) {
              if (fresh?.[key] !== undefined && fresh?.[key] !== null) {
                summary[key] = fresh[key];
              }
            }
            return {
              result:
                `Updated item ${existing.id} in knowledge base "${context.name}".${jobNote(job)}` +
                `\nCurrent item: ${JSON.stringify(summary)}`,
            };
          } catch (error) {
            console.error(`[EXULU] Error updating item in context ${context.id}`, error);
            return {
              result: `Failed to update item in "${context.name}": ${
                error instanceof Error ? error.message : String(error)
              }`,
            };
          }
        },
      }),
    );
  }

  return tools;
};

// Expands an agent's knowledge_base_editor entry into concrete per-context
// write tools. Contexts that no longer exist in code are skipped silently —
// they can disappear between deploys.
// Display-only entry for the agent editor's tool picker (Query.tools). Never
// executable in a chat: getEnabledTools skips this id, and the runtime expands
// the stored entry into per-context write tools instead.
export const createKbEditorPickerTool = (): ExuluTool =>
  new ExuluTool({
    id: KB_EDITOR_TOOL_ID,
    name: "Knowledge base editor",
    category: "default",
    description:
      "Let this agent create or update items in selected knowledge bases during chat, including attaching " +
      "files from the session's files to file fields. Configure per knowledge base whether the agent may create and/or update items.",
    type: "function",
    inputSchema: z.object({}),
    config: [
      {
        name: "knowledge_bases",
        description:
          "JSON record of context id to { create: boolean, update: boolean }. Contexts absent here get no write access.",
        type: "json",
      },
      {
        name: "skip_approval",
        description: "Run knowledge base writes without asking for approval in the chat.",
        type: "boolean",
        default: false,
      },
    ],
    execute: async () => ({
      result:
        "This entry is configuration-only; Exulu expands it into per-context create/update tools at runtime.",
    }),
  });

export const collectKbWriteTools = (
  agent: ExuluAgent | undefined,
  contexts: ExuluContext[] | undefined,
  deps: WriteToolDeps = {},
): ExuluTool[] => {
  if (!agent?.tools || !contexts?.length) {
    return [];
  }
  const config = parseKbEditorConfig(agent.tools as any);
  if (!config.enabled) {
    return [];
  }
  const tools: ExuluTool[] = [];
  for (const [contextId, perms] of Object.entries(config.knowledgeBases)) {
    const context = contexts.find((c) => c.id === contextId);
    if (!context) {
      continue;
    }
    tools.push(...createContextWriteTools(context, perms, config.skipApproval, deps));
  }
  return tools;
};
