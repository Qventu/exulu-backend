import { resolveContextWindow } from "./resolve-context-window";
import { DEFAULT_CONTEXT_WINDOW } from "./context-budget";
import type { ExuluProvider } from "./provider";

jest.mock("./litellm/catalog", () => ({
  findLiteLLMModel: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findLiteLLMModel } = require("./litellm/catalog") as { findLiteLLMModel: jest.Mock };

const ORIGINAL_ENV = process.env.EXULU_USE_LITELLM;
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.EXULU_USE_LITELLM;
  else process.env.EXULU_USE_LITELLM = ORIGINAL_ENV;
  jest.clearAllMocks();
});

describe("resolveContextWindow", () => {
  it("prefers max_input_tokens from the LiteLLM catalog in LiteLLM mode", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    findLiteLLMModel.mockResolvedValue({ max_input_tokens: 1_000_000, max_tokens: 900_000 });
    await expect(resolveContextWindow({ modelId: "gemini-2.5-pro" })).resolves.toBe(1_000_000);
  });

  it("falls back to max_tokens, then the default, in LiteLLM mode", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    findLiteLLMModel.mockResolvedValue({ max_input_tokens: null, max_tokens: 200_000 });
    await expect(resolveContextWindow({ modelId: "m" })).resolves.toBe(200_000);
    findLiteLLMModel.mockResolvedValue(undefined);
    await expect(resolveContextWindow({ modelId: "unknown" })).resolves.toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("uses ExuluProvider.maxContextLength in catalog mode", async () => {
    process.env.EXULU_USE_LITELLM = "false";
    const provider = { maxContextLength: 400_000 } as ExuluProvider;
    await expect(resolveContextWindow({ modelId: "row-id", exuluProvider: provider })).resolves.toBe(400_000);
  });

  it("survives a provider whose property access throws (LiteLLM sentinel) and returns the default", async () => {
    process.env.EXULU_USE_LITELLM = "false";
    const sentinel = new Proxy({} as ExuluProvider, {
      get() {
        throw new Error("not available");
      },
    });
    await expect(resolveContextWindow({ modelId: "x", exuluProvider: sentinel })).resolves.toBe(DEFAULT_CONTEXT_WINDOW);
  });
});
