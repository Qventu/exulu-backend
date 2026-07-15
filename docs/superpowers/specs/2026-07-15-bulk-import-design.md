# Bulk import for knowledge base items (CSV + file drop)

**Date:** 2026-07-15
**Status:** Approved design, pending implementation plan
**Repos:** frontend only (backend verified to need zero changes)

## Problem

Clients need to add or update many knowledge base items at once through the UI. Today the only paths are the single-item NewItemDialog or backend-defined pipeline Sources. The concrete client wish is "drop 50 PDFs into a drop area and get 50 items" — but knowledge bases are arbitrary `ExuluContext` instances (12 field types, possibly several file fields, enums, required fields), so a files-only flow cannot serve every context, and a CSV-only flow serves power users but not the 50-PDFs case.

## Decisions (from brainstorming with Daniel, 2026-07-15)

- **Scope:** bulk create **and** bulk update from day one.
- **Scale:** comfortable at ≤100 items per batch; not designed for thousands.
- **File source:** the user's local machine via the browser (drag-drop / file picker). A CSV column can never reference a local path directly — browsers cannot read arbitrary local paths — so files referenced from a CSV are matched by filename against files the user drops alongside.
- **Approach:** unified "Import" wizard where both file-drops and CSVs feed one editable review grid; import executes client-side over existing per-item GraphQL mutations. (A server-side BullMQ import job was considered and rejected for v1: more backend surface, enterprise-license gating on queues, unnecessary at ≤100 items. A CSV-only dialog was rejected as missing the client's primary use case.)

## The core concept

Both entry formats are just ways of filling rows in a staging grid whose columns derive from `context.fields` — the same metadata that already drives `ItemFormFields`. This is what makes the feature generic across every ExuluContext, including future ones.

## UX flow

Entry points: an **Import** button next to "New item" in the WorkspaceShell page header (`app/(application)/data/[ctx]/components/workspace-shell.tsx:88-93`) and in the items empty state. Opens a near-full-screen dialog with three steps.

### Step 1 — Add data

One dropzone (reuse `components/primitives/dropzone.tsx`) accepts everything; client-side triage splits `.csv` files (data sheets) from all other files (pending file assets).

- **Files only** (the 50-PDFs flow): each file becomes a row. Exactly one file field in the context → files land there automatically, `name` prefilled from filename. Multiple file fields → one dropdown per drop batch: "put these files into: [field]" (re-assignable per row in the grid). No file field → non-CSV files rejected with a friendly explanation.
- **CSV only:** rows come from the CSV via Step 2. A **Download template** link generates a CSV with headers: `id`, `external_id`, `name`, `description`, `tags`, plus every editable, non-calculated context field (file columns documented as "filename of a file you drop alongside").
- **CSV + files:** the CSV is the source of truth. File-column cells hold filenames, matched case-insensitively by basename against dropped files. Unmatched cells → row errors; leftover unmatched files → warning with one-click "add as new rows".

V1 accepts one CSV per import. No XLSX in v1 (Excel users save-as-CSV; the template nudges the format).

### Step 2 — Map columns (CSV only)

Each CSV column shows sample values and a target-field dropdown, auto-matched by header ≈ field name/label (case/underscore-insensitive). Columns can be ignored. Fields with `editable === false` or `calculated` are not offered (same rule as `NewItemDialog`).

### Step 3 — Review grid

Spreadsheet-like editable table (TanStack Table, already used via `primitives/data-table`): one row per item-to-be, per-cell controls by field type, per-row status badge (**create** / **update** / **error** + message), "apply to all" on column headers for constant values. Import is disabled until all rows are valid, with an "import only the N valid rows" escape hatch.

On run, the grid becomes a live progress view (per-row pending → uploading → saving → done/failed) with an overall progress bar and cancel.

## Data mapping and semantics

### Type coercion (pure TS module, unit-tested)

- `number`: accepts `1.5` and `1,5` when unambiguous (de locale ships); thousands separators rejected.
- `boolean`: `true/false/yes/no/ja/nein/1/0`, case-insensitive.
- `enum`: case-insensitive match against `enumValues`, stored canonically; no match → cell error.
- `date`: ISO 8601 preferred, `Date.parse` fallback; ambiguous formats (e.g. `03/04/2026`) rejected with a "use YYYY-MM-DD" hint. (Note: the frontend `ExuluFieldTypes` enum lacks `date`/`uuid` which exist backend-side; the grid handles them via the text fallback with validation, mirroring `FieldControl`'s fallback.)
- `json`/`code`: raw string; json must pass `JSON.parse`.
- `tags`: comma-separated string (existing convention).
- `file`: filename → dropped `File` object at match time → after upload, the `bucket/key` string stored in the `<name>_s3key` column, identical to single-item uploads. Uploaded keys follow the existing `_EXULU_` name-separator convention so `FileDataCard` renders names correctly.

### Create vs update

Per-row priority: `id` column value → **update** via `${ctx}_itemsUpdateOneById`; else `external_id` resolving to an existing item → **update**; else → **create** via `${ctx}_itemsCreateOne` with `source: "import"` (the `source` column is unvalidated text; `"manual"` is the current UI value — verified).

External-id resolution happens on entering the grid via the existing `${ctx}_itemsPagination` query with `filters: [{ external_id: { in: [...] } }]` and `limit` = batch size — the generated filter layer supports `in` (`src/graphql/utilities/convert-graphql-filter-operator-to-pg-query.ts:38-45`, `whereIn`) — and is re-run for rows whose `id`/`external_id` cells are edited in the grid, so create/update badges stay truthful. No new backend query.

Updates are **partial**: only mapped/filled columns are sent; unmapped fields keep current values. A blank cell in a *mapped* column clears that field — visible in the grid before running. Duplicate `id`/`external_id` within a batch → row error (no silent last-write-wins). A file cell on an update row replaces the s3key reference; the old S3 object is not deleted (same as manual edit today).

### Validation

Client-side per-cell validation by field type plus `required` (backend performs no runtime required-field validation, so the grid is the gate — same trust model as today's forms). `required`/`unique` already reach the frontend because `Context.fields` is `JSON` in the SDL (`src/graphql/schemas/index.ts:2226`) and the contexts resolver spreads the full field definition (`schemas/index.ts:1764`); only the frontend TS type `types/models/context.ts` needs the two properties declared.

## Execution and error handling

Client-orchestrated, ~4 rows in flight:

1. Upload any file cells via the existing Uppy-compatible presign endpoint (`/s3/sign` in `src/uppy/index.ts`) followed by a direct PUT — the same sign-then-PUT request pattern `lib/api/skills.ts` uses for its staged uploads; no hidden Uppy instance.
2. Fire the row's create/update mutation. Embedding + processor jobs trigger per item through the existing `postprocessUpdate` hooks (`src/graphql/mutations/index.ts:107-206`); their progress is visible via existing `job_results` polling UI.

A row failure (upload, mutation, or validation) marks the row failed inline and never halts the batch. Cancel stops issuing new rows; in-flight rows finish. `beforeunload` guard while running. End state: summary (*N created, M updated, K failed*) with **Retry failed rows** and **Download error report** (failed rows + error column as CSV, so users fix and re-import exactly what failed). A killed browser mid-run leaves valid, fully-processed items — re-runs are idempotent when rows carry `external_id`s.

## Backend changes

**None.** Verified during design:

- `in` filter on `external_id` exists in the generated pagination layer.
- `required`/`unique` already ship through the `JSON`-typed `Context.fields`.
- `source` is unvalidated text; `"import"` needs no backend accommodation.
- Presigned upload endpoints (`src/uppy/index.ts`) and per-context CRUD mutations cover the rest.

## Frontend architecture

New code:

- `app/(application)/data/[ctx]/components/import/` — `import-wizard-dialog.tsx` (host + stepper), `step-add-data.tsx`, `step-map-columns.tsx`, `step-review-grid.tsx`, `use-import-runner.ts` (concurrency-limited execution state machine).
- `lib/import/` — pure modules: `parse-csv.ts` (papaparse wrapper), `coerce.ts` (per-type coercion), `match-files.ts` (filename matching), `template.ts` (CSV template generation), `resolve-targets.ts` (create/update classification incl. duplicate detection).

Reused: `primitives/dropzone.tsx`, `primitives/data-table` (TanStack), route-local GraphQL documents in `app/(application)/data/queries.ts` (`CREATE_ITEM`, `UPDATE_ITEM`, `GET_ITEMS`), presigned-PUT pattern from `lib/api/skills.ts`, `context.fields` metadata.

New dependency: `papaparse` (frontend; backend already lists it, unused). No spreadsheet library.

## Permissions

The Import button renders exactly where "New item" renders — same RBAC. Update rows pass through the rights checks `_itemsUpdateOneById` already enforces; a row the user may not update fails as a normal row error.

## i18n

All strings under the `knowledge` namespace in `messages/en.json` and `messages/de.json`.

## Design system

shadcn/ui + existing primitives; brand styling per app tokens. No violet accents in any new visual treatment (Daniel's standing design preference) — use the existing neutral/brand palette of the data workspace.

## Testing

- Unit tests (frontend repo's existing setup) for `lib/import/*`: locale number coercion, enum casing, date rejection, filename matching incl. collisions, duplicate `external_id` detection, template generation, partial-update payload building.
- Manual UAT pass against (a) a multi-field context with enums + required fields + one file field, (b) a file-only context, (c) a context with two file fields: happy path, CSV+files matching, partial failure + retry, cancel mid-run, update-by-external_id.

## Out of scope (v1)

- XLSX parsing, multiple CSVs per import, paste-from-Excel into the grid.
- Server-side import job (BullMQ). The wizard's execution step is isolated in `use-import-runner.ts`, so a future server-side runner can replace it without UI rework.
- Deleting items via import, S3 object cleanup on file replacement, >100-item batches.
