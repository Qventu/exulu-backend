import { attachmentMaxPages, extractDocument, pagesToText, validateAttachmentsConfig } from "./attachment-text";
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
    expect(result.tooLong).toEqual({ pageCount: 100, maxPages: 25 });
    expect(result.pages).toEqual([]);
    expect(result.text).toContain('"Handbuch.pdf" has 100 pages');
    expect(result.text).toContain("limit for attachments is 25 pages");
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

  it("reads EXULU_ATTACHMENT_MAX_PAGES and falls back to 25 on nonsense", () => {
    expect(attachmentMaxPages({})).toBe(25);
    expect(attachmentMaxPages({ EXULU_ATTACHMENT_MAX_PAGES: "40" })).toBe(40);
    expect(attachmentMaxPages({ EXULU_ATTACHMENT_MAX_PAGES: "0" })).toBe(25);
    expect(attachmentMaxPages({ EXULU_ATTACHMENT_MAX_PAGES: "viele" })).toBe(25);
  });
});
