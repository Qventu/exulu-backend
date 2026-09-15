/**
 * engine v2 runs identifier pins in parallel with the memory phase, on the original
 * question. Memory augmentation then usually rewrites the question (synonyms from the
 * glossary/memory), and re-running the pins for every rewrite put ~1 s back on the
 * critical path in most turns (eval 2026-09-12: pinsMs median 1.0 s). Pins come from
 * designations (model names, error codes, part numbers), so only a rewrite that adds a
 * new designation-like token can change them.
 */
export function needsPinRerun(originalQuestion: string, updatedQuestion: string): boolean {
  if (originalQuestion === updatedQuestion) return false;
  const before = designations(originalQuestion);
  for (const token of designations(updatedQuestion)) {
    if (!before.has(token)) return true;
  }
  return false;
}

/** Tokens that look like designations: they carry a digit or at least two capitals (FST-2XT, 0x02, CBM). */
function designations(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/[\s,;:()\[\]"'?!]+/)) {
    const token = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!token) continue;
    const hasDigit = /\p{N}/u.test(token);
    const capitals = (token.match(/\p{Lu}/gu) ?? []).length;
    if (hasDigit || capitals >= 2) out.add(token.toLowerCase());
  }
  return out;
}
