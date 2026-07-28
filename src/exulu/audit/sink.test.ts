import { AuditSink } from "./sink";

const baseCfg = {
  target: { s3region: "r", s3key: "k", s3secret: "s", s3Bucket: "b", s3prefix: "audit/" },
  flush: { maxRecords: 2, maxIntervalMs: 60_000 },
  failureMode: "open" as const,
};

const evt = (n: number) => ({ v: 1 as const, ts: "t", type: "tool.call", actor: {}, status: "ok" as const, data: { n } });

const makeSpool = () => {
  const store: Record<string, string> = {};
  return {
    api: {
      write: async (name: string, body: string) => { store[name] = body; },
      list: async () => Object.keys(store),
      read: async (name: string) => store[name],
      remove: async (name: string) => { delete store[name]; },
    },
    store,
  };
};

describe("AuditSink", () => {
  it("flushes a batch as NDJSON when the buffer hits maxRecords", async () => {
    const puts: { key: string; body: string }[] = [];
    const writer = { putNdjson: async (key: string, body: string) => { puts.push({ key, body }); }, getLifecycle: async () => ({}), putLifecycle: async () => {} };
    const spool = makeSpool();
    const sink = new AuditSink(baseCfg as any, writer, spool.api, { now: () => new Date("2026-07-28T12:00:00Z") });
    sink.record(evt(1));
    sink.record(evt(2)); // triggers flush at maxRecords=2
    await sink.flush();
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toMatch(/^audit\/dt=2026-07-28\/12\/\d+-[0-9a-f-]+\.ndjson$/);
    expect(puts[0].body.endsWith("\n")).toBe(true);
    const lines = puts[0].body.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).data.n).toBe(1);
  });

  it("close() drains the remaining buffer", async () => {
    const puts: any[] = [];
    const writer = { putNdjson: async (k: string, b: string) => { puts.push(b); }, getLifecycle: async () => ({}), putLifecycle: async () => {} };
    const sink = new AuditSink(baseCfg as any, writer, makeSpool().api, { now: () => new Date("2026-07-28T12:00:00Z") });
    sink.record(evt(1));
    await sink.close();
    expect(puts).toHaveLength(1);
  });

  it("spools the batch and warns (does not throw) when the write fails (open mode)", async () => {
    const writer = { putNdjson: async () => { throw new Error("s3 down"); }, getLifecycle: async () => ({}), putLifecycle: async () => {} };
    const spool = makeSpool();
    const sink = new AuditSink(baseCfg as any, writer, spool.api, { now: () => new Date("2026-07-28T12:00:00Z") });
    sink.record(evt(1));
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(Object.keys(spool.store)).toHaveLength(1);
  });

  it("recordDurable writes one event synchronously and rethrows on failure", async () => {
    const writer = { putNdjson: async () => { throw new Error("s3 down"); }, getLifecycle: async () => ({}), putLifecycle: async () => {} };
    const sink = new AuditSink({ ...baseCfg, failureMode: "closed" } as any, writer, makeSpool().api, { now: () => new Date("2026-07-28T12:00:00Z") });
    await expect(sink.recordDurable(evt(1))).rejects.toThrow("s3 down");
  });

  it("spool self-healing: spooled entry is drained on next successful flush", async () => {
    let fail = true;
    const puts: { key: string; body: string }[] = [];
    const writer = {
      putNdjson: async (key: string, body: string) => {
        if (fail) throw new Error("s3 down");
        puts.push({ key, body });
      },
      getLifecycle: async () => ({}),
      putLifecycle: async () => {},
    };
    const spool = makeSpool();
    const sink = new AuditSink(baseCfg as any, writer, spool.api, { now: () => new Date("2026-07-28T12:00:00Z") });

    // First flush: writer throws — batch should be spooled, buffer cleared, no throw
    sink.record(evt(1));
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(Object.keys(spool.store)).toHaveLength(1);
    expect(puts).toHaveLength(0);

    // Second flush: writer now succeeds — new event PUT + spooled entry drained
    fail = false;
    sink.record(evt(2));
    await sink.flush();
    // 2 PUTs: the new batch + the drained spool entry
    expect(puts).toHaveLength(2);
    // Spool is now empty
    expect(Object.keys(spool.store)).toHaveLength(0);
  });
});
