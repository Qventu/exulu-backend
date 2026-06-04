import { createIdGenerator, type UIMessage } from "ai";
import {
  createHermesRunStream,
  normalizeEvent,
  uiMessageText,
} from "./run-stream";

describe("uiMessageText", () => {
  it("concatenates the text parts of a message", () => {
    const message = {
      role: "user",
      parts: [{ type: "text", text: "hello " }, { type: "step-start" }, { type: "text", text: "world" }],
    } as unknown as UIMessage;
    expect(uiMessageText(message)).toBe("hello world");
  });

  it("returns empty string for undefined / no text", () => {
    expect(uiMessageText(undefined)).toBe("");
  });
});

describe("normalizeEvent", () => {
  it("maps text deltas across spellings", () => {
    expect(normalizeEvent("message.delta", { delta: "hi" })).toEqual({ kind: "text", delta: "hi" });
    expect(normalizeEvent("response.output_text.delta", { text: "yo" })).toEqual({ kind: "text", delta: "yo" });
    expect(normalizeEvent(undefined, { type: "token", content: "x" })).toEqual({ kind: "text", delta: "x" });
  });

  it("maps tool start and completion (flat / custom shape)", () => {
    expect(normalizeEvent("tool.start", { tool_call_id: "t1", name: "search", input: { q: 1 } })).toEqual({
      kind: "tool-start",
      itemId: "t1",
      toolCallId: "t1",
      toolName: "search",
      input: { q: 1 },
    });
    expect(normalizeEvent("tool.complete", { tool_call_id: "t1", output: { ok: true } })).toEqual({
      kind: "tool-end",
      toolCallId: "t1",
      output: { ok: true },
      isError: false,
    });
  });

  it("maps Hermes-native tool.started / tool.completed (name in `tool`, no id)", () => {
    expect(normalizeEvent(undefined, { event: "tool.started", tool: "session_search", preview: 'recall: "x"' })).toEqual({
      kind: "tool-start",
      toolName: "session_search",
      input: { preview: 'recall: "x"' },
    });
    expect(normalizeEvent(undefined, { event: "tool.completed", tool: "session_search", duration: 0.007, error: false })).toEqual({
      kind: "tool-end",
      output: { ok: true, duration_s: 0.007 },
      isError: false,
    });
  });

  it("maps the Responses streaming tool sequence", () => {
    expect(
      normalizeEvent("response.output_item.added", { item: { id: "fc_1", type: "function_call", name: "list_files", call_id: "call_1" } }),
    ).toEqual({ kind: "tool-start", itemId: "fc_1", toolCallId: "call_1", toolName: "list_files" });
    expect(normalizeEvent("response.function_call_arguments.delta", { item_id: "fc_1", delta: '{"path"' })).toEqual({
      kind: "tool-args-delta",
      itemId: "fc_1",
      delta: '{"path"',
    });
    expect(normalizeEvent("response.function_call_arguments.done", { item_id: "fc_1", arguments: '{"path":"."}' })).toEqual({
      kind: "tool-args-done",
      itemId: "fc_1",
      arguments: '{"path":"."}',
    });
    expect(
      normalizeEvent("response.output_item.added", { item: { type: "function_call_output", call_id: "call_1", output: "a.ts\nb.ts" } }),
    ).toEqual({ kind: "tool-end", toolCallId: "call_1", output: "a.ts\nb.ts" });
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

  it("maps OpenAI Responses-style events", () => {
    expect(normalizeEvent("response.output_text.delta", { delta: "Hi" })).toEqual({
      kind: "text",
      delta: "Hi",
    });
    expect(
      normalizeEvent("response.completed", { response: { usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 } } }),
    ).toEqual({
      kind: "finish",
      usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10, reasoningTokens: undefined, cachedInputTokens: undefined },
    });
    expect(normalizeEvent("response.failed", { error: { message: "nope" } })).toEqual({
      kind: "error",
      message: "nope",
    });
  });

  it("distinguishes function_call from function_call_output", () => {
    expect(normalizeEvent("response.function_call", { call_id: "c1", name: "search", arguments: { q: 1 } })).toEqual({
      kind: "tool-start",
      itemId: "c1",
      toolCallId: "c1",
      toolName: "search",
      input: { q: 1 },
    });
    expect(normalizeEvent("response.function_call_output", { call_id: "c1", output: "done" })).toEqual({
      kind: "tool-end",
      toolCallId: "c1",
      output: "done",
      isError: false,
    });
  });

  it("ignores unknown events", () => {
    expect(normalizeEvent("heartbeat", {})).toEqual({ kind: "ignore" });
  });
});

describe("startRun request body", () => {
  afterEach(() => {
    delete (global as any).fetch;
  });

  it("POSTs an OpenAI Responses-style { input, session_id } body", async () => {
    let captured: any;
    (global as any).fetch = jest.fn(async (url: string, init?: any) => {
      if (url.endsWith("/runs") && init?.method === "POST") {
        captured = JSON.parse(init.body);
        return new Response(JSON.stringify({ run_id: "run_1", status: "started" }), { status: 200 });
      }
      return new Response("event: response.completed\ndata: {}\n\n", { status: 200 });
    });

    const stream = createHermesRunStream({
      baseUrl: "http://127.0.0.1:8642/v1",
      apiKey: "k",
      hermesSessionId: "sess_z",
      input: "what files are here?",
      originalMessages: [],
      generateId: createIdGenerator({ prefix: "msg_", size: 8 }),
      onError: (e) => (e instanceof Error ? e.message : String(e)),
      onFinish: async () => {},
    });
    const reader = stream.getReader();
    while (!(await reader.read()).done) {
      /* drain */
    }

    expect(captured).toEqual({ input: "what files are here?", session_id: "sess_z" });
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
      input: "hi",
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

  it("streams a tool call with name and accumulated input", async () => {
    (global as any).fetch = jest.fn(async (url: string, init?: any) => {
      if (url.endsWith("/runs") && init?.method === "POST") {
        return new Response(JSON.stringify({ run_id: "run_t" }), { status: 200 });
      }
      return new Response(
        sse([
          { event: "response.output_item.added", data: { item: { id: "fc_1", type: "function_call", name: "list_files", call_id: "call_1" } } },
          { event: "response.function_call_arguments.delta", data: { item_id: "fc_1", delta: '{"path":' } },
          { event: "response.function_call_arguments.delta", data: { item_id: "fc_1", delta: '"."}' } },
          { event: "response.function_call_arguments.done", data: { item_id: "fc_1", arguments: '{"path":"."}' } },
          { event: "response.output_item.added", data: { item: { type: "function_call_output", call_id: "call_1", output: "a.ts\nb.ts" } } },
          { event: "response.completed", data: {} },
        ]),
        { status: 200 },
      );
    });

    const stream = createHermesRunStream({
      baseUrl: "http://127.0.0.1:8642/v1",
      apiKey: "k",
      hermesSessionId: "sess_t",
      input: "list files",
      originalMessages: [],
      generateId: createIdGenerator({ prefix: "msg_", size: 8 }),
      onError: (e) => (e instanceof Error ? e.message : String(e)),
      onFinish: async () => {},
    });

    const chunks = await collect(stream);
    const start = chunks.find((c) => c.type === "tool-input-start");
    expect(start).toMatchObject({ toolCallId: "call_1", toolName: "list_files", dynamic: true });

    const available = chunks.find((c) => c.type === "tool-input-available");
    expect(available).toMatchObject({ toolCallId: "call_1", toolName: "list_files", input: { path: "." } });

    const output = chunks.find((c) => c.type === "tool-output-available");
    expect(output).toMatchObject({ toolCallId: "call_1", output: "a.ts\nb.ts" });
  });

  it("translates Hermes-native data-only events (no event: line, name in `tool`)", async () => {
    // Hermes sends SSE with only a data line; the type lives in data.event.
    const dataOnly = (objs: unknown[]) =>
      objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join("");

    (global as any).fetch = jest.fn(async (url: string, init?: any) => {
      if (url.endsWith("/runs") && init?.method === "POST") {
        return new Response(JSON.stringify({ run_id: "run_h" }), { status: 200 });
      }
      return new Response(
        dataOnly([
          { event: "tool.started", tool: "session_search", preview: 'recall: "deck"' },
          { event: "tool.completed", tool: "session_search", duration: 0.007, error: false },
          { event: "message.delta", delta: "We built a deck." },
          { event: "run.completed", output: "We built a deck." },
        ]),
        { status: 200 },
      );
    });

    const stream = createHermesRunStream({
      baseUrl: "http://127.0.0.1:8642/v1",
      apiKey: "k",
      hermesSessionId: "sess_h",
      input: "what did we do?",
      originalMessages: [],
      generateId: createIdGenerator({ prefix: "msg_", size: 8 }),
      onError: (e) => (e instanceof Error ? e.message : String(e)),
      onFinish: async () => {},
    });

    const chunks = await collect(stream);

    const start = chunks.find((c) => c.type === "tool-input-start");
    expect(start).toMatchObject({ toolName: "session_search", dynamic: true });
    const available = chunks.find((c) => c.type === "tool-input-available");
    expect(available).toMatchObject({ toolName: "session_search", input: { preview: 'recall: "deck"' } });
    const output = chunks.find((c) => c.type === "tool-output-available");
    expect(output).toMatchObject({ output: { ok: true, duration_s: 0.007 } });
    // started and completed must resolve to the same synthesized call id.
    expect((start as any).toolCallId).toBe((output as any).toolCallId);

    const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");
    expect(text).toBe("We built a deck.");
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
      input: "hi",
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
