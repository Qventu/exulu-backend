jest.mock("@EE/agentic-retrieval/pipeline/micro-call", () => ({
  microCall: jest.fn(),
  microCallProviderOptions: jest.fn(),
}));
import { microCall } from "@EE/agentic-retrieval/pipeline/micro-call";
import { splitIntoSentences, buildWindows } from "../split";
import { runDisambiguation } from "./disambiguate";
import { CLAIM_CHECK_MAX_OUTPUT_TOKENS } from "../types";

const ANSWER = "Die FST-2XT meldet einen Fehler. Sie wurde dort getauscht.";
const windows = () => buildWindows(splitIntoSentences(ANSWER, "de"), 5, 0);

beforeEach(() => (microCall as jest.Mock).mockReset());

describe("runDisambiguation", () => {
  it("returns the clarified sentence when every ambiguity resolves", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: {
        sentences: [
          { index: 0, resolvable: true, clarified: null, reason: "no ambiguity" },
          { index: 1, resolvable: true, clarified: "Die FST-2XT wurde im Schaltschrank getauscht.", reason: "'Sie' and 'dort' resolved from context" },
        ],
      },
      text: "",
      usage: { inputTokens: 800, outputTokens: 90 },
    });

    const { outcomes, usage } = await runDisambiguation({
      windows: windows(),
      question: "Was wurde getauscht?",
      sentenceTexts: new Map(),
      model: {} as any,
    });

    expect(usage).toEqual({ calls: 1, inputTokens: 800, outputTokens: 90 });
    expect(outcomes[1]).toEqual({
      index: 1,
      resolvable: true,
      clarified: "Die FST-2XT wurde im Schaltschrank getauscht.",
      reason: "'Sie' and 'dort' resolved from context",
    });
  });

  it("marks a sentence unresolvable when readers would not reach consensus", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: {
        sentences: [{ index: 0, resolvable: false, clarified: null, reason: "two mutually exclusive readings" }],
      },
      text: "",
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const { outcomes } = await runDisambiguation({
      windows: windows().slice(0, 1),
      question: "q",
      sentenceTexts: new Map(),
      model: {} as any,
    });
    expect(outcomes[0]!.resolvable).toBe(false);
    expect(outcomes[0]!.clarified).toBeNull();
  });

  it("judges Selection's rewrite rather than the original sentence", async () => {
    (microCall as jest.Mock).mockResolvedValue({ output: { sentences: [] }, text: "", usage: { inputTokens: 1, outputTokens: 1 } });
    await runDisambiguation({
      windows: windows(),
      question: "q",
      sentenceTexts: new Map([[0, "Die FST-2XT meldet einen Fehler."], [1, "Sie wurde getauscht."]]),
      model: {} as any,
    });
    const prompt = String((microCall as jest.Mock).mock.calls[0][0].prompt);
    expect(prompt).toContain("[1] Sie wurde getauscht.");
    expect(prompt).not.toContain("Sie wurde dort getauscht.");
  });

  it("treats an omitted sentence as unresolvable and passes the raised output cap", async () => {
    (microCall as jest.Mock).mockResolvedValue({ output: { sentences: [] }, text: "", usage: { inputTokens: 1, outputTokens: 1 } });
    const { outcomes } = await runDisambiguation({
      windows: windows(),
      question: "q",
      sentenceTexts: new Map(),
      model: {} as any,
    });
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.resolvable === false)).toBe(true);
    expect(outcomes[0]!.reason).toBe("no disambiguation returned for this sentence");
    expect((microCall as jest.Mock).mock.calls[0][0].maxOutputTokens).toBe(CLAIM_CHECK_MAX_OUTPUT_TOKENS);
  });
});
