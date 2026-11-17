import * as fs from "fs";
import * as os from "os";
import * as path from "path";

jest.mock("@EE/entitlements", () => ({ checkLicense: () => ({ "advanced-document-processing": true }) }));
jest.mock("@SRC/utils/with-retry", () => ({
  // Same attempts as the real helper, without the backoff sleeps.
  withRetry: async (fn: () => Promise<unknown>, max = 3) => {
    let last: unknown;
    for (let i = 0; i < max; i++) {
      try { return await fn(); } catch (e) { last = e; }
    }
    throw last;
  },
}));
jest.mock("@SRC/utils/python-executor", () => ({ executePythonScript: jest.fn() }));
jest.mock("@SRC/exulu/resolve-ocr", () => ({ resolveOcr: jest.fn() }));
jest.mock("@SRC/exulu/resolve-model", () => ({ resolveModel: jest.fn(async () => ({ languageModel: {} })) }));
jest.mock("@llamaindex/liteparse", () => ({ LiteParse: jest.fn() }), { virtual: true });
jest.mock("ai", () => ({ generateText: jest.fn(), Output: { object: (x: unknown) => x } }));

import { documentProcessor } from "./doc_processor";
import { processWideLimiters, VISION_CALL_TIMEOUT_MS, OCR_CALL_TIMEOUT_MS } from "./limits";

const { executePythonScript } = require("@SRC/utils/python-executor") as { executePythonScript: jest.Mock };
const { resolveOcr } = require("@SRC/exulu/resolve-ocr") as { resolveOcr: jest.Mock };
const { LiteParse } = require("@llamaindex/liteparse") as { LiteParse: jest.Mock };
const { generateText } = require("ai") as { generateText: jest.Mock };

const chunkDir = fs.mkdtempSync(path.join(os.tmpdir(), "chunks-"));
const chunkFile = path.join(chunkDir, "chunk.pdf");
fs.writeFileSync(chunkFile, "x");

let running = 0;
let maxRunning = 0;

function setupDocument(pageCount: number) {
  executePythonScript.mockResolvedValueOnce({
    stdout: JSON.stringify(Array.from({ length: pageCount }, (_, i) => ({ path: chunkFile, start_page: i, end_page: i + 1 }))),
    stderr: "",
  });
  LiteParse.mockImplementationOnce(() => ({
    screenshot: async () => Array.from({ length: pageCount }, (_, i) => ({ pageNum: i + 1, imageBuffer: Buffer.from(`page-${i + 1}`) })),
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  running = 0;
  maxRunning = 0;
  jest.spyOn(Math, "random").mockReturnValue(0);
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  let call = 0;
  resolveOcr.mockResolvedValue({
    ocr: async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 15));
      running--;
      call++;
      // Every page carries a table so the vision pass looks at it.
      return { pages: [{ index: 0, markdown: `| a | b |\n| 1 | 2 |\nocr text ${call}` }] };
    },
  });
  generateText.mockResolvedValue({
    output: { needs_correction: false, corrected_text: null, current_page_table: null, confidence: "high", reasoning: "ok" },
  });
});
afterEach(() => jest.restoreAllMocks());

const mistral = (extra: Record<string, unknown> = {}) => ({
  processor: { name: "mistral" as const, model: "vertex-ocr" },
  vlm: { model: "vlm", concurrency: 4 },
  ...extra,
});

describe("document processor limits", () => {
  it("chat path: with the process-wide limiters never more than 8 OCR calls at once across two documents, and both finish", async () => {
    setupDocument(12);
    setupDocument(12);
    const config = mistral({ ocr: { concurrency: 8 } });
    const [a, b] = await Promise.all([
      documentProcessor({ file: Buffer.from("%PDF"), name: "a.pdf", config, limiters: processWideLimiters }),
      documentProcessor({ file: Buffer.from("%PDF"), name: "b.pdf", config, limiters: processWideLimiters }),
    ]);
    expect(a).toHaveLength(12);
    expect(b).toHaveLength(12);
    expect(maxRunning).toBeGreaterThan(3);
    expect(maxRunning).toBeLessThanOrEqual(8);
  });

  it("knowledge-base path: a direct call is not capped globally, two documents run 16 OCR calls at once", async () => {
    setupDocument(12);
    setupDocument(12);
    const config = mistral({ ocr: { concurrency: 8 } });
    await Promise.all([
      documentProcessor({ file: Buffer.from("%PDF"), name: "a.pdf", config }),
      documentProcessor({ file: Buffer.from("%PDF"), name: "b.pdf", config }),
    ]);
    expect(maxRunning).toBeGreaterThan(8);
  });

  it("knowledge-base path: vision calls follow vlm.concurrency per document with no global cap", async () => {
    setupDocument(10);
    setupDocument(10);
    let visionRunning = 0;
    let visionMax = 0;
    generateText.mockImplementation(async () => {
      visionRunning++;
      visionMax = Math.max(visionMax, visionRunning);
      await new Promise((r) => setTimeout(r, 15));
      visionRunning--;
      return { output: { needs_correction: false, corrected_text: null, current_page_table: null, confidence: "high", reasoning: "ok" } };
    });
    const config = mistral({ ocr: { concurrency: 8 }, vlm: { model: "vlm", concurrency: 10 } });
    await Promise.all([
      documentProcessor({ file: Buffer.from("%PDF"), name: "a.pdf", config }),
      documentProcessor({ file: Buffer.from("%PDF"), name: "b.pdf", config }),
    ]);
    expect(visionMax).toBeGreaterThan(8);
  });

  it("chat path: vision calls across two documents are capped at 8", async () => {
    setupDocument(10);
    setupDocument(10);
    let visionRunning = 0;
    let visionMax = 0;
    generateText.mockImplementation(async () => {
      visionRunning++;
      visionMax = Math.max(visionMax, visionRunning);
      await new Promise((r) => setTimeout(r, 15));
      visionRunning--;
      return { output: { needs_correction: false, corrected_text: null, current_page_table: null, confidence: "high", reasoning: "ok" } };
    });
    const config = mistral({ ocr: { concurrency: 8 }, vlm: { model: "vlm", concurrency: 10 } });
    await Promise.all([
      documentProcessor({ file: Buffer.from("%PDF"), name: "a.pdf", config, limiters: processWideLimiters }),
      documentProcessor({ file: Buffer.from("%PDF"), name: "b.pdf", config, limiters: processWideLimiters }),
    ]);
    expect(visionMax).toBeGreaterThan(3);
    expect(visionMax).toBeLessThanOrEqual(8);
  });

  it("honours documentProcessor.ocr.concurrency for one document", async () => {
    setupDocument(20);
    await documentProcessor({ file: Buffer.from("%PDF"), name: "a.pdf", config: mistral({ ocr: { concurrency: 8 } }) });
    expect(maxRunning).toBe(8);
  });

  it("limits one document to documentProcessor.ocr.concurrency (default 3)", async () => {
    setupDocument(9);
    await documentProcessor({ file: Buffer.from("%PDF"), name: "a.pdf", config: mistral() });
    expect(maxRunning).toBe(3);
  });
});

describe("vision call time limit", () => {
  it("is 120 seconds", () => {
    expect(VISION_CALL_TIMEOUT_MS).toBe(120_000);
  });

  it("knowledge-base path: a direct call creates no abort signal for OCR or vision", async () => {
    setupDocument(2);
    const timeout = jest.spyOn(AbortSignal, "timeout");
    await documentProcessor({ file: Buffer.from("%PDF"), name: "a.pdf", config: mistral() });
    expect(timeout).not.toHaveBeenCalled();
    expect(generateText).toHaveBeenCalled();
    for (const [args] of generateText.mock.calls) expect(args.abortSignal).toBeUndefined();
    expect(resolveOcr.mock.calls[0][0].timeoutMs).toBeUndefined();
  });

  it("chat path: OCR gets the 180 s timeout and vision calls carry a 120 s signal", async () => {
    setupDocument(1);
    const timeout = jest.spyOn(AbortSignal, "timeout");
    await documentProcessor({ file: Buffer.from("%PDF"), name: "a.pdf", config: mistral(), limiters: processWideLimiters });
    expect(resolveOcr.mock.calls[0][0].timeoutMs).toBe(OCR_CALL_TIMEOUT_MS);
    expect(OCR_CALL_TIMEOUT_MS).toBe(180_000);
    expect(timeout).toHaveBeenCalledWith(120_000);
    expect(generateText.mock.calls[0][0].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("every vision call carries a timeout signal; a stalled call that is aborted counts as a failed attempt", async () => {
    setupDocument(1);
    const controller = new AbortController();
    const timeout = jest.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    generateText.mockImplementation(
      (args: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          args.abortSignal?.addEventListener("abort", () => reject(new Error("timed out")));
          if (args.abortSignal?.aborted) reject(new Error("timed out"));
        }),
    );
    const pending = documentProcessor({ file: Buffer.from("%PDF"), name: "a.pdf", config: mistral(), tolerateVisionFailures: true, limiters: processWideLimiters });
    for (let i = 0; i < 200 && generateText.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(timeout).toHaveBeenCalledWith(120_000);
    controller.abort();
    const result = await pending;
    // Three attempts (the existing retry count), then the page is flagged instead of hanging.
    expect(generateText).toHaveBeenCalledTimes(3);
    expect(result![0].vlm_failed).toBe(true);
  });
});

describe("vision failures", () => {
  const failPage2 = () =>
    generateText.mockImplementation(async (args: { messages: Array<{ content: Array<{ image?: string }> }> }) => {
      const image = args.messages[0].content[1].image as string;
      const text = Buffer.from(image.split(",")[1], "base64").toString();
      if (text === "page-2") throw new Error("vision outage");
      return { output: { needs_correction: false, corrected_text: null, current_page_table: null, confidence: "high", reasoning: "ok" } };
    });

  it("with tolerateVisionFailures a page whose vision call failed three times keeps its OCR text and is flagged", async () => {
    setupDocument(3);
    failPage2();
    const result = await documentProcessor({ file: Buffer.from("%PDF"), name: "a.pdf", config: mistral(), tolerateVisionFailures: true });
    expect(result).toHaveLength(3);
    const page2 = result!.find((p) => p.page === 2)!;
    expect(page2.content).toContain("| a | b |");
    expect(page2.vlm_failed).toBe(true);
    expect(result!.filter((p) => p.vlm_failed).map((p) => p.page)).toEqual([2]);
    const failedCalls = generateText.mock.calls.filter((c) => Buffer.from(c[0].messages[0].content[1].image.split(",")[1], "base64").toString() === "page-2");
    expect(failedCalls).toHaveLength(3);
  });

  it("without the flag the document fails as before", async () => {
    setupDocument(3);
    failPage2();
    await expect(documentProcessor({ file: Buffer.from("%PDF"), name: "a.pdf", config: mistral() })).rejects.toThrow("vision outage");
  });
});

describe("reconstructTableHeaders", () => {
  const { reconstructTableHeaders } = require("./doc_processor") as typeof import("./doc_processor");
  const tableOn = (headers: string[], is_continuation: boolean) =>
    ({ needs_correction: false, confidence: "high", reasoning: "", current_page_table: { headers, is_continuation } }) as never;
  const build = () => [
    { page: 1, content: "| a | b |\n| - | - |\n| 1 | 2 |" },
    { page: 2, content: "| 3 | 4 |", vlm_failed: true as boolean | undefined },
    { page: 3, content: "| 5 | 6 |" },
  ];
  const results = () => new Map([[1, tableOn(["a", "b"], false)], [3, tableOn(["x", "y"], true)]]);

  it("does not hand headers from before a failed page to a later continuation", () => {
    const doc = build();
    reconstructTableHeaders(doc, results());
    expect(doc[2].content).toBe("| 5 | 6 |");
  });

  it("without a failed page the headers carry across as before", () => {
    const doc = build();
    doc[1].vlm_failed = undefined;
    reconstructTableHeaders(doc, results());
    expect(doc[2].content).toBe("| a | b |\n| --- | --- |\n| 5 | 6 |");
  });
});
