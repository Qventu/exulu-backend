/**
 * Renders a saved transcript item into the export formats offered by the
 * reading view's Export menu (spec 2026-09-29 §3.2).
 *
 * Pure on purpose: the route around it needs a live db and the app
 * singleton, so this module is where the formats are actually testable.
 * Every format reads effectiveSegments, so an export always reflects the
 * user's corrections rather than the raw engine output.
 */
import {
  effectiveSegments,
  formatClock,
  type RawSegment,
  type SpeakerMap,
} from "./transcript-text";

export type TranscriptExportItem = {
  name?: string | null;
  recording_source?: string | null;
  recorded_at?: string | Date | null;
  duration_seconds?: number | null;
  language?: string | null;
  speakers?: SpeakerMap | null;
  raw_segments?: RawSegment[] | null;
  corrected_segments?: RawSegment[] | null;
  post_processing?:
    | { prompt_name: string | null; status: string; output: string | null }[]
    | null;
};

export type TranscriptExportOptions = {
  summary: boolean;
  timestamps: boolean;
  speakers: boolean;
};

type Block = { label: string; start: number; text: string };

/** Consecutive segments by the same resolved speaker collapse into one block. */
const toBlocks = (
  item: TranscriptExportItem,
  useSpeakerNames: boolean,
): Block[] => {
  const segments = effectiveSegments(item.raw_segments, item.corrected_segments);
  const names = item.speakers ?? {};
  const blocks: Block[] = [];
  for (const segment of segments) {
    const text = (segment.text ?? "").trim();
    if (!text) continue;
    const raw = segment.speaker || "unknown";
    const label = useSpeakerNames ? (names[raw] ?? raw) : raw;
    const last = blocks[blocks.length - 1];
    if (last && last.label === label) {
      last.text = `${last.text} ${text}`.trim();
    } else {
      blocks.push({ label, start: segment.start, text });
    }
  }
  return blocks;
};

const metaLine = (item: TranscriptExportItem): string => {
  const parts: string[] = [];
  if (item.recording_source) parts.push(item.recording_source);
  if (item.recorded_at) parts.push(new Date(item.recorded_at).toISOString().slice(0, 10));
  if (item.duration_seconds != null) parts.push(formatClock(item.duration_seconds));
  if (item.language) parts.push(item.language);
  return parts.join(" · ");
};

export function buildTranscriptMarkdown(
  item: TranscriptExportItem,
  options: TranscriptExportOptions,
): string {
  const sections: string[] = [`# ${item.name?.trim() || "Transcript"}`];

  const meta = metaLine(item);
  if (meta) sections.push(meta);

  if (options.summary) {
    for (const output of item.post_processing ?? []) {
      // A failed run has no content worth exporting; printing its error
      // into someone's Word document would be worse than omitting it.
      if (output.status !== "done" || !output.output?.trim()) continue;
      sections.push(`## ${output.prompt_name ?? "Summary"}`);
      sections.push(output.output.trim());
    }
  }

  const blocks = toBlocks(item, options.speakers);
  if (blocks.length > 0) {
    sections.push("## Transcript");
    for (const block of blocks) {
      const heading = options.timestamps
        ? `**${block.label}** [${formatClock(block.start)}]`
        : `**${block.label}**`;
      sections.push(`${heading}\n\n${block.text}`);
    }
  }

  return `${sections.join("\n\n")}\n`;
}
