// ee/agentic-retrieval/pipeline/micro-call.test.ts
import { z } from "zod";

jest.mock("ai", () => {
  const actual = jest.requireActual("ai");
  return { ...actual, generateText: jest.fn() };
});
import { generateText } from "ai";
import {
  microCall,
  microCallProviderOptions,
  MICRO_CALL_MAX_OUTPUT_TOKENS,
} from "./micro-call";

const { NoOutputGeneratedError } = jest.requireActual("ai");

beforeEach(() => {
  (generateText as jest.Mock).mockReset();
});

describe("microCallProviderOptions", () => {
  it("disables thinking for gemini model ids (object and string forms)", () => {
    expect(microCallProviderOptions({ modelId: "vertex-gemini-3.5-flash" } as any)).toEqual({
      litellm: { reasoningEffort: "disable" },
    });
    expect(microCallProviderOptions("gemini-3.1-flash-lite")).toEqual({
      litellm: { reasoningEffort: "disable" },
    });
  });

  it("returns undefined for non-gemini models", () => {
    expect(microCallProviderOptions({ modelId: "qwen3-235b" } as any)).toBeUndefined();
    expect(microCallProviderOptions({} as any)).toBeUndefined();
  });
});

describe("microCall", () => {
  const schema = z.object({ ok: z.boolean() });

  it("applies shared defaults: temperature 0, raised token cap, no SDK-internal retries", async () => {
    (generateText as jest.Mock).mockResolvedValue({ output: { ok: true }, text: "" });
    await microCall({
      model: { modelId: "vertex-gemini-3.5-flash" } as any,
      system: "s",
      messages: [{ role: "user", content: "q" }],
      schema,
    });
    const args = (generateText as jest.Mock).mock.calls[0][0];
    expect(args.temperature).toBe(0);
    expect(args.maxOutputTokens).toBe(MICRO_CALL_MAX_OUTPUT_TOKENS);
    expect(MICRO_CALL_MAX_OUTPUT_TOKENS).toBe(2000);
    expect(args.maxRetries).toBe(0);
    expect(args.providerOptions).toEqual({ litellm: { reasoningEffort: "disable" } });
  });

  it("returns the parsed output for schema calls", async () => {
    (generateText as jest.Mock).mockResolvedValue({ output: { ok: true }, text: "{}" });
    const { output } = await microCall({
      model: {} as any,
      system: "s",
      messages: [{ role: "user", content: "q" }],
      schema,
    });
    expect(output).toEqual({ ok: true });
  });

  it("returns text and omits structured output when no schema is given", async () => {
    (generateText as jest.Mock).mockResolvedValue({ text: "a passage" });
    const { text } = await microCall({
      model: {} as any,
      prompt: "write",
      temperature: 0.3,
    });
    expect(text).toBe("a passage");
    const args = (generateText as jest.Mock).mock.calls[0][0];
    expect(args.output).toBeUndefined();
    expect(args.temperature).toBe(0.3);
  });

  it("fails fast without retrying when the model generated no output", async () => {
    (generateText as jest.Mock).mockResolvedValue({
      text: "",
      get output(): unknown {
        throw new NoOutputGeneratedError({ message: "No output generated." });
      },
    });
    await expect(
      microCall({
        model: {} as any,
        system: "s",
        messages: [{ role: "user", content: "q" }],
        schema,
      }),
    ).rejects.toThrow("No output generated.");
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("retries transient errors and succeeds", async () => {
    (generateText as jest.Mock)
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({ output: { ok: true }, text: "" });
    const { output } = await microCall({
      model: {} as any,
      system: "s",
      messages: [{ role: "user", content: "q" }],
      schema,
      retryBaseDelayMs: 1,
    });
    expect(output).toEqual({ ok: true });
    expect(generateText).toHaveBeenCalledTimes(2);
  });
});
