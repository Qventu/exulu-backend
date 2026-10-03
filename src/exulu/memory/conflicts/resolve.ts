import type { ExuluConfig } from "@SRC/exulu/app/index.ts";
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "@SRC/exulu/context";
import { canEditMemory } from "@SRC/exulu/memory/access";
import { creatorId } from "@SRC/exulu/memory/creator-id";
import { displayName } from "@SRC/exulu/memory/recall-collector";
import { getTableName } from "@SRC/exulu/table-names";

export type ResolveAction = "KEEP" | "MERGE" | "NOT_CONFLICT";
export type ResolveInput = {
  db: any; context: ExuluContext; config: ExuluConfig; user: User; id: string;
  action: ResolveAction; keepId?: string | null; merged?: { information: string; type?: string | null } | null;
};

const parseMembers = (raw: unknown): string[] => (Array.isArray(raw) ? raw : JSON.parse(String(raw ?? "[]"))) as string[];

async function loadGroup(db: any, context: ExuluContext, id: string) {
  const group = await db("memory_conflicts").where({ id, context: context.id }).first();
  if (!group) throw new Error(`Conflict ${id} not found`);
  if (group.status !== "open") throw new Error(`Conflict ${id} is not open`);
  return { ...group, members: parseMembers(group.members) };
}

async function assertWritable(db: any, context: ExuluContext, rows: any[], user: User) {
  for (const row of rows) {
    if (!(await canEditMemory(context, row, user, db))) throw new Error(`You can't change memory ${row.id}`);
  }
}

async function archiveMembers(context: ExuluContext, config: ExuluConfig, user: User, rows: any[], except?: string | null) {
  for (const row of rows) {
    if (row.id === except || row.archived === true) continue;
    await context.updateItem({ id: row.id, archived: true } as any, config, user.id, user.role?.id, false, false);
  }
}

async function dropJudgements(db: any, context: ExuluContext, memberIds: string[]) {
  // every judgement key containing one of the members: keys are "<ctx>:<a>,<b>"
  const likes = memberIds.map((id) => `%${id}%`);
  for (const like of likes) await db("memory_judgements").where("context", context.id).whereRaw("key LIKE ?", [like]).del();
}

export async function resolveConflict(input: ResolveInput): Promise<any> {
  const { db, context, config, user, id, action } = input;
  const group = await loadGroup(db, context, id);
  const items = getTableName(context.id);
  const rows: any[] = await db(items).whereIn("id", group.members).select("id", "information", "type", "rights_mode", "created_by", "archived");
  const now = new Date();

  if (action === "NOT_CONFLICT") {
    await db("memory_conflicts").where({ id }).update({ status: "dismissed", resolution: "not_conflict", resolved_by: user.id, resolved_at: now });
    return { ...group, status: "dismissed", resolution: "not_conflict" };
  }

  await assertWritable(db, context, rows, user);

  if (action === "KEEP") {
    if (!input.keepId || !group.members.includes(input.keepId)) throw new Error("keepId must be a member of the conflict");
    await archiveMembers(context, config, user, rows, input.keepId);
    await dropJudgements(db, context, group.members.filter((m: string) => m !== input.keepId));
    await db("memory_conflicts").where({ id }).update({ status: "resolved", resolution: "keep", resolved_by: user.id, resolved_at: now });
    return { ...group, status: "resolved", resolution: "keep" };
  }

  // MERGE
  if (group.kind !== "duplicate") throw new Error("Only duplicate groups can be merged");
  if (!input.merged?.information?.trim()) throw new Error("merged.information is required");
  const information = input.merged.information.trim();
  const types = rows.map((r) => r.type).filter((t): t is string => !!t);
  const type = input.merged.type ?? (types.length && types.every((t) => t === types[0]) ? types[0] : undefined);
  const authorIds = [...new Set(rows.map((r) => creatorId(r.created_by)).filter((x): x is number => x !== null))];
  const authors = authorIds.length ? await db("users").whereIn("id", authorIds).select("id", "firstname", "lastname", "email") : [];
  const names = authors.map((u: any) => displayName(u));
  const [me] = await db("users").whereIn("id", [user.id]).select("id", "firstname", "lastname", "email");
  const description = `Merged from ${group.members.length} memories by ${me ? displayName(me) : user.id}${names.length ? `: ${names.join(", ")}` : ""}`;

  const { item } = await context.createItem(
    { name: information.slice(0, 80), information, ...(type ? { type } : {}), description, rights_mode: "public", created_by: user.id } as any,
    config, user.id, user.role?.id, false,
  );
  const mergedId = item.id as string;

  // Persist the link before touching usage/members: if anything below fails, the
  // group stays open with merged_into set, so a retry (spec §6) finds the memory
  // already created instead of orphaning it.
  await db("memory_conflicts").where({ id }).update({ merged_into: mergedId });

  // Usage history follows the merged memory. recordMemoryUsage writes one row per
  // recalled memory per message, so near-duplicates recalled together already hold
  // (msg, a) and (msg, b); re-pointing both to mergedId would collide on
  // memory_usages_message_memory_uidx (message_id, memory_id). Drop every member row
  // that shares a message with a row already pointing at mergedId, or with another
  // member row for the same message (keeping the lowest id), before the update.
  await db("memory_usages").where("context", context.id).whereIn("memory_id", group.members)
    .whereRaw(
      `EXISTS (SELECT 1 FROM memory_usages m2
                WHERE m2.message_id = memory_usages.message_id
                  AND (m2.memory_id = ? OR (m2.memory_id = ANY(?) AND m2.id < memory_usages.id)))`,
      [mergedId, group.members],
    ).del();
  await db("memory_usages").where("context", context.id).whereIn("memory_id", group.members).update({ memory_id: mergedId });

  await archiveMembers(context, config, user, rows);
  await dropJudgements(db, context, group.members);
  await db("memory_conflicts").where({ id }).update({ status: "resolved", resolution: "merge", resolved_by: user.id, resolved_at: now, merged_into: mergedId });
  return { ...group, status: "resolved", resolution: "merge", mergedInto: mergedId };
}

export async function suggestMerge({ db, context, id, suggester }: { db: any; context: ExuluContext; id: string; suggester: (members: { information: string; type?: string | null }[]) => Promise<{ information: string; type: string | null }> }) {
  const group = await loadGroup(db, context, id);
  const rows: any[] = await db(getTableName(context.id)).whereIn("id", group.members).select("information", "type");
  return suggester(rows.map((r) => ({ information: String(r.information ?? ""), type: r.type ?? null })));
}
