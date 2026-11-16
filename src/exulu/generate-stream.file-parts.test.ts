/**
 * processFilePartsInMessages end to end (finding 4): a document file part whose URL
 * is not on this workspace's storage must not be fetched by the server; it becomes
 * an error text part. Extraction and offload are stubbed: only the fetch decision
 * is under test here.
 */
jest.mock("./attachment-text", () => ({
  extractDocument: jest.fn(async ({ bytes }: { bytes: Buffer }) => ({
    text: bytes.toString("utf8"),
    pages: [bytes.toString("utf8")],
    engine: "stub",
  })),
}));
jest.mock("./tool-output-offload", () => ({
  ...jest.requireActual("./tool-output-offload"),
  guardExtractedFileText: jest.fn(async (_name: string, text: string) => text),
}));

import type { UIMessage } from "ai";
import { processFilePartsInMessages } from "./generate-stream";

const exuluConfig = {
  fileUploads: { s3Bucket: "algi", s3endpoint: "https://minio.api.example.com", s3region: "x", s3key: "k", s3secret: "s" },
} as any;

const userMessage = (part: Record<string, unknown>): UIMessage[] => [
  { id: "m1", role: "user", parts: [part as any, { type: "text", text: "summarise" }] },
];

describe("processFilePartsInMessages", () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn(async () => new Response("manual body", { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it("does not fetch a document part on a foreign host and returns the error text part", async () => {
    const [message] = await processFilePartsInMessages(
      userMessage({ type: "file", mediaType: "application/pdf", filename: "x.pdf", url: "http://169.254.169.254/latest/meta-data/" }),
      { user: { id: 1 } as any, exuluConfig },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(message!.parts[0]).toEqual({
      type: "text",
      text: "[Error: Could not load file x.pdf: only files from this workspace's storage can be attached.]",
    });
    expect(message!.parts[1]).toEqual({ type: "text", text: "summarise" });
  });

  it("fetches a document part on the workspace bucket and inlines its text", async () => {
    const url = "https://minio.api.example.com/algi/items/ctx/manual.pdf?X-Amz-Signature=abc";
    const [message] = await processFilePartsInMessages(
      userMessage({ type: "file", mediaType: "application/pdf", filename: "manual.pdf", url }),
      { user: { id: 1 } as any, exuluConfig },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(url);
    expect((message!.parts[0] as any).text).toContain("manual body");
  });

  it("leaves image parts to the AI SDK (not fetched here)", async () => {
    const [message] = await processFilePartsInMessages(
      userMessage({ type: "file", mediaType: "image/png", filename: "a.png", url: "https://cdn.example.org/a.png" }),
      { user: { id: 1 } as any, exuluConfig },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(message!.parts[0]).toMatchObject({ type: "file", url: "https://cdn.example.org/a.png" });
  });
});
