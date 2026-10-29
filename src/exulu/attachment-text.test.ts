import { extractDocument, pagesToText } from "./attachment-text";
import type { ExuluConfig } from "./app";

const withProcessor = {
  attachments: { documentProcessor: { processor: { name: "mistral", model: "vertex-ocr" }, vlm: { model: "vertex-gemini-2.5-flash", concurrency: 4 } } },
} as unknown as ExuluConfig;

const bytes = Buffer.from("%PDF-1.4 fake");

describe("extractDocument", () => {
  it("uses the configured OCR/VLM processor and prefers the VLM-corrected page text", async () => {
    const process = jest.fn().mockResolvedValue([
      { page: 1, content: "Kennwort: BLAUWAL-47ll", vlm_corrected_text: "Kennwort: BLAUWAL-4711", headings: [] },
      { page: 2, content: "Typenschild: AZBZ 130 DE", headings: [] },
    ]);
    const officeParse = jest.fn();

    const result = await extractDocument({ bytes, filename: "Anfrage.pdf", exuluConfig: withProcessor, attribution: { userId: 14 }, process, officeParse });

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

    const result = await extractDocument({ bytes, filename: "Anfrage.pdf", exuluConfig: withProcessor, process, officeParse });

    expect(result.engine).toBe("officeparser");
    expect(result.text).toBe("text layer");
  });

  it("falls back when the processor returns only empty pages", async () => {
    const process = jest.fn().mockResolvedValue([{ page: 1, content: "   ", headings: [] }]);
    const officeParse = jest.fn().mockResolvedValue("");

    const result = await extractDocument({ bytes, filename: "leer.pdf", exuluConfig: withProcessor, process, officeParse });

    expect(result.engine).toBe("officeparser");
    expect(result.text).toBe("");
  });

  it("joins a single page without a page marker", () => {
    expect(pagesToText([{ page: 1, text: " nur eine Seite " }])).toBe("nur eine Seite");
    expect(pagesToText([])).toBe("");
  });
});
