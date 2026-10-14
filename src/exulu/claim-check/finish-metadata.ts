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
import type { RecallCollector } from "@SRC/exulu/memory/recall-collector";
import { pipelineConfigFor } from "@EE/claim-check/agent-config";
import { isExternalOrAnonymousUser } from "@SRC/exulu/resolve-max-steps";
import { AGENTIC_RETRIEVAL_TOOL_NAME } from "@EE/agentic-retrieval/pipeline/index";
import { SESSION_ITEMS_RETRIEVAL_TOOL_NAME } from "@SRC/templates/tools/session-items-retrieval-tool";
import { SESSION_FILE_READ_TOOL_NAME } from "@SRC/templates/tools/session-file-read-tool";
import { PARSE_DOCUMENT_TOOL_NAME } from "@SRC/templates/tools/parse-document-tool";
import { VIEW_DOCUMENT_PAGE_TOOL_NAME } from "@SRC/templates/tools/view-document-page-tool";
import { INTERNET_SEARCH_TOOL_NAME } from "@SRC/templates/tools/perplexity";
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

/**
 * The rest of the same class (spec §5): tools whose output is evidence the
 * model reads and this fragment cannot represent, because `sourceIds` can
 * only name knowledge-base item ids and the frontend assembles `sources[]`
 * from retrieval chunks alone.
 *
 * All four are reachable on the same turn as agentic retrieval, and the first
 * three need no agent opt-in at all — `read_session_file`, `parse_document`
 * and `view_document_page` are registered for EVERY session once
 * `fileUploads.s3Bucket` is configured. A turn that reads a PDF and also
 * calls Context Search would otherwise emit a fragment covering the retrieval
 * half only, and every PDF-grounded claim would come back `unsupported` —
 * `score.ts` puts `unsupported` in the numerator of the label share, so the
 * panel renders an alert for an answer that was fully grounded in the user's
 * own document. §2.4's honesty invariants exist to prevent exactly that, and
 * a missing panel is the safe failure.
 *
 * Unlike session-items above there is no "proven empty" shape to exempt: each
 * of these returns prose, bytes or an image, so the only honest reading of a
 * call is "the model may have used it". Presence of the part suppresses.
 *
 * Each part type is derived from the tool's own exported display-name literal
 * (never a second hardcoded spelling), so a rename fails this module's test
 * suite instead of silently turning the suppression off.
 */
export const INVISIBLE_EVIDENCE_PART_TYPES = new Set([
  `tool-${sanitizeToolName(SESSION_FILE_READ_TOOL_NAME)}`,
  `tool-${sanitizeToolName(PARSE_DOCUMENT_TOOL_NAME)}`,
  `tool-${sanitizeToolName(VIEW_DOCUMENT_PAGE_TOOL_NAME)}`,
  `tool-${sanitizeToolName(INTERNET_SEARCH_TOOL_NAME)}`,
]);

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

/** True when any part of this turn came from a tool in the class above. */
function invisibleEvidenceToolRan(toolResults: unknown): boolean {
  if (!Array.isArray(toolResults)) return false;
  return toolResults.some(
    (part) => isRecord(part) && typeof part.type === "string" && INVISIBLE_EVIDENCE_PART_TYPES.has(part.type),
  );
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

/**
 * True when any message of this turn's prompt carries a `file` part.
 *
 * This is the attachment half of the same class. `processFilePartsInMessages`
 * (src/exulu/generate-stream.ts) runs over the WHOLE message array — loaded
 * history plus the new message — and replaces each attached document's
 * `file` part with a `text` part holding the extracted text, inline in the
 * user message. So by the time the model answers, a PDF's contents are
 * indistinguishable from text the user typed, and nothing in the assistant's
 * parts records that a document was read.
 *
 * The pre-inlining `file` part is therefore the only signal that cannot be
 * confused with ordinary typed text: it is a structured part type the client
 * emits for an actual upload, where the markers the inlining leaves behind
 * (the `<file file name = "…">` wrapper, or an `[Error extracting text from
 * file …]` string) are plain text any user could type verbatim.
 *
 * Both kinds of `file` part count. An image part survives inlining unchanged
 * and is read by the model directly; a document part becomes inline text.
 * Either way the check never sees it.
 *
 * Reading the whole array rather than only the last message is deliberate: a
 * document attached three turns ago is re-inlined into every later prompt, so
 * it can still ground this turn's answer. The cost is that compaction may
 * have dropped it from the model's view while it is still in the array — that
 * errs towards silence, which is the safe direction.
 */
export function turnCarriedFileAttachment(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (isRecord(part) && part.type === "file") return true;
    }
  }
  return false;
}

/** Message metadata fragment merged on the SDK `finish` part (spec §5). */
export function claimCheckMetadata({ agent, user, isGuest, toolResults, messages, recall }: {
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
  /**
   * This turn's prompt messages **before** file-part inlining — pass
   * `[...result.previousMessages, message]` from the chat route.
   * `result.originalMessages` is the post-inlining view and cannot be used:
   * by then every attached document is a text part (see
   * turnCarriedFileAttachment). Explicitly passed rather than read from a
   * global so this function stays pure.
   */
  messages: unknown;
  /**
   * The turn's memory recall, same object `recalledMemoriesMetadata` gets.
   * Undefined when the agent has no memory base.
   */
  recall: Pick<RecallCollector, "list"> | undefined;
}): { claimCheck: ClaimCheckTrigger } | Record<string, never> {
  const cfg = pipelineConfigFor(agent).claimCheck;
  if (!cfg.enabled) return {};
  if ((isGuest || isExternalOrAnonymousUser(user)) && !cfg.showToExternalUsers) return {};
  if (invisibleEvidenceToolRan(toolResults)) return {};
  if (sessionItemsContributed(toolResults)) return {};
  if (turnCarriedFileAttachment(messages)) return {};
  // A recalled memory reaches the model through the SYSTEM prompt
  // (generate-stream.ts → memoryRecall.promptBlock), never through a tool
  // result, so the check cannot be given it and a claim resting on one scores
  // `unsupported`. Non-empty recall therefore suppresses — the same emptiness
  // test recalledMemoriesMetadata applies one line above the call site.
  if ((recall?.list().length ?? 0) > 0) return {};

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
