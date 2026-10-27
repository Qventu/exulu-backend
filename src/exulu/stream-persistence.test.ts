import http from "node:http";
import type { AddressInfo } from "node:net";
import { streamText, type UIMessage } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { persistThroughDisconnect } from "./stream-persistence";

const DELTAS = ["The ", "spare ", "part ", "is ", "in ", "stock."];
const FULL_ANSWER = DELTAS.join("");

const mockModel = () =>
  new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: 10,
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "id-0", modelId: "mock", timestamp: new Date(0) },
          { type: "text-start", id: "t0" },
          ...DELTAS.map((delta) => ({ type: "text-delta" as const, id: "t0", delta })),
          { type: "text-end", id: "t0" },
          {
            type: "finish" as const,
            finishReason: "stop" as const,
            usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 },
          },
        ],
      }),
    }),
  });

const userMessage: UIMessage[] = [
  { id: "user-1", role: "user", parts: [{ type: "text", text: "is the part in stock?" }] },
];

const answerTextOf = (message: UIMessage | undefined): string =>
  (message?.parts ?? [])
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");

/**
 * Serves one chat turn the way the chat route does, and reports what the
 * route's onFinish (which is where saveChat runs) was handed.
 */
const serveOneTurn = async ({ keepAlive }: { keepAlive: boolean }) => {
  const saved: UIMessage[][] = [];
  const server = http.createServer((_req, res) => {
    const result = streamText({ model: mockModel(), prompt: "is the part in stock?" });
    result.pipeUIMessageStreamToResponse(res, {
      originalMessages: userMessage,
      ...(keepAlive ? persistThroughDisconnect() : {}),
      onFinish: ({ messages }) => {
        saved.push(messages);
      },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
  // Read one chunk, then vanish — the browser closing the tab mid-answer.
  await response.body!.getReader().read();
  controller.abort();

  // Long enough for the whole mock generation to have finished server-side.
  await new Promise((resolve) => setTimeout(resolve, 600));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return saved;
};

describe("persistThroughDisconnect", () => {
  it("persists the turn when the client disappears mid-answer", async () => {
    const saved = await serveOneTurn({ keepAlive: true });

    expect(saved).toHaveLength(1);
    expect(saved[0]!.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("persists the COMPLETE answer, not the part the client had received", async () => {
    const saved = await serveOneTurn({ keepAlive: true });

    expect(answerTextOf(saved[0]!.at(-1))).toBe(FULL_ANSWER);
  });

  it("without it, a disappearing client loses the whole turn (the bug)", async () => {
    const saved = await serveOneTurn({ keepAlive: false });

    expect(saved).toEqual([]);
  });
});
