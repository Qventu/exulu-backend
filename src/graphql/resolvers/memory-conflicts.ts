import type { ExuluContext } from "@SRC/exulu/context";
import { creatorId } from "@SRC/exulu/memory/creator-id";
import { displayName } from "@SRC/exulu/memory/recall-collector";
import { getTableName } from "@SRC/exulu/table-names";

export type ConflictMember = { id: string; information: string; type: string | null; author: { id: number; name: string } | null; createdAt: string; usedCount: number };
export type Conflict = { id: string; kind: string; status: string; similarity: number; reason: string | null; members: ConflictMember[]; scannedAt: string; resolvedAt: string | null; resolution: string | null; mergedInto: string | null };

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : typeof d === "string" ? new Date(d).toISOString() : null);
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const parseMembers = (raw: unknown): string[] => (Array.isArray(raw) ? raw : JSON.parse(String(raw ?? "[]"))) as string[];

async function hydrate(db: any, context: ExuluContext, rows: any[], opts: { includeArchived?: boolean } = {}): Promise<Conflict[]> {
  const ids = [...new Set(rows.flatMap((r) => parseMembers(r.members)))];
  if (ids.length === 0) return [];
  // Public rows only: a member made private after the scan must disappear from
  // its group (and from `mergedFrom`) instead of showing private wording to
  // everyone who can read the base.
  let q = db(getTableName(context.id)).whereIn("id", ids).where("rights_mode", "public").select("id", "information", "type", "created_by", "createdAt", "archived");
  if (!opts.includeArchived) q = q.whereNot("archived", true);
  const items: any[] = await q;
  const byId = new Map(items.map((i) => [i.id, i]));
  const authorIds = [...new Set(items.map((i) => creatorId(i.created_by)).filter((x): x is number => x !== null))];
  const users = new Map<number, string>();
  if (authorIds.length) for (const u of await db("users").whereIn("id", authorIds).select("id", "firstname", "lastname", "email")) users.set(Number(u.id), displayName(u));
  const usage = new Map<string, number>();
  for (const u of await db("memory_usages").where("context", context.id).whereIn("memory_id", ids).groupBy("memory_id").select("memory_id").count("id as c")) usage.set(u.memory_id, num(u.c));
  const member = (id: string): ConflictMember | null => {
    const i = byId.get(id); if (!i) return null;
    const uid = creatorId(i.created_by);
    return { id, information: String(i.information ?? ""), type: i.type ?? null, author: uid !== null && users.has(uid) ? { id: uid, name: users.get(uid)! } : null, createdAt: iso(i.createdAt) ?? "", usedCount: usage.get(id) ?? 0 };
  };
  return rows.map((r) => ({
    id: r.id, kind: r.kind, status: r.status, similarity: num(r.similarity), reason: r.reason ?? null,
    members: parseMembers(r.members).map(member).filter((m): m is ConflictMember => m !== null),
    scannedAt: iso(r.scanned_at) ?? "", resolvedAt: iso(r.resolved_at), resolution: r.resolution ?? null, mergedInto: r.merged_into ?? null,
  })).filter((g) => g.members.length >= 2 || opts.includeArchived);
}

export async function memoryConflicts({ db, context }: { db: any; context: ExuluContext }): Promise<Conflict[]> {
  if (!(await db.schema.hasTable("memory_conflicts"))) return [];
  // `merging` included: a row mid-merge or a crashed claim is still undecided and
  // must stay visible so KEEP/NOT_CONFLICT can finish it (see resolve.ts loadGroup).
  const rows: any[] = await db("memory_conflicts").where({ context: context.id }).whereIn("status", ["open", "merging"]).orderBy("scanned_at", "desc").select("*");
  return hydrate(db, context, rows);
}

export async function memoryConflictCounts({ db, context }: { db: any; context: ExuluContext }) {
  if (!(await db.schema.hasTable("memory_conflicts"))) return { open: 0, memoriesInvolved: 0, lastScanAt: null };
  const rows: any[] = await db("memory_conflicts").where({ context: context.id }).whereIn("status", ["open", "merging"]).select("members", "scanned_at");
  // The scan's own marker (memory_conflict_scans), so a scan that found nothing
  // still dates itself. Older bases scanned before that table existed fall back
  // to the newest group the scan touched.
  const scan = (await db.schema.hasTable("memory_conflict_scans"))
    ? await db("memory_conflict_scans").where("context", context.id).select("scanned_at").first()
    : null;
  const last = scan?.scanned_at ? { last: scan.scanned_at } : await db("memory_conflicts").where("context", context.id).max("scanned_at as last").first();
  const involved = new Set(rows.flatMap((r) => parseMembers(r.members)));
  const newestOpen = rows.length ? new Date(Math.max(...rows.map((r) => new Date(r.scanned_at).getTime()))) : null;
  return { open: rows.length, memoriesInvolved: involved.size, lastScanAt: iso(last?.last) ?? (newestOpen ? newestOpen.toISOString() : null) };
}

/** One group hydrated for a mutation's return value (archived members included, so a resolved group still lists them). */
export async function hydrateConflictRow(db: any, context: ExuluContext, row: any): Promise<Conflict | null> {
  const [group] = await hydrate(db, context, [row], { includeArchived: true });
  return group ?? null;
}

export async function memoryConflictsForMemory({ db, context, memoryId }: { db: any; context: ExuluContext; memoryId: string }) {
  if (!(await db.schema.hasTable("memory_conflicts"))) return { open: [], mergedFrom: [] };
  const openRows: any[] = (await db("memory_conflicts").where({ context: context.id }).whereIn("status", ["open", "merging"]).select("*")).filter((r: any) => parseMembers(r.members).includes(memoryId));
  const open = await hydrate(db, context, openRows);
  const merge = await db("memory_conflicts").where({ context: context.id, merged_into: memoryId }).first();
  const mergedFrom = merge ? (await hydrate(db, context, [{ ...merge, id: merge.id, kind: "duplicate", status: "resolved" }], { includeArchived: true }))[0]?.members ?? [] : [];
  return { open, mergedFrom };
}
