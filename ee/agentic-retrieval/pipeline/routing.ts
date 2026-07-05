import { generateText, Output } from "ai";
import { z } from "zod";
import { withRetry } from "@SRC/utils/with-retry";
import { fuzzyPrefilter } from "./prefilter";
import { normalizeFileName } from "./text-utils";
import type { RoutingRule } from "./config";
import type { RoutingPhaseResult, PhaseStep } from "./types";

/** A genuine document reference resolves to a handful of files. When the fuzzy match
 * returns more than this many, the "hint" was really a product/topic token (e.g. a model
 * name matching 30 brochures/certificates) — pinning all of them replaces the product
 * prefilter with paperwork, force-includes every pin past topK in the rerank, and blows
 * the tool output up by hundreds of thousands of tokens (observed in the newlkiag
 * migration smoke test: 4 retries × ~35 pinned chunk-groups ≈ 1.8M tokens). */
const MAX_USER_PIN_MATCHES = 8;

const buildDocPagePrompt = (knownIdentifiers: string[]) => `
You are checking whether the user's question explicitly references a specific
document (by filename or distinctive filename fragment) and/or a specific page number.

Filename hints: things like "manual_v4.2.de.pdf", "HB_PAM-E4",
"installation guide model X3". Return them as bare names
without folder paths.

STRICT RULE: only report a filename hint when the reference carries a document marker —
a file extension (.pdf, .docx, …), a filename-like pattern (underscores/version tags like
"hb_X_2023"), or wording that names a document ("im Dokument X", "im Handbuch Y",
"in the X manual/guide"). A bare product, model, or component designation is NOT a
filename hint, even when files about it exist — product terms are handled by a
different step.${
  knownIdentifiers.length > 0
    ? `\nKnown product/model designations that must NOT be treated as filenames on their own: ${knownIdentifiers.join(", ")}.`
    : ""
}

Page hints: explicit page references like "page 38", "p. 38", "Seite 38".
Only set pageNumber when the user names a specific page.

Return hasFilenameHint/hasPageHint false (and omit the hint fields) when neither
is present. When in doubt, return false.
`;

export async function runRoutingPhase(opts: {
  question: string;
  enabledContexts: Array<{ id: string; name: string; description?: string }>;
  documentContexts: any[];
  routingRules: RoutingRule[];
  preselectedItems: Map<string, string[] | null>;
  extraInstructions?: string;
  /** Example product/model designations from the configured identifier vocabularies —
   * injected into the doc-reference prompt so they are never mistaken for filenames. */
  knownIdentifiers?: string[];
  model: any;
}): Promise<RoutingPhaseResult> {
  const {
    question,
    enabledContexts,
    documentContexts,
    routingRules,
    preselectedItems,
    extraInstructions,
    knownIdentifiers = [],
    model,
  } = opts;

  try {
  const steps: PhaseStep[] = [];
  const enabledIds = new Set(enabledContexts.map((c) => c.id));

  // Early exit: no contexts → skip all LLM calls
  if (enabledContexts.length === 0) {
    return {
      mainContexts: [],
      fallbackContexts: [],
      userPinnedItemIdsByContext: new Map(),
      userRequestedPage: null,
      hasExplicitDocAndPage: false,
      steps,
    };
  }

  // Build dynamic explicit-KB prompt from enabled contexts.
  // The listing includes names/descriptions so "search the tickets" can resolve to the
  // right id — but that makes topical false positives easy (a question ABOUT software
  // matching the software-docs KB), and an explicit match zeroes the fallback list. The
  // strictness paragraph below exists because exactly that misfire suppressed fallback
  // retrieval during the newlkiag migration gate.
  const kbSystemPrompt =
    `You are a helpful assistant that checks if the user has EXPLICITLY asked you to search in one or multiple of the following knowledge bases:\n` +
    enabledContexts
      .map((c) => `- ${c.id}: ${c.name}${c.description ? " — " + c.description : ""}`)
      .join("\n") +
    `\nEXPLICIT means the user names a knowledge base or clearly commands searching a` +
    ` specific source (e.g. "search in the tickets", "look this up in the manuals KB").` +
    ` A question that merely CONCERNS a topic related to a knowledge base's name or` +
    ` contents (e.g. asking about software changes, norms, or a product) is NOT an` +
    ` explicit request — classification routing handles those. When in doubt, return` +
    ` an empty array.` +
    `\nIf explicit, return the knowledge base ids. If not, return an empty array.`;

  // --- Phase 1: parallel doc/page detection + explicit-KB detection ---

  const [docPageRaw, explicitKBRaw] = await Promise.all([
    (async () => {
      try {
        return await withRetry(
          () =>
            generateText({
              model,
              temperature: 0,
              system: buildDocPagePrompt(knownIdentifiers),
              messages: [{ role: "user", content: question }],
              output: Output.object({
                schema: z.object({
                  hasFilenameHint: z.boolean(),
                  filenameHints: z.array(z.string()).optional(),
                  hasPageHint: z.boolean(),
                  pageNumber: z.number().int().nullable().optional(),
                }),
              }),
              maxOutputTokens: 300,
            }),
          3,
        );
      } catch (err) {
        steps.push({ text: "Doc/page detection failed — skipping filename and page hints." });
        return {
          output: {
            hasFilenameHint: false,
            filenameHints: [] as string[],
            hasPageHint: false,
            pageNumber: null as number | null,
          },
        };
      }
    })(),
    (async () => {
      try {
        return await withRetry(
          () =>
            generateText({
              model,
              temperature: 0,
              system: kbSystemPrompt,
              output: Output.object({
                schema: z.object({
                  explicitlyRequestedKnowledgeBases: z.array(
                    z.enum(enabledContexts.map((c) => c.id) as [string, ...string[]]),
                  ),
                }),
              }),
              messages: [{ role: "user", content: question }],
              maxOutputTokens: 200,
            }),
          3,
        );
      } catch (err) {
        return { output: { explicitlyRequestedKnowledgeBases: [] as string[] } };
      }
    })(),
  ]);

  // --- Phase 2: resolve filename hints across all document contexts ---

  const userPinnedItemIdsByContext = new Map<string, Set<string>>();
  let userRequestedPage: number | null = null;

  if (docPageRaw.output.hasFilenameHint && docPageRaw.output.filenameHints?.length) {
    try {
      const hints = docPageRaw.output.filenameHints;

      const contextMatches = await Promise.all(
        documentContexts.map(async (ctx) => {
          const matches = await fuzzyPrefilter({
            cacheKey: "routing:" + ctx.id,
            relevantKeywords: hints,
            context: ctx,
            fields: ["name", "id", "external_id"],
            normalize: (item: any) =>
              item.external_id ? normalizeFileName(item.external_id) : item.name,
          });
          return { ctxId: ctx.id as string, matches };
        }),
      );

      let totalMatched = 0;
      const matchedNames: string[] = [];

      for (const { ctxId, matches } of contextMatches) {
        if (matches.length > 0) {
          userPinnedItemIdsByContext.set(ctxId, new Set(matches.map((m: any) => m.id)));
          totalMatched += matches.length;
          matchedNames.push(...matches.map((m: any) => m.name));
        }
      }

      // Plausibility cap: a real document reference matches a few files (language/version
      // variants). A hint that fans out wider was a product/topic token — discard the pins
      // and let the normal prefilter/routing handle it.
      if (totalMatched > MAX_USER_PIN_MATCHES) {
        userPinnedItemIdsByContext.clear();
        steps.push({
          text: `Reference "${hints.join(", ")}" matched ${totalMatched} files — too broad for a specific document reference; continuing without file pins.`,
        });
        totalMatched = 0;
      } else {
        steps.push({
          text:
            totalMatched > 0
              ? `User referenced specific document(s); pinning ${totalMatched} file(s): ${matchedNames.join(", ")}`
              : `User referenced document(s) ${hints.join(", ")} but no matching file was found.`,
        });
      }
    } catch (err) {
      console.warn("[EXULU pipeline] Document reference resolution failed:", err);
      steps.push({ text: "Document reference resolution failed — continuing without file pins." });
    }
  }

  if (
    docPageRaw.output.hasPageHint &&
    typeof docPageRaw.output.pageNumber === "number"
  ) {
    userRequestedPage = docPageRaw.output.pageNumber;
    steps.push({
      text: `User referenced specific page ${userRequestedPage}; results will be filtered to chunks on or adjacent to that page.`,
    });
  }

  const hasExplicitDocAndPage =
    userPinnedItemIdsByContext.size > 0 && userRequestedPage !== null;

  // --- Phase 3: context selection (precedence: explicit > preselected > rules > implicit) ---

  let mainContexts: string[] = [];
  let fallbackContexts: string[] = [];

  const explicitKBs = explicitKBRaw.output.explicitlyRequestedKnowledgeBases;

  if (explicitKBs.length > 0) {
    // Explicit KB wins — no fallback
    mainContexts = explicitKBs.filter((id) => enabledIds.has(id));
    fallbackContexts = [];
    steps.push({
      text:
        "The user has explicitly requested to search in the following knowledge bases: " +
        explicitKBs.join(", "),
    });
  } else if (preselectedItems.size > 0) {
    // Preselected items win
    mainContexts = Array.from(preselectedItems.keys()).filter((id) => enabledIds.has(id));
    fallbackContexts = [];
    steps.push({
      text:
        "The user has requested to search in the following knowledge bases: " +
        mainContexts.join(", "),
    });
  } else if (routingRules.length > 0) {
    // Rule-based classification
    const ruleIds = routingRules.map((r) => r.id);
    const rulesLines = routingRules
      .map((r) => `- ${r.id} (${r.label}): ${r.description}`)
      .join("\n");
    let classifyPrompt = `You are a helpful assistant that classifies user requests.\n\n${rulesLines}`;
    if (extraInstructions) {
      classifyPrompt += `\n<instructions>\n${extraInstructions}\n</instructions>`;
    }

    try {
      const { output: classified } = await withRetry(
        () =>
          generateText({
            model,
            temperature: 0,
            system: classifyPrompt,
            messages: [{ role: "user", content: question }],
            output: Output.object({
              schema: z.object({
                ruleId: z.enum(ruleIds as [string, ...string[]]),
                reason: z.string(),
              }),
            }),
            maxOutputTokens: 200,
          }),
        3,
      );

      const matchedRule = routingRules.find((r) => r.id === classified.ruleId);
      if (matchedRule) {
        const main = matchedRule.main.filter((id) => enabledIds.has(id));
        const fallback = matchedRule.fallback.filter(
          (id) => enabledIds.has(id) && !main.includes(id),
        );
        mainContexts = main;
        fallbackContexts = fallback;
        steps.push({
          text: `Classified the request as: ${classified.ruleId} because: ${classified.reason}`,
        });
        steps.push({
          text: `Main contexts: ${mainContexts.join(", ")}, Fallback contexts: ${fallbackContexts.join(", ")}`,
        });
      } else {
        // Unknown ruleId → implicit all-main
        mainContexts = enabledContexts.map((c) => c.id);
        fallbackContexts = [];
        steps.push({
          text: "Classification returned unknown rule — using implicit all-main rule.",
        });
      }
    } catch (err) {
      // Classification failed → implicit all-main (degraded)
      mainContexts = enabledContexts.map((c) => c.id);
      fallbackContexts = [];
      steps.push({
        text: "Classification failed — using implicit all-main rule (degraded).",
      });
    }
  } else {
    // No rules → implicit all-main
    mainContexts = enabledContexts.map((c) => c.id);
    fallbackContexts = [];
  }

  return {
    mainContexts,
    fallbackContexts,
    userPinnedItemIdsByContext,
    userRequestedPage,
    hasExplicitDocAndPage,
    steps,
  };
  } catch (err) {
    console.warn("[EXULU pipeline] runRoutingPhase failed:", err);
    return {
      mainContexts: enabledContexts.map((c) => c.id),
      fallbackContexts: [],
      userPinnedItemIdsByContext: new Map(),
      userRequestedPage: null,
      hasExplicitDocAndPage: false,
      steps: [{ text: "Routing failed — searching all enabled knowledge bases." }],
    };
  }
}
