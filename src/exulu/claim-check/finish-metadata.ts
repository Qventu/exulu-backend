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
import { AGENTIC_RETRIEVAL_TOOL_NAME } from "@EE/agentic-retrieval/pipeline/index";
import { SESSION_ITEMS_RETRIEVAL_TOOL_NAME } from "@SRC/templates/tools/session-items-retrieval-tool";
import { sanitizeToolName } from "@SRC/utils/sanitize-tool-name";

/** What the chat needs to post a check: that it may, and what to send. */
export type ClaimCheckTrigger = {
  enabled: true;
  /** Item ids of the chunks this turn retrieved, first-seen order, deduplicated. */
  sourceIds: string[];
  /**
   * The retrieval tool calls that introduced at least one NEW source id this
   * turn — not "every call that ran", and not "every call whose evidence is
   * in sourceIds". A call whose chunks all duplicated an earlier call's is
   * folded into sourceIds above but omitted here.
   */
  toolCallIds: string[];
};

/**
 * The retrieval tool is renamed per agent in the UI, but the AI-SDK tool key
 * — and so the `tool-${...}` part type this module matches on — is derived
 * from the one display-name literal the tool factory registers
 * (`AGENTIC_RETRIEVAL_TOOL_NAME`). Deriving it here instead of hardcoding a
 * second copy of the sanitized string means a rename of that literal fails
 * this module's own test suite instead of silently turning the feature off.
 */
export const RETRIEVAL_PART_TYPES = new Set([`tool-${sanitizeToolName(AGENTIC_RETRIEVAL_TOOL_NAME)}`]);

/**
 * The session-attached-items search tool runs alongside agentic retrieval on
 * any session with items attached, but its output has no `chunks` key, so it
 * can never contribute source ids here. When it DID return something this
 * turn, part of the answer may be grounded in evidence this fragment cannot
 * see — checking anyway would score that part as unsupported and raise a
 * false hallucination alarm. Follow-up (out of scope here): teach this module
 * — and the frontend's `collectSources` — a second output-shape handler for
 * session-items evidence so it can be included instead of suppressed.
 */
const SESSION_ITEMS_PART_TYPE = `tool-${sanitizeToolName(SESSION_ITEMS_RETRIEVAL_TOOL_NAME)}`;

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
    // Only a call that introduced a NEW id is recorded — see ClaimCheckTrigger's
    // toolCallIds doc comment.
    if (contributed && typeof part.toolCallId === "string") toolCallIds.push(part.toolCallId);
  }

  return { sourceIds, toolCallIds };
}

/**
 * True when the session-items tool ran this turn and may have contributed
 * evidence this fragment cannot represent: a non-empty array, or an output
 * this function could not parse at all. A parse failure counts as "produced
 * something" — the safe failure is suppressing the fragment, not running a
 * check against evidence we failed to read.
 */
function sessionItemsContributed(toolResults: unknown): boolean {
  if (!Array.isArray(toolResults)) return false;

  for (const part of toolResults) {
    if (!isRecord(part) || part.type !== SESSION_ITEMS_PART_TYPE) continue;
    const raw = isRecord(part.output) ? part.output.result : undefined;
    if (typeof raw !== "string") continue;

    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return true;
      // A cleanly-parsed empty array is proven empty — nothing to suppress for.
    } catch {
      return true;
    }
  }

  return false;
}

/** Message metadata fragment merged on the SDK `finish` part (spec §5). */
export function claimCheckMetadata({ agent, user, isGuest, toolResults }: {
  agent: ExuluAgent;
  user?: User;
  /**
   * Whether this request gets guest treatment — pass `treatAsGuest(req, user)`,
   * the same expression `recalledMemoriesMetadata` uses one line above this
   * call. A signed-in user on the public surface renders in guest mode, so
   * the external-visibility gate below must see them as external too, not
   * just an anonymous caller.
   */
  isGuest: boolean;
  toolResults: unknown;
}): { claimCheck: ClaimCheckTrigger } | Record<string, never> {
  const cfg = pipelineConfigFor(agent).claimCheck;
  if (!cfg.enabled) return {};
  if ((isGuest || isExternalOrAnonymousUser(user)) && !cfg.showToExternalUsers) return {};
  if (sessionItemsContributed(toolResults)) return {};

  const { sourceIds, toolCallIds } = retrievedIdsOf(toolResults);
  // No retrieval, no evidence: a check here would mark every claim unsupported
  // for want of sources, which is a worse answer than no check at all.
  if (sourceIds.length === 0) return {};

  return { claimCheck: { enabled: true, sourceIds, toolCallIds } };
}

/**
 * Append one turn's retrieval tool-result stream part onto the accumulator
 * `routes.ts` builds as the SDK's raw stream flows past `messageMetadata` —
 * the only hook with access to tool outputs before the `finish` part needs
 * them (see the comment beside `turnToolResults` there). A streaming tool's
 * intermediate yields arrive tagged `preliminary: true`; only the final one
 * is kept, so each call contributes exactly one entry.
 *
 * Exported and unit-tested on its own because it is the half of this feature
 * that depends on the raw AI-SDK stream shape rather than the assembled
 * UIMessage shape the rest of this module tests against — a shape a provider
 * or AI-SDK upgrade could change without a type error.
 */
export function recordToolResult(
  acc: { type: string; toolCallId: string; output: unknown }[],
  part: { type: string; toolName?: unknown; toolCallId?: unknown; output?: unknown; preliminary?: unknown },
): void {
  if (part.type !== "tool-result" || part.preliminary) return;
  if (typeof part.toolName !== "string" || typeof part.toolCallId !== "string") return;
  acc.push({ type: `tool-${part.toolName}`, toolCallId: part.toolCallId, output: part.output });
}
