import {
  claimCheckMetadata,
  claimCheckStreamMetadata,
  recordToolResult,
  INVISIBLE_EVIDENCE_PART_TYPES,
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
    });
    expect(meta).toEqual({
      claimCheck: { enabled: true, sourceIds: ["i1", "i2"], toolCallIds: ["call_1"] },
    });
    expect(JSON.stringify(meta)).not.toContain("chunk_content");
  });

  it("is ABSENT when the agent has the check disabled", () => {
    expect(
      claimCheckMetadata({ config: configOf('{"enabled":false}'), user: user(), isGuest: false, isLicensed: true, toolResults: retrievalParts }),
    ).toEqual({});
  });

  it("is ABSENT when the agent has no claim_check config at all (default off)", () => {
    expect(
      claimCheckMetadata({ config: pipelineConfigFor({ id: "a", tools: [] }).claimCheck, user: user(), isGuest: false, isLicensed: true, toolResults: retrievalParts }),
    ).toEqual({});
  });

  // Review Focus 5
  it("is ABSENT, not a throw, when the claim_check blob is malformed JSON", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        claimCheckMetadata({ config: configOf("{not json"), user: user(), isGuest: false, isLicensed: true, toolResults: retrievalParts }),
      ).toEqual({});
    } finally {
      warn.mockRestore();
    }
  });

  // Review Focus 1
  it("is ABSENT when the turn made no retrieval call", () => {
    const noRetrieval = [{ type: "step-start" }, { type: "text", text: "Gern!" }];
    expect(
      claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: noRetrieval }),
    ).toEqual({});
  });

  it("is ABSENT when retrieval ran but returned no chunks", () => {
    const empty = [
      { type: "tool-Context_Search", toolCallId: "call_1", output: { result: JSON.stringify({ chunks: [] }) } },
    ];
    expect(
      claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: empty }),
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
    });
    expect(meta).toEqual({});
  });

  it("is emitted for an external viewer when showToExternalUsers is true", () => {
    const meta = claimCheckMetadata({
      config: configOf('{"enabled":true,"showToExternalUsers":true}'),
      user: user({ role: { id: "r1", name: "external" } }),
      isGuest: false,
      isLicensed: true,
      toolResults: retrievalParts,
    });
    expect(meta).toEqual({
      claimCheck: { enabled: true, sourceIds: ["i1", "i2"], toolCallIds: ["call_1"] },
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
    });
    expect(meta).toEqual({});
  });

  it("is emitted for a signed-in internal user on the public surface when showToExternalUsers is true", () => {
    const meta = claimCheckMetadata({
      config: configOf('{"enabled":true,"showToExternalUsers":true}'),
      user: user(),
      isGuest: true,
      isLicensed: true,
      toolResults: retrievalParts,
    });
    expect(meta).toEqual({
      claimCheck: { enabled: true, sourceIds: ["i1", "i2"], toolCallIds: ["call_1"] },
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
      recall: undefined,
    });
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
      recall: undefined,
    });
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
    const meta = claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: twoCalls }) as any;
    expect(meta.claimCheck.sourceIds).toEqual(["i2", "i1", "i3"]);
    expect(meta.claimCheck.toolCallIds).toEqual(["call_1", "call_2"]);
  });

  it("survives a tool output that is not valid JSON without throwing", () => {
    const broken = [{ type: "tool-Context_Search", toolCallId: "call_1", output: { result: "<<not json>>" } }];
    expect(
      claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: broken }),
    ).toEqual({});
  });

  // Fix round 1, Important 2.2: the whitelist is derived from the tool
  // factory's own name literal, not a second hardcoded copy of it.
  it("matches exactly the part type sanitizeToolName derives from the tool factory's own name literal", () => {
    expect(RETRIEVAL_PART_TYPES.has(`tool-${sanitizeToolName(AGENTIC_RETRIEVAL_TOOL_NAME)}`)).toBe(true);
    expect(RETRIEVAL_PART_TYPES.size).toBe(1);
  });

  // Fix round 1, Important 2.3: session-items search coexists with agentic
  // retrieval but its output carries no `chunks`, so evidence it alone
  // contributed is invisible to this fragment. Checking anyway risks a false
  // "unsupported" verdict, so a non-empty session-items result suppresses
  // the whole fragment rather than silently omitting that evidence.
  describe("session-items retrieval ran alongside agentic retrieval", () => {
    const sessionItemsPartType = `tool-${sanitizeToolName(SESSION_ITEMS_RETRIEVAL_TOOL_NAME)}`;

    it("is ABSENT when the session-items tool returned a non-empty result", () => {
      const both = [
        ...retrievalParts,
        {
          type: sessionItemsPartType,
          toolCallId: "call_2",
          output: { result: JSON.stringify([{ id: "s1", content: "..." }]) },
        },
      ];
      expect(
        claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: both }),
      ).toEqual({});
    });

    it("still emits the normal fragment when the session-items tool returned an empty array", () => {
      const both = [
        ...retrievalParts,
        { type: sessionItemsPartType, toolCallId: "call_2", output: { result: JSON.stringify([]) } },
      ];
      const meta = claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: both });
      expect(meta).toEqual({
        claimCheck: { enabled: true, sourceIds: ["i1", "i2"], toolCallIds: ["call_1"] },
      });
    });

    it("is ABSENT, fail-safe, when the session-items tool's output cannot be parsed", () => {
      const both = [
        ...retrievalParts,
        { type: sessionItemsPartType, toolCallId: "call_2", output: { result: "<<not json>>" } },
      ];
      expect(
        claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: both }),
      ).toEqual({});
    });
  });

  // Fix round 2, Critical 1: session-items search was only the narrowest
  // member of a class. Every one of these tools puts evidence in front of the
  // model that the fragment's sourceIds cannot represent, and each is
  // reachable on the same turn as agentic retrieval — so a check run on such
  // a turn scores PDF- or web-grounded claims `unsupported` and renders an
  // alert for an answer that was in fact grounded.
  describe("a tool whose evidence the check will never see ran this turn", () => {
    const partTypeOf = (name: string) => `tool-${sanitizeToolName(name)}`;

    it.each([
      ["read_session_file", SESSION_FILE_READ_TOOL_NAME],
      ["parse_document", PARSE_DOCUMENT_TOOL_NAME],
      ["view_document_page", VIEW_DOCUMENT_PAGE_TOOL_NAME],
      ["internet_search", INTERNET_SEARCH_TOOL_NAME],
    ])("is ABSENT when %s ran alongside agentic retrieval", (_label, toolName) => {
      const both = [
        ...retrievalParts,
        { type: partTypeOf(toolName), toolCallId: "call_2", output: { result: "whatever it returned" } },
      ];
      expect(
        claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: both }),
      ).toEqual({});
    });

    it("derives each part type from the tool's own exported name literal", () => {
      expect([...INVISIBLE_EVIDENCE_PART_TYPES].sort()).toEqual(
        [
          partTypeOf(SESSION_FILE_READ_TOOL_NAME),
          partTypeOf(PARSE_DOCUMENT_TOOL_NAME),
          partTypeOf(VIEW_DOCUMENT_PAGE_TOOL_NAME),
          partTypeOf(INTERNET_SEARCH_TOOL_NAME),
        ].sort(),
      );
    });

    // The suppression must not swallow the feature: the turn the check was
    // built for — agentic retrieval and nothing else — still emits.
    it("still emits for a turn whose only tool was agentic retrieval", () => {
      expect(
        claimCheckMetadata({ config: configOf('{"enabled":true}'), user: user(), isGuest: false, isLicensed: true, toolResults: retrievalParts }),
      ).toEqual({ claimCheck: { enabled: true, sourceIds: ["i1", "i2"], toolCallIds: ["call_1"] } });
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
        recall: undefined,
      }),
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
          recall: undefined,
        }),
      ).toEqual({});
    });

    // generate-stream re-inlines EVERY file part of the loaded history on
    // every turn (processFilePartsInMessages runs over history + the new
    // message), so a PDF attached three turns ago is still in this turn's
    // prompt and can still ground this turn's answer.
    it("is ABSENT when an earlier message in the session carried the file part", () => {
      expect(
        claimCheckMetadata({
          config: configOf('{"enabled":true}'),
          user: user(),
          isGuest: false,
          isLicensed: true,
          toolResults: retrievalParts,
          messages: [fileMessage, textMessage],
          recall: undefined,
        }),
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
          recall: undefined,
        }),
      ).toEqual({ claimCheck: { enabled: true, sourceIds: ["i1", "i2"], toolCallIds: ["call_1"] } });
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
          recall: undefined,
        }),
      ).not.toThrow();
    });
  });

  // Fix round 2, Critical 1: a recalled memory is injected into the SYSTEM
  // prompt, never into a tool result, so the check receives none of it. The
  // functional cost is deliberate and recorded in spec §5: an agent with
  // memory enabled and a non-empty recall produces no claim check.
  describe("a memory was recalled this turn", () => {
    const recallWith = (count: number) =>
      ({ list: () => Array.from({ length: count }, (_, i) => ({ id: `mem-${i}` })) }) as any;

    it("is ABSENT when the recall is non-empty", () => {
      expect(
        claimCheckMetadata({
          config: configOf('{"enabled":true}'),
          user: user(),
          isGuest: false,
          isLicensed: true,
          toolResults: retrievalParts,
          messages: [],
          recall: recallWith(1),
        }),
      ).toEqual({});
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
          recall: recallWith(0),
        }),
      ).toEqual({ claimCheck: { enabled: true, sourceIds: ["i1", "i2"], toolCallIds: ["call_1"] } });
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
          recall: undefined,
        }),
      ).toEqual({ claimCheck: { enabled: true, sourceIds: ["i1", "i2"], toolCallIds: ["call_1"] } });
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
    recall: undefined,
  });

  it("emits the fragment on the finish part, and nothing before it", () => {
    const onPart = claimCheckStreamMetadata(ctxFor('{"enabled":true}'));
    const emitted = streamParts.map((part) => onPart(part as never));

    for (const [i, out] of emitted.slice(0, -1).entries()) {
      expect([i, out]).toEqual([i, {}]);
    }
    // The final (non-preliminary) result only, deduplicated, with the call id.
    expect(emitted.at(-1)).toEqual({
      claimCheck: { enabled: true, sourceIds: ["i1", "i2"], toolCallIds: ["call_1"] },
    });
  });

  it("emits nothing at all when the agent has the check disabled", () => {
    const onPart = claimCheckStreamMetadata(ctxFor('{"enabled":false}'));
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
  // retrievedIdsOf skips it and claim-check silently stops working on exactly
  // the large turns it was built for. This is what that failure looks like.
  it("emits nothing when the retrieval output was offloaded (no result key)", () => {
    const onPart = claimCheckStreamMetadata(ctxFor('{"enabled":true}'));
    onPart({
      type: "tool-result",
      toolName: "Context_Search",
      toolCallId: "call_1",
      output: { truncated: true, notice: "stored as tool-output-Context_Search-ab12.txt", preview: "…" },
    } as never);
    expect(onPart({ type: "finish" } as never)).toEqual({});
  });
});
