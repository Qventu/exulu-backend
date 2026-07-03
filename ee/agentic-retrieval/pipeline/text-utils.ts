export const normalizeFileName = (fileName: string): string => {
  // 1. Remove the first path segment (e.g., "/aufzugsperipherie")
  const parts = fileName.split('/').filter(p => p); // filter out empty strings
  let normalized = parts.length > 1 ? parts.slice(1).join('/') : (parts[0] || '');

  // 2. Replace the remaining slashes with a space
  normalized = normalized.replace(/\//g, ' ');

  // 3. Convert to lowercase
  normalized = normalized.toLowerCase();

  // 4. PRE-CLEANUP: Insert a space before the file extension period.
  // This looks for a dot followed by 3-4 letters/digits at the end of the string.
  // The captured group ($1) puts the extension back with a space before it.
  normalized = normalized.replace(/(\.[a-z0-9]{3,4})$/g, ' $1');

  // 5. Final cleanup: Remove all characters that are NOT a lowercase letter, digit, space, or a period.
  // We keep the period here temporarily to ensure the extension is preserved.
  normalized = normalized.replace(/[^a-z0-9\. ]/g, '');

  // 6. Final step: Replace any space/dot/space pattern with just a space
  // and trim excess spaces. This handles the space inserted in step 4.
  // The regex /\s*\.\s*/g finds any combination of space-dot-space and replaces it with a single space.
  normalized = normalized.replace(/\s*\.\s*/g, ' ');

  // 7. Clean up multiple spaces and leading/trailing spaces
  normalized = normalized.replace(/ +/g, ' ').trim();

  return normalized;
};

export const normalizeText = (text: string): string => {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export const deriveKeywordVariants = (keyword: string): string[] => {
    const lower = keyword.trim().toLowerCase();
    if (!lower) return [];
    const variants = new Set<string>();
    variants.add(lower);
    variants.add(lower.replace(/[-_\.\s]/g, ''));
    variants.add(lower.replace(/\d+$/, ''));
    variants.add(lower.replace(/[-_\.\s]/g, '').replace(/\d+$/, ''));
    return [...variants].filter(v => v.length >= 4);
}

export function extractIdentifierTokens(parts: Array<string | undefined>): string[] {
    const tokens = new Set<string>();
    for (const part of parts) {
        if (!part) continue;
        // Split on whitespace so multi-word strings (the raw question) yield candidates.
        for (const raw of part.split(/\s+/)) {
            const norm = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
            if (norm.length >= 4 && /\d/.test(norm) && /[a-z]/.test(norm)) {
                tokens.add(norm);
            }
        }
    }
    return [...tokens];
}

/** True if the document filename contains any of the identifier tokens (separators ignored). */
export function itemMatchesIdentifierToken(itemName: string | undefined, tokens: string[]): boolean {
    if (!itemName || tokens.length === 0) return false;
    const normName = normalizeFileName(itemName).toLowerCase().replace(/[^a-z0-9]/g, "");
    return tokens.some(t => normName.includes(t));
}

export const stripSeparators = (s: string): string => s.toLowerCase().replace(/[-_\.\s]/g, "");

/** Apply configured find→replace rules (case-insensitive, all occurrences).
 * Returns one rewritten query per rule that changed the input; deduped. */
export function applyRewrites(
  question: string,
  rewrites: { find: string; replace: string }[],
): string[] {
  const out = new Set<string>();
  for (const rule of rewrites) {
    if (!rule.find) continue;
    const escaped = rule.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rewritten = question.replace(new RegExp(escaped, "gi"), rule.replace);
    if (rewritten !== question) out.add(rewritten);
  }
  return [...out];
}
