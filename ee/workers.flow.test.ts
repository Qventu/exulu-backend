import type { UIMessage } from "ai";

// ee/workers.ts pulls in the whole worker runtime; mock everything with
// side effects / heavy transitive imports. Specifiers match workers.ts's
// own import strings (moduleNameMapper resolves both aliased forms).
jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({ db: jest.fn() })),
}));
jest.mock("@SRC/utils/enabled-tools.ts", () => ({
  getEnabledTools: jest.fn(async () => []),
}));
jest.mock("@SRC/exulu/resolve-model.ts", () => ({
  resolveModel: jest.fn(async () => ({ apiKey: undefined, languageModel: {} })),
}));
jest.mock("@SRC/exulu/statistics", () => ({
  updateStatistic: jest.fn(async () => undefined),
}));
jest.mock("@SRC/exulu/storage.ts", () => ({ ExuluStorage: class {} }));
jest.mock("@SRC/exulu/context.ts", () => ({ getTableName: jest.fn() }));
jest.mock("@SRC/exulu/app/singleton", () => ({ exuluApp: { get: jest.fn() } }));
jest.mock("@SRC/exulu/provider.ts", () => ({
  saveChat: jest.fn(async () => undefined),
  getAgentMessages: jest.fn(async () => []),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const providerModule = require("@SRC/exulu/provider.ts") as {
  saveChat: jest.Mock;
  getAgentMessages: jest.Mock;
};

import { FlowStepError, processUiMessagesFlow } from "./workers";

const step = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

const assistant = (id: string, parts: any[]): UIMessage =>
  ({ id, role: "assistant", parts }) as UIMessage;

const approvalPart = {
  type: "tool-create_offer",
  state: "approval-requested",
  approval: { id: "appr-1" },
};

/**
 * Stub ExuluProvider: generateStream returns a fake AI-SDK stream whose
 * toUIMessageStream immediately finishes with [history + step + response].
 * `responses[n]` = assistant messages appended by the n-th generateStream call.
 * A response of `null` makes that call's stream error (onError + reject).
 */
const makeStubProvider = (responses: (UIMessage[] | null)[]) => {
  let call = 0;
  const generateStream = jest.fn(async (opts: any) => {
    const index = call++;
    const original: UIMessage[] = [...(opts.previousMessages ?? []), opts.message];
    return {
      originalMessages: original,
      previousMessages: opts.previousMessages ?? [],
      stream: {
        toUIMessageStream: (streamOpts: any) => ({
          async *[Symbol.asyncIterator]() {
            const response = responses[index];
            if (response === null) {
              streamOpts.onError(new Error("provider exploded"));
              return;
            }
            await streamOpts.onFinish({ messages: [...original, ...(response ?? [])] });
          },
        }),
      },
    };
  });
  return { provider: { generateStream } as any, generateStream };
};

const baseArgs = (provider: any) => ({
  providers: [] as any[],
  agent: { id: "agent-1", name: "Agent", model: "model-1", tools: [], instructions: "do" } as any,
  provider,
  contexts: [] as any[],
  user: { id: 7, role: { id: "role-1" } } as any,
  tools: [{ name: "Create Offer" }] as any[],
  config: {} as any,
});

afterEach(() => jest.clearAllMocks());

describe("processUiMessagesFlow (headless — unchanged legacy behavior)", () => {
  it("passes session undefined + blanket approvedTools and never persists", async () => {
    const { provider, generateStream } = makeStubProvider([[assistant("a1", [{ type: "text", text: "ok" }])]]);
    const result = await processUiMessagesFlow({
      ...baseArgs(provider),
      inputMessages: [step("s1", "hello")],
    });
    expect(generateStream).toHaveBeenCalledTimes(1);
    const opts = generateStream.mock.calls[0][0];
    expect(opts.session).toBeUndefined();
    expect(Array.isArray(opts.approvedTools)).toBe(true);
    expect(providerModule.saveChat).not.toHaveBeenCalled();
    expect(result.pausedAtStepIndex).toBeUndefined();
    expect(result.messages.map((m) => m.id)).toContain("a1");
  });
});

describe("processUiMessagesFlow (session-backed)", () => {
  it("passes the session, rewrites step ids, and persists at each step boundary", async () => {
    const { provider, generateStream } = makeStubProvider([
      [assistant("a1", [{ type: "text", text: "one" }])],
      [assistant("a2", [{ type: "text", text: "two" }])],
    ]);
    await processUiMessagesFlow({
      ...baseArgs(provider),
      inputMessages: [step("s1", "first"), step("s2", "second")],
      sessionId: "sess-1",
    });
    expect(generateStream).toHaveBeenCalledTimes(2);
    for (const call of generateStream.mock.calls) {
      expect(call[0].session).toBe("sess-1");
      // steps_json ids repeat across runs — persisted ids must be fresh:
      expect(call[0].message.id).toMatch(/^wfmsg-/);
    }
    expect(providerModule.saveChat).toHaveBeenCalledTimes(2);
    expect(providerModule.saveChat.mock.calls[0][0]).toMatchObject({ session: "sess-1", user: 7 });
  });

  it("drops the blanket approvedTools when respectToolApprovals is set", async () => {
    const { provider, generateStream } = makeStubProvider([[assistant("a1", [{ type: "text", text: "ok" }])]]);
    await processUiMessagesFlow({
      ...baseArgs(provider),
      inputMessages: [step("s1", "x")],
      sessionId: "sess-1",
      respectToolApprovals: true,
    });
    expect(generateStream.mock.calls[0][0].approvedTools).toBeUndefined();
  });

  it("pauses at the step whose final message requests approval and skips later steps", async () => {
    const { provider, generateStream } = makeStubProvider([
      [assistant("a1", [approvalPart])],
      [assistant("a2", [{ type: "text", text: "never reached" }])],
    ]);
    const result = await processUiMessagesFlow({
      ...baseArgs(provider),
      inputMessages: [step("s1", "gated"), step("s2", "after")],
      sessionId: "sess-1",
      respectToolApprovals: true,
    });
    expect(result.pausedAtStepIndex).toBe(0);
    expect(generateStream).toHaveBeenCalledTimes(1);
    // The paused transcript was persisted before returning:
    expect(providerModule.saveChat).toHaveBeenCalledTimes(1);
  });

  it("resumeFromIndex skips completed steps and reloads history from agent_messages", async () => {
    providerModule.getAgentMessages.mockResolvedValueOnce([
      { content: JSON.stringify(step("old-1", "first")) },
      { content: JSON.stringify(assistant("old-a1", [{ type: "text", text: "done" }])) },
    ]);
    const { provider, generateStream } = makeStubProvider([
      [assistant("a2", [{ type: "text", text: "resumed" }])],
    ]);
    const result = await processUiMessagesFlow({
      ...baseArgs(provider),
      inputMessages: [step("s1", "first"), step("s2", "second")],
      sessionId: "sess-1",
      resumeFromIndex: 1,
    });
    expect(providerModule.getAgentMessages).toHaveBeenCalledWith({
      session: "sess-1",
      includeAllUsers: true,
    });
    expect(generateStream).toHaveBeenCalledTimes(1); // only step index 1
    expect(generateStream.mock.calls[0][0].previousMessages.map((m: UIMessage) => m.id)).toEqual([
      "old-1",
      "old-a1",
    ]);
    expect(result.messages.map((m) => m.id)).toContain("a2");
  });

  it("wraps step failures in FlowStepError carrying the failing step index", async () => {
    const { provider } = makeStubProvider([
      [assistant("a1", [{ type: "text", text: "ok" }])],
      null, // step 1 explodes
    ]);
    const promise = processUiMessagesFlow({
      ...baseArgs(provider),
      inputMessages: [step("s1", "one"), step("s2", "two")],
      sessionId: "sess-1",
    });
    await expect(promise).rejects.toThrow("provider exploded");
    await promise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(FlowStepError);
      expect((error as FlowStepError).stepIndex).toBe(1);
    });
  });

  it("a rerun after a step-1 failure persists only steps >= 1 — no duplicate messages (spec §5.4/§9)", async () => {
    // First run: step 0 succeeds (one boundary persist), step 1 explodes.
    const first = makeStubProvider([
      [assistant("a1", [{ type: "text", text: "one" }])],
      null, // step 1 explodes
    ]);
    await expect(
      processUiMessagesFlow({
        ...baseArgs(first.provider),
        inputMessages: [step("s1", "one"), step("s2", "two")],
        sessionId: "sess-1",
      }),
    ).rejects.toThrow("provider exploded");
    expect(providerModule.saveChat).toHaveBeenCalledTimes(1); // step 0 only

    // Rerun from the failed step (what the worker's retry loop does with
    // FlowStepError.stepIndex): prior history reloads from agent_messages;
    // step 0 must NOT run or persist again.
    providerModule.saveChat.mockClear();
    providerModule.getAgentMessages.mockResolvedValueOnce([
      { content: JSON.stringify(step("old-s1", "one")) },
      { content: JSON.stringify(assistant("a1", [{ type: "text", text: "one" }])) },
    ]);
    const second = makeStubProvider([[assistant("a2", [{ type: "text", text: "two" }])]]);
    await processUiMessagesFlow({
      ...baseArgs(second.provider),
      inputMessages: [step("s1", "one"), step("s2", "two")],
      sessionId: "sess-1",
      resumeFromIndex: 1,
    });
    expect(second.generateStream).toHaveBeenCalledTimes(1); // only step index 1
    expect(providerModule.saveChat).toHaveBeenCalledTimes(1); // only the step-1 boundary
    const persisted = providerModule.saveChat.mock.calls[0][0].messages as UIMessage[];
    expect(persisted.map((m) => m.id)).toContain("a2");
    // Step 0's message reaches saveChat only via the reloaded history (same
    // ids — saveChat's message_id merge keeps it a no-op), never as a re-run.
    expect(persisted.filter((m) => m.id === "a1")).toHaveLength(1);
  });
});
