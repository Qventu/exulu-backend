import {
  insertTriggerWithRetry,
} from "./resolver-helpers";

// ---------------------------------------------------------------------------
// insertTriggerWithRetry
// ---------------------------------------------------------------------------

describe("insertTriggerWithRetry", () => {
  const baseRow = {
    workflow: "wf-1",
    type: "email",
    enabled: true,
    config: "{}",
    run_as_user: "u-1",
    run_as_role: null,
    created_by: "u-1",
  };

  it("returns the inserted row on the first successful attempt", async () => {
    const insertFn = jest.fn().mockResolvedValue({ address: "slug-aabbccdd@mail.client.com" });
    const result = await insertTriggerWithRetry(
      insertFn,
      baseRow,
      "My Routine",
      "mail.client.com",
    );
    expect(result).toEqual({ address: "slug-aabbccdd@mail.client.com" });
    expect(insertFn).toHaveBeenCalledTimes(1);
  });

  it("retries on 23505 and succeeds on the third attempt", async () => {
    const collision = Object.assign(new Error("duplicate"), { code: "23505" });
    const successRow = { address: "my-routine-cccccccc@mail.client.com" };
    const insertFn = jest
      .fn()
      .mockRejectedValueOnce(collision)
      .mockRejectedValueOnce(collision)
      .mockResolvedValue(successRow);

    const result = await insertTriggerWithRetry(
      insertFn,
      baseRow,
      "My Routine",
      "mail.client.com",
    );
    expect(result).toEqual(successRow);
    expect(insertFn).toHaveBeenCalledTimes(3);
  });

  it("rethrows immediately on a non-23505 error without further attempts", async () => {
    const dbError = Object.assign(new Error("connection refused"), { code: "08006" });
    const insertFn = jest.fn().mockRejectedValue(dbError);

    await expect(
      insertTriggerWithRetry(insertFn, baseRow, "My Routine", "mail.client.com"),
    ).rejects.toThrow("connection refused");
    expect(insertFn).toHaveBeenCalledTimes(1);
  });

  it("throws /after 5 attempts/ when all five inserts collide", async () => {
    const collision = Object.assign(new Error("duplicate"), { code: "23505" });
    const insertFn = jest.fn().mockRejectedValue(collision);

    await expect(
      insertTriggerWithRetry(insertFn, baseRow, "My Routine", "mail.client.com"),
    ).rejects.toThrow(/after 5 attempts/);
    expect(insertFn).toHaveBeenCalledTimes(5);
  });
});
