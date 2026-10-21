import { randomUUID } from "node:crypto";
import type { ExuluConfig } from "@SRC/exulu/app/index";
import type { ColumnMapping } from "./mapping";
import type { BatchAccess } from "./rows";
import { mergeMetadataRaw } from "./worker-deps";
import type { ImportUser } from "./worker-deps";

/**
 * `user.role` / `user.team` on the acting user arrive either as a bare uuid
 * string or a hydrated `{ id, ... }` row (mirrors worker-deps.ts's `idOf`,
 * duplicated locally rather than imported so this module stays limited to
 * the one sanctioned import from worker-deps.ts, `mergeMetadataRaw`).
 */
function idOrSelf(value: unknown): unknown {
  if (value != null && typeof value === "object" && "id" in (value as Record<string, unknown>)) {
    return (value as { id: unknown }).id;
  }
  return value;
}

/** `job_results.trigger_metadata` arrives as a jsonb object or (defensively) a JSON string. */
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

export type StartImportArgs = {
  contextId: string;
  s3Key: string;
  fileName: string;
  mapping?: ColumnMapping[];
  access: BatchAccess;
  options?: { skipEmbeddings?: boolean };
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

  // s3Key arrives in the frontend's "bucket/key" form (uploadFile's return
  // shape) -- reject anything outside this deployment's configured bucket
  // before any insert or enqueue (Review Focus 5).
  const bucket = args.s3Key.split("/")[0];
  if (bucket !== config.fileUploads?.s3Bucket) {
    throw new StartImportError("IMPORT_S3_KEY_OUTSIDE_BUCKET");
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
      access: args.access,
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

  return { jobResultId: id };
}

/**
 * Cancels a running (or still-queued) import. Idempotent: a missing row or
 * one already in a terminal state is treated as nothing-to-cancel rather
 * than an error, since a double-click or a race with the worker's own
 * completion should never surface as a hard failure to the caller.
 */
export async function cancelImport(
  deps: StartImportDeps,
  jobResultId: string,
): Promise<{ ok: true }> {
  const { db, queue, user } = deps;

  const row = await db("job_results").where({ id: jobResultId }).first();
  if (!row || (row.state !== "waiting" && row.state !== "active")) {
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
    const job = await queue.getJob?.(jobResultId);
    await job?.remove();
    await db("job_results")
      .where({ id: jobResultId })
      .whereIn("state", ["waiting"])
      .update({ state: "cancelled" });
  }

  return { ok: true };
}
