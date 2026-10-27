/**
 * Chunker for the built-in `transcriptions` context.
 *
 * Why this exists: `defaultChunker` builds its text from `content` →
 * `description` → `name`, and a transcript item carries none of those — its
 * body lives in `transcript_text`, with the structure in `raw_segments` /
 * `corrected_segments`. Without a context-supplied chunker, every saved
 * transcript embedded exactly ONE chunk holding only its title, so vector,
 * tsvector and hybrid search (all three read `chunks.content`, and
 * `chunks.fts` is generated from it) could only ever match the title.
 *
 * Chunks are cut at speaker-turn boundaries and carry the speakers and the
 * time span they cover in `metadata`, which vector-search already selects and
 * passes through — so an answer can cite who said it and when.
 */
import type { Item } from "@EXULU_TYPES/models/item";
import { SentenceChunker } from "@SRC/chunking/sentence";
import { defaultChunker, type ChunkerOperation, type ChunkerResponse } from "@SRC/exulu/chunker";
import {
  effectiveSegments,
  transcriptBlocks,
  type RawSegment,
  type SpeakerMap,
  type TranscriptBlock,
} from "./transcript-text";

/** A block's rendered line, and the char range it occupies in that render. */
export type BlockRange = {
  /** Char offset where the block's line starts in the rendered text. */
  start: number;
  /** Char offset one past the line's last character. */
  end: number;
  block: TranscriptBlock;
};

/**
 * A jsonb column normally comes back parsed, but a value written as a JSON
 * *string* (the import path and the context write-tools both do that) comes
 * back as a string, and anything else — a jsonb scalar, a legacy shape — must
 * not be iterated as if it were segments.
 */
const parseJson = <T>(value: unknown): T | null => {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
};

const asSegments = (value: unknown): RawSegment[] | null => {
  const parsed = parseJson<unknown>(value);
  return Array.isArray(parsed) ? (parsed as RawSegment[]) : null;
};

const asSpeakerMap = (value: unknown): SpeakerMap => {
  const parsed = parseJson<unknown>(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SpeakerMap) : {};
};

/**
 * Render blocks the way `transcript_text` renders them — `Speaker: text`, one
 * line per turn — while recording where each line landed, so a chunk cut from
 * the render can be mapped back to the turns (and therefore the timestamps)
 * it covers.
 */
export const renderBlockLines = (
  blocks: TranscriptBlock[],
): { text: string; ranges: BlockRange[] } => {
  const ranges: BlockRange[] = [];
  let text = "";

  for (const block of blocks) {
    // Every line but the first is preceded by the separator, so the offset
    // has to account for it before the line itself is measured.
    if (text.length > 0) text += "\n";
    const line = `${block.speaker}: ${block.text}`;
    ranges.push({ start: text.length, end: text.length + line.length, block });
    text += line;
  }

  return { text, ranges };
};

/**
 * The speakers and time span of every block a `[from, to)` char range touches.
 * Null when the range overlaps nothing, which the caller treats as "no
 * defensible timestamps" rather than inventing a span.
 */
export const spanForRange = (
  ranges: BlockRange[],
  from: number,
  to: number,
): { speakers: string[]; start: number; end: number } | null => {
  const touched = ranges.filter((range) => range.start < to && range.end > from);
  if (touched.length === 0) return null;

  const speakers: string[] = [];
  for (const { block } of touched) {
    if (!speakers.includes(block.speaker)) speakers.push(block.speaker);
  }

  return {
    speakers,
    start: Math.min(...touched.map((r) => r.block.start)),
    end: Math.max(...touched.map((r) => r.block.end)),
  };
};

/**
 * Chunks carry contiguous indexes (0..n-1) after empties are dropped, the way
 * `defaultChunker` does — `chunk_index` is what expand-neighbours walks.
 */
const reindex = (
  chunks: { content: string; metadata: Record<string, unknown> }[],
): ChunkerResponse["chunks"] =>
  chunks
    .filter((chunk) => chunk.content.length > 0)
    .map((chunk, index) => ({ ...chunk, index }));

/**
 * Why ExuluChunkers.sentence rather than ExuluChunkers.recursive with custom
 * levels: the sentence chunker's delimiters are `[". ", "! ", "? ", "\n"]`,
 * and the newline is the turn separator this module renders — so it already
 * breaks at turn boundaries first and only splits inside a turn when one
 * overflows the budget, which is exactly the hierarchy a transcript wants.
 *
 * The recursive chunker cannot currently express that: `_splitText`
 * (src/chunking/recursive.ts:355) passes a STRING to `String.replace`, which
 * substitutes only the first occurrence, so `delimiters: ["\n"]` marks one
 * split point in the whole transcript and everything after it falls through to
 * the word level, cutting mid-turn.
 */

export const transcriptChunker: ChunkerOperation = async (item, maxChunkSize, utils) => {
  const segments = effectiveSegments(
    asSegments((item as Item).raw_segments),
    asSegments((item as Item).corrected_segments),
  );
  const blocks = transcriptBlocks(segments, asSpeakerMap((item as Item).speakers));

  const transcriptText =
    typeof (item as Item).transcript_text === "string" ? ((item as Item).transcript_text as string) : "";

  // Segments are the good case: cut the render, then map each cut back to the
  // turns it covers. Without them (older items, or a transcript edited down to
  // plain text) the text is still worth embedding — just with no timestamps.
  const { text, ranges } = blocks.length
    ? renderBlockLines(blocks)
    : { text: transcriptText.trim(), ranges: [] as BlockRange[] };

  // Nothing but a title. Keep today's behavior rather than returning zero
  // chunks: a transcript with no body should still be findable by its name.
  if (!text) return defaultChunker(item, maxChunkSize, utils);

  const chunker = await SentenceChunker.create({ chunkSize: maxChunkSize });
  const produced = await chunker(text);

  return {
    item,
    chunks: reindex(
      produced.map((chunk) => {
        const span = ranges.length ? spanForRange(ranges, chunk.startIndex, chunk.endIndex) : null;
        return {
          content: chunk.text.trim(),
          metadata: span ? { speakers: span.speakers, start: span.start, end: span.end } : {},
        };
      }),
    ),
  };
};
