import { createViewDocumentPageTool } from "./view-document-page-tool";
import type { ExuluConfig } from "@SRC/exulu/app";
import type { User } from "@EXULU_TYPES/models/user";
import { clearImageStash, imageAttachmentGuard } from "@SRC/exulu/tool-image-attachments";

jest.mock("@SRC/uppy", () => ({
  getS3ObjectBytes: jest.fn(),
  getS3ObjectEtag: jest.fn().mockResolvedValue('"etag-1"'),
}));
jest.mock("@SRC/sessions/pdf-preview-cache", () => ({
  getPdfPreviewBytes: jest.fn(),
}));
jest.mock("./document-render-helpers", () => ({
  pdfToText: jest.fn(),
  renderPdfPageToPng: jest.fn(),
}));
jest.mock("@SRC/exulu/litellm/catalog", () => ({
  findLiteLLMModel: jest.fn().mockResolvedValue(undefined),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getS3ObjectBytes } = require("@SRC/uppy") as { getS3ObjectBytes: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getPdfPreviewBytes } = require("@SRC/sessions/pdf-preview-cache") as { getPdfPreviewBytes: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderPdfPageToPng } = require("./document-render-helpers") as { renderPdfPageToPng: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findLiteLLMModel } = require("@SRC/exulu/litellm/catalog") as { findLiteLLMModel: jest.Mock };

beforeAll(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => {
  (console.warn as jest.Mock).mockRestore();
});

const exuluConfig = {
  fileUploads: { s3Bucket: "bucket", s3prefix: "exulu" },
} as unknown as ExuluConfig;
const user = { id: 7 } as User;

type ViewResult = { attached?: boolean; filename?: string; page?: number; note?: string; error?: string };
const runTool = (input: Record<string, unknown>, toolCallId = "call_test"): Promise<ViewResult> => {
  const tool = createViewDocumentPageTool({ sessionID: "s1", user, exuluConfig })!;
  return (tool.tool!.execute as (i: unknown, o: unknown) => Promise<ViewResult>)(input, { toolCallId, messages: [] });
};

/** Reads back what execute stashed, via the guard's injection output. */
const injectedFor = async (toolCallId: string) => {
  const guard = imageAttachmentGuard();
  const result = (await guard({
    stepNumber: 1,
    messages: [
      { role: "tool", content: [{ type: "tool-result", toolCallId, toolName: "view_document_page", output: {} }] },
    ],
  })) as { messages?: Array<{ role: string; content: Array<Record<string, unknown>> }> } | undefined;
  return result?.messages?.[1];
};

afterEach(() => {
  jest.clearAllMocks();
  clearImageStash();
});

it("renders a PDF page, stashes it, and returns a marker", async () => {
  getS3ObjectBytes.mockResolvedValue(Buffer.from("%PDF"));
  renderPdfPageToPng.mockResolvedValue(Buffer.from("png-bytes"));
  const result = await runTool({ filename: "report.pdf", page: 2, model: { modelId: "claude-x" } }, "call_pdf");
  expect(result).toEqual({
    attached: true,
    filename: "report.pdf",
    page: 2,
    note: "The rendered image follows this tool result as an attached user message — analyze it there. If no image message follows, the attachment has expired; call this tool again to re-render it.",
  });
  expect(renderPdfPageToPng).toHaveBeenCalledWith(expect.any(Buffer), 2, 1568);
  const injected = await injectedFor("call_pdf");
  expect(injected?.content[1]).toMatchObject({ type: "image", mediaType: "image/png" });
});

it("returns an error for a page beyond the document", async () => {
  getS3ObjectBytes.mockResolvedValue(Buffer.from("%PDF"));
  renderPdfPageToPng.mockResolvedValue(null);
  const result = await runTool({ filename: "report.pdf", page: 99, model: {} });
  expect(result.error).toMatch(/page 99/i);
});

it("converts office files to PDF via the preview cache before rendering", async () => {
  getPdfPreviewBytes.mockResolvedValue(Buffer.from("%PDF-converted"));
  renderPdfPageToPng.mockResolvedValue(Buffer.from("png-bytes"));
  const result = await runTool({ filename: "deck.pptx", page: 3, model: {} }, "call_office");
  expect(result.attached).toBe(true);
  expect(getPdfPreviewBytes).toHaveBeenCalledWith({
    sourceKey: "exulu/user_7/sessions/s1/deck.pptx",
    etag: '"etag-1"',
    config: exuluConfig,
  });
  expect(getS3ObjectBytes).not.toHaveBeenCalled();
});

it("returns image files directly with their own media type", async () => {
  getS3ObjectBytes.mockResolvedValue(Buffer.from("jpeg-bytes"));
  const result = await runTool({ filename: "screenshot.jpg", model: {} }, "call_img");
  expect(result.attached).toBe(true);
  expect(renderPdfPageToPng).not.toHaveBeenCalled();
  const injected = await injectedFor("call_img");
  expect(injected?.content[1]).toMatchObject({ type: "image", mediaType: "image/jpeg" });
});

it("re-renders at 1024px when the 1568px render exceeds the byte cap", async () => {
  getS3ObjectBytes.mockResolvedValue(Buffer.from("%PDF"));
  renderPdfPageToPng
    .mockResolvedValueOnce(Buffer.alloc(4_000_000))
    .mockResolvedValueOnce(Buffer.from("small-png"));
  const result = await runTool({ filename: "huge.pdf", page: 1, model: {} });
  expect(result.attached).toBe(true);
  expect(renderPdfPageToPng).toHaveBeenNthCalledWith(2, expect.any(Buffer), 1, 1024);
});

it("reports a size failure (not missing page) when the fallback render returns null", async () => {
  getS3ObjectBytes.mockResolvedValue(Buffer.from("%PDF"));
  renderPdfPageToPng
    .mockResolvedValueOnce(Buffer.alloc(4_000_000))
    .mockResolvedValueOnce(null);
  const result = await runTool({ filename: "huge.pdf", page: 1, model: {} });
  expect(result.error).toMatch(/size limit/i);
  expect(result.error).not.toMatch(/fewer pages/i);
});

it("rejects oversized source images (no downscale path without an image library)", async () => {
  getS3ObjectBytes.mockResolvedValue(Buffer.alloc(4_000_000));
  const result = await runTool({ filename: "photo.png", model: {} });
  expect(result.error).toMatch(/too large/i);
});

it("refuses when the LiteLLM catalog says the model has no vision", async () => {
  findLiteLLMModel.mockResolvedValue({ supports_vision: false });
  const result = await runTool({ filename: "report.pdf", model: { modelId: "text-only-model" } });
  expect(result.error).toMatch(/does not support images/i);
  expect(getS3ObjectBytes).not.toHaveBeenCalled();
});

it("proceeds when the catalog lookup fails (non-LiteLLM mode)", async () => {
  findLiteLLMModel.mockRejectedValue(new Error("litellm not running"));
  getS3ObjectBytes.mockResolvedValue(Buffer.from("%PDF"));
  renderPdfPageToPng.mockResolvedValue(Buffer.from("png"));
  const result = await runTool({ filename: "report.pdf", model: { modelId: "catalog-mode-model" } });
  expect(result.attached).toBe(true);
});

it("rejects unsupported extensions and path traversal", async () => {
  expect((await runTool({ filename: "notes.txt", model: {} })).error).toMatch(/Unsupported/);
  expect((await runTool({ filename: "../x.pdf", model: {} })).error).toMatch(/Invalid filename/);
});
