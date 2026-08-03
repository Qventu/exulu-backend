jest.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: jest.fn(() => jest.fn()),
}));

jest.mock("./tags", () => ({
  buildTags: jest.fn(() => []),
  createTaggedFetch: jest.fn(() => global.fetch),
}));

jest.mock("./litellm/supervisor", () => ({
  isLiteLLMEnabled: jest.fn(() => true),
  waitForLiteLLMReady: jest.fn(() => Promise.resolve()),
}));

jest.mock("./litellm/budget-service", () => ({
  provisionDefaultUserBudget: jest.fn(() => Promise.resolve()),
}));

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getLiteLLMProvider } from "./resolve-model";
import { setLiteLLMClientMode } from "./litellm/env";

const mockCreateOpenAICompatible = createOpenAICompatible as jest.MockedFunction<
  typeof createOpenAICompatible
>;

const envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  // Snapshot and clear relevant env vars
  for (const key of ["LITELLM_MASTER_KEY", "LITELLM_HOST", "LITELLM_PORT", "LITELLM_BASE_URL", "EXULU_API_KEY"]) {
    envSnapshot[key] = process.env[key];
    delete process.env[key];
  }
  mockCreateOpenAICompatible.mockClear();
  // Default to server (non-client) mode; remote-mode tests opt in.
  setLiteLLMClientMode(false);
});

afterAll(() => {
  // Restore original env
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  setLiteLLMClientMode(false);
});

describe("getLiteLLMProvider", () => {
  test("A (local): uses http://127.0.0.1:4000/v1 when LITELLM_MASTER_KEY is set", () => {
    process.env.LITELLM_MASTER_KEY = "sk-test";

    getLiteLLMProvider({});

    expect(mockCreateOpenAICompatible).toHaveBeenCalledTimes(1);
    const callArg = mockCreateOpenAICompatible.mock.calls[0][0];
    expect(callArg).toMatchObject({ baseURL: "http://127.0.0.1:4000/v1" });
  });

  test("B (remote): uses LITELLM_BASE_URL/v1 and exulu-api-key header", () => {
    setLiteLLMClientMode(true); // remote mode requires worker/client role
    process.env.LITELLM_BASE_URL = "https://srv.example/litellm/DEFAULT";
    process.env.EXULU_API_KEY = "sk_a_b/worker";
    // LITELLM_MASTER_KEY is not set (deleted in beforeEach)

    getLiteLLMProvider({});

    expect(mockCreateOpenAICompatible).toHaveBeenCalledTimes(1);
    const callArg = mockCreateOpenAICompatible.mock.calls[0][0];
    expect(callArg).toMatchObject({ baseURL: "https://srv.example/litellm/DEFAULT/v1" });
    expect((callArg as any).headers).toMatchObject({ "exulu-api-key": "sk_a_b/worker" });
  });

  test("C (no throw in remote without master key): does not throw", () => {
    setLiteLLMClientMode(true); // remote mode requires worker/client role
    process.env.LITELLM_BASE_URL = "https://srv.example/litellm/DEFAULT";
    process.env.EXULU_API_KEY = "sk_a_b/worker";
    // LITELLM_MASTER_KEY is not set (deleted in beforeEach)

    expect(() => getLiteLLMProvider({})).not.toThrow();
  });
});
