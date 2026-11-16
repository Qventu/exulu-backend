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


describe("document processor progress", () => {
  const collect = () => {
    const events: Array<{ phase: string; pagesDone: number; pagesTotal: number }> = [];
    return { events, onProgress: (p: { phase: string; pagesDone: number; pagesTotal: number }) => { events.push({ ...p }); } };
  };

  it("reports OCR after each finished chunk with a monotonically increasing cumulative page count", async () => {
    setupDocument(5);
    // Chunks finish out of order: later chunks answer faster.
    let n = 0;
    resolveOcr.mockResolvedValue({
      ocr: async () => {
        const mine = n++;
        await new Promise((r) => setTimeout(r, 40 - mine * 8));
        return { pages: [{ index: 0, markdown: `plain ${mine}` }] };
      },
    });
    const { events, onProgress } = collect();
    await documentProcessor({ file: Buffer.from("%PDF"), name: "a.pdf", config: mistral({ ocr: { concurrency: 5 } }), onProgress });
    const ocr = events.filter((e) => e.phase === "ocr");
    expect(ocr.map((e) => e.pagesDone)).toEqual([1, 2, 3, 4, 5]);
    expect(ocr.every((e) => e.pagesTotal === 5)).toBe(true);
  });

  it("reports vision per finished page, with the total being the pages that get a vision pass", async () => {
    setupDocument(3);
    let n = 0;
    resolveOcr.mockResolvedValue({
      ocr: async () => {
        n++;
        // Page with a table gets a vision pass; the other two are plain text and are skipped.
        return { pages: [{ index: 0, markdown: n === 2 ? "| a | b |\n| 1 | 2 |" : "plain text" }] };
      },
    });
    const { events, onProgress } = collect();
    await documentProcessor({ file: Buffer.from("%PDF"), name: "a.pdf", config: mistral({ ocr: { concurrency: 1 } }), onProgress });
    expect(events.filter((e) => e.phase === "vision")).toEqual([{ phase: "vision", pagesDone: 1, pagesTotal: 1 }]);
  });

  it("counts a tolerated vision failure as a finished page", async () => {
    setupDocument(2);
    generateText.mockRejectedValue(new Error("vision outage"));
    const { events, onProgress } = collect();
    await documentProcessor({ file: Buffer.from("%PDF"), name: "a.pdf", config: mistral(), tolerateVisionFailures: true, onProgress });
    const vision = events.filter((e) => e.phase === "vision");
    expect(vision.map((e) => e.pagesDone)).toEqual([1, 2]);
    expect(vision.every((e) => e.pagesTotal === 2)).toBe(true);
  });

  it("emits nothing and still works without a callback", async () => {
    setupDocument(2);
    await expect(documentProcessor({ file: Buffer.from("%PDF"), name: "a.pdf", config: mistral() })).resolves.toHaveLength(2);
  });
});
