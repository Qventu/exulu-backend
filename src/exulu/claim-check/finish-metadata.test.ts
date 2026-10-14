import {
  claimCheckMetadata,
  claimCheckStreamMetadata,
  recordToolResult,
  INVISIBLE_EVIDENCE_PART_TYPES,
  RECORDED_PART_TYPES,
  RETRIEVAL_PART_TYPES,
} from "./finish-metadata";
import { AGENTIC_RETRIEVAL_TOOL_NAME } from "@EE/agentic-retrieval/pipeline/index";
import { pipelineConfigFor } from "@EE/claim-check/agent-config";
import { SESSION_ITEMS_RETRIEVAL_TOOL_NAME } from "@SRC/templates/tools/session-items-retrieval-tool";
import { SESSION_FILE_READ_TOOL_NAME } from "@SRC/templates/tools/session-file-read-tool";
import { PARSE_DOCUMENT_TOOL_NAME } from "@SRC/templates/tools/parse-document-tool";
import { VIEW_DOCUMENT_PAGE_TOOL_NAME } from "@SRC/templates/tools/view-document-page-tool";
import { INTERNET_SEARCH_TOOL_NAME } from "@SRC/templates/tools/perplexity";
import { sanitizeToolName } from "@SRC/utils/sanitize-tool-name";

/** A tool's AI-SDK part type, mirroring production's own `partTypeOf`. */
const partTypeOf = (name: string) => `tool-${sanitizeToolName(name)}`;

/** An assistant message's parts, as the SDK shapes them. */
const retrievalParts = [
  { type: "step-start" },
  {
    type: "tool-Context_Search",
    toolCallId: "call_1",
    output: {
      result: JSON.stringify({
        chunks: [
          { chunk_id: "k1", item_id: "i1", item_name: "handbuch.pdf", chunk_content: "..." },
          { chunk_id: "k2", item_id: "i2", item_name: "ticket.txt", chunk_content: "..." },
        ],
      }),
    },
  },
  { type: "text", text: "Die FST-2XT arbeitet mit 230 Volt." },
];

/** This turn's retrieval-only manifest — i1/i2 from call_1, as `retrievalParts` produces. */
const retrievalSources = [
  { type: "knowledge_base", id: "i1", toolCallId: "call_1" },
  { type: "knowledge_base", id: "i2", toolCallId: "call_1" },
];

const agentWith = (claimCheck: string) =>
  ({
    id: "agent-1",
    tools: [
      { id: "agentic_context_search", config: [{ name: "claim_check", variable: claimCheck, type: "json" }] },
    ],
  }) as any;

const user = (over: Record<string, unknown> = {}) => ({ id: 7, type: "user", ...over }) as any;

/**
 * The agent's parsed claim_check block — what the chat route now hands in
 * (fix round 2, M7). Still routed through the agent shape and the real
 * parser, so a malformed blob is exercised here exactly as in production.
 */
const configOf = (claimCheck: string) => pipelineConfigFor(agentWith(claimCheck)).claimCheck;

describe("claimCheckMetadata", () => {
  it("emits ids only — never chunk content — when the check is enabled", () => {
    const meta = claimCheckMetadata({
      config: configOf('{"enabled":true}'),
      user: user(),
      isGuest: false,
      isLicensed: true,
      toolResults: retrievalParts,
    } as any);
    expect(meta).toEqual({
      claimCheck: { enabled: true, sources: retrievalSources },
    });
    expect(JSON.stringify(meta)).not.toContain("chunk_content");
  });

  it("is ABSENT when the agent has the check disabled", () => {
    expect(
      claimCheckMetadata({ config: configOf('{"enabled":false}'), user: user(), isGuest: false, isLicensed: true, toolResults: retrievalParts } as any),
    ).toEqual({});
  });

  it("is ABSENT when the agent has no claim_check config at all (default off)", () => {
    expect(
      claimCheckMetadata({ config: pipelineConfigFor({ id: "a", tools: [] }).claimCheck, user: user(), isGuest: false, isLicensed: true, toolResults: retrievalParts } as any),
    ).toEqual({});
  });

  // Review Focus 5
  it("is ABSENT, not a throw, when the claim_check blob is malformed JSON", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        claimCheckMetadata({ config: configOf("{not json"), user: user(), isGuest: false, isLicensed: true, toolResults: retrievalParts } as any),
      ).toEqual({});
    } finally {
      warn.mockRestore();
    }
  });

  // Review Focus 1
  it("is ABSENT when the turn made no retrieval call", () => {
    const noRetrieval = [{ type: "step-start" }, { type: "text", text: "Gern!" }];
    expect(
      claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: noRetrieval } as any),
    ).toEqual({});
  });

  it("is ABSENT when retrieval ran but returned no chunks", () => {
    const empty = [
      { type: "tool-Context_Search", toolCallId: "call_1", output: { result: JSON.stringify({ chunks: [] }) } },
    ];
    expect(
      claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: empty } as any),
    ).toEqual({});
  });

  // Review Focus 2
  it("is ABSENT for an external viewer when showToExternalUsers is false, even with the check enabled", () => {
    const meta = claimCheckMetadata({
      config: configOf('{"enabled":true,"showToExternalUsers":false}'),
      user: user({ role: { id: "r1", name: "external" } }),
      isGuest: false,
      isLicensed: true,
      toolResults: retrievalParts,
    } as any);
    expect(meta).toEqual({});
  });

  it("is emitted for an external viewer when showToExternalUsers is true", () => {
    const meta = claimCheckMetadata({
      config: configOf('{"enabled":true,"showToExternalUsers":true}'),
      user: user({ role: { id: "r1", name: "external" } }),
      isGuest: false,
      isLicensed: true,
      toolResults: retrievalParts,
    } as any);
    expect(meta).toEqual({
      claimCheck: { enabled: true, sources: retrievalSources },
    });
  });

  // Fix round 1, Important 1: a signed-in internal user viewing a public
  // agent link renders in guest mode, so isGuest must gate the same as an
  // external role — the endpoint applies the identical OR (ee/claim-check/routes.ts).
  it("is ABSENT for a signed-in internal user on the public surface when showToExternalUsers is false", () => {
    const meta = claimCheckMetadata({
      config: configOf('{"enabled":true,"showToExternalUsers":false}'),
      user: user(), // internal: no external role
      isGuest: true, // ...but on the public surface
      isLicensed: true,
      toolResults: retrievalParts,
    } as any);
    expect(meta).toEqual({});
  });

  it("is emitted for a signed-in internal user on the public surface when showToExternalUsers is true", () => {
    const meta = claimCheckMetadata({
      config: configOf('{"enabled":true,"showToExternalUsers":true}'),
      user: user(),
      isGuest: true,
      isLicensed: true,
      toolResults: retrievalParts,
    } as any);
    expect(meta).toEqual({
      claimCheck: { enabled: true, sources: retrievalSources },
    });
  });

  // Fix round 2, Important 1: the chat stream serves fully anonymous guests,
  // for whom showToExternalUsers was the ONLY gate — turn it on for a public
  // link and the fragment was emitted, the client posted, and the endpoint
  // answered 401 (it requires a numeric user id, as does every storage path).
  // The panel could then only ever fail for this feature's headline external
  // audience, so the fragment must agree with the endpoint instead.
  it("is ABSENT for an anonymous guest with no user id, even when showToExternalUsers is true", () => {
    const meta = claimCheckMetadata({
      config: configOf('{"enabled":true,"showToExternalUsers":true}'),
      user: undefined,
      isGuest: true,
      isLicensed: true,
      toolResults: retrievalParts,
      messages: [],
    } as any);
    expect(meta).toEqual({});
  });

  // The endpoint 404s an unlicensed deployment, so offering the fragment
  // there can only produce a failing post. Both EE flags flip together
  // today; this gate is what keeps them from drifting apart silently.
  it("is ABSENT when the deployment is not licensed for claim check", () => {
    const meta = claimCheckMetadata({
      config: configOf('{"enabled":true}'),
      user: user(),
      isGuest: false,
      isLicensed: false,
      toolResults: retrievalParts,
      messages: [],
    } as any);
    expect(meta).toEqual({});
  });

  it("deduplicates source ids across several retrieval calls and keeps first-seen order", () => {
    // Two separate invocations of the same retrieval tool in one turn (e.g.
    // the agent re-called it with a new sub-question) — not two different
    // tools; Important 2 removed the phantom "Knowledge_context_search" type
    // that never existed in production.
    const twoCalls = [
      { type: "tool-Context_Search", toolCallId: "call_1", output: { result: JSON.stringify({ chunks: [{ item_id: "i2" }, { item_id: "i1" }] }) } },
      { type: "tool-Context_Search", toolCallId: "call_2", output: { result: JSON.stringify({ chunks: [{ item_id: "i1" }, { item_id: "i3" }] }) } },
    ];
    const meta = claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: twoCalls } as any) as any;
    // first-seen wins: i1's entry carries call_1 (where it was FIRST seen), and
    // call_2 contributes only i3 — its own i1 is a duplicate, not a second entry.
    expect(meta.claimCheck.sources).toEqual([
      { type: "knowledge_base", id: "i2", toolCallId: "call_1" },
      { type: "knowledge_base", id: "i1", toolCallId: "call_1" },
      { type: "knowledge_base", id: "i3", toolCallId: "call_2" },
    ]);
  });

  it("survives a tool output that is not valid JSON without throwing", () => {
    const broken = [{ type: "tool-Context_Search", toolCallId: "call_1", output: { result: "<<not json>>" } }];
    expect(
      claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: broken } as any),
    ).toEqual({});
  });

  // Fix round 1, Important 2.2: the whitelist is derived from the tool
  // factory's own name literal, not a second hardcoded copy of it.
  it("matches exactly the part type sanitizeToolName derives from the tool factory's own name literal", () => {
    expect(RETRIEVAL_PART_TYPES.has(`tool-${sanitizeToolName(AGENTIC_RETRIEVAL_TOOL_NAME)}`)).toBe(true);
    expect(RETRIEVAL_PART_TYPES.size).toBe(1);
  });

  // Stage 4: session-items search used to suppress the whole fragment
  // whenever it contributed anything (its output nests its chunks one level
  // deeper than agentic retrieval's, so its evidence was invisible to the old
  // sourceIds/toolCallIds shape). Now its output is content the client
  // already rendered and can resend by tool call id, so it becomes a
  // `session_item` manifest entry instead — but only when the client can
  // provably build a source from it.
  //
  // Fix round 3, Critical 2: the gate used to be `Array.isArray(parsed) &&
  // parsed.length > 0`, written against a GUESSED flat item shape. The real
  // array holds one element PER CONTEXT SEARCHED — each a whole
  // `context.search` response with its chunks nested under `.chunks`, or a
  // bare embedder-not-configured STRING — so `length > 0` meant "a context
  // was searched", not "an item was found". The two commonest outcomes
  // (`[{ context, chunks: [] }]` on a session with pinned items, and a
  // context with no embedder) therefore named an entry the client provably
  // cannot fulfil, and F3's guard refuses the WHOLE manifest — KB half
  // included — with no error and nothing logged.
  //
  // The gate now mirrors the client's own arm literally (frontend
  // `sessionItemSources`): at least one element that is a record whose
  // `chunks` is an array holding an entry with a string `item_id` and
  // non-blank `chunk_content`. The fixtures below are the measured shapes,
  // the same ones the frontend's session-item tests encode.
  describe("session-items retrieval ran alongside agentic retrieval", () => {
    const sessionItemsPartType = partTypeOf(SESSION_ITEMS_RETRIEVAL_TOOL_NAME);

    /** One `context.search` response per context searched — the measured shape. */
    const sessionItemsPart = (result: unknown) => ({
      type: sessionItemsPartType,
      toolCallId: "call_2",
      output: { result: JSON.stringify(result) },
    });

    it("names the session-items call as a session_item entry when a context's chunks hold a usable item", () => {
      const both = [
        ...retrievalParts,
        sessionItemsPart([
          {
            context: { name: "Handbücher", id: "ctx_1" },
            chunks: [{ item_id: "i9", item_name: "wartung.pdf", chunk_content: "230 Volt." }],
          },
        ]),
      ];
      const meta = claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: both } as any);
      expect(meta).toEqual({
        claimCheck: {
          enabled: true,
          sources: [...retrievalSources, { type: "session_item", id: "tool:call_2", toolCallId: "call_2" }],
        },
      });
    });

    it("does not name a session_item entry when the search ran and matched nothing — the common case on a session with pinned items", () => {
      const both = [
        ...retrievalParts,
        sessionItemsPart([{ context: { name: "Handbücher", id: "ctx_1" }, chunks: [] }]),
      ];
      const meta = claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: both } as any) as any;
      expect(meta.claimCheck.sources.some((s: any) => s.type === "session_item")).toBe(false);
      expect(meta.claimCheck.sources.length).toBeGreaterThan(0); // the kb sources still count
    });

    // A context with no embedder contributes its bare error message instead
    // of a response object (the tool's own catch branch). The client skips
    // every non-object element, so naming the entry would refuse the whole
    // check for a product that HAS embedder-less contexts.
    it("does not name a session_item entry for a context with no embedder configured", () => {
      const both = [
        ...retrievalParts,
        sessionItemsPart(["Embedder not configured for context ctx_2."]),
      ];
      const meta = claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: both } as any) as any;
      expect(meta.claimCheck.sources.some((s: any) => s.type === "session_item")).toBe(false);
      expect(meta.claimCheck.sources.length).toBeGreaterThan(0);
    });

    it("does not name a session_item entry when every chunk's text is blank, the way the client drops it", () => {
      const both = [
        ...retrievalParts,
        sessionItemsPart([
          { context: { id: "ctx_1" }, chunks: [{ item_id: "i9", item_name: "leer.pdf", chunk_content: "   " }] },
        ]),
      ];
      const meta = claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: both } as any) as any;
      expect(meta.claimCheck.sources.some((s: any) => s.type === "session_item")).toBe(false);
      expect(meta.claimCheck.sources.length).toBeGreaterThan(0);
    });

    it("names the entry when one of several searched contexts found something", () => {
      const both = [
        ...retrievalParts,
        sessionItemsPart([
          "Embedder not configured for context ctx_2.",
          { context: { id: "ctx_1" }, chunks: [] },
          { context: { id: "ctx_3" }, chunks: [{ item_id: "i9", item_name: "w.pdf", chunk_content: "230 Volt." }] },
        ]),
      ];
      const meta = claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: both } as any) as any;
      expect(meta.claimCheck.sources).toContainEqual({ type: "session_item", id: "tool:call_2", toolCallId: "call_2" });
    });

    // The largest results — an offloaded placeholder with no `result` key at
    // all — are precisely the ones most likely to have grounded the answer,
    // and precisely the ones that cannot be read here at all.
    it("does not name a session_item entry when the session-items output was offloaded (truncated/notice/preview)", () => {
      const both = [
        ...retrievalParts,
        {
          type: sessionItemsPartType,
          toolCallId: "call_2",
          output: { truncated: true, notice: "stored as tool-output-context_search-ab12.txt", preview: "…" },
        },
      ];
      const meta = claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: both, messages: [] } as any) as any;
      expect(meta.claimCheck.sources.some((s: any) => s.type === "session_item")).toBe(false);
    });

    it("does not name a session_item entry when the output cannot be parsed", () => {
      const both = [
        ...retrievalParts,
        { type: sessionItemsPartType, toolCallId: "call_2", output: { result: "<<not json>>" } },
      ];
      const meta = claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: both } as any) as any;
      expect(meta.claimCheck.sources.some((s: any) => s.type === "session_item")).toBe(false);
    });
  });

  // Fix round 2, Critical 1 → Stage 4: the other tools that used to blanket-
  // suppress the fragment because their evidence was invisible to it.
  // `read_session_file` and `parse_document` share one output shape
  // (`{ content }` on success, `{ error }` on failure) and become `document`
  // entries; `internet_search` becomes a `web` entry. `view_document_page`
  // is the one member of the old class that stays suppressing — its output
  // is a rendered IMAGE, which a text-only engine can never verify against.
  describe("a tool whose evidence the check could not represent", () => {
    it("is ABSENT when view_document_page ran alongside agentic retrieval — its evidence is a rendered image", () => {
      const both = [
        ...retrievalParts,
        { type: partTypeOf(VIEW_DOCUMENT_PAGE_TOOL_NAME), toolCallId: "call_2", output: { attached: true, filename: "x.pdf", page: 1, note: "shown" } },
      ];
      expect(
        claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: both } as any),
      ).toEqual({});
    });

    it("derives that one remaining part type from the tool's own exported name literal", () => {
      expect([...INVISIBLE_EVIDENCE_PART_TYPES]).toEqual([partTypeOf(VIEW_DOCUMENT_PAGE_TOOL_NAME)]);
    });

    // The suppression must not swallow the feature: the turn the check was
    // built for — agentic retrieval and nothing else — still emits.
    it("still emits for a turn whose only tool was agentic retrieval", () => {
      expect(
        claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: retrievalParts } as any),
      ).toEqual({ claimCheck: { enabled: true, sources: retrievalSources } });
    });

    // names a document tool's output as a document entry (read_session_file)
    it("names a document tool's output as a document entry", () => {
      const out = claimCheckMetadata({
        config: configOf('{"enabled":true}'),
        user: user(),
        isGuest: false,
        isLicensed: true,
        toolResults: [...retrievalParts, { type: "tool-read_session_file", toolCallId: "call_4", output: { content: "230 Volt." } }],
      } as any) as any;
      expect(out.claimCheck.sources).toContainEqual({ type: "document", id: "tool:call_4", toolCallId: "call_4" });
    });

    // parse_document shares read_session_file's output shape — same handler.
    it("names parse_document's output as a document entry too", () => {
      const out = claimCheckMetadata({
        config: configOf('{"enabled":true}'),
        user: user(),
        isGuest: false,
        isLicensed: true,
        toolResults: [...retrievalParts, { type: partTypeOf(PARSE_DOCUMENT_TOOL_NAME), toolCallId: "call_5", output: { content: "--- page 1 ---\n230 Volt." } }],
      } as any) as any;
      expect(out.claimCheck.sources).toContainEqual({ type: "document", id: "tool:call_5", toolCallId: "call_5" });
    });

    // Review Focus 4
    it("does not name a document tool call whose output carries no content", () => {
      const out = claimCheckMetadata({
        config: configOf('{"enabled":true}'),
        user: user(),
        isGuest: false,
        isLicensed: true,
        toolResults: [...retrievalParts, { type: "tool-read_session_file", toolCallId: "call_4", output: { content: "" } }],
      } as any) as any;
      expect(out.claimCheck.sources.some((s: any) => s.id === "tool:call_4")).toBe(false);
    });

    // Review Focus 2
    it("does not name a document tool call that failed", () => {
      const out = claimCheckMetadata({
        config: configOf('{"enabled":true}'),
        user: user(),
        isGuest: false,
        isLicensed: true,
        toolResults: [...retrievalParts, { type: "tool-read_session_file", toolCallId: "call_4", output: { error: "Could not read session file" } }],
      } as any) as any;
      expect(out.claimCheck.sources.some((s: any) => s.id === "tool:call_4")).toBe(false);
    });

    // internet_search → a web entry, named unconditionally (no content/error
    // check), as specified. Unlike session-items (fixed in review round 1)
    // this was not flagged as a gap — left as-is here, not re-litigated.
    it("names an internet-search call as a web entry", () => {
      const out = claimCheckMetadata({
        config: configOf('{"enabled":true}'),
        user: user(),
        isGuest: false,
        isLicensed: true,
        toolResults: [...retrievalParts, { type: partTypeOf(INTERNET_SEARCH_TOOL_NAME), toolCallId: "call_9", output: { result: JSON.stringify({ content: "…", citations: [] }) } }],
      } as any) as any;
      expect(out.claimCheck.sources).toContainEqual({ type: "web", id: "tool:call_9", toolCallId: "call_9" });
    });
  });

  // Fix round 2, Minor 4: for an external viewer whose agent has
  // show_sources_to_external_users off, the retrieval pipeline's
  // serializeOutput strips item_id (and the other reference fields) from
  // every chunk, so there is nothing for the fragment to name. Absent is the
  // right outcome — a check with no sources marks everything unsupported —
  // but it follows from the OTHER flag, so an admin who enables
  // claim_check.showToExternalUsers while sources are hidden gets silence.
  // Pinned here so that stays a decision rather than an accident.
  it("is ABSENT when the chunks had their source references stripped (hidden sources)", () => {
    // Exactly what serializeOutput(result, hideSources: true) produces:
    // stripSourceReferences sets item_id/item_name/context/chunk_id to
    // undefined, and JSON.stringify drops undefined keys entirely.
    const stripped = [
      {
        type: "tool-Context_Search",
        toolCallId: "call_1",
        output: {
          result: JSON.stringify({ chunks: [{ chunk_content: "Die FST-2XT arbeitet mit 230 Volt." }] }),
        },
      },
    ];
    expect(
      claimCheckMetadata({
        config: configOf('{"enabled":true,"showToExternalUsers":true}'),
        user: user({ role: { id: "r1", name: "external" } }),
        isGuest: true,
        isLicensed: true,
        toolResults: stripped,
        messages: [],
      } as any),
    ).toEqual({});
  });

  // Fix round 2, Critical 1: the same class, reached without any tool call.
  describe("the turn carried an attached document", () => {
    const fileMessage = {
      id: "m1",
      role: "user",
      parts: [
        { type: "file", mediaType: "application/pdf", filename: "wartung.pdf", url: "https://s3/wartung.pdf" },
        { type: "text", text: "Was steht da zur Wartung?" },
      ],
    };
    const textMessage = { id: "m0", role: "user", parts: [{ type: "text", text: "Hallo" }] };

    it("is ABSENT when this turn's user message carries a file part", () => {
      expect(
        claimCheckMetadata({
          config: configOf('{"enabled":true}'),
          user: user(),
          isGuest: false,
          isLicensed: true,
          toolResults: retrievalParts,
          messages: [textMessage, fileMessage],
        } as any),
      ).toEqual({});
    });

    // A `file` part in the loaded history means an IMAGE attachment: it
    // survives inlining as a file part and is persisted as one, so it stays
    // visible for the life of the session.
    it("is ABSENT when an earlier message in the session carried the file part", () => {
      expect(
        claimCheckMetadata({
          config: configOf('{"enabled":true}'),
          user: user(),
          isGuest: false,
          isLicensed: true,
          toolResults: retrievalParts,
          messages: [fileMessage, textMessage],
        } as any),
      ).toEqual({});
    });

    it("still emits when no message of the turn carries a file part", () => {
      expect(
        claimCheckMetadata({
          config: configOf('{"enabled":true}'),
          user: user(),
          isGuest: false,
          isLicensed: true,
          toolResults: retrievalParts,
          messages: [textMessage],
        } as any),
      ).toEqual({ claimCheck: { enabled: true, sources: retrievalSources } });
    });

    // Fix round 2, re-review: a DOCUMENT's file part never reaches the
    // database. generateStream returns the post-inlining array as
    // originalMessages, the SDK builds onFinish's `messages` from it, and the
    // chat route persists those rows — so the stored user message holds the
    // inlining wrapper as TEXT. On every follow-up question after an upload
    // the loaded history has no file part at all while the document's text is
    // still in the prompt, which is C1's exact failure mode. This is the test
    // that would have caught it.
    const inlinedDocumentMessage = {
      id: "m1",
      role: "user",
      parts: [
        {
          type: "text",
          text: '<file file name = "wartung.pdf" >\nAlle 12 Monate ist die Steuerung zu prüfen. \n </file>',
        },
        { type: "text", text: "Was steht da zur Wartung?" },
      ],
    };

    it("is ABSENT when a HISTORY message carries the inlined document wrapper as text", () => {
      expect(
        claimCheckMetadata({
          config: configOf('{"enabled":true}'),
          user: user(),
          isGuest: false,
          isLicensed: true,
          toolResults: retrievalParts,
          // Turn 2 of the session: this is exactly what the stored row holds.
          messages: [inlinedDocumentMessage, { id: "m2", role: "assistant", parts: [{ type: "text", text: "..." }] }, textMessage],
        } as any),
      ).toEqual({});
    });

    it("is ABSENT when THIS turn's user message already holds the wrapper", () => {
      expect(
        claimCheckMetadata({
          config: configOf('{"enabled":true}'),
          user: user(),
          isGuest: false,
          isLicensed: true,
          toolResults: retrievalParts,
          messages: [inlinedDocumentMessage],
        } as any),
      ).toEqual({});
    });

    // The wrapper is produced on user messages only. An assistant that quotes
    // the string is not evidence the model was given a document — and when it
    // genuinely was, the user message carrying it suppresses anyway.
    it("still emits when only an ASSISTANT message mentions the wrapper", () => {
      const meta = claimCheckMetadata({
        config: configOf('{"enabled":true}'),
        user: user(),
        isGuest: false,
        isLicensed: true,
        toolResults: retrievalParts,
        messages: [
          textMessage,
          { id: "m2", role: "assistant", parts: [{ type: "text", text: 'Du schriebst <file file name = "x" >' }] },
        ],
      } as any);
      expect(meta).toEqual({ claimCheck: { enabled: true, sources: retrievalSources } });
    });

    // An extraction failure hands the model an error string, not the
    // document, so there is no invisible evidence to suppress for.
    it("still emits when the attachment failed to extract (an error marker, not content)", () => {
      const meta = claimCheckMetadata({
        config: configOf('{"enabled":true}'),
        user: user(),
        isGuest: false,
        isLicensed: true,
        toolResults: retrievalParts,
        messages: [
          { id: "m1", role: "user", parts: [{ type: "text", text: "[Error: Could not load file wartung.pdf]" }] },
        ],
      } as any);
      expect(meta).toEqual({ claimCheck: { enabled: true, sources: retrievalSources } });
    });

    it("treats a malformed messages argument as no signal rather than throwing", () => {
      expect(() =>
        claimCheckMetadata({
          config: configOf('{"enabled":true}'),
          user: user(),
          isGuest: false,
          isLicensed: true,
          toolResults: retrievalParts,
          messages: "not an array" as unknown,
        } as any),
      ).not.toThrow();
    });

    // Step 1's own case, verbatim: a fresh message array carrying only the
    // wrapper, with no prior history at all.
    it("is absent when an attachment was carried, as before", () => {
      const out = claimCheckMetadata({
        config: configOf('{"enabled":true}'),
        user: user(),
        isGuest: false,
        isLicensed: true,
        toolResults: retrievalParts,
        messages: [{ role: "user", parts: [{ type: "text", text: '<file file name = "wartung.pdf" >…</file>' }] }],
      } as any);
      expect(out).toEqual({});
    });
  });

  // Fix round 2, Critical 1 → Stage 4: a recalled memory is injected into the
  // SYSTEM prompt, never into a tool result, so this fragment cannot see it
  // directly — but it CAN now name it as a `memory` entry built from
  // `recalledMemories`, the same list the memories panel already renders, as
  // long as this viewer is allowed to see that list at all.
  describe("a memory was recalled this turn", () => {
    // Review round 1, finding 3: pinned with toEqual on the full array (memory
    // entries first — manifestFor's own order), not a toContainEqual that
    // would pass even if the knowledge_base half silently vanished — this is
    // exactly spec §8's "a memory turn with retrieval produces a complete
    // check... a fragment carrying both kinds".
    it("names a recalled memory as a memory entry with no tool call, alongside the knowledge_base entries", () => {
      const out = claimCheckMetadata({
        config: configOf('{"enabled":true}'),
        user: user(),
        isGuest: false,
        isLicensed: true,
        toolResults: retrievalParts,
        messages: [],
        recallHadItems: true,
        recalledMemories: [{ id: "m_7", title: "Sprache", information: "Der Kunde bevorzugt Deutsch." }],
      } as any) as any;
      expect(out.claimCheck.sources).toEqual([{ type: "memory", id: "memory:m_7" }, ...retrievalSources]);
    });

    // Review round 1, finding 2 (promoted from Minor): RecalledMemory.information
    // can legitimately be "" (a row with neither information nor description —
    // recall-collector.ts:71), and the client omits a memory whose information
    // is blank. Naming it anyway is an entry the client cannot fulfil, and
    // F3's guard refuses the WHOLE check over any one such entry — not a
    // degraded source, a silent total loss of checking on that turn.
    it("does not name a memory entry whose information is blank", () => {
      const out = claimCheckMetadata({
        config: configOf('{"enabled":true}'),
        user: user(),
        isGuest: false,
        isLicensed: true,
        toolResults: retrievalParts,
        messages: [],
        recallHadItems: true,
        recalledMemories: [{ id: "m_8", information: "" }, { id: "m_9", information: "   " }],
      } as any) as any;
      expect(out.claimCheck.sources.some((s: any) => s.type === "memory")).toBe(false);
      expect(out.claimCheck.sources.length).toBeGreaterThan(0); // the kb sources still count
    });

    // information is read purely as an inclusion test and must never reach
    // the produced entry itself — the fragment stays ids-only.
    it("never puts memory information on the entry it names", () => {
      const out = claimCheckMetadata({
        config: configOf('{"enabled":true}'),
        user: user(),
        isGuest: false,
        isLicensed: true,
        toolResults: retrievalParts,
        messages: [],
        recallHadItems: true,
        recalledMemories: [{ id: "m_7", information: "Der Kunde bevorzugt Deutsch." }],
      } as any) as any;
      expect(JSON.stringify(out)).not.toContain("Deutsch");
    });

    // Stage 4 spec §5 and §8's own testing bullet: "A guest turn whose memory
    // list was withheld produces no fragment." recalledMemoriesMetadata
    // withholds `recalledMemories` from a gated guest even though recall
    // genuinely found something (recallHadItems stays true) — the model saw
    // real memory evidence this viewer's client can never recover, so the
    // WHOLE fragment stays absent, exactly as it would for an attachment or
    // view_document_page. (An earlier draft of this test asserted the
    // opposite — that the knowledge_base source should still be named while
    // only the memory one was dropped. That is the §4-guard failure the
    // spec's own language rules out: naming partial evidence here is no
    // safer than an outright false "unsupported", it just moves where the
    // dishonesty happens from the panel into a silently incomplete check.)
    it("is ABSENT when the recall had items but this viewer may not see them, even though a knowledge-base source exists", () => {
      const out = claimCheckMetadata({
        config: configOf('{"enabled":true,"showToExternalUsers":true}'),
        user: user({ role: { id: "r1", name: "external" } }),
        isGuest: true,
        isLicensed: true,
        toolResults: retrievalParts,
        messages: [],
        recallHadItems: true,
        recalledMemories: undefined, // what recalledMemoriesMetadata returns for a gated guest
      } as any);
      expect(out).toEqual({});
    });

    it("still emits when the recall ran and found nothing", () => {
      expect(
        claimCheckMetadata({
          config: configOf('{"enabled":true}'),
          user: user(),
          isGuest: false,
          isLicensed: true,
          toolResults: retrievalParts,
          messages: [],
          recallHadItems: false,
          recalledMemories: undefined,
        } as any),
      ).toEqual({ claimCheck: { enabled: true, sources: retrievalSources } });
    });

    it("still emits when there was no recall collector at all (memory off)", () => {
      expect(
        claimCheckMetadata({
          config: configOf('{"enabled":true}'),
          user: user(),
          isGuest: false,
          isLicensed: true,
          toolResults: retrievalParts,
          messages: [],
        } as any),
      ).toEqual({ claimCheck: { enabled: true, sources: retrievalSources } });
    });

    // Step 1's own case, verbatim (spec §8: "a memory turn with retrieval
    // produces a complete check — a fragment carrying both kinds").
    it("still emits for a turn with retrieval alone", () => {
      const out = claimCheckMetadata({
        config: configOf('{"enabled":true}'),
        user: user(),
        isGuest: false,
        isLicensed: true,
        toolResults: retrievalParts,
      } as any) as any;
      expect(out.claimCheck.sources).toHaveLength(2);
    });
  });
});

// Fix round 1, Minor 5: the raw-stream accumulation glue routes.ts relies on,
// unit-tested against literal stream parts instead of only provable via a
// live SDK stream.
describe("recordToolResult", () => {
  it("records a tool call's final (non-preliminary) result", () => {
    const acc: { type: string; toolCallId: string; output: unknown }[] = [];
    recordToolResult(acc, {
      type: "tool-result",
      toolName: "Context_Search",
      toolCallId: "call_1",
      output: { result: "{}" },
      preliminary: undefined,
    });
    expect(acc).toEqual([{ type: "tool-Context_Search", toolCallId: "call_1", output: { result: "{}" } }]);
  });

  it("skips a streaming tool's preliminary (intermediate) yields", () => {
    const acc: { type: string; toolCallId: string; output: unknown }[] = [];
    recordToolResult(acc, {
      type: "tool-result",
      toolName: "Context_Search",
      toolCallId: "call_1",
      output: { result: "{}" },
      preliminary: true,
    });
    expect(acc).toEqual([]);
  });

  it("ignores any other stream part type", () => {
    const acc: { type: string; toolCallId: string; output: unknown }[] = [];
    recordToolResult(acc, { type: "finish-step" });
    recordToolResult(acc, { type: "text-delta" });
    expect(acc).toEqual([]);
  });

  // Fix round 2, Minor 5: it recorded EVERY tool's final output by reference
  // for the whole turn — sandbox bash, image generation, MCP, everything — so
  // a 20-tool turn held 20 entries the fragment could never read.
  it("ignores a tool whose output the fragment cannot use", () => {
    const acc: { type: string; toolCallId: string; output: unknown }[] = [];
    for (const toolName of ["bash", "image_generation", "writeFile", "Some_MCP_Tool"]) {
      recordToolResult(acc, { type: "tool-result", toolName, toolCallId: "c1", output: { huge: "…" } });
    }
    expect(acc).toEqual([]);
  });

  it("records every part type the fragment reads, including the suppression signals", () => {
    // A suppression signal that failed to be recorded would not be a smaller
    // accumulator, it would be a FALSE "unsupported" verdict — so this is the
    // half of the filter that matters.
    const acc: { type: string; toolCallId: string; output: unknown }[] = [];
    const recorded = [
      sanitizeToolName(AGENTIC_RETRIEVAL_TOOL_NAME),
      sanitizeToolName(SESSION_ITEMS_RETRIEVAL_TOOL_NAME),
      sanitizeToolName(SESSION_FILE_READ_TOOL_NAME),
      sanitizeToolName(PARSE_DOCUMENT_TOOL_NAME),
      sanitizeToolName(VIEW_DOCUMENT_PAGE_TOOL_NAME),
      sanitizeToolName(INTERNET_SEARCH_TOOL_NAME),
    ];
    for (const toolName of recorded) {
      recordToolResult(acc, { type: "tool-result", toolName, toolCallId: "c1", output: { result: "[]" } });
    }
    expect(acc.map((e) => e.type)).toEqual(recorded.map((n) => `tool-${n}`));
  });

  it("keeps the recorded set exactly the union of the types claimCheckMetadata reads", () => {
    expect([...RECORDED_PART_TYPES].sort()).toEqual(
      [
        ...RETRIEVAL_PART_TYPES,
        partTypeOf(SESSION_FILE_READ_TOOL_NAME),
        partTypeOf(PARSE_DOCUMENT_TOOL_NAME),
        partTypeOf(INTERNET_SEARCH_TOOL_NAME),
        partTypeOf(SESSION_ITEMS_RETRIEVAL_TOOL_NAME),
        ...INVISIBLE_EVIDENCE_PART_TYPES,
      ].sort(),
    );
  });
});

// Fix round 2, Important 2: the accumulate-then-emit pair IS the feature's
// switch, and it lived as two unconnected statements inside a 5,000-line
// route factory, so nothing failed if the fragment never reached the client.
// It is one function now, exercised over a literal stream sequence.
describe("claimCheckStreamMetadata", () => {
  /** What streamText pushes past messageMetadata for a one-retrieval turn. */
  const streamParts = [
    { type: "start" },
    { type: "start-step" },
    {
      type: "tool-result",
      toolName: "Context_Search",
      toolCallId: "call_1",
      output: { result: JSON.stringify({ chunks: [{ item_id: "i1" }] }) },
      preliminary: true,
    },
    {
      type: "tool-result",
      toolName: "Context_Search",
      toolCallId: "call_1",
      output: { result: JSON.stringify({ chunks: [{ item_id: "i1" }, { item_id: "i2" }] }) },
    },
    { type: "text-delta", text: "Die FST-2XT …" },
    { type: "finish-step" },
    { type: "finish" },
  ];

  const ctxFor = (claimCheck: string) => ({
    config: configOf(claimCheck),
    user: user(),
    isGuest: false,
    isLicensed: true,
    messages: [],
  });

  it("emits the fragment on the finish part, and nothing before it", () => {
    const onPart = claimCheckStreamMetadata(ctxFor('{"enabled":true}') as any);
    const emitted = streamParts.map((part) => onPart(part as never));

    for (const [i, out] of emitted.slice(0, -1).entries()) {
      expect([i, out]).toEqual([i, {}]);
    }
    // The final (non-preliminary) result only, deduplicated, with the call id.
    expect(emitted.at(-1)).toEqual({
      claimCheck: { enabled: true, sources: [{ type: "knowledge_base", id: "i1", toolCallId: "call_1" }, { type: "knowledge_base", id: "i2", toolCallId: "call_1" }] },
    });
  });

  it("emits nothing at all when the agent has the check disabled", () => {
    const onPart = claimCheckStreamMetadata(ctxFor('{"enabled":false}') as any);
    for (const part of streamParts) expect(onPart(part as never)).toEqual({});
  });

  it("reads the agent's claim_check config exactly once per turn", () => {
    // M7: routes.ts parsed it for the accumulation flag and claimCheckMetadata
    // parsed it again for the gates — two reads of the same blob that could
    // disagree. The config is parsed by the caller now and handed in, so the
    // turn has one source of truth. Proven by the shape of the ctx: a plain
    // parsed config object, with no agent to re-parse.
    const ctx = ctxFor('{"enabled":true}');
    expect(ctx.config).toEqual(expect.objectContaining({ enabled: true }));
    expect(ctx).not.toHaveProperty("agent");
  });

  // Important 2, third guardrail: agentic retrieval's output is exempt from
  // the tool-output offload only by a Set literal in an unrelated file. Drop
  // it — a plausible future cost decision — and guardToolOutput replaces the
  // output with { truncated, notice, preview }, which has no `result` key, so
  // chunkItemIdsOf skips it and claim-check silently stops working on exactly
  // the large turns it was built for. This is what that failure looks like.
  it("emits nothing when the retrieval output was offloaded (no result key)", () => {
    const onPart = claimCheckStreamMetadata(ctxFor('{"enabled":true}') as any);
    onPart({
      type: "tool-result",
      toolName: "Context_Search",
      toolCallId: "call_1",
      output: { truncated: true, notice: "stored as tool-output-Context_Search-ab12.txt", preview: "…" },
    } as never);
    expect(onPart({ type: "finish" } as never)).toEqual({});
  });

  // recalledMemories/recallHadItems must be read lazily — at `finish` time,
  // not when the ctx object is constructed — because routes.ts builds this
  // ctx (and the collector it is backed by) before the stream has run. A
  // getter on the ctx object is exactly how routes.ts achieves that; this
  // proves claimCheckStreamMetadata reads it at the right time rather than
  // snapshotting it at construction.
  it("reads recalledMemories/recallHadItems lazily, at finish time", () => {
    let recallHadItems = false;
    const ctx = {
      ...ctxFor('{"enabled":true}'),
      get recallHadItems() {
        return recallHadItems;
      },
      get recalledMemories() {
        return recallHadItems ? [{ id: "m_1", information: "Der Kunde bevorzugt Deutsch." }] : undefined;
      },
    };
    const onPart = claimCheckStreamMetadata(ctx as any);
    // "Recall" resolves mid-stream, after the ctx object was built.
    recallHadItems = true;
    for (const part of streamParts.slice(0, -1)) onPart(part as never);
    const out = onPart({ type: "finish" } as never) as any;
    expect(out.claimCheck.sources).toContainEqual({ type: "memory", id: "memory:m_1" });
  });
});
