# Bulk Import v1.1 (Two Flows) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the import wizard into two exclusive flows (files vs CSV), switch CSV file columns from filename-matching to instance storage URLs/keys with existence verification, and add an example row to the CSV template.

**Architecture:** Delta on the merged v1 feature (frontend `main` @ `bb4c2c5`). Pure-logic changes in `lib/import/*` (coerce rewrite, rows simplification, template example row, new verify-files module, match-files deleted); UI changes in the three wizard components; i18n delta in both locales. Zero backend changes.

**Tech Stack:** unchanged from v1 (Next.js 16, React 19, Apollo, papaparse, vitest, next-intl, shadcn/ui).

## Global Constraints

- **All code in the FRONTEND repo** `/Users/daniel.claessen/Desktop/Projects/exulu/frontend`; paths below relative to its root. Spec: `docs/superpowers/specs/2026-07-16-bulk-import-v1.1-two-flows-design.md` (backend repo).
- **Branch:** `feature/bulk-import-v1.1` off `main` (`bb4c2c5`), sibling worktree with its own `npm install` (worktree via superpowers:using-git-worktrees).
- **Known pre-existing baseline failures (NOT gates):** 1 vitest failure `components/shell/nav-config.test.ts`; 1 eslint error `app/(application)/data/components/entity-types.tsx` (+~108 warnings); 1 tsc error `app/(authentication)/login/login.tsx` (google.svg); 461 repo-wide prettier violations. **Gate = no NEW failures; all bulk-import feature files stay prettier-clean.**
- **i18n:** `knowledge.workspace.import.*`, en + de in the same commit, alphabetical keys, `npm run check-messages` must pass. House pattern `useTranslations("knowledge")`.
- Error-code → i18n contract: cell errors resolve to `knowledge.workspace.import.errors.<code>`. This plan removes `fileMissing` and adds `fileUrl`, `fileNotFound`.
- **No new dependencies.** Existing token classes only; no violet.
- Test style: colocated `<module>.test.ts`, explicit vitest imports, `@/` alias.

---

### Task 1: Branch, worktree, baseline

**Files:** none (setup).

**Interfaces:**
- Produces: worktree at `/Users/daniel.claessen/Desktop/Projects/exulu/frontend-bulk-import-v11`, branch `feature/bulk-import-v1.1`, green baseline.

- [ ] **Step 1:** `cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && git worktree add ../frontend-bulk-import-v11 -b feature/bulk-import-v1.1 main`
- [ ] **Step 2:** `cd ../frontend-bulk-import-v11 && npm install` (worktree gets a real install; the primary's node_modules is not shared).
- [ ] **Step 3:** `npm test && npm run lint` — expected: 261/262 tests (nav-config pre-existing), lint 1 pre-existing error. If anything else fails, STOP and report.

---

### Task 2: Coerce — file cells take a storage URL or key

**Files:**
- Modify: `lib/import/coerce.ts` (the `case "file"` branch + one import)
- Modify: `lib/import/coerce.test.ts` (replace the file passthrough test with the new suite)

**Interfaces:**
- Consumes: `extractS3KeyFromUrl` from `@/lib/s3/extract-key` (pure, already tested).
- Produces: file-cell coercion — blank → `null`; `http(s)://…` → extracted key (must contain `/`, else error `fileUrl`); raw string containing `/` → passthrough key; anything else → error `fileUrl`. `coerceValue` still never throws.

- [ ] **Step 1: Update the tests.** In `lib/import/coerce.test.ts`, replace this existing test:

```ts
  it("passes file cell values through trimmed (filename matching happens later)", () => {
    expect(coerceValue(field({ type: "file" }), " report.pdf ").value).toBe("report.pdf");
  });
```

with:

```ts
  it("extracts the key from an AWS virtual-hosted storage URL", () => {
    expect(
      coerceValue(
        field({ type: "file" }),
        "https://mybucket.s3.eu-central-1.amazonaws.com/user_1/uuid-_EXULU_report.pdf?X-Amz-Signature=xyz",
      ).value,
    ).toBe("mybucket/user_1/uuid-_EXULU_report.pdf");
  });
  it("extracts the key from a path-style (MinIO) storage URL", () => {
    expect(
      coerceValue(
        field({ type: "file" }),
        "https://api.s3.exulu.com/exulu/user_1/uuid-_EXULU_report.pdf",
      ).value,
    ).toBe("exulu/user_1/uuid-_EXULU_report.pdf");
  });
  it("accepts a raw bucket/key string", () => {
    expect(coerceValue(field({ type: "file" }), " exulu/user_1/x.pdf ").value).toBe(
      "exulu/user_1/x.pdf",
    );
  });
  it("rejects URLs that do not extract to a bucket/key", () => {
    expect(coerceValue(field({ type: "file" }), "https://example.com/").error?.code).toBe(
      "fileUrl",
    );
  });
  it("rejects plain filenames and text", () => {
    expect(coerceValue(field({ type: "file" }), "report.pdf").error?.code).toBe("fileUrl");
    expect(coerceValue(field({ type: "file" }), "some text").error?.code).toBe("fileUrl");
  });
```

(The blank-file-→null test in the blanks describe block stays as is.)

- [ ] **Step 2:** Run `npm test -- lib/import/coerce.test.ts` — expected: FAIL (new tests).
- [ ] **Step 3: Implement.** In `lib/import/coerce.ts`, add to the imports:

```ts
import { extractS3KeyFromUrl } from "@/lib/s3/extract-key";
```

and replace:

```ts
    case "file":
      return { raw, value: trimmed };
```

with:

```ts
    case "file": {
      // v1.1: file cells reference this instance's storage — a URL (presigned
      // links included) or a raw bucket/key. Never a local filename.
      if (/^https?:\/\//i.test(trimmed)) {
        const key = extractS3KeyFromUrl(trimmed);
        return key.includes("/") ? { raw, value: key } : err(raw, "fileUrl");
      }
      if (trimmed.includes("/")) return { raw, value: trimmed };
      return err(raw, "fileUrl");
    }
```

- [ ] **Step 4:** `npm test -- lib/import/coerce.test.ts` — expected: PASS.
- [ ] **Step 5:** `git add lib/import/coerce.ts lib/import/coerce.test.ts && git commit -m "feat(import): file cells coerce storage URLs/keys instead of filenames"`

---

### Task 3: Rows — drop filename matching; delete match-files

**Files:**
- Modify: `lib/import/rows.ts` (remove fileIndex plumbing; widen the allowedFileTypes check)
- Modify: `lib/import/rows.test.ts`
- Delete: `lib/import/match-files.ts`, `lib/import/match-files.test.ts`

**Interfaces:**
- Produces: `rowsFromCsv(parsed: ParsedCsv, mapping: ColumnMapping[], fields: ImportField[]): ImportRow[]` — three params, no file matching, no `fileMissing` errors (coercion emits `fileUrl` instead). `validateRow`'s `allowedFileTypes` check now validates `cell.file?.name` (files flow) OR the string key in `cell.value` (CSV flow) by extension suffix. `rowsFromFiles`, input builders, `rowIsValid` unchanged.
- Consumers updated in Task 7/9 (wizard). Until then the wizard still compiles only in the worktree branch — Tasks 3 and 9 both land before any gate that builds the app, and `rowsFromCsv`'s arity change WILL break `import-wizard-dialog.tsx` compilation; therefore in THIS task also apply the two mechanical wizard edits that unblock tsc (removal of the fourth argument and the match-files import — full wizard rework still happens in Task 9):
  - In `app/(application)/data/[ctx]/components/import/import-wizard-dialog.tsx`: delete the line `import { indexFiles, leftoverFiles } from "@/lib/import/match-files";`; in `enterReview` delete the `const index = indexFiles(files);` statement and the whole `if (index.duplicateNames.length > 0) { toast.error(...) }` block; change `built = rowsFromCsv(csv.parsed, mapping, fields, index);` to `built = rowsFromCsv(csv.parsed, mapping, fields);`; delete the `leftovers` useMemo, the `addLeftovers` function, and the leftover-button JSX block (`{runner.phase === "edit" && leftovers.length > 0 && resolvedFileTarget && ( <Button ...addLeftovers...</Button> )}`).

- [ ] **Step 1: Update tests.** In `lib/import/rows.test.ts`: remove the `import { indexFiles } from "@/lib/import/match-files";` line. Replace the `rowsFromCsv` describe block with:

```ts
describe("rowsFromCsv", () => {
  const parsed = {
    headers: ["name", "category", "doc"],
    rows: [
      ["Alpha", "A", "exulu/user_1/uuid-_EXULU_report.pdf"],
      ["Beta", "b", "not-a-key"],
    ],
    errors: [],
  };
  const mapping = [
    { header: "name", index: 0, fieldName: "name" },
    { header: "category", index: 1, fieldName: "category" },
    { header: "doc", index: 2, fieldName: "doc_s3key" },
  ];

  it("coerces cells; file columns become storage keys", () => {
    const rows = rowsFromCsv(parsed, mapping, FIELDS);
    expect(rows[0].cells.category.value).toBe("a");
    expect(rows[0].cells.doc_s3key.value).toBe("exulu/user_1/uuid-_EXULU_report.pdf");
    expect(rows[1].cells.doc_s3key.error?.code).toBe("fileUrl");
  });

  it("skips unmapped columns", () => {
    const rows = rowsFromCsv(parsed, [{ header: "name", index: 0, fieldName: "name" }], FIELDS);
    expect(Object.keys(rows[0].cells)).toEqual(["name"]);
  });
});
```

In the `validateRow` describe block, replace the allowedFileTypes test with two:

```ts
  it("enforces allowedFileTypes against dropped file names", () => {
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

  it("enforces allowedFileTypes against storage keys", () => {
    const row: ImportRow = {
      key: "r",
      action: "create",
      runState: "pending",
      cells: {
        name: { raw: "n", value: "n" },
        category: { raw: "a", value: "a" },
        doc_s3key: {
          raw: "exulu/user_1/uuid-_EXULU_x.txt",
          value: "exulu/user_1/uuid-_EXULU_x.txt",
        },
      },
    };
    expect(validateRow(row, FIELDS).cells.doc_s3key.error?.code).toBe("fileType");
  });
```

- [ ] **Step 2:** `npm test -- lib/import/rows.test.ts` — expected: FAIL.
- [ ] **Step 3: Implement.** In `lib/import/rows.ts`:
  - Remove the imports of `FileIndex`/`findFile` (the whole `@/lib/import/match-files` import lines).
  - Change `rowsFromCsv`'s signature to `(parsed: ParsedCsv, mapping: ColumnMapping[], fields: ImportField[]): ImportRow[]` and delete the file-matching block inside it (the `if (field.type === "file" && …) { const file = findFile(…) … fileMissing … }` statement) — `coerceValue` now does all file-cell work.
  - Replace the `allowedFileTypes` block in `validateRow` with:

```ts
    if (f.type === "file" && f.allowedFileTypes?.length) {
      const cell = cells[f.name];
      const candidate =
        cell?.file?.name ??
        (typeof cell?.value === "string" ? cell.value : "");
      if (candidate) {
        const ok = f.allowedFileTypes.some((ext) =>
          candidate.toLowerCase().endsWith(ext.toLowerCase()),
        );
        if (!ok) {
          cells[f.name] = {
            ...cell!,
            error: {
              code: "fileType",
              params: { values: f.allowedFileTypes.join(", ") },
            },
          };
        }
      }
    }
```

  - `git rm lib/import/match-files.ts lib/import/match-files.test.ts`
  - Apply the mechanical wizard edits listed under Interfaces above (import removal, `indexFiles`/duplicates block removal, three-arg `rowsFromCsv`, leftovers removal).
- [ ] **Step 4:** `npm test -- lib/import/rows.test.ts && npm test && npx tsc --noEmit` — expected: PASS / no new failures.
- [ ] **Step 5:** `git add -A lib/import "app/(application)/data/[ctx]/components/import/import-wizard-dialog.tsx" && git commit -m "feat(import): CSV rows reference storage keys; retire filename matching"`

---

### Task 4: Template example row

**Files:**
- Modify: `lib/import/template.ts`, `lib/import/template.test.ts`

**Interfaces:**
- Produces: `buildCsvTemplate(fields)` returns header row + one example row. Example values: `id`/`uuid`/`file` → blank; `external_id` → `example-id-123`; `name` → `Example item`; `description` → `Example description`; `tags` → `tag1,tag2` (escaped); number → `1.5`; boolean → `true`; enum → first `enumValues` entry or blank; date → `2026-07-16`; json → `{}`; other → `Example text`. `buildErrorReportCsv` unchanged.

- [ ] **Step 1: Update tests.** Replace the `buildCsvTemplate` describe block in `lib/import/template.test.ts` with:

```ts
describe("buildCsvTemplate", () => {
  it("emits a header row and an example row", () => {
    const fields: ImportField[] = [
      { name: "id", label: "id", type: "text", required: false, core: true },
      { name: "external_id", label: "external_id", type: "text", required: false, core: true },
      { name: "name", label: "name", type: "shortText", required: true, core: true },
      { name: "tags", label: "tags", type: "text", required: false, core: true },
      { name: "count", label: "count", type: "number", required: false, core: false },
      { name: "cat", label: "cat", type: "enum", required: false, core: false, enumValues: ["A", "B"] },
      { name: "doc_s3key", label: "doc", type: "file", required: false, core: false },
    ];
    expect(buildCsvTemplate(fields)).toBe(
      'id,external_id,name,tags,count,cat,doc\n,example-id-123,Example item,"tag1,tag2",1.5,A,\n',
    );
  });

  it("escapes labels containing commas or quotes", () => {
    const fields = [
      { name: "x", label: 'weird, "label"', type: "text", required: false, core: false },
    ];
    expect(buildCsvTemplate(fields)).toBe('"weird, ""label"""\nExample text\n');
  });
});
```

- [ ] **Step 2:** `npm test -- lib/import/template.test.ts` — expected: FAIL.
- [ ] **Step 3: Implement.** In `lib/import/template.ts`, add below `csvEscape`:

```ts
function exampleValueFor(field: ImportField): string {
  if (field.name === "id") return "";
  if (field.name === "external_id") return "example-id-123";
  if (field.name === "name") return "Example item";
  if (field.name === "description") return "Example description";
  if (field.name === "tags") return "tag1,tag2";
  switch (field.type) {
    case "number":
      return "1.5";
    case "boolean":
      return "true";
    case "enum":
      return field.enumValues?.[0] ?? "";
    case "date":
      return "2026-07-16";
    case "json":
      return "{}";
    case "file":
    case "uuid":
      return "";
    default:
      return "Example text";
  }
}
```

and change `buildCsvTemplate` to:

```ts
/** Header row + one example row showing what each column expects. */
export function buildCsvTemplate(fields: ImportField[]): string {
  const header = fields.map((f) => csvEscape(f.label)).join(",");
  const example = fields.map((f) => csvEscape(exampleValueFor(f))).join(",");
  return `${header}\n${example}\n`;
}
```

- [ ] **Step 4:** `npm test -- lib/import/template.test.ts && npm test` — expected: PASS / no new failures.
- [ ] **Step 5:** `git add lib/import/template.ts lib/import/template.test.ts && git commit -m "feat(import): example row in the CSV template"`

---

### Task 5: verify-files module (storage existence check)

**Files:**
- Create: `lib/import/verify-files.ts`
- Test: `lib/import/verify-files.test.ts`

**Interfaces:**
- Produces:
  - `fileKeysOf(rows: ImportRow[], fields: ImportField[]): string[]` — unique string values of file-typed cells that have no attached `File`
  - `findMissingFileKeys(keys: string[], exists: (key: string) => Promise<boolean>, concurrency?: number): Promise<Set<string>>` — injectable check, failures count as missing, default concurrency 5
  - `applyMissingFileErrors(rows: ImportRow[], fields: ImportField[], missing: Set<string>): ImportRow[]` — sets `{ code: "fileNotFound" }` on cells whose key is missing; CLEARS a prior `fileNotFound` error on cells whose key now exists; other errors untouched
- Consumed by the wizard (Task 9) with `exists = filesApi.object(key) → $metadata.httpStatusCode === 200`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/import/verify-files.test.ts
import { describe, expect, it, vi } from "vitest";

import type { ImportField, ImportRow } from "@/lib/import/types";
import {
  applyMissingFileErrors,
  fileKeysOf,
  findMissingFileKeys,
} from "@/lib/import/verify-files";

const FIELDS: ImportField[] = [
  { name: "name", label: "name", type: "shortText", required: true, core: true },
  { name: "doc_s3key", label: "doc", type: "file", required: false, core: false },
];

const row = (key: string, cells: ImportRow["cells"]): ImportRow => ({
  key,
  action: "create",
  runState: "pending",
  cells,
});

describe("fileKeysOf", () => {
  it("collects unique string keys of file cells without attached Files", () => {
    const rows = [
      row("a", { doc_s3key: { raw: "b/k1", value: "b/k1" } }),
      row("b", { doc_s3key: { raw: "b/k1", value: "b/k1" } }),
      row("c", { doc_s3key: { raw: "x.pdf", value: "x.pdf", file: new File(["x"], "x.pdf") } }),
      row("d", { name: { raw: "n", value: "n" } }),
    ];
    expect(fileKeysOf(rows, FIELDS)).toEqual(["b/k1"]);
  });
});

describe("findMissingFileKeys", () => {
  it("returns keys the check rejects or fails on", async () => {
    const exists = vi.fn(async (key: string) => {
      if (key === "b/gone") return false;
      if (key === "b/boom") throw new Error("network");
      return true;
    });
    const missing = await findMissingFileKeys(["b/ok", "b/gone", "b/boom"], exists);
    expect(missing).toEqual(new Set(["b/gone", "b/boom"]));
    expect(exists).toHaveBeenCalledTimes(3);
  });

  it("checks each unique key once", async () => {
    const exists = vi.fn(async () => true);
    await findMissingFileKeys(["b/k", "b/k", "b/k"], exists);
    expect(exists).toHaveBeenCalledTimes(1);
  });
});

describe("applyMissingFileErrors", () => {
  it("flags missing keys and clears stale fileNotFound errors", () => {
    const rows = [
      row("a", { doc_s3key: { raw: "b/gone", value: "b/gone" } }),
      row("b", {
        doc_s3key: { raw: "b/ok", value: "b/ok", error: { code: "fileNotFound" } },
      }),
      row("c", {
        doc_s3key: { raw: "junk", value: null, error: { code: "fileUrl" } },
      }),
    ];
    const result = applyMissingFileErrors(rows, FIELDS, new Set(["b/gone"]));
    expect(result[0].cells.doc_s3key.error?.code).toBe("fileNotFound");
    expect(result[1].cells.doc_s3key.error).toBeUndefined();
    expect(result[2].cells.doc_s3key.error?.code).toBe("fileUrl");
  });
});
```

- [ ] **Step 2:** `npm test -- lib/import/verify-files.test.ts` — expected: FAIL (module not found).
- [ ] **Step 3: Implement**

```ts
// lib/import/verify-files.ts
import type { ImportField, ImportRow } from "@/lib/import/types";

/** Unique storage keys referenced by file cells (CSV flow — no attached File). */
export function fileKeysOf(rows: ImportRow[], fields: ImportField[]): string[] {
  const fileFieldNames = new Set(
    fields.filter((f) => f.type === "file").map((f) => f.name),
  );
  const keys = new Set<string>();
  for (const row of rows) {
    for (const [name, cell] of Object.entries(row.cells)) {
      if (!fileFieldNames.has(name) || cell.file) continue;
      if (typeof cell.value === "string" && cell.value !== "") keys.add(cell.value);
    }
  }
  return [...keys];
}

/**
 * Concurrency-capped existence check with an injectable probe. A probe
 * failure counts as missing — the user sees "not found in storage" rather
 * than importing a broken reference.
 */
export async function findMissingFileKeys(
  keys: string[],
  exists: (key: string) => Promise<boolean>,
  concurrency = 5,
): Promise<Set<string>> {
  const unique = [...new Set(keys)];
  const missing = new Set<string>();
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const key = unique[cursor++];
      if (!key) return;
      try {
        if (!(await exists(key))) missing.add(key);
      } catch {
        missing.add(key);
      }
    }
  };
  const n = Math.max(1, Math.min(concurrency, unique.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return missing;
}

/** Set fileNotFound errors on missing keys; clear stale ones on found keys. */
export function applyMissingFileErrors(
  rows: ImportRow[],
  fields: ImportField[],
  missing: Set<string>,
): ImportRow[] {
  const fileFieldNames = new Set(
    fields.filter((f) => f.type === "file").map((f) => f.name),
  );
  return rows.map((row) => {
    let changed = false;
    const cells = { ...row.cells };
    for (const [name, cell] of Object.entries(cells)) {
      if (!fileFieldNames.has(name) || cell.file) continue;
      if (typeof cell.value !== "string" || cell.value === "") continue;
      if (missing.has(cell.value)) {
        cells[name] = { ...cell, error: { code: "fileNotFound" } };
        changed = true;
      } else if (cell.error?.code === "fileNotFound") {
        cells[name] = { raw: cell.raw, value: cell.value };
        changed = true;
      }
    }
    return changed ? { ...row, cells } : row;
  });
}
```

- [ ] **Step 4:** `npm test -- lib/import/verify-files.test.ts` — expected: PASS.
- [ ] **Step 5:** `git add lib/import/verify-files.ts lib/import/verify-files.test.ts && git commit -m "feat(import): storage existence verification for file keys"`

---

### Task 6: i18n delta (en + de)

**Files:** `messages/en.json`, `messages/de.json` — all inside `knowledge.workspace.import`, alphabetical order maintained.

**Remove from BOTH locales:** `add.browse`, `add.csvOnlyHint`, `add.duplicateFiles`, `add.hint`, `errors.fileMissing`, `review.addLeftovers`.

**Add to en:**

```json
"add": {
  "clearCsvToSwitch": "Remove the CSV to import files instead",
  "clearFilesToSwitch": "Clear the files to import via CSV instead",
  "csvZoneDrop": "Drop a CSV here, or click to browse",
  "csvZoneHint": "Columns become fields. File columns take a storage URL or key.",
  "csvZoneTitle": "Import via CSV",
  "filesZoneDrop": "Drop files here, or click to browse",
  "filesZoneHint": "One new item per file",
  "filesZoneTitle": "Import files"
}
```
(merged into the existing `add` object alphabetically), plus:
- `errors.fileNotFound`: `"Not found in storage"`
- `errors.fileUrl`: `"Must be this instance's storage URL or key"`
- `map.fileHint`: `"Values must be this instance's storage URLs or keys"`
- `review.blankClearsWarning`: `"Blank cells in mapped columns will clear those fields on updated items."`
- `review.filePlaceholder`: `"Storage URL or key"`

**Add to de** (same positions):

```json
"add": {
  "clearCsvToSwitch": "CSV entfernen, um stattdessen Dateien zu importieren",
  "clearFilesToSwitch": "Dateien entfernen, um stattdessen per CSV zu importieren",
  "csvZoneDrop": "CSV hier ablegen oder klicken zum Auswählen",
  "csvZoneHint": "Spalten werden zu Feldern. Datei-Spalten erwarten eine Speicher-URL oder einen Schlüssel.",
  "csvZoneTitle": "Per CSV importieren",
  "filesZoneDrop": "Dateien hier ablegen oder klicken zum Auswählen",
  "filesZoneHint": "Ein neuer Eintrag pro Datei",
  "filesZoneTitle": "Dateien importieren"
}
```
- `errors.fileNotFound`: `"Nicht im Speicher gefunden"`
- `errors.fileUrl`: `"Muss eine Speicher-URL oder ein Schlüssel dieser Instanz sein"`
- `map.fileHint`: `"Werte müssen Speicher-URLs oder Schlüssel dieser Instanz sein"`
- `review.blankClearsWarning`: `"Leere Zellen in zugeordneten Spalten löschen diese Felder bei aktualisierten Einträgen."`
- `review.filePlaceholder`: `"Speicher-URL oder Schlüssel"`

**Note:** removing `add.browse`/`add.hint`/`add.csvOnlyHint` breaks `step-add-data.tsx` until Task 7 rewrites it; Tasks 6 and 7 must land in the SAME commit-adjacent window — run only `npm run check-messages` as this task's gate; the tsc/test gates run at the end of Task 7. (Or execute Tasks 6+7 as one commit if the executor prefers; the plan keeps them separate for reviewability.)

- [ ] **Step 1:** Apply both locale edits.
- [ ] **Step 2:** `npm run check-messages` — expected: PASS with identical key counts.
- [ ] **Step 3:** `git add messages/en.json messages/de.json && git commit -m "feat(import): i18n delta for two-flow wizard (en/de)"`

---

### Task 7: Two-zone add step

**Files:**
- Rewrite: `app/(application)/data/[ctx]/components/import/step-add-data.tsx`

**Interfaces:**
- Props UNCHANGED (`StepAddDataProps` identical to v1 — wizard needs no prop changes for this task).
- Behavior: two zones with exclusivity as specced; files zone hidden when no eligible file fields; the multi-file-field target select lives in the files zone; template link lives in the CSV zone; no toasts.

- [ ] **Step 1: Replace the file's entire contents with:**

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
import { cn } from "@/lib/utils";

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

  // The two flows are exclusive: content in one zone disables the other.
  const filesZoneDisabled = Boolean(csv);
  const csvZoneDisabled = files.length > 0;

  const handleFilesDrop = (dropped: File[]) => {
    const dataFiles = dropped.filter(
      (f) => !f.name.toLowerCase().endsWith(".csv"),
    );
    if (dataFiles.length > 0) onFilesAdded(dataFiles);
  };

  const handleCsvDrop = async (dropped: File[]) => {
    const csvFile = dropped.find((f) => f.name.toLowerCase().endsWith(".csv"));
    if (csvFile) {
      onCsvChange({ name: csvFile.name, parsed: await parseCsvFile(csvFile) });
    }
  };

  const downloadTemplate = () => {
    const blob = new Blob([buildCsvTemplate(fields)], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${contextId}-import-template.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4",
        fileTargets.length > 0 && "md:grid-cols-2",
      )}
    >
      {fileTargets.length > 0 && (
        <section
          aria-disabled={filesZoneDisabled}
          className={cn(
            "flex flex-col gap-3 rounded-lg border border-input p-4",
            filesZoneDisabled && "opacity-50",
          )}
        >
          <div>
            <h3 className="text-sm font-semibold">
              {t("workspace.import.add.filesZoneTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("workspace.import.add.filesZoneHint")}
            </p>
          </div>
          <Dropzone
            multiple
            disabled={filesZoneDisabled}
            onFiles={handleFilesDrop}
            label={t("workspace.import.add.filesZoneDrop")}
          />
          {filesZoneDisabled && (
            <p className="text-sm text-muted-foreground">
              {t("workspace.import.add.clearCsvToSwitch")}
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
                        {t("workspace.import.add.removeFile", {
                          name: file.name,
                        })}
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
        </section>
      )}

      <section
        aria-disabled={csvZoneDisabled}
        className={cn(
          "flex flex-col gap-3 rounded-lg border border-input p-4",
          csvZoneDisabled && "opacity-50",
        )}
      >
        <div>
          <h3 className="text-sm font-semibold">
            {t("workspace.import.add.csvZoneTitle")}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t("workspace.import.add.csvZoneHint")}
          </p>
        </div>
        <Dropzone
          accept={[".csv"]}
          disabled={csvZoneDisabled}
          onFiles={(dropped) => void handleCsvDrop(dropped)}
          label={t("workspace.import.add.csvZoneDrop")}
        />
        {csvZoneDisabled && (
          <p className="text-sm text-muted-foreground">
            {t("workspace.import.add.clearFilesToSwitch")}
          </p>
        )}
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={csvZoneDisabled}
            onClick={downloadTemplate}
          >
            <Download aria-hidden="true" className="mr-2 size-4" />
            {t("workspace.import.add.template")}
          </Button>
        </div>

        {csv && (
          <div className="flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm">
            <FileSpreadsheet
              aria-hidden="true"
              className="size-4 text-muted-foreground"
            />
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
              <span className="sr-only">
                {t("workspace.import.add.removeCsv")}
              </span>
            </Button>
          </div>
        )}
        {csv && csv.parsed.errors.length > 0 && (
          <p className="text-sm text-destructive">
            {t("workspace.import.add.csvErrors", {
              errors: csv.parsed.errors.join("; "),
            })}
          </p>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 2:** `npx tsc --noEmit && npm run lint && npm test` — expected: no new failures (this also validates Task 6's key removals no longer have referents).
- [ ] **Step 3:** `git add "app/(application)/data/[ctx]/components/import/step-add-data.tsx" && git commit -m "feat(import): two exclusive import zones (files vs CSV)"`

---

### Task 8: Grid file-cell editor + map-step file hint

**Files:**
- Modify: `app/(application)/data/[ctx]/components/import/step-review-grid.tsx` (CellEditor file branch + blur wiring)
- Modify: `app/(application)/data/[ctx]/components/import/step-map-columns.tsx` (file-target hint)

**Interfaces:**
- Grid: file cells with an attached `File` (files flow) render the read-only chip; file cells WITHOUT one (CSV flow) render an editable text Input (placeholder `review.filePlaceholder`) whose blur triggers the same verify/classify handler as id/external_id.
- Map step: when a column maps to a file-typed field, a muted hint line `map.fileHint` renders under that row's Select.

- [ ] **Step 1: Grid.** In `step-review-grid.tsx`, inside `CellEditor`, replace the whole `if (field.type === "file") { … }` block with:

```tsx
  if (field.type === "file") {
    if (cell?.file) {
      return (
        <span
          title={errorTitle}
          className={cn(
            "inline-flex max-w-44 items-center gap-1 truncate rounded-md border border-input px-2 py-0.5 text-xs",
            cell?.error && "border-destructive text-destructive",
          )}
        >
          <Paperclip aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{cell.file.name}</span>
        </span>
      );
    }
    // CSV flow: the cell holds a storage URL/key — editable text.
    const keyName =
      typeof cell?.value === "string" && cell.value !== ""
        ? cell.value.split("_EXULU_").pop()
        : undefined;
    return (
      <Input
        disabled={disabled}
        value={cell?.raw ?? ""}
        onChange={(e) => onCellChange(row.key, field.name, e.target.value)}
        onBlur={onKeyCellBlur}
        title={errorTitle ?? keyName}
        aria-invalid={Boolean(cell?.error)}
        placeholder={t("workspace.import.review.filePlaceholder")}
        className={cn(
          "h-8 min-w-36 text-sm",
          cell?.error && "border-destructive",
        )}
        type="text"
      />
    );
  }
```

- [ ] **Step 2: Map hint.** In `step-map-columns.tsx`, add `ImportField` lookup + hint: inside the `TableCell` that renders the target `Select`, after the `</Select>` closing tag, add:

```tsx
                {(() => {
                  const target = fields.find((f) => f.name === m.fieldName);
                  return target?.type === "file" ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("workspace.import.map.fileHint")}
                    </p>
                  ) : null;
                })()}
```

- [ ] **Step 3:** `npx tsc --noEmit && npm run lint` — expected: no new issues.
- [ ] **Step 4:** `git add "app/(application)/data/[ctx]/components/import/step-review-grid.tsx" "app/(application)/data/[ctx]/components/import/step-map-columns.tsx" && git commit -m "feat(import): editable storage-key file cells and map-step file hint"`

---

### Task 9: Wizard integration — verification pass + blank-clears warning

**Files:**
- Modify: `app/(application)/data/[ctx]/components/import/import-wizard-dialog.tsx`

**Interfaces:**
- Consumes: `fileKeysOf`, `findMissingFileKeys`, `applyMissingFileErrors` from `@/lib/import/verify-files`; `filesApi` from `@/lib/api/files`.
- Produces: `verifyRows(input)` = classify → validate → storage-existence check, used by both `enterReview` and the blur handler; a blank-clears warning line above the grid.

(The match-files/leftovers removal already landed in Task 3.)

- [ ] **Step 1:** Add imports:

```ts
import { filesApi } from "@/lib/api/files";
import {
  applyMissingFileErrors,
  fileKeysOf,
  findMissingFileKeys,
} from "@/lib/import/verify-files";
```

- [ ] **Step 2:** Below `classifyAgainstServer`, add:

```ts
  const verifyRows = React.useCallback(
    async (input: ImportRow[]): Promise<ImportRow[]> => {
      const classified = await classifyAgainstServer(input);
      const keys = fileKeysOf(classified, fields);
      if (keys.length === 0) return classified;
      const missing = await findMissingFileKeys(keys, async (key) => {
        const res = await filesApi.object(key);
        return res?.$metadata?.httpStatusCode === 200;
      });
      return applyMissingFileErrors(classified, fields, missing);
    },
    [classifyAgainstServer, fields],
  );
```

- [ ] **Step 3:** In `enterReview`, change `setRows(await classifyAgainstServer(built));` to `setRows(await verifyRows(built));`. In `handleKeyCellBlur`, change `void classifyAgainstServer(rowsRef.current)` to `void verifyRows(rowsRef.current)` and extend the merge to also take the verified cells' file-cell errors — replace the merge callback body with:

```ts
      .then((verified) => {
        const byKey = new Map(verified.map((r) => [r.key, r]));
        setRows((prev) =>
          prev.map((row) => {
            const v = byKey.get(row.key);
            if (!v) return row;
            const cells = { ...row.cells };
            for (const f of fields) {
              if (f.type !== "file") continue;
              const verifiedCell = v.cells[f.name];
              const currentCell = cells[f.name];
              // Adopt verification outcome only when the cell wasn't edited
              // during the roundtrip (same raw).
              if (
                verifiedCell &&
                currentCell &&
                verifiedCell.raw === currentCell.raw
              ) {
                cells[f.name] = verifiedCell;
              }
            }
            return validateRow(
              {
                ...row,
                cells,
                action: v.action,
                targetItemId: v.targetItemId,
                error: v.error,
              },
              fields,
            );
          }),
        );
      })
```

- [ ] **Step 4:** Add the warning computation after `displayFields`:

```ts
  const hasBlankUpdateCells = React.useMemo(
    () =>
      rows.some(
        (row) =>
          row.action === "update" &&
          Object.values(row.cells).some(
            (c) => (c.value === null || c.value === "") && !c.file,
          ),
      ),
    [rows],
  );
```

and render it in the review step, directly above `<StepReviewGrid …>`:

```tsx
              {runner.phase === "edit" && hasBlankUpdateCells && (
                <p className="text-sm text-muted-foreground">
                  {t("workspace.import.review.blankClearsWarning")}
                </p>
              )}
```

- [ ] **Step 5:** `npx tsc --noEmit && npm run lint && npm test` — no new failures.
- [ ] **Step 6:** `git add "app/(application)/data/[ctx]/components/import/import-wizard-dialog.tsx" && git commit -m "feat(import): storage verification pass and blank-clears warning"`

---

### Task 10: Gates, prettier, final review handoff

- [ ] **Step 1:** `npm test && npm run lint && npx tsc --noEmit && npm run check-messages` — no new failures anywhere.
- [ ] **Step 2:** `npx prettier --check` every file this branch touched; `--write` + amend/commit any that fail (feature files must stay clean; do not reformat untouched pre-existing files).
- [ ] **Step 3:** `npm run build` — must succeed.
- [ ] **Step 4:** Whole-branch review (controller dispatches per SDD), then UAT handoff: two-zone exclusivity both directions, files flow end-to-end incl. multi-file-field select, CSV flow with pasted storage URLs (copy one from an existing item's file field), existence-check error on a typo'd key, example row visible in grid and removable, blank-clears warning on update rows, de locale.

---

## Self-Review Notes (applied)

- **Spec coverage:** two zones + exclusivity (T7), files-flow-always-grid (unchanged v1 behavior once mixing removed — T3/T7), URL/key coercion (T2), existence check (T5/T9), editable CSV file cells + placeholder + map hint (T8), example row (T4), blank-clears warning (T9), deletions (T3/T6), error-code delta (T2/T5/T6). Deferred items live in the spec only.
- **Compile-order hazard handled explicitly:** T3 carries the two mechanical wizard edits its signature change forces; T6's key removals are gated only by check-messages until T7 restores referent-free copy.
- **Type consistency:** `rowsFromCsv(parsed, mapping, fields)` used identically in T3 tests and T3/T9 wizard code; `verify-files` exports match T9's imports; `filesApi.object` returns `S3ObjectOutput` whose `$metadata.httpStatusCode` the probe checks (verified against `lib/api/files.ts:41-54`).
