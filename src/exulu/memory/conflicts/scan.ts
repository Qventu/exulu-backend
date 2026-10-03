import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "@SRC/exulu/context";
import { getChunksTableName, getTableName } from "@SRC/exulu/table-names";
import { groupDuplicates, groupKey, pairKey, sortIds, splitBands, type Pair } from "./detect";
import type { Judge, Judgement } from "./judge";
import { CANDIDATE_MIN_SIMILARITY, GROUP_MAX_MEMBERS, JUDGE_CALLS_PER_SCAN, SCAN_MAX_MEMORIES, SCAN_MAX_PAIRS } from "./thresholds";

export type { Judge, Judgement };
export type ScanResult = { open: number; duplicateGroups: number; contradictionGroups: number; judged: number; unjudged: number; skipped: number; scannedAt: string };

/** Insert cap per statement; large upserts go in chunks of this size. */
const INSERT_CHUNK = 500;

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);

const insertInChunks = async (db: any, table: string, rows: any[]): Promise<void> => {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await db(table).insert(rows.slice(i, i + INSERT_CHUNK)).onConflict("key").ignore();
  }
};

/** All public, non-archived memory pairs of the base at or above the candidate floor (first chunk per memory). */
export async function loadPublicPairs(db: any, context: ExuluContext): Promise<{ pairs: Pair[]; truncated: boolean }> {
  const items = getTableName(context.id);
  const chunks = getChunksTableName(context.id);
  const { rows } = await db.raw(
    `SELECT a.source AS a_id, b.source AS b_id, 1 - (a.embedding <=> b.embedding) AS similarity
       FROM ${chunks} a
       JOIN ${chunks} b ON a.source < b.source
       JOIN ${items} ia ON ia.id = a.source
       JOIN ${items} ib ON ib.id = b.source
      WHERE a.chunk_index = 0 AND b.chunk_index = 0
        AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
        AND ia.rights_mode = 'public' AND ib.rights_mode = 'public'
        AND (ia.archived IS NOT TRUE) AND (ib.archived IS NOT TRUE)
        AND 1 - (a.embedding <=> b.embedding) >= ?
      ORDER BY similarity DESC
      LIMIT ?`,
    [CANDIDATE_MIN_SIMILARITY, SCAN_MAX_PAIRS + 1],
  );
  const all = (rows ?? []).map((r: any) => ({ a: r.a_id, b: r.b_id, similarity: num(r.similarity) }));
  // We asked for one row past the cap. If it's there, the base has more pairs than
  // one scan will process; drop that extra row and flag `truncated` so the caller
  // can surface "more pairs exist, run again" via `skipped` instead of silently
  // dropping work.
  const truncated = all.length > SCAN_MAX_PAIRS;
  return { pairs: truncated ? all.slice(0, SCAN_MAX_PAIRS) : all, truncated };
}

export async function runScan({ db, context, user, judge, now = new Date() }: { db: any; context: ExuluContext; user: User; judge: Judge; now?: Date }): Promise<ScanResult> {
  const items = getTableName(context.id);
  const [{ c }] = await db(items).whereRaw("archived IS NOT TRUE").where("rights_mode", "public").count("id as c");
  if (num(c) > SCAN_MAX_MEMORIES) throw new Error(`Memory base ${context.id} is too large for a conflict scan (${c} public memories, cap ${SCAN_MAX_MEMORIES})`);

  const { pairs, truncated } = await loadPublicPairs(db, context);
  const { duplicatePairs, candidatePairs } = splitBands(pairs);

  // Stored judgements: reuse, never re-ask.
  const stored: any[] = await db("memory_judgements").where("context", context.id).select("key", "verdict", "reason");
  const known = new Map(stored.map((j) => [j.key, { verdict: j.verdict as Judgement["verdict"], reason: j.reason ?? "" }]));

  const samePairs: Pair[] = [];
  const contradictions: { pair: Pair; reason: string }[] = [];
  const newJudgements: { key: string; verdict: string; reason: string }[] = [];
  let judged = 0, unjudged = 0, calls = 0;
  const wordings = new Map<string, string>();
  const needWording = candidatePairs.filter((p) => !known.has(pairKey(context.id, p.a, p.b)));
  if (needWording.length) {
    const ids = [...new Set(needWording.flatMap((p) => [p.a, p.b]))];
    for (const row of await db(items).whereIn("id", ids).select("id", "information")) wordings.set(row.id, String(row.information ?? ""));
  }
  for (const pair of candidatePairs) {
    const key = pairKey(context.id, pair.a, pair.b);
    let verdict = known.get(key);
    if (!verdict) {
      if (calls >= JUDGE_CALLS_PER_SCAN) { unjudged += 1; continue; }
      calls += 1;
      try {
        verdict = await judge(wordings.get(pair.a) ?? "", wordings.get(pair.b) ?? "");
        judged += 1;
        newJudgements.push({ key, verdict: verdict.verdict, reason: verdict.reason });
      } catch (e) {
        console.error("[EXULU] conflict judge failed", e instanceof Error ? e.message : String(e));
        unjudged += 1;
        continue;
      }
    }
    if (verdict.verdict === "same") samePairs.push(pair);
    else if (verdict.verdict === "contradict") contradictions.push({ pair, reason: verdict.reason });
  }
  if (newJudgements.length) {
    await insertInChunks(db, "memory_judgements", newJudgements.map((j) => ({ context: context.id, ...j, judged_at: now })));
  }

  const { groups, leftover } = groupDuplicates([...duplicatePairs, ...samePairs], GROUP_MAX_MEMBERS);
  const produced = new Map<string, { kind: "duplicate" | "contradiction"; members: string[]; similarity: number; reason: string | null }>();
  for (const g of groups) produced.set(groupKey(context.id, "duplicate", g.members), { kind: "duplicate", members: g.members, similarity: g.similarity, reason: null });
  for (const { pair, reason } of contradictions) {
    const members = sortIds([pair.a, pair.b]);
    produced.set(groupKey(context.id, "contradiction", members), { kind: "contradiction", members, similarity: pair.similarity, reason });
  }

  const existing: any[] = await db("memory_conflicts").where("context", context.id).select("id", "key", "status", "resolution");
  const byKey = new Map(existing.map((r) => [r.key, r]));
  const inserts: any[] = [];
  for (const [key, g] of produced) {
    const row = byKey.get(key);
    if (!row) {
      inserts.push({ context: context.id, kind: g.kind, key, members: JSON.stringify(g.members), similarity: g.similarity, reason: g.reason, status: "open", scanned_at: now });
    } else if (row.status === "open") {
      await db("memory_conflicts").where({ id: row.id }).update({ similarity: g.similarity, reason: g.reason, scanned_at: now });
    } else if (row.status === "resolved" && row.resolution == null) {
      // Machine-closed (scan stopped reproducing it) and the scan reproduces it again:
      // reopen. A human `resolution` on a resolved row means it stays closed.
      await db("memory_conflicts").where({ id: row.id }).update({ status: "open", resolved_at: null, resolved_by: null, similarity: g.similarity, reason: g.reason, scanned_at: now });
    }
    // dismissed, or resolved with a human resolution: untouched
  }
  if (inserts.length) await insertInChunks(db, "memory_conflicts", inserts);
  const toClose = existing.filter((r) => r.status === "open" && !produced.has(r.key)).map((r) => r.id);
  if (toClose.length) await db("memory_conflicts").whereIn("id", toClose).update({ status: "resolved", resolution: null, resolved_at: now, scanned_at: now });

  const stillClosed = (k: string): boolean => {
    const row = byKey.get(k);
    if (!row) return false;
    if (row.status === "dismissed") return true;
    if (row.status === "resolved" && row.resolution != null) return true;
    return false; // new, already open, or machine-closed and just reopened above
  };

  return {
    open: [...produced.keys()].filter((k) => !stillClosed(k)).length,
    duplicateGroups: groups.length,
    contradictionGroups: contradictions.length,
    judged, unjudged, skipped: leftover.length + (truncated ? 1 : 0),
    scannedAt: now.toISOString(),
  };
}
