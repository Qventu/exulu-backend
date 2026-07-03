// ee/agentic-retrieval/pipeline/routing.test.ts
import { runRoutingPhase } from "./routing";

jest.mock("ai", () => ({ generateText: jest.fn(), Output: { object: (x: any) => x } }));
jest.mock("./prefilter", () => ({ fuzzyPrefilter: jest.fn(async () => []) }));
import { generateText } from "ai";
import { fuzzyPrefilter } from "./prefilter";

const enabled = [
  { id: "docs", name: "Docs", description: "manuals" },
  { id: "tickets", name: "Tickets", description: "support" },
];
const noHints = { output: { hasFilenameHint: false, filenameHints: [], hasPageHint: false, pageNumber: null } };
const noExplicit = { output: { explicitlyRequestedKnowledgeBases: [] } };

beforeEach(() => { (generateText as jest.Mock).mockReset(); (fuzzyPrefilter as jest.Mock).mockClear(); });

describe("runRoutingPhase", () => {
  it("explicit KB request wins and yields no fallback", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce(noHints)
      .mockResolvedValueOnce({ output: { explicitlyRequestedKnowledgeBases: ["tickets"] } });
    const r = await runRoutingPhase({
      question: "search tickets for X", enabledContexts: enabled, documentContexts: [],
      routingRules: [{ id: "t", label: "T", description: "d", main: ["docs"], fallback: ["tickets"] }],
      preselectedItems: new Map(), model: {},
    });
    expect(r.mainContexts).toEqual(["tickets"]);
    expect(r.fallbackContexts).toEqual([]);
    expect(generateText).toHaveBeenCalledTimes(2); // no classification call
  });

  it("classifies against configured rules when nothing is explicit", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce(noHints)
      .mockResolvedValueOnce(noExplicit)
      .mockResolvedValueOnce({ output: { ruleId: "t", reason: "because" } });
    const r = await runRoutingPhase({
      question: "how do I fix the door?", enabledContexts: enabled, documentContexts: [],
      routingRules: [{ id: "t", label: "T", description: "d", main: ["docs"], fallback: ["tickets"] }],
      preselectedItems: new Map(), model: {},
    });
    expect(r.mainContexts).toEqual(["docs"]);
    expect(r.fallbackContexts).toEqual(["tickets"]);
  });

  it("with no rules everything enabled becomes main", async () => {
    (generateText as jest.Mock).mockResolvedValueOnce(noHints).mockResolvedValueOnce(noExplicit);
    const r = await runRoutingPhase({
      question: "q", enabledContexts: enabled, documentContexts: [], routingRules: [],
      preselectedItems: new Map(), model: {},
    });
    expect(r.mainContexts).toEqual(["docs", "tickets"]);
    expect(r.fallbackContexts).toEqual([]);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("resolves filename hints against document contexts and reports the page", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ output: { hasFilenameHint: true, filenameHints: ["manual X3"], hasPageHint: true, pageNumber: 12 } })
      .mockResolvedValueOnce(noExplicit);
    (fuzzyPrefilter as jest.Mock).mockResolvedValue([{ id: "42", name: "Manual X3", key: "k" }]);
    const docCtx = { id: "docs" };
    const r = await runRoutingPhase({
      question: "in manual X3 on page 12", enabledContexts: enabled, documentContexts: [docCtx],
      routingRules: [], preselectedItems: new Map(), model: {},
    });
    expect([...r.userPinnedItemIdsByContext.get("docs")!]).toEqual(["42"]);
    expect(r.userRequestedPage).toBe(12);
    expect(r.hasExplicitDocAndPage).toBe(true);
  });

  it("degrades to no pins when document-reference resolution fails", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ output: { hasFilenameHint: true, filenameHints: ["manual X3"], hasPageHint: false, pageNumber: null } })
      .mockResolvedValueOnce(noExplicit);
    (fuzzyPrefilter as jest.Mock).mockRejectedValueOnce(new Error("getItems failed"));
    const r = await runRoutingPhase({
      question: "in manual X3", enabledContexts: enabled, documentContexts: [{ id: "docs" }],
      routingRules: [], preselectedItems: new Map(), model: {},
    });
    expect(r.userPinnedItemIdsByContext.size).toBe(0);
    expect(r.steps.some((s) => s.text.includes("continuing without file pins"))).toBe(true);
  });

  it("degrades to all-main when the classifier throws", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce(noHints)
      .mockResolvedValueOnce(noExplicit)
      .mockRejectedValue(new Error("down")); // withRetry exhausts on classification
    const r = await runRoutingPhase({
      question: "q", enabledContexts: enabled, documentContexts: [],
      routingRules: [{ id: "t", label: "T", description: "d", main: ["docs"], fallback: [] }],
      preselectedItems: new Map(), model: {},
    });
    expect(r.mainContexts).toEqual(["docs", "tickets"]);
  }, 30000); // withRetry backs off 2s+4s before exhausting
});
