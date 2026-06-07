import { randomBytes } from "node:crypto";
import type { Knex } from "knex";

/**
 * Maps an Exulu session onto its Hermes-side session id.
 *
 * We carry our own identity into Hermes via the X-Hermes-Session-Id header, so
 * Hermes' per-profile state.db keys conversation continuity on an id we control
 * and store on `agent_sessions.hermes_session_id`. Access control is unchanged:
 * the caller has already passed `agent_sessions` RBAC before reaching here, so
 * this module never re-checks permissions — it only resolves/persists the id.
 *
 * Design doc: docs/superpowers/specs/2026-06-03-hermes-agent-mode-design.md
 */

const newHermesSessionId = (): string => `sess_${randomBytes(16).toString("hex")}`;

/**
 * Resolve the Hermes session id for an Exulu session, creating and persisting
 * one on first advanced-mode use. When there is no Exulu session (anonymous /
 * sessionless request), returns a fresh ephemeral id that is not persisted.
 */
export const resolveHermesSessionId = async (
  db: Knex,
  exuluSessionId: string | null | undefined,
): Promise<string> => {
  if (!exuluSessionId) return newHermesSessionId();

  const row = await db
    .from("agent_sessions")
    .where({ id: exuluSessionId })
    .first();

  const existing = row?.hermes_session_id as string | undefined;
  if (existing && existing.length > 0) return existing;

  const id = newHermesSessionId();
  await db
    .from("agent_sessions")
    .where({ id: exuluSessionId })
    .update({ hermes_session_id: id });
  return id;
};

export type HistoryTurn = { role: "user" | "assistant"; content: string };

/**
 * Load the prior turns of a session as [{role, content}] for the runs API's
 * `conversation_history`. The runs API's `session_id` is only a correlation
 * label — it does NOT make Hermes recall the conversation — so we pass history
 * explicitly. We read it from `agent_messages` (the dual-write we already do),
 * so there's no dependency on Hermes' own session memory.
 *
 * Returns turns oldest-first, text-only; excludes the in-flight turn (persisted
 * after the run). RBAC is enforced upstream.
 */
export const loadHermesConversationHistory = async (
  db: Knex,
  exuluSessionId: string | null | undefined,
  userId?: number | string,
): Promise<HistoryTurn[]> => {
  if (!exuluSessionId) return [];
  const rows: Array<{ content: string }> = await db
    .from("agent_messages")
    .where({ session: exuluSessionId, ...(userId != null ? { user: userId } : {}) })
    .orderBy("createdAt", "asc");

  const history: HistoryTurn[] = [];
  for (const row of rows) {
    try {
      const msg = JSON.parse(row.content);
      const text = (msg?.parts ?? [])
        .map((p: any) => (p?.type === "text" ? p.text : ""))
        .join("")
        .trim();
      if (!text) continue;
      history.push({ role: msg?.role === "user" ? "user" : "assistant", content: text });
    } catch {
      // skip unparseable rows
    }
  }
  return history;
};
