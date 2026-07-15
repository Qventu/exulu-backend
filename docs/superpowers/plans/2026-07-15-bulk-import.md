# Bulk Import (CSV + File Drop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A three-step Import wizard in the knowledge workspace that turns dropped files and/or a CSV into bulk create/update operations against any ExuluContext, executed client-side over existing GraphQL mutations and presigned S3 uploads.

**Architecture:** Pure logic (CSV parsing, coercion, mapping, file matching, row building, classification, execution engine) lives in unit-tested modules under `lib/import/`; UI is a wizard dialog under `app/(application)/data/[ctx]/components/import/` reusing existing primitives (Dropzone, shadcn Dialog/Table/Select, TanStack table). Zero backend changes — verified in the spec (`docs/superpowers/specs/2026-07-15-bulk-import-design.md` in the backend repo).

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Apollo Client, papaparse (new dep), @tanstack/react-table (existing), vitest, next-intl, shadcn/ui.

## Global Constraints

- **All code lives in the FRONTEND repo:** `/Users/daniel.claessen/Desktop/Projects/exulu/frontend`. Every file path below is relative to that root. This plan document lives in the backend repo; do not add code to the backend.
- **Branch:** `feature/bulk-import` off `main` (frontend has no develop branch). Per repo convention, work in a sibling worktree with symlinked `node_modules` (use superpowers:using-git-worktrees at execution start).
- **Node 22.18.0, npm** (`package-lock.json`). Run `npm test` (vitest run), `npm run lint` (ESLint 9 flat config), `npx tsc --noEmit` as quality gates.
- **New dependencies:** `papaparse` and `@types/papaparse` ONLY. No spreadsheet/grid library.
- **i18n:** every user-facing string via next-intl under the `knowledge` namespace; `messages/en.json` AND `messages/de.json` change in the same commit; keys alphabetically sorted within their object.
- **Created items get `source: "import"`** (existing UI uses `"manual"`; the column is unvalidated text).
- **Never edit `queries/queries.ts`** (monolith copy). The editable GraphQL layer is `app/(application)/data/queries.ts`.
- **Design:** existing token classes only (`bg-secondary`, `text-destructive`, etc.). No violet accents, no new colors.
- **Test style:** colocated `<module>.test.ts`, explicit `import { describe, expect, it } from "vitest"`, module under test imported via `@/` alias. Vitest runs in a plain node environment — the include globs already cover `lib/**/*.test.ts`.
- The wizard targets batches of ≤100 rows; no server-side job, no XLSX, one CSV per import (spec "Out of scope").

---

### Task 1: Branch, dependencies, baseline

**Files:**
- Modify: `package.json`, `package-lock.json` (via npm)

**Interfaces:**
- Consumes: nothing.
- Produces: branch `feature/bulk-import` with `papaparse@^5` + `@types/papaparse` installed; green baseline (`npm test`, `npm run lint` pass before any feature code).

- [ ] **Step 1: Create the branch** (inside the worktree created by superpowers:using-git-worktrees)

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend   # or the worktree path
git checkout main && git pull && git checkout -b feature/bulk-import
```

- [ ] **Step 2: Record the baseline**

Run: `npm test && npm run lint`
Expected: both pass (19 pre-existing test files). If the baseline is red, STOP and report — do not proceed on a broken baseline.

- [ ] **Step 3: Install papaparse**

```bash
npm install papaparse && npm install -D @types/papaparse
```

- [ ] **Step 4: Verify install**

Run: `node -e "console.log(require('papaparse').parse('a,b\n1,2').data)"`
Expected: `[ [ 'a', 'b' ], [ '1', '2' ] ]`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add papaparse for bulk import CSV parsing"
```

---

### Task 2: Extract `extractS3KeyFromUrl` into a pure module

The function currently lives module-private in `hooks/use-uppy.tsx`. The import upload helper (Task 11) needs it, and importing `use-uppy.tsx` into node tests would drag in Uppy + localStorage. Move it to a pure module and rewire.

**Files:**
- Create: `lib/s3/extract-key.ts`
- Test: `lib/s3/extract-key.test.ts`
- Modify: `hooks/use-uppy.tsx` (delete local function lines 32–60, add import)

**Interfaces:**
- Consumes: nothing.
- Produces: `export function extractS3KeyFromUrl(uploadURL: string): string` at `@/lib/s3/extract-key` — given a presigned upload URL, returns the raw `bucket/key` (path-style hosts) or re-prepends the bucket (AWS virtual-hosted hosts). Task 11 imports this.

- [ ] **Step 1: Write the failing test**

```ts
// lib/s3/extract-key.test.ts
import { describe, expect, it } from "vitest";

import { extractS3KeyFromUrl } from "@/lib/s3/extract-key";

describe("extractS3KeyFromUrl", () => {
  it("re-prepends the bucket for AWS virtual-hosted URLs", () => {
    expect(
      extractS3KeyFromUrl(
        "https://mybucket.s3.eu-central-1.amazonaws.com/user_1/abc-_EXULU_report.pdf?X-Amz-Signature=xyz",
      ),
    ).toBe("mybucket/user_1/abc-_EXULU_report.pdf");
  });

  it("returns the decoded pathname for path-style endpoints (MinIO/custom)", () => {
    expect(
      extractS3KeyFromUrl(
        "https://api.s3.exulu.com/exulu/user_1/abc-_EXULU_my%20file.pdf?X-Amz-Signature=xyz",
      ),
    ).toBe("exulu/user_1/abc-_EXULU_my file.pdf");
  });

  it("does not treat a custom host with s3 in the name as virtual-hosted", () => {
    expect(
      extractS3KeyFromUrl("https://api.s3.exulu.com/bucket/key.png"),
    ).toBe("bucket/key.png");
  });

  it("falls back to the last URL segment when parsing fails", () => {
    expect(extractS3KeyFromUrl("not a url/last-bit")).toBe("last-bit");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/s3/extract-key.test.ts`
Expected: FAIL — cannot resolve `@/lib/s3/extract-key`.

- [ ] **Step 3: Create the module** (verbatim move of the function body from `hooks/use-uppy.tsx:32-60`)

```ts
// lib/s3/extract-key.ts

/**
 * Converts a presigned S3 upload URL back into the raw object key stored in
 * file fields. Moved verbatim out of hooks/use-uppy.tsx so pure modules
 * (lib/import/upload.ts) can use it without importing Uppy.
 */
export function extractS3KeyFromUrl(uploadURL: string): string {
  try {
    const url = new URL(uploadURL);
    const hostname = url.hostname;
    // url.pathname is percent-encoded (spaces → %20, "–" → %E2%80%93, etc.).
    // Decode it so the stored s3Key is the raw object key — otherwise the
    // backend re-encodes it when presigning (%20 → %2520) and S3 404s on a
    // key that doesn't exist.
    const rawPath = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
    const keyPath = decodeURIComponent(rawPath);
    // Virtual-hosted-style AWS S3 URLs put the bucket in the subdomain:
    // <bucket>.s3.<region>.amazonaws.com/<key> → re-prepend the bucket.
    // Custom / MinIO endpoints (e.g. api.s3.exulu.com) are path-style — the
    // bucket is already the first path segment — so the pathname IS the
    // bucket/key. Guard on amazonaws.com so a host like "api.s3.exulu.com"
    // isn't mistaken for a virtual-hosted bucket named "api".
    const isAwsVirtualHosted =
      hostname.endsWith(".amazonaws.com") && /\.s3[.-]/.test(hostname);
    if (isAwsVirtualHosted) {
      const parts = hostname.split(/\.s3[.-]/);
      const bucket = parts[0];
      return `${bucket}/${keyPath}`;
    }
    return keyPath;
  } catch (e) {
    console.error("Failed to parse S3 upload URL:", e);
    return uploadURL.split("/").pop() || "";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/s3/extract-key.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Rewire `hooks/use-uppy.tsx`**

Delete the entire local `function extractS3KeyFromUrl(uploadURL: string): string { ... }` block (lines 32–60) and add to the import block at the top of the file:

```ts
import { extractS3KeyFromUrl } from "@/lib/s3/extract-key";
```

The two call sites (`s3Key: extractS3KeyFromUrl(response.uploadURL)` in the `upload-success` handler) stay unchanged.

- [ ] **Step 6: Verify nothing broke**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add lib/s3/extract-key.ts lib/s3/extract-key.test.ts hooks/use-uppy.tsx
git commit -m "refactor: extract extractS3KeyFromUrl into lib/s3/extract-key"
```

---

### Task 3: Import types, Context type extension, and the column model

**Files:**
- Modify: `types/models/context.ts` (add `required?`/`unique?` to `fields[]`)
- Create: `lib/import/types.ts`
- Create: `lib/import/fields.ts`
- Test: `lib/import/fields.test.ts`

**Interfaces:**
- Consumes: `Context` from `@/types/models/context`.
- Produces (used by every later task):
  - `ImportField { name: string; label: string; type: string; required: boolean; core: boolean; enumValues?: string[]; allowedFileTypes?: string[] }`
  - `CellValue = string | number | boolean | null`
  - `CellError { code: string; params?: Record<string, string> }`
  - `ImportCell { raw: string; value: CellValue; error?: CellError; file?: File }`
  - `RowAction = "create" | "update"`, `RowRunState = "pending" | "uploading" | "saving" | "done" | "failed"`
  - `ImportRow { key: string; cells: Record<string, ImportCell>; action: RowAction; targetItemId?: string; error?: CellError; runState: RowRunState; runError?: string }`
  - `CORE_FIELDS: ImportField[]` (order: `id`, `external_id`, `name`, `description`, `tags`; only `name` is required)
  - `importableFields(context: Context): ImportField[]` — core fields + context fields minus `editable === false` / `calculated`
  - `fileFields(fields: ImportField[]): ImportField[]`

- [ ] **Step 1: Extend the Context type.** In `types/models/context.ts`, change the `fields` entry type to:

```ts
  fields: {
    name: string
    editable?: boolean
    calculated?: boolean
    required?: boolean
    unique?: boolean
    type: ExuluFieldTypes
    label: string
    allowedFileTypes?: allFileTypes[]
    enumValues?: string[]
  }[]
```

(The backend already ships `required`/`unique` through the JSON-typed `Context.fields`; this only teaches TypeScript about it.)

- [ ] **Step 2: Write the failing test**

```ts
// lib/import/fields.test.ts
import { describe, expect, it } from "vitest";

import { CORE_FIELDS, fileFields, importableFields } from "@/lib/import/fields";
import type { Context } from "@/types/models/context";

const context = {
  id: "docs",
  fields: [
    { name: "category", type: "enum", label: "category", enumValues: ["a", "b"], required: true },
    { name: "document_s3key", type: "file", label: "document", allowedFileTypes: [".pdf"] },
    { name: "score", type: "number", label: "score", editable: false },
    { name: "summary", type: "longText", label: "summary", calculated: true },
  ],
} as unknown as Context;

describe("importableFields", () => {
  it("prepends core fields in order id, external_id, name, description, tags", () => {
    const names = importableFields(context).map((f) => f.name);
    expect(names.slice(0, 5)).toEqual(["id", "external_id", "name", "description", "tags"]);
  });

  it("skips non-editable and calculated fields", () => {
    const names = importableFields(context).map((f) => f.name);
    expect(names).not.toContain("score");
    expect(names).not.toContain("summary");
    expect(names).toContain("category");
    expect(names).toContain("document_s3key");
  });

  it("carries required, enumValues and allowedFileTypes through", () => {
    const fields = importableFields(context);
    const category = fields.find((f) => f.name === "category");
    expect(category?.required).toBe(true);
    expect(category?.enumValues).toEqual(["a", "b"]);
    const doc = fields.find((f) => f.name === "document_s3key");
    expect(doc?.allowedFileTypes).toEqual([".pdf"]);
    expect(doc?.label).toBe("document");
  });

  it("marks only the core name field as required among core fields", () => {
    expect(CORE_FIELDS.filter((f) => f.required).map((f) => f.name)).toEqual(["name"]);
  });
});

describe("fileFields", () => {
  it("returns only file-typed fields", () => {
    expect(fileFields(importableFields(context)).map((f) => f.name)).toEqual(["document_s3key"]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- lib/import/fields.test.ts`
Expected: FAIL — cannot resolve `@/lib/import/fields`.

- [ ] **Step 4: Create the types module**

```ts
// lib/import/types.ts

/** One importable column: a core item field or a context custom field. */
export interface ImportField {
  /** GraphQL input key, e.g. "name" or "document_s3key". */
  name: string;
  /** Human label used in CSV templates, mapping and grid headers. */
  label: string;
  /** ExuluFieldTypes plus backend-only "date"/"uuid" — kept as string. */
  type: string;
  required: boolean;
  core: boolean;
  enumValues?: string[];
  allowedFileTypes?: string[];
}

export type CellValue = string | number | boolean | null;

/** i18n-translatable error: code resolves to knowledge.workspace.import.errors.<code>. */
export interface CellError {
  code: string;
  params?: Record<string, string>;
}

export interface ImportCell {
  /** Original text (CSV cell / grid input) for display and error reports. */
  raw: string;
  /** Coerced value ready for the mutation input. */
  value: CellValue;
  error?: CellError;
  /** File cells: the matched local file, uploaded at run time. */
  file?: File;
}

export type RowAction = "create" | "update";
export type RowRunState = "pending" | "uploading" | "saving" | "done" | "failed";

export interface ImportRow {
  /** Stable per-batch key, e.g. "csv-3" or "file-0-report.pdf". */
  key: string;
  cells: Record<string, ImportCell>;
  action: RowAction;
  /** Item id this row updates (set by classifyRows). */
  targetItemId?: string;
  /** Row-level error (duplicate key, unknown id). */
  error?: CellError;
  runState: RowRunState;
  runError?: string;
}
```

- [ ] **Step 5: Create the fields module**

```ts
// lib/import/fields.ts
import type { Context } from "@/types/models/context";

import type { ImportField } from "@/lib/import/types";

/**
 * Core item columns every context supports. `id` is matching metadata only —
 * input builders never send it (see rows.ts).
 */
export const CORE_FIELDS: ImportField[] = [
  { name: "id", label: "id", type: "text", required: false, core: true },
  { name: "external_id", label: "external_id", type: "text", required: false, core: true },
  { name: "name", label: "name", type: "shortText", required: true, core: true },
  { name: "description", label: "description", type: "longText", required: false, core: true },
  { name: "tags", label: "tags", type: "text", required: false, core: true },
];

/** Importable columns: core fields + editable, non-calculated context fields. */
export function importableFields(context: Context): ImportField[] {
  const custom: ImportField[] = (context.fields ?? [])
    .filter((f) => f.editable !== false && !f.calculated)
    .map((f) => ({
      name: f.name,
      label: f.label || f.name,
      type: f.type,
      required: f.required === true,
      core: false,
      enumValues: f.enumValues,
      allowedFileTypes: f.allowedFileTypes,
    }));
  return [...CORE_FIELDS, ...custom];
}

export function fileFields(fields: ImportField[]): ImportField[] {
  return fields.filter((f) => f.type === "file");
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- lib/import/fields.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add types/models/context.ts lib/import/types.ts lib/import/fields.ts lib/import/fields.test.ts
git commit -m "feat(import): column model derived from context fields"
```

---

### Task 4: Type coercion

**Files:**
- Create: `lib/import/coerce.ts`
- Test: `lib/import/coerce.test.ts`

**Interfaces:**
- Consumes: `ImportField`, `ImportCell` from `@/lib/import/types`.
- Produces: `export function coerceValue(field: ImportField, raw: string): ImportCell` — never throws; failures are `ImportCell.error` with codes `number`, `numberAmbiguous`, `boolean`, `enum`, `date`, `json`, `uuid`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/import/coerce.test.ts
import { describe, expect, it } from "vitest";

import { coerceValue } from "@/lib/import/coerce";
import type { ImportField } from "@/lib/import/types";

const field = (overrides: Partial<ImportField>): ImportField => ({
  name: "f",
  label: "f",
  type: "text",
  required: false,
  core: false,
  ...overrides,
});

describe("coerceValue: blanks", () => {
  it("keeps empty string for textual types", () => {
    expect(coerceValue(field({ type: "text" }), "").value).toBe("");
    expect(coerceValue(field({ type: "markdown" }), "  ").value).toBe("");
  });
  it("maps blank to null for non-textual types", () => {
    expect(coerceValue(field({ type: "number" }), "").value).toBeNull();
    expect(coerceValue(field({ type: "boolean" }), " ").value).toBeNull();
    expect(coerceValue(field({ type: "file" }), "").value).toBeNull();
  });
});

describe("coerceValue: number", () => {
  const num = field({ type: "number" });
  it("parses dot decimals", () => {
    expect(coerceValue(num, "1.5").value).toBe(1.5);
  });
  it("accepts unambiguous comma decimals (1-2 decimals)", () => {
    expect(coerceValue(num, "1,5").value).toBe(1.5);
    expect(coerceValue(num, "1,50").value).toBe(1.5);
  });
  it("rejects comma with three decimals as ambiguous thousands", () => {
    expect(coerceValue(num, "1,500").error?.code).toBe("numberAmbiguous");
  });
  it("rejects mixed separators and non-numbers", () => {
    expect(coerceValue(num, "1,234.56").error?.code).toBe("number");
    expect(coerceValue(num, "abc").error?.code).toBe("number");
  });
});

describe("coerceValue: boolean", () => {
  const bool = field({ type: "boolean" });
  it("accepts true/yes/ja/1 and false/no/nein/0, case-insensitive", () => {
    for (const v of ["true", "YES", "Ja", "1"]) expect(coerceValue(bool, v).value).toBe(true);
    for (const v of ["false", "No", "NEIN", "0"]) expect(coerceValue(bool, v).value).toBe(false);
  });
  it("rejects anything else", () => {
    expect(coerceValue(bool, "maybe").error?.code).toBe("boolean");
  });
});

describe("coerceValue: enum", () => {
  const en = field({ type: "enum", enumValues: ["Alpha", "Beta"] });
  it("matches case-insensitively and stores the canonical casing", () => {
    expect(coerceValue(en, "alpha").value).toBe("Alpha");
  });
  it("rejects unknown values and lists the options", () => {
    const cell = coerceValue(en, "gamma");
    expect(cell.error?.code).toBe("enum");
    expect(cell.error?.params?.values).toBe("Alpha, Beta");
  });
});

describe("coerceValue: date", () => {
  const date = field({ type: "date" });
  it("accepts ISO dates verbatim", () => {
    expect(coerceValue(date, "2026-07-15").value).toBe("2026-07-15");
    expect(coerceValue(date, "2026-07-15T10:00:00Z").value).toBe("2026-07-15T10:00:00Z");
  });
  it("rejects slash formats as ambiguous", () => {
    expect(coerceValue(date, "03/04/2026").error?.code).toBe("date");
  });
  it("falls back to Date.parse for unambiguous text dates", () => {
    const cell = coerceValue(date, "15 July 2026");
    expect(cell.error).toBeUndefined();
    expect(typeof cell.value).toBe("string");
  });
  it("rejects garbage", () => {
    expect(coerceValue(date, "not a date").error?.code).toBe("date");
  });
});

describe("coerceValue: json / uuid / file / text", () => {
  it("validates json but keeps the raw string as value", () => {
    expect(coerceValue(field({ type: "json" }), '{"a":1}').value).toBe('{"a":1}');
    expect(coerceValue(field({ type: "json" }), "{nope").error?.code).toBe("json");
  });
  it("validates uuid format", () => {
    expect(
      coerceValue(field({ type: "uuid" }), "123e4567-e89b-12d3-a456-426614174000").error,
    ).toBeUndefined();
    expect(coerceValue(field({ type: "uuid" }), "nope").error?.code).toBe("uuid");
  });
  it("passes file cell values through trimmed (filename matching happens later)", () => {
    expect(coerceValue(field({ type: "file" }), " report.pdf ").value).toBe("report.pdf");
  });
  it("keeps raw text for unknown types (backend-only types degrade to text)", () => {
    expect(coerceValue(field({ type: "somethingNew" }), "keep me").value).toBe("keep me");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/import/coerce.test.ts`
Expected: FAIL — cannot resolve `@/lib/import/coerce`.

- [ ] **Step 3: Implement**

```ts
// lib/import/coerce.ts
import type { ImportCell, ImportField } from "@/lib/import/types";

const TEXTUAL = new Set(["text", "longText", "shortText", "markdown", "code"]);

const err = (raw: string, code: string, params?: Record<string, string>): ImportCell => ({
  raw,
  value: null,
  error: { code, params },
});

/** Coerce a raw string to the field's value type. Never throws. */
export function coerceValue(field: ImportField, raw: string): ImportCell {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { raw, value: TEXTUAL.has(field.type) ? "" : null };
  }
  switch (field.type) {
    case "number": {
      const hasComma = trimmed.includes(",");
      const hasDot = trimmed.includes(".");
      if (hasComma && hasDot) return err(raw, "number");
      let candidate = trimmed;
      if (hasComma) {
        const parts = trimmed.split(",");
        // A single comma with 1-2 decimals is an unambiguous decimal comma
        // (German CSV exports); "1,500" is indistinguishable from a
        // thousands separator, so it is rejected rather than guessed.
        if (parts.length !== 2 || parts[1].length === 3) return err(raw, "numberAmbiguous");
        candidate = parts.join(".");
      }
      const n = Number(candidate);
      if (!Number.isFinite(n)) return err(raw, "number");
      return { raw, value: n };
    }
    case "boolean": {
      const v = trimmed.toLowerCase();
      if (["true", "yes", "ja", "1"].includes(v)) return { raw, value: true };
      if (["false", "no", "nein", "0"].includes(v)) return { raw, value: false };
      return err(raw, "boolean");
    }
    case "enum": {
      const match = (field.enumValues ?? []).find(
        (e) => e.toLowerCase() === trimmed.toLowerCase(),
      );
      if (!match) return err(raw, "enum", { values: (field.enumValues ?? []).join(", ") });
      return { raw, value: match };
    }
    case "date": {
      if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed)) {
        return Number.isNaN(Date.parse(trimmed)) ? err(raw, "date") : { raw, value: trimmed };
      }
      if (trimmed.includes("/")) return err(raw, "date");
      return Number.isNaN(Date.parse(trimmed))
        ? err(raw, "date")
        : { raw, value: new Date(trimmed).toISOString() };
    }
    case "json": {
      try {
        JSON.parse(trimmed);
        return { raw, value: trimmed };
      } catch {
        return err(raw, "json");
      }
    }
    case "uuid": {
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
        ? { raw, value: trimmed }
        : err(raw, "uuid");
    }
    case "file":
      return { raw, value: trimmed };
    default:
      return { raw, value: raw };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/import/coerce.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/import/coerce.ts lib/import/coerce.test.ts
git commit -m "feat(import): per-field-type value coercion"
```

---

### Task 5: CSV parsing and column auto-mapping

**Files:**
- Create: `lib/import/parse-csv.ts`, `lib/import/map-columns.ts`
- Test: `lib/import/parse-csv.test.ts`, `lib/import/map-columns.test.ts`

**Interfaces:**
- Consumes: `papaparse`; `ImportField`.
- Produces:
  - `ParsedCsv { headers: string[]; rows: string[][]; errors: string[] }`
  - `parseCsvText(text: string): ParsedCsv` and `parseCsvFile(file: File): Promise<ParsedCsv>`
  - `ColumnMapping { header: string; index: number; fieldName: string | null }`
  - `normalizeHeader(value: string): string`
  - `autoMapColumns(headers: string[], fields: ImportField[]): ColumnMapping[]`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/import/parse-csv.test.ts
import { describe, expect, it } from "vitest";

import { parseCsvText } from "@/lib/import/parse-csv";

describe("parseCsvText", () => {
  it("splits headers and rows", () => {
    const parsed = parseCsvText("name,category\nAlpha,a\nBeta,b\n");
    expect(parsed.headers).toEqual(["name", "category"]);
    expect(parsed.rows).toEqual([
      ["Alpha", "a"],
      ["Beta", "b"],
    ]);
  });

  it("handles quoted commas and quotes", () => {
    const parsed = parseCsvText('name,description\n"Comma, Inc.","He said ""hi"""\n');
    expect(parsed.rows[0]).toEqual(["Comma, Inc.", 'He said "hi"']);
  });

  it("skips fully empty lines", () => {
    const parsed = parseCsvText("name\nAlpha\n\n\nBeta\n");
    expect(parsed.rows).toEqual([["Alpha"], ["Beta"]]);
  });

  it("trims header whitespace", () => {
    expect(parseCsvText(" name , category \nA,b").headers).toEqual(["name", "category"]);
  });
});
```

```ts
// lib/import/map-columns.test.ts
import { describe, expect, it } from "vitest";

import { autoMapColumns, normalizeHeader } from "@/lib/import/map-columns";
import type { ImportField } from "@/lib/import/types";

const fields: ImportField[] = [
  { name: "id", label: "id", type: "text", required: false, core: true },
  { name: "external_id", label: "external_id", type: "text", required: false, core: true },
  { name: "name", label: "name", type: "shortText", required: true, core: true },
  { name: "document_s3key", label: "document", type: "file", required: false, core: false },
  { name: "category", label: "category", type: "enum", required: false, core: false },
];

describe("normalizeHeader", () => {
  it("lowercases, trims and unifies separators", () => {
    expect(normalizeHeader(" External ID ")).toBe("external_id");
    expect(normalizeHeader("document-s3key")).toBe("document_s3key");
  });
});

describe("autoMapColumns", () => {
  it("matches by field name or label, case/separator-insensitive", () => {
    const mapping = autoMapColumns(["Name", "External ID", "document", "unknown"], fields);
    expect(mapping.map((m) => m.fieldName)).toEqual(["name", "external_id", "document_s3key", null]);
    expect(mapping[2].index).toBe(2);
  });

  it("maps a file column by its storage name too", () => {
    expect(autoMapColumns(["document_s3key"], fields)[0].fieldName).toBe("document_s3key");
  });

  it("never maps two columns to the same field", () => {
    const mapping = autoMapColumns(["name", "Name"], fields);
    expect(mapping[0].fieldName).toBe("name");
    expect(mapping[1].fieldName).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- lib/import/parse-csv.test.ts lib/import/map-columns.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement both modules**

```ts
// lib/import/parse-csv.ts
import Papa from "papaparse";

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  errors: string[];
}

export function parseCsvText(text: string): ParsedCsv {
  const result = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
  const data = result.data.filter((r) => Array.isArray(r));
  const headers = (data[0] ?? []).map((h) => String(h ?? "").trim());
  const rows = data.slice(1).map((r) => r.map((v) => String(v ?? "")));
  const errors = result.errors.map(
    (e) => `${e.message}${typeof e.row === "number" ? ` (row ${e.row + 1})` : ""}`,
  );
  return { headers, rows, errors };
}

export async function parseCsvFile(file: File): Promise<ParsedCsv> {
  return parseCsvText(await file.text());
}
```

```ts
// lib/import/map-columns.ts
import type { ImportField } from "@/lib/import/types";

/** Lowercase, trim, and unify space/dash separators to underscores. */
export function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export interface ColumnMapping {
  header: string;
  index: number;
  fieldName: string | null;
}

/** Best-effort header → field auto-match; unmatched columns map to null. */
export function autoMapColumns(headers: string[], fields: ImportField[]): ColumnMapping[] {
  const used = new Set<string>();
  return headers.map((header, index) => {
    const n = normalizeHeader(header);
    const match = fields.find(
      (f) =>
        !used.has(f.name) &&
        (normalizeHeader(f.name) === n || normalizeHeader(f.label) === n),
    );
    if (!match) return { header, index, fieldName: null };
    used.add(match.name);
    return { header, index, fieldName: match.name };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- lib/import/parse-csv.test.ts lib/import/map-columns.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/import/parse-csv.ts lib/import/parse-csv.test.ts lib/import/map-columns.ts lib/import/map-columns.test.ts
git commit -m "feat(import): CSV parsing and header auto-mapping"
```

---

### Task 6: Filename → dropped-file matching

**Files:**
- Create: `lib/import/match-files.ts`
- Test: `lib/import/match-files.test.ts`

**Interfaces:**
- Consumes: `ImportRow` from types.
- Produces:
  - `fileMatchKey(value: string): string` — basename, lowercased
  - `FileIndex { byName: Map<string, File>; duplicateNames: string[] }`
  - `indexFiles(files: File[]): FileIndex`
  - `findFile(index: FileIndex, cellValue: string): File | undefined`
  - `leftoverFiles(files: File[], rows: ImportRow[]): File[]`

- [ ] **Step 1: Write the failing test**

```ts
// lib/import/match-files.test.ts
import { describe, expect, it } from "vitest";

import { fileMatchKey, findFile, indexFiles, leftoverFiles } from "@/lib/import/match-files";
import type { ImportRow } from "@/lib/import/types";

const f = (name: string) => new File(["x"], name);

describe("fileMatchKey", () => {
  it("takes the basename and lowercases", () => {
    expect(fileMatchKey("C:\\docs\\Report.PDF")).toBe("report.pdf");
    expect(fileMatchKey("folder/Report.pdf")).toBe("report.pdf");
    expect(fileMatchKey(" Report.pdf ")).toBe("report.pdf");
  });
});

describe("indexFiles / findFile", () => {
  it("matches case-insensitively by basename", () => {
    const index = indexFiles([f("Report.PDF"), f("notes.txt")]);
    expect(findFile(index, "report.pdf")?.name).toBe("Report.PDF");
    expect(findFile(index, "missing.pdf")).toBeUndefined();
  });

  it("keeps the first file and reports duplicates", () => {
    const index = indexFiles([f("a.pdf"), f("A.PDF")]);
    expect(index.duplicateNames).toEqual(["A.PDF"]);
    expect(index.byName.size).toBe(1);
  });
});

describe("leftoverFiles", () => {
  it("returns files not referenced by any row cell", () => {
    const used = f("used.pdf");
    const unused = f("unused.pdf");
    const rows: ImportRow[] = [
      {
        key: "r1",
        action: "create",
        runState: "pending",
        cells: { doc: { raw: "used.pdf", value: "used.pdf", file: used } },
      },
    ];
    expect(leftoverFiles([used, unused], rows)).toEqual([unused]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/import/match-files.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// lib/import/match-files.ts
import type { ImportRow } from "@/lib/import/types";

/** Basename (either separator style), trimmed and lowercased. */
export function fileMatchKey(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? value;
  return base.trim().toLowerCase();
}

export interface FileIndex {
  byName: Map<string, File>;
  duplicateNames: string[];
}

/** First file wins on name collisions; later duplicates are reported. */
export function indexFiles(files: File[]): FileIndex {
  const byName = new Map<string, File>();
  const duplicateNames: string[] = [];
  for (const file of files) {
    const key = fileMatchKey(file.name);
    if (byName.has(key)) duplicateNames.push(file.name);
    else byName.set(key, file);
  }
  return { byName, duplicateNames };
}

export function findFile(index: FileIndex, cellValue: string): File | undefined {
  return index.byName.get(fileMatchKey(cellValue));
}

/** Dropped files not referenced by any row's file cell. */
export function leftoverFiles(files: File[], rows: ImportRow[]): File[] {
  const used = new Set<File>();
  for (const row of rows) {
    for (const cell of Object.values(row.cells)) {
      if (cell.file) used.add(cell.file);
    }
  }
  return files.filter((file) => !used.has(file));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/import/match-files.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/import/match-files.ts lib/import/match-files.test.ts
git commit -m "feat(import): filename matching for dropped files"
```

---

### Task 7: Row building, validation, and mutation input builders

**Files:**
- Create: `lib/import/rows.ts`
- Test: `lib/import/rows.test.ts`

**Interfaces:**
- Consumes: `coerceValue`, `findFile`/`FileIndex`, `ParsedCsv`, `ColumnMapping`, types.
- Produces:
  - `rowsFromFiles(files: File[], targetFieldName: string, keyPrefix?: string): ImportRow[]` — one create-row per file; `name` prefilled from the filename without extension
  - `rowsFromCsv(parsed: ParsedCsv, mapping: ColumnMapping[], fields: ImportField[], fileIndex: FileIndex): ImportRow[]`
  - `validateRow(row: ImportRow, fields: ImportField[]): ImportRow` — adds/clears `required` and `fileType` cell errors
  - `rowIsValid(row: ImportRow): boolean`
  - `buildCreateInput(row: ImportRow, fields: ImportField[]): Record<string, unknown>` — mirrors `new-item-dialog.tsx` (`tags` comma string, `textlength`, `external_id || null`) but with `source: "import"`; never includes `id`
  - `buildUpdateInput(row: ImportRow, fields: ImportField[]): Record<string, unknown>` — partial: only present cells; never `id`, never `source`; `textlength` added when `description` present

- [ ] **Step 1: Write the failing test**

```ts
// lib/import/rows.test.ts
import { describe, expect, it } from "vitest";

import { indexFiles } from "@/lib/import/match-files";
import {
  buildCreateInput,
  buildUpdateInput,
  rowIsValid,
  rowsFromCsv,
  rowsFromFiles,
  validateRow,
} from "@/lib/import/rows";
import type { ImportField, ImportRow } from "@/lib/import/types";

const FIELDS: ImportField[] = [
  { name: "id", label: "id", type: "text", required: false, core: true },
  { name: "external_id", label: "external_id", type: "text", required: false, core: true },
  { name: "name", label: "name", type: "shortText", required: true, core: true },
  { name: "description", label: "description", type: "longText", required: false, core: true },
  { name: "tags", label: "tags", type: "text", required: false, core: true },
  { name: "category", label: "category", type: "enum", required: true, core: false, enumValues: ["a", "b"] },
  { name: "doc_s3key", label: "doc", type: "file", required: false, core: false, allowedFileTypes: [".pdf"] },
];

describe("rowsFromFiles", () => {
  it("creates one row per file with name prefilled (extension stripped)", () => {
    const rows = rowsFromFiles([new File(["x"], "Q3 Report.pdf")], "doc_s3key");
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("create");
    expect(rows[0].cells.name.value).toBe("Q3 Report");
    expect(rows[0].cells.doc_s3key.file?.name).toBe("Q3 Report.pdf");
  });
});

describe("rowsFromCsv", () => {
  const parsed = {
    headers: ["name", "category", "doc"],
    rows: [
      ["Alpha", "A", "report.pdf"],
      ["Beta", "b", "missing.pdf"],
    ],
    errors: [],
  };
  const mapping = [
    { header: "name", index: 0, fieldName: "name" },
    { header: "category", index: 1, fieldName: "category" },
    { header: "doc", index: 2, fieldName: "doc_s3key" },
  ];

  it("coerces cells and matches files by name", () => {
    const index = indexFiles([new File(["x"], "Report.PDF")]);
    const rows = rowsFromCsv(parsed, mapping, FIELDS, index);
    expect(rows[0].cells.category.value).toBe("a");
    expect(rows[0].cells.doc_s3key.file?.name).toBe("Report.PDF");
    expect(rows[1].cells.doc_s3key.error?.code).toBe("fileMissing");
  });

  it("skips unmapped columns", () => {
    const rows = rowsFromCsv(parsed, [{ header: "name", index: 0, fieldName: "name" }], FIELDS, indexFiles([]));
    expect(Object.keys(rows[0].cells)).toEqual(["name"]);
  });
});

describe("validateRow", () => {
  it("flags missing required fields on create rows", () => {
    const row: ImportRow = { key: "r", action: "create", runState: "pending", cells: {} };
    const validated = validateRow(row, FIELDS);
    expect(validated.cells.name?.error?.code).toBe("required");
    expect(validated.cells.category?.error?.code).toBe("required");
    expect(rowIsValid(validated)).toBe(false);
  });

  it("on update rows only flags mapped-but-blank required fields", () => {
    const row: ImportRow = {
      key: "r",
      action: "update",
      targetItemId: "x",
      runState: "pending",
      cells: { name: { raw: "", value: "" } },
    };
    const validated = validateRow(row, FIELDS);
    expect(validated.cells.name?.error?.code).toBe("required");
    expect(validated.cells.category).toBeUndefined();
  });

  it("enforces allowedFileTypes", () => {
    const row: ImportRow = {
      key: "r",
      action: "create",
      runState: "pending",
      cells: {
        name: { raw: "n", value: "n" },
        category: { raw: "a", value: "a" },
        doc_s3key: { raw: "x.txt", value: "x.txt", file: new File(["x"], "x.txt") },
      },
    };
    expect(validateRow(row, FIELDS).cells.doc_s3key.error?.code).toBe("fileType");
  });

  it("clears a stale required error once the value is filled", () => {
    const row: ImportRow = {
      key: "r",
      action: "create",
      runState: "pending",
      cells: {
        name: { raw: "n", value: "n", error: { code: "required", params: { field: "name" } } },
        category: { raw: "a", value: "a" },
      },
    };
    expect(validateRow(row, FIELDS).cells.name.error).toBeUndefined();
  });
});

describe("buildCreateInput", () => {
  it("mirrors the single-item dialog shape with source import", () => {
    const row: ImportRow = {
      key: "r",
      action: "create",
      runState: "pending",
      cells: {
        id: { raw: "ignored", value: "ignored" },
        name: { raw: "Alpha", value: "Alpha" },
        description: { raw: "desc", value: "desc" },
        tags: { raw: "x,y", value: "x,y" },
        category: { raw: "a", value: "a" },
      },
    };
    expect(buildCreateInput(row, FIELDS)).toEqual({
      name: "Alpha",
      description: "desc",
      external_id: null,
      tags: "x,y",
      source: "import",
      textlength: 4,
      category: "a",
    });
  });
});

describe("buildUpdateInput", () => {
  it("sends only present cells, never id or source", () => {
    const row: ImportRow = {
      key: "r",
      action: "update",
      targetItemId: "item-1",
      runState: "pending",
      cells: {
        id: { raw: "item-1", value: "item-1" },
        description: { raw: "new", value: "new" },
        category: { raw: "b", value: "b" },
      },
    };
    expect(buildUpdateInput(row, FIELDS)).toEqual({
      description: "new",
      textlength: 3,
      category: "b",
    });
  });

  it("a mapped blank cell clears the field (null / empty string)", () => {
    const row: ImportRow = {
      key: "r",
      action: "update",
      targetItemId: "item-1",
      runState: "pending",
      cells: { doc_s3key: { raw: "", value: null } },
    };
    expect(buildUpdateInput(row, FIELDS)).toEqual({ doc_s3key: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/import/rows.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// lib/import/rows.ts
import { coerceValue } from "@/lib/import/coerce";
import type { FileIndex } from "@/lib/import/match-files";
import { findFile } from "@/lib/import/match-files";
import type { ColumnMapping } from "@/lib/import/map-columns";
import type { ParsedCsv } from "@/lib/import/parse-csv";
import type { ImportCell, ImportField, ImportRow } from "@/lib/import/types";

function stripExtension(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i > 0 ? filename.slice(0, i) : filename;
}

/** One create-row per dropped file, file landing in `targetFieldName`. */
export function rowsFromFiles(
  files: File[],
  targetFieldName: string,
  keyPrefix = "file",
): ImportRow[] {
  return files.map((file, i) => ({
    key: `${keyPrefix}-${i}-${file.name}`,
    action: "create" as const,
    runState: "pending" as const,
    cells: {
      name: { raw: stripExtension(file.name), value: stripExtension(file.name) },
      [targetFieldName]: { raw: file.name, value: file.name, file },
    },
  }));
}

/** One row per CSV data row; only mapped columns become cells. */
export function rowsFromCsv(
  parsed: ParsedCsv,
  mapping: ColumnMapping[],
  fields: ImportField[],
  fileIndex: FileIndex,
): ImportRow[] {
  const byName = new Map(fields.map((f) => [f.name, f]));
  return parsed.rows.map((raw, i) => {
    const cells: Record<string, ImportCell> = {};
    for (const m of mapping) {
      if (!m.fieldName) continue;
      const field = byName.get(m.fieldName);
      if (!field) continue;
      const cell = coerceValue(field, raw[m.index] ?? "");
      if (field.type === "file" && typeof cell.value === "string" && cell.value !== "") {
        const file = findFile(fileIndex, cell.value);
        if (file) cell.file = file;
        else cell.error = { code: "fileMissing", params: { name: cell.value } };
      }
      cells[m.fieldName] = cell;
    }
    return { key: `csv-${i}`, action: "create" as const, runState: "pending" as const, cells };
  });
}

const isEmpty = (cell: ImportCell | undefined) =>
  !cell || ((cell.value === null || cell.value === "") && !cell.file);

/** Required + allowedFileTypes checks; returns a new row, cells replaced. */
export function validateRow(row: ImportRow, fields: ImportField[]): ImportRow {
  const cells = { ...row.cells };
  for (const f of fields) {
    const cell = cells[f.name];
    if (f.required) {
      const mustHaveValue = row.action === "create" || cell !== undefined;
      if (mustHaveValue && isEmpty(cell)) {
        cells[f.name] = {
          raw: cell?.raw ?? "",
          value: cell?.value ?? null,
          file: cell?.file,
          error: { code: "required", params: { field: f.label } },
        };
        continue;
      }
      if (cell?.error?.code === "required" && !isEmpty(cell)) {
        cells[f.name] = { raw: cell.raw, value: cell.value, file: cell.file };
      }
    }
    if (f.type === "file" && f.allowedFileTypes?.length && cell?.file) {
      const ok = f.allowedFileTypes.some((ext) =>
        cell.file!.name.toLowerCase().endsWith(ext.toLowerCase()),
      );
      if (!ok) {
        cells[f.name] = {
          ...cell,
          error: { code: "fileType", params: { values: f.allowedFileTypes.join(", ") } },
        };
      }
    }
  }
  return { ...row, cells };
}

export function rowIsValid(row: ImportRow): boolean {
  if (row.error) return false;
  return Object.values(row.cells).every((c) => !c.error);
}

/** Create-mutation input, mirroring new-item-dialog.tsx but source "import". */
export function buildCreateInput(row: ImportRow, fields: ImportField[]): Record<string, unknown> {
  const description =
    typeof row.cells.description?.value === "string" ? row.cells.description.value : "";
  const input: Record<string, unknown> = {
    name: row.cells.name?.value ?? "",
    description,
    external_id: (row.cells.external_id?.value as string) || null,
    tags: typeof row.cells.tags?.value === "string" ? row.cells.tags.value : "",
    source: "import",
    textlength: description.length,
  };
  for (const f of fields) {
    if (f.core) continue;
    const cell = row.cells[f.name];
    if (cell === undefined) continue;
    input[f.name] = cell.value;
  }
  return input;
}

/** Partial update input: only mapped/filled cells; id and source never sent. */
export function buildUpdateInput(row: ImportRow, fields: ImportField[]): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.name === "id") continue;
    const cell = row.cells[f.name];
    if (cell === undefined) continue;
    input[f.name] = cell.value;
  }
  if (typeof input.description === "string") {
    input.textlength = input.description.length;
  }
  return input;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/import/rows.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/import/rows.ts lib/import/rows.test.ts
git commit -m "feat(import): row building, validation and mutation input builders"
```

---

### Task 8: Create/update classification

**Files:**
- Create: `lib/import/resolve-targets.ts`
- Test: `lib/import/resolve-targets.test.ts`

**Interfaces:**
- Consumes: `ImportRow`.
- Produces:
  - `ExistingRefs { byExternalId: Map<string, string>; knownIds: Set<string> }`
  - `classifyRows(rows: ImportRow[], existing: ExistingRefs): ImportRow[]` — pure; priority `id` > `external_id` > create; duplicate keys and unknown ids become row errors (`duplicateKey`, `idNotFound`). The server lookup that fills `ExistingRefs` happens in the wizard (Task 13/15) via `GET_ITEMS_BY_IDS` / `GET_ITEMS_BY_EXTERNAL_IDS`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/import/resolve-targets.test.ts
import { describe, expect, it } from "vitest";

import { classifyRows } from "@/lib/import/resolve-targets";
import type { ImportRow } from "@/lib/import/types";

const row = (key: string, cells: ImportRow["cells"]): ImportRow => ({
  key,
  action: "create",
  runState: "pending",
  cells,
});

const existing = {
  byExternalId: new Map([["ext-1", "item-1"]]),
  knownIds: new Set(["item-9"]),
};

describe("classifyRows", () => {
  it("id column wins and must exist", () => {
    const rows = classifyRows(
      [
        row("a", { id: { raw: "item-9", value: "item-9" } }),
        row("b", { id: { raw: "nope", value: "nope" } }),
      ],
      existing,
    );
    expect(rows[0].action).toBe("update");
    expect(rows[0].targetItemId).toBe("item-9");
    expect(rows[1].error?.code).toBe("idNotFound");
  });

  it("matching external_id updates, unknown external_id creates", () => {
    const rows = classifyRows(
      [
        row("a", { external_id: { raw: "ext-1", value: "ext-1" } }),
        row("b", { external_id: { raw: "new-ext", value: "new-ext" } }),
      ],
      existing,
    );
    expect(rows[0].action).toBe("update");
    expect(rows[0].targetItemId).toBe("item-1");
    expect(rows[1].action).toBe("create");
    expect(rows[1].error).toBeUndefined();
  });

  it("duplicate keys within the batch error on later rows", () => {
    const rows = classifyRows(
      [
        row("a", { external_id: { raw: "x", value: "x" } }),
        row("b", { external_id: { raw: "x", value: "x" } }),
        row("c", { id: { raw: "item-9", value: "item-9" } }),
        row("d", { id: { raw: "item-9", value: "item-9" } }),
      ],
      existing,
    );
    expect(rows[0].error).toBeUndefined();
    expect(rows[1].error?.code).toBe("duplicateKey");
    expect(rows[1].error?.params?.field).toBe("external_id");
    expect(rows[3].error?.code).toBe("duplicateKey");
  });

  it("re-running clears stale classification", () => {
    const stale: ImportRow = {
      ...row("a", {}),
      action: "update",
      targetItemId: "old",
      error: { code: "idNotFound" },
    };
    const [reclassified] = classifyRows([stale], existing);
    expect(reclassified.action).toBe("create");
    expect(reclassified.targetItemId).toBeUndefined();
    expect(reclassified.error).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/import/resolve-targets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// lib/import/resolve-targets.ts
import type { ImportRow } from "@/lib/import/types";

export interface ExistingRefs {
  /** external_id → item id, from the server lookup. */
  byExternalId: Map<string, string>;
  /** Item ids confirmed to exist. */
  knownIds: Set<string>;
}

/**
 * Pure classification: id column > external_id match > create. Always resets
 * previous classification so it can safely re-run after grid edits.
 */
export function classifyRows(rows: ImportRow[], existing: ExistingRefs): ImportRow[] {
  const seenIds = new Set<string>();
  const seenExternal = new Set<string>();
  return rows.map((row) => {
    const next: ImportRow = { ...row, action: "create", targetItemId: undefined, error: undefined };
    const id = typeof row.cells.id?.value === "string" ? row.cells.id.value : "";
    const ext =
      typeof row.cells.external_id?.value === "string" ? row.cells.external_id.value : "";
    if (id) {
      if (seenIds.has(id)) {
        return { ...next, error: { code: "duplicateKey", params: { field: "id" } } };
      }
      seenIds.add(id);
      if (!existing.knownIds.has(id)) return { ...next, error: { code: "idNotFound" } };
      return { ...next, action: "update", targetItemId: id };
    }
    if (ext) {
      if (seenExternal.has(ext)) {
        return { ...next, error: { code: "duplicateKey", params: { field: "external_id" } } };
      }
      seenExternal.add(ext);
      const target = existing.byExternalId.get(ext);
      if (target) return { ...next, action: "update", targetItemId: target };
    }
    return next;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/import/resolve-targets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/import/resolve-targets.ts lib/import/resolve-targets.test.ts
git commit -m "feat(import): create/update classification with duplicate detection"
```

---

### Task 9: CSV template and error report

**Files:**
- Create: `lib/import/template.ts`
- Test: `lib/import/template.test.ts`

**Interfaces:**
- Consumes: `ImportField`, `ImportRow`.
- Produces:
  - `buildCsvTemplate(fields: ImportField[]): string` — one header row of field labels
  - `buildErrorReportCsv(rows: ImportRow[], fields: ImportField[], errorFor: (row: ImportRow) => string): string` — failed/errored rows with raw values + trailing `error` column (translated message injected by the caller)

- [ ] **Step 1: Write the failing test**

```ts
// lib/import/template.test.ts
import { describe, expect, it } from "vitest";

import { buildCsvTemplate, buildErrorReportCsv } from "@/lib/import/template";
import type { ImportField, ImportRow } from "@/lib/import/types";

const FIELDS: ImportField[] = [
  { name: "id", label: "id", type: "text", required: false, core: true },
  { name: "name", label: "name", type: "shortText", required: true, core: true },
  { name: "doc_s3key", label: "doc", type: "file", required: false, core: false },
];

describe("buildCsvTemplate", () => {
  it("emits one header row using labels", () => {
    expect(buildCsvTemplate(FIELDS)).toBe("id,name,doc\n");
  });

  it("escapes labels containing commas or quotes", () => {
    const fields = [{ name: "x", label: 'weird, "label"', type: "text", required: false, core: false }];
    expect(buildCsvTemplate(fields)).toBe('"weird, ""label"""\n');
  });
});

describe("buildErrorReportCsv", () => {
  const rows: ImportRow[] = [
    { key: "ok", action: "create", runState: "done", cells: { name: { raw: "fine", value: "fine" } } },
    {
      key: "bad",
      action: "create",
      runState: "failed",
      runError: "boom",
      cells: { name: { raw: "Broken, Inc.", value: "Broken, Inc." } },
    },
  ];

  it("includes only failed/errored rows, raw values, and the error column", () => {
    const csv = buildErrorReportCsv(rows, FIELDS, (r) => r.runError ?? "invalid");
    expect(csv).toBe('id,name,doc,error\n,"Broken, Inc.",,boom\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/import/template.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// lib/import/template.ts
import type { ImportField, ImportRow } from "@/lib/import/types";

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Header-only CSV template using human labels (mapping matches labels too). */
export function buildCsvTemplate(fields: ImportField[]): string {
  return fields.map((f) => csvEscape(f.label)).join(",") + "\n";
}

/**
 * Failed rows as a re-importable CSV: raw values in template column order
 * plus a trailing translated `error` column.
 */
export function buildErrorReportCsv(
  rows: ImportRow[],
  fields: ImportField[],
  errorFor: (row: ImportRow) => string,
): string {
  const failed = rows.filter(
    (r) => r.runState === "failed" || r.error || Object.values(r.cells).some((c) => c.error),
  );
  const header = [...fields.map((f) => csvEscape(f.label)), "error"].join(",");
  const lines = failed.map((row) =>
    [
      ...fields.map((f) => csvEscape(row.cells[f.name]?.raw ?? "")),
      csvEscape(errorFor(row)),
    ].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/import/template.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/import/template.ts lib/import/template.test.ts
git commit -m "feat(import): CSV template and error report generation"
```

---

### Task 10: Execution engine (pure runner)

**Files:**
- Create: `lib/import/runner.ts`
- Test: `lib/import/runner.test.ts`

**Interfaces:**
- Consumes: `rowIsValid`, `buildCreateInput`, `buildUpdateInput` from `@/lib/import/rows`; types.
- Produces:
  - `RunnerEffects { uploadFile(file: File): Promise<string>; createItem(input: Record<string, unknown>): Promise<void>; updateItem(id: string, input: Record<string, unknown>): Promise<void> }`
  - `RunOptions { concurrency?: number; isCancelled?: () => boolean; onRowState(key: string, state: RowRunState, error?: string): void }`
  - `RunSummary { created: number; updated: number; failed: number; skipped: number }`
  - `runImport(rows: ImportRow[], fields: ImportField[], effects: RunnerEffects, options: RunOptions): Promise<RunSummary>` — mutates `row.runState` and file-cell values in place (the React layer mirrors state via `onRowState`); rows already `done` or invalid are skipped, so a second call retries failures.

- [ ] **Step 1: Write the failing test**

```ts
// lib/import/runner.test.ts
import { describe, expect, it, vi } from "vitest";

import { runImport } from "@/lib/import/runner";
import type { ImportField, ImportRow } from "@/lib/import/types";

const FIELDS: ImportField[] = [
  { name: "id", label: "id", type: "text", required: false, core: true },
  { name: "external_id", label: "external_id", type: "text", required: false, core: true },
  { name: "name", label: "name", type: "shortText", required: true, core: true },
  { name: "description", label: "description", type: "longText", required: false, core: true },
  { name: "tags", label: "tags", type: "text", required: false, core: true },
  { name: "doc_s3key", label: "doc", type: "file", required: false, core: false },
];

const createRow = (key: string, name: string, file?: File): ImportRow => ({
  key,
  action: "create",
  runState: "pending",
  cells: {
    name: { raw: name, value: name },
    ...(file ? { doc_s3key: { raw: file.name, value: file.name, file } } : {}),
  },
});

const effects = () => ({
  uploadFile: vi.fn(async (file: File) => `bucket/user_1/uuid-_EXULU_${file.name}`),
  createItem: vi.fn(async () => {}),
  updateItem: vi.fn(async () => {}),
});

describe("runImport", () => {
  it("uploads file cells first and sends the s3key in the input", async () => {
    const fx = effects();
    const rows = [createRow("r1", "Alpha", new File(["x"], "a.pdf"))];
    const summary = await runImport(rows, FIELDS, fx, { onRowState: () => {} });
    expect(fx.uploadFile).toHaveBeenCalledTimes(1);
    expect(fx.createItem).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Alpha", doc_s3key: "bucket/user_1/uuid-_EXULU_a.pdf", source: "import" }),
    );
    expect(summary).toEqual({ created: 1, updated: 0, failed: 0, skipped: 0 });
    expect(rows[0].runState).toBe("done");
    expect(rows[0].cells.doc_s3key.file).toBeUndefined();
  });

  it("routes update rows to updateItem with the target id", async () => {
    const fx = effects();
    const row: ImportRow = {
      key: "u1",
      action: "update",
      targetItemId: "item-1",
      runState: "pending",
      cells: { description: { raw: "d", value: "d" } },
    };
    const summary = await runImport([row], FIELDS, fx, { onRowState: () => {} });
    expect(fx.updateItem).toHaveBeenCalledWith("item-1", { description: "d", textlength: 1 });
    expect(summary.updated).toBe(1);
  });

  it("isolates failures and reports them via onRowState", async () => {
    const fx = effects();
    fx.createItem
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const states: Array<[string, string, string | undefined]> = [];
    const rows = [createRow("r1", "A"), createRow("r2", "B")];
    const summary = await runImport(rows, FIELDS, fx, {
      concurrency: 1,
      onRowState: (key, state, error) => states.push([key, state, error]),
    });
    expect(summary.failed).toBe(1);
    expect(summary.created).toBe(1);
    expect(states).toContainEqual(["r1", "failed", "boom"]);
    expect(rows[0].runState).toBe("failed");
    expect(rows[1].runState).toBe("done");
  });

  it("skips invalid and done rows (retry semantics)", async () => {
    const fx = effects();
    const done = { ...createRow("d", "Done"), runState: "done" as const };
    const invalid: ImportRow = {
      key: "bad",
      action: "create",
      runState: "pending",
      cells: { name: { raw: "", value: "", error: { code: "required" } } },
    };
    const summary = await runImport([done, invalid, createRow("ok", "Ok")], FIELDS, fx, {
      onRowState: () => {},
    });
    expect(fx.createItem).toHaveBeenCalledTimes(1);
    expect(summary.skipped).toBe(2);
  });

  it("stops issuing new rows when cancelled", async () => {
    const fx = effects();
    let cancelled = false;
    fx.createItem.mockImplementation(async () => {
      cancelled = true;
    });
    const rows = [createRow("r1", "A"), createRow("r2", "B"), createRow("r3", "C")];
    const summary = await runImport(rows, FIELDS, fx, {
      concurrency: 1,
      isCancelled: () => cancelled,
      onRowState: () => {},
    });
    expect(summary.created).toBe(1);
    expect(rows[2].runState).toBe("pending");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/import/runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// lib/import/runner.ts
import { buildCreateInput, buildUpdateInput, rowIsValid } from "@/lib/import/rows";
import type { ImportField, ImportRow, RowRunState } from "@/lib/import/types";

export interface RunnerEffects {
  /** Uploads one file, resolves to the s3key to store in the file field. */
  uploadFile: (file: File) => Promise<string>;
  createItem: (input: Record<string, unknown>) => Promise<void>;
  updateItem: (id: string, input: Record<string, unknown>) => Promise<void>;
}

export interface RunOptions {
  concurrency?: number;
  isCancelled?: () => boolean;
  onRowState: (key: string, state: RowRunState, error?: string) => void;
}

export interface RunSummary {
  created: number;
  updated: number;
  failed: number;
  skipped: number;
}

/**
 * Client-side execution: per row upload file cells then fire the mutation.
 * Mutates row.runState and file-cell values in place; a second call skips
 * done rows, which is what "retry failed rows" relies on. A row failure
 * never halts the batch; cancel stops issuing rows, in-flight rows finish.
 */
export async function runImport(
  rows: ImportRow[],
  fields: ImportField[],
  effects: RunnerEffects,
  options: RunOptions,
): Promise<RunSummary> {
  const queue = rows.filter((r) => rowIsValid(r) && r.runState !== "done");
  const summary: RunSummary = {
    created: 0,
    updated: 0,
    failed: 0,
    skipped: rows.length - queue.length,
  };
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      if (options.isCancelled?.()) return;
      const row = queue[cursor++];
      if (!row) return;
      try {
        const fileCells = Object.values(row.cells).filter((c) => c.file);
        if (fileCells.length > 0) {
          row.runState = "uploading";
          options.onRowState(row.key, "uploading");
          for (const cell of fileCells) {
            cell.value = await effects.uploadFile(cell.file as File);
            // Uploaded — drop the File so a retry doesn't re-upload it.
            cell.file = undefined;
          }
        }
        row.runState = "saving";
        options.onRowState(row.key, "saving");
        if (row.action === "update" && row.targetItemId) {
          await effects.updateItem(row.targetItemId, buildUpdateInput(row, fields));
          summary.updated += 1;
        } else {
          await effects.createItem(buildCreateInput(row, fields));
          summary.created += 1;
        }
        row.runState = "done";
        options.onRowState(row.key, "done");
      } catch (e) {
        summary.failed += 1;
        row.runState = "failed";
        row.runError = e instanceof Error ? e.message : String(e);
        options.onRowState(row.key, "failed", row.runError);
      }
    }
  };

  const n = Math.max(1, Math.min(options.concurrency ?? 4, queue.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return summary;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/import/runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/import/runner.ts lib/import/runner.test.ts
git commit -m "feat(import): concurrency-limited execution engine with retry semantics"
```

---

### Task 11: S3 upload helper + external_id lookup query

**Files:**
- Create: `lib/import/upload.ts`
- Test: `lib/import/upload.test.ts`
- Modify: `app/(application)/data/queries.ts` (add `GET_ITEMS_BY_EXTERNAL_IDS` next to `GET_ITEMS_BY_IDS` at ~line 290)

**Interfaces:**
- Consumes: `getUris`/`getToken` from `@/lib/api/client`; `extractS3KeyFromUrl` from `@/lib/s3/extract-key`. Backend: `POST {backend}/s3/sign` with body `{ filename, type }` → `{ key, url, method: "PUT" }` (the stored key must be derived from the **url**, which carries the full `[s3prefix/]user_<id>/` prefix — the returned `key` is bare).
- Produces:
  - `uploadFileToS3(file: File): Promise<string>` — resolves to the s3key string; matches the `RunnerEffects.uploadFile` signature
  - `GET_ITEMS_BY_EXTERNAL_IDS(context: string)` gql builder returning `items { id external_id }` via `filters: [{ external_id: { in: $ids } }]`

- [ ] **Step 1: Write the failing test**

```ts
// lib/import/upload.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadFileToS3 } from "@/lib/import/upload";

vi.mock("@/lib/api/client", () => ({
  getUris: vi.fn(async () => ({ base: "https://backend.test", files: "https://backend.test" })),
  getToken: vi.fn(async () => "jwt-token"),
}));

const signedUrl =
  "https://api.s3.exulu.com/exulu/user_1/uuid-_EXULU_report.pdf?X-Amz-Signature=xyz";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadFileToS3", () => {
  it("signs, PUTs, and returns the key extracted from the signed url", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ key: "uuid-_EXULU_report.pdf", url: signedUrl, method: "PUT" })),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const key = await uploadFileToS3(new File(["x"], "report.pdf", { type: "application/pdf" }));

    expect(key).toBe("exulu/user_1/uuid-_EXULU_report.pdf");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://backend.test/s3/sign",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer jwt-token" }),
        body: JSON.stringify({ filename: "report.pdf", type: "application/pdf" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      signedUrl,
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("defaults the content type for extension-less files", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ key: "k", url: signedUrl, method: "PUT" })),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadFileToS3(new File(["x"], "README"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).type).toBe("application/octet-stream");
  });

  it("throws the backend detail on sign failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "no permission" }), { status: 403 }),
      ),
    );
    await expect(uploadFileToS3(new File(["x"], "a.pdf"))).rejects.toThrow("no permission");
  });

  it("throws on PUT failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ key: "k", url: signedUrl, method: "PUT" })),
        )
        .mockResolvedValueOnce(new Response(null, { status: 500 })),
    );
    await expect(uploadFileToS3(new File(["x"], "a.pdf"))).rejects.toThrow("Upload failed (500)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/import/upload.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the upload helper**

```ts
// lib/import/upload.ts
import { getToken, getUris } from "@/lib/api/client";
import { extractS3KeyFromUrl } from "@/lib/s3/extract-key";

/**
 * Presign-then-PUT via the backend's Uppy-compatible /s3/sign endpoint
 * (POST { filename, type } → { key, url, method }). The stored s3key MUST be
 * derived from the signed url — the response `key` lacks the user/prefix
 * segments that only appear in the url path.
 */
export async function uploadFileToS3(file: File): Promise<string> {
  const uris = await getUris();
  const token = await getToken();
  if (!token) throw new Error("No valid session token available.");
  const contentType = file.type || "application/octet-stream";

  const signRes = await fetch(`${uris.base}/s3/sign`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ filename: file.name, type: contentType }),
  });
  if (!signRes.ok) {
    const detail = await signRes
      .json()
      .then((j) => j.detail ?? signRes.statusText)
      .catch(() => signRes.statusText);
    throw new Error(detail);
  }
  const { url, method } = (await signRes.json()) as { url: string; method?: string };

  const putRes = await fetch(url, {
    method: method ?? "PUT",
    body: file,
    headers: { "Content-Type": contentType },
  });
  if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`);

  return extractS3KeyFromUrl(url);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/import/upload.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the lookup query.** In `app/(application)/data/queries.ts`, directly below the existing `GET_ITEMS_BY_IDS` builder (~line 302), add:

```ts
export const GET_ITEMS_BY_EXTERNAL_IDS = (context: string) => {
  return gql`
    query ${context}ByExternalIds($ids: [String], $limit: Int!) {
      ${context}${PAGINATION_POSTFIX}(page: 1, limit: $limit, filters: [{ external_id: { in: $ids } }]) {
        items {
          id
          external_id
        }
      }
    }
  `;
};
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add lib/import/upload.ts lib/import/upload.test.ts "app/(application)/data/queries.ts"
git commit -m "feat(import): presigned S3 upload helper and external_id lookup query"
```

---

### Task 12: i18n strings (en + de)

**Files:**
- Modify: `messages/en.json`, `messages/de.json`

**Interfaces:**
- Consumes: nothing.
- Produces: the complete `knowledge.workspace.import.*` key tree used by Tasks 13–16. Error codes from lib map to `knowledge.workspace.import.errors.<code>`.

- [ ] **Step 1: Add the English block.** In `messages/en.json`, inside `knowledge.workspace` (keys are alphabetically sorted — `import` goes between `expandEditor` and `items`), insert:

```json
"import": {
  "add": {
    "browse": "Drop files or a CSV here, or click to browse",
    "csvChip": "{name} — {count, plural, one {# row} other {# rows}}",
    "csvErrors": "CSV parsed with warnings: {errors}",
    "csvOnlyHint": "This knowledge base has no file field, so only CSV import is available.",
    "duplicateFiles": "Ignored duplicate filenames: {names}",
    "fileCount": "{count, plural, one {# file} other {# files}} ready to import",
    "fileFieldTarget": "Put dropped files into",
    "hint": "Files become new items; a CSV fills fields from columns",
    "removeCsv": "Remove CSV",
    "removeFile": "Remove {name}",
    "template": "Download CSV template"
  },
  "back": "Back",
  "cancelRun": "Cancel import",
  "close": "Close",
  "continue": "Continue",
  "description": "Add or update many items at once from files or a CSV.",
  "errors": {
    "boolean": "Use true/false, yes/no or 1/0",
    "date": "Use the YYYY-MM-DD format",
    "duplicateKey": "Duplicate {field} in this import",
    "enum": "Must be one of: {values}",
    "fileMissing": "No dropped file named \"{name}\"",
    "fileType": "Allowed file types: {values}",
    "idNotFound": "No item with this id exists",
    "json": "Not valid JSON",
    "number": "Not a number — use a dot decimal like 1.5",
    "numberAmbiguous": "Ambiguous number — use a dot decimal like 1.5",
    "required": "{field} is required",
    "uuid": "Not a valid UUID"
  },
  "map": {
    "column": "CSV column",
    "hint": "Rows with an id or a matching external_id update existing items; everything else creates new ones.",
    "ignore": "Ignore",
    "samples": "Sample values",
    "target": "Import as",
    "title": "Match CSV columns to fields"
  },
  "review": {
    "addLeftovers": "{count, plural, one {# dropped file is} other {# dropped files are}} unreferenced — add as new rows",
    "applyToAll": "Apply to all rows",
    "applyToAllValue": "Value for every row",
    "emptyCell": "—",
    "importAll": "Import {count, plural, one {# item} other {# items}}",
    "importValid": "Import {count} valid rows",
    "removeRow": "Remove row",
    "statusCreate": "Create",
    "statusError": "Error",
    "statusUpdate": "Update",
    "validCount": "{valid} of {total} rows ready"
  },
  "run": {
    "downloadReport": "Download error report",
    "progress": "Imported {done} of {total}…",
    "retryFailed": "Retry failed rows",
    "stateDone": "Done",
    "stateFailed": "Failed",
    "statePending": "Pending",
    "stateSaving": "Saving",
    "stateUploading": "Uploading",
    "summary": "{created} created, {updated} updated, {failed} failed"
  },
  "steps": {
    "add": "Add data",
    "map": "Map columns",
    "review": "Review & import"
  },
  "title": "Import items",
  "trigger": "Import"
}
```

- [ ] **Step 2: Add the German block.** In `messages/de.json`, same location (`knowledge.workspace`, alphabetical):

```json
"import": {
  "add": {
    "browse": "Dateien oder CSV hier ablegen oder klicken zum Auswählen",
    "csvChip": "{name} — {count, plural, one {# Zeile} other {# Zeilen}}",
    "csvErrors": "CSV mit Warnungen gelesen: {errors}",
    "csvOnlyHint": "Diese Wissensdatenbank hat kein Dateifeld, daher ist nur CSV-Import möglich.",
    "duplicateFiles": "Doppelte Dateinamen ignoriert: {names}",
    "fileCount": "{count, plural, one {# Datei} other {# Dateien}} bereit zum Import",
    "fileFieldTarget": "Abgelegte Dateien speichern in",
    "hint": "Dateien werden zu neuen Einträgen; eine CSV füllt Felder aus Spalten",
    "removeCsv": "CSV entfernen",
    "removeFile": "{name} entfernen",
    "template": "CSV-Vorlage herunterladen"
  },
  "back": "Zurück",
  "cancelRun": "Import abbrechen",
  "close": "Schließen",
  "continue": "Weiter",
  "description": "Viele Einträge auf einmal aus Dateien oder einer CSV hinzufügen oder aktualisieren.",
  "errors": {
    "boolean": "true/false, ja/nein oder 1/0 verwenden",
    "date": "Format JJJJ-MM-TT verwenden",
    "duplicateKey": "Doppelter Wert für {field} in diesem Import",
    "enum": "Muss einer der folgenden Werte sein: {values}",
    "fileMissing": "Keine abgelegte Datei namens \"{name}\"",
    "fileType": "Erlaubte Dateitypen: {values}",
    "idNotFound": "Kein Eintrag mit dieser ID vorhanden",
    "json": "Kein gültiges JSON",
    "number": "Keine Zahl — Dezimalpunkt wie 1.5 verwenden",
    "numberAmbiguous": "Mehrdeutige Zahl — Dezimalpunkt wie 1.5 verwenden",
    "required": "{field} ist erforderlich",
    "uuid": "Keine gültige UUID"
  },
  "map": {
    "column": "CSV-Spalte",
    "hint": "Zeilen mit einer id oder passender external_id aktualisieren bestehende Einträge; alle anderen erstellen neue.",
    "ignore": "Ignorieren",
    "samples": "Beispielwerte",
    "target": "Importieren als",
    "title": "CSV-Spalten den Feldern zuordnen"
  },
  "review": {
    "addLeftovers": "{count, plural, one {# abgelegte Datei ist} other {# abgelegte Dateien sind}} nicht referenziert — als neue Zeilen hinzufügen",
    "applyToAll": "Auf alle Zeilen anwenden",
    "applyToAllValue": "Wert für alle Zeilen",
    "emptyCell": "—",
    "importAll": "{count, plural, one {# Eintrag} other {# Einträge}} importieren",
    "importValid": "{count} gültige Zeilen importieren",
    "removeRow": "Zeile entfernen",
    "statusCreate": "Neu",
    "statusError": "Fehler",
    "statusUpdate": "Update",
    "validCount": "{valid} von {total} Zeilen bereit"
  },
  "run": {
    "downloadReport": "Fehlerbericht herunterladen",
    "progress": "{done} von {total} importiert…",
    "retryFailed": "Fehlgeschlagene Zeilen erneut versuchen",
    "stateDone": "Fertig",
    "stateFailed": "Fehlgeschlagen",
    "statePending": "Wartet",
    "stateSaving": "Speichert",
    "stateUploading": "Lädt hoch",
    "summary": "{created} erstellt, {updated} aktualisiert, {failed} fehlgeschlagen"
  },
  "steps": {
    "add": "Daten hinzufügen",
    "map": "Spalten zuordnen",
    "review": "Prüfen & importieren"
  },
  "title": "Einträge importieren",
  "trigger": "Importieren"
}
```

- [ ] **Step 3: Verify parity**

Run: `npm run check-messages`
Expected: PASS (en/de key parity).

- [ ] **Step 4: Commit**

```bash
git add messages/en.json messages/de.json
git commit -m "feat(import): i18n strings for the bulk import wizard (en/de)"
```

---

### Task 13: Wizard steps 1–2 — Add data & Map columns components

**Files:**
- Create: `app/(application)/data/[ctx]/components/import/step-add-data.tsx`
- Create: `app/(application)/data/[ctx]/components/import/step-map-columns.tsx`

**Interfaces:**
- Consumes: `Dropzone` (`@/components/primitives/dropzone` — `onFiles`, required `label`, `multiple`), `parseCsvFile`/`ParsedCsv`, `buildCsvTemplate`, `ColumnMapping`, `ImportField`, `fileFields`, shadcn `Select`/`Button`, `useTranslations("knowledge")`.
- Produces (consumed by the wizard host in Task 15):
  - `StepAddData` props: `{ contextId: string; fields: ImportField[]; files: File[]; csv: { name: string; parsed: ParsedCsv } | null; fileFieldTarget: string | null; onFilesAdded(files: File[]): void; onRemoveFile(index: number): void; onCsvChange(csv: { name: string; parsed: ParsedCsv } | null): void; onFileFieldTargetChange(name: string): void }`
  - `StepMapColumns` props: `{ csv: { name: string; parsed: ParsedCsv }; mapping: ColumnMapping[]; fields: ImportField[]; onMappingChange(mapping: ColumnMapping[]): void }`
  - Both are presentation-only; all state lives in the wizard host.

- [ ] **Step 1: Create `step-add-data.tsx`**

```tsx
"use client";

import { Download, FileSpreadsheet, X } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Dropzone } from "@/components/primitives/dropzone";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fileFields } from "@/lib/import/fields";
import type { ParsedCsv } from "@/lib/import/parse-csv";
import { parseCsvFile } from "@/lib/import/parse-csv";
import { buildCsvTemplate } from "@/lib/import/template";
import type { ImportField } from "@/lib/import/types";

export interface StepAddDataProps {
  contextId: string;
  fields: ImportField[];
  files: File[];
  csv: { name: string; parsed: ParsedCsv } | null;
  fileFieldTarget: string | null;
  onFilesAdded: (files: File[]) => void;
  onRemoveFile: (index: number) => void;
  onCsvChange: (csv: { name: string; parsed: ParsedCsv } | null) => void;
  onFileFieldTargetChange: (name: string) => void;
}

export function StepAddData({
  contextId,
  fields,
  files,
  csv,
  fileFieldTarget,
  onFilesAdded,
  onRemoveFile,
  onCsvChange,
  onFileFieldTargetChange,
}: StepAddDataProps) {
  const t = useTranslations("knowledge");
  const fileTargets = fileFields(fields);

  const handleDrop = async (dropped: File[]) => {
    const csvFile = dropped.find((f) => f.name.toLowerCase().endsWith(".csv"));
    const dataFiles = dropped.filter((f) => !f.name.toLowerCase().endsWith(".csv"));
    if (csvFile) {
      onCsvChange({ name: csvFile.name, parsed: await parseCsvFile(csvFile) });
    }
    if (dataFiles.length > 0) onFilesAdded(dataFiles);
  };

  const downloadTemplate = () => {
    const blob = new Blob([buildCsvTemplate(fields)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${contextId}-import-template.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-4">
      <Dropzone
        multiple
        onFiles={(dropped) => void handleDrop(dropped)}
        label={t("workspace.import.add.browse")}
        hint={t("workspace.import.add.hint")}
      />

      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={downloadTemplate}>
          <Download aria-hidden="true" className="mr-2 size-4" />
          {t("workspace.import.add.template")}
        </Button>
        {fileTargets.length === 0 && files.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t("workspace.import.add.csvOnlyHint")}
          </p>
        )}
      </div>

      {csv && (
        <div className="flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm">
          <FileSpreadsheet aria-hidden="true" className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            {t("workspace.import.add.csvChip", {
              name: csv.name,
              count: csv.parsed.rows.length,
            })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onCsvChange(null)}
          >
            <X aria-hidden="true" className="size-4" />
            <span className="sr-only">{t("workspace.import.add.removeCsv")}</span>
          </Button>
        </div>
      )}
      {csv && csv.parsed.errors.length > 0 && (
        <p className="text-sm text-destructive">
          {t("workspace.import.add.csvErrors", { errors: csv.parsed.errors.join("; ") })}
        </p>
      )}

      {files.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">
            {t("workspace.import.add.fileCount", { count: files.length })}
          </p>
          <ul className="max-h-48 overflow-y-auto rounded-md border border-input">
            {files.map((file, i) => (
              <li
                key={`${file.name}-${i}`}
                className="flex items-center gap-2 border-b border-input px-3 py-1.5 text-sm last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => onRemoveFile(i)}
                >
                  <X aria-hidden="true" className="size-4" />
                  <span className="sr-only">
                    {t("workspace.import.add.removeFile", { name: file.name })}
                  </span>
                </Button>
              </li>
            ))}
          </ul>

          {fileTargets.length > 1 && (
            <div className="flex items-center gap-2">
              <Label htmlFor="import-file-target" className="text-sm">
                {t("workspace.import.add.fileFieldTarget")}
              </Label>
              <Select
                value={fileFieldTarget ?? undefined}
                onValueChange={onFileFieldTargetChange}
              >
                <SelectTrigger id="import-file-target" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {fileTargets.map((f) => (
                    <SelectItem key={f.name} value={f.name}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `step-map-columns.tsx`**

```tsx
"use client";

import { useTranslations } from "next-intl";
import * as React from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ColumnMapping } from "@/lib/import/map-columns";
import type { ParsedCsv } from "@/lib/import/parse-csv";
import type { ImportField } from "@/lib/import/types";

const IGNORE = "__ignore__";

export interface StepMapColumnsProps {
  csv: { name: string; parsed: ParsedCsv };
  mapping: ColumnMapping[];
  fields: ImportField[];
  onMappingChange: (mapping: ColumnMapping[]) => void;
}

export function StepMapColumns({ csv, mapping, fields, onMappingChange }: StepMapColumnsProps) {
  const t = useTranslations("knowledge");

  const usedFields = new Set(mapping.map((m) => m.fieldName).filter(Boolean));
  const samplesFor = (index: number) =>
    csv.parsed.rows
      .slice(0, 2)
      .map((r) => r[index])
      .filter((v) => v && v.trim() !== "")
      .join(", ");

  const setTarget = (index: number, fieldName: string) => {
    onMappingChange(
      mapping.map((m) =>
        m.index === index ? { ...m, fieldName: fieldName === IGNORE ? null : fieldName } : m,
      ),
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t("workspace.import.map.hint")}</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("workspace.import.map.column")}</TableHead>
            <TableHead>{t("workspace.import.map.samples")}</TableHead>
            <TableHead>{t("workspace.import.map.target")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {mapping.map((m) => (
            <TableRow key={m.index}>
              <TableCell className="font-medium">{m.header}</TableCell>
              <TableCell className="max-w-48 truncate text-muted-foreground">
                {samplesFor(m.index)}
              </TableCell>
              <TableCell>
                <Select value={m.fieldName ?? IGNORE} onValueChange={(v) => setTarget(m.index, v)}>
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={IGNORE}>{t("workspace.import.map.ignore")}</SelectItem>
                    {fields.map((f) => (
                      <SelectItem
                        key={f.name}
                        value={f.name}
                        disabled={usedFields.has(f.name) && m.fieldName !== f.name}
                      >
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: pass. (No component test infra exists in this repo — UI is covered by the type/lint gates here and the UAT pass in Task 17.)

- [ ] **Step 4: Commit**

```bash
git add "app/(application)/data/[ctx]/components/import/step-add-data.tsx" "app/(application)/data/[ctx]/components/import/step-map-columns.tsx"
git commit -m "feat(import): add-data and map-columns wizard steps"
```

---

### Task 14: Wizard step 3 — Review grid

**Files:**
- Create: `app/(application)/data/[ctx]/components/import/step-review-grid.tsx`

**Interfaces:**
- Consumes: `@tanstack/react-table` (`useReactTable`, `getCoreRowModel`, `flexRender`, `ColumnDef`), `ImportRow`/`ImportField`/`CellError`/`RowRunState`, shadcn `Table`/`Input`/`Select`/`Button`, `cn`.
- Produces: `StepReviewGrid` props:
  - `{ fields: ImportField[]; displayFields: ImportField[]; rows: ImportRow[]; running: boolean; rowStates: Record<string, { state: RowRunState; error?: string }>; onCellChange(rowKey: string, fieldName: string, raw: string): void; onKeyCellBlur(): void; onApplyToAll(fieldName: string, raw: string): void; onRemoveRow(rowKey: string): void }`
  - Exports `translateCellError(t: (key: string, params?: Record<string, string>) => string, error: CellError): string` for reuse by the wizard's error report.

- [ ] **Step 1: Create `step-review-grid.tsx`**

```tsx
"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { Paperclip, X } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CellError, ImportField, ImportRow, RowRunState } from "@/lib/import/types";
import { cn } from "@/lib/utils";

const UNSET = "__unset__";

/** Resolve a lib-level error code to the translated message. */
export function translateCellError(
  t: (key: string, params?: Record<string, string>) => string,
  error: CellError,
): string {
  return t(`workspace.import.errors.${error.code}`, error.params);
}

export interface StepReviewGridProps {
  fields: ImportField[];
  displayFields: ImportField[];
  rows: ImportRow[];
  running: boolean;
  rowStates: Record<string, { state: RowRunState; error?: string }>;
  onCellChange: (rowKey: string, fieldName: string, raw: string) => void;
  onKeyCellBlur: () => void;
  onApplyToAll: (fieldName: string, raw: string) => void;
  onRemoveRow: (rowKey: string) => void;
}

function StatusBadge({ label, tone, title }: { label: string; tone: "create" | "update" | "error" | "muted" | "done" | "failed"; title?: string }) {
  const classes = {
    create: "bg-secondary text-secondary-foreground",
    update: "border border-input text-foreground",
    error: "bg-destructive/10 text-destructive",
    muted: "bg-muted text-muted-foreground",
    done: "bg-secondary text-secondary-foreground",
    failed: "bg-destructive/10 text-destructive",
  }[tone];
  return (
    <span
      title={title}
      className={cn("inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", classes)}
    >
      {label}
    </span>
  );
}

function CellEditor({
  field,
  row,
  disabled,
  onCellChange,
  onKeyCellBlur,
  t,
}: {
  field: ImportField;
  row: ImportRow;
  disabled: boolean;
  onCellChange: StepReviewGridProps["onCellChange"];
  onKeyCellBlur: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const cell = row.cells[field.name];
  const errorTitle = cell?.error ? translateCellError(t, cell.error) : undefined;
  const isKeyField = field.name === "id" || field.name === "external_id";

  if (field.type === "file") {
    if (cell?.file || (typeof cell?.value === "string" && cell.value !== "")) {
      return (
        <span
          title={errorTitle}
          className={cn(
            "inline-flex max-w-44 items-center gap-1 truncate rounded-md border border-input px-2 py-0.5 text-xs",
            cell?.error && "border-destructive text-destructive",
          )}
        >
          <Paperclip aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{cell?.file?.name ?? String(cell?.value)}</span>
        </span>
      );
    }
    return <span className="text-muted-foreground">{t("workspace.import.review.emptyCell")}</span>;
  }

  if (field.type === "boolean") {
    const current = cell?.value === true ? "true" : cell?.value === false ? "false" : UNSET;
    return (
      <Select
        disabled={disabled}
        value={current}
        onValueChange={(v) => onCellChange(row.key, field.name, v === UNSET ? "" : v)}
      >
        <SelectTrigger className={cn("h-8 w-24", cell?.error && "border-destructive")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET}>{t("workspace.import.review.emptyCell")}</SelectItem>
          <SelectItem value="true">true</SelectItem>
          <SelectItem value="false">false</SelectItem>
        </SelectContent>
      </Select>
    );
  }

  if (field.type === "enum") {
    const current = typeof cell?.value === "string" && cell.value !== "" ? cell.value : UNSET;
    return (
      <Select
        disabled={disabled}
        value={current}
        onValueChange={(v) => onCellChange(row.key, field.name, v === UNSET ? "" : v)}
      >
        <SelectTrigger
          title={errorTitle}
          className={cn("h-8 w-36", cell?.error && "border-destructive")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET}>{t("workspace.import.review.emptyCell")}</SelectItem>
          {(field.enumValues ?? []).map((v) => (
            <SelectItem key={v} value={v}>
              {v}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <Input
      disabled={disabled}
      value={cell?.raw ?? ""}
      onChange={(e) => onCellChange(row.key, field.name, e.target.value)}
      onBlur={isKeyField ? onKeyCellBlur : undefined}
      title={errorTitle}
      aria-invalid={Boolean(cell?.error)}
      className={cn("h-8 min-w-28 text-sm", cell?.error && "border-destructive")}
      type={field.type === "number" ? "number" : "text"}
    />
  );
}

export function StepReviewGrid({
  fields,
  displayFields,
  rows,
  running,
  rowStates,
  onCellChange,
  onKeyCellBlur,
  onApplyToAll,
  onRemoveRow,
}: StepReviewGridProps) {
  const t = useTranslations("knowledge");
  const [applyField, setApplyField] = React.useState<string>("");
  const [applyValue, setApplyValue] = React.useState<string>("");

  const statusFor = (row: ImportRow): React.ReactNode => {
    const runState = rowStates[row.key]?.state ?? row.runState;
    if (running || runState === "done" || runState === "failed") {
      const tone = runState === "done" ? "done" : runState === "failed" ? "failed" : "muted";
      const labelKey = {
        pending: "statePending",
        uploading: "stateUploading",
        saving: "stateSaving",
        done: "stateDone",
        failed: "stateFailed",
      }[runState];
      return (
        <StatusBadge
          label={t(`workspace.import.run.${labelKey}`)}
          tone={tone}
          title={rowStates[row.key]?.error ?? row.runError}
        />
      );
    }
    if (row.error) {
      return (
        <StatusBadge
          label={t("workspace.import.review.statusError")}
          tone="error"
          title={translateCellError(t, row.error)}
        />
      );
    }
    return row.action === "update" ? (
      <StatusBadge label={t("workspace.import.review.statusUpdate")} tone="update" />
    ) : (
      <StatusBadge label={t("workspace.import.review.statusCreate")} tone="create" />
    );
  };

  const columns = React.useMemo<ColumnDef<ImportRow>[]>(() => {
    const status: ColumnDef<ImportRow> = {
      id: "__status",
      header: "",
      cell: ({ row }) => statusFor(row.original),
    };
    const fieldColumns = displayFields.map<ColumnDef<ImportRow>>((field) => ({
      id: field.name,
      header: field.label + (field.required ? " *" : ""),
      cell: ({ row }) => (
        <CellEditor
          field={field}
          row={row.original}
          disabled={running}
          onCellChange={onCellChange}
          onKeyCellBlur={onKeyCellBlur}
          t={t}
        />
      ),
    }));
    const remove: ColumnDef<ImportRow> = {
      id: "__remove",
      header: "",
      cell: ({ row }) => (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={running}
          onClick={() => onRemoveRow(row.original.key)}
        >
          <X aria-hidden="true" className="size-4" />
          <span className="sr-only">{t("workspace.import.review.removeRow")}</span>
        </Button>
      ),
    };
    return [status, ...fieldColumns, remove];
    // statusFor closes over rows/rowStates/running — recompute with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayFields, running, rowStates, onCellChange, onKeyCellBlur, onRemoveRow, t]);

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.key,
  });

  const applicableFields = displayFields.filter(
    (f) => f.type !== "file" && f.name !== "id" && f.name !== "external_id",
  );

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {!running && applicableFields.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={applyField || undefined} onValueChange={setApplyField}>
            <SelectTrigger className="h-8 w-44">
              <SelectValue placeholder={t("workspace.import.review.applyToAll")} />
            </SelectTrigger>
            <SelectContent>
              {applicableFields.map((f) => (
                <SelectItem key={f.name} value={f.name}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={applyValue}
            onChange={(e) => setApplyValue(e.target.value)}
            placeholder={t("workspace.import.review.applyToAllValue")}
            className="h-8 w-52 text-sm"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!applyField}
            onClick={() => onApplyToAll(applyField, applyValue)}
          >
            {t("workspace.import.review.applyToAll")}
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-input">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className="whitespace-nowrap">
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className="py-1.5">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add "app/(application)/data/[ctx]/components/import/step-review-grid.tsx"
git commit -m "feat(import): editable review grid with status badges and apply-to-all"
```

---

### Task 15: Runner hook + wizard host dialog

**Files:**
- Create: `app/(application)/data/[ctx]/components/import/use-import-runner.ts`
- Create: `app/(application)/data/[ctx]/components/import/import-wizard-dialog.tsx`

**Interfaces:**
- Consumes: everything from Tasks 3–14; `CREATE_ITEM`, `UPDATE_ITEM`, `GET_ITEMS_BY_IDS`, `GET_ITEMS_BY_EXTERNAL_IDS`, `PAGINATION_POSTFIX` from `../../../queries` (route-local GraphQL file — note the extra `../` vs. sibling components because these live one directory deeper, in `components/import/`); Apollo `useApolloClient`.
- Produces:
  - `useImportRunner(contextId: string, fields: ImportField[]): { phase: "edit" | "running" | "done"; rowStates: Record<string, { state: RowRunState; error?: string }>; summary: RunSummary | null; doneCount: number; run(rows: ImportRow[]): Promise<void>; cancel(): void; reset(): void }`
  - `ImportWizardDialog` props: `{ open: boolean; onOpenChange(open: boolean): void; context: Context }` — mounted by WorkspaceShell (Task 16).

- [ ] **Step 1: Create `use-import-runner.ts`**

```ts
"use client";

import { useApolloClient } from "@apollo/client";
import * as React from "react";

import { runImport } from "@/lib/import/runner";
import type { RunSummary } from "@/lib/import/runner";
import type { ImportField, ImportRow, RowRunState } from "@/lib/import/types";
import { uploadFileToS3 } from "@/lib/import/upload";

import { CREATE_ITEM, UPDATE_ITEM } from "../../../queries";

export type ImportPhase = "edit" | "running" | "done";

export function useImportRunner(contextId: string, fields: ImportField[]) {
  const client = useApolloClient();
  const [phase, setPhase] = React.useState<ImportPhase>("edit");
  const [rowStates, setRowStates] = React.useState<
    Record<string, { state: RowRunState; error?: string }>
  >({});
  const [summary, setSummary] = React.useState<RunSummary | null>(null);
  const cancelRef = React.useRef(false);

  const run = React.useCallback(
    async (rows: ImportRow[]) => {
      cancelRef.current = false;
      setPhase("running");
      setSummary(null);
      const result = await runImport(
        rows,
        fields,
        {
          uploadFile: uploadFileToS3,
          createItem: async (input) => {
            await client.mutate({
              mutation: CREATE_ITEM(contextId, []),
              variables: { input },
            });
          },
          updateItem: async (id, input) => {
            await client.mutate({
              mutation: UPDATE_ITEM(contextId),
              variables: { id, input },
            });
          },
        },
        {
          concurrency: 4,
          isCancelled: () => cancelRef.current,
          onRowState: (key, state, error) =>
            setRowStates((prev) => ({ ...prev, [key]: { state, error } })),
        },
      );
      setSummary(result);
      setPhase("done");
      try {
        // Refresh the (dynamic per-context) items list queries.
        await client.refetchQueries({ include: "active" });
      } catch {
        // List refresh is best-effort; the import itself succeeded.
      }
    },
    [client, contextId, fields],
  );

  const cancel = React.useCallback(() => {
    cancelRef.current = true;
  }, []);

  const reset = React.useCallback(() => {
    cancelRef.current = false;
    setPhase("edit");
    setRowStates({});
    setSummary(null);
  }, []);

  const doneCount = Object.values(rowStates).filter(
    (s) => s.state === "done" || s.state === "failed",
  ).length;

  return { phase, rowStates, summary, doneCount, run, cancel, reset };
}
```

- [ ] **Step 2: Create `import-wizard-dialog.tsx`**

```tsx
"use client";

import { useApolloClient } from "@apollo/client";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { coerceValue } from "@/lib/import/coerce";
import { fileFields, importableFields } from "@/lib/import/fields";
import { autoMapColumns } from "@/lib/import/map-columns";
import type { ColumnMapping } from "@/lib/import/map-columns";
import { indexFiles, leftoverFiles } from "@/lib/import/match-files";
import type { ParsedCsv } from "@/lib/import/parse-csv";
import { classifyRows } from "@/lib/import/resolve-targets";
import type { ExistingRefs } from "@/lib/import/resolve-targets";
import { rowIsValid, rowsFromCsv, rowsFromFiles, validateRow } from "@/lib/import/rows";
import { buildErrorReportCsv } from "@/lib/import/template";
import type { ImportRow } from "@/lib/import/types";
import type { Context } from "@/types/models/context";

import { GET_ITEMS_BY_EXTERNAL_IDS, GET_ITEMS_BY_IDS, PAGINATION_POSTFIX } from "../../../queries";

import { StepAddData } from "./step-add-data";
import { StepMapColumns } from "./step-map-columns";
import { StepReviewGrid, translateCellError } from "./step-review-grid";
import { useImportRunner } from "./use-import-runner";

type WizardStep = "add" | "map" | "review";

export interface ImportWizardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: Context;
}

export function ImportWizardDialog({ open, onOpenChange, context }: ImportWizardDialogProps) {
  const t = useTranslations("knowledge");
  const client = useApolloClient();
  const fields = React.useMemo(() => importableFields(context), [context]);
  const fileTargets = React.useMemo(() => fileFields(fields), [fields]);

  const [step, setStep] = React.useState<WizardStep>("add");
  const [files, setFiles] = React.useState<File[]>([]);
  const [csv, setCsv] = React.useState<{ name: string; parsed: ParsedCsv } | null>(null);
  const [mapping, setMapping] = React.useState<ColumnMapping[]>([]);
  const [rows, setRows] = React.useState<ImportRow[]>([]);
  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;

  const runner = useImportRunner(context.id, fields);
  const running = runner.phase === "running";

  // Single file field auto-selects; multiple need the add-step dropdown.
  const [fileFieldTarget, setFileFieldTarget] = React.useState<string | null>(null);
  const resolvedFileTarget =
    fileTargets.length === 1 ? fileTargets[0].name : fileFieldTarget;

  // Reset everything on (re)open, mirroring new-item-dialog.tsx.
  React.useEffect(() => {
    if (open) {
      setStep("add");
      setFiles([]);
      setCsv(null);
      setMapping([]);
      setRows([]);
      setFileFieldTarget(null);
      runner.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Warn against closing the tab while the import runs.
  React.useEffect(() => {
    if (!running) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [running]);

  const classifyAgainstServer = React.useCallback(
    async (input: ImportRow[]): Promise<ImportRow[]> => {
      const ids = [
        ...new Set(
          input
            .map((r) => (typeof r.cells.id?.value === "string" ? r.cells.id.value : ""))
            .filter(Boolean),
        ),
      ];
      const exts = [
        ...new Set(
          input
            .map((r) =>
              typeof r.cells.external_id?.value === "string" ? r.cells.external_id.value : "",
            )
            .filter(Boolean),
        ),
      ];
      const existing: ExistingRefs = { byExternalId: new Map(), knownIds: new Set() };
      if (exts.length > 0) {
        const { data } = await client.query({
          query: GET_ITEMS_BY_EXTERNAL_IDS(context.id),
          variables: { ids: exts, limit: exts.length },
          fetchPolicy: "network-only",
        });
        for (const item of data?.[context.id + PAGINATION_POSTFIX]?.items ?? []) {
          if (item.external_id) existing.byExternalId.set(item.external_id, item.id);
        }
      }
      if (ids.length > 0) {
        const { data } = await client.query({
          query: GET_ITEMS_BY_IDS(context.id),
          variables: { ids, limit: ids.length },
          fetchPolicy: "network-only",
        });
        for (const item of data?.[context.id + PAGINATION_POSTFIX]?.items ?? []) {
          existing.knownIds.add(item.id);
        }
      }
      return classifyRows(input, existing).map((r) => validateRow(r, fields));
    },
    [client, context.id, fields],
  );

  const enterReview = React.useCallback(async () => {
    const index = indexFiles(files);
    if (index.duplicateNames.length > 0) {
      toast.error(
        t("workspace.import.add.duplicateFiles", { names: index.duplicateNames.join(", ") }),
      );
    }
    let built: ImportRow[] = [];
    if (csv) built = rowsFromCsv(csv.parsed, mapping, fields, index);
    else if (resolvedFileTarget) built = rowsFromFiles(files, resolvedFileTarget);
    setRows(await classifyAgainstServer(built));
    setStep("review");
  }, [csv, files, mapping, fields, resolvedFileTarget, classifyAgainstServer, t]);

  const handleContinueFromAdd = () => {
    if (csv) {
      setMapping(autoMapColumns(csv.parsed.headers, fields));
      setStep("map");
    } else {
      void enterReview();
    }
  };

  const handleCellChange = (rowKey: string, fieldName: string, raw: string) => {
    setRows((prev) =>
      prev.map((row) => {
        if (row.key !== rowKey) return row;
        const field = fields.find((f) => f.name === fieldName);
        if (!field) return row;
        const next = { ...row, cells: { ...row.cells, [fieldName]: coerceValue(field, raw) } };
        return validateRow(next, fields);
      }),
    );
  };

  const handleKeyCellBlur = () => {
    void classifyAgainstServer(rowsRef.current).then(setRows);
  };

  const handleApplyToAll = (fieldName: string, raw: string) => {
    const field = fields.find((f) => f.name === fieldName);
    if (!field) return;
    setRows((prev) =>
      prev.map((row) =>
        validateRow(
          { ...row, cells: { ...row.cells, [fieldName]: coerceValue(field, raw) } },
          fields,
        ),
      ),
    );
  };

  const handleRemoveRow = (rowKey: string) => {
    setRows((prev) => prev.filter((r) => r.key !== rowKey));
  };

  const leftovers = React.useMemo(
    () => (csv ? leftoverFiles(files, rows) : []),
    [csv, files, rows],
  );

  const addLeftovers = () => {
    if (!resolvedFileTarget) return;
    const extra = rowsFromFiles(leftovers, resolvedFileTarget, "extra").map((r) =>
      validateRow(r, fields),
    );
    setRows((prev) => [...prev, ...extra]);
  };

  const displayFields = React.useMemo(() => {
    const present = new Set<string>();
    for (const row of rows) for (const key of Object.keys(row.cells)) present.add(key);
    return fields.filter(
      (f) => f.name === "name" || present.has(f.name) || (f.required && !f.core),
    );
  }, [rows, fields]);

  const validRows = rows.filter(rowIsValid);
  const failedCount = rows.filter((r) => r.runState === "failed").length;

  const downloadErrorReport = () => {
    const report = buildErrorReportCsv(rows, fields, (row) =>
      row.runError ??
      (row.error
        ? translateCellError(t, row.error)
        : Object.values(row.cells)
            .filter((c) => c.error)
            .map((c) => translateCellError(t, c.error!))
            .join("; ")),
    );
    const blob = new Blob([report], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${context.id}-import-errors.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && running) return; // must cancel first
    onOpenChange(next);
  };

  const canContinueFromAdd =
    Boolean(csv) || (files.length > 0 && Boolean(resolvedFileTarget));

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[90dvh] w-[95vw] max-w-6xl flex-col gap-4">
        <DialogHeader>
          <DialogTitle>
            {t("workspace.import.title")} — {t(`workspace.import.steps.${step}`)}
          </DialogTitle>
          <DialogDescription>{t("workspace.import.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {step === "add" && (
            <StepAddData
              contextId={context.id}
              fields={fields}
              files={files}
              csv={csv}
              fileFieldTarget={resolvedFileTarget}
              onFilesAdded={(added) => setFiles((prev) => [...prev, ...added])}
              onRemoveFile={(i) => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
              onCsvChange={setCsv}
              onFileFieldTargetChange={setFileFieldTarget}
            />
          )}
          {step === "map" && csv && (
            <StepMapColumns
              csv={csv}
              mapping={mapping}
              fields={fields}
              onMappingChange={setMapping}
            />
          )}
          {step === "review" && (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              {runner.phase !== "edit" && (
                <div className="flex items-center gap-3">
                  <Progress
                    className="h-2 flex-1"
                    value={rows.length ? (runner.doneCount / rows.length) * 100 : 0}
                  />
                  <span className="whitespace-nowrap text-sm text-muted-foreground">
                    {runner.phase === "running"
                      ? t("workspace.import.run.progress", {
                          done: runner.doneCount,
                          total: rows.length,
                        })
                      : t("workspace.import.run.summary", {
                          created: runner.summary?.created ?? 0,
                          updated: runner.summary?.updated ?? 0,
                          failed: runner.summary?.failed ?? 0,
                        })}
                  </span>
                </div>
              )}
              {runner.phase === "edit" && leftovers.length > 0 && resolvedFileTarget && (
                <Button type="button" variant="outline" size="sm" onClick={addLeftovers}>
                  {t("workspace.import.review.addLeftovers", { count: leftovers.length })}
                </Button>
              )}
              <StepReviewGrid
                fields={fields}
                displayFields={displayFields}
                rows={rows}
                running={running}
                rowStates={runner.rowStates}
                onCellChange={handleCellChange}
                onKeyCellBlur={handleKeyCellBlur}
                onApplyToAll={handleApplyToAll}
                onRemoveRow={handleRemoveRow}
              />
            </div>
          )}
        </div>

        <DialogFooter className="flex-wrap gap-2">
          {step !== "add" && runner.phase === "edit" && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setStep(step === "review" && csv ? "map" : "add")}
            >
              {t("workspace.import.back")}
            </Button>
          )}

          {step === "add" && (
            <Button type="button" disabled={!canContinueFromAdd} onClick={handleContinueFromAdd}>
              {t("workspace.import.continue")}
            </Button>
          )}
          {step === "map" && (
            <Button type="button" onClick={() => void enterReview()}>
              {t("workspace.import.continue")}
            </Button>
          )}

          {step === "review" && runner.phase === "edit" && (
            <>
              <span className="mr-auto text-sm text-muted-foreground">
                {t("workspace.import.review.validCount", {
                  valid: validRows.length,
                  total: rows.length,
                })}
              </span>
              <Button
                type="button"
                disabled={validRows.length === 0}
                onClick={() => void runner.run(rowsRef.current)}
              >
                {validRows.length === rows.length
                  ? t("workspace.import.review.importAll", { count: rows.length })
                  : t("workspace.import.review.importValid", { count: validRows.length })}
              </Button>
            </>
          )}

          {running && (
            <Button type="button" variant="outline" onClick={runner.cancel}>
              {t("workspace.import.cancelRun")}
            </Button>
          )}

          {runner.phase === "done" && (
            <>
              {failedCount > 0 && (
                <>
                  <Button type="button" variant="outline" onClick={downloadErrorReport}>
                    {t("workspace.import.run.downloadReport")}
                  </Button>
                  <Button type="button" onClick={() => void runner.run(rowsRef.current)}>
                    {t("workspace.import.run.retryFailed")}
                  </Button>
                </>
              )}
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("workspace.import.close")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add "app/(application)/data/[ctx]/components/import/use-import-runner.ts" "app/(application)/data/[ctx]/components/import/import-wizard-dialog.tsx"
git commit -m "feat(import): wizard host dialog and Apollo-backed import runner"
```

---

### Task 16: Entry-point wiring

**Files:**
- Modify: `app/(application)/data/[ctx]/components/workspace-shell.tsx`
- Modify: `app/(application)/data/[ctx]/components/items-tab.tsx`
- Modify: `app/(application)/data/[ctx]/components/items-table.tsx`
- Modify: `app/(application)/data/[ctx]/components/items-empty.tsx`

**Interfaces:**
- Consumes: `ImportWizardDialog` from Task 15.
- Produces: Import button in the PageHeader action slot; `onOpenImport` threaded WorkspaceShell → ItemsTab → ItemsTable → ItemsEmpty (suppressed in archived view, mirroring `onOpenCreate`). EmptyState primitive is NOT modified (its contract is "the ONE primary action") — ItemsEmpty composes a secondary button beneath it.

- [ ] **Step 1: WorkspaceShell.** In `workspace-shell.tsx`:

Change the lucide import and add the wizard import:

```ts
import { Plus, Upload } from "lucide-react";
// with the other relative imports:
import { ImportWizardDialog } from "./import/import-wizard-dialog";
```

Below `const [newItemOpen, setNewItemOpen] = React.useState(false);` add:

```ts
const [importOpen, setImportOpen] = React.useState(false);
```

Replace the PageHeader `action` prop value:

```tsx
action={
  <div className="flex items-center gap-2">
    <Button variant="outline" onClick={() => setImportOpen(true)}>
      <Upload aria-hidden="true" className="mr-2 size-4" />
      {t("workspace.import.trigger")}
    </Button>
    <Button onClick={() => setNewItemOpen(true)}>
      <Plus aria-hidden="true" className="mr-2 size-4" />
      {t("workspace.newItem")}
    </Button>
  </div>
}
```

Add `onOpenImport` to the ItemsTab usage:

```tsx
<ItemsTab
  context={context}
  ...existing props...
  onOpenCreate={() => setNewItemOpen(true)}
  onOpenImport={() => setImportOpen(true)}
/>
```

Mount the wizard next to NewItemDialog:

```tsx
<ImportWizardDialog
  open={importOpen}
  onOpenChange={setImportOpen}
  context={context}
/>
```

- [ ] **Step 2: ItemsTab.** In `items-tab.tsx`, add to `ItemsTabProps` and the destructured params:

```ts
onOpenImport: () => void;
```

and pass it through to `<ItemsTable ... onOpenImport={onOpenImport} />`.

- [ ] **Step 3: ItemsTable.** In `items-table.tsx`, add to `ItemsTableProps` and the destructured params:

```ts
onOpenImport: () => void;
```

and extend the ItemsEmpty usage (currently `onCreate={archived ? undefined : onOpenCreate}`):

```tsx
<ItemsEmpty
  hasFilters={hasFilters}
  onClearFilters={onClearFilters}
  onCreate={archived ? undefined : onOpenCreate}
  onImport={archived ? undefined : onOpenImport}
/>
```

- [ ] **Step 4: ItemsEmpty.** In `items-empty.tsx`, add the lucide `Upload` import and `Button` import:

```ts
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
```

Add to `ItemsEmptyProps`:

```ts
/** When undefined, the secondary Import CTA is suppressed (archived view). */
onImport?: () => void;
```

Replace the final `return` (the non-filtered branch) with a composed layout — EmptyState keeps its single primary action; the Import CTA is a sibling:

```tsx
return (
  <div className="flex flex-col items-center">
    <EmptyState
      icon={Database}
      title={t("workspace.items.noItemsTitle")}
      description={t("workspace.items.noItemsDescription")}
      action={
        onCreate
          ? { label: t("workspace.items.addFirst"), onClick: onCreate }
          : undefined
      }
    />
    {onImport && (
      <Button type="button" variant="outline" onClick={onImport} className="-mt-6 mb-6">
        <Upload aria-hidden="true" className="mr-2 size-4" />
        {t("workspace.import.trigger")}
      </Button>
    )}
  </div>
);
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add "app/(application)/data/[ctx]/components/workspace-shell.tsx" "app/(application)/data/[ctx]/components/items-tab.tsx" "app/(application)/data/[ctx]/components/items-table.tsx" "app/(application)/data/[ctx]/components/items-empty.tsx"
git commit -m "feat(import): wire Import entry points into the knowledge workspace"
```

---

### Task 17: Final verification and manual UAT

**Files:** none (verification only).

**Interfaces:**
- Consumes: the complete feature.
- Produces: a verified branch ready for review/merge (use superpowers:verification-before-completion and superpowers:finishing-a-development-branch).

- [ ] **Step 1: Full automated gates**

Run: `npm test && npm run lint && npm run prettier && npm run check-messages && npm run build`
Expected: all pass. `npm run build` is the authoritative Next.js type gate.

- [ ] **Step 2: Manual UAT** — start the backend (`npm run dev` in the backend repo, per its README) and frontend dev server, sign in, open a context under `/data`. Work through this checklist and record the outcome of each item:

1. **Files-only, single file field** (e.g. the built-in `transcriptions` context or any context with one file field): drop 3 PDFs → review grid shows 3 create-rows, names prefilled without extension → import → 3 items appear in the list, each with the file attached (open one; FileDataCard shows the original filename), processing/embedding activity appears in the existing pipeline/activity UI.
2. **Multiple file fields**: on a context with ≥2 file fields, drop files → target-field dropdown appears and routes files to the chosen field.
3. **No file field**: drop a PDF on a text-only context → friendly hint, cannot continue with files alone.
4. **CSV template**: download it, confirm headers = id, external_id, name, description, tags + custom field labels.
5. **CSV create + update**: export/prepare a CSV with some new rows and some rows carrying an existing item's `external_id` → mapping auto-matches → review shows correct Create/Update badges → import → updates changed only mapped columns.
6. **CSV + files**: CSV with a file column holding filenames + the files dropped alongside → matched; a misspelled filename shows the `fileMissing` error on that row only; leftover files offer "add as new rows".
7. **Validation**: blank required cell blocks the row; enum typo shows allowed values; `1,5` accepted in a number column, `1,500` rejected; fixing a cell inline clears the error and the "N of M ready" count updates.
8. **Partial failure + retry**: force a failure (e.g. temporarily stop the backend mid-run, or include a row that violates a server constraint) → other rows complete, failed rows show the message, "Retry failed rows" re-runs only those, error report CSV downloads with the raw values + error column.
9. **Cancel**: start a larger import, cancel mid-run → no new rows start, in-flight rows finish, summary reflects partials.
10. **Tab-close guard**: while running, attempt to close the tab → browser warns.
11. **German**: switch locale to de → wizard fully translated.
12. **Permissions**: as a non-admin user who can create items, the flow works; update rows against items they cannot edit fail as row errors, not a crash.

- [ ] **Step 3: Fix anything UAT surfaces** (each fix follows the usual test-first loop where it touches `lib/`), re-run Step 1.

- [ ] **Step 4: Finish the branch**

Invoke superpowers:finishing-a-development-branch — present merge/PR options for `feature/bulk-import` against `main`.

---

## Self-Review Notes (already applied)

- **Spec coverage:** every spec section maps to a task — UX flow (13–16), coercion table (4), create/update semantics incl. re-classification on key-cell edit (8, 15 `handleKeyCellBlur`), execution/error handling incl. beforeunload + retry + error report (10, 15), template (9), i18n (12), permissions (16 — entry point mirrors "New item" placement; no new checks), testing (every lib task + 17). Backend changes: none, matching the spec.
- **Known constraint (documented in spec review):** contexts whose *custom* fields are `required` may reject partial update inputs at the GraphQL layer (generated input types mark required fields non-null). Such rows fail cleanly as row errors with the server message. If UAT hits this, the v2 path is prefetching current values for update rows — explicitly out of scope for v1.
- **Type consistency check:** `ImportCell`/`ImportRow`/`ImportField` names and shapes are identical across Tasks 3–15; `runImport` consumes `buildCreateInput`/`buildUpdateInput` from Task 7; `uploadFileToS3` satisfies `RunnerEffects.uploadFile`; wizard imports match the exported names of each step component.
- **EmptyState primitive intentionally not modified** — its documented contract is one primary action; ItemsEmpty composes the secondary CTA outside it.
