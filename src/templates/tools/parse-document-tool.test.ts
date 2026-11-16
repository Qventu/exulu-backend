import { createParseDocumentTool, binaryDocumentBashHint } from "./parse-document-tool";
import type { ExuluConfig } from "@SRC/exulu/app";
import type { User } from "@EXULU_TYPES/models/user";

// In-memory stand-in for the bucket: source files and the derived text store share it.
const bucket = new Map<string, { body: Buffer | string; lastModified: Date }>();
jest.mock("@SRC/uppy", () => ({
  isS3NotFound: (e: { name?: string }) => e?.name === "NoSuchKey",
  headS3ObjectExact: jest.fn(async (key: string) => (bucket.has(key) ? { etag: `"etag-${key}"` } : null)),
  getS3ObjectBytes: jest.fn(async (key: string) => {
    const obj = bucket.get(key);
    if (!obj) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    return Buffer.from(obj.body);
  }),
  getS3ObjectTextExact: jest.fn(async (key: string) => {
    const obj = bucket.get(key);
    return obj ? { text: String(obj.body), lastModified: obj.lastModified } : null;
  }),
  putS3ObjectTextExact: jest.fn(async (key: string, text: string) => {
    bucket.set(key, { body: text, lastModified: new Date() });
  }),
}));
jest.mock("./document-render-helpers", () => ({
  pdfToText: jest.fn(),
  renderPdfPageToPng: jest.fn(),
  isLegacyOfficeFormat: jest.requireActual("./document-render-helpers").isLegacyOfficeFormat,
  convertLegacyOfficeToModern: jest.fn(),
}));
jest.mock("@SRC/exulu/attachment-text", () => ({ extractDocument: jest.fn() }));
jest.mock("officeparser", () => ({
  parseOfficeAsync: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const uppy = require("@SRC/uppy") as { getS3ObjectBytes: jest.Mock; putS3ObjectTextExact: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { pdfToText, convertLegacyOfficeToModern } = require("./document-render-helpers") as {
  pdfToText: jest.Mock;
  convertLegacyOfficeToModern: jest.Mock;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractDocument } = require("@SRC/exulu/attachment-text") as { extractDocument: jest.Mock };
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
/** The tool's final result: the last value its generator yields (what the SDK sends the model). */
const finalOf = async (r: unknown): Promise<ParseResult> => {
  if (r && typeof r === "object" && Symbol.asyncIterator in r) {
    let last: unknown;
    for await (const v of r as AsyncGenerator<unknown>) last = v;
    return last as ParseResult;
  }
  return (await r) as ParseResult;
};
const runTool = (input: Record<string, unknown>): Promise<ParseResult> => {
  const tool = createParseDocumentTool({ sessionID: "s1", user, exuluConfig })!;
  return finalOf((tool.tool!.execute as (i: unknown) => unknown)(input));
};

const PDF_BYTES = Buffer.from([37, 80, 68, 70]); // "%PDF"
const put = (key: string, body: Buffer = PDF_BYTES) => bucket.set(key, { body, lastModified: new Date() });
beforeEach(() => {
  bucket.clear();
  put("exulu/user_7/sessions/s1/report.pdf");
  put("exulu/user_7/sessions/s1/scan.pdf");
  put("exulu/user_7/sessions/s1/long.pdf");
  put("exulu/user_7/sessions/s1/notes.docx");
  put("exulu/user_7/sessions/s1/FU_Preise.xls");
  put("exulu/user_7/sessions/s1/1200_LV-Auszug.pdf");
  put("exulu/user_11/sessions/s1/Anfrage 04072.pdf");
  put("exulu/projects/p1/files/a.pdf");
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
  expect(uppy.getS3ObjectBytes).toHaveBeenCalledWith("exulu/user_7/sessions/s1/report.pdf", exuluConfig);
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
  // .docx is already a modern format — no LibreOffice round-trip needed.
  expect(convertLegacyOfficeToModern).not.toHaveBeenCalled();
});

it("converts legacy .xls/.doc/.ppt/.rtf via LibreOffice before handing bytes to officeparser", async () => {
  // officeparser's own dispatch has no case for these extensions and would
  // otherwise fail with "add support for cfb files" — this is the fix for
  // the reported "xls Dateien lassen sich nicht öffnen" feedback.
  const convertedBytes = Buffer.from("converted xlsx bytes");
  convertLegacyOfficeToModern.mockResolvedValue(convertedBytes);
  parseOfficeAsync.mockResolvedValue("price list body");

  const result = await runTool({ filename: "FU_Preise.xls" });

  expect(convertLegacyOfficeToModern).toHaveBeenCalledWith(expect.any(Buffer), ".xls");
  expect(parseOfficeAsync).toHaveBeenCalledWith(convertedBytes, expect.anything());
  expect(result.content).toBe("price list body");
});

it("rejects the pages option for non-PDF formats", async () => {
  const result = await runTool({ filename: "notes.docx", pages: "2" });
  expect(result.error).toMatch(/only supported for PDF/);
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
  expect(result.totalLines).toBe(501);
});

it("surfaces fetch failures as error objects, not throws", async () => {
  const result = await runTool({ filename: "missing.pdf" });
  expect(result.error).toMatch(/404/);
});

it("rejects degenerate page ranges", async () => {
  pdfToText.mockResolvedValue(
    "page one full body of searchable text\fpage two full body of searchable text\fpage three full body of searchable text\fpage four full body of searchable text",
  );
  expect((await runTool({ filename: "report.pdf", pages: "0-5" })).error).toMatch(/start must be at least 1/);
  expect((await runTool({ filename: "report.pdf", pages: "3-1" })).error).toMatch(/not greater than the end/);
  expect((await runTool({ filename: "report.pdf", pages: "9-12" })).error).toMatch(/only 4 pages/);
});

it("flags a PDF whose text layer comes out glyph-shifted (digits become control characters) as unreadable", async () => {
  // Real-world sample: every character code is offset by 29, so "Technische Daten"
  // extracts as "7HFKQLVFKH 'DWHQ" and the digits of "7000" become \x1a\x13\x13\x13.
  const shifted = (s: string) => Array.from(s, (c) => (c === "\n" || c === " " ? c : String.fromCharCode(c.charCodeAt(0) - 29))).join("");
  const page = shifted("Leistungsverzeichnis Modernisierung Aufzugsanlagen\nTechnische Daten\nTragkraft kg 7000\nFahrkorbgewicht kg 4500\nFoerderhoehe m 13.5\n");
  pdfToText.mockResolvedValue(page + "\f" + page + "\f");
  const result = await runTool({ filename: "1200_LV-Auszug.pdf" });
  expect(result.content).toBeUndefined();
  expect(result.error).toMatch(/text layer.*unreadable|unreadable.*text layer/i);
  expect(result.error).toMatch(/view_document_page/);
});

describe("binaryDocumentBashHint — nudges agents off grep/cat against binary documents", () => {
  // Real incident, 2026-09-14 (job 40a1f12d): ALFREDO_2 grepped a PDF directly for
  // "Schelle" ~25 times in a row (each grep silently returning nothing, since the
  // file is compressed binary, not plain text), ballooning the turn to 1.4M tokens
  // and failing CONTEXT_COMPACTION_REQUIRED. The agent had already successfully
  // extracted the same PDF's text via parse_document earlier in the same turn.
  it("hints when grep against a PDF returns nothing", () => {
    const hint = binaryDocumentBashHint(
      'grep -i "Schelle" Auftrag_23206780_Schindler_20260911125129.371_X.pdf',
      "",
      "",
    );
    expect(hint).toMatch(/Auftrag_23206780_Schindler_20260911125129\.371_X\.pdf/);
    expect(hint).toMatch(/parse_document/);
  });

  it("hints when cat against a .docx returns garbled binary content", () => {
    const garbled = "PK\x03\x04\x14\x00\x00\x00\x08\x00" + "\x01\x02\x03".repeat(30);
    const hint = binaryDocumentBashHint("cat notes.docx", garbled, "");
    expect(hint).toMatch(/notes\.docx/);
  });

  it("does not hint when the command has no binary-document filename", () => {
    expect(binaryDocumentBashHint('grep -i "Schelle" notes.txt', "", "")).toBeUndefined();
  });

  it("does not hint when the search actually found readable text", () => {
    const hint = binaryDocumentBashHint(
      "grep -i Schelle extracted_text.pdf.txt",
      "Position 3.2 Schelle 48-52 mm",
      "",
    );
    expect(hint).toBeUndefined();
  });

  it("does not hint when a PDF command returns real output (e.g. ls -la)", () => {
    const hint = binaryDocumentBashHint("ls -la report.pdf", "-rw-r--r-- 1 user user 48213 report.pdf", "");
    expect(hint).toBeUndefined();
  });
});

describe("stored text", () => {
  const PAGES =
    "page one full body of searchable text\fpage two full body of searchable text\fpage three full body of searchable text\fpage four full body of searchable text";

  it("two calls for one file extract once, and pages/lines are applied to the stored text", async () => {
    pdfToText.mockResolvedValue(PAGES);
    const first = await runTool({ filename: "report.pdf", pages: "2-3" });
    const second = await runTool({ filename: "report.pdf", pages: "2-3" });
    expect(pdfToText).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ ...first, fromStore: true });
    expect(second.content).toBe(
      "--- page 2 ---\npage two full body of searchable text\n--- page 3 ---\npage three full body of searchable text",
    );
    expect(second.totalPages).toBe(4);
    const whole = await runTool({ filename: "report.pdf", offset: 3, limit: 2 });
    expect(pdfToText).toHaveBeenCalledTimes(1);
    expect(whole.content).toBe("--- page 2 ---\npage two full body of searchable text");
    expect(whole.totalLines).toBe(8);
  });

  it("flags a read served from the store with fromStore: true, and a first read has no such key", async () => {
    pdfToText.mockResolvedValue(PAGES);
    const first = await runTool({ filename: "report.pdf" });
    expect(Object.keys(first)).not.toContain("fromStore");
    const second = await runTool({ filename: "report.pdf" });
    expect((second as { fromStore?: boolean }).fromStore).toBe(true);
  });

  it("does not download the source again on a hit", async () => {
    pdfToText.mockResolvedValue(PAGES);
    await runTool({ filename: "report.pdf" });
    uppy.getS3ObjectBytes.mockClear();
    await runTool({ filename: "report.pdf" });
    expect(uppy.getS3ObjectBytes).not.toHaveBeenCalled();
  });

  it("rejects a page range beyond the document on a hit too", async () => {
    pdfToText.mockResolvedValue(PAGES);
    await runTool({ filename: "report.pdf" });
    expect((await runTool({ filename: "report.pdf", pages: "9-12" })).error).toMatch(/only 4 pages/);
  });

  it("does not store a refused scan", async () => {
    pdfToText.mockResolvedValue(" \f  \f ");
    expect((await runTool({ filename: "scan.pdf" })).error).toMatch(/no extractable text/i);
    expect((await runTool({ filename: "scan.pdf" })).error).toMatch(/no extractable text/i);
    expect(pdfToText).toHaveBeenCalledTimes(2);
    expect(uppy.putS3ObjectTextExact).not.toHaveBeenCalled();
  });

  describe("with a document processor", () => {
    const withProcessor = {
      fileUploads: exuluConfig.fileUploads,
      attachments: { documentProcessor: { processor: { name: "mistral" } } },
    } as unknown as ExuluConfig;
    const run = (input: Record<string, unknown>) =>
      finalOf((createParseDocumentTool({ sessionID: "s1", user, exuluConfig: withProcessor })!.tool!.execute as (i: unknown) => unknown)(input));

    it("stores processor output with page markers", async () => {
      extractDocument.mockResolvedValue({
        engine: "document-processor",
        text: "",
        pages: [{ page: 1, text: "alpha" }, { page: 2, text: "beta" }],
      });
      const first = await run({ filename: "report.pdf", pages: "2" });
      const second = await run({ filename: "report.pdf", pages: "2" });
      expect(first.content).toBe("--- page 2 ---\nbeta");
      expect(second).toEqual({ ...first, fromStore: true });
      expect(extractDocument).toHaveBeenCalledTimes(1);
    });

    it("reads with the tool page cap and tolerates vision failures", async () => {
      extractDocument.mockResolvedValue({ engine: "document-processor", text: "", pages: [{ page: 1, text: "a" }, { page: 2, text: "b" }] });
      await run({ filename: "report.pdf" });
      const input = extractDocument.mock.calls[0][0];
      expect(input.maxPages).toBe(300);
      expect(input.tolerateVisionFailures).toBe(true);
    });

    it("refuses over the tool cap with the extraction's notice", async () => {
      extractDocument.mockResolvedValue({ engine: "document-processor", text: "[Document too long: ...]", pages: [], tooLong: { pageCount: 301, maxPages: 300 } });
      expect(await run({ filename: "report.pdf" })).toEqual({ error: "[Document too long: ...]" });
    });

    describe("unverified pages", () => {
      const NOTE = (list: string) => `[Note: figures and tables on page(s) ${list} could not be verified; the text for those pages is OCR only.]`;
      const pagesOf = (n: number) => Array.from({ length: n }, (_, i) => ({ page: i + 1, text: `body ${i + 1}` }));
      const degraded = (n: number, degradedPages: number[]) =>
        extractDocument.mockResolvedValue({ engine: "document-processor", text: "", pages: pagesOf(n), degradedPages });

      it("names the degraded page inside the requested range, as the last line, and does not store", async () => {
        degraded(3, [2]);
        const r = await run({ filename: "report.pdf", pages: "2" });
        expect(r.content).toBe(`--- page 2 ---\nbody 2\n${NOTE("2")}`);
        expect(r.totalLines).toBe(2);
        expect(r.linesReturned).toBe(2);
        await run({ filename: "report.pdf", pages: "2" });
        expect(extractDocument).toHaveBeenCalledTimes(2);
        expect(uppy.putS3ObjectTextExact).not.toHaveBeenCalled();
      });

      it("adds no note when the degraded page is outside the range", async () => {
        degraded(6, [2]);
        const r = await run({ filename: "report.pdf", pages: "5" });
        expect(r.content).toBe("--- page 5 ---\nbody 5");
      });

      it("keeps the note when the degraded page lies far beyond the first slice", async () => {
        degraded(300, [250]);
        const r = await run({ filename: "report.pdf", offset: 1 });
        expect(r.content.endsWith(`\n${NOTE("250")}`)).toBe(true);
        expect(r.content).not.toContain("--- page 250 ---");
        expect(r.linesReturned).toBe(250);
        expect(r.totalLines).toBe(600);
      });

      it("collapses consecutive pages into ranges", async () => {
        degraded(45, [40, 7, 8, 9, 10, 11, 12]);
        const r = await run({ filename: "report.pdf", limit: 1 });
        expect(r.content.endsWith(`\n${NOTE("7-12, 40")}`)).toBe(true);
      });
    });

    it("does not store the officeparser fallback", async () => {
      extractDocument.mockResolvedValue({ engine: "officeparser", text: "x", pages: [{ page: 1, text: "x" }] });
      pdfToText.mockResolvedValue(PAGES);
      await run({ filename: "report.pdf" });
      await run({ filename: "report.pdf" });
      expect(pdfToText).toHaveBeenCalledTimes(2);
      expect(uppy.putS3ObjectTextExact).not.toHaveBeenCalled();
    });
  });

  it("stores the text under the derived prefix with the readable extractor label", async () => {
    parseOfficeAsync.mockResolvedValue("word document body");
    await runTool({ filename: "notes.docx" });
    const [key, text, metadata] = uppy.putS3ObjectTextExact.mock.calls[0];
    expect(key).toMatch(/^exulu\/derived\/content\/[0-9a-f]{64}\/[0-9a-f]{16}\.md$/);
    expect(text).toBe("word document body");
    expect(metadata).toEqual({ "exulu-extractor": "officeparser@1" });
  });
});

it("addresses the session file under the session owner's prefix when an owner is given", async () => {
  pdfToText.mockResolvedValue("Some perfectly readable page content with enough characters.\f");
  const tool = createParseDocumentTool({ sessionID: "s1", user, exuluConfig, ownerId: 11 })!;
  await finalOf((tool.tool!.execute as (i: unknown) => unknown)({ filename: "Anfrage 04072.pdf" }));
  expect(uppy.getS3ObjectBytes).toHaveBeenCalledWith("exulu/user_11/sessions/s1/Anfrage 04072.pdf", exuluConfig);
});

describe("project files", () => {
  const runWith = (projectId: string | null, input: Record<string, unknown>): Promise<ParseResult> => {
    const tool = createParseDocumentTool({ sessionID: "s1", user, exuluConfig, projectId })!;
    return finalOf((tool.tool!.execute as (i: unknown) => unknown)(input));
  };
  it("reads project/<name> from the project key", async () => {
    pdfToText.mockResolvedValue("a page body with plenty of extractable text for the detector");
    const result = await runWith("p1", { filename: "project/a.pdf" });
    expect(result.error).toBeUndefined();
    expect(uppy.getS3ObjectBytes).toHaveBeenCalledWith("exulu/projects/p1/files/a.pdf", exuluConfig);
  });
  it("refuses project/<name> without a resolved project", async () => {
    const result = await runWith(null, { filename: "project/a.pdf" });
    expect(result.error).toBe("This session has no project files.");
    expect(uppy.getS3ObjectBytes).not.toHaveBeenCalled();
  });
  it("tells the model how project files are addressed", () => {
    const tool = createParseDocumentTool({ sessionID: "s1", user, exuluConfig })!;
    expect(tool.description).toMatch(/project\/<name>.*read-only/);
  });
});

describe("reading progress", () => {
  const withProcessor = {
    fileUploads: exuluConfig.fileUploads,
    attachments: { documentProcessor: { processor: { name: "mistral" } } },
  } as unknown as ExuluConfig;
  const gen = (input: Record<string, unknown>) =>
    (createParseDocumentTool({ sessionID: "s1", user, exuluConfig: withProcessor })!.tool!.execute as (i: unknown) => AsyncGenerator<Record<string, unknown>>)(input);
  const collect = async (g: AsyncGenerator<Record<string, unknown>>) => {
    const out: Array<Record<string, unknown>> = [];
    for await (const v of g) out.push(v);
    return out;
  };
  const processorPages = { engine: "document-processor", text: "", pages: [{ page: 1, text: "alpha" }, { page: 2, text: "beta" }] };

  it("yields interim reading objects first and exactly one final result last", async () => {
    extractDocument.mockImplementation(async (input: { onProgress: (p: unknown) => void }) => {
      input.onProgress({ phase: "ocr", pagesDone: 1, pagesTotal: 2 });
      await new Promise((r) => setTimeout(r, 5));
      input.onProgress({ phase: "ocr", pagesDone: 2, pagesTotal: 2 });
      return processorPages;
    });
    const out = await collect(gen({ filename: "report.pdf" }));
    const interim = out.filter((v) => v.status === "reading");
    const finals = out.filter((v) => v.status !== "reading");
    expect(finals).toHaveLength(1);
    expect(out[out.length - 1]).toBe(finals[0]);
    expect(finals[0]!.content).toBe("--- page 1 ---\nalpha\n--- page 2 ---\nbeta");
    expect(interim[0]).toEqual({ status: "reading", filename: "report.pdf", phase: "ocr", pagesDone: 1, pagesTotal: 2 });
    expect(interim.some((v) => v.phase === "ocr" && v.pagesDone === 2)).toBe(true);
    expect(interim.some((v) => v.phase === "storing")).toBe(true);
  });

  it("throttles interim objects to one per second but always lets the final page count through", async () => {
    extractDocument.mockImplementation(async (input: { onProgress: (p: unknown) => void }) => {
      for (let i = 1; i <= 5; i++) input.onProgress({ phase: "vision", pagesDone: i, pagesTotal: 5 });
      return processorPages;
    });
    const out = await collect(gen({ filename: "report.pdf" }));
    const vision = out.filter((v) => v.phase === "vision").map((v) => v.pagesDone);
    expect(vision).toEqual([1, 5]);
  });

  it("yields only the final result on a store hit", async () => {
    extractDocument.mockResolvedValue(processorPages);
    await collect(gen({ filename: "report.pdf" }));
    const out = await collect(gen({ filename: "report.pdf" }));
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBeDefined();
    expect(extractDocument).toHaveBeenCalledTimes(1);
  });

  it("reports an extraction failure as the final error result", async () => {
    // Failures inside the tool body are reported as { error }, as before.
    extractDocument.mockRejectedValue(new Error("boom"));
    const out = await collect(gen({ filename: "report.pdf" }));
    expect(out[out.length - 1]).toEqual({ error: 'Failed to parse "report.pdf": boom' });
  });

  it("does not cancel the extraction when the consumer stops early", async () => {
    let finished = false;
    extractDocument.mockImplementation(async (input: { onProgress: (p: unknown) => void }) => {
      input.onProgress({ phase: "ocr", pagesDone: 1, pagesTotal: 2 });
      await new Promise((r) => setTimeout(r, 20));
      finished = true;
      return processorPages;
    });
    const g = gen({ filename: "report.pdf" });
    await g.next();
    await g.return(undefined);
    await new Promise((r) => setTimeout(r, 60));
    expect(finished).toBe(true);
    expect(uppy.putS3ObjectTextExact).toHaveBeenCalled();
  });

  it("stops queueing progress once the consumer has left", async () => {
    let emit!: (p: unknown) => void;
    let release!: () => void;
    extractDocument.mockImplementation(async (input: { onProgress: (p: unknown) => void }) => {
      emit = input.onProgress;
      input.onProgress({ phase: "ocr", pagesDone: 1, pagesTotal: 3 });
      await new Promise<void>((r) => { release = r; });
      return processorPages;
    });
    const g = gen({ filename: "report.pdf" });
    await g.next();
    await g.return(undefined);
    // Must not throw or retain events; extraction still completes.
    emit({ phase: "ocr", pagesDone: 3, pagesTotal: 3 });
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(uppy.putS3ObjectTextExact).toHaveBeenCalled();
  });
});
