import { z } from "zod";
import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluRightsMode } from "@EXULU_TYPES/rbac-rights-modes";
import type { ExuluContext } from "@SRC/exulu/context";
import { ExuluTool } from "@SRC/exulu/tool";
import { postgresClient } from "@SRC/postgres/client";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";
import { handleRBACUpdate } from "@EE/rbac-update.ts";
import { memoryTypeValues } from "./memory-base";
import type { MemoryDecision } from "./decisions";
import { canEditMemory } from "./access";
import { displayName, loadVisibleMemoryRows, type MemoryItemRow } from "./recall-collector";

export type MemoryToolOutput =
  | { type: "memory_saved" | "memory_updated"; contextId: string; itemId: string; title: string; information: string; memoryType?: string; rights_mode: ExuluRightsMode; result: string }
  | { type: "memory_forgotten"; contextId: string; itemId: string; title: string; result: string }
  | { type: "memory_no_access"; contextId: string; itemId: string; title: string | null; createdBy: { id: number; name: string } | null; result: string }
  | { type: "memory_error"; message: string; result: string };

type ToolParams = Record<string, any> & { user?: User; exuluConfig?: any; memoryDecision?: MemoryDecision };

const err = (message: string): MemoryToolOutput => ({ type: "memory_error", message, result: `Memory operation failed: ${message}` });

/** Case-insensitive match against the context's type enum; first value when unknown. */
const resolveType = (context: ExuluContext, raw: unknown): string | undefined => {
  const values = memoryTypeValues(context);
  if (values.length === 0) return undefined;
  const wanted = String(raw ?? "").toUpperCase();
  return values.find((v) => v.toUpperCase() === wanted) ?? values[0];
};

async function creatorOf(row: MemoryItemRow, db: any): Promise<{ id: number; name: string } | null> {
  if (typeof row.created_by !== "number") return null;
  const [u] = await db("users").whereIn("id", [row.created_by]).select("id", "firstname", "lastname", "email");
  return u ? { id: u.id, name: displayName(u) } : null;
}

async function findVisible(context: ExuluContext, id: string, user: User | undefined): Promise<{ row?: MemoryItemRow; db: any }> {
  const { db } = await postgresClient();
  const [row] = await loadVisibleMemoryRows(context, [id], user, db);
  return { row, db };
}

export function createMemoryTools({ agent, context, user }: { agent: ExuluAgent; context: ExuluContext; user?: User }): ExuluTool[] {
  const types = memoryTypeValues(context);
  const typeSchema = types.length > 0 ? z.enum(types as [string, ...string[]]) : z.string();
  const category = `${agent.name}_memory`;

  const remember = new ExuluTool({
    id: "memory_remember",
    name: "Remember",
    category,
    type: "function",
    config: [],
    needsApproval: true,
    description:
      `Propose saving ONE fact, preference, decision or instruction the user shared to ${agent.name}'s long-term memory. ` +
      `The user reviews the wording and who can see it on a card before anything is saved; never ask about visibility yourself ` +
      `unless the user raised it, and never claim something was saved until this tool returns memory_saved. ` +
      `Call it once per fact, in the user's own words.`,
    inputSchema: z.object({
      title: z.string().describe("Short title, max 80 characters"),
      information: z.string().describe("The fact in one or two sentences, in the user's own words"),
      type: typeSchema.describe(`Memory type. One of: ${types.join(", ")}`),
      whySaved: z.string().describe("Why this is worth remembering: the question or topic that triggered it"),
      visibility: z.enum(["private", "public"]).optional().describe("Only when the user explicitly said who may see it"),
    }),
    execute: async (params: ToolParams): Promise<MemoryToolOutput> => {
      const { user: u, exuluConfig, memoryDecision } = params;
      if (!u?.id) return err("Memory requires a signed-in user.");
      const d = memoryDecision?.kind === "remember" ? memoryDecision : undefined;
      const information = String(d?.information ?? params.information ?? "").trim();
      const title = String(d?.title ?? params.title ?? information.slice(0, 80)).trim();
      if (!information) return err("The memory wording is empty.");
      const type = resolveType(context, d?.type ?? params.type);
      const rights_mode: ExuluRightsMode | undefined =
        d?.rights_mode ?? (params.visibility === "public" ? "public" : params.visibility === "private" ? "private" : undefined);
      try {
        const { item } = await context.createItem(
          { name: title, information, ...(type ? { type } : {}), description: String(params.whySaved ?? ""), ...(rights_mode ? { rights_mode } : {}) },
          exuluConfig, u.id, u.role?.id, false,
        );
        if (!item?.id) return err("The memory could not be created.");
        if (d?.rbac && (d.rbac.users?.length || d.rbac.roles?.length || d.rbac.teams?.length)) {
          const { db } = await postgresClient();
          await handleRBACUpdate(db, convertContextToTableDefinition(context).name.singular, item.id, d.rbac, []);
        }
        const mode = (item.rights_mode ?? rights_mode ?? "private") as ExuluRightsMode;
        return { type: "memory_saved", contextId: context.id, itemId: item.id, title, information, ...(type ? { memoryType: type } : {}), rights_mode: mode, result: `Saved memory "${title}" (${mode}).` };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  const needsWriteApproval = async (input: unknown): Promise<boolean> => {
    const id = typeof (input as any)?.memoryId === "string" ? (input as any).memoryId : "";
    if (!id || !user?.id) return false;
    const { row, db } = await findVisible(context, id, user);
    return !!row && (await canEditMemory(context, row, user, db));
  };

  const noAccess = async (id: string, row: MemoryItemRow | undefined, db: any): Promise<MemoryToolOutput> => {
    const createdBy = row ? await creatorOf(row, db) : null;
    const title = row?.name ?? null;
    const result = createdBy
      ? `This memory was saved by ${createdBy.name}; only they or an admin can change it. Suggest asking them.`
      : "No memory with that id is available to this user.";
    return { type: "memory_no_access", contextId: context.id, itemId: id, title, createdBy, result };
  };

  const update = new ExuluTool({
    id: "memory_update",
    name: "Update memory",
    category,
    type: "function",
    config: [],
    needsApproval: true,
    description:
      `Propose a correction to an existing memory of ${agent.name} (use the item_id from the memory block). ` +
      `Only the person who saved it, people with write access, or admins can change it; otherwise the result names the creator so you can suggest asking them. ` +
      `The user confirms on a card before anything changes.`,
    inputSchema: z.object({
      memoryId: z.string().describe("item_id of the memory to change"),
      information: z.string().optional().describe("New wording, if it changes"),
      title: z.string().optional(),
      type: typeSchema.optional(),
      reason: z.string().describe("What the user said that contradicts or refines the memory"),
    }),
    execute: async (params: ToolParams): Promise<MemoryToolOutput> => {
      const { user: u, exuluConfig, memoryDecision } = params;
      if (!u?.id) return err("Memory requires a signed-in user.");
      const id = String(params.memoryId ?? "");
      const { row, db } = await findVisible(context, id, u);
      if (!row || !(await canEditMemory(context, row, u, db))) return noAccess(id, row, db);
      const d = memoryDecision?.kind === "update" ? memoryDecision : undefined;
      const patch: Record<string, unknown> = { id };
      const information = d?.information ?? params.information;
      const title = d?.title ?? params.title;
      const typeRaw = d?.type ?? params.type;
      if (typeof information === "string" && information.trim()) patch.information = information.trim();
      if (typeof title === "string" && title.trim()) patch.name = title.trim();
      if (typeRaw !== undefined) { const t = resolveType(context, typeRaw); if (t) patch.type = t; }
      if (Object.keys(patch).length === 1) return err("Nothing to change.");
      try {
        await context.updateItem(patch, exuluConfig, u.id, u.role?.id);
        const finalTitle = (patch.name as string) ?? row.name ?? "";
        const finalInfo = (patch.information as string) ?? row.information ?? "";
        return { type: "memory_updated", contextId: context.id, itemId: id, title: finalTitle, information: finalInfo, ...(patch.type ? { memoryType: String(patch.type) } : {}), rights_mode: (row.rights_mode ?? "private") as ExuluRightsMode, result: `Updated memory "${finalTitle}".` };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });
  update.needsApprovalFn = needsWriteApproval;

  const forget = new ExuluTool({
    id: "memory_forget",
    name: "Forget memory",
    category,
    type: "function",
    config: [],
    needsApproval: true,
    description:
      `Propose deleting one of ${agent.name}'s memories when the user asks to forget it (use the item_id from the memory block). ` +
      `Same access rule as update_memory; the user confirms on a card before anything is deleted.`,
    inputSchema: z.object({
      memoryId: z.string().describe("item_id of the memory to delete"),
      reason: z.string().describe("What the user said"),
    }),
    execute: async (params: ToolParams): Promise<MemoryToolOutput> => {
      const { user: u } = params;
      if (!u?.id) return err("Memory requires a signed-in user.");
      const id = String(params.memoryId ?? "");
      const { row, db } = await findVisible(context, id, u);
      if (!row || !(await canEditMemory(context, row, u, db))) return noAccess(id, row, db);
      try {
        await context.deleteItem({ id }, u.id, u.role?.id);
        return { type: "memory_forgotten", contextId: context.id, itemId: id, title: row.name ?? "", result: `Forgot memory "${row.name ?? id}".` };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });
  forget.needsApprovalFn = needsWriteApproval;

  return [remember, update, forget];
}
