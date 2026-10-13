jest.mock("@EE/agentic-retrieval/pipeline/micro-call", () => ({
  microCall: jest.fn(),
  microCallProviderOptions: jest.fn(),
}));
import { microCall } from "@EE/agentic-retrieval/pipeline/micro-call";
import { splitIntoSentences, buildWindows } from "../split";
import { runSelectAndDisambiguate } from "./select-disambiguate";

const ANSWER =
  "Die FST-2XT ist eine Steuerung. Das zeigt, wie wichtig gute Technik ist. Sie wurde dort getauscht.";
const windows = () => buildWindows(splitIntoSentences(ANSWER, "de"), 5, 5);

beforeEach(() => (microCall as jest.Mock).mockReset());

describe("runSelectAndDisambiguate", () => {
  it("derives both stages' outcomes from a single call", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: {
        sentences: [
          { index: 0, verifiable: true, rewritten: null, resolvable: true, clarified: null, reason: "clear fact" },
          { index: 1, verifiable: false, rewritten: null, resolvable: true, clarified: null, reason: "opinion" },
          { index: 2, verifiable: true, rewritten: "Sie wurde dort getauscht.", resolvable: false, clarified: null, reason: "'dort' is unresolvable" },
        ],
      },
      text: "",
      usage: { inputTokens: 1500, outputTokens: 300 },
    });

    const { selection, disambiguation, usage } = await runSelectAndDisambiguate({
      windows: windows(),
      question: "Was wurde getauscht?",
      model: {} as any,
    });

    expect((microCall as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(usage).toEqual({ calls: 1, inputTokens: 1500, outputTokens: 300 });
    expect(selection.map((s) => s.verifiable)).toEqual([true, false, true]);
    expect(selection[2]!.rewritten).toBe("Sie wurde dort getauscht.");
    expect(disambiguation.map((d) => d.resolvable)).toEqual([true, false, false]);
  });

  it("forces resolvable=false for a sentence that failed selection, so it can never reach decomposition", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: {
        sentences: [
          { index: 0, verifiable: false, rewritten: null, resolvable: true, clarified: "irrelevant", reason: "opinion" },
          { index: 1, verifiable: false, rewritten: null, resolvable: true, clarified: null, reason: "opinion" },
          { index: 2, verifiable: false, rewritten: null, resolvable: true, clarified: null, reason: "opinion" },
        ],
      },
      text: "",
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const { disambiguation } = await runSelectAndDisambiguate({ windows: windows(), question: "q", model: {} as any });
    expect(disambiguation.every((d) => d.resolvable === false)).toBe(true);
    expect(disambiguation[0]!.clarified).toBeNull();
  });

  it("treats an omitted sentence as neither verifiable nor resolvable", async () => {
    (microCall as jest.Mock).mockResolvedValue({ output: { sentences: [] }, text: "", usage: { inputTokens: 1, outputTokens: 1 } });
    const { selection, disambiguation } = await runSelectAndDisambiguate({ windows: windows(), question: "q", model: {} as any });
    expect(selection.every((s) => s.verifiable === false)).toBe(true);
    expect(disambiguation.every((d) => d.resolvable === false)).toBe(true);
  });
});
