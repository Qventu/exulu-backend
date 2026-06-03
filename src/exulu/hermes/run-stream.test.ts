import { createIdGenerator, type UIMessage } from "ai";
import {
  createHermesRunStream,
  normalizeEvent,
  uiMessagesToOpenAI,
} from "./run-stream";

describe("uiMessagesToOpenAI", () => {
  it("flattens text parts into OpenAI-style messages", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] },
      { role: "assistant", parts: [{ type: "step-start" }, { type: "text", text: "hi" }] },
    ] as unknown as UIMessage[];
    expect(uiMessagesToOpenAI(messages)).toEqual([
      { role: "user", content: "hello world" },
      { role: "assistant", content: "hi" },
    ]);
  });
});

describe("normalizeEvent", () => {
  it("maps text deltas across spellings", () => {
    expect(normalizeEvent("message.delta", { delta: "hi" })).toEqual({ kind: "text", delta: "hi" });
    expect(normalizeEvent("response.output_text.delta", { text: "yo" })).toEqual({ kind: "text", delta: "yo" });
    expect(normalizeEvent(undefined, { type: "token", content: "x" })).toEqual({ kind: "text", delta: "x" });
  });

  it("maps tool start and completion", () => {
    expect(normalizeEvent("tool.start", { tool_call_id: "t1", name: "search", input: { q: 1 } })).toEqual({
      kind: "tool-start",
      toolCallId: "t1",
      toolName: "search",
      input: { q: 1 },
    });
    expect(normalizeEvent("tool.complete", { tool_call_id: "t1", output: { ok: true } })).toEqual({
      kind: "tool-end",
      toolCallId: "t1",
      output: { ok: true },
    });
  });

  it("maps approval, finish (with usage), and error", () => {
    expect(normalizeEvent("approval.request", { approval_id: "a1", tool_call_id: "t1" })).toEqual({
      kind: "approval",
      approvalId: "a1",
      toolCallId: "t1",
    });
    expect(normalizeEvent("run.completed", { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } })).toEqual({
      kind: "finish",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: undefined, cachedInputTokens: undefined },
    });
    expect(normalizeEvent("run.failed", { error: "boom" })).toEqual({ kind: "error", message: "boom" });
  });

  it("ignores unknown events", () => {
    expect(normalizeEvent("heartbeat", {})).toEqual({ kind: "ignore" });
  });
});

describe("createHermesRunStream (integration with mocked fetch)", () => {
  const sse = (records: Array<{ event: string; data: unknown }>) =>
    records.map((r) => `event: ${r.event}\ndata: ${JSON.stringify(r.data)}\n\n`).join("");

  afterEach(() => {
    delete (global as any).fetch;
  });

  const collect = async (stream: ReadableStream<any>) => {
    const reader = stream.getReader();
    const chunks: any[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return chunks;
  };

  it("translates a run's SSE events into UIMessage chunks", async () => {
    (global as any).fetch = jest.fn(async (url: string, init?: any) => {
      if (url.endsWith("/runs") && init?.method === "POST") {
        return new Response(JSON.stringify({ run_id: "run_123" }), { status: 200 });
      }
      if (url.endsWith("/runs/run_123/events")) {
        return new Response(
          sse([
            { event: "message.delta", data: { delta: "Hel" } },
            { event: "message.delta", data: { delta: "lo" } },
            { event: "run.completed", data: { usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const stream = createHermesRunStream({
      baseUrl: "http://127.0.0.1:8642/v1",
      apiKey: "k",
      hermesSessionId: "sess_x",
      messages: [{ role: "user", content: "hi" }],
      originalMessages: [],
      generateId: createIdGenerator({ prefix: "msg_", size: 8 }),
      onError: (e) => (e instanceof Error ? e.message : String(e)),
      onFinish: async () => {},
    });

    const chunks = await collect(stream);
    const types = chunks.map((c) => c.type);
    expect(types).toContain("text-start");
    expect(types.filter((t) => t === "text-delta")).toHaveLength(2);
    expect(types).toContain("text-end");

    const text = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => c.delta)
      .join("");
    expect(text).toBe("Hello");

    const finish = chunks.find((c) => c.type === "finish");
    expect(finish?.messageMetadata).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  });

  it("surfaces a run error as an error chunk", async () => {
    (global as any).fetch = jest.fn(async (url: string, init?: any) => {
      if (url.endsWith("/runs") && init?.method === "POST") {
        return new Response(JSON.stringify({ run_id: "run_err" }), { status: 200 });
      }
      return new Response(sse([{ event: "run.failed", data: { error: "kaboom" } }]), { status: 200 });
    });

    const stream = createHermesRunStream({
      baseUrl: "http://127.0.0.1:8642/v1",
      apiKey: "k",
      hermesSessionId: "sess_y",
      messages: [{ role: "user", content: "hi" }],
      originalMessages: [],
      generateId: createIdGenerator({ prefix: "msg_", size: 8 }),
      onError: (e) => (e instanceof Error ? e.message : String(e)),
      onFinish: async () => {},
    });

    const chunks = await collect(stream);
    const err = chunks.find((c) => c.type === "error");
    expect(err?.errorText).toBe("kaboom");
  });
});
