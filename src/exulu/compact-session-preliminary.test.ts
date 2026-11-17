// A focused file: compact-session.test.ts already fails on the base branch (its provider mock is stale).
jest.mock("./generate-stream", () => ({ getAgentMessages: jest.fn(), saveChat: jest.fn() }));

import type { UIMessage } from "ai";
import { serializeForSummary } from "./compact-session";

const assistant = (parts: object[]): UIMessage => ({ id: "m1", role: "assistant", parts }) as UIMessage;

describe("serializeForSummary and unfinished tool results", () => {
  it("leaves out a tool part persisted with preliminary: true (a read whose stream died)", () => {
    const text = serializeForSummary([
      assistant([
        { type: "text", text: "Reading the offer." },
        {
          type: "tool-parse_document",
          toolCallId: "c1",
          state: "output-available",
          input: { filename: "offer.pdf" },
          output: { status: "reading", filename: "offer.pdf", phase: "ocr", pagesDone: 3, pagesTotal: 40 },
          preliminary: true,
        },
      ]),
    ]);
    expect(text).toContain("Reading the offer.");
    expect(text).not.toContain("parse_document");
    expect(text).not.toContain("reading");
  });

  it("still renders a finished tool part", () => {
    const text = serializeForSummary([
      assistant([
        {
          type: "tool-parse_document",
          toolCallId: "c1",
          state: "output-available",
          input: { filename: "offer.pdf" },
          output: { content: "page text", totalPages: 2 },
        },
      ]),
    ]);
    expect(text).toContain("[tool tool-parse_document");
    expect(text).toContain("page text");
  });
});
