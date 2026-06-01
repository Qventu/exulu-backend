/**
 * Pure renderer: take whisperx segments + a speaker rename map and produce a
 * human-readable, speaker-labeled transcript string for the main field of a
 * transcriptions context item.
 *
 * Consecutive segments by the same speaker are collapsed into one block.
 * Speakers absent from `speakers` keep their raw label (SPEAKER_NN / "unknown").
 */

export type RawSegment = {
  start: number;
  end: number;
  text: string;
  speaker: string;
};

/**
 * Speaker rename map: { SPEAKER_00: "Daniel", SPEAKER_01: "Alex" }.
 * Keys not present in the map are rendered with the raw label.
 */
export type SpeakerMap = Record<string, string>;

export const renderTranscript = (
  segments: RawSegment[],
  speakers: SpeakerMap,
): string => {
  if (!segments || segments.length === 0) return "";

  const blocks: { speaker: string; text: string }[] = [];
  for (const seg of segments) {
    const text = (seg.text ?? "").trim();
    if (!text) continue;
    const label = speakers[seg.speaker] ?? seg.speaker ?? "unknown";
    const last = blocks[blocks.length - 1];
    if (last && last.speaker === label) {
      last.text = `${last.text} ${text}`.trim();
    } else {
      blocks.push({ speaker: label, text });
    }
  }

  return blocks.map((b) => `${b.speaker}: ${b.text}`).join("\n");
};
