import { franc } from "franc";
import natural from "natural";

/**
 * Query Preprocessing Utilities
 *
 * Handles language detection and query stemming for better search results
 * across different languages and word forms.
 */

/**
 * Language code mapping from franc (ISO 639-3) to natural stemmers
 */
const STEMMER_MAP: Record<string, any> = {
  eng: natural.PorterStemmer, // English
  deu: natural.PorterStemmerDe, // German
  fra: natural.PorterStemmerFr, // French
  rus: natural.PorterStemmerRu, // Russian
  ita: natural.PorterStemmerIt, // Italian
  nld: natural.PorterStemmerNl, // Dutch
  por: natural.PorterStemmerPt, // Portuguese
  spa: natural.PorterStemmerEs, // Spanish
  swe: natural.PorterStemmerSv, // Swedish
  nor: natural.PorterStemmerNo, // Norwegian
  dan: natural.PorterStemmer, // Danish (fallback to English)
};

/**
 * Common language codes for better detection with short queries
 */
const COMMON_LANGUAGES = ["eng", "deu", "fra", "spa", "ita", "por", "rus", "nld"];

/**
 * Detects the language of a query string
 *
 * @param query - The query string to analyze
 * @param minLength - Minimum query length for reliable detection (default: 10)
 * @returns ISO 639-3 language code (e.g., 'eng', 'deu') or 'und' if undetermined
 */
function detectQueryLanguage(query: string, minLength: number = 10): string {
  // Clean the query
  const cleaned = query.trim();

  // For very short queries, franc is unreliable
  // Try to detect based on character patterns
  if (cleaned.length < minLength) {
    // Check for German-specific characters
    if (/[äöüßÄÖÜ]/.test(cleaned)) {
      return "deu";
    }
    // Check for French-specific characters
    if (/[àâæçéèêëîïôùûüÿœÀÂÆÇÉÈÊËÎÏÔÙÛÜŸŒ]/.test(cleaned)) {
      return "fra";
    }
    // Check for Spanish-specific characters
    if (/[áéíóúñüÁÉÍÓÚÑÜ¿¡]/.test(cleaned)) {
      return "spa";
    }
    // Default to English for short queries without special characters
    return "eng";
  }

  // Use franc for longer queries, with whitelist of common languages
  const detected = franc(cleaned, { only: COMMON_LANGUAGES, minLength: 3 });

  // If undetermined, default to English
  if (detected === "und") {
    return "eng";
  }

  return detected;
}

/**
 * Stems a word using the appropriate language-specific stemmer
 *
 * @param word - The word to stem
 * @param languageCode - ISO 639-3 language code
 * @returns Stemmed word
 */
function stemWord(word: string, languageCode: string): string {
  const stemmer = STEMMER_MAP[languageCode] || natural.PorterStemmer;

  // Trim punctuation that merely surrounds the token (commas, quotes, brackets, …) and
  // normalise case. Inner characters are kept: they are part of the token's identity.
  const core = word
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "")
    .toLowerCase();

  if (!core) {
    return word;
  }

  // Tokens containing digits or inner punctuation are identifiers, dimensions or
  // fractions (3/4, 50/95, Zg.60858_0500, AZFR-G), not inflected words. Stemming them
  // used to strip the punctuation first, turning 3/4 into 34 and 50/95 into 5095 —
  // which matches nothing in a catalog that stores 3/4". Keep them verbatim.
  if (!/^\p{L}+$/u.test(core)) {
    return core;
  }

  try {
    return stemmer.stem(core);
  } catch (error) {
    console.warn(`[EXULU] Error stemming word "${word}":`, error);
    return core;
  }
}

/**
 * Builds the input for `websearch_to_tsquery` used by the hybrid search's full-text branch.
 *
 * The tokens of the original query and of its stemmed form are OR-ed together, so a single
 * keyword that does not occur in the corpus (a pump type read off a photo, say) can no longer
 * zero out the whole branch the way the AND semantics of `plainto_tsquery` did. Including the
 * original tokens also makes the branch independent of the JS stemmer's language guess:
 * Postgres applies its own stemmer per configured language.
 *
 * Only the characters `websearch_to_tsquery` treats as operators are removed: double quotes
 * (phrases), a leading dash (NOT) and the literal word `or`.
 */
export function buildFullTextOrQuery(original: string, processed: string): string {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const raw of `${original} ${processed}`.split(/\s+/)) {
    const token = raw
      .replace(/["'`]/g, "")
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .replace(/[^\p{L}\p{N}]+$/u, "")
      .toLowerCase();
    if (!token || token === "or" || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens.join(" or ");
}

/**
 * Preprocesses a query by detecting language and applying stemming
 *
 * @param query - The original query string
 * @param options - Preprocessing options
 * @returns Object with original query, detected language, and stemmed query
 */
export function preprocessQuery(
  query: string,
  options: {
    enableStemming?: boolean;
    detectLanguage?: boolean;
    preserveCase?: boolean;
    minDetectionLength?: number;
  } = {},
): {
  original: string;
  processed: string;
  language: string;
  stemmed: boolean;
} {
  const {
    enableStemming = true,
    detectLanguage = true,
    preserveCase = false,
    minDetectionLength = 10,
  } = options;

  // Detect language
  const language = detectLanguage ? detectQueryLanguage(query, minDetectionLength) : "eng";

  console.log(`[EXULU] Query preprocessing - Detected language: ${language} for query: "${query}"`);

  // If stemming is disabled, return as-is
  if (!enableStemming) {
    return {
      original: query,
      processed: query,
      language,
      stemmed: false,
    };
  }

  // Split query into words (preserve structure for semantic search)
  const words = query.split(/\s+/);

  // Stem each word
  const stemmedWords = words.map((word) => {
    const stemmed = stemWord(word, language);

    // Preserve original case if requested
    if (preserveCase && word[0] && word[0] === word[0].toUpperCase()) {
      return stemmed.charAt(0).toUpperCase() + stemmed.slice(1);
    }

    return stemmed;
  });

  const processed = stemmedWords.join(" ");

  console.log(`[EXULU] Query preprocessing - Original: "${query}" → Stemmed: "${processed}"`);

  return {
    original: query,
    processed,
    language,
    stemmed: true,
  };
}

/**
 * Derives the texts the vector search needs from one user query.
 *
 * - `embedText`: the query untouched. Chunks are embedded from their raw content, so the
 *   query vector must come from the raw query as well — embedding the stemmed form compared
 *   "pulsationsdämpf 34 zoll" against "Pulsationsdämpfer 3/4"" and lost the match.
 * - `ftsText`: the stemmed query (kept for the `tsvector` method's keyword extraction).
 * - `hybridOrQuery`: `websearch_to_tsquery` input for the hybrid search's full-text branch.
 */
export function resolveSearchQueryTexts(query: string): {
  embedText: string;
  ftsText: string;
  hybridOrQuery: string;
} {
  const { processed } = preprocessQuery(query, {
    enableStemming: true,
    detectLanguage: true,
  });
  const ftsText = processed || query;
  return {
    embedText: query,
    ftsText,
    hybridOrQuery: buildFullTextOrQuery(query, ftsText),
  };
}
