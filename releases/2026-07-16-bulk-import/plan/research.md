# Research — Bulk Import Wizard (v1.1 two-flows + batch access)

Feature window: 2026-07-15 → 2026-07-22.
Specs: `backend/docs/superpowers/specs/2026-07-15-bulk-import-design.md`, `backend/docs/superpowers/specs/2026-07-16-bulk-import-v1.1-two-flows-design.md`, `frontend/docs/superpowers/specs/2026-07-21-bulk-import-rights-mode-design.md`.
Frontend commits: bulk import v1.1 (pushed ~2026-07-16), batch access: `6ec3802`, `c7f2d54` (2026-07-21), `55cfd7d` (footer layout), `398fea4` (read-only Access column, 2026-07-22).
All frontend paths below are relative to `/Users/daniel.claessen/Desktop/Projects/exulu/frontend`, backend paths to `/Users/daniel.claessen/Desktop/Projects/exulu/backend`.

## What shipped & why it matters

Until now, getting many items into an Exulu knowledge base through the UI meant one of two things: clicking through the single-item "New item" dialog fifty times, or asking an engineer to wire up a backend pipeline Source. The concrete client wish that drove this feature was "drop 50 PDFs into a drop area and get 50 items" (spec 2026-07-15, Problem section). The new **Import** button — sitting right next to "New item" in every knowledge-base workspace — opens a wizard that turns bulk data entry into a three-step flow: add data, map columns (CSV only), review & import. It works generically across every knowledge base because the review grid's columns are derived from the context's own field metadata (12 field types, enums, required fields, file fields) — the same metadata that already drives the single-item form.

There are **two distinct, mutually exclusive flows** (v1.1 decision after UAT showed that mixing them was confusing). **Import files**: drag any number of files into a dropzone and each file becomes one new item, with the name prefilled from the filename — the 50-PDFs case solved in seconds. **Import via CSV**: drop a spreadsheet, map its columns to fields with auto-matching, and each row becomes a create *or* an update — rows carrying an `id` or a matching `external_id` update existing items (partial updates: only mapped columns are touched), everything else creates new ones. Every import passes through a spreadsheet-like review grid with per-cell editing, per-cell validation errors shown inline, create/update badges per row, and a live progress view during the run (Pending → Uploading → Saving → Done/Failed per row). Failures never halt the batch; the end state offers "Retry failed rows" and a downloadable CSV error report containing exactly the rows that failed. Scale target: comfortable at ≤100 items per batch. Zero new backend surface was needed for the import itself — the wizard rides the existing per-context GraphQL mutations and presigned-upload endpoints.

The **batch access (rights mode) control** (2026-07-21/22) closes the follow-up gap: imported items used to always land private, forcing users to re-open each item and share it afterwards. Now the review step's footer has an "Access: Private" button that opens the full sharing control — private, shared with users/roles/teams (with read/write grants), or public — and the chosen access is applied to every *created* item in the batch. Update rows deliberately keep their existing access, echoed by a read-only "Access" column in the grid (create rows show the chosen mode; update rows show an em dash with an "Existing access is kept." tooltip). This required one small backend change: the generic `CreateOne` resolver now honors an explicitly provided, validated `rights_mode` instead of force-inserting `"private"`.

## UI reconstruction cues

### Entry point

`app/(application)/data/[ctx]/components/workspace-shell.tsx:92-95` — page-header action cluster of the knowledge workspace:

- Outline button: `Upload` lucide icon (`mr-2 size-4`) + label **"Import"** (`knowledge.workspace.import.trigger`), left of the primary button `Plus` icon + **"New item"**.
- Dialog mounted at `workspace-shell.tsx:147-151`.

### Dialog shell

`app/(application)/data/[ctx]/components/import/import-wizard-dialog.tsx` (608 lines).

- `DialogContent` classes: `flex max-h-[90dvh] w-[95vw] max-w-6xl flex-col gap-4` (line 366) — a near-full-screen dialog.
- Title (line 368-371): `"Import items"` + ` — ` + current step name. Step names (`en.json` `knowledge.workspace.import.steps`): **"Add data"**, **"Map columns"**, **"Review & import"**. So the visible title reads e.g. **"Import items — Add data"**.
- Description (line 372-374): **"Add or update many items at once from files or a CSV."**
- Steps are a state machine `"add" | "map" | "review"` (line 61); files flow skips "map".
- i18n: all strings in `messages/en.json` starting line 2614 (`knowledge.workspace.import`), German parity in `messages/de.json`.

### Step 1 — Add data (two zones)

`app/(application)/data/[ctx]/components/import/step-add-data.tsx`.

- Layout (lines 84-89): `grid grid-cols-1 gap-4`, plus `md:grid-cols-2` when both zones show. Each zone is a `<section>` with `flex flex-col gap-3 rounded-lg border border-input p-4`.
- **Files zone** (lines 90-177, only rendered when the context has ≥1 file field and no CSV is loaded):
  - `<h3 class="text-sm font-semibold">` **"Import files"**; hint `text-sm text-muted-foreground`: **"One new item per file"**.
  - Dropzone label: **"Drop files here, or click to browse"**.
  - After dropping: `text-sm font-medium` count **"{count} files ready to import"** (singular "# file"), ghost sm button **"Remove all"**, and a file list (`max-h-48 overflow-y-auto rounded-md border border-input`, rows `flex items-center gap-2 border-b border-input px-3 py-1.5 text-sm`) with per-file `X` icon-buttons (sr-only "Remove {name}").
  - Multiple file fields → Select labeled **"Put dropped files into"** (`SelectTrigger` width `w-56`).
  - When the CSV zone is hidden: helper line **"Clear the files to import via CSV instead"**.
- **CSV zone** (lines 179-244, hidden once files are dropped):
  - `<h3>` **"Import via CSV"**; hint: **"Columns become fields. File columns take a storage URL or key."**
  - Dropzone (accept `.csv`) label: **"Drop a CSV here, or click to browse"**.
  - Ghost sm button with `Download` icon (`mr-2 size-4`): **"Download CSV template"** — downloads `{contextId}-import-template.csv` incl. a second row of per-type example values (`Example item`, `1.5`, `true`, `2026-07-16`, `{}`, `tag1,tag2`…).
  - Loaded-CSV chip (lines 212-235): `flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm` with `FileSpreadsheet` icon (`size-4 text-muted-foreground`), text **"{name} — {count} rows"**, and an `X` remove button (sr-only "Remove CSV").
  - Parse warnings in `text-sm text-destructive`: **"CSV parsed with warnings: {errors}"**.
  - When the files zone is hidden: **"Remove the CSV to import files instead"**.
- Footer button (dialog, line 472-480): primary **"Continue"** — disabled until a zone has content.
- Dropzone primitive (`components/primitives/dropzone.tsx:182-190`): one big `<button>` — `flex min-h-24 w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-transparent px-4 py-6 text-center transition-colors duration-150`, hover `hover:border-muted-foreground/50 hover:bg-muted/40`, drag-active `border-primary bg-primary/5`. Contents: `Upload` icon `size-5 text-muted-foreground` above the label `text-sm font-medium text-foreground`.

### Step 2 — Map columns (CSV flow only)

`app/(application)/data/[ctx]/components/import/step-map-columns.tsx`.

- Hint above the table (`text-sm text-muted-foreground`): **"Rows with an id or a matching external_id update existing items; everything else creates new ones."**
- shadcn `Table` with three headers (lines 68-70): **"CSV column"** / **"Sample values"** / **"Import as"**.
- Each row: CSV header in `font-medium`; up to 2 sample values (`max-w-48 truncate text-muted-foreground`); a `Select` (`w-56`) targeting a field, auto-matched on entry (`autoMapColumns`, header ≈ field name/label). First option: **"Ignore"**. Already-used fields are disabled in other rows' dropdowns.
- File-typed target shows a sub-hint (`mt-1 text-xs text-muted-foreground`): **"Values must be this instance's storage URLs or keys"**.
- Footer: outline **"Back"** + primary **"Continue"**.

### Step 3 — Review & import (the grid)

`app/(application)/data/[ctx]/components/import/step-review-grid.tsx` (TanStack Table) + dialog wiring at `import-wizard-dialog.tsx:402-458`.

- Grid container: `min-h-0 flex-1 overflow-auto rounded-md border border-input`; header cells `whitespace-nowrap`; body cells `py-1.5 align-top`.
- Column order (line 390): status badge | **"Access"** | field columns | remove (`X` icon-button, sr-only "Remove row").
- Field column headers: `field.label` plus `" *"` when required (line 360). Core columns: `id`, `external_id`, `name`, `description`, `tags` (`lib/import/fields.ts:9-32`); plus every editable, non-calculated context field. Only columns with data (or required ones) display (`import-wizard-dialog.tsx:303-311`).
- **Status badges** (`StatusBadge`, lines 75-109): pill `inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium`. Tones: create/done `bg-secondary text-secondary-foreground`; update `border border-input text-foreground`; error/failed `bg-destructive/10 text-destructive`; muted (pending/skipped) `bg-muted text-muted-foreground`. Labels: **"Create"**, **"Update"**, **"Error"**, and during/after run **"Pending"**, **"Uploading"**, **"Saving"**, **"Done"**, **"Failed"**, **"Skipped"**. Error/failed badges get a shadcn Tooltip with the message (no native tooltips — UAT decision).
- **Access column** (lines 337-357, commit 398fea4): read-only, `text-sm text-muted-foreground`. Create rows echo the footer mode label (e.g. "Private"); update rows show **"—"** with tooltip **"Existing access is kept."**
- **Cell editors** (`CellEditor`, lines 111-255): text/number `Input` `h-8 min-w-28 text-sm` (`inputMode="decimal"` for numbers); boolean `Select` `h-8 w-24` with options "—" / "true" / "false"; enum `Select` `h-8 w-36` listing `enumValues` plus "—"; file cells in the files flow render a read-only chip `inline-flex max-w-44 items-center gap-1 truncate rounded-md border border-input px-2 py-0.5 text-xs` with `Paperclip` icon (`size-3`); file cells in the CSV flow are text `Input`s `h-8 min-w-36` with placeholder **"Storage URL or key"**. Invalid cells: `border-destructive` + `aria-invalid` + inline error line `text-xs text-destructive` under the control. Editing `id`/`external_id`/file cells re-verifies against the server on blur.
- Cell error messages (`en.json` `…import.errors`): **"Use true/false, yes/no or 1/0"**, **"Use the YYYY-MM-DD format"**, **"Duplicate {field} in this import"**, **"Must be one of: {values}"**, **"Not found in storage"**, **"Allowed file types: {values}"**, **"Must be this instance's storage URL or key"**, **"No item with this id exists"**, **"Not valid JSON"**, **"Not a number — use a dot decimal like 1.5"**, **"Ambiguous number — use a dot decimal like 1.5"**, **"{field} is required"**, **"Not a valid UUID"**.
- Blank-clears notice above the grid (`import-wizard-dialog.tsx:440-444`, `text-sm text-muted-foreground`): **"Blank cells in mapped columns will clear those fields on updated items."**

### Review footer (edit phase) — `import-wizard-dialog.tsx:491-564`

Layout (commit 55cfd7d): `flex w-full flex-wrap items-center justify-between gap-2` — Access control far left, nav cluster right.

- **Access popover trigger** (left): outline button, `Lock` icon `mr-2 size-4`, label **"Access: {mode}"** — modes: **"Private" / "Users" / "Roles" / "Teams" / "Public"** (`MODE_LABEL_KEY`, `item-access-section.tsx:37-43`; `en.json` `knowledge.workspace.access`).
- Popover (`align="start"`, `max-h-[60vh] w-[420px] overflow-y-auto`) hosts the full `RBACControl` (`components/rbac.tsx`): label **"Visibility & sharing"** (rbac.tsx:191); visibility options (rbac.tsx:38-44): **"Private"** (Lock, "Only you can see this imported item"), **"Shared with Users"** (Users), **"Shared with Roles"** (Settings), **"Shared with Teams"** (Building2), **"Public"** (Globe); grant pickers **"Share with users"** ("Search users by email..."), **"Share with roles ({n})"**, **"Share with teams ({n})"**, each grant with a Read/Write select. `subjectLabel` = "imported item".
- When the batch contains update rows and mode ≠ private, muted hint inside the popover: **"Applies to newly created items only."**
- Right cluster: `text-sm text-muted-foreground` counter **"{valid} of {total} rows ready"**; outline **"Back"**; primary import button — **"Import {count} items"** when all rows valid ("Import # item" singular), else **"Import {count} valid rows"**. Disabled at 0 valid rows or while verifying.
- Batch access defaults to the context's `configuration.defaultRightsMode ?? "private"` (`import-wizard-dialog.tsx:96-104`).

### Run + done phases — `import-wizard-dialog.tsx:404-439, 566-603`

- Progress row: shadcn `Progress` bar `h-2 flex-1`, right-hand text `whitespace-nowrap text-sm text-muted-foreground` — running: **"Imported {done} of {total}…"**; done: **"{created} created, {updated} updated, {failed} failed"**, appending **" · {count} rows skipped"** when rows were skipped.
- All-success: `CheckCircle2` icon `size-4 shrink-0 text-emerald-600 dark:text-emerald-500` next to the bar.
- While running: outline **"Cancel import"** (in-flight rows finish); dialog can't be closed; `beforeunload` guard.
- Done: outline **"Download error report"** (only when failures; saves `{contextId}-import-errors.csv` with an error column), primary **"Retry failed rows"** (or "Import {count} valid rows" for rows fixed after the run), outline **"Close"**.
- Rows run with concurrency 4 (`use-import-runner.ts:64`); per-row status streams into the grid badges live.

### Icons & colors summary

- Lucide icons: `Upload` (trigger + dropzone), `Plus` (New item), `Download` (template), `FileSpreadsheet` (CSV chip), `X` (remove), `Paperclip` (file chip), `Lock` (access button), `CheckCircle2` (success), and in RBACControl: `Lock`, `Users`, `Settings`, `Building2`, `Globe`.
- Colors are all shadcn/token-based (no hard-coded hues except the success check `text-emerald-600`): `border-input`, `bg-secondary`, `bg-muted`, `bg-destructive/10 text-destructive`, `text-muted-foreground`, drag-active `border-primary bg-primary/5`. Per the design spec: brand petrol/teal app tokens, explicitly **no violet accents**.

## Developer surfaces

No new public REST or GraphQL surface was added for import itself — the wizard is a pure client orchestration over pre-existing endpoints ("Backend changes: **None.**", spec 2026-07-15:79-86). `backend/src/exulu/routes.ts` contains no bulk-import routes (verified by grep). What the wizard actually calls:

### GraphQL (dynamic per-context operations, route-local docs in `app/(application)/data/queries.ts`)

- `CREATE_ITEM` (`queries.ts:377-389`) — one per created row (`use-import-runner.ts:50-55`):
  ```graphql
  mutation CreateOne${context}($input: ${context}_itemsInput!) {
    ${context}_itemsCreateOne(input: $input) { item { id name description } job }
  }
  ```
  Input = mapped cells + `source: "import"` (`lib/import/rows.ts:111-125`) merged with batch access via `mergeBatchAccess(input, access)` (`lib/import/rows.ts:159-180`): always `rights_mode`; `RBAC: { users, roles, teams }` only for grant modes.
- `UPDATE_ITEM` (`queries.ts:425-434`) — one per update row:
  ```graphql
  mutation UpdateOneById${context}($id: ID!, $input: ${context}_itemsInput!) {
    ${context}_itemsUpdateOneById(id: $id, input: $input) { item { id } job }
  }
  ```
  Partial input: only mapped/filled cells; `id`, `source`, `rights_mode`/`RBAC` never sent (`rows.ts:137`, spec decision #2).
- Create/update classification lookups (`import-wizard-dialog.tsx:143-195`): `GET_ITEMS_BY_IDS` (`queries.ts:290-302`) and `GET_ITEMS_BY_EXTERNAL_IDS` (`queries.ts:304-315`) — both hit `${context}_itemsPagination` with `filters: [{ id | external_id: { in: $ids } }]`.

### REST (existing file endpoints, Express app in `backend/src/uppy/index.ts`)

- `POST /s3/sign` (`src/uppy/index.ts:849-851`, handler `signOnServer` 778-844) — body `{ filename, type }` (Bearer token or `exulu-api-key` header) → `{ key, url, method: "PUT" }` (lines 838-841); keys are `${uuid}-_EXULU_${filename}` (line 776), user-prefixed. The client then PUTs the file bytes to the presigned `url` (`lib/import/upload.ts` — files flow only).
- `POST /s3/object` (`src/uppy/index.ts:574`) — body `{ key }` → exact-key head; the wizard treats `$metadata.httpStatusCode === 200` as "exists" (`import-wizard-dialog.tsx:202-206`, client `lib/api/files.ts:41-54`). Used to verify CSV storage URL/key file cells.

### Backend change shipped for batch access

`backend/src/graphql/mutations/index.ts` (on `develop`):

- `VALID_RIGHTS_MODES = ["private", "users", "roles", "teams", "public"]` (line 29).
- `CreateOne` now validates an explicit `input.rights_mode` (lines 529-533, invalid → `Invalid rights_mode "…" — expected one of: …`) and inserts `rights_mode: input.rights_mode ?? "private"` (line 541) instead of always forcing private. Absent still means private; `CopyOneById` intentionally keeps forcing private.

## Demo-worthy moments

1. **50 files → 50 items (the hero flow).** Knowledge workspace with the "Import" button next to "New item". Click Import → "Import items — Add data" with the two cards ("Import files" / "Import via CSV"). A pile of PDFs drops onto "Drop files here, or click to browse" → CSV card disappears, list shows "50 files ready to import". Click "Continue" → straight to "Review & import": 50 rows, every one badged "Create", names prefilled from filenames. Click "Import 50 items" → badges flip Pending → Uploading → Saving → Done as the progress bar fills → green check, "50 created, 0 updated, 0 failed".
2. **CSV with smart column mapping.** Drop a CSV on the "Import via CSV" card → chip "products.csv — 40 rows" → Continue → "Map columns" table: CSV headers on the left, sample values in the middle, "Import as" dropdowns already auto-matched on the right; flip one stray column to "Ignore" → Continue → grid shows a mix of "Create" and "Update" badges (the hint said it: rows with an id or matching external_id update, everything else creates).
3. **Fix errors in the grid, import only what's valid.** Review grid with a few red cells: an enum cell "Must be one of: …", a number cell "Not a number — use a dot decimal like 1.5", counter reads "38 of 40 rows ready" and the button says "Import 38 valid rows". Click into a red cell, type the fix → error clears, badge flips from "Error" to "Create", counter ticks up. After a run with failures: "Retry failed rows" + "Download error report".
4. **Share the whole batch in one move (batch access).** Review footer, left side: button "Access: Private" with a lock icon. Click → "Visibility & sharing" popover → pick "Shared with Teams", add a team with Write → button now reads "Access: Teams" and every Create row's read-only "Access" column says "Teams", while an Update row shows "—" (tooltip: "Existing access is kept."). Import → items land already shared, no per-item cleanup.

## Flags / requirements

- **No feature flags.** The Import button and wizard render unconditionally wherever "New item" renders; no env var or flag gates them (grep across the wizard + `workspace-shell.tsx` shows none; the `KNOWLEDGE_*` schema-gating constants in `app/(application)/data/queries.ts` don't touch import).
- **Permissions:** permissions-by-placement — same RBAC as the "New item" button (spec 2026-07-15:99-101). Update rows pass through the rights checks `_itemsUpdateOneById` already enforces (`backend/src/graphql/mutations/index.ts:286-370`); a row the user may not update fails as a normal row error. CSV file references are limited to storage objects the user can access (the `/s3/object` check runs under the caller's auth).
- **Backend requirements:** file endpoints require `config.fileUploads` to be configured (`src/uppy/index.ts:575-577, 779-781` throw "File uploads are not configured" otherwise) — files flow and CSV file-column verification depend on it. Batch access requires the backend `develop` build containing the `CreateOne` rights_mode change (`mutations/index.ts:526-541`); on older backends the mode is silently forced private.
- **Versions/status:** v1.1 frontend was pushed to `origin/main` (547c800, 2026-07-16). The batch-access commits (`6ec3802`, `c7f2d54`, `55cfd7d`, `398fea4`) and the backend rights_mode change are merged locally (frontend `main`, backend `develop`) but per project memory not yet pushed/UAT'd as of 2026-07-22.
- **Known limits (out of scope, spec'd):** ≤100 items per batch, no XLSX, one CSV per import, no external-URL fetch (deferred pending an SSRF-guarded backend endpoint), no cross-instance file references, no per-row rights columns.
