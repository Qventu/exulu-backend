import { streamCsvRows } from "./csv-stream";
import { resolveMapping } from "./mapping";
import type { ColumnMapping, ImportField } from "./mapping";
import { buildCreateInput, buildRow, buildUpdateInput, rowAction, rowIsValid } from "./rows";
import type { BatchAccess, ImportRow } from "./rows";

/** A row already in the context, as returned by `lookupExisting`. */
export type ExistingRow = {
  id: string;
  external_id: string | null;
  rights_mode: string | null;
  created_by: string | null;
  RBAC?: unknown;
};

export type ProgressMetadata = {
  total: number | null;
  processed: number;
  created: number;
  updated: number;
  failed: number;
  invalid: number;
};

export type RunImportResult = ProgressMetadata & {
  durationMs: number;
  errorReportKey: string | null;
  cancelled: boolean;
};

/**
 * Everything the run loop needs, injected -- no direct I/O, no SDK imports,
 * so the whole loop is testable with fakes.
 */
export type RunImportDeps = {
  stream: NodeJS.ReadableStream;
  fields: ImportField[];
  mapping?: ColumnMapping[];
  access: BatchAccess;
  options: { skipEmbeddings?: boolean };
  user: { id: number; super_admin?: boolean; role?: unknown };
  lookupExisting: (ids: string[], externalIds: string[]) => Promise<ExistingRow[]>;
  /** Per-record write gate for an update target (D13: public, private+creator, creator, RBAC users/roles/teams with write). */
  canWrite: (existing: ExistingRow) => boolean;
  createItem: (input: Record<string, unknown>) => Promise<void>;
  updateItem: (id: string, input: Record<string, unknown>) => Promise<void>;
  writeProgress: (m: ProgressMetadata) => Promise<void>;
  isCancelRequested: () => Promise<boolean>;
  /** Uploads the error-report CSV, returning its S3 key. */
  uploadErrorReport: (csv: string) => Promise<string>;
  now?: () => number;
  log?: (m: string) => void;
  chunkRows?: number;
  concurrency?: number;
  progressIntervalMs?: number;
  /** Carried straight into `ProgressMetadata.total`; `null` when the caller does not know the row count up front. */
  total?: number | null;
};

const ABORT_MESSAGES: Record<"NO_MAPPABLE_COLUMNS" | "EMPTY_FILE", string> = {
  NO_MAPPABLE_COLUMNS: "No column in the file maps to a usable field (name, id, or external_id).",
  EMPTY_FILE: "The file has no header row.",
};

export class ImportAbort extends Error {
  constructor(public code: "NO_MAPPABLE_COLUMNS" | "EMPTY_FILE") {
    super(ABORT_MESSAGES[code]);
    this.name = "ImportAbort";
  }
}

const DEFAULT_CHUNK_ROWS = 500;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_PROGRESS_INTERVAL_MS = 10_000;

/** Internal signal thrown from `onRow` to stop the parser right after a cancellation is observed. */
class RunCancelled extends Error {}

/** RFC 4180 quoting: wrap in quotes (doubling embedded quotes) when the value contains a quote, comma, or newline. */
function csvField(value: string): string {
  return /["\n,]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvLine(cells: string[]): string {
  return cells.map(csvField).join(",");
}

/** Runs `worker` over `items` with at most `concurrency` in flight. */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index]!);
    }
  });
  await Promise.all(runners);
}

type BufferedRow = { index: number; cells: string[] };

/**
 * Stream a CSV from `deps.stream` into a context: map + coerce + validate
 * each row, chunk it, look up existing rows by id/external_id, and create or
 * update through a bounded pool -- reporting progress and collecting an
 * error CSV as it goes.
 *
 * Rows are buffered from `onRow` up to `chunkRows`; a full chunk is looked up
 * and written *inside* the awaited `onRow`, so the CSV parser stays paused
 * while the chunk is written (back-pressure). A tentative update (row has a
 * non-empty `id` or `external_id`) whose key misses in `lookupExisting`
 * becomes a create -- the key just does not belong to an existing row yet.
 */
export async function runImport(deps: RunImportDeps): Promise<RunImportResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const chunkRows = deps.chunkRows ?? DEFAULT_CHUNK_ROWS;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const progressIntervalMs = deps.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  const startedAt = now();

  const metadata: ProgressMetadata = {
    total: deps.total ?? null,
    processed: 0,
    created: 0,
    updated: 0,
    failed: 0,
    invalid: 0,
  };

  let cancelled = false;
  let headerSeen = false;
  let headerCells: string[] = [];
  let byIndex: Array<string | null> = [];
  const errorLines: string[] = [];
  const seenIds = new Set<string>();
  const seenExternalIds = new Set<string>();
  let buffer: BufferedRow[] = [];
  let lastTickAt = startedAt;

  function pushErrorLine(cells: string[], message: string): void {
    errorLines.push(csvLine([...cells, message]));
  }

  async function runCreate(row: ImportRow, cells: string[]): Promise<void> {
    try {
      await deps.createItem(buildCreateInput(row, deps.access));
      metadata.created++;
    } catch (e) {
      metadata.failed++;
      pushErrorLine(cells, e instanceof Error ? e.message : String(e));
    }
  }

  async function runUpdate(existing: ExistingRow, row: ImportRow, cells: string[]): Promise<void> {
    if (!deps.canWrite(existing)) {
      metadata.failed++;
      pushErrorLine(cells, "no write access");
      return;
    }
    try {
      await deps.updateItem(existing.id, buildUpdateInput(row));
      metadata.updated++;
    } catch (e) {
      metadata.failed++;
      pushErrorLine(cells, e instanceof Error ? e.message : String(e));
    }
  }

  async function processChunk(chunk: BufferedRow[]): Promise<void> {
    if (chunk.length === 0) return;

    const toCreate: Array<{ row: ImportRow; cells: string[] }> = [];
    const toUpdate: Array<{ row: ImportRow; by: "id" | "external_id"; key: string; cells: string[] }> = [];

    for (const { index, cells } of chunk) {
      const row = buildRow(index, cells, byIndex, deps.fields);
      metadata.processed++;
      if (!rowIsValid(row)) {
        metadata.invalid++;
        pushErrorLine(cells, row.errors.join("; "));
        continue;
      }
      const action = rowAction(row);
      if (action.action === "create") {
        toCreate.push({ row, cells });
        continue;
      }
      // Duplicate keys within one import: a later row reusing an id/external_id
      // already seen in this run is invalid, not written.
      const seen = action.by === "id" ? seenIds : seenExternalIds;
      if (seen.has(action.key)) {
        metadata.invalid++;
        pushErrorLine(cells, `duplicateKey:${action.by}`);
        continue;
      }
      seen.add(action.key);
      toUpdate.push({ row, by: action.by, key: action.key, cells });
    }

    const ids = toUpdate.filter((u) => u.by === "id").map((u) => u.key);
    const externalIds = toUpdate.filter((u) => u.by === "external_id").map((u) => u.key);
    const existingRows =
      ids.length > 0 || externalIds.length > 0 ? await deps.lookupExisting(ids, externalIds) : [];
    const byId = new Map(existingRows.map((r) => [r.id, r] as const));
    const byExternalId = new Map(
      existingRows.filter((r) => r.external_id != null).map((r) => [r.external_id as string, r] as const),
    );

    const tasks: Array<() => Promise<void>> = [];
    for (const { row, cells } of toCreate) {
      tasks.push(() => runCreate(row, cells));
    }
    for (const u of toUpdate) {
      const existing = u.by === "id" ? byId.get(u.key) : byExternalId.get(u.key);
      tasks.push(existing ? () => runUpdate(existing, u.row, u.cells) : () => runCreate(u.row, u.cells));
    }

    await runPool(tasks, concurrency, (task) => task());
  }

  async function tick(): Promise<void> {
    lastTickAt = now();
    await deps.writeProgress({ ...metadata });
  }

  try {
    await streamCsvRows(deps.stream, {
      onHeader: (headers) => {
        headerSeen = true;
        headerCells = headers;
        const resolved = resolveMapping(headers, deps.fields, deps.mapping);
        byIndex = resolved.byIndex;
        const nameMapped = byIndex.includes("name");
        const keyMapped = byIndex.includes("id") || byIndex.includes("external_id");
        const allUnmapped = byIndex.every((f) => f === null);
        if (allUnmapped || (!nameMapped && !keyMapped)) {
          throw new ImportAbort("NO_MAPPABLE_COLUMNS");
        }
      },
      onRow: async (cells, index) => {
        buffer.push({ index, cells });
        const intervalElapsed = now() - lastTickAt >= progressIntervalMs;
        if (buffer.length < chunkRows && !intervalElapsed) return;

        const chunk = buffer;
        buffer = [];
        await processChunk(chunk);
        await tick();
        if (await deps.isCancelRequested()) {
          cancelled = true;
          log(`import: cancelled after ${metadata.processed} rows`);
          throw new RunCancelled();
        }
      },
    });
  } catch (e) {
    if (!(e instanceof RunCancelled)) throw e;
  }

  if (!headerSeen) {
    throw new ImportAbort("EMPTY_FILE");
  }

  if (!cancelled && buffer.length > 0) {
    const chunk = buffer;
    buffer = [];
    await processChunk(chunk);
    await tick();
    if (await deps.isCancelRequested()) {
      cancelled = true;
    }
  }

  let errorReportKey: string | null = null;
  if (errorLines.length > 0) {
    const csv = "﻿" + [csvLine([...headerCells, "import_error"]), ...errorLines].join("\n");
    errorReportKey = await deps.uploadErrorReport(csv);
  }

  log(
    `import: completed -- processed ${metadata.processed}, created ${metadata.created}, ` +
      `updated ${metadata.updated}, failed ${metadata.failed}, invalid ${metadata.invalid}`,
  );

  return {
    ...metadata,
    durationMs: now() - startedAt,
    errorReportKey,
    cancelled,
  };
}
