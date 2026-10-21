# Server-side bulk import — operator notes

**Date:** 2026-10-21
**Covers:** `exulu/backend` only (this repo). Companion design doc:
`docs/superpowers/specs/2026-10-21-server-side-bulk-import-design.md`.
**Audience:** operators running/deploying an Exulu backend, and scripted/API callers.

## Overview

The CSV import wizard has two modes, split by size:

- **Client mode** (up to `IMPORT_CLIENT_MAX_ROWS = 200` rows and ≤ 2 MB): the
  browser parses the whole file, shows an editable review grid, and fires one
  mutation per row (client runner, concurrency 4). No queue, no backend job.
- **Server mode** (above either threshold): the browser uploads the file to S3
  and calls `${table}StartImport`. A backend job (`ee/workers.ts`, job type
  `"import"`) streams the file from S3, maps/coerces/validates each row, and
  creates or updates items directly. The same mutation, called with an
  existing `s3Key`, is also the entry point for scripted/API imports (e.g. a
  daily export already sitting on S3) — there is no separate API path.

Server mode requires the queues enterprise licence and Redis (see
Configuration prerequisites and Queue below). A missing/invalid licence is
the only case that surfaces as `QUEUES_NOT_LICENSED`; a missing or
unreachable Redis server surfaces as the original error (e.g.
`[EXULU] no redis server configured.`), deliberately unmapped — see Error
codes.

## Configuration prerequisites

This repo has no literal `/config` settings file; configuration is the
`ExuluConfig` object passed into `ExuluApp.create()` plus a few environment
variables. For server-side import to work, an operator must have:

- **`EXULU_ENTERPRISE_LICENSE`** set and starting with `EXULU_EE_`
  (`ee/entitlements.ts`, `checkLicense()`). Without it, `checkLicense()["queues"]`
  is `false` and any attempt to register the `import` queue throws — surfaced
  to API callers as `QUEUES_NOT_LICENSED` (see Error codes).
- **Redis reachable**: `REDIS_HOST` and `REDIS_PORT` env vars (optionally
  `REDIS_PASSWORD`, `REDIS_USER`) read by `ee/queues/server.ts`'s
  `redisServer`. `src/exulu/app/index.ts` only registers the system queues
  (`eval_runs`, `email_intake`, `import`) when
  `redisServer.host?.length && redisServer.port?.length`; otherwise the
  `import` queue is never registered and `StartImport` cannot enqueue.
- **S3 file uploads configured**: `config.fileUploads` on `ExuluConfig`
  (`src/exulu/app/index.ts`) with `s3region`, `s3key`, `s3secret`, `s3Bucket`
  all set (`s3endpoint`/`s3prefix` optional). `s3Bucket` is the *only* bucket
  `StartImport` will accept an upload's `s3Key` from (see Error codes,
  `IMPORT_S3_KEY_OUTSIDE_BUCKET`).
- **A worker process running the queue**: `ExuluApp.bullmq.workers.create(queues?: string[])`
  also requires the licence. If a deployment calls `workers.create([...])`
  with an **explicit queue-name list**, that list must include `"import"` —
  `src/exulu/app/index.ts`'s `create` filters `this._queues` down to the
  names passed in, so an import job enqueued for a worker that was not told
  to listen on `"import"` simply waits forever. Calling `workers.create()`
  with no list (the default) listens to every registered queue, `import`
  included.

## Queue

- **Name:** `"import"` (`ee/queues/queues.ts`, `global_queues.import`).
  Registered names are interpolated verbatim into a GraphQL enum, so queue
  names use underscores, never hyphens — `"import"` has neither.
- **Registered by:** `src/exulu/app/index.ts`, alongside `eval_runs` and
  `email_intake`, only when Redis is configured (see above). Concurrency
  `{ worker: 1, queue: 1 }`, rate limit `1` (job/sec — moot at concurrency 1),
  timeout `6 * 3600` seconds (6 hours).
- **One job at a time, globally, per deployment** — the queue's global
  concurrency is 1, so only one import run executes at any moment across the
  whole deployment, regardless of how many contexts have imports queued. A
  bulk import's own internal row-write pool (concurrency 8, see Worker
  behaviour) runs inside that one job.
- **Licence gate, independent copy:** the two mutation resolvers
  (`src/graphql/mutations/index.ts`) register/obtain the same `import` queue
  handle themselves (`getImportQueue()`), rather than depending on it already
  having been registered at boot — `ExuluQueues.register(...)` is idempotent
  per name, so this is safe, but it means a licence check happens on every
  `StartImport`/`CancelImport` call, not only at startup.

## Starting an import via the API

Any context of type `items` gets `${singular}StartImport` and
`${singular}CancelImport` mutations (`src/graphql/schemas/index.ts`). For a
context the *singular table name* is `<contextId>_items`
(`convertContextToTableDefinition`), so a context with id `products` gets
**`products_itemsStartImport`** and **`products_itemsCancelImport`** — the
same spelling as its sibling mutations (`products_itemsExecuteSource`), not
`productStartImport`:

```graphql
mutation {
  products_itemsStartImport(
    input: {
      s3Key: "my-platform-bucket/imports/products-2026-10-21.csv"
      fileName: "products-2026-10-21.csv"
      mapping: [
        { header: "SKU", fieldName: "external_id" }
        { header: "Product Name", fieldName: "name" }
        { header: "Description", fieldName: "description" }
        { header: "Internal Notes", fieldName: null }
      ]
      access: {
        rights_mode: "private"
        users: null
        roles: null
        teams: null
      }
      options: { skipEmbeddings: false, delimiter: ";" }
      totalRows: 42000
    }
  ) {
    jobResultId
  }
}
```

Exact input shape (`src/graphql/schemas/index.ts`):

```graphql
input StartImportInput {
    s3Key: String!
    fileName: String!
    mapping: [StartImportMappingInput!]
    access: StartImportAccessInput!
    options: StartImportOptionsInput
    totalRows: Int
}
input StartImportMappingInput {
    header: String!
    fieldName: String
}
input StartImportAccessInput {
    rights_mode: String!
    users: JSON
    roles: JSON
    teams: JSON
}
input StartImportOptionsInput {
    skipEmbeddings: Boolean
    delimiter: String
}
type StartImportPayload {
    jobResultId: ID!
}
```

Notes:

- **`s3Key`** must be in `bucket/key` form (the same shape `uploadFile`
  returns, e.g. the result of a prior S3 upload) and its bucket must equal
  `config.fileUploads.s3Bucket` exactly — a key pointing at any other bucket
  is rejected before anything is written (`IMPORT_S3_KEY_OUTSIDE_BUCKET`).
  There is no cross-bucket support: copy or upload the file into the
  platform bucket first. Within the bucket, a key under somebody else's
  private upload prefix (`user_<id>/…`, for any id other than the caller's)
  is also refused (`IMPORT_S3_KEY_NOT_ALLOWED`) — the same rule
  `GET /s3/download` applies, since an import would otherwise read another
  user's upload and materialise it as items. Super admins and API-key
  callers (`user.type === "api"`) are exempt, and keys with no `user_`
  segment (e.g. a shared `imports/…` prefix) are unaffected.
- **`mapping`** is by **header name**, not column index
  (`{ header, fieldName }`). `fieldName: null` means "ignore this column" —
  also how a retry pre-fills the error CSV's own `import_error` column so it
  is not re-imported as data. When `mapping` is omitted entirely, the backend
  auto-maps headers to fields (`autoMapColumns` in `src/exulu/import/mapping.ts`,
  same `normalizeHeader` rule as below).
- **`access.rights_mode`** must be one of `private`, `users`, `roles`,
  `teams`, `public` (`VALID_RIGHTS_MODES`, `src/exulu/import/start-import.ts`)
  or the call fails with `INVALID_RIGHTS_MODE`. This access is applied only
  to newly **created** rows; updated rows keep their existing access
  unchanged. `access.users`/`roles`/`teams` are `JSON` lists of
  `{ id, rights }`; `null` or an omitted list is fine and is normalised to
  an empty array before being stored (the grant writer maps over all three).
- **`options.delimiter`**, if supplied, is used verbatim by the CSV parser.
  Omitted, the delimiter is **sniffed from the header line**: the most
  frequent of `,` `;` `\t` `|` outside quotes wins, with `,` as the default
  and tie-break (`sniffDelimiter`, `src/exulu/import/csv-stream.ts`). A
  `;`-delimited export (the German/Swiss Excel default) therefore imports
  without any extra input. A supplied delimiter must be exactly one
  character, or the call fails with `INVALID_DELIMITER` before anything is
  written.
- **`totalRows`**, if supplied by the caller (e.g. the wizard's chunked
  count), seeds `job_results.metadata.total` and is carried through the run
  as the progress denominator. Omitted, the row is still *seeded* with
  `total: 0` at insert time; the first progress tick replaces that with
  `null` (the run has no row count of its own) and it stays `null`, so only
  `processed` is meaningful until the run finishes.
- The call returns `{ jobResultId }` — this is both the `job_results.id` to
  poll and the BullMQ job id (`jobId: jobResultId` on enqueue), so cancel and
  the progress query both key off the same value.
- **Header normalisation** for matching a header to a field name or label
  (`normalizeHeader`, `src/exulu/import/mapping.ts`): trim, lowercase, then
  collapse runs of spaces or dashes to a single underscore.

## Cancelling

```graphql
mutation {
  products_itemsCancelImport(jobResultId: "3fa85f64-5717-4562-b3fc-2c963f66afa6") {
    ok
  }
}
```

`CancelImportPayload { ok: Boolean! }`. Behaviour
(`src/exulu/import/start-import.ts`, `cancelImport`):

- Sets `job_results.metadata.cancelRequested = true` via an atomic jsonb
  merge (never a read-then-write), so it cannot race-lose against a
  concurrent progress tick.
- If the row is still `waiting` (not yet picked up by a worker), also tries
  to remove the still-queued BullMQ job and flips the row straight to
  `cancelled`. A failed removal (e.g. the worker grabbed it a moment earlier)
  is logged, not thrown — the `cancelRequested` flag is already persisted
  and the running worker will honour it instead.
- If the row is `active` (a worker has it), the running worker normally sees
  the flag at its next chunk boundary and finalizes the row itself, so only
  the flag is written. **Recovery for a stuck `active` row:** if the BullMQ
  job no longer exists (the run died in a way that never reached the
  `"failed"` handler — worker process gone, a Postgres outage swallowing
  that write, the 6 h timeout on a dead process), nothing will ever observe
  the flag and D6's gate would refuse every future import for the context.
  Cancel therefore also forces such a row to `cancelled` (CAS-guarded on it
  still being `active`), so the next `StartImport` works. If Redis itself is
  unreachable, the lookup failure is logged and the row is left `active` —
  cancel still returns `{ ok: true }`; retry once Redis is back.
- If the row is already terminal (`completed`/`failed`/`cancelled`), the call
  is a no-op that still returns `{ ok: true }` — a double-click or a race
  with the worker's own completion never errors.
- A `jobResultId` with no matching row — or one whose row is not an import
  (`type != "import"`, e.g. a workflow run) — is an error
  (`IMPORT_NOT_FOUND`); the per-context mutation prefix is cosmetic, so this
  is what stops an import-cancel from touching another job type's row.

## Progress and results

Poll the context's generic `job_resultsPagination` query, filtered to the
`jobResultId`, e.g. `job_resultsPagination(filters: [{ id: { eq: $id } }])`.
Relevant columns/keys on the `job_results` row:

- **`state`**: `waiting` → `active` → one of `completed` / `failed` /
  `cancelled` (`types/enums/jobs.ts`). The worker moves the row to `active`
  at pickup (`upsertJobStart`, `ee/workers.ts`).
- **`metadata`** while running: `{ total, processed, created, updated,
  failed, invalid }`, merged atomically every 500 rows **or** every 10
  seconds of wall time, whichever comes first (`DEFAULT_CHUNK_ROWS = 500`,
  `DEFAULT_PROGRESS_INTERVAL_MS = 10_000`, `src/exulu/import/run-import.ts`).
  `metadata.cancelRequested` appears once a cancel has been requested.
- **`metadata` and `result` on completion**: both are set to the **same**
  final object: `{ total, processed, created, updated, failed, invalid,
  durationMs, errorReportKey, cancelled, errorReportTruncated }`
  (`RunImportResult`, `src/exulu/import/run-import.ts`; written by the
  worker's `"completed"` handler in `ee/workers.ts`, CAS-guarded on
  `state = "active"`). A **cancelled** run gets the same final object through
  a separate path, `finalizeCancelled` (`src/exulu/import/worker-deps.ts`),
  because the generic `"completed"` handler's CAS no longer matches once the
  state is `cancelled`.
- **`errorReportKey`** (inside `result`/`metadata`): the `bucket/key` of the
  error CSV, or `null` if there were no invalid/failed rows (see Error CSV).
- **`error`** column: only populated when the run itself aborted (state
  `failed`) rather than finishing with some failed rows — see Error codes'
  run-abort codes.
- **`trigger`** (`"ui"` or `"api"`) and **`trigger_metadata`** (`{ s3Key,
  fileName, mapping, access, options, user }`, the inputs snapshotted at
  start time) are on the row from creation and do not change.

## Error codes

Thrown from `src/exulu/import/start-import.ts` (`StartImportError`) and
re-thrown by the mutation resolvers in `src/graphql/mutations/index.ts` as a
plain `Error` whose message **is** the code string — i.e. the code is what
reaches a GraphQL client as the error message.

| Code | Cause | Remedy |
|---|---|---|
| `CONTEXT_NOT_FOUND` | `table.id` does not match a registered context. | Check the context id used in the mutation name/call. |
| `IMPORT_ALREADY_RUNNING` | A `job_results` row for this context, `type = "import"`, is already `waiting` or `active` (one running import per context, D6). | Wait for it to finish, or cancel it first. |
| `IMPORT_S3_KEY_OUTSIDE_BUCKET` | `s3Key`'s bucket segment does not equal `config.fileUploads.s3Bucket`. | Upload/copy the file into the platform bucket and pass that key. |
| `IMPORT_S3_KEY_NOT_ALLOWED` | The key is inside the platform bucket but under another user's `user_<id>/` prefix, and the caller is neither a super admin nor an API key (same predicate as `GET /s3/download`, `src/uppy/index.ts`). | Upload the file under your own prefix (or a shared one), or call as a super admin / API key. |
| `INVALID_RIGHTS_MODE` | `access.rights_mode` is not one of `private`, `users`, `roles`, `teams`, `public`. | Fix the `access.rights_mode` value. |
| `INVALID_DELIMITER` | `options.delimiter` was supplied but is not exactly one character (csv-parse would reject it as `CSV_INVALID_OPTION_DELIMITER` mid-run, after the upload). | Pass a single character, or omit it and let the header line be sniffed. |
| `IMPORT_NOT_FOUND` | `CancelImport`'s `jobResultId` matches no `job_results` row, or matches a row whose `type` is not `"import"`. | Check the id; it may have been typo'd, pruned, or belong to another job type. |
| `NOT_AUTHORIZED` | Either: no authenticated user on the request (`StartImport`/`CancelImport` both require `context.user`); or (`CancelImport` only) the caller is neither the import's starter nor a super admin. | Authenticate, or have the starter / a super admin cancel instead. |
| `QUEUES_NOT_LICENSED` | `ExuluQueues.register(...)` for the `import` queue threw — only happens when `checkLicense()["queues"]` is false, i.e. `EXULU_ENTERPRISE_LICENSE` missing/invalid. A genuine Redis connectivity error from `.use()` is deliberately **not** mapped to this code and surfaces as-is. | Set a valid `EXULU_ENTERPRISE_LICENSE`. If the error is something else (Redis down/unreachable), fix Redis, not the licence. |

Run-abort codes (`ImportAbort`, `src/exulu/import/run-import.ts`): these do
not reach the GraphQL caller — they land in `job_results.error` with
`state = "failed"` once the run itself aborts (the whole file, not a row):

| Code | Cause | Remedy |
|---|---|---|
| `NO_MAPPABLE_COLUMNS` | After mapping, no column resolves to `name`, `id`, or `external_id` — nothing in the file can be mapped to a usable field. | Fix the CSV header or the `mapping` input so at least a name or key column maps. |
| `EMPTY_FILE` | The CSV stream never produced a header row. | Check the uploaded file is non-empty and really a CSV. |

A DB outage or any other unexpected throw during the run also lands the row
in `state = "failed"` with the real error serialized into `error`
(`src/utils/serialize-error.ts`), via the same worker `"failed"` handler.

**`IMPORT_RESTARTED_AFTER_STALL`** is one such message, raised by the worker
branch itself rather than by `run-import`. `attempts: 1` stops *failure*
retries, but BullMQ's stalled recovery (`lockDuration` 5 min,
`stalledInterval` 2 min, `maxStalledCount` 1) still moves a job back to
`wait` once after a worker crash, a long event-loop block, or a Redis gap.
Re-streaming the file from row 0 would create every key-less row a second
time and reset the counters, so the second pickup refuses: the row goes
`failed` with `IMPORT_RESTARTED_AFTER_STALL: import <id> was already
running; partial rows are kept, start a new import`. The rows written before
the stall stay; the context's gate reopens, so the remedy is to start a new
import (an `external_id`/`id`-keyed file is safe to re-run as-is, since
those rows match and update).

## Error CSV

- **Location:** `imports/<contextId>/<jobResultId>-errors.csv`, uploaded to
  the platform bucket under the shared/global prefix (not the triggering
  user's private prefix) by `uploadErrorReport`
  (`src/exulu/import/worker-deps.ts`). The key stored in
  `metadata.errorReportKey` / `result.errorReportKey` is the full
  `bucket/key` form, same as an `s3Key` input.
- **Produced only when there is something to report** — `errorReportKey` is
  `null` if no row was invalid, failed, or truncated.
- **Columns:** the original row's columns (as seen in the file's header row)
  plus one trailing `import_error` column with the reason.
- **Encoding:** UTF-8 **with a BOM** (`"﻿"` prepended, so Excel opens it
  correctly) — `src/exulu/import/run-import.ts`.
- **50,000-line cap:** at most `IMPORT_MAX_ERROR_LINES = 50_000` error rows
  are retained in the CSV; errors beyond that are still counted in
  `metadata.failed`/`invalid` but not written out. When the cap is hit, the
  CSV's last line is a marker: first column `…`, remaining columns blank,
  final column `truncated: <N> more rows not listed`
  (`errorReportTruncated: true` in the result).
- A row becomes an error line for one of: a validation failure (prefixed
  with the field validation message), `"no write access"` (an update target
  the acting user may not write), `"duplicateKey:id"` /
  `"duplicateKey:external_id"` (a later row in the same file reusing a key
  already claimed earlier in the same run), or the raw error message from a
  failed create/update/lookup.

## Coercion parity with the browser preview

The server validates and coerces exactly as the client wizard's preview does
(same outcomes, same error codes), for every type except `file` — which is
excluded from a server import entirely, there being no local file to upload
against. The shared parity fixture lives at
**`src/exulu/import/fixtures/coercion-cases.json`** in this repo, and the
frontend copies it verbatim; nothing in either repo enforces that link
automatically, so a change to the coercion rules means changing the fixture
here and re-copying it there.

## Retention

`ee/queues/prune-job-results.ts`, run opportunistically (every 100th
enqueue/completion, idempotent, guarded against overlap):

- The **generic** cap (`MAX_TERMINAL = 10_000` newest terminal rows overall)
  explicitly **excludes** `type = "import"` rows (and folds back in any row
  with a null `type`, which the generic cap still owns).
- **Import rows get their own, per-context cap**: the newest
  `MAX_IMPORT_PER_CONTEXT = 200` terminal rows are kept *per context*; older
  ones are deleted. "Terminal" here means `TERMINAL_JOB_STATES` =
  `completed`, `failed`, `filtered`, `cancelled` (`types/enums/jobs.ts`).
  `waiting`/`active` import rows are never pruned.
- The per-context import prune uses a Postgres window function
  (`row_number() over (partition by context ...)`) and is skipped entirely
  on any non-`"pg"` knex client — this codebase only ever connects with
  `"pg"`, so in practice the cap always applies, but it is worth knowing the
  guard exists if a future deployment ever used a different dialect.

## Permissions

- **Starting an import**: any authenticated user (`context.user` present) —
  no super-admin gate, unlike `ExecuteSource`. This mirrors the client
  wizard, where any user can already create items.
- **Per-row write checks on updates**: an update target's existing
  `rights_mode`/`created_by`/RBAC grants are checked per row
  (`canWrite`, `src/exulu/import/worker-deps.ts`, a port of
  `validateWriteAccess`). A row the acting user may not write is counted as
  `failed` with `"no write access"` in the error CSV — it does not abort the
  run. **Created** rows get the batch `access` input instead of a per-row
  check.
- **Cancelling**: the import's starter (the user snapshotted into
  `trigger_metadata.user` at start time) or a super admin; anyone else gets
  `NOT_AUTHORIZED`.
- `job_results` itself has no RBAC (no `RBAC: true` on its table definition
  in `ee/schemas.ts`) — any user who can query it at all can see every
  import's `trigger_metadata` (including who started it and the access/
  mapping used).

## Known limits

- **One running import per context**: enforced by `IMPORT_ALREADY_RUNNING`
  (a `job_results` row with `context`/`type = "import"` in `waiting` or
  `active`).
- **That check is a check-then-insert race**, not a single atomic operation
  (`src/exulu/import/start-import.ts`: a `SELECT` for a running row, then
  later an `INSERT`) — two `StartImport` calls for the same context arriving
  close enough together could both pass the check and both insert a
  `"waiting"` row. The blast radius is bounded by the `import` queue's
  global concurrency of 1: even if two rows get created, the worker still
  executes them one at a time, never two simultaneous writers racing on the
  same context's upserts.
- **A cancelled run keeps whatever it already wrote.** Cancellation is
  checked only at a chunk boundary (every 500 rows or 10 s); rows already
  created/updated before that boundary are not rolled back, and the
  persisted `result`/`metadata` reflect exactly those partial counters.

---

The product docs page (`building/knowledge/bulk-import`, docs repo) is updated separately with this content.
