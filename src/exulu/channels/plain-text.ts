/**
 * Channel answers are plain text. When an agent has a context-search or web-search tool,
 * generateSync's system prompt (generate-stream.ts, "When you use a context search tool")
 * asks for inline citations on one line with unquoted keys:
 *
 *   {item_name: <item_name>, item_id: <item_id>, context: <context_id>, chunk_id: <chunk_id>, chunk_index: <chunk_index>}
 *   {url: <url>, title: <title>, snippet: <snippet>}
 *
 * The web chat turns these into badges (frontend components/message-renderer.tsx: a
 * `{...}` group containing `item_name` + `item_id`, or `url` + `title` + `snippet`).
 * Here they are removed, and only the spacing and brackets they leave behind are tidied.
 * Memory recall cites with quoted values ({item_name: "…", context: "…"}), so quoted
 * values and nested braces inside a group are allowed. Only a whole group that ends on its
 * own line and reads as a citation is removed; anything else is left exactly as it is.
 */

const MARK = "\u0000";

const CITATION_KEYS = ["item_name", "item_id", "context", "chunk_id", "chunk_index", "url", "title", "snippet"];

const hasKey = (inner: string, key: string): boolean => new RegExp(`(?:^|[\\s,])${key}\\s*:`).test(inner);

const isCitation = (inner: string): boolean => {
  // a citation starts with one of its own unquoted keys; JSON ("key": …), placeholders
  // ({name}) and other objects ({a: 1}) do not
  const first = /^\s*([a-z_]+)\s*:/i.exec(inner);
  if (!first?.[1] || !CITATION_KEYS.includes(first[1].toLowerCase())) return false;
  if (hasKey(inner, "item_name") && (hasKey(inner, "item_id") || hasKey(inner, "context") || hasKey(inner, "chunk_id"))) {
    return true;
  }
  return hasKey(inner, "url") && hasKey(inner, "title") && hasKey(inner, "snippet");
};

/** `"` opens a quoted value only directly after a field's `key:` (`{key: "` or `, key: "`). */
const OPENS_QUOTE = /(?:^|[{,])\s*[a-z_]+\s*:\s*$/i;
/** and closes it only where the value can end: before `,`, `}` or the end of the line. */
const CLOSES_QUOTE = /^[ \t]*(?:[,}]|\n|$)/;

/**
 * Index of the `}` closing the group opened at `start`, on the same line, or -1. Braces
 * inside a quoted value do not count; any other `"` (an inch mark, a quote in a file name)
 * is an ordinary character.
 */
const closingBrace = (text: string, start: number): number => {
  let depth = 0;
  let quoted = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") return -1;
    if (quoted) {
      if (c === '"' && CLOSES_QUOTE.test(text.slice(i + 1, i + 33))) quoted = false;
      continue;
    }
    if (c === '"' && OPENS_QUOTE.test(text.slice(start, i))) quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
};

export const stripCitations = (text: string): string => {
  let out = "";
  let found = false;
  for (let i = 0; i < text.length; ) {
    if (text[i] === "{") {
      const end = closingBrace(text, i);
      if (end !== -1 && isCitation(text.slice(i + 1, end))) {
        out += MARK;
        found = true;
        i = end + 1;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  if (!found) return text;
  if (text.includes(MARK)) return out.split(MARK).join("").trim();

  return (
    out
      // a run of citations, and the spaces before it, count as one
      .replace(/[ \t]*\u0000(?:[ \t]*\u0000)*/g, MARK)
      // brackets that only held citations
      .replace(/[ \t]*(?:\(\s*\u0000\s*\)|\[\s*\u0000\s*\])/g, MARK)
      // before punctuation
      .replace(/\u0000(?=[.,;:!?)\]])/g, "")
      // at the end of a line
      .replace(/\u0000[ \t]*(?=\n|$)/g, "")
      // at the start of a line
      .replace(/(^|\n)\u0000[ \t]*/g, "$1")
      // between two words: one space
      .replace(/\u0000(?=\S)/g, " ")
      .replace(/\u0000/g, "")
      // lines that only held citations
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+/, "")
      .trimEnd()
  );
};
