jest.mock("@EE/agentic-retrieval/pipeline/search", () => ({ searchContexts: jest.fn() }));
import { searchContexts } from "@EE/agentic-retrieval/pipeline/search";
import { makeSecondChance } from "./second-chance";

const CONTEXTS = [{ id: "handbuecher", name: "Handbücher" }, { id: "tickets", name: "Tickets" }] as any[];

const agentWith = (claimCheck: string, knowledgeBases?: string) => ({
  id: "agent-1",
  tools: [
    {
      id: "agentic_context_search",
      config: [
        { name: "claim_check", variable: claimCheck, type: "json" },
        ...(knowledgeBases ? [{ name: "knowledge_bases", variable: knowledgeBases, type: "json" }] : []),
      ],
    },
  ],
});

beforeEach(() => (searchContexts as jest.Mock).mockReset());

describe("makeSecondChance", () => {
  it("searches the agent's enabled contexts and returns ranked snippets", async () => {
    (searchContexts as jest.Mock).mockResolvedValue({
      chunks: [
        { chunk_id: "k1", item_id: "i1", item_name: "handbuch.pdf", chunk_content: "Die FST-2XT arbeitet mit 230 Volt." },
        { chunk_id: "k2", item_id: "i2", item_name: "anderes.pdf", chunk_content: "Unverwandter Inhalt über Türen." },
      ],
    });

    const secondChance = makeSecondChance({
      agent: agentWith('{"enabled":true}', '{"handbuecher":{"enabled":true},"tickets":{"enabled":false}}'),
      user: { id: 7 } as any,
      model: {} as any,
      contexts: CONTEXTS,
      cap: 5,
    });

    const snippets = await secondChance!("Die FST-2XT arbeitet mit 230 Volt.");
    expect((searchContexts as jest.Mock).mock.calls[0][0].contextIds).toEqual(["handbuecher"]);
    expect(snippets[0]!.text).toContain("230 Volt");
    expect(snippets[0]!.sourceId).toBe("i1");
  });

  it("returns undefined when the agent has no retrieval tool or no enabled context", () => {
    expect(makeSecondChance({ agent: { id: "a", tools: [] }, model: {} as any, contexts: CONTEXTS, cap: 5 })).toBeUndefined();
    expect(
      makeSecondChance({
        agent: agentWith('{"enabled":true}', '{"handbuecher":{"enabled":false},"tickets":{"enabled":false}}'),
        model: {} as any,
        contexts: CONTEXTS,
        cap: 5,
      }),
    ).toBeUndefined();
  });

  it("stops searching once the cap is spent", async () => {
    (searchContexts as jest.Mock).mockResolvedValue({ chunks: [] });
    const secondChance = makeSecondChance({
      agent: agentWith('{"enabled":true}'),
      model: {} as any,
      contexts: CONTEXTS,
      cap: 2,
    })!;
    await secondChance("eins");
    await secondChance("zwei");
    await secondChance("drei");
    expect((searchContexts as jest.Mock).mock.calls.length).toBe(2);
  });

  it("swallows a retrieval failure and returns no snippets, leaving the first verdict standing", async () => {
    (searchContexts as jest.Mock).mockRejectedValue(new Error("vector search down"));
    const secondChance = makeSecondChance({
      agent: agentWith('{"enabled":true}'),
      model: {} as any,
      contexts: CONTEXTS,
      cap: 5,
    })!;
    // Expected noise: the implementation warns on a swallowed failure (see
    // second-chance.ts); spied so it doesn't dirty test output, same as
    // routes.test.ts does for its own swallowed-error case.
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(secondChance("eine Aussage")).resolves.toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
