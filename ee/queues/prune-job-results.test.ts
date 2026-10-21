import { TERMINAL_JOB_STATES } from "@EXULU_TYPES/enums/jobs";
import { maybePruneJobResults } from "./prune-job-results";

describe("TERMINAL_JOB_STATES", () => {
  it("is the single source of truth for prunable terminal states", () => {
    expect(TERMINAL_JOB_STATES).toEqual(["completed", "failed", "filtered", "cancelled"]);
  });

  it("never contains live or paused states", () => {
    for (const state of ["waiting", "active", "delayed", "paused", "waiting_approval", "stuck"]) {
      expect(TERMINAL_JOB_STATES).not.toContain(state);
    }
  });
});

describe("maybePruneJobResults", () => {
  it("prunes only TERMINAL_JOB_STATES rows (every 100th call)", async () => {
    const whereInCalls: any[][] = [];
    const builder: any = {
      whereIn: (...args: any[]) => {
        whereInCalls.push(args);
        return builder;
      },
      whereNot: () => builder,
      whereRaw: () => builder,
      orderBy: () => builder,
      offset: () => builder,
      limit: () => builder,
      first: async () => undefined, // under cap: nothing to delete
      where: () => builder,
      del: async () => 0,
    };
    const db: any = jest.fn(() => builder);
    db.client = { config: { client: "pg" } };

    // The module-level counter only reaches the prune body every 100th call.
    for (let i = 0; i < 100; i++) {
      await maybePruneJobResults(db);
    }

    expect(whereInCalls.length).toBeGreaterThanOrEqual(1);
    expect(whereInCalls[0]).toEqual(["state", TERMINAL_JOB_STATES]);
  });
});

/**
 * Review Focus 7: import rows get their own, smaller, per-context retention
 * instead of sharing the generic MAX_TERMINAL rolling window -- a tenant
 * running frequent imports in one context should not crowd out every other
 * context's/job type's terminal rows. Fake-db pattern: chainable builder
 * recording every call per method name (as in
 * src/exulu/email-inbound/intake.test.ts), so each assertion checks the
 * actual knex calls the module made rather than its return value.
 */
describe("maybePruneJobResults -- import retention exemption", () => {
  function fakeDb(opts: { dialect?: string; boundaryCreatedAt?: string } = {}) {
    const calls: Record<string, any[][]> = {};
    const builder: any = {};
    const record =
      (name: string) =>
      (...args: any[]) => {
        (calls[name] ||= []).push(args);
        return builder;
      };
    builder.whereIn = record("whereIn");
    builder.whereNot = record("whereNot");
    builder.where = record("where");
    builder.whereRaw = record("whereRaw");
    builder.orderBy = record("orderBy");
    builder.offset = record("offset");
    builder.limit = record("limit");
    builder.first = jest.fn(async () =>
      opts.boundaryCreatedAt ? { createdAt: opts.boundaryCreatedAt } : undefined,
    );
    builder.del = jest.fn(async () => 0);
    const db: any = jest.fn(() => builder);
    db.client = { config: { client: opts.dialect ?? "pg" } };
    return { db, calls, del: builder.del as jest.Mock };
  }

  it("excludes import rows from both the generic boundary query and its delete", async () => {
    const { db, calls } = fakeDb({ boundaryCreatedAt: "2026-01-01T00:00:00.000Z" });
    for (let i = 0; i < 100; i++) await maybePruneJobResults(db);

    const whereNotCalls = calls["whereNot"] ?? [];
    // One on the boundary SELECT, one on the DELETE that uses it.
    expect(whereNotCalls.length).toBeGreaterThanOrEqual(2);
    for (const args of whereNotCalls) {
      expect(args[0]).toEqual({ type: "import" });
    }
  });

  it("runs its own per-context cap query and delete for import rows (Postgres)", async () => {
    // No boundaryCreatedAt: the generic cap's own delete never fires (under
    // cap), isolating this assertion to the import cap's independent delete.
    const { db, calls, del } = fakeDb();
    for (let i = 0; i < 100; i++) await maybePruneJobResults(db);

    const whereRawCalls = calls["whereRaw"] ?? [];
    expect(whereRawCalls.length).toBeGreaterThanOrEqual(1);
    const [sql, bindings] = whereRawCalls[0]!;
    expect(sql).toMatch(/row_number\(\)/i);
    expect(sql).toMatch(/partition by context/i);
    expect(bindings).toContain(200);

    // Scoped to type = "import", and runs its own delete independent of the
    // generic cap's boundary check above.
    const typeWhereCalls = (calls["where"] ?? []).filter(
      (args) => JSON.stringify(args[0]) === JSON.stringify({ type: "import" }),
    );
    expect(typeWhereCalls.length).toBeGreaterThanOrEqual(1);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("skips the per-context import cap on a non-Postgres dialect", async () => {
    const { db, calls } = fakeDb({ dialect: "mysql" });
    for (let i = 0; i < 100; i++) await maybePruneJobResults(db);

    expect(calls["whereRaw"]).toBeUndefined();
  });
});
