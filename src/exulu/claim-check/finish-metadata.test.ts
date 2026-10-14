import { claimCheckMetadata } from "./finish-metadata";

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
      toolResults: retrievalParts,
    });
    expect(meta).toEqual({
      claimCheck: { enabled: true, sourceIds: ["i1", "i2"], toolCallIds: ["call_1"] },
    });
    expect(JSON.stringify(meta)).not.toContain("chunk_content");
  });

  it("is ABSENT when the agent has the check disabled", () => {
    expect(claimCheckMetadata({ agent: agentWith('{"enabled":false}'), user: user(), toolResults: retrievalParts })).toEqual({});
  });

  it("is ABSENT when the agent has no claim_check config at all (default off)", () => {
    expect(claimCheckMetadata({ agent: { id: "a", tools: [] } as any, user: user(), toolResults: retrievalParts })).toEqual({});
  });

  // Review Focus 5
  it("is ABSENT, not a throw, when the claim_check blob is malformed JSON", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(claimCheckMetadata({ agent: agentWith("{not json"), user: user(), toolResults: retrievalParts })).toEqual({});
    } finally {
      warn.mockRestore();
    }
  });

  // Review Focus 1
  it("is ABSENT when the turn made no retrieval call", () => {
    const noRetrieval = [{ type: "step-start" }, { type: "text", text: "Gern!" }];
    expect(claimCheckMetadata({ agent: agentWith('{"enabled":true}'), user: user(), toolResults: noRetrieval })).toEqual({});
  });

  it("is ABSENT when retrieval ran but returned no chunks", () => {
    const empty = [
      { type: "tool-Context_Search", toolCallId: "call_1", output: { result: JSON.stringify({ chunks: [] }) } },
    ];
    expect(claimCheckMetadata({ agent: agentWith('{"enabled":true}'), user: user(), toolResults: empty })).toEqual({});
  });

  // Review Focus 2
  it("is ABSENT for an external viewer when showToExternalUsers is false, even with the check enabled", () => {
    const meta = claimCheckMetadata({
      agent: agentWith('{"enabled":true,"showToExternalUsers":false}'),
      user: user({ role: { id: "r1", name: "external" } }),
      toolResults: retrievalParts,
    });
    expect(meta).toEqual({});
  });

  it("is emitted for an external viewer when showToExternalUsers is true", () => {
    const meta = claimCheckMetadata({
      agent: agentWith('{"enabled":true,"showToExternalUsers":true}'),
      user: user({ role: { id: "r1", name: "external" } }),
      toolResults: retrievalParts,
    });
    expect(meta).toEqual({
      claimCheck: { enabled: true, sourceIds: ["i1", "i2"], toolCallIds: ["call_1"] },
    });
  });

  it("deduplicates source ids across several retrieval calls and keeps first-seen order", () => {
    const twoCalls = [
      { type: "tool-Context_Search", toolCallId: "call_1", output: { result: JSON.stringify({ chunks: [{ item_id: "i2" }, { item_id: "i1" }] }) } },
      { type: "tool-Knowledge_context_search", toolCallId: "call_2", output: { result: JSON.stringify({ chunks: [{ item_id: "i1" }, { item_id: "i3" }] }) } },
    ];
    const meta = claimCheckMetadata({ agent: agentWith('{"enabled":true}'), user: user(), toolResults: twoCalls }) as any;
    expect(meta.claimCheck.sourceIds).toEqual(["i2", "i1", "i3"]);
    expect(meta.claimCheck.toolCallIds).toEqual(["call_1", "call_2"]);
  });

  it("survives a tool output that is not valid JSON without throwing", () => {
    const broken = [{ type: "tool-Context_Search", toolCallId: "call_1", output: { result: "<<not json>>" } }];
    expect(claimCheckMetadata({ agent: agentWith('{"enabled":true}'), user: user(), toolResults: broken })).toEqual({});
  });
});
