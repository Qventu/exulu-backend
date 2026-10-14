// src/exulu/claim-check/store.test.ts
//
// Tests the real SQL layer against a knex double (no Postgres), following
// src/exulu/viewer-identity-routes.test.ts's pattern. Every assertion at the
// route-handler level (ee/claim-check/routes.test.ts) stops at "a mock was
// called with these arguments" — it cannot see what a query actually filters
// on. This file is what caught (and now guards against) the fix-round defect:
// an upsert whose DELETE half was scoped by (session, message_id) alone,
// which let a caller destroy another user's stored row by naming their
// session uuid and message id.
import { saveClaimCheck, listClaimChecks } from "./store";

const RESULT = {
  status: "ok" as const,
  score: { claims: 2, supported: 2, contradicted: 0, unsupported: 0, unsupportedShare: 0, label: "ok" as const },
  sentences: [],
  claims: [],
  usage: { calls: 3, inputTokens: 10, outputTokens: 2 },
  timings: { totalMs: 5 },
  limits: { truncated: false, sentencesSkipped: 0 },
  notes: [],
};

/**
 * A fake knex double. Every method returns the same chainable `builder` (so
 * any call order a real knex query might take still resolves), and every
 * call is recorded with its arguments — including methods this module must
 * NEVER call (`del`), so a regression that reintroduces a delete is caught
 * by a plain "was del ever called" assertion rather than by tracing a mock's
 * return value.
 */
function fakeDb(selectRows: any[] = []) {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: any = {
    where: (...args: unknown[]) => {
      calls.push({ method: "where", args });
      return builder;
    },
    select: async (...args: unknown[]) => {
      calls.push({ method: "select", args });
      return selectRows;
    },
    del: async (...args: unknown[]) => {
      calls.push({ method: "del", args });
      return 0;
    },
    insert: (...args: unknown[]) => {
      calls.push({ method: "insert", args });
      return builder;
    },
    onConflict: (...args: unknown[]) => {
      calls.push({ method: "onConflict", args });
      return builder;
    },
    merge: async (...args: unknown[]) => {
      calls.push({ method: "merge", args });
      return undefined;
    },
  };
  const db = (_table: string) => builder;
  return { db: db as any, calls };
}

describe("saveClaimCheck", () => {
  it("upserts via onConflict, with conflict columns that include user — never a delete", async () => {
    const { db, calls } = fakeDb();
    await saveClaimCheck(db, { session: "s1", messageId: "msg_1", userId: 7, result: RESULT });

    expect(calls.some((c) => c.method === "del")).toBe(false);

    const insertCall = calls.find((c) => c.method === "insert");
    expect(insertCall?.args[0]).toEqual(
      expect.objectContaining({
        session: "s1",
        message_id: "msg_1",
        user: 7,
        score_label: "ok",
        payload: JSON.stringify(RESULT),
      }),
    );

    const onConflictCall = calls.find((c) => c.method === "onConflict");
    expect(onConflictCall?.args[0]).toEqual(["session", "message_id", "user"]);
    expect((onConflictCall?.args[0] as string[])).toContain("user");

    expect(calls.some((c) => c.method === "merge")).toBe(true);
  });
});

describe("listClaimChecks", () => {
  it("filters the select on both session and user in the same query", async () => {
    const { db, calls } = fakeDb([]);
    await listClaimChecks(db, { session: "s1", userId: 7 });

    const whereCall = calls.find((c) => c.method === "where");
    expect(whereCall?.args[0]).toEqual({ session: "s1", user: 7 });
    expect(calls.some((c) => c.method === "del")).toBe(false);
  });

  it("keys the result by message_id and parses a stringified payload", async () => {
    const { db } = fakeDb([{ message_id: "msg_1", payload: JSON.stringify(RESULT) }]);
    const checks = await listClaimChecks(db, { session: "s1", userId: 7 });
    expect(checks.msg_1.score.label).toBe("ok");
  });

  it("reads back a payload that arrives already parsed (an object, not a string)", async () => {
    const { db } = fakeDb([{ message_id: "msg_1", payload: RESULT }]);
    const checks = await listClaimChecks(db, { session: "s1", userId: 7 });
    expect(checks.msg_1.score.label).toBe("ok");
  });

  it("returns an empty object when nothing matches", async () => {
    const { db } = fakeDb([]);
    const checks = await listClaimChecks(db, { session: "s1", userId: 7 });
    expect(checks).toEqual({});
  });
});
