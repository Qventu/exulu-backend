import { testSource, type SourceTestDeps } from "./source-test";

const deps = (over: Partial<SourceTestDeps> = {}): SourceTestDeps => ({
  whisperConfigured: () => true,
  pingWhisper: async () => {},
  recallConfigured: () => true,
  pingRecall: async () => {},
  recordModelConfigured: () => true,
  pingRecordModel: async () => {},
  ...over,
});

describe("testSource", () => {
  it("reports not-configured without pinging", async () => {
    const pingWhisper = jest.fn(async () => {});
    const result = await testSource("upload", deps({ whisperConfigured: () => false, pingWhisper }));
    expect(result).toEqual({ ok: false, reason: "not_configured" });
    expect(pingWhisper).not.toHaveBeenCalled();
  });

  it("reports ok when the service answers", async () => {
    expect(await testSource("upload", deps())).toEqual({ ok: true });
  });

  it("surfaces the service's own message on failure", async () => {
    // The whole value of the button is the real error, not a generic one.
    const result = await testSource(
      "meeting",
      deps({
        pingRecall: async () => {
          throw new Error("401 Unauthorized: bad RECALL_API_KEY");
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "unreachable", message: "401 Unauthorized: bad RECALL_API_KEY" });
  });

  it("rejects an unknown source rather than guessing", async () => {
    await expect(testSource("nonsense" as never, deps())).rejects.toThrow(/unknown source/i);
  });
});
