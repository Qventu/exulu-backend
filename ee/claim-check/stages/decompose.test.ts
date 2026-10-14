jest.mock("@EE/agentic-retrieval/pipeline/micro-call", () => ({
  microCall: jest.fn(),
  microCallProviderOptions: jest.fn(),
}));
import { microCall } from "@EE/agentic-retrieval/pipeline/micro-call";
import { splitIntoSentences, buildWindows } from "../split";
import { runDecomposition } from "./decompose";
import { CLAIM_CHECK_MAX_OUTPUT_TOKENS } from "../types";
import { SAME_LANGUAGE_RULE } from "../prompts/shared";

const ANSWER = "Die FST-2XT arbeitet mit 230 Volt und wird im Schaltschrank montiert.";
const windows = () => buildWindows(splitIntoSentences(ANSWER, "de"), 5, 0);

beforeEach(() => (microCall as jest.Mock).mockReset());

describe("runDecomposition", () => {
  it("splits a conjunction into independently checkable claims", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: {
        sentences: [
          {
            index: 0,
            claims: [
              { text: "Die FST-2XT arbeitet mit 230 Volt.", inferred: false },
              { text: "Die FST-2XT wird im Schaltschrank montiert.", inferred: false },
            ],
          },
        ],
      },
      text: "",
      usage: { inputTokens: 700, outputTokens: 150 },
    });

    const { outcomes, usage } = await runDecomposition({
      windows: windows(),
      question: "Womit arbeitet die FST-2XT?",
      sentenceTexts: new Map(),
      model: {} as any,
    });

    expect(usage).toEqual({ calls: 1, inputTokens: 700, outputTokens: 150 });
    expect(outcomes[0]!.claims).toHaveLength(2);
    expect(outcomes[0]!.claims[0]!.inferred).toBe(false);
  });

  it("keeps bracketed context and its inferred flag", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: {
        sentences: [{ index: 0, claims: [{ text: "Die FST-2XT [eine Aufzugssteuerung] arbeitet mit 230 Volt.", inferred: true }] }],
      },
      text: "",
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const { outcomes } = await runDecomposition({ windows: windows(), question: "q", sentenceTexts: new Map(), model: {} as any });
    expect(outcomes[0]!.claims[0]!.text).toContain("[eine Aufzugssteuerung]");
    expect(outcomes[0]!.claims[0]!.inferred).toBe(true);
  });

  it("returns an empty claim list when the model extracts nothing, without inventing one", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: { sentences: [{ index: 0, claims: [] }] },
      text: "",
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const { outcomes } = await runDecomposition({ windows: windows(), question: "q", sentenceTexts: new Map(), model: {} as any });
    expect(outcomes[0]!.claims).toEqual([]);
  });

  it("drops blank claim texts and claims for indexes not in the batch", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: {
        sentences: [
          { index: 0, claims: [{ text: "   ", inferred: false }, { text: "Gültige Aussage.", inferred: false }] },
          { index: 77, claims: [{ text: "Fremder Index.", inferred: false }] },
        ],
      },
      text: "",
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const { outcomes } = await runDecomposition({ windows: windows(), question: "q", sentenceTexts: new Map(), model: {} as any });
    expect(outcomes.map((o) => o.index)).toEqual([0]);
    expect(outcomes[0]!.claims.map((c) => c.text)).toEqual(["Gültige Aussage."]);
  });

  it("decomposes the disambiguated text when one was supplied", async () => {
    (microCall as jest.Mock).mockResolvedValue({ output: { sentences: [] }, text: "", usage: { inputTokens: 1, outputTokens: 1 } });
    await runDecomposition({
      windows: windows(),
      question: "q",
      sentenceTexts: new Map([[0, "Die FST-2XT arbeitet mit 230 Volt."]]),
      model: {} as any,
    });
    const prompt = String((microCall as jest.Mock).mock.calls[0][0].prompt);
    expect(prompt).toContain("[0] Die FST-2XT arbeitet mit 230 Volt.");
    expect(prompt).not.toContain("im Schaltschrank montiert");
  });

  it("passes the raised output cap and uses temperature 0", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: { sentences: [] },
      text: "",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await runDecomposition({
      windows: windows(),
      question: "q",
      sentenceTexts: new Map(),
      model: {} as any,
    });
    const args = (microCall as jest.Mock).mock.calls[0][0];
    expect(args.maxOutputTokens).toBe(CLAIM_CHECK_MAX_OUTPUT_TOKENS);
    expect(args.temperature).toBe(0);
  });
  // Finding 10: see select.test.ts.
  it("pins the output language in the system prompt", async () => {
    (microCall as jest.Mock).mockResolvedValue({ output: { sentences: [] }, text: "", usage: { inputTokens: 1, outputTokens: 1 } });
    await runDecomposition({ windows: windows(), question: "q", sentenceTexts: new Map(), model: {} as any });
    expect(String((microCall as jest.Mock).mock.calls[0][0].system)).toContain(SAME_LANGUAGE_RULE);
  });
});
