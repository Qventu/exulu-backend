/**
 * Ownership check shared by the custom transcription GraphQL resolvers
 * (transcriptionJobFinalize/Cancel, runTranscriptPostProcessing,
 * recordingVideoUrl, liveRecordingStop) and the live-recording chunk REST
 * route. Mirrors createMutations.validateWriteAccess for RBAC tables:
 * super-admins pass, public rows pass, otherwise only the creator.
 *
 * `created_by` is a text column while `user.id` is an integer SERIAL, so the
 * comparison is string-based — a raw `===` fails for the legitimate creator
 * ("1" === 1 → false). Matches utils/check-record-access.ts.
 */
export class TranscriptionJobAccessError extends Error {
  constructor(
    public readonly code: 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = "TranscriptionJobAccessError";
  }
}

export type TranscriptionJobUser = {
  id: number | string;
  super_admin?: boolean | null;
};

// `db` is a knex instance; only .from().select().where().first() is used.
export async function assertOwnsTranscriptionJob(
  db: any,
  user: TranscriptionJobUser | null | undefined,
  id: string,
): Promise<void> {
  if (!user) throw new TranscriptionJobAccessError(403, "Authentication required");
  if (user.super_admin === true) return;
  const row = await db
    .from("transcription_jobs")
    .select(["created_by", "rights_mode"])
    .where({ id })
    .first();
  if (!row) throw new TranscriptionJobAccessError(404, `transcription_job ${id} not found`);
  if (row.rights_mode === "public") return;
  if (row.created_by != null && String(row.created_by) === String(user.id)) return;
  throw new TranscriptionJobAccessError(403, "Not authorized to act on this transcription job");
}
