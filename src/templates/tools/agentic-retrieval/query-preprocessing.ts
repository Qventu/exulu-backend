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

  // Remove punctuation and normalize
  const cleaned = word.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

  if (!cleaned) {
    return word;
  }

  try {
    return stemmer.stem(cleaned);
  } catch (error) {
    console.warn(`[EXULU] Error stemming word "${word}":`, error);
    return cleaned;
  }
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
