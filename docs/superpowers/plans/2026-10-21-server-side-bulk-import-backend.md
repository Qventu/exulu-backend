# Server-side Bulk Import — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An `import` job type that streams a CSV from S3 into a context (create or partial update per row, batch access on creates, per-row write checks on updates), started and cancelled through two per-context GraphQL mutations, with progress, result and an error CSV in `job_results`.

**Architecture:** A pure import module under `src/exulu/import/` (ported coercion/validation rules, a streaming CSV reader, the chunked run loop with injected dependencies, start/cancel logic with injected db/queue), wired into the existing worker dispatch (`ee/workers.ts`), the system queues (`ExuluApp`), the per-context SDL/resolvers and the job_results pruner.

**Tech Stack:** TypeScript, BullMQ, knex/Postgres, `csv-parse` (streaming), AWS SDK S3 (`GetObjectCommand` stream), jest (`npm test -- <file>`), module mocks via hoisted `jest.mock` factories as in `src/exulu/email-inbound/intake.test.ts`.

**Spec:** `docs/superpowers/specs/2026-10-21-server-side-bulk-import-design.md`

## Global Constraints

- Every exported function in `src/exulu/import/` takes its I/O as injected dependencies (`db`, `queue`, `s3`, `createItem`, `updateItem`, `now`, `log`) so it is unit-testable without Redis, Postgres or S3.
- Chunk size `IMPORT_CHUNK_ROWS = 500`; write pool `IMPORT_WRITE_CONCURRENCY = 8`; progress tick every chunk or `IMPORT_PROGRESS_INTERVAL_MS = 10_000`, whichever first.
- `job_results` row for an import: `type: "import"`, `context: <contextId>`, `label: "Import <fileName>"`, `trigger: "ui" | "api"`, `trigger_metadata` = `{ s3Key, fileName, mapping, access, options, user }`, `metadata` = `{ total, processed, created, updated, failed, invalid, cancelRequested?, errorReportKey? }`, `result` (final) = `{ total, processed, created, updated, failed, invalid, durationMs, errorReportKey }`.
- Queue name `global_queues.import = "import"`, `{ worker: 1, queue: 1 }`, concurrency 1, timeout `6 * 3600`; job data `{ type: "import", jobResultId, context, user?, role? }`, BullMQ `jobId = jobResultId`, `attempts: 1`.
- Mapping is `Array<{ header: string; fieldName: string | null }>` (null = ignore); header matching uses the ported `normalizeHeader` (lowercase, trim, `[\s-]+` → `_`).
- `s3Key` has the `bucket/key` form the frontend stores; the bucket must equal `config.fileUploads.s3Bucket` (`IMPORT_S3_KEY_OUTSIDE_BUCKET` error otherwise).
- Error CSV: original columns + `import_error`, UTF-8 with BOM, uploaded to `imports/<contextId>/<jobResultId>-errors.csv` (relative to the configured upload prefix) via the existing `uploadFile`.
- Commit messages: conventional, lowercase (`feat:`, `test:`, `fix:`, `docs:`), one commit per task.
- Do not change the behaviour of `CreateOne`, `UpdateOneById`, `ExecuteSource` or the existing worker branches.

## Review Focus

1. A CSV cell with an embedded newline or a doubled quote must survive the streaming parser — test in Task 2 (`streamCsvRows`).
2. A file whose header maps to no field (or lacks `name`/`external_id`/`id` for every row) must fail the job fast with a clear message, not import nothing silently — test in Task 3 (`runImport`).
3. An update row the stored user may not write must be counted `failed` with `"no write access"` and must not be written — test in Task 3 (`runImport`).
4. Cancel mid-run stops at the next row boundary, keeps the rows already written and ends in `state: "cancelled"` (never overwritten to `completed` by the worker's completed handler) — tests in Task 3 (`runImport`) and Task 4 (worker branch CAS).
5. An `s3Key` outside the platform bucket is refused by `StartImport` before anything is enqueued — test in Task 5 (`startImport`).

---

### Task 1: Port the wizard's mapping, coercion and validation rules

**Files:**
- Create: `src/exulu/import/mapping.ts`, `src/exulu/import/coerce.ts`, `src/exulu/import/rows.ts`, `src/exulu/import/fixtures/coercion-cases.json`
- Test: `src/exulu/import/mapping.test.ts`, `src/exulu/import/coerce.test.ts`, `src/exulu/import/rows.test.ts`

**Interfaces:**
- Consumes: nothing from the repo except types (`ExuluContextFieldDefinition` from `@EXULU_TYPES`).
- Produces:

```ts
// mapping.ts
export type ColumnMapping = { header: string; fieldName: string | null };
export type ImportField = { name: string; label?: string; type: string; required?: boolean; core?: boolean; enumValues?: string[] };
export function normalizeHeader(value: string): string;                                 // port of frontend/lib/import/map-columns.ts
export function autoMapColumns(headers: string[], fields: ImportField[]): ColumnMapping[];
export function importFieldsFor(fields: ExuluContextFieldDefinition[]): ImportField[];   // built-ins id, external_id, name (required), description, tags + context fields, minus calculated/hidden/file
export function resolveMapping(headers: string[], fields: ImportField[], given?: ColumnMapping[]): { byIndex: Array<string | null>; unknownFields: string[] }; // given mapping validated against headers/fields; missing → autoMapColumns
// coerce.ts
export type CellError = { code: string; params?: Record<string, string> };
export type ImportCell = { raw: string; value: string | number | boolean | null; error?: CellError };
export function coerceValue(field: ImportField, raw: string): ImportCell;                 // port of frontend/lib/import/coerce.ts (number, boolean, enum, date, textual); file fields are not importable here
// rows.ts
export type ImportRow = { index: number; cells: Record<string, ImportCell>; errors: string[] };
export function buildRow(index: number, cells: string[], byIndex: Array<string | null>, fields: ImportField[]): ImportRow; // coerce every mapped cell, required-field errors as "required:<field>"
export function rowIsValid(row: ImportRow): boolean;
export function rowAction(row: ImportRow): { action: "update"; by: "id" | "external_id"; key: string } | { action: "create" };
export function buildCreateInput(row: ImportRow, access: BatchAccess): Record<string, unknown>;   // mapped values + rights_mode/RBAC from access (port of mergeBatchAccess)
export function buildUpdateInput(row: ImportRow): Record<string, unknown>;                        // mapped values only, never rights_mode/RBAC/created_by
export type BatchAccess = { rights_mode: "private" | "users" | "roles" | "teams" | "public"; users?: Array<{ id: number; rights: "read" | "write" }>; roles?: Array<{ id: string; rights: "read" | "write" }>; teams?: Array<{ id: string; rights: "read" | "write" }> };
```

The fixture `coercion-cases.json` is an array of `{ field: { name, type, enumValues? }, raw, expect: { value } | { error } }` extracted from `frontend/lib/import/coerce.test.ts` (same cases; the frontend plan makes its test consume the same file). Minimum cases: `"1,5"` → 1.5; `"1,500"` → error `numberAmbiguous`; `"1.5,2"` → error `number`; `"ja"` → true; `"nein"` → false; enum case-insensitive match; `"2026-10-21"` → date ok; `"21.10.2026"` → error `date`; `""` on number → null; `""` on text → `""`.

- [ ] **Step 1: Write the failing tests**

```ts
// mapping.test.ts
expect(normalizeHeader(" Description_Long-de_ch ")).toBe("description_long_de_ch");
expect(autoMapColumns(["Item Number", "brand", "unknown"], [{ name: "item_number", type: "shortText" }, { name: "brand", type: "shortText" }]))
  .toEqual([{ header: "Item Number", fieldName: "item_number" }, { header: "brand", fieldName: "brand" }, { header: "unknown", fieldName: null }]);
expect(resolveMapping(["a", "b"], [{ name: "a", type: "text" }], [{ header: "a", fieldName: "a" }, { header: "b", fieldName: "nope" }]))
  .toEqual({ byIndex: ["a", null], unknownFields: ["nope"] });
expect(importFieldsFor([{ name: "report", type: "text", calculated: true }, { name: "x", type: "shortText" }]).map((f) => f.name))
  .toEqual(["id", "external_id", "name", "description", "tags", "x"]);
// coerce.test.ts — every fixture case
for (const c of cases) { const cell = coerceValue(c.field, c.raw); if ("error" in c.expect) expect(cell.error?.code).toBe(c.expect.error); else expect(cell.value).toEqual(c.expect.value); }
// rows.test.ts
const fields = [{ name: "name", type: "shortText", required: true, core: true }, { name: "external_id", type: "text", core: true }, { name: "qty", type: "number" }];
const row = buildRow(3, ["Shoe", "X1", "1,5"], ["name", "external_id", "qty"], fields);
expect(rowIsValid(row)).toBe(true); expect(rowAction(row)).toEqual({ action: "update", by: "external_id", key: "X1" });
expect(buildUpdateInput(row)).toEqual({ name: "Shoe", external_id: "X1", qty: 1.5 });
expect(buildCreateInput(row, { rights_mode: "public" })).toEqual({ name: "Shoe", external_id: "X1", qty: 1.5, rights_mode: "public" });
expect(rowIsValid(buildRow(4, ["", "X2", "abc"], ["name", "external_id", "qty"], fields))).toBe(false);
expect(buildRow(4, ["", "X2", "abc"], ["name", "external_id", "qty"], fields).errors).toEqual(["required:name", "qty:number"]);
expect(rowAction(buildRow(5, ["N", "", ""], ["name", "external_id", "qty"], fields))).toEqual({ action: "create" });
```

- [ ] **Step 2: Run them to verify they fail** — `npm test -- src/exulu/import` → FAIL (modules not found)
- [ ] **Step 3: Implement the three modules and the fixture**
- [ ] **Step 4: Run to verify they pass** — `npm test -- src/exulu/import` → PASS
- [ ] **Step 5: Commit** — `git add src/exulu/import && git commit -m "feat: import rules module (mapping, coercion, rows) ported from the wizard"`

---

### Task 2: Streaming CSV reader

**Files:**
- Create: `src/exulu/import/csv-stream.ts`
- Test: `src/exulu/import/csv-stream.test.ts`

**Interfaces:**
- Produces:

```ts
export type CsvStreamHandlers = { onHeader: (headers: string[]) => void | Promise<void>; onRow: (cells: string[], index: number) => void | Promise<void> };
export async function streamCsvRows(input: NodeJS.ReadableStream, handlers: CsvStreamHandlers, opts?: { delimiter?: string }): Promise<{ rows: number }>;
```

Built on `csv-parse` (`bom: true, relax_quotes: true, relax_column_count: true, skip_empty_lines: true, columns: false`); the parser is paused while `onRow` awaits (back-pressure); header = first record, trimmed; `index` is 0-based over data rows; blank rows skipped.

- [ ] **Step 1: Write the failing test** — Readable from `"﻿a,b\n1,\"x\ny\"\r\n2,\"he said \"\"hi\"\"\"\n,,\n"`:
  `headers` → `["a","b"]`; rows → `[["1","x\ny"],["2",'he said "hi"']]`; result `{ rows: 2 }`; `onRow` awaited in order (an `await setTimeout(1)` inside records `[0,1]`).
- [ ] **Step 2: Run to verify it fails** — `npm test -- src/exulu/import/csv-stream` → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify it passes**
- [ ] **Step 5: Commit** — `git commit -m "feat: streaming csv reader for server-side import"`

---

### Task 3: The run loop

**Files:**
- Create: `src/exulu/import/run-import.ts`
- Test: `src/exulu/import/run-import.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:

```ts
export type ExistingRow = { id: string; external_id: string | null; rights_mode: string | null; created_by: string | null; RBAC?: unknown };
export type RunImportDeps = {
  stream: NodeJS.ReadableStream;
  fields: ImportField[];
  mapping?: ColumnMapping[];
  access: BatchAccess;
  options: { skipEmbeddings?: boolean };
  user: { id: number; super_admin?: boolean; role?: unknown };
  lookupExisting: (ids: string[], externalIds: string[]) => Promise<ExistingRow[]>;
  canWrite: (existing: ExistingRow) => boolean;                 // D13: port of validateWriteAccess' per-record rules (public, private+creator, creator, RBAC users/roles/teams with write)
  createItem: (input: Record<string, unknown>) => Promise<void>;
  updateItem: (id: string, input: Record<string, unknown>) => Promise<void>;
  writeProgress: (m: ProgressMetadata) => Promise<void>;
  isCancelRequested: () => Promise<boolean>;
  uploadErrorReport: (csv: string) => Promise<string>;          // returns the s3 key
  now?: () => number; log?: (m: string) => void;
  chunkRows?: number; concurrency?: number; progressIntervalMs?: number;
};
export type ProgressMetadata = { total: number | null; processed: number; created: number; updated: number; failed: number; invalid: number };
export type RunImportResult = ProgressMetadata & { durationMs: number; errorReportKey: string | null; cancelled: boolean };
export class ImportAbort extends Error { code: "NO_MAPPABLE_COLUMNS" | "EMPTY_FILE" }
export async function runImport(deps: RunImportDeps): Promise<RunImportResult>;
```

Loop: `streamCsvRows` → header → `resolveMapping`; abort `NO_MAPPABLE_COLUMNS` when every entry is null or `name` is unmapped and no `id`/`external_id` column exists; rows are buffered up to `chunkRows`, then: invalid rows → `invalid++` + error line; `lookupExisting` for the chunk's ids/external_ids; per row in a pool of `concurrency`: existing → `canWrite` ? `updateItem` (`updated++`) : `failed++` with `"no write access"`; not existing → `createItem` (`created++`); any throw → `failed++` with the message; after each chunk (or when `progressIntervalMs` elapsed): `writeProgress`, then `isCancelRequested()` → stop with `cancelled: true`. Error lines are collected `[...originalCells, message]` and uploaded as CSV with the original header + `import_error` when any exist. `EMPTY_FILE` when no header.

- [ ] **Step 1: Write the failing tests** (fixtures: a 3-field context `name*`, `external_id`, `qty`; a `deps()` helper with recording fakes):
  - create vs update: rows X1 (existing, public), X2 (new) → `created 1, updated 1`, `updateItem` called with `("id-X1", { name, external_id, qty })`, `createItem` with access merged.
  - Review Focus 3: existing private row created by user 9, user 7 → `failed 1`, `updateItem` not called, error line contains `no write access`.
  - Review Focus 2: header `["foo","bar"]` with no mappable field → rejects with `ImportAbort` code `NO_MAPPABLE_COLUMNS`; empty input → `EMPTY_FILE`.
  - invalid row (`qty: "abc"`) → `invalid 1`, error line `qty:number`, not written.
  - Review Focus 4: `isCancelRequested` returns true after the first chunk (chunkRows 2, 5 rows) → `processed 2`, `cancelled true`, only 2 writes.
  - progress: chunkRows 2, 5 rows → `writeProgress` called 3 times with increasing `processed` (2, 4, 5).
  - pool: concurrency 2, 6 rows whose `createItem` resolves after `setTimeout(5)` → at most 2 in flight (count via counters inside the fake).
  - error report: 2 bad rows → `uploadErrorReport` receives `"﻿name,external_id,qty,import_error\n..."`; `errorReportKey` set; no bad rows → not called, key null.
- [ ] **Step 2: Run to verify they fail** — `npm test -- src/exulu/import/run-import` → FAIL
- [ ] **Step 3: Implement `run-import.ts`** (a small in-file promise pool; `csv-parse` back-pressure through the awaited `onRow`)
- [ ] **Step 4: Run to verify they pass**
- [ ] **Step 5: Commit** — `git commit -m "feat: chunked import run loop with create/update, access checks, progress and error report"`

---

### Task 4: Queue, worker branch, pruning exemption, S3 stream

**Files:**
- Modify: `ee/queues/queues.ts` (`global_queues.import`), `src/exulu/app/index.ts` (register next to `email_intake`: `{ worker: 1, queue: 1 }, 1, 6 * 3600`), `types/queue-config.ts` (job data variant), `ee/workers.ts` (branch), `ee/queues/prune-job-results.ts`, `src/uppy/index.ts` (`getS3ObjectStream`)
- Create: `src/exulu/import/worker-deps.ts` (builds `RunImportDeps` from db/config/context/jobResult: `lookupExisting` via knex on `<context>_items` selecting `id, external_id, rights_mode, created_by, RBAC`; `canWrite` port of `validateWriteAccess` lines 365–430 of `mutations/index.ts`; `createItem` → `context.createItem(input, config, user, role, false, options.skipEmbeddings ? false : undefined)`; `updateItem` → `context.updateItem({ id, ...input }, config, user, role, options.skipEmbeddings ? false : undefined)`; `writeProgress` → `db("job_results").where({ id }).update({ metadata: JSON.stringify({ ...prev, ...m }) })` preserving `cancelRequested`; `isCancelRequested` → read `metadata.cancelRequested`; `uploadErrorReport` → `uploadFile(Buffer, key, "text/csv", user)`)
- Test: `src/exulu/import/worker-deps.test.ts` (canWrite rules; progress merge keeps `cancelRequested`), `ee/queues/prune-job-results.test.ts` (extend or create: import rows are not in the generic prune; per-context cap 200)

**Worker branch** (`ee/workers.ts`, after the `source` branch): load the `job_results` row by `data.jobResultId`; `upsertJobStart(db, bullmqJob, row.label, "import")`; 25 s heartbeat like the processor branch; `runImport(buildWorkerDeps(...))`; on `ImportAbort` → throw (the failed handler records it); when `result.cancelled` → `casJobResultState(db, row.id, [active], cancelled)` then return `{ result, metadata: result }` (the completed handler's CAS on `active` no longer matches, so `cancelled` stays — Review Focus 4); otherwise return `{ result, metadata: result }`.

**Prune** (`prune-job-results.ts`): the generic boundary query and delete gain `.whereNot({ type: "import" })`; a second step keeps the newest 200 `type = "import"` terminal rows per `context` (knex: delete where id in (select id … row_number() over (partition by context order by createdAt desc) > 200) — Postgres only is fine; guard with the dialect check the module already uses, else skip).

- [ ] **Step 1: Write the failing tests** (canWrite: public → true; private + creator → true; private + other → false; rbac users write → true; super_admin → true. prune: with a fake db record calls and assert the generic delete has `whereNot type import` and the import cap query exists)
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement all files**
- [ ] **Step 4: Run the tests and `npm run build`** (or the repo's typecheck script) → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat: import job type, system queue, worker branch and job_results retention"`

---

### Task 5: Start and cancel logic + GraphQL wiring

**Files:**
- Create: `src/exulu/import/start-import.ts`
- Test: `src/exulu/import/start-import.test.ts`
- Modify: `src/graphql/schemas/index.ts` (SDL for items tables), `src/graphql/mutations/index.ts` (two resolvers)

**Interfaces:**

```ts
export type StartImportArgs = { contextId: string; s3Key: string; fileName: string; mapping?: ColumnMapping[]; access: BatchAccess; options?: { skipEmbeddings?: boolean }; trigger: "ui" | "api"; totalRows?: number };
export type StartImportDeps = { db: any; config: ExuluConfig; queue: { add: (name: string, data: unknown, opts: unknown) => Promise<{ id?: string }>; getJob?: (id: string) => Promise<{ remove: () => Promise<void> } | undefined> }; user: { id: number; super_admin?: boolean; role?: { id?: string } }; contextExists: (id: string) => boolean; now?: () => Date; uuid?: () => string };
export class StartImportError extends Error { code: "CONTEXT_NOT_FOUND" | "IMPORT_ALREADY_RUNNING" | "IMPORT_S3_KEY_OUTSIDE_BUCKET" | "NOT_AUTHORIZED" }
export async function startImport(deps: StartImportDeps, args: StartImportArgs): Promise<{ jobResultId: string }>;
export async function cancelImport(deps: StartImportDeps, jobResultId: string): Promise<{ ok: true }>;
```

`startImport`: context must exist; `s3Key.split("/")[0] === config.fileUploads.s3Bucket` else `IMPORT_S3_KEY_OUTSIDE_BUCKET`; `IMPORT_ALREADY_RUNNING` when `db("job_results").where({ context, type: "import" }).whereIn("state", ["waiting","active"]).first()` exists; insert the row (Global Constraints) with `id = uuid()`, `job_id = id`, `state: "waiting"`; `queue.add("import", { type: "import", jobResultId: id, context, user: user.id, role: user.role?.id }, { jobId: id, attempts: 1, removeOnComplete: 5000, removeOnFail: 5000 })`. `cancelImport`: row must exist and be `waiting`/`active`; caller must be the starter (`trigger_metadata.user === user.id`) or `super_admin`, else `NOT_AUTHORIZED`; set `metadata.cancelRequested = true`; if `waiting`, `queue.getJob(id)?.remove()` and set `state: "cancelled"`.

SDL (items tables only), next to `ExecuteSource`:
```graphql
input StartImportMappingInput { header: String!, fieldName: String }
input StartImportAccessInput { rights_mode: String!, users: JSON, roles: JSON, teams: JSON }
input StartImportOptionsInput { skipEmbeddings: Boolean }
input StartImportInput { s3Key: String!, fileName: String!, mapping: [StartImportMappingInput!], access: StartImportAccessInput!, options: StartImportOptionsInput, totalRows: Int }
type StartImportPayload { jobResultId: ID! }
type CancelImportPayload { ok: Boolean! }
${tableNameSingular}StartImport(input: StartImportInput!): StartImportPayload
${tableNameSingular}CancelImport(jobResultId: ID!): CancelImportPayload
```
Resolvers: any authenticated user (`context.user` present); `trigger: "api"` when the request carries an API key, else `"ui"` (reuse whatever flag the resolvers already use to distinguish API users; builder: find it in `createMutations`); errors map `StartImportError.code` to the GraphQL error message.

- [ ] **Step 1: Write the failing tests** (db fake pattern from `intake.test.ts`): context missing → `CONTEXT_NOT_FOUND`; Review Focus 5: `s3Key "other-bucket/x.csv"` → `IMPORT_S3_KEY_OUTSIDE_BUCKET`, no insert, no `queue.add`; running row → `IMPORT_ALREADY_RUNNING`; happy path → insert with `type "import"`, `context`, `state "waiting"`, `trigger_metadata.user`, then `queue.add` with `jobId === jobResultId` and `attempts 1`; cancel by other user → `NOT_AUTHORIZED`; cancel by starter while waiting → `remove` called and state `cancelled`; while active → only `metadata.cancelRequested`.
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement `start-import.ts`, the SDL and the resolvers**
- [ ] **Step 4: Run the tests, then the whole suite and the build** — `npm test` → PASS; build → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat: StartImport and CancelImport mutations for server-side bulk import"`

---

### Task 6: Docs and spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-10-21-server-side-bulk-import-design.md:3` (status)
- Create: `docs/superpowers/plans/2026-10-21-server-side-bulk-import-operator-notes.md` — queue name, worker queue list requirement, `/config` flags, S3 bucket rule, error CSV location, `job_results` retention, the API call example (GraphQL mutation with an existing `s3Key`); the product docs page (`building/knowledge/bulk-import`, docs repo) is updated separately with this content.

- [ ] **Step 1: Write the notes, set the status to `backend implemented <date>`**
- [ ] **Step 2: Commit** — `git commit -m "docs: operator notes for server-side bulk import"`
