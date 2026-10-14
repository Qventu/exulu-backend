// src/exulu/claim-check/finish-metadata.ts
//
// The chat's trigger for a claim check, merged onto the SDK `finish` part the
// same way recalledMemoriesMetadata is (spec §5; Stage 4 amendment §4).
//
// Two rules the shape encodes:
//
//  - MANIFEST, NOT CONTENT. The client already holds every source's content —
//    it rendered the retrieval chunks, the recalled-memories panel and the
//    tool outputs already, so re-sending any of it here would double a
//    payload that averages ~89,000 characters per turn. This fragment names
//    each source by `type` and `id`, and the client locates the matching part
//    BY TOOL CALL ID and assembles POST /claims/check's `sources[]` from what
//    it already has. See manifestFor's docblock for the one entry per kind.
//  - ABSENT, NOT EMPTY. When the check is off, the viewer may not see it, or
//    this turn used evidence that is still genuinely unreachable (§5), the
//    fragment is missing entirely. The frontend's rule is "no fragment, no
//    check ever runs", so a present-but-false fragment would be a second
//    state nobody needs — and naming a source the client cannot in fact
//    produce is worse than that: the client's completeness guard then
//    refuses the WHOLE check, not just the one source.
import type { User } from "@EXULU_TYPES/models/user";
import type { ClaimCheckConfig } from "@EE/agentic-retrieval/pipeline/config";
import type { ClaimCheckSourceType } from "@EE/claim-check/types";
import { isExternalOrAnonymousUser } from "@SRC/exulu/resolve-max-steps";
import { AGENTIC_RETRIEVAL_TOOL_NAME } from "@EE/agentic-retrieval/pipeline/index";
import { SESSION_ITEMS_RETRIEVAL_TOOL_NAME } from "@SRC/templates/tools/session-items-retrieval-tool";
import { SESSION_FILE_READ_TOOL_NAME } from "@SRC/templates/tools/session-file-read-tool";
import { PARSE_DOCUMENT_TOOL_NAME } from "@SRC/templates/tools/parse-document-tool";
import { VIEW_DOCUMENT_PAGE_TOOL_NAME } from "@SRC/templates/tools/view-document-page-tool";
import { INTERNET_SEARCH_TOOL_NAME } from "@SRC/templates/tools/perplexity";
import { sanitizeToolName } from "@SRC/utils/sanitize-tool-name";

/** One source the client must locate and send. */
export type ClaimCheckManifestEntry = {
  type: ClaimCheckSourceType;
  id: string;
  /**
   * Which tool call this source came from.
   *
   * For `document`, `web` and `session_item` this IS the lookup key: the id
   * is `tool:<toolCallId>`, one entry per call, so the client finds the part
   * by it.
   *
   * For `knowledge_base` it is **provenance, not a lookup key** (fix round 3,
   * Critical 3). One entry is named per ITEM, deduplicated by item id, so an
   * item several retrieval calls returned carries only the call that saw it
   * FIRST — while each call serialises only its own chunks. A client that
   * read just this call's part would therefore drop every passage the other
   * calls returned for the same item, and verifying an answer against part of
   * its evidence scores grounded claims `unsupported`. The client pools an
   * item's chunks across the turn's parts by `item_id` instead; this field
   * records where the item was first seen.
   *
   * Absent for a `memory` entry: recalled memories reach the model through
   * the system prompt, not a tool call, so there is no call to locate it by.
   */
  toolCallId?: string;
};

/** What the chat needs to post a check: that it may, and what to send. */
export type ClaimCheckTrigger = {
  enabled: true;
  /** One entry per source the client should send, first-seen order, deduplicated by id. */
  sources: ClaimCheckManifestEntry[];
};

/** A tool's AI-SDK part type, derived from the one display-name literal its
 * factory registers rather than a second hardcoded spelling of it — so a
 * rename of that literal fails this module's own test suite instead of
 * silently turning the detection it feeds off. */
const partTypeOf = (toolName: string) => `tool-${sanitizeToolName(toolName)}`;

/**
 * The retrieval tool is renamed per agent in the UI, but the AI-SDK tool key
 * — and so the `tool-${...}` part type this module matches on — is derived
 * from the one display-name literal the tool factory registers
 * (`AGENTIC_RETRIEVAL_TOOL_NAME`).
 */
export const RETRIEVAL_PART_TYPES = new Set([partTypeOf(AGENTIC_RETRIEVAL_TOOL_NAME)]);

/**
 * `read_session_file` and `parse_document` share one output shape — `{ content }`
 * on success, `{ error }` on failure — so one handler in `manifestFor` serves
 * both (spec §4's table).
 */
const DOCUMENT_PART_TYPES = new Set([partTypeOf(SESSION_FILE_READ_TOOL_NAME), partTypeOf(PARSE_DOCUMENT_TOOL_NAME)]);

/** `internet_search`'s part type — one web source per call (spec §4). */
const WEB_PART_TYPE = partTypeOf(INTERNET_SEARCH_TOOL_NAME);

/**
 * The session-attached-items search tool's part type. Its output has no
 * `chunks` key (unlike agentic retrieval), so it needs its own manifest
 * handler rather than sharing `RETRIEVAL_PART_TYPES`'s.
 */
const SESSION_ITEMS_PART_TYPE = partTypeOf(SESSION_ITEMS_RETRIEVAL_TOOL_NAME);

/**
 * What remains genuinely unreachable after Stage 4 (spec §5): `view_document_page`'s
 * output is `{ attached: true, filename, page, note }` — the evidence is a
 * RENDERED IMAGE, not text the client could ever hand the (text-only) claim-check
 * engine. This is not a deferred case like the four Stage 4 covers; it is permanent.
 *
 * Each part type is derived from the tool's own exported display-name literal
 * (never a second hardcoded spelling), so a rename fails this module's test
 * suite instead of silently turning the suppression off.
 */
export const INVISIBLE_EVIDENCE_PART_TYPES = new Set([partTypeOf(VIEW_DOCUMENT_PAGE_TOOL_NAME)]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Item ids from one retrieval part's output (`{ result: JSON string }` → `.chunks[].item_id`); never throws. */
function chunkItemIdsOf(output: unknown): string[] {
  const raw = isRecord(output) ? output.result : undefined;
  if (typeof raw !== "string") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A truncated or offloaded tool output is not a reason to break the
    // turn's finish part. Skip it; with no ids this call contributes nothing.
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.chunks)) return [];

  const ids: string[] = [];
  for (const chunk of parsed.chunks) {
    if (!isRecord(chunk)) continue;
    const id = typeof chunk.item_id === "string" ? chunk.item_id : undefined;
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * A tool output's `{ result: <JSON string> }` payload, parsed — or
 * `UNREADABLE` when there is no string `result` (an offloaded
 * `{ truncated, notice, preview }` placeholder has none) or it does not
 * parse. The distinction matters: see `Readability` below.
 */
const UNREADABLE = Symbol("claim-check:unreadable-tool-output");

function parsedToolPayload(output: unknown): unknown {
  const raw = isRecord(output) ? output.result : undefined;
  if (typeof raw !== "string") return UNREADABLE;
  try {
    return JSON.parse(raw);
  } catch {
    return UNREADABLE;
  }
}

/**
 * What a covered tool's output lets this module say about the evidence that
 * tool contributed. **Three answers, not two** (fix round 3, Critical 4):
 *
 *  - `readable` — the client can provably build at least one source from it,
 *    so the entry is named;
 *  - `nothing` — a cleanly-parsed EMPTY result. The tool genuinely
 *    contributed no evidence, so the entry is skipped and the fragment is
 *    still emitted: the check runs against the turn's other sources, which
 *    IS the whole of the answer's evidence;
 *  - `unreadable` — the tool contributed evidence this fragment cannot
 *    represent: an OFFLOADED output (`{ truncated, notice, preview }`, no
 *    `result` key — `guardToolOutput` in src/exulu/tool-output-offload.ts,
 *    whose 4,000-char preview the model DID read), a payload that does not
 *    parse, or a shape the tool does not emit. The whole fragment is then
 *    suppressed, exactly as `view_document_page` already does, because
 *    scoring an answer against part of its evidence reports grounded claims
 *    `unsupported`.
 *
 * Inverting Stage 3's suppression gates into Stage 4's inclusion gates
 * collapsed the third answer into the second: an offloaded output read
 * exactly like "the tool found nothing". `read_session_file`'s 16,000-char
 * slices sit right on the offload floor for a <=40k-window model, so this is
 * not a corner case.
 */
type Readability = "readable" | "nothing" | "unreadable";

/**
 * A session-items call's output, classified.
 *
 * The measured shape: `{ result: JSON.stringify(results.flat()) }` where
 * `results` holds one `context.search(...)` response PER CONTEXT referenced
 * in the session — `{ …, context: { name, id }, chunks:
 * VectorSearchChunkResult[] }` — or, for a context with no embedder, that
 * context's bare error STRING (the tool's own catch branch). So the chunks
 * nest one level deeper than agentic retrieval's output, and
 * `parsed.length > 0` (the gate this replaced) meant "a context was
 * searched", not "an item was found".
 *
 * `readable` is **the client's own predicate, mirrored** (frontend
 * `sessionItemSources` in `claim-check-data.ts`), not a second guess at the
 * shape: at least one element that is a record whose `chunks` is an array
 * holding an entry with a string `item_id` and non-blank `chunk_content`.
 * Getting that wrong is not a degraded source — the two commonest outcomes
 * (`[{ context, chunks: [] }]`, which is the common case on a session with
 * pinned items, and an embedder-less context) would name an entry the client
 * provably cannot fulfil, and the client's completeness guard refuses the
 * WHOLE manifest over any one such entry, knowledge-base half included, with
 * no error and nothing logged.
 *
 * `unreadable` covers the offloaded/unparseable/non-array payload, an
 * element that is neither a context response nor the embedder string, and a
 * chunk carrying text the client cannot attribute to an item — it keys its
 * sources on `item_id`, so such text is text it silently drops.
 */
function sessionItemsReadability(output: unknown): Readability {
  const parsed = parsedToolPayload(output);
  if (!Array.isArray(parsed)) return "unreadable";
  let found = false;
  for (const element of parsed) {
    // A bare string is the embedder-not-configured message, not evidence —
    // skipped here exactly as the client skips every non-object element.
    if (typeof element === "string") continue;
    if (!isRecord(element) || !Array.isArray(element.chunks)) return "unreadable";
    for (const row of element.chunks) {
      if (!isRecord(row)) return "unreadable";
      const text = typeof row.chunk_content === "string" ? row.chunk_content : "";
      if (!text.trim()) continue;
      if (typeof row.item_id !== "string") return "unreadable";
      found = true;
    }
  }
  return found ? "readable" : "nothing";
}

/**
 * A `read_session_file` / `parse_document` call's output, classified.
 * `{ content, … }` on success, `{ error }` on failure — one handler serves
 * both (spec §4's table).
 *
 * An `{ error }` output is `nothing`, not `unreadable`: the model was handed
 * a failure message, which is not evidence, so the turn's other sources are
 * still the whole of the answer's evidence. Naming it would instead have the
 * check verify the answer against a failure message and report grounded
 * claims unsupported.
 *
 * Everything else — an offloaded placeholder, or any shape with neither a
 * string `content` nor a string `error` — is `unreadable`.
 */
function documentReadability(output: unknown): Readability {
  if (!isRecord(output)) return "unreadable";
  if (typeof output.content === "string") return output.content.trim() ? "readable" : "nothing";
  if (typeof output.error === "string") return "nothing";
  return "unreadable";
}

/**
 * An `internet_search` call's output, classified.
 *
 * Perplexity answers `{ result: JSON.stringify({ content, citations,
 * search_results }) }`, where `content` is the prose answer the assistant
 * paraphrased and each `search_results[i]` carries a `title`/`snippet`.
 * `readable` mirrors the client's `webSources` arm: it sends the body as its
 * own source whenever `content` has text, and one source per cited page that
 * has text — so the entry is nameable when either exists, and only then.
 *
 * `unreadable` is the whole point of gating this arm at all (fix round 3,
 * Important 7: it was the one arm with no inclusion test). Two shapes the
 * backend really records and the client cannot parse:
 *
 *  - `{ result: "Max retries exceeded for perplexity research for query." }`
 *    — a `result` string that is not JSON, returned after three
 *    rate-limited attempts;
 *  - an offloaded payload, because `internet_search` is **not** in
 *    `OUTPUT_OFFLOAD_EXEMPT_TOOL_IDS`.
 *
 * Both used to name an entry the client could never fulfil, which refuses
 * the whole turn's check silently; they now withhold the fragment, which is
 * the same user-visible outcome reached honestly and with the manifest
 * telling the truth.
 */
function webReadability(output: unknown): Readability {
  const parsed = parsedToolPayload(output);
  // `isRecord` admits an array (typeof [] === "object"), and an array is not
  // a shape this tool emits — the client's own arm recovers nothing from one.
  if (!isRecord(parsed) || Array.isArray(parsed)) return "unreadable";
  if (typeof parsed.content === "string" && parsed.content.trim()) return "readable";
  const results = Array.isArray(parsed.search_results) ? parsed.search_results : [];
  const cited = results.some(
    (result) =>
      isRecord(result) &&
      [result.title, result.snippet].some((field) => typeof field === "string" && field.trim()),
  );
  return cited ? "readable" : "nothing";
}

/**
 * The manifest the client fills in. One entry per source it must send, each
 * naming the handler (`type`) and where to find it (`toolCallId`). The client
 * locates parts BY TOOL CALL ID — no tool display name appears on the frontend
 * any more, which is what makes a rename on this side harmless.
 *
 * Never throws, and never names a source this function cannot vouch for:
 * a retrieval chunk with its source reference stripped, a document call that
 * errored or returned no content, a session-items call that found nothing, or
 * a memory this viewer may not see or whose title and information are both
 * blank all contribute nothing. Naming an entry the client cannot in fact
 * recover is worse than omitting it — the client's own completeness guard
 * counts MANIFEST ENTRIES, not final sources, and refuses the WHOLE check the
 * moment any one named entry produces nothing (spec §4; F3's guard).
 *
 * **Returns `null` when a covered tool contributed evidence this manifest
 * cannot represent at all** — the `unreadable` third outcome (see
 * `Readability`). That is not "one fewer source": the caller withholds the
 * whole fragment, the way `view_document_page` and an attachment already do,
 * because a check run against the remaining sources reports grounded claims
 * `unsupported`. "Nothing here" and "here it is" cannot be the only two
 * answers a handler gives; "I cannot represent this turn" is the third.
 */
function manifestFor(args: {
  toolResults: unknown;
  recalledMemories: { id: string; information?: string; title?: string }[] | undefined;
}): ClaimCheckManifestEntry[] | null {
  const out: ClaimCheckManifestEntry[] = [];
  const seen = new Set<string>();
  const add = (entry: ClaimCheckManifestEntry) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    out.push(entry);
  };

  for (const memory of args.recalledMemories ?? []) {
    if (typeof memory?.id !== "string" || !memory.id) continue;
    // `information` can legitimately be "" (a row with neither information nor
    // description — recall-collector.ts), but that does NOT make the memory
    // invisible to the check: the prompt block the model read is
    // `- {item_name: "<title>", item_id: …} <information> (saved by …)`
    // (buildMemoryPromptBlock), so with blank information the TITLE is still
    // real evidence in the system prompt — and a hand-created row with only a
    // name is an ordinary shape. The client falls back to the title as the
    // content, so such an entry IS fulfillable; dropping it instead
    // discarded evidence the model was shown (fix round 3, Important 5).
    //
    // Both blank is the one unfulfillable case, and naming it would have the
    // client recover nothing — F3's guard treats ANY unfulfillable entry as
    // reason to refuse the WHOLE check, not just that source.
    //
    // Both fields are read here purely as an inclusion test; neither ever
    // appears on the entry itself — the fragment stays ids-only.
    const information = typeof memory.information === "string" ? memory.information : "";
    const title = typeof memory.title === "string" ? memory.title : "";
    if (!information.trim() && !title.trim()) continue;
    add({ type: "memory", id: `memory:${memory.id}` });
  }

  for (const part of Array.isArray(args.toolResults) ? args.toolResults : []) {
    if (!isRecord(part) || typeof part.type !== "string" || typeof part.toolCallId !== "string") continue;

    if (RETRIEVAL_PART_TYPES.has(part.type)) {
      // One entry per ITEM, not per call: `add` dedupes by id, so an item two
      // searches both returned keeps the FIRST call's id. That id is
      // provenance only — the client pools the item's chunks across every
      // part of the turn by `item_id`, because each call serialises only its
      // own chunks and the second call's passages are evidence too (fix
      // round 3, Critical 3; see ClaimCheckManifestEntry.toolCallId).
      for (const id of chunkItemIdsOf(part.output)) {
        add({ type: "knowledge_base", id, toolCallId: part.toolCallId });
      }
      continue;
    }

    if (DOCUMENT_PART_TYPES.has(part.type)) {
      const readability = documentReadability(part.output);
      if (readability === "unreadable") return null;
      if (readability === "readable") {
        add({ type: "document", id: `tool:${part.toolCallId}`, toolCallId: part.toolCallId });
      }
      continue;
    }

    if (part.type === WEB_PART_TYPE) {
      const readability = webReadability(part.output);
      if (readability === "unreadable") return null;
      if (readability === "readable") {
        add({ type: "web", id: `tool:${part.toolCallId}`, toolCallId: part.toolCallId });
      }
      continue;
    }

    if (part.type === SESSION_ITEMS_PART_TYPE) {
      // The client builds one source per ITEM found across the searched
      // contexts, so "a context was searched" is not "an item was found" —
      // naming an entry the client cannot fulfil silences the whole check,
      // the same problem the memory and document handlers guard against. The
      // readable predicate is the client's own arm, mirrored; see the
      // classifier's docblock.
      const readability = sessionItemsReadability(part.output);
      if (readability === "unreadable") return null;
      if (readability === "readable") {
        add({ type: "session_item", id: `tool:${part.toolCallId}`, toolCallId: part.toolCallId });
      }
      continue;
    }
  }

  return out;
}

/** True when any part of this turn came from a tool in the permanently-uncoverable class above. */
function invisibleEvidenceToolRan(toolResults: unknown): boolean {
  if (!Array.isArray(toolResults)) return false;
  return toolResults.some(
    (part) => isRecord(part) && typeof part.type === "string" && INVISIBLE_EVIDENCE_PART_TYPES.has(part.type),
  );
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
 * of the invisible-evidence class (spec §5: extraction happens server-side,
 * so the client holds the raw file and never the extracted text).
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
   * The recalled-memories list this VIEWER may see this turn — exactly what
   * `recalledMemoriesMetadata({ recall, agent, isGuest })` returns under its
   * `recalledMemories` key, or undefined when it returned nothing at all
   * (recall found nothing this turn, OR it found something this viewer is
   * gated from seeing). Passed explicitly from routes.ts rather than derived
   * here from `agent`/`isGuest`: `recalledMemoriesMetadata` already owns the
   * "may this viewer see it" rule, and re-deriving it here is how the two
   * drift apart (a guest turn then names memory sources the client cannot
   * produce, and the client's completeness guard refuses the whole check).
   *
   * Carries `information` and `title` too — not for the fragment (which
   * stays ids-only; `manifestFor` reads them purely to decide whether to
   * name the entry at all, and neither ever reaches the produced entry) but
   * because a row can legitimately have blank information
   * (recall-collector.ts). Both are needed: the prompt block the model read
   * is `- {item_name: "<title>", item_id: …} <information> (saved by …)`, so
   * a title-only row is still evidence and the client falls back to the
   * title as the content. Only a row with BOTH blank is one the client has
   * nothing to render for and omits — the same "entry the client cannot
   * fulfil" problem a failed document call has.
   */
  recalledMemories?: { id: string; information?: string; title?: string }[];
  /**
   * True when the turn's recall actually found something (`recall.list().length > 0`),
   * independent of whether this viewer may see it. Needed to tell "recall
   * found nothing" (false — nothing is being hidden, the turn simply emits
   * with whatever other evidence exists) apart from "recall found something
   * but this viewer is gated from it" (true, with `recalledMemories`
   * undefined — real evidence the model saw that this fragment cannot
   * represent for this viewer, see the suppression below).
   */
  recallHadItems: boolean;
};

/** Message metadata fragment merged on the SDK `finish` part (spec §5; Stage 4 amendment §4). */
export function claimCheckMetadata({ config, user, isGuest, isLicensed, toolResults, messages, recalledMemories, recallHadItems }:
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
  if (turnCarriedFileAttachment(messages)) return {};
  // A recall the viewer may not see is still invisible evidence: the client
  // has no memory text to send, so the check would run against part of the
  // answer's evidence. recalledMemoriesMetadata already owns that rule — ask
  // it (via the two fields above), do not restate its condition here.
  if (recallHadItems && !recalledMemories) return {};

  const sources = manifestFor({ toolResults, recalledMemories });
  // `null`: a covered tool contributed evidence this fragment cannot
  // represent (an offloaded output, a payload that will not parse, a shape
  // the tool does not emit). The model read it; the check never would. Same
  // outcome as view_document_page and an attachment — withhold everything
  // rather than score the answer against the rest of its evidence.
  if (sources === null) return {};
  // No evidence at all, no check: a check with no sources marks every claim
  // unsupported for want of sources, which is a worse answer than no check.
  if (sources.length === 0) return {};

  return { claimCheck: { enabled: true, sources } };
}


/**
 * Every part type `claimCheckMetadata` reads: the retrieval evidence itself
 * plus every other recognised source and the one remaining suppression
 * signal. `recordToolResult` keeps nothing else, so a twenty-tool turn holds
 * a handful of entries instead of twenty — it used to hold a reference to
 * EVERY tool's final output (sandbox bash, image generation, MCP) for the
 * length of the turn, none of which this module can read.
 *
 * Derived from the sets above rather than spelled out again: a type added to
 * any of them is recorded automatically. Getting that wrong would not merely
 * waste memory — an unrecorded source is evidence this fragment silently
 * fails to name, and an unrecorded suppression signal is a FALSE
 * "unsupported" verdict, which is the whole point of C1.
 */
export const RECORDED_PART_TYPES = new Set([
  ...RETRIEVAL_PART_TYPES,
  ...DOCUMENT_PART_TYPES,
  WEB_PART_TYPE,
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
 * key, so `chunkItemIdsOf` skips it and the fragment goes missing. Agentic
 * retrieval is exempt from that offload today only because of a `Set` literal
 * in an unrelated file (`OUTPUT_OFFLOAD_EXEMPT_TOOL_IDS` in
 * convert-exulu-tools-to-ai-sdk-tools.ts, which has its own test asserting
 * agentic_context_search is still in it).
 *
 * `ctx`'s `recalledMemories`/`recallHadItems` are read lazily (whatever the
 * caller's ctx object does to make that true — e.g. accessor properties
 * backed by a live recall collector) because, like `toolResults` here, they
 * are only final once the turn's stream has actually run; `ctx` itself is
 * captured once, before the stream starts.
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
