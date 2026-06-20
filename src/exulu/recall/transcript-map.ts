/**
 * Map a Recall.ai downloaded transcript (JSON Transcript Download URL schema)
 * onto the RawSegment[] shape the transcription feature already uses, so the
 * existing renderTranscript() and finalize() paths work unchanged.
 *
 * The downloaded transcript is an array of per-participant utterances:
 *
 *   [
 *     {
 *       participant: { id, name, email, ... },
 *       words: [ { text, start_timestamp: { relative }, end_timestamp: { relative } | null } ]
 *     },
 *     ...
 *   ]
 *
 * Each utterance becomes one RawSegment whose `speaker` is the participant's
 * real name from diarization (falling back to email or "Speaker <id>").
 *
 * Design doc: docs/superpowers/specs/2026-06-19-recall-meeting-recording-design.md
 */

import type { RawSegment } from "../transcription/transcript-text";

type RecallWord = {
  text?: string;
  start_timestamp?: { relative?: number | null } | null;
  end_timestamp?: { relative?: number | null } | null;
};

type RecallParticipant = {
  id?: number | string | null;
  name?: string | null;
  email?: string | null;
};

type RecallUtterance = {
  participant?: RecallParticipant | null;
  words?: RecallWord[] | null;
};

const speakerLabel = (participant: RecallParticipant | null | undefined): string => {
  if (!participant) return "unknown";
  if (participant.name && participant.name.trim()) return participant.name.trim();
  if (participant.email && participant.email.trim()) return participant.email.trim();
  if (participant.id != null) return `Speaker ${participant.id}`;
  return "unknown";
};

const wordStart = (w: RecallWord): number | null =>
  typeof w.start_timestamp?.relative === "number" ? w.start_timestamp.relative : null;

const wordEnd = (w: RecallWord): number | null =>
  typeof w.end_timestamp?.relative === "number" ? w.end_timestamp.relative : null;

/**
 * Convert the downloaded Recall transcript JSON into RawSegment[].
 * Tolerant of missing/empty fields; utterances with no text are skipped.
 */
export const mapRecallTranscript = (raw: unknown): RawSegment[] => {
  if (!Array.isArray(raw)) return [];

  const segments: RawSegment[] = [];
  for (const entry of raw as RecallUtterance[]) {
    const words = Array.isArray(entry?.words) ? entry.words : [];
    const text = words
      .map((w) => (w?.text ?? "").trim())
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!text) continue;

    const starts = words.map(wordStart).filter((n): n is number => n != null);
    const ends = words.map(wordEnd).filter((n): n is number => n != null);
    const start = starts.length ? Math.min(...starts) : 0;
    const end = ends.length ? Math.max(...ends) : start;

    segments.push({
      start,
      end,
      text,
      speaker: speakerLabel(entry?.participant),
    });
  }

  // Recall delivers per-participant streams; sort by start time so the rendered
  // transcript reads chronologically across speakers.
  segments.sort((a, b) => a.start - b.start);
  return segments;
};

/** Longest end timestamp across segments — used as a duration fallback. */
export const durationFromSegments = (segments: RawSegment[]): number | null => {
  if (!segments.length) return null;
  return Math.max(...segments.map((s) => s.end));
};
