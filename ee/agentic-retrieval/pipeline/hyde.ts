import { microCall } from "./micro-call";
import { extractIdentifierTokens } from "./text-utils";

// Per-question memoization of the HyDE passage. A single search invokes
// generateHydePassage several times with the same question, so without this we would pay
// one LLM call per invocation. The PROMISE is cached (not just the resolved value) so
// concurrent invocations within one request share a single generation. A failed/empty
// result is evicted so a transient blip does not disable HyDE for that question.
// FIFO-capped to bound memory.
const hydeCache = new Map<string, Promise<string | null>>();
const HYDE_CACHE_MAX = 200;

function hydeCacheKey(
  originalQuestion: string,
  relevantKeywords: string[],
  styleHint: string,
  importantKeyword?: string,
): string {
  return JSON.stringify([originalQuestion, importantKeyword ?? "", relevantKeywords, styleHint]);
}

/**
 * HyDE (Hypothetical Document Embeddings): generate a short passage that answers the
 * question in the style and vocabulary of the knowledge base. Embedding this passage
 * bridges the gap between the user's wording and the document's wording, which is what
 * lets the relevant chunk enter the candidate pool at all.
 *
 * Returns null on any failure (incl. no model) so the caller degrades gracefully.
 * Memoized per question (see hydeCache).
 */
export function generateHydePassage({
  originalQuestion,
  relevantKeywords,
  importantKeyword,
  styleHint,
  model,
}: {
  originalQuestion: string;
  relevantKeywords: string[];
  importantKeyword?: string;
  styleHint: string;
  model: any;
}): Promise<string | null> {
  if (!model) return Promise.resolve(null);

  const key = hydeCacheKey(originalQuestion, relevantKeywords, styleHint, importantKeyword);
  const cached = hydeCache.get(key);
  if (cached) return cached;

  const passagePromise = generateHydePassageUncached({
    originalQuestion,
    relevantKeywords,
    importantKeyword,
    styleHint,
    model,
  })
    .then((passage) => {
      // Don't persist failures/empties — allow a retry on the next call.
      if (passage === null) hydeCache.delete(key);
      return passage;
    })
    .catch((e) => {
      console.warn("[EXULU] HyDE passage generation failed, skipping:", e);
      hydeCache.delete(key);
      return null;
    });

  if (hydeCache.size >= HYDE_CACHE_MAX) {
    const oldest = hydeCache.keys().next().value;
    if (oldest !== undefined) hydeCache.delete(oldest);
  }
  hydeCache.set(key, passagePromise);
  return passagePromise;
}

export function clearHydeCache(): void {
  hydeCache.clear();
}

async function generateHydePassageUncached({
  originalQuestion,
  relevantKeywords,
  importantKeyword,
  styleHint,
  model,
}: {
  originalQuestion: string;
  relevantKeywords: string[];
  importantKeyword?: string;
  styleHint: string;
  model: any;
}): Promise<string | null> {
  const modelHint =
    importantKeyword ||
    extractIdentifierTokens([importantKeyword, ...relevantKeywords, originalQuestion])[0] ||
    "";

  let prompt = `You are a technical writer producing content in the style of this organization's knowledge base.${
    styleHint ? `\nThe documents look like this: ${styleHint}` : ""
  }
Write a SHORT hypothetical passage (3-6 sentences) that answers the question below the way the
original document would state it — using the domain's typical terminology (menu paths, parameters,
codes, section names). Write in the same language as the question.
`;

  if (modelHint) {
    prompt += `
IMPORTANT:
- Refer exactly to the mentioned product/model: "${modelHint}". Mention this exact designation and NO other variant.
- Invent plausible, domain-appropriate terms and structure; factual accuracy is not required — the text is only a search anchor.
- Output ONLY the passage, no preamble, no markdown.
`;
  } else {
    prompt += `
IMPORTANT:
- Invent plausible, domain-appropriate terms and structure; factual accuracy is not required — the text is only a search anchor.
- Output ONLY the passage, no preamble, no markdown.
`;
  }

  prompt += `
Question: "${originalQuestion}"
Relevant keywords: ${relevantKeywords.join(", ")}`;

  // Single attempt on purpose: HyDE is an optional search anchor with a null
  // fallback and per-question cache eviction on failure — retry backoff here
  // would delay every search phase behind it.
  const { text } = await microCall({
    model,
    prompt,
    temperature: 0.3,
    maxAttempts: 1,
  });
  const passage = (text || "").trim();
  return passage.length > 0 ? passage : null;
}
