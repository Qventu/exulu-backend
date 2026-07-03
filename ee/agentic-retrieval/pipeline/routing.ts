import { generateText, Output } from "ai";
import { z } from "zod";
import { withRetry } from "@SRC/utils/with-retry";
import { fuzzyPrefilter } from "./prefilter";
import { normalizeFileName } from "./text-utils";
import type { RoutingRule } from "./config";
import type { RoutingPhaseResult, PhaseStep } from "./types";

const PROMPT_CHECK_FOR_DOC_AND_PAGE_REFERENCES = `
You are checking whether the user's question explicitly references a specific
document (by filename or distinctive filename fragment) and/or a specific page number.

Filename hints: things like "manual_v4.2.de.pdf", "HB_PAM-E4",
"installation guide model X3". Return them as bare names
without folder paths. Do NOT include generic product names on their own —
those are handled by a different step.

Page hints: explicit page references like "page 38", "p. 38", "Seite 38".
Only set pageNumber when the user names a specific page.

Return hasFilenameHint/hasPageHint false (and omit the hint fields) when neither
is present.
`;

export async function runRoutingPhase(opts: {
  question: string;
  enabledContexts: Array<{ id: string; name: string; description?: string }>;
  documentContexts: any[];
  routingRules: RoutingRule[];
  preselectedItems: Map<string, string[] | null>;
  extraInstructions?: string;
  model: any;
}): Promise<RoutingPhaseResult> {
  const {
    question,
    enabledContexts,
    documentContexts,
    routingRules,
    preselectedItems,
    extraInstructions,
    model,
  } = opts;

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

  // Build dynamic explicit-KB prompt from enabled contexts
  const kbSystemPrompt =
    `You are a helpful assistant that checks if the user has EXPLICITLY asked you to search in one or multiple of the following knowledge bases:\n` +
    enabledContexts
      .map((c) => `- ${c.id}: ${c.name}${c.description ? " — " + c.description : ""}`)
      .join("\n") +
    `\nIf so, return the knowledge base names. If not, return an empty array.`;

  // --- Phase 1: parallel doc/page detection + explicit-KB detection ---

  const [docPageRaw, explicitKBRaw] = await Promise.all([
    (async () => {
      try {
        return await withRetry(
          () =>
            generateText({
              model,
              temperature: 0,
              system: PROMPT_CHECK_FOR_DOC_AND_PAGE_REFERENCES,
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

    steps.push({
      text:
        totalMatched > 0
          ? `User referenced specific document(s); pinning ${totalMatched} file(s): ${matchedNames.join(", ")}`
          : `User referenced document(s) ${hints.join(", ")} but no matching file was found.`,
    });
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
}
