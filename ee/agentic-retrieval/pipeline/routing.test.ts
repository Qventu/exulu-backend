// ee/agentic-retrieval/pipeline/routing.test.ts
import { runRoutingPhase } from "./routing";

jest.mock("ai", () => {
  const actual = jest.requireActual("ai");
  return { ...actual, generateText: jest.fn(), Output: { object: (x: any) => x } };
});
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

  it("discards doc-reference pins when the hint matches too many files (token-bomb regression)", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ output: { hasFilenameHint: true, filenameHints: ["FST-2XT"], hasPageHint: false, pageNumber: null } })
      .mockResolvedValueOnce(noExplicit);
    (fuzzyPrefilter as jest.Mock).mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ({ id: "f" + i, name: "file" + i + ".pdf", key: "k" + i })),
    );
    const r = await runRoutingPhase({
      question: "Was bedeutet der Fehler S2 CMP Input beim FST-2XT?",
      enabledContexts: enabled, documentContexts: [{ id: "docs" }],
      routingRules: [], preselectedItems: new Map(), model: {},
    });
    expect(r.userPinnedItemIdsByContext.size).toBe(0);
    expect(r.hasExplicitDocAndPage).toBe(false);
    expect(r.steps.some((s) => s.text.includes("too broad"))).toBe(true);
  });

  it("doc-reference prompt carries the file-marker rule and configured identifier examples", async () => {
    (generateText as jest.Mock).mockResolvedValueOnce(noHints).mockResolvedValueOnce(noExplicit);
    await runRoutingPhase({
      question: "q", enabledContexts: enabled, documentContexts: [], routingRules: [],
      preselectedItems: new Map(), knownIdentifiers: ["FST", "ECO", "CBM-2"], model: {},
    });
    const docCall = (generateText as jest.Mock).mock.calls.find(([args]) =>
      String(args?.system ?? "").includes("filename hint"),
    );
    expect(docCall).toBeDefined();
    expect(docCall![0].system).toContain("STRICT RULE");
    expect(docCall![0].system).toContain("FST, ECO, CBM-2");
    expect(docCall![0].system).toContain("NOT be treated as filenames");
  });

  it("explicit-KB prompt carries the topical-false-positive guard (newlkiag gate regression)", async () => {
    (generateText as jest.Mock).mockResolvedValueOnce(noHints).mockResolvedValueOnce(noExplicit);
    await runRoutingPhase({
      question: "Welche Software-Änderungen gab es zuletzt?", enabledContexts: enabled,
      documentContexts: [], routingRules: [], preselectedItems: new Map(), model: {},
    });
    const kbCall = (generateText as jest.Mock).mock.calls.find(([args]) =>
      String(args?.system ?? "").includes("EXPLICITLY asked"),
    );
    expect(kbCall).toBeDefined();
    expect(kbCall![0].system).toContain("is NOT an explicit request");
    expect(kbCall![0].system).toContain("When in doubt, return");
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

  it("sends thinking-disable provider options and the raised token cap on every micro-call (gemini)", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce(noHints)
      .mockResolvedValueOnce(noExplicit)
      .mockResolvedValueOnce({ output: { ruleId: "t", reason: "r" } });
    await runRoutingPhase({
      question: "how do I fix the door?", enabledContexts: enabled, documentContexts: [],
      routingRules: [{ id: "t", label: "T", description: "d", main: ["docs"], fallback: ["tickets"] }],
      preselectedItems: new Map(), model: { modelId: "vertex-gemini-3.5-flash" },
    });
    const calls = (generateText as jest.Mock).mock.calls;
    expect(calls.length).toBe(3);
    for (const [args] of calls) {
      expect(args.maxOutputTokens).toBe(2000);
      expect(args.maxRetries).toBe(0);
      expect(args.providerOptions).toEqual({ litellm: { reasoningEffort: "disable" } });
    }
  });

  it("degrades only the doc/page step when the model returns empty output (thinking-starvation regression)", async () => {
    const { NoOutputGeneratedError } = jest.requireActual("ai");
    (generateText as jest.Mock)
      .mockResolvedValueOnce({
        text: "",
        get output(): any {
          throw new NoOutputGeneratedError({ message: "No output generated." });
        },
      })
      .mockResolvedValueOnce(noExplicit);
    const r = await runRoutingPhase({
      question: "q", enabledContexts: enabled, documentContexts: [], routingRules: [],
      preselectedItems: new Map(), model: {},
    });
    // Empty output is deterministic: no blind retry, and only the one step degrades.
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(r.steps.some((s) => s.text.includes("Doc/page detection failed"))).toBe(true);
    expect(r.steps.some((s) => s.text.includes("Routing failed"))).toBe(false);
    expect(r.mainContexts).toEqual(["docs", "tickets"]);
  });
});
