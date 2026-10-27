import type { Knex } from "knex";

/**
 * The three timestamps on agent_sessions that let a chat list say what a
 * conversation is doing without opening it:
 *
 *   generating_since — an answer is being produced right now
 *   last_answer_at   — when the most recent answer finished
 *   last_seen_at     — when someone last had the session open
 *
 * "An answer nobody has read yet" is last_answer_at > last_seen_at. Both are
 * stamped from the SERVER clock on purpose: the comparison is meaningless if
 * one side comes from a browser whose clock is minutes off.
 *
 * The marks are session-wide, not per-viewer. On a shared session the badge
 * therefore means "nobody has read this yet" rather than "you haven't" —
 * the simpler reading, and the right one for a list whose rows are
 * overwhelmingly single-owner chats.
 *
 * Every stamp here is decoration on a chat turn, so none of them may ever
 * break one: they swallow their own failures and log.
 */

const stamp = async (
  db: Knex,
  session: string | undefined | null,
  patch: Record<string, Date | null>,
): Promise<void> => {
  if (!session) return;
  try {
    await db("agent_sessions").where({ id: session }).update(patch);
  } catch (error) {
    console.error(
      "[EXULU] failed to stamp session activity on " + session,
      error instanceof Error ? error.message : error,
    );
  }
};

/** A turn has started: the list shows this conversation as working. */
export const markSessionGenerating = (db: Knex, session: string | undefined | null): Promise<void> =>
  stamp(db, session, { generating_since: new Date() });

/**
 * A turn finished and produced an answer. Clearing generating_since in the
 * same write is what keeps a list row from ever showing both states at once.
 */
export const markSessionAnswered = (db: Knex, session: string | undefined | null): Promise<void> =>
  stamp(db, session, { last_answer_at: new Date(), generating_since: null });

/**
 * A turn stopped without an answer (it failed, or never started). The row goes
 * quiet rather than claiming there is something new to read.
 */
export const markSessionIdle = (db: Knex, session: string | undefined | null): Promise<void> =>
  stamp(db, session, { generating_since: null });

/** Someone has the session open, so everything in it counts as read. */
export const markSessionSeen = (db: Knex, session: string | undefined | null): Promise<void> =>
  stamp(db, session, { last_seen_at: new Date() });
