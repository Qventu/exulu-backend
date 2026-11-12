import type { Item } from "@EXULU_TYPES/models/item";
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "@SRC/exulu/context";
import { getTableName } from "@SRC/exulu/table-names";
import { ExuluTool } from "@SRC/exulu/tool";
import { UnknownFilterPathError } from "@SRC/graphql/utilities/convert-graphql-filter-operator-to-pg-query";
import { postgresClient } from "@SRC/postgres/client";
import { checkRecordAccess } from "@SRC/utils/check-record-access";
import { sanitizeName } from "@SRC/utils/sanitize-name";
import { z, type ZodSchema } from "zod";
import { contextToolSegment, isHiddenField, itemNotFoundMessage } from "./context-write-tools";

/**
 * Generated per-context READ tools: `get_<ctx>_item` and `find_<ctx>_items`,
 * siblings of `create_<ctx>_item` / `update_<ctx>_item` in
 * context-write-tools.ts (segment rule, hidden-field rule and the not-found
 * message are imported from there, never copied).
 *
 * Why they exist: an agent that may write a knowledge base could only read an
 * item back by calling `update_<ctx>_item` with a no-op patch — which asks the
 * user for approval for a write that changes nothing, and returns the item as
 * a side effect (M&V, 2026-11-12). Reads are now first-class, approval-free
 * and access-controlled.
 *
 * Two invariants carry the security of this module:
 *  - A field marked `hidden` is a write-only secret: it is in no output, no
 *    `fields` list and no filter. The question is asked of the CONTEXT's field
 *    definitions (isHiddenField), because convertContextToTableDefinition
 *    drops the flag.
 *  - "Not there" and "not yours" are the same sentence (itemNotFoundMessage),
 *    so neither tool can be used to probe for rows the caller cannot see.
 */

/** `find`'s page size when the caller names none. */
export const FIND_DEFAULT_LIMIT = 20;
/** `find`'s hard ceiling. A larger request is clamped, never refused. */
export const FIND_MAX_LIMIT = 50;

/**
 * The filter operators `applyFilters` actually compiles into SQL
 * (convert-graphql-filter-operator-to-pg-query.ts). `gt` and `lt` are NOT in
 * it — the platform grammar has never implemented them — so they must not be
 * offered: an operator nothing compiles would silently drop the whole
 * condition and return rows the model believes were filtered.
 */
const SUPPORTED_OPERATORS = ["eq", "ne", "in", "contains", "gte", "lte"] as const;

/**
 * `contains` compiles to ILIKE on a non-json column — which Postgres refuses
 * outright on a numeric, boolean or timestamp column (42883). Offering it
 * there would trade a usable filter for a SQL error the model cannot read, so
 * those types get the other five operators and `contains` is refused by name
 * (fix round 1, F4).
 */
const CONTAINS_UNSUPPORTED_TYPES = new Set(["number", "boolean", "date"]);

const operatorsForField = (field: ReadableField): string[] =>
  CONTAINS_UNSUPPORTED_TYPES.has(field.type)
    ? SUPPORTED_OPERATORS.filter((operator) => operator !== "contains")
    : [...SUPPORTED_OPERATORS];

/**
 * A column a read tool may expose, with the name the model uses for it.
 * `name` and `column` differ for a `file` field (stored in `<name>_s3key`,
 * exposed under the logical name the write tools use) and for any field whose
 * name `sanitizeName` rewrites — `Kunden Name` lives in `kunden_name`. The
 * rule: `column` is the only thing that may reach SQL, `name` the only thing
 * the model ever sees.
 */
type ReadableField = {
  name: string;
  column: string;
  type: string;
  isFile: boolean;
  /** Part of `find`'s default selection (spec: everything but file fields). */
  findDefault: boolean;
};

// Columns every context items table carries (ExuluContext.createItemsTable).
// NOTE the timestamps are camelCase in the items tables — `created_at` /
// `updated_at` do not exist there.
const SYSTEM_FIELDS: { name: string; type: string; findDefault: boolean }[] = [
  { name: "id", type: "text", findDefault: true },
  { name: "createdAt", type: "date", findDefault: false },
  { name: "updatedAt", type: "date", findDefault: true },
  { name: "rights_mode", type: "text", findDefault: false },
  { name: "archived", type: "boolean", findDefault: false },
];

// The core content columns the write tools also expose under these names.
const CORE_CONTENT_FIELDS: { name: string; type: string }[] = [
  { name: "name", type: "text" },
  { name: "description", type: "text" },
  { name: "tags", type: "text" },
  { name: "external_id", type: "text" },
];

export type ReadToolDeps = {
  /**
   * Row-level read gate. Injectable for tests; defaults to
   * checkItemReadAccess.
   */
  checkAccess?: (context: ExuluContext, record: Item, user?: User) => Promise<boolean>;
};

/**
 * Every field a read tool may expose for this context, in output order.
 * Unlike the write schema this keeps calculated, non-editable and uuid fields
 * — they are readable data, they are just not writable. Only `hidden` is
 * excluded, and `file` fields are mapped onto their physical column.
 */
export const readableContextFields = (context: ExuluContext): ReadableField[] => {
  const fields: ReadableField[] = [];
  const seen = new Set<string>();
  const add = (field: ReadableField) => {
    if (seen.has(field.name)) return;
    seen.add(field.name);
    fields.push(field);
  };

  for (const system of SYSTEM_FIELDS) {
    add({ ...system, column: system.name, isFile: false });
  }
  for (const core of CORE_CONTENT_FIELDS) {
    add({ ...core, column: core.name, isFile: false, findDefault: true });
  }
  for (const field of context.fields ?? []) {
    if (!field?.name || !field.type) continue;
    if (isHiddenField(field)) continue;
    const isFile = field.type === "file";
    add({
      name: field.name,
      column: sanitizeName(isFile ? `${field.name}_s3key` : field.name),
      type: field.type,
      isFile,
      // A file column holds an opaque storage key, which is noise in a list —
      // asked for by name it is still returned.
      findDefault: !isFile,
    });
  }
  return fields;
};

const nameList = (fields: ReadableField[]): string => fields.map((f) => f.name).join(", ");

/**
 * Resolves the caller's `fields` against the readable set. An unknown name —
 * including a hidden field's name, which is simply not in the set — comes back
 * as a message naming what IS valid, never as a partial selection: silently
 * dropping a requested field would have the model read an absent key as an
 * empty value.
 */
const resolveFields = (
  readable: ReadableField[],
  requested: unknown,
  contextName: string,
): { fields: ReadableField[] } | { error: string } => {
  if (!Array.isArray(requested) || requested.length === 0) {
    return { fields: readable };
  }
  const byName = new Map(readable.map((f) => [f.name, f]));
  const picked: ReadableField[] = [];
  const unknown: string[] = [];
  for (const raw of requested) {
    const name = String(raw);
    const field = byName.get(name);
    if (!field) {
      unknown.push(name);
      continue;
    }
    if (!picked.includes(field)) picked.push(field);
  }
  if (unknown.length > 0) {
    return {
      error:
        `Unknown field name${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")} ` +
        `for "${contextName}". Valid field names: ${nameList(readable)}.`,
    };
  }
  // `id` is always returned so the model can act on what it found.
  const id = readable.find((f) => f.name === "id");
  if (id && !picked.includes(id)) picked.unshift(id);
  return { fields: picked };
};

/**
 * The `select` list for getItems. Aliased whenever the physical column differs
 * from the model-facing name — a `file` field (`manual` → `manual_s3key`) AND
 * any field whose name sanitizeName() rewrites (`Kunden Name` →
 * `kunden_name`). Without the alias, `find` would hand back rows keyed by
 * column while `get` keys them by name (fix round 1, F2).
 */
const selectList = (fields: ReadableField[]): string[] =>
  fields.map((field) => (field.column === field.name ? field.column : `${field.column} as ${field.name}`));

/**
 * Maps a validated `where` onto the physical columns applyFilters compiles
 * against. The table definition names every field `sanitizeName(field.name)`,
 * so a model-facing name reaching SQL unmapped is either a Postgres 42703 or
 * — for a json field — a missed `isJsonField`, which turns `@>` into an ILIKE
 * on jsonb (fix round 1, F2).
 */
const whereByColumn = (
  filterable: ReadableField[],
  where: Record<string, any>,
): Record<string, any> => {
  const byName = new Map(filterable.map((f) => [f.name, f]));
  const mapped: Record<string, any> = {};
  for (const [name, operators] of Object.entries(where)) {
    mapped[byName.get(name)?.column ?? name] = operators;
  }
  return mapped;
};

/**
 * Projects a fetched row onto the fields the caller may see.
 *
 * `explicit` = the caller named the fields. Then an empty value is ANSWERED as
 * `null` rather than omitted: an absent key reads to a model as "I don't know"
 * and invites a second call, while the row genuinely says "nothing stored"
 * (fix round 1, F6). The default selection stays compact.
 */
const projectRow = (
  record: Item,
  fields: ReadableField[],
  explicit: boolean,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = record[field.column];
    if (value === undefined || value === null) {
      if (explicit) out[field.name] = null;
      continue;
    }
    out[field.name] = value;
  }
  return out;
};

const clampLimit = (raw: unknown): number => {
  const asNumber = typeof raw === "number" ? Math.floor(raw) : Number.NaN;
  if (!Number.isFinite(asNumber) || asNumber <= 0) return FIND_DEFAULT_LIMIT;
  return Math.min(asNumber, FIND_MAX_LIMIT);
};

/**
 * A `where` the tool is willing to execute: every key a filterable field,
 * every value at least one supported operator. Both halves are refused with a
 * message rather than ignored, because both failure modes are silent
 * otherwise — an unknown column reaches knex as a SQL error, and an unknown
 * operator (`gt`, `and`, a typo) compiles to no condition at all and returns
 * the whole table as if it had been filtered.
 */
const validateWhere = (
  filterable: ReadableField[],
  where: Record<string, any>,
  contextName: string,
): string | undefined => {
  const names = new Set(filterable.map((f) => f.name));
  const unknown = Object.keys(where).filter((key) => !names.has(key));
  if (unknown.length > 0) {
    return (
      `Unknown filter field${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")} ` +
      `for "${contextName}". Valid filter fields: ${nameList(filterable)}.`
    );
  }
  const byName = new Map(filterable.map((f) => [f.name, f]));
  for (const [name, operators] of Object.entries(where)) {
    if (!operators || typeof operators !== "object" || Array.isArray(operators)) {
      return `The filter on "${name}" must be an object of operators, e.g. { "${name}": { "eq": … } }.`;
    }
    const allowed = operatorsForField(byName.get(name)!);
    const keys = Object.keys(operators as Record<string, unknown>);
    const badOperators = keys.filter((key) => !allowed.includes(key));
    if (keys.length === 0 || badOperators.length > 0) {
      return (
        `The filter on "${name}" uses ${
          keys.length === 0 ? "no operator" : `unsupported operator(s) ${badOperators.map((k) => `"${k}"`).join(", ")}`
        }. Supported operators for "${name}": ${allowed.join(", ")}.`
      );
    }
  }
  return undefined;
};

// A json filter value is matched with Postgres' containment operator, so it is
// an object or an array as often as a scalar (a json column legally holds any
// of them, and `@>` on an array element is a normal filter). Record/array
// typed on purpose: a declared json schema's own shape is NOT used here (a
// `contains` filter is a fragment, not a whole value), and neither a record
// nor an array strips the key the path check downstream is there to judge.
const JSON_FILTER_VALUE = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.record(z.string(), z.any()),
  z.array(z.any()),
]);

const filterValueSchema = (type: string): ZodSchema => {
  switch (type) {
    case "json":
      return JSON_FILTER_VALUE;
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    default:
      // text | longText | markdown | enum | date | uuid — dates and uuids
      // travel as strings.
      return z.string();
  }
};

const operatorsSchema = (field: ReadableField): ZodSchema => {
  const value = filterValueSchema(field.type);
  const allowed = operatorsForField(field);
  const shape: Record<string, ZodSchema> = {
    eq: value.optional(),
    ne: value.optional(),
    in: z.array(value).optional(),
    gte: value.optional(),
    lte: value.optional(),
  };
  if (allowed.includes("contains")) {
    shape["contains"] = value.optional();
  }
  // Loose on purpose: a strict object would STRIP an operator the model
  // invented (`gt`) before validateWhere could name it, turning the typo into
  // an unfiltered query.
  return z
    .looseObject(shape)
    .optional()
    .describe(
      `Filter on ${field.name} (${allowed.join(", ")})` +
        (field.type === "json"
          ? ": eq/ne/in match the whole stored value, contains does json containment."
          : "."),
    );
};

const whereSchema = (filterable: ReadableField[]): ZodSchema => {
  const shape: Record<string, ZodSchema> = {};
  for (const field of filterable) {
    shape[field.name] = operatorsSchema(field);
  }
  // Loose for the same reason as the operators object: an unknown field name
  // must reach validateWhere, not vanish.
  return z
    .looseObject(shape)
    .optional()
    .describe(
      `Filter: an object of field name to operators, e.g. { "name": { "contains": "widget" } }. ` +
        `Several fields are combined with AND. Operators: ${SUPPORTED_OPERATORS.join(", ")} — ` +
        `"contains" only on text, enum and json fields (each field's own list is on its filter).`,
    );
};

/**
 * Row-level READ gate for context items.
 *
 * checkRecordAccess is the decision function (Global Constraints) and answers
 * everything that can be answered from the row alone: public, the creator,
 * super admins, admin-mode API keys. It cannot answer the shared modes —
 * item rows carry no in-memory `record.RBAC`, the grants live in the `rbac`
 * table (the same reason check-item-write-access.ts exists) — so a
 * users/roles/teams item falls through to that table here. Any grant counts
 * as read, which is exactly what applyAccessControl does for the `find` path:
 * without this, `find` would list an item that `get` then reports as missing.
 */
export const checkItemReadAccess = async (
  context: { id: string },
  record: Item,
  user?: User,
): Promise<boolean> => {
  if (!user) return false;
  if (await checkRecordAccess(record, "read", user)) return true;

  const mode = record?.rights_mode;
  if (mode !== "users" && mode !== "roles" && mode !== "teams") return false;

  const entity = getTableName(context.id);
  const { db } = await postgresClient();

  if (mode === "users") {
    const grant = await db
      .from("rbac")
      .where({ entity, target_resource_id: record.id, access_type: "User", user_id: user.id })
      .first();
    return !!grant;
  }
  if (mode === "roles") {
    const roleId = typeof user.role === "string" ? user.role : user.role?.id;
    if (!roleId) return false;
    const grant = await db
      .from("rbac")
      .where({ entity, target_resource_id: record.id, access_type: "Role", role_id: roleId })
      .first();
    return !!grant;
  }
  const teamId = typeof user.team === "string" ? user.team : user.team?.id;
  if (!teamId) return false;
  const grant = await db
    .from("rbac")
    .where({ entity, target_resource_id: record.id, access_type: "Team", team_id: teamId })
    .first();
  return !!grant;
};

export const createContextReadTools = (
  context: ExuluContext,
  deps: ReadToolDeps = {},
): ExuluTool[] => {
  const segment = contextToolSegment(context);
  const contextLabel = context.description ? ` ${context.description}` : "";
  const readable = readableContextFields(context);
  // A file column holds a storage key; filtering on it is meaningless, and it
  // is not a column the table definition even knows under this name.
  const filterable = readable.filter((field) => !field.isFile);
  const findDefaults = readable.filter((field) => field.findDefault);
  const NOT_FOUND = itemNotFoundMessage(context, "read");
  const checkAccess = deps.checkAccess ?? checkItemReadAccess;

  const fieldsInput = z
    .array(z.string())
    .optional()
    .describe(
      `Which fields to return. Omit for the defaults. Available: ${nameList(readable)}.`,
    );

  const getTool = new ExuluTool({
    id: `get_${segment}_item`,
    name: `Get ${context.name} item`,
    category: "knowledge_base_reading",
    description:
      `Read one item from the "${context.name}" knowledge base by id or external_id.${contextLabel} ` +
      `Returns the item's fields as JSON. Reading changes nothing and needs no approval.`,
    type: "function",
    inputSchema: z.object({
      id: z.string().optional().describe("The id of the item to read."),
      external_id: z
        .string()
        .optional()
        .describe("The external_id of the item to read, if the id is unknown."),
      fields: fieldsInput,
    }),
    config: [],
    needsApproval: false,
    execute: async (params: any) => {
      const { user } = params;
      // No user: the same sentence as a missing row. A guest learns nothing
      // about what exists.
      if (!user?.id) {
        return { result: NOT_FOUND };
      }
      if (!params.id && !params.external_id) {
        return { result: "Provide the id or external_id of the item to read." };
      }
      const selection = resolveFields(readable, params.fields, context.name);
      if ("error" in selection) {
        return { result: selection.error };
      }
      try {
        const record = await context.getItem({
          item: { id: params.id, external_id: params.external_id },
        });
        if (!record?.id) {
          return { result: NOT_FOUND };
        }
        if (!(await checkAccess(context, record, user))) {
          return { result: NOT_FOUND };
        }
        const explicit = Array.isArray(params.fields) && params.fields.length > 0;
        return {
          result: `Item: ${JSON.stringify(projectRow(record, selection.fields, explicit))}`,
        };
      } catch (error) {
        console.error(`[EXULU] Error reading item in context ${context.id}`, error);
        return {
          result: `Failed to read the item in "${context.name}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  });

  const findTool = new ExuluTool({
    id: `find_${segment}_items`,
    name: `Find ${context.name} items`,
    category: "knowledge_base_reading",
    description:
      `Find items in the "${context.name}" knowledge base with a structured filter over their fields.${contextLabel} ` +
      `Exact, field-by-field lookup — for a meaning-based search use the knowledge base search tool instead. ` +
      `Returns up to ${FIND_MAX_LIMIT} items (${FIND_DEFAULT_LIMIT} by default). Archived items are included ` +
      `unless you filter them out with { "archived": { "eq": false } }. Reading changes nothing and needs no approval.`,
    type: "function",
    inputSchema: z.object({
      where: whereSchema(filterable),
      limit: z
        .number()
        .optional()
        .describe(
          `How many items to return at most. Default ${FIND_DEFAULT_LIMIT}, maximum ${FIND_MAX_LIMIT} (a larger number is clamped).`,
        ),
      fields: fieldsInput,
    }),
    config: [],
    needsApproval: false,
    execute: async (params: any) => {
      const { user } = params;
      const limit = clampLimit(params.limit);
      // No user: nothing is readable, and saying so as an empty result keeps
      // the tool from reporting on what exists.
      if (!user?.id) {
        return { result: "Found 0 item(s): []" };
      }
      const requested = Array.isArray(params.fields) && params.fields.length > 0 ? params.fields : undefined;
      const selection = resolveFields(requested ? readable : findDefaults, requested, context.name);
      if ("error" in selection) {
        return { result: selection.error };
      }
      const where =
        params.where && typeof params.where === "object" && !Array.isArray(params.where)
          ? (params.where as Record<string, any>)
          : undefined;
      if (where && Object.keys(where).length > 0) {
        const whereError = validateWhere(filterable, where, context.name);
        if (whereError) {
          return { result: whereError };
        }
      }
      try {
        // One filter chokepoint: the `where` goes into getItems as a single
        // filter object and applyFilters compiles it. This tool never builds
        // SQL of its own — it only translates the model-facing field names
        // into the columns applyFilters expects.
        const items = await context.getItems({
          filters:
            where && Object.keys(where).length > 0 ? [whereByColumn(filterable, where)] : [],
          fields: selectList(selection.fields),
          user,
          // A user's role can be the bare id string as well as an object;
          // `user.role?.id` on a string silently yields undefined, which knex
          // then refuses as an undefined binding (fix round 1, F3).
          role: typeof user.role === "string" ? user.role : user.role?.id,
          limit,
        });
        return { result: `Found ${items.length} item(s): ${JSON.stringify(items)}` };
      } catch (error) {
        // A refused json filter path is the CALLER's to fix: it comes back as
        // a normal result carrying the full four-part message (which names
        // the paths the schema does define), not as a thrown error that ends
        // the turn.
        if (error instanceof UnknownFilterPathError) {
          console.warn(`[EXULU] ${findTool.id} refused an unknown json filter path:`, error.message);
          return { result: error.message };
        }
        console.error(`[EXULU] Error finding items in context ${context.id}`, error);
        return {
          result: `Failed to find items in "${context.name}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  });

  return [getTool, findTool];
};
