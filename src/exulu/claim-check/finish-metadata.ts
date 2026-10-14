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
import type { User } from "@EXULU_TYPES/models/user";
import type { RecallCollector } from "@SRC/exulu/memory/recall-collector";
import type { ClaimCheckConfig } from "@EE/agentic-retrieval/pipeline/config";
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
 * evidence this fragment cannot represent.
 *
 * The only shape that does NOT suppress is a cleanly-parsed EMPTY ARRAY:
 * that is proof the tool found nothing, and proven-empty is proven harmless.
 * Everything else counts as contributed — "cannot prove it empty" is not
 * "empty":
 *
 *  - An **offloaded** result. This tool is not in
 *    `OUTPUT_OFFLOAD_EXEMPT_TOOL_IDS`, so `guardToolOutput` replaces a large
 *    output with `{ truncated, notice, preview }` and there is no `result`
 *    key at all. Skipping that (the previous `continue`) meant this tool's
 *    LARGEST results — the ones most likely to have grounded the answer —
 *    were precisely the ones that failed to suppress.
 *  - A `result` that is not a string, a payload that does not parse, or one
 *    that parses to anything other than an array.
 */
function sessionItemsContributed(toolResults: unknown): boolean {
  if (!Array.isArray(toolResults)) return false;

  for (const part of toolResults) {
    if (!isRecord(part) || part.type !== SESSION_ITEMS_PART_TYPE) continue;
    const raw = isRecord(part.output) ? part.output.result : undefined;
    if (typeof raw !== "string") return true;

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length > 0) return true;
    } catch {
      return true;
    }
  }

  return false;
}

/**
 * The exact prefix `processFilePartsInMessages` wraps an extracted document's
 * text in (src/exulu/generate-stream.ts:140,
 * `` `<file file name = "${filename}" >\n…` ``). Spelled with its real, odd
 * spacing on purpose: it is matched, not rendered, and it is produced in that
 * one place only.
 */
const INLINED_DOCUMENT_MARKER = '<file file name = "';

/**
 * True when this turn's prompt carried an attached file — the attachment half
 * of the invisible-evidence class.
 *
 * Two signals, because a document's attachment leaves two different traces and
 * only one of them survives a turn:
 *
 *  1. **A `file` part.** `processFilePartsInMessages` replaces a document's
 *     `file` part with a `text` part holding the extracted text, and leaves an
 *     IMAGE part as a `file` part. So on the turn of the upload itself both
 *     kinds are visible here as `file` parts, and an image stays visible for
 *     the life of the session.
 *  2. **The inlining wrapper, in a user `text` part.** A document's `file`
 *     part never reaches the database: generateStream returns the
 *     POST-inlining array as `originalMessages` (:1096), the SDK composes
 *     onFinish's `messages` from it, and the chat route persists exactly those
 *     rows. The stored user message therefore holds
 *     `<file file name = "wartung.pdf" >…</file>` as TEXT. On every follow-up
 *     question in that session the loaded history contains no `file` part at
 *     all, while the document's extracted text is still in the prompt — which
 *     is C1's exact failure mode (an answer grounded in the user's own PDF,
 *     scored against the retrieval chunks alone, rendered as an alert).
 *     Keying on the wrapper is what closes it.
 *
 * The wrapper is ordinary text, so a user who types that prefix into a chat
 * loses claim checking for that session. That is the deliberate trade: spec
 * §5's rule is that the fragment stays absent when in doubt, and a lost panel
 * for a bizarre message beats telling someone their correct answer was
 * unfounded. Only USER messages are checked for it — it is produced on user
 * messages alone, and restricting it there keeps an assistant that quotes the
 * string from counting as evidence it never saw.
 *
 * The extraction FAILURE markers (`[Error: Could not load file …]`,
 * `[Error extracting text from file …]`) are deliberately not matched: they
 * mean the model was handed an error instead of the document, so there is no
 * invisible evidence to protect against.
 *
 * Scanning the whole array, not just the last message, is what makes signal 2
 * work at all: the attachment's trace lives in the HISTORY from turn 2 on.
 * One upload therefore suppresses claim checks for the rest of that
 * conversation (as images already did) — see §5.
 */
export function turnCarriedFileAttachment(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    const fromUser = message.role === "user";
    for (const part of message.parts) {
      if (!isRecord(part)) continue;
      if (part.type === "file") return true;
      if (
        fromUser &&
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.includes(INLINED_DOCUMENT_MARKER)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Everything the fragment needs about a turn except its tool results, which
 * only exist once the stream has run. `claimCheckStreamMetadata` below holds
 * one of these for the length of a turn.
 */
export type ClaimCheckTurnContext = {
  /**
   * The agent's parsed `claim_check` block. Parsed by the caller and handed
   * in, not re-parsed here: it used to be read once in routes.ts for the
   * accumulation flag and again in this function for the gates, two reads of
   * the same blob that could disagree.
   */
  config: ClaimCheckConfig;
  user?: User;
  /**
   * Whether this request gets guest treatment — pass `treatAsGuest(req, user)`,
   * the same expression `recalledMemoriesMetadata` gets in the chat route. A
   * signed-in user on the public surface renders in guest mode, so the
   * external-visibility gate below must see them as external too, not just an
   * anonymous caller.
   */
  isGuest: boolean;
  /**
   * `checkLicense()["claim-check"]` — passed in rather than read here so this
   * function stays pure. Today the EE licence flag that registers the table
   * and the one the endpoint checks are the same flag, so this can only be
   * false when the endpoint is 404ing too; the gate exists because the two
   * surfaces disagreeing is precisely what produced this finding.
   */
  isLicensed: boolean;
  /**
   * This turn's messages — pass `[...result.previousMessages, message]` from
   * the chat route. The new message is pre-inlining (its `file` parts are
   * intact); the loaded history is whatever was persisted, which for a
   * document is the already-inlined wrapper TEXT. `turnCarriedFileAttachment`
   * reads both shapes, and this is why it has to. `result.originalMessages`
   * is not usable here: it is the post-inlining array for this turn, so the
   * new message's own `file` part is already gone from it. Explicitly passed
   * rather than read from a global so this function stays pure.
   */
  messages: unknown;
  /**
   * The turn's memory recall, same object `recalledMemoriesMetadata` gets.
   * Undefined when the agent has no memory base.
   */
  recall: Pick<RecallCollector, "list"> | undefined;
};

/** Message metadata fragment merged on the SDK `finish` part (spec §5). */
export function claimCheckMetadata({ config, user, isGuest, isLicensed, toolResults, messages, recall }:
  ClaimCheckTurnContext & { toolResults: unknown }
): { claimCheck: ClaimCheckTrigger } | Record<string, never> {
  if (!config.enabled) return {};
  if (!isLicensed) return {};
  // An anonymous viewer can never complete a check: POST /claims/check needs
  // a user id that coerces to a finite number (hasNumericUserId in
  // ee/claim-check/routes.ts) and answers 401 without one, and neither
  // storage path can key a row. showToExternalUsers exists to serve guests on
  // a public link — but a SIGNED-IN guest-surface visitor, who has an id.
  // Offering the fragment to an anonymous one promises a panel that can only
  // ever fail. (`hasNumericUserId` is the strict superset of this test; no
  // auth branch yields a truthy non-numeric id today.)
  if (!user?.id) return {};
  if ((isGuest || isExternalOrAnonymousUser(user)) && !config.showToExternalUsers) return {};
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
 * Every part type `claimCheckMetadata` reads: the retrieval evidence itself
 * plus every suppression signal. `recordToolResult` keeps nothing else, so a
 * twenty-tool turn holds two entries instead of twenty — it used to hold a
 * reference to EVERY tool's final output (sandbox bash, image generation,
 * MCP) for the length of the turn, none of which this module can read.
 *
 * Derived from the three sets above rather than spelled out again: a type
 * added to the suppression class is recorded automatically. Getting that
 * wrong would not merely waste memory — an unrecorded suppression signal is
 * a FALSE "unsupported" verdict, which is the whole point of C1.
 */
export const RECORDED_PART_TYPES = new Set([
  ...RETRIEVAL_PART_TYPES,
  SESSION_ITEMS_PART_TYPE,
  ...INVISIBLE_EVIDENCE_PART_TYPES,
]);

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
  const type = `tool-${part.toolName}`;
  if (!RECORDED_PART_TYPES.has(type)) return;
  acc.push({ type, toolCallId: part.toolCallId, output: part.output });
}

/** The subset of a raw stream part this module reads. */
type ClaimCheckStreamPart = {
  type: string;
  toolName?: unknown;
  toolCallId?: unknown;
  output?: unknown;
  preliminary?: unknown;
};

/**
 * The whole feature's switch, as one function: feed it every raw stream part
 * of a turn and it returns the `finish` part's claim-check metadata fragment
 * (and `{}` for every other part).
 *
 * It exists because this was two statements sitting 20 lines apart inside a
 * 5,000-line route factory — an accumulator push in `messageMetadata` and a
 * spread in its `finish` branch — so nothing failed if the fragment never
 * reached the client. There is a realistic way for that to happen:
 * `guardToolOutput` (src/exulu/tool-output-offload.ts) replaces an over-cap
 * tool output with `{ truncated, notice, preview }`, which has no `result`
 * key, so `retrievedIdsOf` skips it and the fragment goes missing. Agentic
 * retrieval is exempt from that offload today only because of a `Set` literal
 * in an unrelated file (`OUTPUT_OFFLOAD_EXEMPT_TOOL_IDS` in
 * convert-exulu-tools-to-ai-sdk-tools.ts, which has its own test asserting
 * agentic_context_search is still in it).
 *
 * The config is read ONCE here, at the start of the turn, and handed to
 * `claimCheckMetadata` — never parsed twice per turn by two callers who could
 * disagree. A disabled check returns a no-op handler, so the turns that do
 * not use this feature (the vast majority) pay nothing per stream part.
 */
export function claimCheckStreamMetadata(
  ctx: ClaimCheckTurnContext,
): (part: ClaimCheckStreamPart) => { claimCheck: ClaimCheckTrigger } | Record<string, never> {
  if (!ctx.config.enabled) return () => ({});

  const toolResults: { type: string; toolCallId: string; output: unknown }[] = [];
  return (part) => {
    recordToolResult(toolResults, part);
    if (part.type !== "finish") return {};
    return claimCheckMetadata({ ...ctx, toolResults });
  };
}
