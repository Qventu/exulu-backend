jest.mock("@EE/agentic-retrieval/pipeline/micro-call", () => ({
  microCall: jest.fn(),
  microCallProviderOptions: jest.fn(),
}));
import { microCall } from "@EE/agentic-retrieval/pipeline/micro-call";
import { splitIntoSentences, buildWindows } from "../split";
import { excerptFor, runSelection } from "./select";
import { CLAIM_CHECK_MAX_OUTPUT_TOKENS } from "../types";
import { SAME_LANGUAGE_RULE } from "../prompts/shared";

const ANSWER =
  "Die FST-2XT ist eine Steuerung. Das zeigt, wie wichtig gute Technik ist. " +
  "Sie arbeitet mit 230 Volt und ist dabei beeindruckend zuverlässig.";

const windows = () => buildWindows(splitIntoSentences(ANSWER, "de"), 5, 5);

beforeEach(() => (microCall as jest.Mock).mockReset());

describe("runSelection", () => {
  it("sends one call for the batch and maps outcomes back by sentence index", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: {
        sentences: [
          { index: 0, verifiable: true, rewritten: null, reason: "fact about a controller" },
          { index: 1, verifiable: false, rewritten: null, reason: "opinion" },
          { index: 2, verifiable: true, rewritten: "Sie arbeitet mit 230 Volt.", reason: "mixed" },
        ],
      },
      text: "",
      usage: { inputTokens: 900, outputTokens: 120 },
    });

    const { outcomes, usage } = await runSelection({
      windows: windows(),
      question: "Womit arbeitet die FST-2XT?",
      model: {} as any,
    });

    expect((microCall as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(usage).toEqual({ calls: 1, inputTokens: 900, outputTokens: 120 });
    expect(outcomes).toEqual([
      { index: 0, verifiable: true, rewritten: null, reason: "fact about a controller", answered: true },
      { index: 1, verifiable: false, rewritten: null, reason: "opinion", answered: true },
      { index: 2, verifiable: true, rewritten: "Sie arbeitet mit 230 Volt.", reason: "mixed", answered: true },
    ]);
  });

  it("passes the raised output cap and the requested temperature", async () => {
    (microCall as jest.Mock).mockResolvedValue({ output: { sentences: [] }, text: "", usage: { inputTokens: 1, outputTokens: 1 } });
    await runSelection({ windows: windows(), question: "q", model: {} as any, temperature: 0.2 });
    const args = (microCall as jest.Mock).mock.calls[0][0];
    expect(args.maxOutputTokens).toBe(CLAIM_CHECK_MAX_OUTPUT_TOKENS);
    expect(args.temperature).toBe(0.2);
  });

  it("includes the question, the target sentences and their surrounding context in the prompt", async () => {
    (microCall as jest.Mock).mockResolvedValue({ output: { sentences: [] }, text: "", usage: { inputTokens: 1, outputTokens: 1 } });
    await runSelection({ windows: windows(), question: "Womit arbeitet die FST-2XT?", model: {} as any });
    const prompt = String((microCall as jest.Mock).mock.calls[0][0].prompt);
    expect(prompt).toContain("Womit arbeitet die FST-2XT?");
    expect(prompt).toContain("Die FST-2XT ist eine Steuerung.");
    expect(prompt).toContain("[0]");
  });

  // Finding 4: still never promoted to verifiable, but flagged `answered: false`
  // so the orchestrator can report "the model skipped this sentence"
  // (not_checked) instead of "this sentence asserts nothing checkable".
  it("marks a sentence the model omitted as unanswered, not as unverifiable content", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: { sentences: [{ index: 0, verifiable: true, rewritten: null, reason: "ok" }] },
      text: "",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const { outcomes } = await runSelection({ windows: windows(), question: "q", model: {} as any });
    expect(outcomes).toHaveLength(3);
    expect(outcomes[1]).toEqual({
      index: 1,
      verifiable: false,
      rewritten: null,
      reason: "no selection returned for this sentence",
      answered: false,
    });
    expect(outcomes[0]!.answered).toBe(true);
  });

  it("ignores an outcome whose index is not in the batch", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: { sentences: [{ index: 99, verifiable: true, rewritten: null, reason: "hallucinated index" }] },
      text: "",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const { outcomes } = await runSelection({ windows: windows(), question: "q", model: {} as any });
    expect(outcomes.map((o) => o.index)).toEqual([0, 1, 2]);
    expect(outcomes.every((o) => o.verifiable === false)).toBe(true);
  });
  // Finding 10: a flash-class model that translates a German sentence into
  // English makes the claim unscorable against German passages and poisons the
  // second-chance query. The instruction must be in the composed prompt.
  it("pins the output language in the system prompt", async () => {
    (microCall as jest.Mock).mockResolvedValue({ output: { sentences: [] }, text: "", usage: { inputTokens: 1, outputTokens: 1 } });
    await runSelection({ windows: windows(), question: "q", model: {} as any });
    expect(String((microCall as jest.Mock).mock.calls[0][0].system)).toContain(SAME_LANGUAGE_RULE);
  });
  // Finding 11: the heading path was computed, carried on every Sentence and
  // read nowhere, so a sentence whose subject only appears in its section
  // title could not be resolved and was refused as cannot_disambiguate.
  it("leads the excerpt with the heading path the sentences sit under", () => {
    const answer = [
      "# Fehlerbehebung",
      "",
      "## FST-2XT Steuerung",
      "Sie arbeitet mit 230 Volt.",
    ].join("\n");
    const built = buildWindows(splitIntoSentences(answer, "de"), 5, 5);
    const excerpt = excerptFor(built);
    expect(excerpt).toBe("Section: Fehlerbehebung > FST-2XT Steuerung\n\nSie arbeitet mit 230 Volt.");
  });

  it("lists each distinct heading path once and omits the line when there is no heading", () => {
    const answer = [
      "## Ursachen",
      "Der Schalter ist defekt.",
      "",
      "## Abhilfe",
      "Die Sicherung wird getauscht.",
    ].join("\n");
    const built = buildWindows(splitIntoSentences(answer, "de"), 5, 5);
    const excerpt = excerptFor(built);
    expect(excerpt.startsWith("Section: Ursachen\nSection: Abhilfe\n\n")).toBe(true);

    const plain = buildWindows(splitIntoSentences("Der Schalter ist defekt.", "de"), 5, 5);
    expect(excerptFor(plain)).toBe("Der Schalter ist defekt.");
  });

  it("carries the heading path into the prompt the model receives", async () => {
    (microCall as jest.Mock).mockResolvedValue({ output: { sentences: [] }, text: "", usage: { inputTokens: 1, outputTokens: 1 } });
    const answer = ["## FST-2XT Steuerung", "Sie arbeitet mit 230 Volt."].join("\n");
    const built = buildWindows(splitIntoSentences(answer, "de"), 5, 5);
    await runSelection({ windows: built, question: "Womit arbeitet sie?", model: {} as any });
    expect(String((microCall as jest.Mock).mock.calls[0][0].prompt)).toContain("Section: FST-2XT Steuerung");
  });
});
