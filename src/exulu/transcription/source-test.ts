/**
 * Liveness check for one transcription source, for the Sources section of the
 * Transcripts settings page.
 *
 * Deliberately a reachability check, not a round-trip: it answers "is this
 * configured and responding", which is what an admin looking at a red dot
 * needs. Built from injected deps so the branching is testable without the
 * three real services.
 *
 * Design doc: docs/superpowers/specs/2026-09-30-transcripts-settings-design.md §5
 */
export type TranscriptionSource = "upload" | "meeting" | "record";

export type SourceTestResult =
  | { ok: true }
  | { ok: false; reason: "not_configured" }
  | { ok: false; reason: "unreachable"; message: string };

export type SourceTestDeps = {
  whisperConfigured: () => boolean;
  pingWhisper: () => Promise<void>;
  recallConfigured: () => boolean;
  pingRecall: () => Promise<void>;
  recordModelConfigured: () => boolean;
  pingRecordModel: () => Promise<void>;
};

export async function testSource(
  source: TranscriptionSource,
  deps: SourceTestDeps,
): Promise<SourceTestResult> {
  const table: Record<TranscriptionSource, { configured: () => boolean; ping: () => Promise<void> }> = {
    upload: { configured: deps.whisperConfigured, ping: deps.pingWhisper },
    meeting: { configured: deps.recallConfigured, ping: deps.pingRecall },
    record: { configured: deps.recordModelConfigured, ping: deps.pingRecordModel },
  };
  const entry = table[source];
  if (!entry) throw new Error(`Unknown source "${source}".`);
  if (!entry.configured()) return { ok: false, reason: "not_configured" };
  try {
    await entry.ping();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "unreachable", message: (err as Error).message };
  }
}
