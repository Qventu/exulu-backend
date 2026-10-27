import type { Knex } from "knex";
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";
import { applyAccessControl } from "../utilities/access-control";
import { markSessionSeen } from "@SRC/exulu/session-activity";

/**
 * Records that someone has the session open, which is what clears the chat
 * list's "answer waiting" badge (see src/exulu/session-activity.ts).
 *
 * The timestamp is taken from the server clock rather than accepted from the
 * caller: it is compared against a server-stamped last_answer_at, and a
 * browser clock running fast would otherwise mark every future answer read.
 * For the same reason the viewer may only stamp a session they could open —
 * the read marker is shared by everyone with access, so letting any
 * authenticated caller stamp any id would hide other people's answers.
 */
export const markSessionSeenForViewer = async ({
  db,
  table,
  user,
  id,
}: {
  db: Knex;
  table: ExuluTableDefinition;
  user?: User;
  id: string;
}): Promise<boolean> => {
  if (!user) {
    throw new Error("Authentication required to mark a conversation as seen.");
  }
  if (!id) return false;

  const visible = await applyAccessControl(
    table,
    db.from("agent_sessions").where({ id }).select("id"),
    user,
  ).first();
  if (!visible) return false;

  await markSessionSeen(db, id);
  return true;
};
