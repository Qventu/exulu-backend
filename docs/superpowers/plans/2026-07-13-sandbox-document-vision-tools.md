# Sandbox Document Vision Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the chat agent two on-demand tools — `parse_document` (page-marked text extraction) and `view_document_page` (render a document page or image into the model's visual context) — so it can answer questions about images inside uploaded PDFs.

**Architecture:** Both tools follow the `read_session_file` pattern (host-side `ExuluTool.internal`, S3-backed, registered in `convert-exulu-tools-to-ai-sdk-tools.ts`). Image delivery works around a hard LiteLLM transport limitation (`@ai-sdk/openai-compatible` JSON-stringifies rich tool-result content): `view_document_page` stashes the rendered PNG in an in-process map keyed by `toolCallId` and returns a small marker; a new `imageAttachmentGuard` prepareStep injects the image as a user-message image part (serialized as a standard `image_url` data URL) directly after the tool-result message.

**Tech Stack:** TypeScript, AI SDK v6 (`ai@^6.0.49`), Zod, Jest + ts-jest, poppler (`pdftotext`, `pdftoppm`), LibreOffice (via existing `getPdfPreviewBytes`), `officeparser` (already a dependency).

**Spec:** `docs/superpowers/specs/2026-07-13-sandbox-document-vision-tools-design.md`

## Global Constraints

- No new npm dependencies (no `sharp` — downscaling is done with `pdftoppm -scale-to`; oversized source *images* are rejected with a clear error).
- Image caps: 1568px long edge primary render, 1024px fallback re-render, 3,750,000 raw bytes max (≈5MB after base64, the provider limit).
- Text caps: 16,000 chars per tool call, line-based `offset`/`limit` paging, defaults matching `read_session_file` (limit 250, max 1000).
- Tools return `{ error: string }` — never throw.
- Filenames are base names only; reject anything containing `..`, `/`, or `\`.
- No license gate on either tool (deep processing stays with ExuluContext knowledge bases).
- Path aliases in imports: `@SRC/...`, `@EXULU_TYPES/...` (see `jest.config.cjs` moduleNameMapper).
- Run a single test file with: `npm test -- <filename>.test.ts`

## File Structure

- Modify: `src/exulu/system-dependencies.ts` — add `pdftotext` required binary.
- Create: `src/templates/tools/document-render-helpers.ts` — thin shell-out helpers (`pdfToText`, `renderPdfPageToPng`). Isolated so tool unit tests can mock them (CI has no poppler; repo convention is programmatic test data, no binary fixtures).
- Create: `src/templates/tools/parse-document-tool.ts` + colocated `.test.ts`.
- Create: `src/exulu/tool-image-attachments.ts` + colocated `.test.ts` — image stash + prepareStep guard.
- Create: `src/templates/tools/view-document-page-tool.ts` + colocated `.test.ts`.
- Modify: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts` — register both tools (after the `createSessionFileReadTool` block, lines ~281-284).
- Modify: `src/exulu/provider.ts` (3 `composePrepareSteps` sites: lines ~587, ~655, ~1210) and `src/exulu/openai-gateway.ts` (2 sites: lines ~548, ~590) — append `imageAttachmentGuard()`.
- Create: `scripts/repro-view-page-image.ts` — LiteLLM image-injection verification script.

---

### Task 1: Require `pdftotext` as a system dependency

**Files:**
- Modify: `src/exulu/system-dependencies.ts` (REQUIRED_SYSTEM_DEPENDENCIES array, lines 44-81)

**Interfaces:**
- Consumes: existing `SystemDependency` type `{ check: { kind: "binary", binary: string }, displayName, purpose, installHints }`.
- Produces: startup probe for `pdftotext` (no exports change).

- [ ] **Step 1: Add the dependency entry**

In `src/exulu/system-dependencies.ts`, inside `REQUIRED_SYSTEM_DEPENDENCIES`, after the existing `pdftoppm` entry, add:

```typescript
  {
    check: { kind: "binary", binary: "pdftotext" },
    displayName: "Poppler (pdftotext)",
    purpose: "parse_document tool: extracting page-marked text from PDFs",
    installHints: {
      debian: "apt-get install -y poppler-utils",
      macos: "brew install poppler",
    },
  },
```

- [ ] **Step 2: Verify the file compiles and existing tests pass**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20` (expect no NEW errors in system-dependencies.ts) and `npm test -- system-dependencies` (expect PASS, or "No tests found" if none exist — both fine).

- [ ] **Step 3: Commit**

```bash
git add src/exulu/system-dependencies.ts
git commit -m "feat(tools): require pdftotext for document parsing"
```

---

### Task 2: Shell-out render helpers

**Files:**
- Create: `src/templates/tools/document-render-helpers.ts`

**Interfaces:**
- Consumes: `node:child_process` execFile, `node:fs/promises`, `node:os` tmpdir.
- Produces (Tasks 3 and 5 mock this module in their tests):
  - `pdfToText(pdf: Buffer): Promise<string>` — raw `pdftotext -layout` stdout; pages separated by form-feed (`\f`).
  - `renderPdfPageToPng(pdf: Buffer, page: number, scaleTo: number): Promise<Buffer | null>` — PNG bytes of page N scaled to `scaleTo` px on the long edge; `null` when the page doesn't exist.

- [ ] **Step 1: Write the helpers**

Create `src/templates/tools/document-render-helpers.ts`:

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

/**
 * Extract the text layer of a PDF via poppler's pdftotext.
 * Returns raw stdout: pages separated by form-feed (\f) characters,
 * -layout preserves column/table alignment.
 */
export async function pdfToText(pdf: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "exulu-parse-"));
  try {
    const inputPath = join(dir, "input.pdf");
    await writeFile(inputPath, pdf);
    // "-" writes to stdout — no output temp file needed.
    const { stdout } = await execFileAsync("pdftotext", ["-layout", inputPath, "-"], {
      timeout: 60_000,
      maxBuffer: MAX_STDOUT_BYTES,
    });
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Render one PDF page to PNG via poppler's pdftoppm.
 * -scale-to bounds the long edge, so no separate image library is needed.
 * Returns null when the requested page is beyond the document's last page
 * (pdftoppm simply produces no output file in that case).
 */
export async function renderPdfPageToPng(
  pdf: Buffer,
  page: number,
  scaleTo: number,
): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), "exulu-render-"));
  try {
    const inputPath = join(dir, "input.pdf");
    await writeFile(inputPath, pdf);
    await execFileAsync(
      "pdftoppm",
      ["-png", "-f", String(page), "-l", String(page), "-scale-to", String(scaleTo), inputPath, join(dir, "page")],
      { timeout: 60_000, maxBuffer: MAX_STDOUT_BYTES },
    );
    // pdftoppm names output page-<N>.png with zero-padding that depends on
    // the document's total page count — glob instead of guessing.
    const produced = (await readdir(dir)).find((f) => f.startsWith("page") && f.endsWith(".png"));
    if (!produced) return null;
    return await readFile(join(dir, produced));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep document-render-helpers` — expect no output (no errors).

- [ ] **Step 3: Smoke-test locally against a real PDF (dev machine has poppler)**

Write a scratch file `/tmp/smoke-render-helpers.ts`:

```typescript
import { pdfToText, renderPdfPageToPng } from "/Users/daniel.claessen/Desktop/Projects/exulu/backend/src/templates/tools/document-render-helpers.ts";
import { readFileSync } from "node:fs";

const pdfPath = process.argv[2];
const pdf = readFileSync(pdfPath);
const text = await pdfToText(pdf);
console.log("pages:", text.split("\f").length, "first 100 chars:", JSON.stringify(text.slice(0, 100)));
const png = await renderPdfPageToPng(pdf, 1, 1568);
console.log("page 1 png bytes:", png?.length);
const missing = await renderPdfPageToPng(pdf, 9999, 1568);
console.log("page 9999:", missing);
```

Run: `npx tsx /tmp/smoke-render-helpers.ts "./AI.OPEN Guide.pdf"` (or any local PDF path).
Expected: a page count ≥ 1, non-empty text, a PNG byte length > 0, and `page 9999: null`.

- [ ] **Step 4: Commit**

```bash
git add src/templates/tools/document-render-helpers.ts
git commit -m "feat(tools): add pdftotext/pdftoppm render helpers"
```

---

### Task 3: `parse_document` tool

**Files:**
- Create: `src/templates/tools/parse-document-tool.ts`
- Test: `src/templates/tools/parse-document-tool.test.ts`

**Interfaces:**
- Consumes: `pdfToText` from `./document-render-helpers` (Task 2); `getPresignedUrl` from `@SRC/uppy`; `ExuluTool.internal`; `parseOfficeAsync` from `officeparser`.
- Produces: `createParseDocumentTool({ sessionID, user, exuluConfig }): ExuluTool | undefined` — registered in Task 6. Tool id/name: `parse_document`. Success shape `{ content, totalPages?, totalLines, offset, linesReturned }`; failure `{ error }`.

- [ ] **Step 1: Write the failing test**

Create `src/templates/tools/parse-document-tool.test.ts`:

```typescript
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
  pdfToText.mockResolvedValue("page one text\fpage two text\fpage three text");
  const result = await runTool({ filename: "report.pdf" });
  expect(result.content).toBe(
    "--- page 1 ---\npage one text\n--- page 2 ---\npage two text\n--- page 3 ---\npage three text",
  );
  expect(result.totalPages).toBe(3);
  expect(getPresignedUrl).toHaveBeenCalledWith(
    "bucket",
    "exulu/user_7/sessions/s1/report.pdf",
    exuluConfig,
  );
});

it("filters to a requested page range", async () => {
  pdfToText.mockResolvedValue("one\ftwo\fthree\ffour");
  const result = await runTool({ filename: "report.pdf", pages: "2-3" });
  expect(result.content).toBe("--- page 2 ---\ntwo\n--- page 3 ---\nthree");
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
  expect(result.content).toBe("line 8\nline 9\nline 10");
  expect(result.offset).toBe(10);
  expect(result.linesReturned).toBe(3);
});

it("surfaces fetch failures as error objects, not throws", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 404 } as never);
  const result = await runTool({ filename: "missing.pdf" });
  expect(result.error).toMatch(/404/);
});
```

Note on the offset test: line 1 of the tool's output is the `--- page 1 ---` marker, so `offset: 10` addresses the 10th output line, which is `line 8` of the raw text. This asserts paging operates on the marked-up output the model actually sees.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- parse-document-tool.test.ts`
Expected: FAIL — `Cannot find module './parse-document-tool'`.

- [ ] **Step 3: Write the implementation**

Create `src/templates/tools/parse-document-tool.ts`:

```typescript
import { z } from "zod";
import { extname } from "node:path";
import { parseOfficeAsync } from "officeparser";
import { ExuluTool } from "@SRC/exulu/tool";
import { getPresignedUrl } from "@SRC/uppy";
import type { ExuluConfig } from "@SRC/exulu/app";
import type { User } from "@EXULU_TYPES/models/user";
import { pdfToText } from "./document-render-helpers";

const DEFAULT_LIMIT = 250;
const MAX_CONTENT_CHARS = 16_000;
/** Under this many non-whitespace chars per page on average, the PDF is
 * effectively scanned — its text layer is useless and OCR-class processing
 * (knowledge base with a processor) or view_document_page is the way in. */
const MIN_CHARS_PER_PAGE = 20;

const OFFICE_EXTENSIONS = new Set([
  ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".odt", ".ods", ".odp", ".rtf", ".csv",
]);

const pagesPattern = /^(\d+)(?:-(\d+))?$/;

export const createParseDocumentTool = ({
  sessionID,
  user,
  exuluConfig,
}: {
  sessionID?: string;
  user?: User;
  exuluConfig?: ExuluConfig;
}): ExuluTool | undefined => {
  if (!sessionID || !exuluConfig?.fileUploads?.s3Bucket) return undefined;

  const parseDocumentExecute = async ({
    filename,
    pages,
    offset,
    limit,
  }: {
    filename: string;
    pages?: string;
    offset?: number;
    limit?: number;
  }) => {
    const safeName = String(filename ?? "").trim();
    if (!safeName || safeName.includes("..") || safeName.includes("/") || safeName.includes("\\")) {
      return {
        error: "Invalid filename — pass the bare file name exactly as listed in the session files (no paths).",
      };
    }
    const ext = extname(safeName).toLowerCase();
    if (ext !== ".pdf" && !OFFICE_EXTENSIONS.has(ext)) {
      return {
        error: `Unsupported extension "${ext}" — parse_document handles PDF and Office formats. For plain-text files use read_session_file.`,
      };
    }

    const uploads = exuluConfig.fileUploads!;
    const generalPrefix = uploads.s3prefix ? `${uploads.s3prefix.replace(/\/$/, "")}/` : "";
    const key = `${generalPrefix}user_${user?.id ?? "api"}/sessions/${sessionID}/${safeName}`;
    try {
      const url = await getPresignedUrl(uploads.s3Bucket!, key, exuluConfig);
      const res = await fetch(url);
      if (!res.ok) {
        return { error: `Could not read session file "${safeName}" (status ${res.status}). Check the exact file name.` };
      }
      const bytes = Buffer.from(await res.arrayBuffer());

      let fullText: string;
      let totalPages: number | undefined;
      if (ext === ".pdf") {
        const raw = await pdfToText(bytes);
        const pageTexts = raw.replace(/\f$/, "").split("\f");
        totalPages = pageTexts.length;
        const nonWhitespace = raw.replace(/\s/g, "").length;
        if (nonWhitespace < totalPages * MIN_CHARS_PER_PAGE) {
          return {
            error:
              `"${safeName}" has no extractable text layer (likely a scan or image-based PDF). ` +
              "Use view_document_page to look at pages visually, or suggest the user add the document " +
              "to a knowledge base with a document processor for full OCR.",
          };
        }
        let range: [number, number] = [1, totalPages];
        if (pages) {
          const m = pagesPattern.exec(pages.trim());
          if (!m) return { error: `Invalid pages "${pages}" — use "3" or "2-5".` };
          range = [Number(m[1]), Number(m[2] ?? m[1])];
        }
        fullText = pageTexts
          .map((text, i) => ({ page: i + 1, text }))
          .filter(({ page }) => page >= range[0] && page <= range[1])
          .map(({ page, text }) => `--- page ${page} ---\n${text.trim()}`)
          .join("\n");
      } else {
        const extracted = await parseOfficeAsync(bytes, {
          outputErrorToConsole: false,
          newlineDelimiter: "\n",
        });
        fullText = String(extracted);
      }

      const lines = fullText.split("\n");
      const start = (offset ?? 1) - 1;
      const requested = limit ?? DEFAULT_LIMIT;
      const sliced = lines.slice(start, start + requested);
      let content = sliced.join("\n");
      let linesReturned = sliced.length;
      if (content.length > MAX_CONTENT_CHARS) {
        content = content.slice(0, MAX_CONTENT_CHARS);
        linesReturned = Math.max(1, content.split("\n").length - 1);
        content = content + "\n[slice truncated — request fewer lines]";
      }
      return {
        content,
        ...(totalPages !== undefined ? { totalPages } : {}),
        totalLines: lines.length,
        offset: start + 1,
        linesReturned,
      };
    } catch (err) {
      return { error: `Failed to parse "${safeName}": ${err instanceof Error ? err.message : "unknown error"}` };
    }
  };

  return ExuluTool.internal({
    id: "parse_document",
    name: "parse_document",
    needsApproval: false,
    description:
      "Extract the text of an uploaded PDF or Office document from this session's files, with " +
      '"--- page N ---" markers for PDFs so you can locate content by page. Free and fast (no OCR): ' +
      "works only on documents with a real text layer. To SEE a page or an image inside a document, " +
      "use view_document_page.",
    inputSchema: z.object({
      filename: z.string().describe('Exact session file name, e.g. "report.pdf"'),
      pages: z.string().optional().describe('PDF page or range to extract, e.g. "2" or "1-5" (default: all pages)'),
      offset: z.number().int().min(1).optional().describe("1-based first output line to read (default 1)"),
      limit: z.number().int().min(1).max(1000).optional().describe(`Number of lines to read (default ${DEFAULT_LIMIT})`),
    }),
    type: "function",
    category: "session",
    config: [],
    // Same shape mismatch as read_session_file / memory-tool: internal utility
    // tools return richer objects than ExuluTool's retrieval-flavored execute
    // type; the AI SDK passes the object through verbatim.
    execute: parseDocumentExecute as never,
  });
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- parse-document-tool.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/templates/tools/parse-document-tool.ts src/templates/tools/parse-document-tool.test.ts
git commit -m "feat(tools): add parse_document session tool"
```

---

### Task 4: Image stash + `imageAttachmentGuard` prepareStep

**Files:**
- Create: `src/exulu/tool-image-attachments.ts`
- Test: `src/exulu/tool-image-attachments.test.ts`

**Interfaces:**
- Consumes: `PrepareStepFn` from `@SRC/exulu/context-guard` (shape: `(opts: { stepNumber, messages?, steps? }) => Record<string, unknown> | undefined`).
- Produces (Task 5 calls the stash; Task 6 wires the guard):
  - `stashToolImage(toolCallId: string, image: { data: string; mediaType: string; label: string }): void`
  - `imageAttachmentGuard(): PrepareStepFn`
  - `clearImageStash(): void` (test hygiene)
  - `INJECTED_IMAGE_PREFIX` (exported const, used for idempotency detection)

- [ ] **Step 1: Write the failing test**

Create `src/exulu/tool-image-attachments.test.ts`:

```typescript
import {
  stashToolImage,
  imageAttachmentGuard,
  clearImageStash,
  INJECTED_IMAGE_PREFIX,
} from "./tool-image-attachments";

const PNG_B64 = "aGVsbG8="; // content is irrelevant to the guard

const toolMessage = (toolCallId: string) => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId,
      toolName: "view_document_page",
      output: { type: "json", value: { attached: true } },
    },
  ],
});

afterEach(() => clearImageStash());

it("returns undefined when nothing is stashed", async () => {
  const guard = imageAttachmentGuard();
  const result = await guard({ stepNumber: 1, messages: [toolMessage("call_1")] });
  expect(result).toBeUndefined();
});

it("injects a user image message directly after the matching tool message", async () => {
  stashToolImage("call_1", { data: PNG_B64, mediaType: "image/png", label: "report.pdf page 2" });
  const guard = imageAttachmentGuard();
  const messages = [
    { role: "user", content: "what is on page 2?" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_1", toolName: "view_document_page" }] },
    toolMessage("call_1"),
  ];
  const result = (await guard({ stepNumber: 2, messages })) as { messages: unknown[] };
  expect(result.messages).toHaveLength(4);
  const injected = result.messages[3] as { role: string; content: Array<Record<string, unknown>> };
  expect(injected.role).toBe("user");
  expect((injected.content[0] as { text: string }).text).toBe(`${INJECTED_IMAGE_PREFIX}report.pdf page 2`);
  expect(injected.content[1]).toEqual({ type: "image", image: PNG_B64, mediaType: "image/png" });
});

it("keeps injection position between the tool message and later conversation", async () => {
  stashToolImage("call_1", { data: PNG_B64, mediaType: "image/png", label: "report.pdf page 2" });
  const guard = imageAttachmentGuard();
  const messages = [
    toolMessage("call_1"),
    { role: "assistant", content: "the page shows a chart" },
    { role: "user", content: "zoom into the legend" },
  ];
  const result = (await guard({ stepNumber: 3, messages })) as { messages: unknown[] };
  expect(result.messages).toHaveLength(4);
  expect((result.messages[1] as { role: string }).role).toBe("user"); // injected right after tool msg
  expect((result.messages[2] as { content: string }).content).toBe("the page shows a chart");
});

it("does not double-inject when an injected message already follows", async () => {
  stashToolImage("call_1", { data: PNG_B64, mediaType: "image/png", label: "x" });
  const guard = imageAttachmentGuard();
  const once = (await guard({ stepNumber: 1, messages: [toolMessage("call_1")] })) as { messages: unknown[] };
  const twice = await guard({ stepNumber: 2, messages: once.messages });
  expect(twice).toBeUndefined();
});

it("injects multiple stashed images for multiple tool calls", async () => {
  stashToolImage("call_1", { data: PNG_B64, mediaType: "image/png", label: "a" });
  stashToolImage("call_2", { data: PNG_B64, mediaType: "image/png", label: "b" });
  const guard = imageAttachmentGuard();
  const result = (await guard({
    stepNumber: 1,
    messages: [toolMessage("call_1"), toolMessage("call_2")],
  })) as { messages: unknown[] };
  expect(result.messages).toHaveLength(4);
});

it("evicts oldest entries beyond the stash cap", async () => {
  for (let i = 0; i < 105; i++) {
    stashToolImage(`call_${i}`, { data: PNG_B64, mediaType: "image/png", label: `img ${i}` });
  }
  const guard = imageAttachmentGuard();
  const oldest = await guard({ stepNumber: 1, messages: [toolMessage("call_0")] });
  expect(oldest).toBeUndefined(); // evicted
  const newest = await guard({ stepNumber: 1, messages: [toolMessage("call_104")] });
  expect(newest).toBeDefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tool-image-attachments.test.ts`
Expected: FAIL — `Cannot find module './tool-image-attachments'`.

- [ ] **Step 3: Write the implementation**

Create `src/exulu/tool-image-attachments.ts`:

```typescript
import type { PrepareStepFn } from "./context-guard";

export const INJECTED_IMAGE_PREFIX = "[Image attached from tool call: ";

type StashedImage = { data: string; mediaType: string; label: string; stashedAt: number };

/**
 * In-process channel that carries rendered images from view_document_page's
 * execute (which can only return JSON — the openai-compatible transport
 * stringifies rich tool-result content) into the model's context: the guard
 * below injects each stashed image as a user-message image part right after
 * its tool-result message. Bounded because entries outlive the request that
 * created them; images are intentionally never persisted to chat history.
 */
const stash = new Map<string, StashedImage>();
const MAX_ENTRIES = 100;
const TTL_MS = 30 * 60 * 1000;

function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, entry] of stash) {
    if (entry.stashedAt < cutoff) stash.delete(id);
  }
  while (stash.size > MAX_ENTRIES) {
    const oldest = stash.keys().next().value;
    if (oldest === undefined) break;
    stash.delete(oldest);
  }
}

export function stashToolImage(
  toolCallId: string,
  image: { data: string; mediaType: string; label: string },
): void {
  stash.set(toolCallId, { ...image, stashedAt: Date.now() });
  sweep();
}

export function clearImageStash(): void {
  stash.clear();
}

type MessageLike = { role?: string; content?: unknown };
type ToolResultPartLike = { type?: string; toolCallId?: string };

function stashedIdsInMessage(message: MessageLike): string[] {
  if (message?.role !== "tool" || !Array.isArray(message.content)) return [];
  return (message.content as ToolResultPartLike[])
    .filter((p) => p?.type === "tool-result" && typeof p.toolCallId === "string" && stash.has(p.toolCallId))
    .map((p) => p.toolCallId as string);
}

function isInjectedImageMessage(message: MessageLike | undefined): boolean {
  if (message?.role !== "user" || !Array.isArray(message.content)) return false;
  const first = (message.content as Array<{ type?: string; text?: string }>)[0];
  return first?.type === "text" && typeof first.text === "string" && first.text.startsWith(INJECTED_IMAGE_PREFIX);
}

/**
 * prepareStep guard: after any tool message whose tool-result toolCallId has a
 * stashed image, insert a user message carrying that image. Idempotent —
 * prepareStep rebuilds messages from response history each step, so the guard
 * re-runs every step and skips positions already followed by an injection.
 */
export function imageAttachmentGuard(): PrepareStepFn {
  return ({ messages }) => {
    if (!Array.isArray(messages) || messages.length === 0 || stash.size === 0) return undefined;
    let changed = false;
    const next: unknown[] = [];
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i] as MessageLike;
      next.push(message);
      const ids = stashedIdsInMessage(message);
      if (ids.length === 0 || isInjectedImageMessage(messages[i + 1] as MessageLike)) continue;
      for (const id of ids) {
        const image = stash.get(id)!;
        changed = true;
        next.push({
          role: "user",
          content: [
            { type: "text", text: `${INJECTED_IMAGE_PREFIX}${image.label}` },
            { type: "image", image: image.data, mediaType: image.mediaType },
          ],
        });
      }
    }
    return changed ? { messages: next as never } : undefined;
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tool-image-attachments.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exulu/tool-image-attachments.ts src/exulu/tool-image-attachments.test.ts
git commit -m "feat(provider): add tool image stash and prepareStep attachment guard"
```

---

### Task 5: `view_document_page` tool

**Files:**
- Create: `src/templates/tools/view-document-page-tool.ts`
- Test: `src/templates/tools/view-document-page-tool.test.ts`

**Interfaces:**
- Consumes: `renderPdfPageToPng` (Task 2); `stashToolImage` (Task 4); `getS3ObjectBytes`, `getS3ObjectEtag` from `@SRC/uppy`; `getPdfPreviewBytes` from `@SRC/sessions/pdf-preview-cache`; `findLiteLLMModel` from `@SRC/exulu/litellm/catalog`.
- Consumes at runtime: the conversion wrapper injects `model` (the AI SDK `LanguageModel`) into every tool's inputs (`convert-exulu-tools-to-ai-sdk-tools.ts` line ~552) and passes `{ toolCallId }` as the second execute argument.
- Produces: `createViewDocumentPageTool({ sessionID, user, exuluConfig }): ExuluTool | undefined`. Tool id/name: `view_document_page`. Success shape `{ attached: true, filename, page, note }`; failure `{ error }`.

- [ ] **Step 1: Write the failing test**

Create `src/templates/tools/view-document-page-tool.test.ts`:

```typescript
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
    note: "The rendered image follows this tool result as an attached user message — analyze it there.",
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- view-document-page-tool.test.ts`
Expected: FAIL — `Cannot find module './view-document-page-tool'`.

- [ ] **Step 3: Write the implementation**

Create `src/templates/tools/view-document-page-tool.ts`:

```typescript
import { z } from "zod";
import { extname } from "node:path";
import { ExuluTool } from "@SRC/exulu/tool";
import { getS3ObjectBytes, getS3ObjectEtag } from "@SRC/uppy";
import { getPdfPreviewBytes } from "@SRC/sessions/pdf-preview-cache";
import { findLiteLLMModel } from "@SRC/exulu/litellm/catalog";
import { stashToolImage } from "@SRC/exulu/tool-image-attachments";
import type { ExuluConfig } from "@SRC/exulu/app";
import type { User } from "@EXULU_TYPES/models/user";
import { renderPdfPageToPng } from "./document-render-helpers";

/** ≈5MB after base64 — the common provider per-image limit. */
const MAX_IMAGE_BYTES = 3_750_000;
const SCALE_PRIMARY = 1568;
const SCALE_FALLBACK = 1024;

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const OFFICE_EXTENSIONS = new Set([
  ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".odt", ".ods", ".odp", ".rtf",
]);

export const createViewDocumentPageTool = ({
  sessionID,
  user,
  exuluConfig,
}: {
  sessionID?: string;
  user?: User;
  exuluConfig?: ExuluConfig;
}): ExuluTool | undefined => {
  if (!sessionID || !exuluConfig?.fileUploads?.s3Bucket) return undefined;

  const viewDocumentPageExecute = async (
    // The conversion wrapper spreads runtime context into inputs — `model` is
    // the AI SDK LanguageModel instance for this run (string or { modelId }).
    { filename, page, model }: { filename: string; page?: number; model?: unknown },
    options?: { toolCallId?: string },
  ) => {
    const safeName = String(filename ?? "").trim();
    if (!safeName || safeName.includes("..") || safeName.includes("/") || safeName.includes("\\")) {
      return {
        error: "Invalid filename — pass the bare file name exactly as listed in the session files (no paths).",
      };
    }
    const ext = extname(safeName).toLowerCase();
    const isImage = ext in IMAGE_MEDIA_TYPES;
    const isPdf = ext === ".pdf";
    const isOffice = OFFICE_EXTENSIONS.has(ext);
    if (!isImage && !isPdf && !isOffice) {
      return { error: `Unsupported extension "${ext}" — view_document_page handles PDF, Office, and image files.` };
    }

    // Vision gate: authoritative in LiteLLM mode; in catalog mode (or when the
    // proxy is unreachable) the lookup fails and we attempt optimistically —
    // a non-vision provider then errors visibly rather than silently.
    const modelId = typeof model === "string" ? model : (model as { modelId?: string } | undefined)?.modelId;
    if (modelId) {
      try {
        const entry = await findLiteLLMModel(modelId);
        if (entry && entry.supports_vision === false) {
          return {
            error:
              `The current model "${modelId}" does not support images, so this page cannot be shown to you. ` +
              "Use parse_document for the text, or tell the user a vision-capable model is required.",
          };
        }
      } catch {
        // catalog unavailable — proceed
      }
    }

    const uploads = exuluConfig.fileUploads!;
    const generalPrefix = uploads.s3prefix ? `${uploads.s3prefix.replace(/\/$/, "")}/` : "";
    const key = `${generalPrefix}user_${user?.id ?? "api"}/sessions/${sessionID}/${safeName}`;
    const pageNumber = page ?? 1;

    try {
      let imageBytes: Buffer;
      let mediaType = "image/png";

      if (isImage) {
        imageBytes = await getS3ObjectBytes(key, exuluConfig);
        mediaType = IMAGE_MEDIA_TYPES[ext]!;
        if (imageBytes.length > MAX_IMAGE_BYTES) {
          return {
            error:
              `"${safeName}" is too large to attach (${imageBytes.length} bytes, max ${MAX_IMAGE_BYTES}). ` +
              "Ask the user for a smaller version of the image.",
          };
        }
      } else {
        let pdfBytes: Buffer;
        if (isPdf) {
          pdfBytes = await getS3ObjectBytes(key, exuluConfig);
        } else {
          const etag = await getS3ObjectEtag(key, exuluConfig);
          if (!etag) {
            return { error: `Could not read session file "${safeName}". Check the exact file name.` };
          }
          pdfBytes = await getPdfPreviewBytes({ sourceKey: key, etag, config: exuluConfig });
        }
        let rendered = await renderPdfPageToPng(pdfBytes, pageNumber, SCALE_PRIMARY);
        if (rendered && rendered.length > MAX_IMAGE_BYTES) {
          rendered = await renderPdfPageToPng(pdfBytes, pageNumber, SCALE_FALLBACK);
        }
        if (!rendered) {
          return { error: `Could not render page ${pageNumber} of "${safeName}" — the document may have fewer pages.` };
        }
        if (rendered.length > MAX_IMAGE_BYTES) {
          return { error: `Page ${pageNumber} of "${safeName}" is too complex to attach within the image size limit.` };
        }
        imageBytes = rendered;
      }

      if (!options?.toolCallId) {
        return { error: "Internal error: missing toolCallId — the image cannot be attached." };
      }
      stashToolImage(options.toolCallId, {
        data: imageBytes.toString("base64"),
        mediaType,
        label: isImage ? safeName : `${safeName} page ${pageNumber}`,
      });
      return {
        attached: true,
        filename: safeName,
        page: pageNumber,
        note: "The rendered image follows this tool result as an attached user message — analyze it there.",
      };
    } catch (err) {
      return { error: `Failed to render "${safeName}": ${err instanceof Error ? err.message : "unknown error"}` };
    }
  };

  return ExuluTool.internal({
    id: "view_document_page",
    name: "view_document_page",
    needsApproval: false,
    description:
      "LOOK at a page of an uploaded PDF/Office document, or at an uploaded image, from this session's " +
      "files. The rendered image is attached as a user message directly after this tool result so you " +
      "can visually analyze photos, charts, scans, and layouts. Use parse_document first to find which " +
      "page you need. Requires a vision-capable model.",
    inputSchema: z.object({
      filename: z.string().describe('Exact session file name, e.g. "report.pdf" or "screenshot.png"'),
      page: z.number().int().min(1).optional().describe("Page number to render (default 1; ignored for image files)"),
    }),
    type: "function",
    category: "session",
    config: [],
    // Same execute-shape cast as read_session_file / parse_document.
    execute: viewDocumentPageExecute as never,
  });
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- view-document-page-tool.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/templates/tools/view-document-page-tool.ts src/templates/tools/view-document-page-tool.test.ts
git commit -m "feat(tools): add view_document_page tool with image stash delivery"
```

---

### Task 6: Register the tools and wire the guard

**Files:**
- Modify: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts` (imports ~line 30; registration after the `createSessionFileReadTool` block at ~lines 281-284)
- Modify: `src/exulu/provider.ts` (import ~line 3; `composePrepareSteps` sites at lines ~587, ~655, ~1210)
- Modify: `src/exulu/openai-gateway.ts` (import ~line 33; `composePrepareSteps` sites at lines ~548, ~590)
- Test: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts` (extend existing)

**Interfaces:**
- Consumes: `createParseDocumentTool` (Task 3), `createViewDocumentPageTool` (Task 5), `imageAttachmentGuard` (Task 4).
- Produces: both tools available to every session with file uploads configured; the guard active on every agent loop.

- [ ] **Step 1: Write the failing registration test**

In `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts`, add (following the file's existing mock style — mock the two new factory modules the same way the file mocks other tool factories):

```typescript
jest.mock("./parse-document-tool", () => ({
  createParseDocumentTool: jest.fn().mockReturnValue(undefined),
}));
jest.mock("./view-document-page-tool", () => ({
  createViewDocumentPageTool: jest.fn().mockReturnValue(undefined),
}));
```

and a test:

```typescript
it("registers parse_document and view_document_page factories with session context", async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createParseDocumentTool } = require("./parse-document-tool") as { createParseDocumentTool: jest.Mock };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createViewDocumentPageTool } = require("./view-document-page-tool") as { createViewDocumentPageTool: jest.Mock };
  await convertExuluToolsToAiSdkTools(
    [], [], [], [], [], undefined, undefined,
    { id: 7 } as never,           // user
    { fileUploads: { s3Bucket: "b" } } as never, // exuluConfig
    "session-1",                  // sessionID
  );
  expect(createParseDocumentTool).toHaveBeenCalledWith({
    sessionID: "session-1",
    user: { id: 7 },
    exuluConfig: { fileUploads: { s3Bucket: "b" } },
  });
  expect(createViewDocumentPageTool).toHaveBeenCalledWith({
    sessionID: "session-1",
    user: { id: 7 },
    exuluConfig: { fileUploads: { s3Bucket: "b" } },
  });
});
```

(Match the argument style of the existing tests in that file — if existing tests call `convertExuluToolsToAiSdkTools` with a different positional pattern, mirror it; the function signature is 18 positional parameters and existing tests already encode it.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- convert-exulu-tools-to-ai-sdk-tools.test.ts`
Expected: FAIL — the new `it(...)` fails because the factories are never called.

- [ ] **Step 3: Register the tools**

In `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`, add imports next to the `createSessionFileReadTool` import:

```typescript
import { createParseDocumentTool } from "./parse-document-tool";
import { createViewDocumentPageTool } from "./view-document-page-tool";
```

and directly after the existing `sessionFileReadTool` block (lines ~281-284):

```typescript
  const parseDocumentTool = createParseDocumentTool({ sessionID, user, exuluConfig });
  if (parseDocumentTool && !disabled.has(parseDocumentTool.id)) {
    currentTools.push(parseDocumentTool);
  }

  const viewDocumentPageTool = createViewDocumentPageTool({ sessionID, user, exuluConfig });
  if (viewDocumentPageTool && !disabled.has(viewDocumentPageTool.id)) {
    currentTools.push(viewDocumentPageTool);
  }
```

Note: no `OUTPUT_OFFLOAD_EXEMPT_TOOL_IDS` change is needed — `view_document_page` returns only a small marker JSON; the image itself never passes through the tool output.

- [ ] **Step 4: Wire the guard into all five prepareStep chains**

In `src/exulu/provider.ts`, add to the imports at the top:

```typescript
import { imageAttachmentGuard } from "./tool-image-attachments";
```

At each of the three `composePrepareSteps` sites (lines ~587, ~655, ~1210), append `imageAttachmentGuard()` as the LAST guard (after `finalAnswerGuard`) so `contextGuard`'s token estimation runs on un-inflated messages:

```typescript
        prepareStep: composePrepareSteps(contextGuard(contextWindow), retrievalGuard, finalAnswerGuard(turnBudget), imageAttachmentGuard()) as never,
```

In `src/exulu/openai-gateway.ts`, add the import (this file uses explicit `.ts` extensions — match that):

```typescript
import { imageAttachmentGuard } from "./tool-image-attachments.ts";
```

and at both sites (lines ~548, ~590):

```typescript
            prepareStep: clientTools.length > 0 ? undefined : composePrepareSteps(contextGuard(contextWindow), gatewayRetrievalGuard, finalAnswerGuard(turnBudget), imageAttachmentGuard()),
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test -- convert-exulu-tools-to-ai-sdk-tools.test.ts` — expected: PASS.
Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "provider|gateway|convert-exulu"` — expected: no new errors.
Run the full suite once: `npm test` — expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts src/exulu/provider.ts src/exulu/openai-gateway.ts
git commit -m "feat(provider): register document tools and image attachment guard"
```

---

### Task 7: LiteLLM image-injection repro script

**Files:**
- Create: `scripts/repro-view-page-image.ts`

**Interfaces:**
- Consumes: `createOpenAICompatible` from `@ai-sdk/openai-compatible`, `generateText` from `ai`, env vars `LITELLM_HOST`/`LITELLM_PORT`/`LITELLM_MASTER_KEY`.
- Produces: a manual verification command; no exports.

- [ ] **Step 1: Write the script**

Create `scripts/repro-view-page-image.ts`:

```typescript
// Verifies the image delivery mechanism used by view_document_page: an image
// injected as a user-message image part (exactly what imageAttachmentGuard
// produces) must reach the model through the local LiteLLM proxy.
// Also documents the negative case: the same image inside a tool-result is
// JSON-stringified by @ai-sdk/openai-compatible and arrives as base64 text.
//
// Usage: npx tsx scripts/repro-view-page-image.ts <litellm-model-id> <path-to-image>
//   e.g. npx tsx scripts/repro-view-page-image.ts claude-sonnet ./screenshot.png
// Run once against a Claude model and once against a non-Anthropic vision model.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const [modelId, imagePath] = process.argv.slice(2);
if (!modelId || !imagePath) {
  console.error("Usage: npx tsx scripts/repro-view-page-image.ts <litellm-model-id> <path-to-image>");
  process.exit(1);
}

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

async function main() {
  const host = process.env.LITELLM_HOST ?? "127.0.0.1";
  const port = process.env.LITELLM_PORT ?? "4000";
  const masterKey = process.env.LITELLM_MASTER_KEY;
  if (!masterKey) throw new Error("LITELLM_MASTER_KEY is required");

  const litellm = createOpenAICompatible({
    name: "litellm",
    baseURL: `http://${host}:${port}/v1`,
    apiKey: masterKey,
  });

  const mediaType = MEDIA_TYPES[extname(imagePath).toLowerCase()];
  if (!mediaType) throw new Error(`Unsupported image extension on ${imagePath}`);
  const imageBase64 = readFileSync(imagePath).toString("base64");

  // The exact message shape imageAttachmentGuard injects.
  const { text } = await generateText({
    model: litellm(modelId),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "[Image attached from tool call: test.pdf page 2]" },
          { type: "image", image: imageBase64, mediaType },
        ],
      },
      {
        role: "user",
        content: "Describe the attached image in one short sentence. If you cannot see any image, reply exactly: NO IMAGE VISIBLE",
      },
    ],
  });

  console.log(`model: ${modelId}`);
  console.log(`response: ${text}`);
  if (text.includes("NO IMAGE VISIBLE")) {
    console.error("FAIL — the injected user-message image did not reach the model.");
    process.exit(1);
  }
  console.log("PASS — injected user-message image reached the model.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run against a Claude model and a non-Anthropic vision model via local LiteLLM**

Run (with the local LiteLLM proxy running; pick model ids that exist in your LiteLLM config):
```bash
npx tsx scripts/repro-view-page-image.ts <claude-model-id> <any-local-screenshot.png>
npx tsx scripts/repro-view-page-image.ts <non-anthropic-vision-model-id> <any-local-screenshot.png>
```
Expected: `PASS — injected user-message image reached the model.` for both, with a plausible one-sentence description. If a model fails, record which and investigate LiteLLM's image handling for that provider before shipping.

- [ ] **Step 3: Commit**

```bash
git add scripts/repro-view-page-image.ts
git commit -m "test(tools): add LiteLLM image-injection repro script"
```

---

### Task 8: Manual end-to-end verification (the original failing scenario)

**Files:** none (checklist only).

- [ ] **Step 1: Replay the originating bug**

1. Start the backend and frontend dev servers with file uploads + LiteLLM configured, using a vision-capable default model.
2. In a new chat session, upload a PDF that contains a picture on page 2 (any PDF with an embedded image works) via the session files panel.
3. Ask: *"What is the image on page 2 of <filename>?"*
4. Expected agent behavior: calls `parse_document` (orients, or gets the "no extractable text" hint for scans) → calls `view_document_page` with page 2 → the response describes the actual image content. No apology, no `file: command not found`.

- [ ] **Step 2: Verify the guard rails**

1. Ask about page 999 → agent relays the page-out-of-range error gracefully.
2. Switch the agent to a non-vision model (if one is configured) and repeat → agent explains a vision-capable model is needed rather than failing silently.
3. Upload a `.png` screenshot and ask "what does this screenshot show?" → agent uses `view_document_page` directly and describes it.

- [ ] **Step 3: Confirm history hygiene**

After the conversation, send one more unrelated message, then inspect the persisted session messages (DB or session transcript): tool results for `view_document_page` must contain only the marker JSON — no base64 blobs in stored history.

---

## Verification checklist (spec → tasks)

- `parse_document` (page-marked text, free, paginated, traversal-guarded) → Tasks 2, 3
- `pdftotext` required dependency → Task 1
- `view_document_page` (PDF render, office via preview cache, direct images, caps + downscale, vision gate) → Tasks 2, 5
- Delivery via prepareStep injection (amended spec) → Tasks 4, 6
- Registration alongside `read_session_file` → Task 6
- LiteLLM pass-through verification (Claude + non-Anthropic) → Task 7
- Original scenario E2E + error handling + no-base64-in-history → Task 8
