import { convertToModelMessages, type UIMessage } from "ai";

it("a persisted preliminary tool part (read aborted mid-way) yields no tool result for the model", async () => {
  const messages = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "read it" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-parse_document",
          toolCallId: "c1",
          state: "output-available",
          preliminary: true,
          input: { filename: "a.pdf" },
          output: { status: "reading", filename: "a.pdf", phase: "ocr", pagesDone: 1, pagesTotal: 9 },
        },
      ],
    },
  ] as unknown as UIMessage[];
  const out = await convertToModelMessages(messages, { ignoreIncompleteToolCalls: true });
  const serialized = JSON.stringify(out);
  expect(serialized).not.toContain("tool-result");
  expect(serialized).not.toContain('"status":"reading"');
});
