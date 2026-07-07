import type { KbProfile } from "./config";
import { parsePreselectedItems } from "./global-ids";

/** Identity + items of the project attached to the current chat session. */
export type ProjectScope = {
  id: string;
  name: string;
  description?: string;
  customInstructions?: string;
  /** Raw project_items gids: "<contextId>/<itemId>" or bare "<contextId>" (= whole context). */
  items: string[];
  /** Synthesized per-context profile defaults; a stored knowledge_bases profile always wins. */
  kbProfileDefaults?: Record<string, KbProfile>;
};

export type ResolvedProjectScope = {
  /** Contexts the instance already searches in full: project items only BOOST reranking. */
  pinsByContext: Map<string, Set<string>>;
  /** Contexts added for the project: hard item filter (null = whole context). */
  scopedItemsByContext: Map<string, string[] | null>;
  addedContextIds: string[];
  allProjectContextIds: string[];
};

/**
 * Split a project's items into pin vs scoped-source treatment. The invariant:
 * a project may ADD scope but must never NARROW what the agent already searches.
 */
export function resolveProjectScope(opts: {
  scope: ProjectScope | undefined;
  enabledContextIds: Set<string>;
  availableContextIds: Set<string>;
}): ResolvedProjectScope | undefined {
  const { scope, enabledContextIds, availableContextIds } = opts;
  if (!scope || scope.items.length === 0) return undefined;

  const itemsByContext = parsePreselectedItems(scope.items);
  const pinsByContext = new Map<string, Set<string>>();
  const scopedItemsByContext = new Map<string, string[] | null>();
  const addedContextIds: string[] = [];
  const allProjectContextIds: string[] = [];

  for (const [ctxId, itemIds] of itemsByContext) {
    if (!availableContextIds.has(ctxId)) {
      console.warn(
        `[EXULU pipeline] project "${scope.name}" references unknown context "${ctxId}" — skipping those items.`,
      );
      continue;
    }
    allProjectContextIds.push(ctxId);
    if (enabledContextIds.has(ctxId)) {
      if (itemIds && itemIds.length > 0) pinsByContext.set(ctxId, new Set(itemIds));
      // bare-context entry on an already-enabled context adds nothing
    } else {
      scopedItemsByContext.set(ctxId, itemIds);
      addedContextIds.push(ctxId);
    }
  }

  if (allProjectContextIds.length === 0) return undefined;
  return { pinsByContext, scopedItemsByContext, addedContextIds, allProjectContextIds };
}

const TRANSCRIPTIONS_CONTEXT_ID = "transcriptions";

/** Kind heuristic for auto-configured project sources (design spec §7.3). */
export function buildProjectKbProfileDefaults(items: string[]): Record<string, KbProfile> {
  const defaults: Record<string, KbProfile> = {};
  for (const gid of items) {
    const slashIdx = gid.indexOf("/");
    const ctxId = slashIdx === -1 ? gid : gid.slice(0, slashIdx);
    if (ctxId === TRANSCRIPTIONS_CONTEXT_ID && !defaults[ctxId]) {
      defaults[ctxId] = { enabled: true, kind: "conversations", instructions: "", overrides: {} };
    }
  }
  return defaults;
}
