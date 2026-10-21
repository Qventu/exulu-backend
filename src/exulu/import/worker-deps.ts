import { getTableName } from "@SRC/exulu/table-names";
import { uploadFile } from "@SRC/uppy";
import { JOB_STATUS_ENUM } from "@EXULU_TYPES/enums/jobs";
import type { ExuluConfig } from "@SRC/exulu/app/index";
import type { ColumnMapping, ImportField } from "./mapping";
import type { BatchAccess } from "./rows";
import type { ExistingRow, ProgressMetadata, RunImportDeps, RunImportResult } from "./run-import";

/** The acting user for an import run, as carried on RunImportDeps.user. */
export type ImportUser = { id: number; super_admin?: boolean; role?: unknown; team?: unknown };

/**
 * One grant row from the shared `rbac` table (ee/rbac-update.ts), as attached
 * to an ExistingRow's `RBAC` field by lookupExisting.
 */
type RbacGrant = {
  access_type: "User" | "Role" | "Team";
  user_id?: number | string | null;
  role_id?: string | null;
  team_id?: string | null;
  rights?: "read" | "write" | null;
};

function grantsOf(existing: ExistingRow): RbacGrant[] {
  const raw = (existing as { RBAC?: unknown }).RBAC;
  return Array.isArray(raw) ? (raw as RbacGrant[]) : [];
}

/**
 * Item tables declare `id` as a `uuid` column (createItemsTable,
 * src/exulu/context.ts). A CSV's `id` column is free text -- a row quoting
 * some other system's non-uuid key there (e.g. a SKU) must not reach
 * `whereIn("id", ...)`, or Postgres rejects the whole query ("invalid input
 * syntax for type uuid") and fails every row in the chunk, not just the bad
 * one. `external_id` is a plain text column and is never filtered.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * `user.role` / `user.team` each arrive either as a bare uuid string or a
 * hydrated `{ id, ... }` row (auth.ts hydrates when the role/team still
 * exists; unhydrated it is still just the uuid string).
 */
function idOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value != null && typeof value === "object" && "id" in value) {
    const id = (value as { id: unknown }).id;
    if (typeof id === "string") return id;
    if (typeof id === "number") return String(id);
  }
  return undefined;
}

/**
 * Per-record write gate for an update target, porting validateWriteAccess's
 * rules (src/graphql/mutations/index.ts lines 365-430, mirrored for item rows
 * by src/utils/check-item-write-access.ts) to the pre-fetched ExistingRow
 * shape lookupExisting returns.
 *
 * Must stay synchronous: run-import.ts calls `deps.canWrite(existing)`
 * without awaiting it (RunImportDeps.canWrite returns `boolean`, not a
 * Promise), so it cannot query the `rbac` table itself the way
 * checkItemWriteAccess does -- lookupExisting batches those grants (users,
 * roles, AND teams -- mirrors src/graphql/mutations/index.ts:444-461 and
 * src/utils/check-item-write-access.ts:84-98) onto `existing.RBAC` once per
 * chunk instead of a query per row.
 */
export function canWrite(existing: ExistingRow, user: ImportUser): boolean {
  if (user.super_admin === true) return true;
  if (existing.rights_mode === "public") return true;

  const isCreator = existing.created_by != null && String(existing.created_by) === String(user.id);
  if (existing.rights_mode === "private") return isCreator;
  // The creator can always edit their own record, regardless of how it is
  // shared (matches validateWriteAccess's and checkItemWriteAccess's fallback).
  if (isCreator) return true;

  if (existing.rights_mode === "users") {
    return grantsOf(existing).some(
      (g) => g.access_type === "User" && String(g.user_id) === String(user.id) && g.rights === "write",
    );
  }

  if (existing.rights_mode === "roles") {
    const roleId = idOf(user.role);
    if (!roleId) return false;
    return grantsOf(existing).some(
      (g) => g.access_type === "Role" && String(g.role_id) === roleId && g.rights === "write",
    );
  }

  if (existing.rights_mode === "teams") {
    const teamId = idOf(user.team);
    if (!teamId) return false;
    return grantsOf(existing).some(
      (g) => g.access_type === "Team" && String(g.team_id) === teamId && g.rights === "write",
    );
  }

  // Any other/unknown rights_mode: deny.
  return false;
}

async function selectItemsBy(
  db: any,
  tableName: string,
  column: "id" | "external_id",
  values: string[],
): Promise<ExistingRow[]> {
  if (values.length === 0) return [];
  return db(tableName)
    .select("id", "external_id", "rights_mode", "created_by")
    .whereIn(column, values);
}

/**
 * Loads the candidate existing rows for a chunk's would-be updates, plus (in
 * one extra, batched query -- not one per row) any `rbac` grants on them, so
 * `canWrite` above can stay synchronous.
 *
 * Direct knex query rather than `context.getItems`: getItems applies
 * applyAccessControl's READ scoping for a given user, which is the wrong
 * question here (we need the raw row to evaluate WRITE access ourselves,
 * including rows the acting user cannot read-filter their way to, e.g. a
 * private row owned by someone else that should surface as "no write
 * access" rather than silently vanish from the lookup and get miscounted as
 * a create). getItems also has no way to select the `rbac` grants at all.
 *
 * `ids` is filtered to uuid-shaped strings before it ever reaches
 * `whereIn("id", ...)` -- `id` is a `uuid` PK column, and a CSV's id column
 * is free text (a non-uuid key like a SKU is a tentative-update signal, not
 * a real row reference); an unfiltered non-uuid value in that `whereIn`
 * would make Postgres reject the whole query ("invalid input syntax for
 * type uuid"), failing every row in the chunk instead of just the one with
 * the bad id. `external_id` is a plain text column and stays unfiltered.
 */
export async function lookupExisting(
  db: any,
  tableName: string,
  ids: string[],
  externalIds: string[],
): Promise<ExistingRow[]> {
  const [byId, byExternalId] = await Promise.all([
    selectItemsBy(db, tableName, "id", ids.filter(isUuid)),
    selectItemsBy(db, tableName, "external_id", externalIds),
  ]);
  const merged = new Map<string, ExistingRow>();
  for (const row of [...byId, ...byExternalId]) merged.set(row.id, row);
  const rows = [...merged.values()];
  if (rows.length === 0) return [];

  // Only rows shared via a grant-based rights_mode can ever need a grant --
  // skip the extra query entirely when none of this chunk's matches do
  // (the common case: most rows are "private" or "public").
  const needsGrants = rows.some(
    (r) => r.rights_mode === "users" || r.rights_mode === "roles" || r.rights_mode === "teams",
  );
  if (!needsGrants) {
    return rows.map((r) => ({ ...r, RBAC: [] }));
  }

  const grants: Array<RbacGrant & { target_resource_id: string }> = await db("rbac")
    .select("target_resource_id", "access_type", "user_id", "role_id", "team_id", "rights")
    .where({ entity: tableName })
    .whereIn(
      "target_resource_id",
      rows.map((r) => r.id),
    );

  const grantsByItem = new Map<string, RbacGrant[]>();
  for (const g of grants) {
    const list = grantsByItem.get(g.target_resource_id) ?? [];
    list.push(g);
    grantsByItem.set(g.target_resource_id, list);
  }
  return rows.map((r) => ({ ...r, RBAC: grantsByItem.get(r.id) ?? [] }));
}

/** `job_results.metadata` / `trigger_metadata` arrive as jsonb objects or strings. */
export function parseMetadata(value: unknown): Record<string, any> {
  if (value == null) return {};
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, any>) : {};
}

/**
 * `job_results.metadata` is a `jsonb` column (declared `type: "json"` in
 * ee/schemas.ts, but src/utils/map-types.ts's `"json"` branch calls
 * `table.jsonb(name)` -- the physical Postgres type is jsonb). `||` is
 * jsonb's own top-level merge operator: keys in `patch` overwrite keys
 * already in the column, everything else (notably `cancelRequested`, set by
 * the Cancel mutation outside the run loop) is left untouched.
 */
export function mergeMetadataRaw(db: any, patch: Record<string, unknown>): unknown {
  return db.raw("coalesce(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify(patch)]);
}

/**
 * Merges the run loop's latest counters into the row's metadata in a single
 * UPDATE (D-Fix F4): a prior read-merge-write round-tripped through this
 * process's memory between the SELECT and the UPDATE, so a `cancelRequested`
 * write landing in that window (the Cancel mutation, racing a progress tick)
 * would be read, then silently overwritten back to absent by this UPDATE
 * once it ran -- the merge now happens inside the single statement, in the
 * database, so no window exists for another writer to lose.
 */
export async function writeProgress(db: any, jobResultId: string, m: ProgressMetadata): Promise<void> {
  await db("job_results")
    .where({ id: jobResultId })
    .update({ metadata: mergeMetadataRaw(db, m) });
}

export async function isCancelRequested(db: any, jobResultId: string): Promise<boolean> {
  const row = await db("job_results").where({ id: jobResultId }).select("metadata").first();
  return parseMetadata(row?.metadata).cancelRequested === true;
}

/**
 * Persists a cancelled run's final result (D-Fix F6): the cancelled path
 * previously only CASed `state` to "cancelled" and returned `{ result,
 * metadata: result }` for the worker's `completed`/`failed` handlers to
 * persist -- but neither handler runs for a return value on the already-
 * terminal "cancelled" state (the `completed` handler's own CAS requires
 * `state = "active"`, which no longer matches once this flips it), so
 * `result`/`errorReportKey` were silently dropped on every cancelled run.
 * This single, CAS-guarded UPDATE sets state, result, AND merges the final
 * counters + errorReportKey into metadata (same atomic merge as
 * writeProgress) all at once, so nothing else needs to write afterward.
 */
export async function finalizeCancelled(
  db: any,
  jobResultId: string,
  result: RunImportResult,
): Promise<void> {
  await db("job_results")
    .where({ id: jobResultId })
    .whereIn("state", [JOB_STATUS_ENUM.active])
    .update({
      state: JOB_STATUS_ENUM.cancelled,
      result: JSON.stringify(result),
      metadata: mergeMetadataRaw(db, result),
    });
}

/**
 * Uploads the run's error-report CSV under a stable, predictable key (not
 * the uploading user's private `user_<id>/` prefix -- `global: true` -- the
 * report belongs to the job/context, not to whoever happened to trigger it)
 * and returns uploadFile's bucket/key string unchanged, the same form the
 * frontend already handles for every other stored-file reference.
 */
export async function uploadErrorReport(
  csv: string,
  contextId: string,
  jobResultId: string,
  config: ExuluConfig,
  user?: number,
): Promise<string> {
  const buffer = Buffer.from(csv, "utf-8");
  const fileName = `imports/${contextId}/${jobResultId}-errors.csv`;
  return uploadFile(buffer, fileName, config, { contentType: "text/csv" }, user, undefined, true);
}

/** The minimal context surface buildWorkerDeps needs (not the full ExuluContext). */
export type ImportContext = {
  createItem: (
    item: Record<string, unknown>,
    config: ExuluConfig,
    user?: number,
    role?: string,
    upsert?: boolean,
    generateEmbeddingsOverwrite?: boolean,
  ) => Promise<unknown>;
  updateItem: (
    item: Record<string, unknown>,
    config: ExuluConfig,
    user?: number,
    role?: string,
    generateEmbeddingsOverwrite?: boolean,
  ) => Promise<unknown>;
};

export type BuildWorkerDepsInput = {
  db: any;
  config: ExuluConfig;
  context: ImportContext;
  contextId: string;
  jobResultId: string;
  stream: NodeJS.ReadableStream;
  fields: ImportField[];
  mapping?: ColumnMapping[];
  access: BatchAccess;
  options: { skipEmbeddings?: boolean };
  user: ImportUser;
  log?: (m: string) => void;
};

/**
 * Builds the RunImportDeps the run loop (run-import.ts) needs, wiring its
 * injected hooks to this job's db/config/context/job_results row. Kept
 * separate from the ee/workers.ts dispatch branch so the wiring itself --
 * canWrite, the progress merge, the error-report key -- is unit-testable
 * without a worker or a live queue.
 */
export function buildWorkerDeps(input: BuildWorkerDepsInput): RunImportDeps {
  const { db, config, context, contextId, jobResultId, stream, fields, mapping, access, options, user, log } =
    input;
  const tableName = getTableName(contextId);
  const roleId = idOf(user.role);
  // D6/Review Focus 6: the loop already decided create vs. update, so both
  // calls pass upsert=false; skipEmbeddings forces the overwrite to `false`,
  // otherwise leaving it `undefined` so the context's own calculateVectors
  // configuration decides.
  const generateEmbeddingsOverwrite = options.skipEmbeddings ? false : undefined;

  return {
    stream,
    fields,
    mapping,
    access,
    options,
    user,
    log,
    lookupExisting: (ids, externalIds) => lookupExisting(db, tableName, ids, externalIds),
    canWrite: (existing) => canWrite(existing, user),
    createItem: async (itemInput) => {
      await context.createItem(itemInput, config, user.id, roleId, false, generateEmbeddingsOverwrite);
    },
    // buildUpdateInput (rows.ts) never carries an id/rights_mode/RBAC -- the
    // target's id is threaded in here, same as the GraphQL updateOne path.
    updateItem: async (id, itemInput) => {
      await context.updateItem({ id, ...itemInput }, config, user.id, roleId, generateEmbeddingsOverwrite);
    },
    writeProgress: (m) => writeProgress(db, jobResultId, m),
    isCancelRequested: () => isCancelRequested(db, jobResultId),
    uploadErrorReport: (csv) => uploadErrorReport(csv, contextId, jobResultId, config, user.id),
  };
}
