import {
  toEmailInboundConfigPayload,
  insertTriggerWithRetry,
} from "./resolver-helpers";

// ---------------------------------------------------------------------------
// toEmailInboundConfigPayload
// ---------------------------------------------------------------------------

describe("toEmailInboundConfigPayload", () => {
  const baseInbound = {
    provider: "mailgun-eu",
    inbound_domain: "mail.client.com",
    enabled: true,
    last_webhook_at: "2026-07-15T10:00:00.000Z",
  };

  it("never includes signing_key in the output", () => {
    const payload = toEmailInboundConfigPayload({
      ...baseInbound,
      signing_key: "super-secret",
    });
    expect(payload).not.toHaveProperty("signing_key");
  });

  it("sets has_signing_key true when a key is present", () => {
    const payload = toEmailInboundConfigPayload({
      ...baseInbound,
      signing_key: "some-key",
    });
    expect(payload.has_signing_key).toBe(true);
  });

  it("sets has_signing_key false when no key is present", () => {
    const payload = toEmailInboundConfigPayload({
      ...baseInbound,
      signing_key: null,
    });
    expect(payload.has_signing_key).toBe(false);
  });

  it("derives webhook_url from process.env.BACKEND with trailing slash stripped", () => {
    const original = process.env.BACKEND;
    process.env.BACKEND = "https://api.example.com/";
    try {
      const payload = toEmailInboundConfigPayload({ ...baseInbound, signing_key: null });
      expect(payload.webhook_url).toBe("https://api.example.com/webhooks/email/mime");
    } finally {
      process.env.BACKEND = original;
    }
  });

  it("returns null webhook_url when BACKEND is not set", () => {
    const original = process.env.BACKEND;
    delete process.env.BACKEND;
    try {
      const payload = toEmailInboundConfigPayload({ ...baseInbound, signing_key: null });
      expect(payload.webhook_url).toBeNull();
    } finally {
      process.env.BACKEND = original;
    }
  });
});

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
