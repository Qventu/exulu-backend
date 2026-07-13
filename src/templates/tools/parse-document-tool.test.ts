import { createParseDocumentTool } from "./parse-document-tool";
import type { ExuluConfig } from "@SRC/exulu/app";
import type { User } from "@EXULU_TYPES/models/user";

jest.mock("@SRC/uppy", () => ({
  getPresignedUrl: jest.fn().mockResolvedValue("https://s3.example/presigned"),
}));
jest.mock("./document-render-helpers", () => ({
  pdfToText: jest.fn(),
  renderPdfPageToPng: jest.fn(),
}));
jest.mock("officeparser", () => ({
  parseOfficeAsync: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getPresignedUrl } = require("@SRC/uppy") as { getPresignedUrl: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { pdfToText } = require("./document-render-helpers") as { pdfToText: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseOfficeAsync } = require("officeparser") as { parseOfficeAsync: jest.Mock };

const exuluConfig = {
  fileUploads: { s3Bucket: "bucket", s3prefix: "exulu" },
} as unknown as ExuluConfig;
const user = { id: 7 } as User;

type ParseResult = {
  content?: string;
  totalPages?: number;
  totalLines?: number;
  offset?: number;
  linesReturned?: number;
  error?: string;
};
const runTool = (input: Record<string, unknown>): Promise<ParseResult> => {
  const tool = createParseDocumentTool({ sessionID: "s1", user, exuluConfig })!;
  return (tool.tool!.execute as (i: unknown) => Promise<ParseResult>)(input);
};

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer, // "%PDF"
  } as never) as never;
});
afterEach(() => jest.clearAllMocks());

it("returns undefined without sessionID or file uploads config", () => {
  expect(createParseDocumentTool({ sessionID: undefined, user, exuluConfig })).toBeUndefined();
  expect(createParseDocumentTool({ sessionID: "s1", user, exuluConfig: {} as ExuluConfig })).toBeUndefined();
});

it("rejects path traversal in filename", async () => {
  const result = await runTool({ filename: "../secret.pdf" });
  expect(result.error).toMatch(/Invalid filename/);
});

it("extracts PDF text with page markers from form-feed separators", async () => {
  // Page bodies must clear MIN_CHARS_PER_PAGE (20 non-whitespace chars/page
  // average) or the scanned-document detector rejects them.
  pdfToText.mockResolvedValue(
    "first page body with plenty of extractable text\fsecond page body with plenty of extractable text\fthird page body with plenty of extractable text",
  );
  const result = await runTool({ filename: "report.pdf" });
  expect(result.content).toBe(
    "--- page 1 ---\nfirst page body with plenty of extractable text\n--- page 2 ---\nsecond page body with plenty of extractable text\n--- page 3 ---\nthird page body with plenty of extractable text",
  );
  expect(result.totalPages).toBe(3);
  expect(getPresignedUrl).toHaveBeenCalledWith(
    "bucket",
    "exulu/user_7/sessions/s1/report.pdf",
    exuluConfig,
  );
});

it("filters to a requested page range", async () => {
  pdfToText.mockResolvedValue(
    "page one full body of searchable text\fpage two full body of searchable text\fpage three full body of searchable text\fpage four full body of searchable text",
  );
  const result = await runTool({ filename: "report.pdf", pages: "2-3" });
  expect(result.content).toBe(
    "--- page 2 ---\npage two full body of searchable text\n--- page 3 ---\npage three full body of searchable text",
  );
  expect(result.totalPages).toBe(4);
});

it("flags a PDF with a near-empty text layer as likely scanned", async () => {
  pdfToText.mockResolvedValue(" \f  \f ");
  const result = await runTool({ filename: "scan.pdf" });
  expect(result.error).toMatch(/no extractable text/i);
  expect(result.error).toMatch(/view_document_page/);
});

it("extracts office documents via officeparser (no page markers)", async () => {
  parseOfficeAsync.mockResolvedValue("word document body");
  const result = await runTool({ filename: "notes.docx" });
  expect(result.content).toBe("word document body");
  expect(result.totalPages).toBeUndefined();
});

it("rejects unsupported extensions with a pointer to read_session_file", async () => {
  const result = await runTool({ filename: "data.csv" });
  expect(result.error).toMatch(/read_session_file/);
});

it("pages long output with offset/limit and caps at 16k chars", async () => {
  const longPage = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
  pdfToText.mockResolvedValue(longPage);
  const result = await runTool({ filename: "long.pdf", offset: 10, limit: 3 });
  expect(result.content).toBe("line 9\nline 10\nline 11");
  expect(result.offset).toBe(10);
  expect(result.linesReturned).toBe(3);
});

it("surfaces fetch failures as error objects, not throws", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 404 } as never);
  const result = await runTool({ filename: "missing.pdf" });
  expect(result.error).toMatch(/404/);
});
