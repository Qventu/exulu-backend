import { attachmentMaxPages, extractDocument, pagesToText, tooLongForToolNotice, tooLongNotice, validateAttachmentsConfig } from "./attachment-text";
import type { ExuluConfig } from "./app";

const withProcessor = {
  attachments: { documentProcessor: { processor: { name: "mistral", model: "vertex-ocr" }, vlm: { model: "vertex-gemini-2.5-flash", concurrency: 4 } } },
} as unknown as ExuluConfig;

const bytes = Buffer.from("%PDF-1.4 fake");
const twoPages = async () => 2;

describe("extractDocument", () => {
  it("uses the configured OCR/VLM processor and prefers the VLM-corrected page text", async () => {
    const process = jest.fn().mockResolvedValue([
      { page: 1, content: "Kennwort: BLAUWAL-47ll", vlm_corrected_text: "Kennwort: BLAUWAL-4711", headings: [] },
      { page: 2, content: "Typenschild: AZBZ 130 DE", headings: [] },
    ]);
    const officeParse = jest.fn();

    const result = await extractDocument({ bytes, filename: "Anfrage.pdf", exuluConfig: withProcessor, attribution: { userId: 14 }, process, officeParse, countPages: twoPages });

    expect(result.engine).toBe("document-processor");
    expect(result.pages).toEqual([
      { page: 1, text: "Kennwort: BLAUWAL-4711" },
      { page: 2, text: "Typenschild: AZBZ 130 DE" },
    ]);
    expect(result.text).toBe("--- page 1 ---\nKennwort: BLAUWAL-4711\n--- page 2 ---\nTypenschild: AZBZ 130 DE");
    expect(officeParse).not.toHaveBeenCalled();
    const call = process.mock.calls[0][0];
    expect(call.name).toBe("Anfrage.pdf");
    expect(call.config.processor).toEqual({ name: "mistral", model: "vertex-ocr" });
    expect(call.config.attribution).toEqual({ userId: 14 });
    // Chat reads share the process-wide provider ceilings; knowledge-base callers do not pass them.
    const { processWideLimiters } = require("@EE/python/documents/processing/limits");
    expect(processWideLimiters).toBeDefined();
    expect(call.limiters).toBe(processWideLimiters);
  });

  it("falls back to officeparser when no processor is configured", async () => {
    const process = jest.fn();
    const officeParse = jest.fn().mockResolvedValue("  plain text layer \n");

    const result = await extractDocument({ bytes, filename: "Anfrage.pdf", exuluConfig: {} as ExuluConfig, process, officeParse });

    expect(result).toEqual({ pages: [{ page: 1, text: "plain text layer" }], text: "plain text layer", engine: "officeparser" });
    expect(process).not.toHaveBeenCalled();
  });

  it("falls back to officeparser when the processor throws (licence, unsupported type, OCR outage)", async () => {
    const process = jest.fn().mockRejectedValue(new Error("Advanced document processing is an enterprise feature"));
    const officeParse = jest.fn().mockResolvedValue("text layer");

    const result = await extractDocument({ bytes, filename: "Anfrage.pdf", exuluConfig: withProcessor, process, officeParse, countPages: twoPages });

    expect(result.engine).toBe("officeparser");
    expect(result.text).toBe("text layer");
  });

  it("falls back when the processor returns only empty pages", async () => {
    const process = jest.fn().mockResolvedValue([{ page: 1, content: "   ", headings: [] }]);
    const officeParse = jest.fn().mockResolvedValue("");

    const result = await extractDocument({ bytes, filename: "leer.pdf", exuluConfig: withProcessor, process, officeParse, countPages: twoPages });

    expect(result.engine).toBe("officeparser");
    expect(result.text).toBe("");
  });

  it("joins a single page without a page marker", () => {
    expect(pagesToText([{ page: 1, text: " nur eine Seite " }])).toBe("nur eine Seite");
    expect(pagesToText([])).toBe("");
  });
});

describe("validateAttachmentsConfig", () => {
  const licensed = { "advanced-document-processing": true };

  it("accepts an absent config (feature off) and a complete one", () => {
    expect(validateAttachmentsConfig(undefined, { "advanced-document-processing": false })).toEqual([]);
    expect(validateAttachmentsConfig({} as ExuluConfig, { "advanced-document-processing": false })).toEqual([]);
    expect(validateAttachmentsConfig(withProcessor, licensed)).toEqual([]);
  });

  it("names every missing piece: engine, OCR model, VLM model, concurrency, licence", () => {
    const broken = {
      attachments: { documentProcessor: { processor: { name: "mistral" }, vlm: { model: " ", concurrency: 0 } } },
    } as unknown as ExuluConfig;
    const problems = validateAttachmentsConfig(broken, { "advanced-document-processing": false });
    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toMatch(/processor\.model/);
    expect(problems.join("\n")).toMatch(/vlm\.model/);
    expect(problems.join("\n")).toMatch(/vlm\.concurrency/);
    expect(problems.join("\n")).toMatch(/enterprise licence/);
  });

  it("rejects an unknown engine", () => {
    const unknown = { attachments: { documentProcessor: { processor: { name: "tesseract" } } } } as unknown as ExuluConfig;
    expect(validateAttachmentsConfig(unknown, licensed)).toEqual([
      expect.stringMatching(/processor\.name must be one of/),
    ]);
  });
});

describe("attachment page cap", () => {
  it("refuses a PDF over the cap with a notice and without calling the processor", async () => {
    const process = jest.fn();
    const officeParse = jest.fn();
    const result = await extractDocument({
      bytes, filename: "Handbuch.pdf", exuluConfig: withProcessor, process, officeParse, countPages: async () => 100,
    });
    expect(result.tooLong).toEqual({ pageCount: 100, maxPages: 50 });
    expect(result.pages).toEqual([]);
    expect(result.text).toContain('"Handbuch.pdf" has 100 pages');
    expect(result.text).toContain("limit for attachments is 50 pages");
    expect(process).not.toHaveBeenCalled();
    expect(officeParse).not.toHaveBeenCalled();
  });

  it("does not count pages for non-PDF files or without a processor", async () => {
    const countPages = jest.fn();
    const process = jest.fn().mockResolvedValue([{ page: 1, content: "docx text", headings: [] }]);
    await extractDocument({ bytes, filename: "Angebot.docx", exuluConfig: withProcessor, process, countPages });
    await extractDocument({ bytes, filename: "Handbuch.pdf", exuluConfig: {} as ExuluConfig, officeParse: async () => "x", countPages });
    expect(countPages).not.toHaveBeenCalled();
  });

  it("reads EXULU_ATTACHMENT_MAX_PAGES and falls back to 50 on nonsense", () => {
    expect(attachmentMaxPages({})).toBe(50);
    expect(attachmentMaxPages({ EXULU_ATTACHMENT_MAX_PAGES: "40" })).toBe(40);
    expect(attachmentMaxPages({ EXULU_ATTACHMENT_MAX_PAGES: "0" })).toBe(50);
    expect(attachmentMaxPages({ EXULU_ATTACHMENT_MAX_PAGES: "viele" })).toBe(50);
  });
});

describe("long documents through the tool path", () => {
  const pageResult = (n: number) => Array.from({ length: n }, (_, i) => ({ page: i + 1, content: `text ${i + 1}`, headings: [] }));

  it("with maxPages 300 reads a 120-page PDF and forwards the tool options to the processor", async () => {
    const process = jest.fn().mockResolvedValue(pageResult(120));
    const onProgress = jest.fn();
    const result = await extractDocument({
      bytes, filename: "Handbuch.pdf", exuluConfig: withProcessor, process, countPages: async () => 120,
      maxPages: 300, tolerateVisionFailures: true, onProgress,
    });
    expect(result.tooLong).toBeUndefined();
    expect(result.pages).toHaveLength(120);
    expect(result.degradedPages).toBeUndefined();
    const call = process.mock.calls[0][0];
    expect(call.tolerateVisionFailures).toBe(true);
    expect(call.onProgress).toBe(onProgress);
  });

  it("refuses 301 pages with the tool notice", async () => {
    const process = jest.fn();
    const result = await extractDocument({
      bytes, filename: "Riesig.pdf", exuluConfig: withProcessor, process, countPages: async () => 301, maxPages: 300,
    });
    expect(result.tooLong).toEqual({ pageCount: 301, maxPages: 300 });
    expect(result.text).toBe(tooLongForToolNotice("Riesig.pdf", 301, 300));
    expect(result.text).toBe(
      '[Document too long: "Riesig.pdf" has 301 pages, the limit for reading a document is 300 pages (EXULU_DOCUMENT_MAX_PAGES). ' +
      "The document was NOT read. Tell the user plainly and suggest splitting the file.]",
    );
    expect(process).not.toHaveBeenCalled();
  });

  it("inline attachments (no maxPages) still refuse at 51 with the attachment notice", async () => {
    const process = jest.fn();
    const result = await extractDocument({ bytes, filename: "Handbuch.pdf", exuluConfig: withProcessor, process, countPages: async () => 51 });
    expect(result.tooLong).toEqual({ pageCount: 51, maxPages: 50 });
    expect(result.text).toBe(tooLongNotice("Handbuch.pdf", 51, 50));
    expect(process).not.toHaveBeenCalled();
  });

  it("lists pages whose vision pass failed in degradedPages", async () => {
    const process = jest.fn().mockResolvedValue([
      { page: 1, content: "a", headings: [] },
      { page: 2, content: "b", vlm_failed: true, headings: [] },
      { page: 3, content: "c", vlm_failed: true, headings: [] },
    ]);
    const result = await extractDocument({
      bytes, filename: "x.pdf", exuluConfig: withProcessor, process, countPages: async () => 3, maxPages: 300, tolerateVisionFailures: true,
    });
    expect(result.degradedPages).toEqual([2, 3]);
    expect(result.engine).toBe("document-processor");
  });
});

describe("validateAttachmentsConfig ocr.concurrency", () => {
  const licensed = { "advanced-document-processing": true };
  const withOcr = (ocr: unknown) =>
    ({ attachments: { documentProcessor: { ...(withProcessor.attachments!.documentProcessor as object), ocr } } }) as unknown as ExuluConfig;
  it("accepts integers 1..8 and absence", () => {
    expect(validateAttachmentsConfig(withOcr({ concurrency: 1 }), licensed)).toEqual([]);
    expect(validateAttachmentsConfig(withOcr({ concurrency: 8 }), licensed)).toEqual([]);
    expect(validateAttachmentsConfig(withOcr({}), licensed)).toEqual([]);
  });
  it.each([0, 9, 2.5, "3"])("rejects %p", (value) => {
    expect(validateAttachmentsConfig(withOcr({ concurrency: value }), licensed)).toEqual([
      "attachments.documentProcessor.ocr.concurrency must be an integer from 1 to 8",
    ]);
  });
});
