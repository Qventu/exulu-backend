# Server-side bulk import (large CSVs) — design

**Status:** backend implemented 2026-10-21
**Date:** 2026-10-21
**Author:** daniel.claessen (with Claude Fable 5.1)
**Extends:** `2026-07-15-bulk-import-design.md` (client-side wizard, ≤100 rows),
`2026-07-16-bulk-import-v1.1-two-flows-design.md`, the rights-mode design (2026-07-21).
**Repos:** this document covers both `exulu/backend` (job, mutation, worker) and
`exulu/frontend` (wizard changes, status UI). The plans are written per repo.

## Purpose

The CSV import wizard runs entirely in the browser: it parses the whole file, shows
an editable review grid and fires one GraphQL mutation per row (four in flight). That
is right for ~100 rows and wrong for 30 000 or 100 000: an hour in an open tab, a
grid with a million cells, and a half-imported context when the tab closes.

A customer (CHRIS Sports) now imports product exports of 30k–100k rows and expects
the import to **finish without the tab** — and to be startable without the UI once
the export arrives on S3 daily.

The wizard keeps what works (drop, column mapping, batch access) and hands the
work to the backend: the file goes to S3, a job streams it into the context, and the
IMP shows progress, a report and a downloadable error CSV.

## Facts (read 2026-10-21)

| Area | Fact |
|---|---|
| Wizard | `frontend/app/(application)/data/[ctx]/components/import/` — steps `add` → `map` → `review`; `lib/import/` holds `parse-csv.ts` (papaparse, whole text), `map-columns.ts` (`normalizeHeader`: lowercase, spaces and dashes → `_`, exact match on field name or label), `coerce.ts` (number/boolean/enum/date/file coercion with error codes), `rows.ts` (validation, `buildCreateInput`/`buildUpdateInput`, `mergeBatchAccess`), `resolve-targets.ts` (create vs update by `id`/`external_id`), `runner.ts` (client loop, concurrency 4), `upload.ts` (`uploadFileToS3`: presign via `POST /s3/sign`, then PUT) |
| Review grid | `step-review-grid.tsx` on `@tanstack/react-table`, not virtualised |
| Earlier decision | 2026-07-15: "A server-side BullMQ import job was considered and rejected for v1: more backend surface, enterprise-license gating on queues, unnecessary at ≤100 items" |
| Queues | `ee/queues/queues.ts` (`ExuluQueues.register(name, { worker, queue }, concurrency, timeoutSeconds).use()`); `global_queues` (`eval_runs`, `email_intake`) are registered by `ExuluApp` in `src/exulu/app/index.ts` when Redis is configured; `checkLicense()["queues"]` gates registration (enterprise license) |
| Worker | `ee/workers.ts`: one BullMQ `Worker` per queue, dispatch on `bullmqJob.data.type` (`processor`, `embedder`, `workflow`, `eval_run`, `eval_function`, `source`, `email_intake`); processor jobs send a 25 s `updateProgress` heartbeat; the `source` branch loops `context.createItem(item, config, user, role, upsert)` |
| Job records | Table `job_results` (columns in use: `job_id`, `label`, `state`, `type`, `context`, `trigger`, `trigger_metadata`, `result`, `metadata`, `tries`, `session`, `workflow`, timestamps; `context` and `type` are indexed; no RBAC on the table; `ee/queues/prune-job-results.ts` keeps the newest 10 000 terminal rows regardless of type); `JOB_STATUS` in `types/enums/jobs.ts` incl. `cancelled`; exposed via `job_resultsPagination(filters: [FilterJob_result], sort)`; the home dashboard reads it (`(home)/queries.ts`) |
| Per-context mutations | `src/graphql/schemas/index.ts` builds SDL per table, e.g. `${singular}ExecuteSource(source: ID!, inputs: JSON!)`; resolvers in `src/graphql/mutations/index.ts` (`createMutations`) with `validateWriteAccess`; `ExecuteSource` enqueues `{ type: "source", … }` on the source's queue |
| Access | `validateWriteAccess` (`mutations/index.ts`) is a per-row check (rights_mode / created_by / RBAC) used by `UpdateOneById`; `CreateOne` is open to any authenticated user; `ExecuteSource` is super-admin only; `context.createItem(…, upsert)` performs no access check and merges every column on conflict |
| S3 | `src/uppy/index.ts`: `GetObjectCommand` helpers (`transformToString` today), presign for upload; `POST /s3/sign` route |
| CSV libs | backend: `csv-parse` 5 (streaming) and `papaparse`; frontend: `papaparse` (supports `step`/`chunk` streaming on a `File` and `preview: n`) |
| i18n | `messages/en.json` + `messages/de.json`, parity enforced (`npm run check-messages`); wizard keys under `"import"` |
| Tests | backend `jest`, frontend `vitest run` |

## Scope

**In scope**

- Backend: a global `import` queue; an `import` job type in `ee/workers.ts` that streams a CSV from S3 into a context; a per-context mutation `${singular}StartImport` and a `${singular}CancelImport`; progress and result in `job_results`; an error CSV in S3.
- Backend: the mapping/coercion/validation rules of the wizard ported to a backend module (`src/exulu/import/`), with the frontend's test cases as parity fixtures.
- Frontend: the wizard reads only header + sample (streaming), decides the mode by size, uploads the file and starts the job; a new `run` step shows live progress and the result; a new **Imports** section in the context's Pipeline tab lists past and running imports with cancel, error-report download and "retry failed rows".
- Both: i18n (en/de), tests, the IMP docs page `building/knowledge/bulk-import` updated.

**Out of scope**

- Changing the small-batch client flow (≤ threshold keeps today's editable grid and client runner — D1).
- XLSX, multi-file CSV, files-flow (PDF drop) through the job.
- Per-cell editing in server mode.
- Virtualising the review grid (not needed once large files never reach it).
- A generic job UI for all job types; the Imports list is per context and per type.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Two modes by size.** Up to `IMPORT_CLIENT_MAX_ROWS = 200` rows the wizard behaves exactly as today (editable grid, client runner). Above, or when the file exceeds 2 MB, it switches to **server mode**: read-only preview, upload, job. The decision is shown in the add step ("Server-Import: 33 675 Zeilen"). | Small imports keep cell editing and need no queue; large ones cannot be edited by hand anyway. One threshold, visible to the user. |
| D2 | Server mode requires the queues license and Redis. Without them the wizard shows the limit ("bis 200 Zeilen im Browser; grössere Dateien brauchen die Queue-Funktion") and refuses larger files. | Queue registration is license-gated (`checkLicense()["queues"]`); the frontend learns availability from a new boolean in the existing config/feature query (builder: reuse the query the shell already uses for licence-gated features). |
| D3 | The browser never parses the whole file. papaparse streams the `File` in chunks: the header and the first 500 rows feed mapping, preview and validation preview; a counting pass (chunked, no retention) yields the row count for D1 and the progress total. | A 200 MB × 324-column file held as rows kills the tab; counting newlines in chunks does not. |
| D4 | Upload via the existing `uploadFileToS3` (presign + PUT), then **one mutation** `${singular}StartImport(input: StartImportInput!): StartImportPayload` with `{ s3Key, fileName, mapping?: [{ header, fieldName }], access: { rights_mode, users, roles, teams }, options?: { skipEmbeddings?: Boolean } }` → `{ jobResultId }`. `mapping` is **by header name**, not column index; when omitted, the backend auto-maps with a port of `normalizeHeader`/`autoMapColumns`. `s3Key` is the `bucket/key` form the frontend already stores and must point into the platform upload bucket (`config.fileUploads.s3Bucket`). The same mutation with an existing `s3Key` is the API entry for scripted imports. | No new upload path; the API case (daily export on S3) is the same call. Header-based mapping survives a changed column order in the next export; a scripted caller can omit it entirely. Cross-bucket reads are out of scope: the customer copies or uploads into the platform bucket. |
| D5 | The mutation creates the `job_results` row **before** enqueuing, using the existing `context` and `type` columns: `type: "import"`, `context: <contextId>`, `label: "Import <fileName>"`, `state: "waiting"`, `trigger: "ui" \| "api"`, `trigger_metadata: { s3Key, fileName, mapping, access, options, user }`, `metadata: { total, processed: 0, created: 0, updated: 0, failed: 0, invalid: 0 }`; then `queue.add("import", { type: "import", jobResultId, context, user, role }, { jobId: jobResultId, attempts: 1 })`. At pickup the worker moves the row to `active` (the `upsertJobStart` pattern), because the generic completed/failed handlers CAS on `job_id` + `active`. | The row is the handle the UI polls from the first second; `jobId = jobResultId` makes cancel and dedupe trivial. `attempts: 1`: a retried import would double-count; re-running is an explicit user action (D11). |
| D6 | **One active import per context.** `StartImport` refuses (`IMPORT_ALREADY_RUNNING`) while a `job_results` row with `context = <contextId>`, `type = "import"` is `waiting` or `active`. | Two concurrent imports into one context race on upserts and confuse the counters. |
| D7 | Worker branch `data.type === "import"` in `ee/workers.ts`, delegating to `src/exulu/import/run-import.ts` (`runImport(deps)`): stream the S3 object (`GetObjectCommand` body as a Node stream → `csv-parse` with `columns: false, relax_quotes, bom: true, skip_empty_lines`), map header columns to fields, coerce + validate each row with the ported rules, and process in **chunks of 500 rows**: one lookup query for the chunk's `id`s / `external_id`s → hits become **updates** (`updateItem`-equivalent: only the mapped columns, access untouched — the rights-mode decision "update rows keep their existing access"), misses become **creates** (`createItem` with the batch access), each row's write going through a pool of **8**; counters `created`/`updated` are therefore exact. Update rows are checked against the stored user/role with a port of `validateWriteAccess`; a row the user may not write counts as `failed` ("no write access"). Embeddings and the processor run per item exactly as the single-item path does; `options.skipEmbeddings` passes `generateEmbeddingsOverwrite = false` for operators who prefer one "Generate embeddings" run afterwards. **The server create path must reuse the `CreateOne` mutation's semantics — `created_by`, RBAC grant writes via `handleRBACUpdate`, `rights_mode` validation — not bare `context.createItem`, which is a low-level insert with none of them: a `private` row created without `created_by` is invisible to its own author, and an `RBAC` key on the column input fails the insert outright (item tables have no such column).** | A blind `createItem(…, upsert)` merges every column, resets `rights_mode` on existing rows and blanks unmapped core fields (`name`, `description`, `tags`) — wrong for a daily upsert-heavy export. The chunked lookup keeps the client runner's contract (partial updates, access kept) at a cost of one query per 500 rows. |
| D8 | Progress: every 500 rows or 10 s, `job_results.metadata` is updated with the counters and `bullmqJob.updateProgress({ processed, total })`; the same tick checks `metadata.cancelRequested` and stops at the next row boundary (`state: "cancelled"`, rows already written stay). | The processor heartbeat pattern already exists (25 s); counters in `metadata` are what the UI reads. |
| D9 | Invalid rows (validation) and failed rows (mutation error) go to an **error CSV**: the original row columns plus `import_error`; uploaded to S3 at the end under `imports/<contextId>/<jobResultId>-errors.csv`, key in `metadata.errorReportKey`. `result` holds the final summary `{ total, processed, created, updated, failed, invalid, durationMs, errorReportKey }`; `state: "completed"` even when some rows failed, `"failed"` only when the run itself aborts (file unreadable, header unmappable, DB down). | Same semantics as the client runner: a failing row never halts the batch; the report is the "download error report" of today. |
| D10 | Mapping/coercion/validation live in the backend (`src/exulu/import/coerce.ts`, `rows.ts`) as a port of the frontend modules; the frontend keeps its copies for the preview. A shared fixture file (`import-coercion-cases.json`) with the same cases is tested in both repos so they cannot drift. | The two repos share no package; a shared fixture is the cheapest parity guarantee. |
| D11 | **Retry failed rows** = `StartImport` with `s3Key` of the error CSV and the stored mapping plus `import_error` mapped to *Ignore* (the wizard pre-fills this). **Cancel** = `${singular}CancelImport(jobResultId: ID!)` sets `metadata.cancelRequested = true` (and removes a still-waiting BullMQ job). | No new job shapes; retry is just another import. |
| D12 | Frontend status: the wizard's new `run` step polls `job_resultsPagination` by id every 2 s (progress bar from `metadata`, counters, cancel, "close — the import continues"). The context's **Pipeline** tab gets an **Imports** card: list of `job_results` with `context = <contextId>` and `type = "import"` (state, file name, counters, duration, started by), actions cancel / download error report (presigned URL via the existing S3 route) / retry failed rows. | The user chose: Pipeline tab plus the wizard. Polling, not subscriptions — the SDK has no job subscription and 2 s is fine. |
| D13 | Permissions (**decided**): anyone who may use the wizard today (any authenticated user, as `CreateOne`) may start a server import; update rows are checked per row (D7); cancel is allowed to the starter and super-admins; the Imports card and `trigger_metadata` are visible to everyone with access to the context page (`job_results` has no RBAC). | The client wizard already lets any user create items and gates updates per row; the server path is neither more permissive nor more restrictive. |
| D14 | Queue: `global_queues.import` registered by `ExuluApp` next to `email_intake` with `{ worker: 1, queue: 1 }`, concurrency 1, timeout 6 h; the worker runs the import with its own internal pool (D7) inside the shared worker process. **Deployments that pass an explicit queue list to `workers.create([...])` must add `import`**, otherwise jobs wait forever; the runbook/docs say so. (CHRIS Sports' `worker.ts` calls `workers.create()` without a list, so it picks the queue up automatically.) | One import at a time per deployment keeps DB load predictable; 100k rows at ~50 ms/8 ≈ 10 min, far under 6 h. |
| D15 | i18n: every new string in `messages/en.json` and `messages/de.json` under `import.server.*` and `pipeline.imports.*`. | Repo rule (parity check in CI). |
| D16 | Docs: `building/knowledge/bulk-import` gains a "Large files" section (threshold, progress, error report, retry, API start, the worker queue list) and the changelog an entry. | The feature is customer-facing. |
| D17 | `ee/queues/prune-job-results.ts` keeps `type = "import"` rows out of the rolling 10 000-terminal-rows cap and caps them separately at the newest 200 per context. | A 100k-row import enqueues ~100k embedder rows, which would prune the import's own summary (and all import history) within minutes. |
| D18 | Availability for D2 comes from the existing `GET /config` payload (`entitlements` from `checkLicense()`, `workers.enabled`, `redisHost`), already consumed by `frontend/lib/api/config.ts`. | No new endpoint. |

## Architecture

```
 Wizard (browser)                                   Backend
 ─────────────────                                  ───────
 drop CSV ──► stream header + 500 rows ──► mapping / preview / validation preview
         └──► count rows (chunked)  ──► rows > 200 or file > 2 MB ? server mode : client mode (as today)
 server mode: uploadFileToS3(file) ──► s3Key
             StartImport(s3Key, mapping, access, options) ──► job_results row (waiting) + queue.add("import")
             run step: poll job_results by id ──────────────┐
                                                             │
 Worker (ee/workers.ts, type "import") ── runImport()        │
   S3 GetObject stream ─► csv-parse ─► map ─► coerce/validate ─► createItem ×8 ─► counters
   every 500 rows / 10 s: metadata.{processed,…}, updateProgress, check cancelRequested
   end: error CSV → S3, result summary, state completed | failed | cancelled
                                                             │
 Pipeline tab ► Imports card: job_results (label ilike import:<ctx>:%) ◄┘
   cancel ─► CancelImport     download ─► presigned error CSV     retry ─► StartImport(errorKey)
```

## Components

### Backend

- `ee/queues/queues.ts`: add `import: "import"` to `global_queues`.
- `src/exulu/app/index.ts`: register `global_queues.import` with the other system queues (Redis + license present).
- `types/queue-config.ts`: extend the job data union with `{ type: "import"; jobResultId: string; context: string; user?: number; role?: string }`.
- `src/exulu/import/coerce.ts`, `rows.ts`: ports of the frontend modules (`coerceValue`, `validateRow`, `buildCreateInput`, `buildUpdateInput`, `mergeBatchAccess`, `classifyRows` logic for id/external_id).
- `src/exulu/import/run-import.ts`: `runImport(deps)` — streaming loop, pool, counters, error CSV, cancel; pure enough to test with an injected readable stream, a fake `createItem` and a fake clock.
- `ee/workers.ts`: the `import` branch (load job_results row, call `runImport`, persist result/state, heartbeat).
- `src/graphql/schemas/index.ts`: SDL for `StartImportInput`, `StartImportPayload`, `${singular}StartImport`, `${singular}CancelImport` (items tables only).
- `src/graphql/mutations/index.ts`: the two resolvers (access check, D5/D6/D11).
- Tests (jest): coercion parity fixture, `runImport` (streaming, pool back-pressure, counters, error CSV, cancel at boundary, header without mappable columns → failed), mutation guards (already running, unknown context, access).

### Frontend

- `lib/import/parse-csv.ts`: add `peekCsvFile(file, sampleRows)` and `countCsvRows(file)` (papaparse streaming).
- `lib/import/mode.ts`: `decideImportMode({ rows, bytes, serverAvailable })`.
- Wizard: add step shows the mode; map step unchanged; review step in server mode renders a read-only sample grid + validation counts from the sample; a `run` step with progress, counters, cancel, "close and continue in background".
- `lib/api/imports.ts`: `START_IMPORT(context)`, `CANCEL_IMPORT(context)`, `GET_IMPORT_JOBS(context)` documents.
- Pipeline tab: `imports-card.tsx` (list, actions), using `job_resultsPagination`.
- i18n keys; vitest for `mode.ts`, `peekCsvFile`/`countCsvRows` (BOM, quotes, CRLF), the mapping pre-fill for retries (`import_error` → Ignore).

## Resolved with the operator (2026-10-21)

- Permissions: any user may start, per-row write checks on updates, cancel by starter or super-admin (D13).
- Threshold 200 rows / 2 MB (D1); larger files refused without the queues license (D2).

## Resolved by the builder check

- Blind `createItem(…, upsert)` would reset access and blank unmapped fields → chunked lookup, update vs create (D7).
- Mapping by header name, optional for API callers; platform bucket only (D4).
- `job_results` has `context`/`type` columns → used instead of a label prefix (D5, D6, D12).
- Per-item embedder/processor jobs stay as in the single-item path; `skipEmbeddings` option; import rows exempt from pruning (D7, D17).
- Availability flag exists in `GET /config` (D18); worker must set `active` at pickup (D5); deployments with an explicit queue list must add `import` (D14).

## Left to the builder

- Exact SDL field names and payload types; the name of the feature-availability flag.
- Pool implementation and the parser pause/resume mechanics.
- Error CSV column order and encoding (UTF-8 with BOM, so Excel opens it).
- Polling interval constant; empty-state copy.
