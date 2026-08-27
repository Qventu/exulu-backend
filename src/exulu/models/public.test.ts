const resolveModelSpy = jest.fn(async () => ({
  languageModel: { modelId: "vertex-gemini-2.5-flash" },
  model: { id: "vertex-gemini-2.5-flash" },
}));
jest.mock("@SRC/exulu/resolve-model", () => ({
  resolveModel: (...args: any[]) => resolveModelSpy(...args),
}));

const firstSpy = jest.fn();
jest.mock("@SRC/postgres/client", () => ({
  postgresClient: async () => ({
    db: () => ({ where: () => ({ first: () => firstSpy() }) }),
  }),
}));

import { ExuluModels } from "./public";

describe("ExuluModels.resolve", () => {
  beforeEach(() => {
    resolveModelSpy.mockClear();
    firstSpy.mockReset();
  });

  it("passes the loaded user through so LiteLLM tags attribute the spend", async () => {
    const row = { id: 7, email: "a@b.c", role: "role-1", team: "team-1" };
    firstSpy.mockResolvedValueOnce(row);

    await ExuluModels.resolve({ modelId: "vertex-gemini-2.5-flash", userId: 7 });

    expect(resolveModelSpy).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "vertex-gemini-2.5-flash", user: row }),
    );
  });

  it("returns the language model, not the {languageModel, model} pair", async () => {
    firstSpy.mockResolvedValueOnce({ id: 7 });

    const model = await ExuluModels.resolve({ modelId: "m", userId: 7 });

    expect(model).toEqual({ modelId: "vertex-gemini-2.5-flash" });
  });

  it("resolves without a userId — the call is simply unattributed", async () => {
    await ExuluModels.resolve({ modelId: "m" });

    expect(firstSpy).not.toHaveBeenCalled();
    expect(resolveModelSpy).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "m", user: undefined }),
    );
  });

  it("resolves unattributed rather than throwing when the user row is gone", async () => {
    firstSpy.mockResolvedValueOnce(undefined);

    await expect(
      ExuluModels.resolve({ modelId: "m", userId: 999 }),
    ).resolves.toBeDefined();
    expect(resolveModelSpy).toHaveBeenCalledWith(
      expect.objectContaining({ user: undefined }),
    );
  });

  it("propagates resolveModel failures — an unusable model must not look resolved", async () => {
    firstSpy.mockResolvedValueOnce({ id: 7 });
    resolveModelSpy.mockRejectedValueOnce(new Error("LiteLLM is not ready"));

    await expect(
      ExuluModels.resolve({ modelId: "m", userId: 7 }),
    ).rejects.toThrow("LiteLLM is not ready");
  });
});

describe("ExuluModels.providerOptions", () => {
  it("disables reasoning for gemini models", () => {
    expect(ExuluModels.providerOptions({ modelId: "vertex-gemini-2.5-flash" } as any)).toEqual({
      litellm: { reasoningEffort: "disable" },
    });
  });

  it("accepts a bare model id string", () => {
    expect(ExuluModels.providerOptions("gemini-3.5-flash")).toEqual({
      litellm: { reasoningEffort: "disable" },
    });
  });

  it("returns undefined for non-gemini models", () => {
    expect(ExuluModels.providerOptions({ modelId: "gpt-4o" } as any)).toBeUndefined();
  });
});
