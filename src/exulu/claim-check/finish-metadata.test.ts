import { claimCheckMetadata, recordToolResult, RETRIEVAL_PART_TYPES } from "./finish-metadata";
import { AGENTIC_RETRIEVAL_TOOL_NAME } from "@EE/agentic-retrieval/pipeline/index";
import { SESSION_ITEMS_RETRIEVAL_TOOL_NAME } from "@SRC/templates/tools/session-items-retrieval-tool";
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

describe("claimCheckMetadata", () => {
  it("emits ids only — never chunk content — when the check is enabled", () => {
    const meta = claimCheckMetadata({
      agent: agentWith('{"enabled":true}'),
      user: user(),
      isGuest: false,
      toolResults: retrievalParts,
    });
    expect(meta).toEqual({
      claimCheck: { enabled: true, sourceIds: ["i1", "i2"], toolCallIds: ["call_1"] },
    });
    expect(JSON.stringify(meta)).not.toContain("chunk_content");
  });

  it("is ABSENT when the agent has the check disabled", () => {
    expect(
      claimCheckMetadata({ agent: agentWith('{"enabled":false}'), user: user(), isGuest: false, toolResults: retrievalParts }),
    ).toEqual({});
  });

  it("is ABSENT when the agent has no claim_check config at all (default off)", () => {
    expect(
      claimCheckMetadata({ agent: { id: "a", tools: [] } as any, user: user(), isGuest: false, toolResults: retrievalParts }),
    ).toEqual({});
  });

  // Review Focus 5
  it("is ABSENT, not a throw, when the claim_check blob is malformed JSON", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        claimCheckMetadata({ agent: agentWith("{not json"), user: user(), isGuest: false, toolResults: retrievalParts }),
      ).toEqual({});
    } finally {
      warn.mockRestore();
    }
  });

  // Review Focus 1
  it("is ABSENT when the turn made no retrieval call", () => {
    const noRetrieval = [{ type: "step-start" }, { type: "text", text: "Gern!" }];
    expect(
      claimCheckMetadata({ agent: agentWith('{"enabled":true}'), user: user(), isGuest: false, toolResults: noRetrieval }),
    ).toEqual({});
  });

  it("is ABSENT when retrieval ran but returned no chunks", () => {
    const empty = [
      { type: "tool-Context_Search", toolCallId: "call_1", output: { result: JSON.stringify({ chunks: [] }) } },
    ];
    expect(
      claimCheckMetadata({ agent: agentWith('{"enabled":true}'), user: user(), isGuest: false, toolResults: empty }),
    ).toEqual({});
  });

  // Review Focus 2
  it("is ABSENT for an external viewer when showToExternalUsers is false, even with the check enabled", () => {
    const meta = claimCheckMetadata({
      agent: agentWith('{"enabled":true,"showToExternalUsers":false}'),
      user: user({ role: { id: "r1", name: "external" } }),
      isGuest: false,
      toolResults: retrievalParts,
    });
    expect(meta).toEqual({});
  });

  it("is emitted for an external viewer when showToExternalUsers is true", () => {
    const meta = claimCheckMetadata({
      agent: agentWith('{"enabled":true,"showToExternalUsers":true}'),
      user: user({ role: { id: "r1", name: "external" } }),
      isGuest: false,
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
      agent: agentWith('{"enabled":true,"showToExternalUsers":false}'),
      user: user(), // internal: no external role
      isGuest: true, // ...but on the public surface
      toolResults: retrievalParts,
    });
    expect(meta).toEqual({});
  });

  it("is emitted for a signed-in internal user on the public surface when showToExternalUsers is true", () => {
    const meta = claimCheckMetadata({
      agent: agentWith('{"enabled":true,"showToExternalUsers":true}'),
      user: user(),
      isGuest: true,
      toolResults: retrievalParts,
    });
    expect(meta).toEqual({
      claimCheck: { enabled: true, sourceIds: ["i1", "i2"], toolCallIds: ["call_1"] },
    });
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
    const meta = claimCheckMetadata({ agent: agentWith('{"enabled":true}'), user: user(), isGuest: false, toolResults: twoCalls }) as any;
    expect(meta.claimCheck.sourceIds).toEqual(["i2", "i1", "i3"]);
    expect(meta.claimCheck.toolCallIds).toEqual(["call_1", "call_2"]);
  });

  it("survives a tool output that is not valid JSON without throwing", () => {
    const broken = [{ type: "tool-Context_Search", toolCallId: "call_1", output: { result: "<<not json>>" } }];
    expect(
      claimCheckMetadata({ agent: agentWith('{"enabled":true}'), user: user(), isGuest: false, toolResults: broken }),
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
        claimCheckMetadata({ agent: agentWith('{"enabled":true}'), user: user(), isGuest: false, toolResults: both }),
      ).toEqual({});
    });

    it("still emits the normal fragment when the session-items tool returned an empty array", () => {
      const both = [
        ...retrievalParts,
        { type: sessionItemsPartType, toolCallId: "call_2", output: { result: JSON.stringify([]) } },
      ];
      const meta = claimCheckMetadata({ agent: agentWith('{"enabled":true}'), user: user(), isGuest: false, toolResults: both });
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
        claimCheckMetadata({ agent: agentWith('{"enabled":true}'), user: user(), isGuest: false, toolResults: both }),
      ).toEqual({});
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
