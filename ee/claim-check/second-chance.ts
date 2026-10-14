// ee/claim-check/second-chance.ts
//
// One targeted retrieval per unsupported claim (spec decision 2). The point is
// to tell "the model made this up" apart from "true, but from a passage the
// answer was never shown" — so this only exists for callers with an agent
// scope. External callers bring their own sources and have nothing to search.
import type { LanguageModel } from "ai";
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "@SRC/exulu/context";
import { searchContexts } from "@EE/agentic-retrieval/pipeline/search";
import { parsePipelineConfig } from "@EE/agentic-retrieval/pipeline/config";
import { toolConfigOf, hasNoToolConfig } from "./agent-config";
import { indexSources, selectEvidence } from "./evidence";
import type { EvidenceSnippet } from "./types";

const MAX_SNIPPETS_PER_CLAIM = 4;

export function makeSecondChance(args: {
  agent: any;
  user?: User;
  role?: string;
  model: LanguageModel;
  contexts: ExuluContext[];
  cap: number;
}): ((claimText: string) => Promise<EvidenceSnippet[]>) | undefined {
  const raw = toolConfigOf(args.agent);
  if (hasNoToolConfig(raw)) return undefined;

  const cfg = parsePipelineConfig(raw);
  const enabled = args.contexts.filter((c) => cfg.knowledgeBases[c.id]?.enabled !== false);
  if (enabled.length === 0) return undefined;

  const contextsById = new Map(enabled.map((c) => [c.id, c]));
  const contextIds = enabled.map((c) => c.id);
  let spent = 0;

  return async (claimText: string): Promise<EvidenceSnippet[]> => {
    if (spent >= args.cap) return [];
    spent += 1;

    try {
      const { chunks } = await searchContexts({
        contextIds,
        contextsById,
        kbProfiles: cfg.knowledgeBases,
        // The claim IS the query: it is already standalone and decontextualized,
        // which is what the extraction stages were for.
        question: claimText,
        keywords: [],
        importantKeyword: "",
        user: args.user,
        role: args.role,
        model: args.model,
        preselectedItems: new Map(),
        identifierPinsByContext: new Map(),
        memoryPinnedItemIdsByContext: new Map(),
        userPinnedItemIdsByContext: new Map(),
        rewrites: cfg.vocabulary.rewrites,
        styleHint: cfg.vocabulary.styleHint,
        maxQueries: 1,
        skipPrefilter: true,
      });

      if (chunks.length === 0) return [];

      const passages = indexSources(
        chunks.map((c: any) => ({
          id: String(c.item_id ?? c.chunk_id),
          name: c.item_name,
          content: String(c.chunk_content ?? ""),
        })),
      );
      return selectEvidence([claimText], passages, MAX_SNIPPETS_PER_CLAIM);
    } catch (err) {
      // A failed second chance must never change a verdict or fail the check.
      console.warn("[EXULU claim-check] second-chance retrieval failed:", err);
      return [];
    }
  };
}
