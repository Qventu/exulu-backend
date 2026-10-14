// src/exulu/claim-check/finish-metadata.ts
//
// The chat's trigger for a claim check, merged onto the SDK `finish` part the
// same way recalledMemoriesMetadata is (spec §5).
//
// Two rules the shape encodes:
//
//  - IDS ONLY. The client already holds the retrieval tool's output — it renders
//    source cards from it — so re-sending the evidence here would double a
//    payload that averages ~89,000 characters per turn. The frontend assembles
//    the `sources[]` array for POST /claims/check from what it already has.
//  - ABSENT, NOT EMPTY. When the check is off, or the viewer may not see it, the
//    fragment is missing entirely. The frontend's rule is "no fragment, no check
//    ever runs", so a present-but-false fragment would be a second state nobody
//    needs.
import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import type { User } from "@EXULU_TYPES/models/user";
import { pipelineConfigFor } from "@EE/claim-check/agent-config";
import { isExternalOrAnonymousUser } from "@SRC/exulu/resolve-max-steps";

/** What the chat needs to post a check: that it may, and what to send. */
export type ClaimCheckTrigger = {
  enabled: true;
  /** Item ids of the chunks this turn retrieved, first-seen order, deduplicated. */
  sourceIds: string[];
  /** The retrieval tool calls those chunks came from, so the client can find them. */
  toolCallIds: string[];
};

/** The retrieval tool is renamed per agent; these are the shapes it ships as. */
const RETRIEVAL_PART_TYPES = new Set(["tool-Context_Search", "tool-Knowledge_context_search"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Item ids and tool-call ids from a turn's retrieval parts; never throws. */
function retrievedIdsOf(toolResults: unknown): { sourceIds: string[]; toolCallIds: string[] } {
  const sourceIds: string[] = [];
  const seen = new Set<string>();
  const toolCallIds: string[] = [];
  if (!Array.isArray(toolResults)) return { sourceIds, toolCallIds };

  for (const part of toolResults) {
    if (!isRecord(part) || typeof part.type !== "string") continue;
    // A renamed retrieval tool still starts with the same prefix shapes; match
    // the known names rather than any tool, so a web search or a memory write
    // never looks like evidence.
    if (!RETRIEVAL_PART_TYPES.has(part.type)) continue;
    const raw = isRecord(part.output) ? part.output.result : undefined;
    if (typeof raw !== "string") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A truncated or offloaded tool output is not a reason to break the
      // turn's finish part. Skip it; with no ids the fragment stays absent.
      continue;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.chunks)) continue;

    let contributed = false;
    for (const chunk of parsed.chunks) {
      if (!isRecord(chunk)) continue;
      const id = typeof chunk.item_id === "string" ? chunk.item_id : undefined;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      sourceIds.push(id);
      contributed = true;
    }
    if (contributed && typeof part.toolCallId === "string") toolCallIds.push(part.toolCallId);
  }

  return { sourceIds, toolCallIds };
}

/** Message metadata fragment merged on the SDK `finish` part (spec §5). */
export function claimCheckMetadata({ agent, user, toolResults }: {
  agent: ExuluAgent;
  user?: User;
  toolResults: unknown;
}): { claimCheck: ClaimCheckTrigger } | Record<string, never> {
  const cfg = pipelineConfigFor(agent).claimCheck;
  if (!cfg.enabled) return {};
  if (!cfg.showToExternalUsers && isExternalOrAnonymousUser(user)) return {};

  const { sourceIds, toolCallIds } = retrievedIdsOf(toolResults);
  // No retrieval, no evidence: a check here would mark every claim unsupported
  // for want of sources, which is a worse answer than no check at all.
  if (sourceIds.length === 0) return {};

  return { claimCheck: { enabled: true, sourceIds, toolCallIds } };
}
