import type { InboundEmail, WorkflowTriggerRow } from "./types";
import {
  DEFAULT_SENDER_RATE_LIMIT_PER_HOUR,
  DEFAULT_TRIGGER_RATE_LIMIT_PER_HOUR,
  checkRateLimit,
  matchesFilters,
  runGuardChain,
  senderAllowed,
} from "./guards";

const makeEmail = (overrides: Partial<InboundEmail> = {}): InboundEmail => ({
  messageId: "<msg-1@example.com>",
  from: { address: "service@kone.com", name: "Anna" },
  recipient: "spare-parts-1a2b3c4d@mail.client.com",
  subject: "Ersatzteil Anfrage",
  text: "Wir brauchen ein Ersatzteil.",
  attachments: [],
  headers: new Map<string, string>(),
  ...overrides,
});

const makeTrigger = (config: Record<string, unknown> = {}): WorkflowTriggerRow => ({
  id: "trigger-1",
  workflow: "workflow-1",
  type: "email",
  enabled: true,
  address: "spare-parts-1a2b3c4d@mail.client.com",
  config,
  run_as_user: 7,
  run_as_role: "role-1",
});

// Redis fake: counters behave like INCR; get() reads previous buckets.
const makeRedis = (counters: Record<string, number> = {}) => ({
  store: counters,
  incr: jest.fn(async function (this: void, key: string) {
    counters[key] = (counters[key] ?? 0) + 1;
    return counters[key];
  }),
  expire: jest.fn(async () => 1),
  get: jest.fn(async (key: string) => (counters[key] != null ? String(counters[key]) : null)),
});

// DB fake for the dedup lookup: .from().where().whereRaw().first().
const makeDb = (duplicateRow?: Record<string, unknown>) => {
  const builder: any = {
    where: jest.fn(() => builder),
    whereRaw: jest.fn(() => builder),
    first: jest.fn(async () => duplicateRow),
  };
  return { db: { from: jest.fn(() => builder) } as any, builder };
};

const baseOpts = (overrides: Partial<Parameters<typeof runGuardChain>[0]> = {}) => ({
  email: makeEmail(),
  trigger: makeTrigger(),
  db: makeDb().db,
  redis: makeRedis(),
  ...overrides,
});

describe("auto-reply guard", () => {
  afterEach(() => {
    delete process.env.SMTP_FROM;
  });

  it.each([
    ["Auto-Submitted auto-replied", new Map([["auto-submitted", "auto-replied"]])],
    ["Precedence bulk", new Map([["precedence", "bulk"]])],
    ["Precedence Junk (case-insensitive)", new Map([["precedence", "Junk"]])],
    ["X-Autoreply", new Map([["x-autoreply", "yes"]])],
    ["X-Autorespond", new Map([["x-autorespond", "ticket-system"]])],
  ])("filters %s", async (_label, headers) => {
    const result = await runGuardChain(baseOpts({ email: makeEmail({ headers }) }));
    expect(result).toEqual({ ok: false, reason: "auto_reply" });
  });

  it("does not filter Auto-Submitted: no", async () => {
    const result = await runGuardChain(
      baseOpts({ email: makeEmail({ headers: new Map([["auto-submitted", "no"]]) }) }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("filters mail from the instance's own SMTP_FROM (loop guard)", async () => {
    process.env.SMTP_FROM = "Exulu@Client.com";
    const result = await runGuardChain(
      baseOpts({ email: makeEmail({ from: { address: "exulu@client.com" } }) }),
    );
    expect(result).toEqual({ ok: false, reason: "auto_reply" });
  });

  it("wins over the allowlist (guard order)", async () => {
    const result = await runGuardChain(
      baseOpts({
        email: makeEmail({ headers: new Map([["precedence", "bulk"]]) }),
        trigger: makeTrigger({ allowed_senders: ["someone-else@x.com"] }),
      }),
    );
    expect(result).toEqual({ ok: false, reason: "auto_reply" });
  });
});

describe("sender allowlist", () => {
  it("allows everyone when the allowlist is empty", () => {
    expect(senderAllowed("anyone@anywhere.com", [])).toBe(true);
    expect(senderAllowed("anyone@anywhere.com", undefined)).toBe(true);
  });

  it("matches exact addresses case-insensitively", () => {
    expect(senderAllowed("Service@KONE.com", ["service@kone.com"])).toBe(true);
  });

  it("matches *@domain globs", () => {
    expect(senderAllowed("anna.service@kone.com", ["*@kone.com"])).toBe(true);
    expect(senderAllowed("anna@notkone.com", ["*@kone.com"])).toBe(false);
  });

  it("returns sender_not_allowed through the chain", async () => {
    const result = await runGuardChain(
      baseOpts({ trigger: makeTrigger({ allowed_senders: ["*@otis.com"] }) }),
    );
    expect(result).toEqual({ ok: false, reason: "sender_not_allowed" });
  });
});

describe("rate limits (sliding window over current + previous hour)", () => {
  const HOUR_MS = 60 * 60 * 1000;

  it("allows under the limit and expires the current bucket", async () => {
    const redis = makeRedis();
    const now = 42 * HOUR_MS + HOUR_MS / 2;
    await expect(checkRateLimit(redis, "k", 10, now)).resolves.toBe(true);
    expect(redis.expire).toHaveBeenCalledWith("k:42", 2 * 60 * 60);
  });

  it("weights the previous bucket by the remaining window fraction", async () => {
    // Half way through the hour: previous counts 50%. current(6) + 10*0.5 = 11 > 10.
    const now = 42 * HOUR_MS + HOUR_MS / 2;
    const redis = makeRedis({ "k:42": 5, "k:41": 10 });
    await expect(checkRateLimit(redis, "k", 10, now)).resolves.toBe(false);
    // With an empty previous bucket the same call passes: 6 <= 10.
    const redis2 = makeRedis({ "k:42": 5 });
    await expect(checkRateLimit(redis2, "k", 10, now)).resolves.toBe(true);
  });

  it("allows when redis is unavailable (best-effort)", async () => {
    await expect(checkRateLimit(null, "k", 1)).resolves.toBe(true);
  });

  it("allows when redis operations reject (best-effort, incr failure)", async () => {
    const redis = {
      incr: jest.fn(async () => {
        throw new Error("READONLY You can't write against a read only replica");
      }),
    };
    await expect(checkRateLimit(redis, "k", 1)).resolves.toBe(true);
  });

  it("returns rate_limited through the chain when the per-trigger ceiling is hit", async () => {
    const redis = makeRedis();
    const opts = baseOpts({ redis, trigger: makeTrigger({ rate_limit_per_hour: 1 }) });
    await expect(runGuardChain(opts)).resolves.toEqual({ ok: true });
    await expect(runGuardChain(opts)).resolves.toEqual({ ok: false, reason: "rate_limited" });
  });

  it("uses the documented defaults", () => {
    expect(DEFAULT_TRIGGER_RATE_LIMIT_PER_HOUR).toBe(60);
    expect(DEFAULT_SENDER_RATE_LIMIT_PER_HOUR).toBe(10);
  });
});

describe("DB dedup", () => {
  it("returns duplicate when a run with this message id exists", async () => {
    const { db, builder } = makeDb({ id: "jr-1", state: "completed" });
    const result = await runGuardChain(baseOpts({ db }));
    expect(result).toEqual({ ok: false, reason: "duplicate" });
    expect(builder.whereRaw).toHaveBeenCalledWith(
      "trigger_metadata->>'message_id' = ?",
      ["<msg-1@example.com>"],
    );
  });
});

describe("regex filters", () => {
  it("passes when ALL rules match", () => {
    const email = makeEmail({ attachments: [{ filename: "order.pdf", contentType: "application/pdf", content: Buffer.from("") }] });
    const result = matchesFilters(email, [
      { field: "subject", pattern: "Ersatzteil|spare part" },
      { field: "from", pattern: "@kone\\.com$" },
      { field: "attachment_name", pattern: "\\.pdf$" },
    ]);
    expect(result).toEqual({ ok: true });
  });

  it("fails with the failed rule recorded", async () => {
    const result = await runGuardChain(
      baseOpts({
        trigger: makeTrigger({ filters: [{ field: "subject", pattern: "^Rechnung" }] }),
      }),
    );
    expect(result).toEqual({ ok: false, reason: "filter", failedRule: "subject:^Rechnung" });
  });

  it("evaluates body rules against the first 10KB only (ReDoS input cap)", () => {
    const email = makeEmail({ text: "x".repeat(11 * 1024) + "NEEDLE" });
    const result = matchesFilters(email, [{ field: "body", pattern: "NEEDLE" }]);
    expect(result).toEqual({ ok: false, failedRule: "body:NEEDLE" });
  });
});
