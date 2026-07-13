import {
  stashToolImage,
  imageAttachmentGuard,
  clearImageStash,
  INJECTED_IMAGE_PREFIX,
} from "./tool-image-attachments";

const PNG_B64 = "aGVsbG8="; // content is irrelevant to the guard

const toolMessage = (toolCallId: string) => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId,
      toolName: "view_document_page",
      output: { type: "json", value: { attached: true } },
    },
  ],
});

afterEach(() => clearImageStash());

it("returns undefined when nothing is stashed", async () => {
  const guard = imageAttachmentGuard();
  const result = await guard({ stepNumber: 1, messages: [toolMessage("call_1")] });
  expect(result).toBeUndefined();
});

it("injects a user image message directly after the matching tool message", async () => {
  stashToolImage("call_1", { data: PNG_B64, mediaType: "image/png", label: "report.pdf page 2" });
  const guard = imageAttachmentGuard();
  const messages = [
    { role: "user", content: "what is on page 2?" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_1", toolName: "view_document_page" }] },
    toolMessage("call_1"),
  ];
  const result = (await guard({ stepNumber: 2, messages })) as { messages: unknown[] };
  expect(result.messages).toHaveLength(4);
  const injected = result.messages[3] as { role: string; content: Array<Record<string, unknown>> };
  expect(injected.role).toBe("user");
  expect((injected.content[0] as { text: string }).text).toBe(`${INJECTED_IMAGE_PREFIX}call_1: report.pdf page 2]`);
  expect(injected.content[1]).toEqual({ type: "image", image: PNG_B64, mediaType: "image/png" });
});

it("keeps injection position between the tool message and later conversation", async () => {
  stashToolImage("call_1", { data: PNG_B64, mediaType: "image/png", label: "report.pdf page 2" });
  const guard = imageAttachmentGuard();
  const messages = [
    toolMessage("call_1"),
    { role: "assistant", content: "the page shows a chart" },
    { role: "user", content: "zoom into the legend" },
  ];
  const result = (await guard({ stepNumber: 3, messages })) as { messages: unknown[] };
  expect(result.messages).toHaveLength(4);
  expect((result.messages[1] as { role: string }).role).toBe("user"); // injected right after tool msg
  expect((result.messages[2] as { content: string }).content).toBe("the page shows a chart");
});

it("does not double-inject when an injected message already follows", async () => {
  stashToolImage("call_1", { data: PNG_B64, mediaType: "image/png", label: "x" });
  const guard = imageAttachmentGuard();
  const once = (await guard({ stepNumber: 1, messages: [toolMessage("call_1")] })) as { messages: unknown[] };
  const twice = await guard({ stepNumber: 2, messages: once.messages });
  expect(twice).toBeUndefined();
});

it("injects only missing images when one tool message has multiple tool-results", async () => {
  stashToolImage("call_1", { data: PNG_B64, mediaType: "image/png", label: "a" });
  const guard = imageAttachmentGuard();
  const multiToolMessage = {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: "call_1", toolName: "view_document_page", output: {} },
      { type: "tool-result", toolCallId: "call_2", toolName: "view_document_page", output: {} },
    ],
  };
  const once = (await guard({ stepNumber: 1, messages: [multiToolMessage] })) as { messages: unknown[] };
  expect(once.messages).toHaveLength(2); // call_2 not stashed yet
  stashToolImage("call_2", { data: PNG_B64, mediaType: "image/png", label: "b" });
  const twice = (await guard({ stepNumber: 2, messages: once.messages })) as { messages: unknown[] };
  expect(twice.messages).toHaveLength(3); // only call_2's image added, call_1 not duplicated
  const texts = (twice.messages.slice(1) as Array<{ content: Array<{ text?: string }> }>).map(
    (m) => m.content[0].text ?? "",
  );
  expect(texts.some((t) => t.includes("call_1"))).toBe(true);
  expect(texts.some((t) => t.includes("call_2"))).toBe(true);
});

it("injects multiple stashed images for multiple tool calls", async () => {
  stashToolImage("call_1", { data: PNG_B64, mediaType: "image/png", label: "a" });
  stashToolImage("call_2", { data: PNG_B64, mediaType: "image/png", label: "b" });
  const guard = imageAttachmentGuard();
  const result = (await guard({
    stepNumber: 1,
    messages: [toolMessage("call_1"), toolMessage("call_2")],
  })) as { messages: unknown[] };
  expect(result.messages).toHaveLength(4);
});

it("evicts oldest entries beyond the stash cap", async () => {
  for (let i = 0; i < 105; i++) {
    stashToolImage(`call_${i}`, { data: PNG_B64, mediaType: "image/png", label: `img ${i}` });
  }
  const guard = imageAttachmentGuard();
  const oldest = await guard({ stepNumber: 1, messages: [toolMessage("call_0")] });
  expect(oldest).toBeUndefined(); // evicted
  const newest = await guard({ stepNumber: 1, messages: [toolMessage("call_104")] });
  expect(newest).toBeDefined();
});
