// ee/claim-check/split.ts
//
// Sentence segmentation for claim extraction. Two jobs the paper's NLTK
// splitter does not have to do: keep character offsets into the ORIGINAL
// answer (the UI highlights by offset), and ignore the parts of a Markdown
// answer that are not prose (headings, fences, tables, bullets).
import { preprocessQuery } from "@SRC/utils/query-preprocessing";
import type { Sentence, SentenceWindow } from "./types";

/** ISO 639-3 (franc) -> ISO 639-1 (Intl.Segmenter). */
const LOCALE_BY_LANGUAGE: Record<string, string> = {
  eng: "en", deu: "de", fra: "fr", spa: "es", ita: "it",
  por: "pt", rus: "ru", nld: "nl", swe: "sv", nor: "no", dan: "da",
};

/**
 * Abbreviations that ICU's sentence-break suppressions do not reliably cover
 * across ICU builds. A segment ending with one of these is glued back onto
 * the next one, so "z. B." never ends a sentence.
 *
 * "z." (bare) was added for this machine's ICU build: it breaks "z. B."
 * between the two abbreviated words ("Die Ursache ist z. " | "B. ein ...")
 * rather than after the pair, so the two-word forms "z. b." / "z.b." never
 * match as a suffix and the bare form is what actually needs gluing here.
 * A bare single-letter entry is only safe because the match below requires a
 * word boundary before it — otherwise "z." also matches ordinary nouns like
 * "Platz." (and "no." would match "Casino.", "Domino.", "Piano."), gluing
 * unrelated sentences together while leaving offsets looking exact.
 */
const ABBREVIATIONS = [
  "z. b.", "z.b.", "z.", "u. a.", "u.a.", "d. h.", "d.h.", "bzw.", "ggf.", "ca.",
  "nr.", "abs.", "art.", "abb.", "tab.", "evtl.", "inkl.", "exkl.", "max.",
  "min.", "vgl.", "sog.", "bspw.", "etc.", "e.g.", "i.e.", "fig.", "no.",
];

/**
 * One boundary-guarded regex per abbreviation, built once at module load:
 * matches only when the abbreviation is preceded by start-of-text or
 * whitespace, so "z." glues "… ist z." but not "… am Platz.", and "no."
 * glues "… ist no." but not "… im Casino.".
 */
const ABBREVIATION_PATTERNS = ABBREVIATIONS.map(
  (a) => new RegExp(`(?:^|\\s)${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
);

function endsWithAbbreviation(text: string): boolean {
  const trimmed = text.trimEnd();
  return ABBREVIATION_PATTERNS.some((re) => re.test(trimmed));
}

type Block = { start: number; end: number; headingPath: string[] };

export function localeFromText(text: string): string {
  if (!text.trim()) return "en";
  const { language } = preprocessQuery(text, { enableStemming: false, detectLanguage: true });
  return LOCALE_BY_LANGUAGE[language] ?? "en";
}

/** True for lines that are structure, not prose: bullets, numbered items, table rows, rules, quotes. */
function isNonProseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (t.startsWith("|")) return true;
  if (/^[-*+]\s/.test(t)) return true;
  if (/^\d+[.)]\s/.test(t)) return true;
  if (/^(-{3,}|_{3,}|\*{3,})$/.test(t)) return true;
  if (t.startsWith(">")) return true;
  return false;
}

/**
 * Walk the answer line by line and collect maximal runs of prose lines. A run
 * is segmented as one unit, so a sentence may span a soft line break; offsets
 * stay absolute because a run is addressed by slice bounds into the answer.
 */
function collectBlocks(answer: string): Block[] {
  const blocks: Block[] = [];
  const headingPath: string[] = [];
  let inFence = false;
  let offset = 0;
  let runStart: number | null = null;
  let runEnd = 0;
  let runHeadings: string[] = [];

  const closeRun = () => {
    if (runStart !== null && runEnd > runStart) {
      blocks.push({ start: runStart, end: runEnd, headingPath: [...runHeadings] });
    }
    runStart = null;
  };

  for (const line of answer.split("\n")) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1; // the "\n" that split consumed
    const trimmed = line.trim();

    if (/^(```|~~~)/.test(trimmed)) {
      closeRun();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      closeRun();
      const depth = heading[1]!.length;
      headingPath.length = depth - 1;
      headingPath[depth - 1] = heading[2]!.trim();
      continue;
    }

    if (isNonProseLine(line)) {
      closeRun();
      continue;
    }

    if (runStart === null) {
      runStart = lineStart;
      runHeadings = headingPath.filter((h): h is string => Boolean(h));
    }
    runEnd = lineEnd;
  }

  closeRun();
  return blocks;
}

export function splitIntoSentences(answer: string, locale?: string): Sentence[] {
  if (!answer.trim()) return [];
  const resolved = locale ?? localeFromText(answer);
  const segmenter = new Intl.Segmenter(resolved, { granularity: "sentence" });
  const sentences: Sentence[] = [];

  for (const block of collectBlocks(answer)) {
    const raw = answer.slice(block.start, block.end);
    const pieces: { text: string; start: number }[] = [];

    for (const seg of segmenter.segment(raw)) {
      const previous = pieces[pieces.length - 1];
      if (previous !== undefined && endsWithAbbreviation(previous.text)) {
        previous.text += seg.segment;
      } else {
        pieces.push({ text: seg.segment, start: block.start + seg.index });
      }
    }

    for (const piece of pieces) {
      const leading = piece.text.length - piece.text.trimStart().length;
      const trimmed = piece.text.trim();
      if (!trimmed) continue;
      const start = piece.start + leading;
      sentences.push({
        index: sentences.length,
        start,
        end: start + trimmed.length,
        text: trimmed,
        headingPath: block.headingPath,
      });
    }
  }

  return sentences;
}

export function buildWindows(
  sentences: Sentence[],
  preceding: number,
  following: number,
): SentenceWindow[] {
  return sentences.map((sentence, i) => ({
    sentence,
    preceding: sentences.slice(Math.max(0, i - preceding), i),
    following: sentences.slice(i + 1, i + 1 + following),
  }));
}
