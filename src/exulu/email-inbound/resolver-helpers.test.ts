import { toWorkflowTriggerPayload, insertTriggerWithSecretRetry } from "./resolver-helpers";
import type { InsertTriggerRow } from "./resolver-helpers";
import type { WorkflowTriggerRow } from "./types";

const row: WorkflowTriggerRow = {
  id: "t1", workflow: "w1", type: "email", enabled: true,
  secret: "SECRET", signing_secret: "enc", last_fired_at: null,
  config: {}, run_as_user: 1, run_as_role: null,
};

describe("toWorkflowTriggerPayload", () => {
  it("exposes webhook_url to writers and hides it from readers", () => {
    process.env.BACKEND = "https://api.example.com";
    const writer = toWorkflowTriggerPayload(row, { canWrite: true });
    expect(writer.webhook_url).toBe("https://api.example.com/webhooks/routine/SECRET");
    expect(writer.has_webhook).toBe(true);
    expect(writer.has_signing_secret).toBe(true);
    const reader = toWorkflowTriggerPayload(row, { canWrite: false });
    expect(reader.webhook_url).toBeNull();
    expect(reader.has_webhook).toBe(true);
  });
  it("passes signing_secret_once only when provided", () => {
    expect(toWorkflowTriggerPayload(row, { canWrite: true }).signing_secret_once).toBeNull();
    expect(toWorkflowTriggerPayload(row, { canWrite: true, signingSecretOnce: "plain" }).signing_secret_once).toBe("plain");
  });
});

const baseRow: Omit<InsertTriggerRow, "secret"> = {
  workflow: "w1",
  type: "email",
  enabled: true,
  config: "{}",
  run_as_user: "1",
  run_as_role: null,
  created_by: "u1",
};

describe("insertTriggerWithSecretRetry", () => {
  it("(a) first-attempt success: returns the row and calls insertFn once with a non-empty secret", async () => {
    const returned = { id: "t1", ...baseRow, secret: "abc" };
    const insertFn = jest.fn(async (row: InsertTriggerRow) => ({ ...returned, secret: row.secret }));
    const result = await insertTriggerWithSecretRetry(insertFn, baseRow);
    expect(insertFn).toHaveBeenCalledTimes(1);
    const calledWith = insertFn.mock.calls[0][0] as InsertTriggerRow;
    expect(typeof calledWith.secret).toBe("string");
    expect(calledWith.secret.length).toBeGreaterThan(0);
    expect(result.secret).toBe(calledWith.secret);
  });

  it("(b) 23505 on first call then success on second: retries and returns the row", async () => {
    const collision = Object.assign(new Error("unique violation"), { code: "23505" });
    let calls = 0;
    const insertFn = jest.fn(async (row: InsertTriggerRow) => {
      calls++;
      if (calls === 1) throw collision;
      return { id: "t2", ...baseRow, secret: row.secret };
    });
    const result = await insertTriggerWithSecretRetry(insertFn, baseRow);
    expect(insertFn).toHaveBeenCalledTimes(2);
    expect(result.id).toBe("t2");
    expect(typeof result.secret).toBe("string");
    expect(result.secret.length).toBeGreaterThan(0);
  });

  it("(c) non-23505 error rethrows immediately without further retries", async () => {
    const boom = new Error("some other db error");
    const insertFn = jest.fn(async () => { throw boom; });
    await expect(insertTriggerWithSecretRetry(insertFn, baseRow)).rejects.toThrow("some other db error");
    expect(insertFn).toHaveBeenCalledTimes(1);
  });

  it("(d) five consecutive 23505 errors throws 'Could not generate a unique trigger secret.'", async () => {
    const collision = Object.assign(new Error("unique violation"), { code: "23505" });
    const insertFn = jest.fn(async () => { throw collision; });
    await expect(insertTriggerWithSecretRetry(insertFn, baseRow)).rejects.toThrow(
      "Could not generate a unique trigger secret.",
    );
    expect(insertFn).toHaveBeenCalledTimes(5);
  });
});
