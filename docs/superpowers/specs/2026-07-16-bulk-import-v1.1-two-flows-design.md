# Bulk import v1.1 — two distinct flows (files vs CSV)

**Date:** 2026-07-16
**Status:** Approved design (Daniel, during UAT of v1), pending implementation plan
**Supersedes parts of:** `2026-07-15-bulk-import-design.md` (entry step + file-column semantics)
**Repos:** frontend only (zero backend changes, preserved from v1)

## Problem (UAT feedback)

v1 unified file-drops and CSVs into one dropzone with filename-matching between CSV file columns and dropped files. Daniel's UAT verdict: the mixing is hard to understand — users can't tell which mode they're in, and "put a filename in the CSV, then also drop that file" is a confusing contract. The template also didn't show what values columns expect.

## Decisions

- **Two exclusive flows, two drop areas.** No CSV+files mixing, ever.
- **CSV file columns take this instance's storage URL or key** — referenced directly, never copied or downloaded.
- **External-URL fetching is deferred** (would require an SSRF-guarded backend download endpoint; browser-side fetching dies on CORS for most hosts). Also deferred: cross-instance references.
- **Files flow always shows the review grid** before import.

## Design

### Entry step: two zones

The single dropzone is replaced by two cards (side by side on desktop, stacked on mobile):

- **"Import files"** — rendered only when the context has ≥1 editable, non-calculated file field. Accepts any non-`.csv` files, multi-drop. Hint: one new item per file. When the context has multiple eligible file fields, the existing "put files into: [field]" select appears here.
- **"Import via CSV"** — always rendered. Accepts `.csv` only (a second CSV replaces the first, as today). Hint: columns become fields; "Download example CSV" link lives here.

**Exclusivity:** as soon as either zone has content, the other is disabled (reduced opacity, drop/click inert, helper line "Clear the files/CSV to switch"). Clearing content (existing remove buttons) re-enables the other zone. `Continue` proceeds with whichever zone has content: files → grid (map step skipped), CSV → map step → grid.

Dropping a `.csv` into the files zone or a non-CSV into the CSV zone is ignored by that zone's accept filter (existing Dropzone `accept` behavior).

### Files flow

Drop → (field select if multiple file fields) → **review grid, always** (name prefilled from filename without extension, required fields fillable, apply-to-all available) → import. Upload via the existing presigned `/s3/sign` + PUT flow at run time — unchanged from v1. File cells render as read-only chips (the dropped `File`).

### CSV flow: file columns hold a storage URL or key

**Accepted cell values** (coercion, `lib/import/coerce.ts` file case):

1. Blank → `null` (no file; on update rows this clears the field — see warning below).
2. `http(s)://…` URL → run through `extractS3KeyFromUrl` (already normalizes AWS virtual-hosted and path-style/MinIO URLs, decodes percent-encoding, strips query params — presigned links work). The result must look like a key (`bucket/key`, i.e. contain `/`); otherwise cell error `fileUrl`.
3. A raw key `bucket/key…` (contains `/`, no scheme) → accepted as-is.
4. Anything else → cell error `fileUrl` ("Must be this instance's storage URL or key").

**Existence check:** on entering the review grid (same async step as create/update classification), every unique file-cell key is verified via the existing `filesApi.object(key)` (POST `/s3/object` — exact-key head). Non-2xx (`$metadata.httpStatusCode !== 200` or request failure) → cell error `fileNotFound` on all cells holding that key. Capped concurrency (~5); ≤100 rows keeps this cheap. Note: keys the current user cannot access get flagged too — v1.1 rule is "you can only reference storage objects you can access", which matches the endpoint's rights model. Editing a file cell re-coerces immediately; existence re-verifies in the same pass as id/external_id re-classification (cell blur).

**Grid editing:** in CSV mode, file cells are editable text `Input`s (placeholder: "Storage URL or key") — paste a URL directly in the grid; it coerces to a key on change. Cells with a valid key display the key's human name (`split("_EXULU_").pop()`) as a `title` tooltip.

**Import:** CSV rows never upload anything — the coerced key is the stored value, sent as `<field>_s3key` exactly like v1. The runner's upload path is exercised only by the files flow.

**Blank-clears warning:** whenever ≥1 update row has a mapped-but-blank cell (any field type, not just files), a one-line notice renders above the grid: "Blank cells in mapped columns will clear those fields on updated items."

### Example CSV (template)

`buildCsvTemplate` gains a second row of per-type example values:

| type | example |
|---|---|
| id | *(blank)* |
| external_id | `example-id-123` |
| name | `Example item` |
| description | `Example description` |
| tags | `tag1,tag2` |
| shortText/text/longText/markdown/code | `Example text` |
| number | `1.5` |
| boolean | `true` |
| enum | first `enumValues` entry (blank if none) |
| date | `2026-07-16` |
| json | `{}` |
| uuid | *(blank)* |
| file | *(blank — the map-step hint and grid placeholder explain the URL/key contract)* |

Values are CSV-escaped like headers. The user overwrites or deletes the row; if forgotten, it appears in the grid where remove-row handles it — blocked by required-field validation where the context has required blank columns, and otherwise visibly named "Example item" so it stands out before import.

The map step's hint for file-typed targets becomes explicit: "Values must be this instance's storage URLs or keys."

### Deletions (v1 machinery retired)

- `lib/import/match-files.ts` + `lib/import/match-files.test.ts` (filename matching).
- `rowsFromCsv`'s `fileIndex` parameter and the `fileMissing` error path (replaced by `fileUrl`/`fileNotFound`).
- The leftover-files banner, `leftoverFiles` usage, duplicate-filename toast in the CSV path, and the `csvOnlyHint` gating (a context without file fields now simply shows only the CSV zone — the hint is obsolete).
- i18n keys that lose their referents are removed from both locales; new keys added (zone titles/hints, `errors.fileUrl`, `errors.fileNotFound`, `review.blankClearsWarning`, `review.filePlaceholder`), parity enforced by `check-messages`.

### Unchanged from v1

Classification (id > external_id > create), the execution runner (concurrency, cancel, retry, in-place row mutation contract), error report (file cells round-trip as URL/key text), template download mechanics, entry points, permissions-by-placement, beforeunload guard, i18n namespace conventions.

## Error codes (delta)

- Removed: `fileMissing`.
- Added: `fileUrl` ("Must be this instance's storage URL or key"), `fileNotFound` ("Not found in storage" — also covers access-denied).

## Testing

- `coerce.test.ts`: file-case rewrite — blank→null, AWS URL→key, MinIO/path-style URL→key, presigned URL with query params→key, raw `bucket/key` passthrough, scheme-less non-key text→`fileUrl`, URL that extracts to a keyless value→`fileUrl`.
- `rows.test.ts`: `rowsFromCsv` without `fileIndex`; file cells coerce to keys; `validateRow` unchanged except `allowedFileTypes` now checks the key/File name suffix in both modes.
- `template.test.ts`: example-row content per type, escaping, blank file/id/uuid cells.
- Removed: `match-files.test.ts`.
- UI verified by tsc/lint + a fresh UAT pass (two-zone exclusivity, files flow end-to-end, CSV flow with pasted storage URLs, existence-check errors, blank-clears warning).

## Out of scope

External-URL download (deferred; requires backend SSRF-guarded fetch endpoint), cross-instance file references, XLSX, batches >100, mixing flows.

## UAT amendments (2026-07-16, Daniel)

- **Apply-to-all removed.** The review-grid toolbar (field + value + apply button) is deleted, including its i18n keys — bulk constant-filling was judged not worth the surface.
- **Error display: visible, no native tooltips.** Invalid cells show their translated error as inline text under the control (plus the existing red border/aria-invalid); native `title` tooltips are gone from the grid. Row-status badges use the app's shadcn Tooltip instead of the system tooltip.
