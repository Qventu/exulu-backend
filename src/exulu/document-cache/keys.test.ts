import {
  DERIVED_ROOT,
  contentKey,
  documentCacheDays,
  documentMaxPages,
  extractorFingerprint,
  isDerivedKey,
  pointerKey,
} from "./keys";
import { validateAttachmentsConfig } from "../attachment-text";
import { createHash } from "crypto";

const sha = "a".repeat(64);
const proc = (processor: object, vlm?: object) => ({ attachments: { documentProcessor: { processor, vlm } } });

describe("keys", () => {
  it("builds content and pointer keys, with and without a prefix", () => {
    expect(DERIVED_ROOT).toBe("derived");
    expect(contentKey(sha, "fp1")).toBe(`derived/content/${sha}/fp1.md`);
    expect(contentKey(sha, "fp1", "pre/")).toBe(`pre/derived/content/${sha}/fp1.md`);
    const hash = createHash("sha256").update("bkt/user_1/a.pdf").digest("hex");
    expect(pointerKey("bkt", "user_1/a.pdf")).toBe(`derived/pointers/${hash}.json`);
    expect(pointerKey("bkt", "user_1/a.pdf", "pre")).toBe(`pre/derived/pointers/${hash}.json`);
  });
  it("isDerivedKey", () => {
    expect(isDerivedKey("derived/x")).toBe(true);
    expect(isDerivedKey("/derived/x")).toBe(true);
    expect(isDerivedKey("pre/derived/x", "pre")).toBe(true);
    expect(isDerivedKey("pre/derived/x", "pre/")).toBe(true);
    expect(isDerivedKey("/pre/derived/x", "/pre")).toBe(true);
    expect(isDerivedKey("pre/derived/x", "/pre/")).toBe(true);
    expect(contentKey(sha, "fp1", "/pre/")).toBe(`pre/derived/content/${sha}/fp1.md`);
    expect(isDerivedKey("user_1/derived/x")).toBe(false);
    expect(isDerivedKey("derivedx/y")).toBe(false);
    expect(isDerivedKey("pre/user_1/a", "pre")).toBe(false);
  });
});

describe("extractorFingerprint", () => {
  const fp = (filename: string, exuluConfig: any) => extractorFingerprint({ filename, exuluConfig });
  it("labels the no-processor cases", () => {
    expect(fp("a.docx", {}).label).toBe("officeparser@1");
    expect(fp("a.PDF", undefined).label).toBe("pdftotext@1");
    expect(fp("a.pdf", {}).id).toBe(createHash("sha256").update("pdftotext@1").digest("hex").slice(0, 16));
  });
  it("labels the processor cases and varies with engine, model, vlm", () => {
    const base = fp("a.pdf", proc({ name: "mistral", model: "mistral-ocr" }, { model: "g", concurrency: 2 }));
    expect(base.label).toBe("document-processor/mistral/mistral-ocr/vlm:g/.pdf/chunk:25@1");
    expect(fp("a.pdf", proc({ name: "mistral", model: "mistral-ocr" })).label).toBe("document-processor/mistral/mistral-ocr/vlm:off/.pdf/chunk:25@1");
    expect(fp("a.pdf", proc({ name: "mistral" }, { model: "g", concurrency: 2 })).label).toBe(base.label);
    const ids = new Set([
      base.id,
      fp("a.pdf", proc({ name: "liteparse" }, { model: "g", concurrency: 2 })).id,
      fp("a.pdf", proc({ name: "mistral", model: "other" }, { model: "g", concurrency: 2 })).id,
      fp("a.pdf", proc({ name: "mistral", model: "mistral-ocr" })).id,
      fp("a.pdf", proc({ name: "mistral", model: "mistral-ocr" }, { model: "h", concurrency: 2 })).id,
    ]);
    expect(ids.size).toBe(5);
  });
  it("with a processor, the file extension and maxPagesPerChunk are part of the fingerprint", () => {
    const withProc = { name: "mistral", model: "m" };
    expect(fp("a.doc", proc(withProc)).id).not.toBe(fp("a.docx", proc(withProc)).id);
    expect(fp("a.DOCX", proc(withProc)).id).toBe(fp("b.docx", proc(withProc)).id);
    expect(fp("a.pdf", proc({ ...withProc, maxPagesPerChunk: 10 })).id).not.toBe(fp("a.pdf", proc(withProc)).id);
    expect(fp("a.pdf", proc({ ...withProc, maxPagesPerChunk: 25 })).id).toBe(fp("a.pdf", proc(withProc)).id);
  });
  it("ignores concurrency", () => {
    expect(fp("a.pdf", proc({ name: "mistral", model: "m" }, { model: "g", concurrency: 1 })).id).toBe(
      fp("a.pdf", proc({ name: "mistral", model: "m" }, { model: "g", concurrency: 9 })).id,
    );
  });
});

describe("env settings", () => {
  it("documentCacheDays", () => {
    expect(documentCacheDays({})).toBe(365);
    expect(documentCacheDays({ EXULU_DOCUMENT_CACHE_DAYS: "0" })).toBe(0);
    expect(documentCacheDays({ EXULU_DOCUMENT_CACHE_DAYS: "30" })).toBe(30);
  });
  it("documentMaxPages", () => {
    expect(documentMaxPages({})).toBe(300);
    expect(documentMaxPages({ EXULU_DOCUMENT_MAX_PAGES: "12" })).toBe(12);
  });
  describe("boot validation, without any attachments config", () => {
    const lic = { "advanced-document-processing": false };
    const run = (env: Record<string, string>) => {
      const saved = { ...process.env };
      Object.assign(process.env, env);
      try {
        return validateAttachmentsConfig(undefined, lic);
      } finally {
        process.env = saved;
      }
    };
    it("accepts defaults and 0 cache days", () => {
      expect(run({})).toEqual([]);
      expect(run({ EXULU_DOCUMENT_CACHE_DAYS: "0" })).toEqual([]);
    });
    it.each(["abc", "-1", "1.5"])("rejects cache days %s", (v) => {
      expect(run({ EXULU_DOCUMENT_CACHE_DAYS: v })).toEqual([expect.stringMatching(/EXULU_DOCUMENT_CACHE_DAYS/)]);
    });
    it.each(["0", "abc", "-1"])("rejects max pages %s", (v) => {
      expect(run({ EXULU_DOCUMENT_MAX_PAGES: v })).toEqual([expect.stringMatching(/EXULU_DOCUMENT_MAX_PAGES/)]);
    });
  });
});
