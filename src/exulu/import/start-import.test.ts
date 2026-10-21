// Module mocks are hoisted above imports (jest.mock factory pattern used
// across the repo, e.g. src/exulu/import/worker-deps.test.ts). start-import.ts
// pulls in worker-deps.ts (for mergeMetadataRaw), which itself imports
// @SRC/uppy -- mocked here for the same reason worker-deps.test.ts mocks it:
// keep this suite free of real S3/Postgres module side effects.
const uploadFileSpy = jest.fn(async () => "test-bucket/unused");
jest.mock("@SRC/uppy", () => ({
  uploadFile: (...args: any[]) => uploadFileSpy(...args),
}));

import knexFactory from "knex";
import { startImport, cancelImport, StartImportError } from "./start-import";
import type { StartImportArgs, StartImportDeps } from "./start-import";

// Connectionless real knex instance (same pattern as worker-deps.test.ts):
// lets `db.raw(...)` compile genuine SQL -- via `.toString()` -- without a
// live database, so the atomic cancelRequested merge can be asserted on
// verbatim instead of guessed at through a hand-rolled fake.
const k = knexFactory({ client: "pg" });

/** Fake `job_results` query builder: records every call, `db.raw` is real. */
function fakeDb(opts: { first?: any } = {}) {
  const calls: Record<string, any[][]> = {};
  const builder: any = {};
  const record =
    (name: string) =>
    (...args: any[]) => {
      (calls[name] ||= []).push(args);
      return builder;
    };
  builder.where = record("where");
  builder.whereIn = record("whereIn");
  builder.first = jest.fn(async () => opts.first);
  builder.insert = jest.fn(async (values: any) => {
    (calls["insert"] ||= []).push([values]);
    return undefined;
  });
  builder.update = jest.fn(async (values: any) => {
    (calls["update"] ||= []).push([values]);
    return 1;
  });
  const db: any = jest.fn(() => builder);
  db.raw = (...args: any[]) => k.raw(...args);
  return { db, calls, builder };
}

const config: any = { fileUploads: { s3Bucket: "test-bucket" } };

const baseArgs: StartImportArgs = {
  contextId: "ctx-1",
  s3Key: "test-bucket/uploads/file.csv",
  fileName: "file.csv",
  access: { rights_mode: "private" },
  trigger: "ui",
};

function makeDeps(
  overrides: Partial<StartImportDeps> = {},
  dbOpts: { first?: any } = {},
) {
  const { db, calls, builder } = fakeDb(dbOpts);
  const queue = {
    add: jest.fn(async () => ({ id: "bull-1" })),
    getJob: jest.fn(async (): Promise<{ remove: () => Promise<void> } | undefined> => undefined),
  };
  const deps: StartImportDeps = {
    db,
    config,
    queue,
    user: { id: 7, super_admin: false, role: { id: "role-1" } },
    contextExists: (id: string) => id === "ctx-1",
    uuid: () => "job-1",
    ...overrides,
  };
  return { deps, calls, builder, queue };
}

describe("startImport", () => {
  it("throws CONTEXT_NOT_FOUND when the context is not registered", async () => {
    const { deps, calls, queue } = makeDeps({ contextExists: () => false });

    await expect(startImport(deps, baseArgs)).rejects.toMatchObject({ code: "CONTEXT_NOT_FOUND" });
    await expect(startImport(deps, baseArgs)).rejects.toBeInstanceOf(StartImportError);
    expect(calls["insert"]).toBeUndefined();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("rejects an s3Key outside the configured bucket without inserting or enqueuing (Review Focus 5)", async () => {
    const { deps, calls, queue } = makeDeps();
    const args = { ...baseArgs, s3Key: "other-bucket/x.csv" };

    await expect(startImport(deps, args)).rejects.toMatchObject({ code: "IMPORT_S3_KEY_OUTSIDE_BUCKET" });
    expect(calls["insert"]).toBeUndefined();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("throws IMPORT_ALREADY_RUNNING when a waiting/active import already exists for the context", async () => {
    const { deps, calls, queue } = makeDeps({}, { first: { id: "existing-job" } });

    await expect(startImport(deps, baseArgs)).rejects.toMatchObject({ code: "IMPORT_ALREADY_RUNNING" });
    expect(calls["insert"]).toBeUndefined();
    expect(queue.add).not.toHaveBeenCalled();
    expect(calls["where"]![0]![0]).toEqual({ context: "ctx-1", type: "import" });
    expect(calls["whereIn"]![0]!).toEqual(["state", ["waiting", "active"]]);
  });

  it("inserts a waiting job_results row and enqueues the import job on the happy path", async () => {
    const { deps, calls, queue } = makeDeps({}, { first: undefined });

    const result = await startImport(deps, baseArgs);
    expect(result).toEqual({ jobResultId: "job-1" });

    const inserted = calls["insert"]![0]![0];
    expect(inserted).toMatchObject({
      id: "job-1",
      job_id: "job-1",
      type: "import",
      context: "ctx-1",
      label: "Import file.csv",
      state: "waiting",
      trigger: "ui",
    });

    const triggerMetadata = JSON.parse(inserted.trigger_metadata);
    expect(triggerMetadata).toMatchObject({
      s3Key: "test-bucket/uploads/file.csv",
      fileName: "file.csv",
      access: { rights_mode: "private" },
    });
    expect(triggerMetadata.user).toEqual({ id: 7, super_admin: false, role: "role-1" });

    expect(JSON.parse(inserted.metadata)).toEqual({
      total: 0,
      processed: 0,
      created: 0,
      updated: 0,
      failed: 0,
      invalid: 0,
    });

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [jobName, jobData, jobOpts] = queue.add.mock.calls[0]!;
    expect(jobName).toBe("import");
    expect(jobData).toMatchObject({
      label: "Import file.csv",
      type: "import",
      trigger: "api",
      timeoutInSeconds: 6 * 3600,
      inputs: {},
      jobResultId: "job-1",
      context: "ctx-1",
      user: 7,
      role: "role-1",
    });
    expect(jobOpts).toEqual({
      jobId: "job-1",
      attempts: 1,
      removeOnComplete: 5000,
      removeOnFail: 5000,
    });
  });

  it("carries totalRows into metadata.total and defaults to 0 when absent", async () => {
    const { deps, calls } = makeDeps({}, { first: undefined });
    await startImport(deps, { ...baseArgs, totalRows: 123 });
    const inserted = calls["insert"]![0]![0];
    expect(JSON.parse(inserted.metadata).total).toBe(123);
  });

  it("normalizes a hydrated team object to its id in the trigger_metadata user snapshot", async () => {
    const { deps, calls } = makeDeps(
      { user: { id: 7, super_admin: true, role: "role-bare", team: { id: "team-1" } } },
      { first: undefined },
    );
    await startImport(deps, baseArgs);
    const inserted = calls["insert"]![0]![0];
    const triggerMetadata = JSON.parse(inserted.trigger_metadata);
    expect(triggerMetadata.user).toEqual({
      id: 7,
      super_admin: true,
      role: "role-bare",
      team: "team-1",
    });
  });

  it("passes trigger: api through to the job_results row when the resolver determined an API caller", async () => {
    const { deps, calls } = makeDeps({}, { first: undefined });
    await startImport(deps, { ...baseArgs, trigger: "api" });
    const inserted = calls["insert"]![0]![0];
    expect(inserted.trigger).toBe("api");
  });
});

describe("cancelImport", () => {
  function runningRow(state: string, starter: unknown = 7) {
    return {
      id: "job-1",
      state,
      trigger_metadata: { user: { id: starter, super_admin: false } },
    };
  }

  it("throws NOT_AUTHORIZED when the caller is neither the starter nor a super admin", async () => {
    const { deps } = makeDeps(
      { user: { id: 99, super_admin: false } },
      { first: runningRow("waiting", 7) },
    );
    await expect(cancelImport(deps, "job-1")).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  });

  it("removes the queued job and sets state cancelled when the row is still waiting", async () => {
    const remove = jest.fn(async () => undefined);
    const { deps, calls, queue } = makeDeps(
      { user: { id: 7, super_admin: false } },
      { first: runningRow("waiting", 7) },
    );
    queue.getJob.mockResolvedValue({ remove });

    const result = await cancelImport(deps, "job-1");
    expect(result).toEqual({ ok: true });
    expect(queue.getJob).toHaveBeenCalledWith("job-1");
    expect(remove).toHaveBeenCalledTimes(1);

    expect(calls["update"]).toHaveLength(2);
    const metadataUpdate = calls["update"]!.find((c) => "metadata" in c[0]!)!;
    expect(metadataUpdate[0].metadata.toString()).toBe(
      `coalesce(metadata, '{}'::jsonb) || '${JSON.stringify({ cancelRequested: true })}'::jsonb`,
    );
    const stateUpdate = calls["update"]!.find((c) => "state" in c[0]!)!;
    expect(stateUpdate[0]).toEqual({ state: "cancelled" });
  });

  it("only flags cancelRequested (no remove, no state change) when the row is already active", async () => {
    const { deps, calls, queue } = makeDeps(
      { user: { id: 7, super_admin: false } },
      { first: runningRow("active", 7) },
    );

    const result = await cancelImport(deps, "job-1");
    expect(result).toEqual({ ok: true });
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(calls["update"]).toHaveLength(1);
    expect(calls["update"]![0]![0].metadata.toString()).toBe(
      `coalesce(metadata, '{}'::jsonb) || '${JSON.stringify({ cancelRequested: true })}'::jsonb`,
    );
  });

  it("allows a super admin to cancel someone else's import", async () => {
    const { deps } = makeDeps(
      { user: { id: 99, super_admin: true } },
      { first: runningRow("active", 7) },
    );
    await expect(cancelImport(deps, "job-1")).resolves.toEqual({ ok: true });
  });

  it("tolerates a bare-number trigger_metadata.user snapshot for the starter check", async () => {
    const { deps } = makeDeps(
      { user: { id: 7, super_admin: false } },
      { first: { id: "job-1", state: "active", trigger_metadata: { user: 7 } } },
    );
    await expect(cancelImport(deps, "job-1")).resolves.toEqual({ ok: true });
  });

  it("is a no-op when the row does not exist", async () => {
    const { deps, calls } = makeDeps({}, { first: undefined });
    await expect(cancelImport(deps, "missing")).resolves.toEqual({ ok: true });
    expect(calls["update"]).toBeUndefined();
  });

  it("is a no-op when the row is already in a terminal state", async () => {
    const { deps, calls } = makeDeps({}, { first: runningRow("completed", 7) });
    await expect(cancelImport(deps, "job-1")).resolves.toEqual({ ok: true });
    expect(calls["update"]).toBeUndefined();
  });
});
