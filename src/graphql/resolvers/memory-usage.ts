import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "@SRC/exulu/context";
import { creatorId } from "@SRC/exulu/memory/creator-id";
import { displayName } from "@SRC/exulu/memory/recall-collector";
import { getTableName } from "@SRC/exulu/table-names";
import { coreSchemas } from "@SRC/postgres/core-schema";
import { applyAccessControl } from "@SRC/graphql/utilities/access-control";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";

const USAGE = "memory_usages";
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

// `coreSchemas.get().agentSessionsSchema()` runs `addCoreFields`, which pushes
// onto the shared module-level schema object's `fields` array on every call
// (see core-schema.ts) — every other production call site invokes it once at
// module scope, so memoize it here instead of calling it per request.
let sessionsTableDef: ExuluTableDefinition | null = null;
const sessionsTable = (): ExuluTableDefinition => (sessionsTableDef ??= coreSchemas.get().agentSessionsSchema());

export type UsageSummary = { memoryId: string; count: number; lastUsedAt: string | null };
export type UsageEntry = {
  sessionId: string | null; messageId: string; usedAt: string;
  agent: { id: string; name: string } | null; user: { id: number; name: string } | null; title: string | null;
};
export type MemoryUsageResult = { count: number; lastUsedAt: string | null; recent: UsageEntry[] };
export type WeekBucket = { weekStart: string; count: number };
export type BaseUsage = {
  used: number; neverUsed: number; stale: number;
  mostUsed: { id: string; information: string; count: number; lastUsedAt: string | null }[];
  newPerWeek: WeekBucket[];
};

const iso = (d: unknown): string | null => (d instanceof Date ? d.toISOString() : typeof d === "string" ? new Date(d).toISOString() : null);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0) || 0);

export function staleCutoff(now: Date, days: number): Date { return new Date(now.getTime() - days * DAY); }
export function isStale(lastUsedAt: Date | string | null | undefined, cutoff: Date): boolean {
  if (!lastUsedAt) return false;
  return new Date(lastUsedAt).getTime() < cutoff.getTime();
}

/** Monday 00:00 UTC of the ISO week containing `d`. */
function weekStart(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - day);
  return start;
}

export function weekBuckets(dates: (Date | string)[], now: Date, weeks = 6): WeekBucket[] {
  const current = weekStart(now);
  const starts = Array.from({ length: weeks }, (_, i) => new Date(current.getTime() - (weeks - 1 - i) * WEEK));
  const counts = new Map(starts.map((s) => [s.toISOString().slice(0, 10), 0]));
  for (const d of dates) {
    const key = weekStart(new Date(d)).toISOString().slice(0, 10);
    if (counts.has(key)) counts.set(key, counts.get(key)! + 1);
  }
  return starts.map((s) => { const key = s.toISOString().slice(0, 10); return { weekStart: key, count: counts.get(key)! }; });
}

async function hasTables(db: any, ...names: string[]): Promise<boolean> {
  for (const n of names) if (!(await db.schema.hasTable(n))) return false;
  return true;
}

/** Per-memory count + last use for the given ids (one grouped query). */
export async function memoryUsageByIds({ db, contextId, ids }: { db: any; contextId: string; ids: string[] }): Promise<UsageSummary[]> {
  if (ids.length === 0 || !(await hasTables(db, USAGE))) return [];
  // The frontend sends ≤ 20 ids at a time; clamp so the API never accepts thousands.
  const wanted = ids.slice(0, 200);
  const rows: any[] = await db(USAGE).where("context", contextId).whereIn("memory_id", wanted).groupBy("memory_id").select("memory_id").count("id as c").max("createdAt as last");
  return rows.map((r) => ({ memoryId: r.memory_id, count: num(r.c), lastUsedAt: iso(r.last) }));
}

/** Count, last use and the recent conversations of one memory; titles only for sessions the viewer may read. */
export async function memoryUsage({ db, contextId, memoryId, limit, user }: { db: any; contextId: string; memoryId: string; limit: number; user: User | undefined }): Promise<MemoryUsageResult> {
  if (!(await hasTables(db, USAGE))) return { count: 0, lastUsedAt: null, recent: [] };
  const totals = await db(USAGE).where({ context: contextId, memory_id: memoryId }).count("id as c").max("createdAt as last").first();
  const recentRows: any[] = await db(USAGE).where({ context: contextId, memory_id: memoryId }).orderBy("createdAt", "desc").limit(Math.max(1, Math.min(limit, 20))).select("session", "message_id", "createdAt", "agent", "user", "guest");
  const sessionIds = [...new Set(recentRows.map((r) => r.session).filter(Boolean))];
  const agentIds = [...new Set(recentRows.map((r) => r.agent).filter(Boolean))];
  const userIds = [...new Set(recentRows.map((r) => creatorId(r.user)).filter((x): x is number => x !== null))];
  const titles = new Map<string, string | null>();
  if (sessionIds.length) {
    const sessions: any[] = await applyAccessControl(sessionsTable(), db("agent_sessions").whereIn("id", sessionIds), user).select("id", "title");
    for (const s of sessions) titles.set(s.id, s.title ?? "");
  }
  const agents = new Map<string, string>();
  if (agentIds.length) for (const a of await db("agents").whereIn("id", agentIds).select("id", "name")) agents.set(a.id, a.name);
  const users = new Map<number, string>();
  if (userIds.length) for (const u of await db("users").whereIn("id", userIds).select("id", "firstname", "lastname", "email")) users.set(Number(u.id), displayName(u));
  return {
    count: num(totals?.c),
    lastUsedAt: iso(totals?.last),
    recent: recentRows.map((r) => {
      const uid = creatorId(r.user);
      return {
        sessionId: r.session ?? null, messageId: r.message_id, usedAt: iso(r.createdAt) ?? "",
        agent: r.agent && agents.has(r.agent) ? { id: r.agent, name: agents.get(r.agent)! } : null,
        user: uid !== null && users.has(uid) ? { id: uid, name: users.get(uid)! } : null,
        title: r.session && titles.has(r.session) ? titles.get(r.session) ?? null : null,
      };
    }),
  };
}

type UsageAgg = { memory_id: string; c: number; last: Date | null };

async function usageByMemory(db: any, contextId: string): Promise<UsageAgg[]> {
  const rows: any[] = await db(USAGE).where("context", contextId).groupBy("memory_id").select("memory_id").count("id as c").max("createdAt as last");
  return rows.map((r) => ({ memory_id: r.memory_id, c: num(r.c), last: r.last ? new Date(r.last) : null }));
}

/** Base-level usage for the stat card, the Usage filter and the workbench Insights block. */
export async function memoryBaseUsage({ db, context, user, staleDays, now = new Date() }: { db: any; context: ExuluContext; user: User | undefined; staleDays: number; now?: Date }): Promise<BaseUsage> {
  const itemsTable = getTableName(context.id);
  const empty: BaseUsage = { used: 0, neverUsed: 0, stale: 0, mostUsed: [], newPerWeek: weekBuckets([], now) };
  if (!(await hasTables(db, itemsTable))) return empty;
  const items: any[] = await db(itemsTable).whereNot("archived", true).select("id", "createdAt");
  const newPerWeek = weekBuckets(items.map((i) => i.createdAt), now);
  if (!(await hasTables(db, USAGE))) return { ...empty, neverUsed: items.length, newPerWeek };
  const agg = await usageByMemory(db, context.id);
  const itemIds = new Set(items.map((i) => i.id));
  const live = agg.filter((a) => itemIds.has(a.memory_id));
  const cutoff = staleCutoff(now, staleDays);
  const used = live.length;
  const stale = live.filter((a) => isStale(a.last, cutoff)).length;
  const neverUsed = items.length - used;
  // mostUsed: top candidates by count then last use, then only the wordings the viewer may read.
  const candidates = [...live].sort((a, b) => b.c - a.c || (b.last?.getTime() ?? 0) - (a.last?.getTime() ?? 0)).slice(0, 10);
  let mostUsed: BaseUsage["mostUsed"] = [];
  if (candidates.length) {
    const table = convertContextToTableDefinition(context);
    const visible: any[] = await applyAccessControl(table, db(itemsTable).whereIn("id", candidates.map((c) => c.memory_id)).whereNot("archived", true), user).select("id", "information");
    const wording = new Map(visible.map((v) => [v.id, String(v.information ?? "")]));
    mostUsed = candidates.filter((c) => wording.has(c.memory_id)).slice(0, 5).map((c) => ({ id: c.memory_id, information: wording.get(c.memory_id)!, count: c.c, lastUsedAt: c.last ? c.last.toISOString() : null }));
  }
  return { used, neverUsed, stale, mostUsed, newPerWeek };
}

/** Ids of non-archived memories never used (NEVER) or last used before the cutoff (STALE). */
export async function memoryBaseUnusedIds({ db, context, mode, staleDays, now = new Date() }: { db: any; context: ExuluContext; mode: "NEVER" | "STALE"; staleDays: number; now?: Date }): Promise<string[]> {
  const itemsTable = getTableName(context.id);
  if (!(await hasTables(db, itemsTable))) return [];
  const items: any[] = await db(itemsTable).whereNot("archived", true).select("id");
  if (!(await hasTables(db, USAGE))) return mode === "NEVER" ? items.map((i) => i.id) : [];
  const agg = await usageByMemory(db, context.id);
  const last = new Map(agg.map((a) => [a.memory_id, a.last]));
  const cutoff = staleCutoff(now, staleDays);
  return items.map((i) => i.id).filter((id) => (mode === "NEVER" ? !last.has(id) : last.has(id) && isStale(last.get(id) ?? null, cutoff)));
}
