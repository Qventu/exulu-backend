import { randomUUID } from "node:crypto";
import type { ExuluConfig } from "@SRC/exulu/app/index";
import { serializeError } from "@SRC/utils/serialize-error";
import type { ColumnMapping } from "./mapping";
import { asGrantList } from "./rows";
import type { BatchAccess } from "./rows";
import { mergeMetadataRaw, parseMetadata } from "./worker-deps";
import type { ImportUser } from "./worker-deps";

/**
 * `user.role` / `user.team` on the acting user arrive either as a bare uuid
 * string or a hydrated `{ id, ... }` row (mirrors worker-deps.ts's `idOf`,
 * duplicated locally rather than imported so this module stays limited to
 * the two sanctioned imports from worker-deps.ts, `mergeMetadataRaw` and
 * `parseMetadata`).
 */
function idOrSelf(value: unknown): unknown {
  if (value != null && typeof value === "object" && "id" in (value as Record<string, unknown>)) {
    return (value as { id: unknown }).id;
  }
  return value;
}

/**
 * The `rights_mode` values `canWrite` (worker-deps.ts) and `validateWriteAccess`
 * (src/graphql/mutations/index.ts) both understand -- kept identical to
 * mutations/index.ts's own `VALID_RIGHTS_MODES` (duplicated rather than
 * imported, since importing from the GraphQL mutations module would pull
 * GraphQL into this dependency-injected, Redis/Postgres-free module).
 */
const VALID_RIGHTS_MODES = ["private", "users", "roles", "teams", "public"];

export type StartImportArgs = {
  contextId: string;
  s3Key: string;
  fileName: string;
  mapping?: ColumnMapping[];
  access: BatchAccess;
  options?: { skipEmbeddings?: boolean; delimiter?: string };
  trigger: "ui" | "api";
  totalRows?: number;
};

/**
 * Everything startImport/cancelImport need, injected -- no direct I/O, no
 * GraphQL/BullMQ imports, so both are unit-testable without Redis/Postgres.
 * `user` reuses worker-deps.ts's `ImportUser` shape (rather than a narrower
 * inline type) because the trigger_metadata.user snapshot this module writes
 * must carry `team` too, for the worker's `canWrite` to read back later.
 */
export type StartImportDeps = {
  db: any;
  config: ExuluConfig;
  queue: {
    add: (name: string, data: unknown, opts: unknown) => Promise<{ id?: string }>;
    getJob?: (id: string) => Promise<{ remove: () => Promise<void> } | undefined>;
  };
  user: ImportUser;
  contextExists: (id: string) => boolean;
  now?: () => Date;
  uuid?: () => string;
};

export class StartImportError extends Error {
  constructor(
    public readonly code:
      | "CONTEXT_NOT_FOUND"
      | "IMPORT_ALREADY_RUNNING"
      | "IMPORT_S3_KEY_OUTSIDE_BUCKET"
      | "IMPORT_S3_KEY_NOT_ALLOWED"
      | "INVALID_RIGHTS_MODE"
      | "INVALID_DELIMITER"
      | "IMPORT_NOT_FOUND"
      | "NOT_AUTHORIZED",
  ) {
    super(code);
    this.name = "StartImportError";
  }
}

/**
 * Starts a server-side bulk import: validates the target context and the
 * uploaded file's bucket, enforces one running import per context, then
 * inserts the job_results row (state "waiting") and enqueues the BullMQ job
 * -- in that order, so a crash between insert and enqueue leaves a row the
 * operator can see and retry/clean up, never an orphaned queue job with no
 * row to report progress against.
 */
export async function startImport(
  deps: StartImportDeps,
  args: StartImportArgs,
): Promise<{ jobResultId: string }> {
  const { db, config, queue, user, contextExists, uuid } = deps;

  if (!contextExists(args.contextId)) {
    throw new StartImportError("CONTEXT_NOT_FOUND");
  }

  if (!VALID_RIGHTS_MODES.includes(args.access.rights_mode)) {
    throw new StartImportError("INVALID_RIGHTS_MODE");
  }

  // The grant lists come in as GraphQL `JSON`, so `null` (what the operator
  // notes' own example sends for the lists a batch does not use) and any
  // other non-array shape are both possible. Normalise once, here, so
  // trigger_metadata only ever stores arrays: handleRBACUpdate's `= []`
  // destructuring defaults do not cover `null`, and a stored `null` would
  // make it throw on `null.map(...)` and fail every create row of a
  // users/roles/teams import.
  const access: BatchAccess = {
    ...args.access,
    users: asGrantList(args.access.users),
    roles: asGrantList(args.access.roles),
    teams: asGrantList(args.access.teams),
  };

  // csv-parse rejects a delimiter that is not exactly one character
  // (CSV_INVALID_OPTION_DELIMITER) -- but only once the worker has the file
  // open, which would mark the whole run failed after the upload. Refuse it
  // here instead, before anything is written or enqueued.
  if (args.options?.delimiter != null && args.options.delimiter.length !== 1) {
    throw new StartImportError("INVALID_DELIMITER");
  }

  // s3Key arrives in the frontend's "bucket/key" form (uploadFile's return
  // shape) -- reject anything outside this deployment's configured bucket
  // before any insert or enqueue (Review Focus 5).
  const bucket = args.s3Key.split("/")[0];
  if (bucket !== config.fileUploads?.s3Bucket) {
    throw new StartImportError("IMPORT_S3_KEY_OUTSIDE_BUCKET");
  }

  // Per-user prefix confinement, the same predicate `GET /s3/download` and
  // the delete route apply (src/uppy/index.ts): a key under somebody else's
  // `user_<id>/` upload prefix is refused, because an import is a read
  // primitive -- it would otherwise stream another user's private upload and
  // materialise its contents as items the caller can read. Super admins and
  // API-key callers are exempt there, so they are exempt here too. Keys with
  // no `user_` segment at all (shared/global prefixes such as `imports/...`)
  // are unaffected.
  const keyWithoutBucket = args.s3Key.split("/").slice(1).join("/");
  const prefixAllowed =
    user.type === "api" ||
    user.super_admin === true ||
    !keyWithoutBucket.includes("user_") ||
    keyWithoutBucket.includes(`user_${user.id}/`);
  if (!prefixAllowed) {
    throw new StartImportError("IMPORT_S3_KEY_NOT_ALLOWED");
  }

  const running = await db("job_results")
    .where({ context: args.contextId, type: "import" })
    .whereIn("state", ["waiting", "active"])
    .first();
  if (running) {
    throw new StartImportError("IMPORT_ALREADY_RUNNING");
  }

  const id = (uuid ?? randomUUID)();
  const label = `Import ${args.fileName}`;

  // Snapshot of the acting user at start time -- the worker (ee/workers.ts
  // import branch) and canWrite (worker-deps.ts) read exactly this shape
  // back off trigger_metadata.user, since the BullMQ job's own top-level
  // user/role fields carry neither super_admin nor team.
  const userSnapshot = {
    id: user.id,
    super_admin: user.super_admin === true,
    role: idOrSelf(user.role),
    team: idOrSelf(user.team),
  };

  await db("job_results").insert({
    id,
    job_id: id,
    type: "import",
    context: args.contextId,
    label,
    state: "waiting",
    trigger: args.trigger,
    trigger_metadata: JSON.stringify({
      s3Key: args.s3Key,
      fileName: args.fileName,
      mapping: args.mapping,
      access,
      options: args.options,
      user: userSnapshot,
    }),
    metadata: JSON.stringify({
      total: args.totalRows ?? 0,
      processed: 0,
      created: 0,
      updated: 0,
      failed: 0,
      invalid: 0,
    }),
  });

  try {
    await queue.add(
      "import",
      {
        label,
        type: "import",
        // BullMqJobData.trigger is a STATISTICS_LABELS value, which has no
        // "ui" member -- "api" here is just that field's required value for
        // this queue path, unrelated to the job_results row's own ui|api
        // `trigger` column above (which records real run provenance).
        trigger: "api",
        timeoutInSeconds: 6 * 3600,
        // Required: bullmq.validate (src/validators/bullmq.ts) throws without
        // an `inputs` key, even though the import branch ignores it (its
        // inputs live on the job_results row's trigger_metadata instead).
        inputs: {},
        jobResultId: id,
        context: args.contextId,
        user: user.id,
        role: idOrSelf(user.role),
      },
      {
        jobId: id,
        attempts: 1,
        removeOnComplete: 5000,
        removeOnFail: 5000,
      },
    );
  } catch (error: unknown) {
    // The row was already inserted "waiting" -- a failed enqueue must not
    // leave it stuck there blocking the context's one-running-import gate
    // (IMPORT_ALREADY_RUNNING) forever. Mark it failed with the real reason
    // and rethrow so the caller still sees the original error.
    await db("job_results")
      .where({ id })
      .update({ state: "failed", error: JSON.stringify(serializeError(error)) });
    throw error;
  }

  return { jobResultId: id };
}

/**
 * Cancels a running (or still-queued) import. A missing row, or a row that is
 * not an import at all, is an error (IMPORT_NOT_FOUND) -- the caller passed a
 * jobResultId that was never started as an import, which is a real mistake
 * worth surfacing. A row already in a
 * terminal state (completed/failed/cancelled), by contrast, is treated as
 * nothing-to-cancel rather than an error: a double-click or a race with the
 * worker's own completion should never fail the caller.
 */
export async function cancelImport(
  deps: StartImportDeps,
  jobResultId: string,
): Promise<{ ok: true }> {
  const { db, queue, user } = deps;

  const row = await db("job_results").where({ id: jobResultId }).first();
  if (!row) {
    throw new StartImportError("IMPORT_NOT_FOUND");
  }
  // The per-context mutation prefix is cosmetic -- `job_results` holds every
  // job type, so without this an import-cancel could flag (and, below, even
  // cancel the row of) a workflow run or an eval the caller started.
  if (row.type !== "import") {
    throw new StartImportError("IMPORT_NOT_FOUND");
  }
  if (row.state !== "waiting" && row.state !== "active") {
    return { ok: true };
  }

  const meta = parseMetadata(row.trigger_metadata);
  const starterId = idOrSelf(meta.user);
  const isStarter = starterId != null && Number(starterId) === user.id;
  if (!isStarter && user.super_admin !== true) {
    throw new StartImportError("NOT_AUTHORIZED");
  }

  // Same atomic jsonb merge the run loop uses for progress (D-Fix F4,
  // worker-deps.ts's writeProgress) -- never read-merge-write, so a
  // concurrent progress tick can never lose this flag (or vice versa).
  await db("job_results")
    .where({ id: jobResultId })
    .update({ metadata: mergeMetadataRaw(db, { cancelRequested: true }) });

  if (row.state === "waiting") {
    try {
      // getJob is inside the guard too: a Redis outage here would otherwise
      // throw *after* cancelRequested was persisted and leave the row
      // "waiting", still blocking the context's one-import gate.
      const job = await queue.getJob?.(jobResultId);
      await job?.remove();
    } catch (error: unknown) {
      // cancelRequested is already persisted above -- a failed remove (e.g.
      // the worker grabbed the lock between our select and this call) must
      // not fail the cancel; the worker will see the flag and honour it.
      console.error("[EXULU] failed to remove queued import job after cancel", error);
    }
    await db("job_results")
      .where({ id: jobResultId })
      .whereIn("state", ["waiting"])
      .update({ state: "cancelled" });
  } else {
    // row.state === "active". Normally the running worker observes
    // cancelRequested at the next chunk boundary and finalizes the row
    // itself, so flagging is all that is needed. But if the BullMQ job no
    // longer exists, nothing will ever observe the flag -- the run died in a
    // way that never reached the "failed" handler (worker process gone, a
    // Postgres outage swallowing that handler's own write, the 6 h timeout on
    // a dead process) -- and D6's gate would refuse every future import for
    // this context with no API way out. Force the row terminal in that case,
    // CAS-guarded so a worker that is in fact still alive and completing
    // cannot be overwritten.
    try {
      const job = await queue.getJob?.(jobResultId);
      if (!job) {
        await db("job_results")
          .where({ id: jobResultId })
          .whereIn("state", ["active"])
          .update({ state: "cancelled" });
      }
    } catch (error: unknown) {
      // Redis unreachable: we cannot tell whether the job is gone, so leave
      // the row active (the flag is persisted) rather than guess.
      console.error("[EXULU] failed to inspect the running import job after cancel", error);
    }
  }

  return { ok: true };
}
