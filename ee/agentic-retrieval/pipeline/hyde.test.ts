import { generateHydePassage, clearHydeCache } from "./hyde";

jest.mock("ai", () => ({ generateText: jest.fn() }));
import { generateText } from "ai";

beforeEach(() => {
  clearHydeCache();
  (generateText as jest.Mock).mockReset();
});

describe("generateHydePassage", () => {
  it("returns the generated passage and includes the styleHint in the prompt", async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: "A passage." });
    const p = await generateHydePassage({
      originalQuestion: "How do I lock door A?",
      relevantKeywords: ["door"],
      importantKeyword: "FST-2XT",
      styleHint: "German elevator manuals",
      model: {},
    });
    expect(p).toBe("A passage.");
    const prompt = (generateText as jest.Mock).mock.calls[0][0].prompt as string;
    expect(prompt).toContain("German elevator manuals");
    expect(prompt).toContain("FST-2XT");
    expect(prompt).toContain("same language as the question");
  });

  it("memoizes per question (one LLM call for two invocations)", async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: "A passage." });
    const opts = { originalQuestion: "q", relevantKeywords: [], styleHint: "", model: {} };
    await generateHydePassage(opts);
    await generateHydePassage(opts);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("returns null on failure without caching the failure", async () => {
    (generateText as jest.Mock)
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValueOnce({ text: "ok" });
    const opts = { originalQuestion: "q2", relevantKeywords: [], styleHint: "", model: {} };
    expect(await generateHydePassage(opts)).toBeNull();
    expect(await generateHydePassage(opts)).toBe("ok");
  });

  it("returns null when no model is provided", async () => {
    expect(
      await generateHydePassage({
        originalQuestion: "q",
        relevantKeywords: [],
        styleHint: "",
        model: undefined,
      })
    ).toBeNull();
  });
});
