import { createChannelAuditor, CODE_LOCKOUT_AUDIT_WINDOW_SECONDS } from "./audit";

class FakeKv {
  values = new Map<string, string>();
  calls: Array<{ key: string; opts: { EX: number; NX?: true } }> = [];
  async set(key: string, value: string, opts: { EX: number; NX?: true }) {
    this.calls.push({ key, opts });
    if (opts.NX && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }
}

let info: jest.SpyInstance;
beforeEach(() => {
  info = jest.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => info.mockRestore());

const logged = () => info.mock.calls.map((c) => JSON.parse(c[1]));

describe("createChannelAuditor", () => {
  it("writes one structured line per event with the masked identity", async () => {
    const audit = createChannelAuditor({ channelId: "chan-1", kv: new FakeKv() });
    await audit({ type: "linked", identity: "4915112345678", userId: 7 });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toBe("[EXULU-CHANNEL] audit");
    expect(logged()[0]).toEqual({ event: "linked", channel: "chan-1", identity: "•••• 5678", user: 7 });
    expect(JSON.stringify(info.mock.calls)).not.toContain("4915112345678");
  });

  it("code_lockout is emitted at most once per channel and identity in the window", async () => {
    const kv = new FakeKv();
    const audit = createChannelAuditor({ channelId: "chan-1", kv });
    await audit({ type: "code_lockout", identity: "4915112345678" });
    await audit({ type: "code_lockout", identity: "4915112345678" });
    await audit({ type: "code_lockout", identity: "4915112345678" });
    expect(logged().filter((e) => e.event === "code_lockout")).toHaveLength(1);
    expect(kv.calls[0].opts).toEqual({ EX: CODE_LOCKOUT_AUDIT_WINDOW_SECONDS, NX: true });
    expect(CODE_LOCKOUT_AUDIT_WINDOW_SECONDS).toBe(3600);
  });

  it("the window is per identity and per channel", async () => {
    const kv = new FakeKv();
    await createChannelAuditor({ channelId: "chan-1", kv })({ type: "code_lockout", identity: "a1111" });
    await createChannelAuditor({ channelId: "chan-1", kv })({ type: "code_lockout", identity: "b2222" });
    await createChannelAuditor({ channelId: "chan-2", kv })({ type: "code_lockout", identity: "a1111" });
    expect(logged()).toHaveLength(3);
  });

  it("other events are never suppressed", async () => {
    const kv = new FakeKv();
    const audit = createChannelAuditor({ channelId: "chan-1", kv });
    await audit({ type: "access_rejected", identity: "a1111", userId: 1 });
    await audit({ type: "access_rejected", identity: "a1111", userId: 1 });
    expect(logged()).toHaveLength(2);
    expect(kv.calls).toHaveLength(0);
  });

  it("never throws: a failing de-duplication store is logged and the event is dropped", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const kv = { set: async () => Promise.reject(new Error("ERR key channel-audit:code_lockout:chan-1:a1111")) };
    const audit = createChannelAuditor({ channelId: "chan-1", kv });
    await expect(audit({ type: "code_lockout", identity: "a1111" })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain("a1111");
    expect(error.mock.calls.flat().some((x) => x instanceof Error)).toBe(false);
    error.mockRestore();
  });
});

describe("forwarding to the audit logger", () => {
  const mk = (over: any = {}) => {
    const record = jest.fn();
    const logger = { enabled: true, record, ...over };
    return { record, logger };
  };

  it("emits channel.<type> with a masked identity, channel, agent and user", async () => {
    const { record, logger } = mk();
    const audit = createChannelAuditor({ channelId: "chan-1", agentId: "ag-1", kv: new FakeKv(), logger: () => logger });
    await audit({ type: "linked", identity: "4915112345678", userId: 7 });
    expect(record).toHaveBeenCalledTimes(1);
    const ev = record.mock.calls[0][0];
    expect(ev.type).toBe("channel.linked");
    expect(ev.v).toBe(1);
    expect(ev.actor).toEqual({ kind: "user", userId: "7" });
    expect(ev.context).toEqual({ agentId: "ag-1" });
    expect(ev.target).toEqual({ kind: "channel", id: "chan-1" });
    expect(ev.status).toBe("ok");
    expect(ev.data).toEqual({ identity: "•••• 5678" });
    expect(JSON.stringify(ev)).not.toContain("4915112345678");
  });

  it("rejections are status denied; no user means a system actor", async () => {
    const { record, logger } = mk();
    const audit = createChannelAuditor({ channelId: "chan-1", kv: new FakeKv(), logger: () => logger });
    await audit({ type: "code_lockout", identity: "4915112345678" });
    const ev = record.mock.calls[0][0];
    expect(ev.status).toBe("denied");
    expect(ev.actor).toEqual({ kind: "system" });
    expect(ev.context).toBeUndefined();
  });

  it("does nothing when audit logging is disabled; the log line remains", async () => {
    const { record, logger } = mk({ enabled: false });
    await createChannelAuditor({ channelId: "chan-1", kv: new FakeKv(), logger: () => logger })({
      type: "linked",
      identity: "a1111",
    });
    expect(record).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("a throwing logger does not throw into the caller and is logged without detail", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const { logger } = mk({
      record: () => {
        throw new Error("sink down 4915112345678");
      },
    });
    const audit = createChannelAuditor({ channelId: "chan-1", kv: new FakeKv(), logger: () => logger });
    await expect(audit({ type: "revoked", identity: "4915112345678", userId: 1 })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain("4915112345678");
    error.mockRestore();
  });

  it("a throwing logger resolver does not throw either", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const audit = createChannelAuditor({
      channelId: "chan-1",
      kv: new FakeKv(),
      logger: () => {
        throw new Error("boom");
      },
    });
    await expect(audit({ type: "linked", identity: "a1111" })).resolves.toBeUndefined();
    error.mockRestore();
  });

  it("does not wait for a slow sink (record is fire-and-forget)", async () => {
    const { logger } = mk({ record: () => new Promise(() => {}) });
    const audit = createChannelAuditor({ channelId: "chan-1", kv: new FakeKv(), logger: () => logger });
    await expect(audit({ type: "linked", identity: "a1111" })).resolves.toBeUndefined();
  });

  it("a suppressed code_lockout repeat is not forwarded either", async () => {
    const { record, logger } = mk();
    const audit = createChannelAuditor({ channelId: "chan-1", kv: new FakeKv(), logger: () => logger });
    await audit({ type: "code_lockout", identity: "4915112345678" });
    await audit({ type: "code_lockout", identity: "4915112345678" });
    expect(record).toHaveBeenCalledTimes(1);
  });
});
