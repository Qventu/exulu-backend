import type { UIMessage } from "ai";

/** Fewer words than this and the message is treated as a follow-up that needs context. */
export const SHORT_QUERY_WORDS = 8;
/** Upper bound of the combined search text; the tail (current message) is always kept. */
export const MAX_QUERY_CHARS = 600;
/** Phrases that refer back to an earlier turn (DE/EN). */
const REFERS_BACK = /\b(ich meinte|ich meine|meinte|sorry|das andere|die andere|der andere|das gleiche|dieselbe|derselbe|nochmal|noch mal|i meant|i mean|the same|that one|this one|the other)\b/i;
// Correction openers ("Nein, ...", "Doch, ...") are anchored to the start of the
// message rather than folded into REFERS_BACK: a trailing \b after a literal
// comma never matches in natural text, since the comma is followed by
// whitespace, not a word character.
const CORRECTION_OPENER = /^(nein|doch|falsch|nope|no)\b[,!.:]?/i;

/**
 * Search text for the memory recall (spec §3.1, "conversation-aware"). The
 * current message alone when it stands on its own; otherwise the previous one
 * or two user turns are prepended so a terse follow-up still recalls the
 * memories the conversation is about.
 */
export function buildRecallQuery(current: string, previousUserTurns: string[]): string {
  const cur = (current ?? "").trim();
  const words = cur.split(/\s+/).filter(Boolean).length;
  const needsContext = words < SHORT_QUERY_WORDS || REFERS_BACK.test(cur) || CORRECTION_OPENER.test(cur);
  if (!needsContext) return cur.slice(0, MAX_QUERY_CHARS);
  const prev = previousUserTurns.map((t) => (t ?? "").trim()).filter(Boolean).slice(-2);
  if (prev.length === 0) return cur.slice(0, MAX_QUERY_CHARS);
  const combined = [...prev, cur].join("\n");
  return combined.length > MAX_QUERY_CHARS ? combined.slice(combined.length - MAX_QUERY_CHARS) : combined;
}

/** User-authored text of every message except the last one, oldest first. */
export function previousUserTexts(messages: UIMessage[]): string[] {
  return messages
    .slice(0, -1)
    .filter((m) => m.role === "user")
    .map((m) => ((m.parts ?? []) as { type: string; text?: string }[]).filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text!.trim()).filter(Boolean).join("\n"))
    .filter(Boolean);
}
