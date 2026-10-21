import { getTableName } from "@SRC/exulu/table-names";
import { uploadFile } from "@SRC/uppy";
import type { ExuluConfig } from "@SRC/exulu/app/index";
import type { ColumnMapping, ImportField } from "./mapping";
import type { BatchAccess } from "./rows";
import type { ExistingRow, ProgressMetadata, RunImportDeps } from "./run-import";

/** The acting user for an import run, as carried on RunImportDeps.user. */
export type ImportUser = { id: number; super_admin?: boolean; role?: unknown };

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

/** `user.role` arrives either as a bare uuid string or a hydrated `{ id, ... }` row. */
function roleIdOf(role: unknown): string | undefined {
  if (typeof role === "string") return role;
  if (role != null && typeof role === "object" && "id" in role) {
    const id = (role as { id: unknown }).id;
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
 * checkItemWriteAccess does -- lookupExisting batches those grants onto
 * `existing.RBAC` once per chunk instead of a query per row.
 *
 * No `teams` support: ImportUser (built from the import job's data) carries
 * no team membership -- the import job data never does -- so a
 * `teams`-shared record can never be written through this path. Deliberate,
 * documented gap, not a bug: such rows simply fail with "no write access"
 * the same way an unknown rights_mode would.
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
    const roleId = roleIdOf(user.role);
    if (!roleId) return false;
    return grantsOf(existing).some(
      (g) => g.access_type === "Role" && String(g.role_id) === roleId && g.rights === "write",
    );
  }

  // rights_mode === "teams" (no team on ImportUser, see doc comment) or any
  // other/unknown value: deny.
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
 */
export async function lookupExisting(
  db: any,
  tableName: string,
  ids: string[],
  externalIds: string[],
): Promise<ExistingRow[]> {
  const [byId, byExternalId] = await Promise.all([
    selectItemsBy(db, tableName, "id", ids),
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
function parseMetadata(value: unknown): Record<string, any> {
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
 * Merges the run loop's latest counters over the row's current metadata
 * (rather than overwriting it outright), so `cancelRequested` -- set by the
 * Cancel mutation directly on the row, outside the run loop -- survives
 * every progress tick.
 */
export async function writeProgress(db: any, jobResultId: string, m: ProgressMetadata): Promise<void> {
  const row = await db("job_results").where({ id: jobResultId }).select("metadata").first();
  const prev = parseMetadata(row?.metadata);
  await db("job_results")
    .where({ id: jobResultId })
    .update({ metadata: JSON.stringify({ ...prev, ...m }) });
}

export async function isCancelRequested(db: any, jobResultId: string): Promise<boolean> {
  const row = await db("job_results").where({ id: jobResultId }).select("metadata").first();
  return parseMetadata(row?.metadata).cancelRequested === true;
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
  const roleId = roleIdOf(user.role);
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
