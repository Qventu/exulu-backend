import { handleChannelMessage, runLockKey, RUN_LOCK_TTL_SECONDS, type ChannelMessageJob, type RunDeps } from "./run";
import { replyText } from "./texts";
import type { AgentChannelRow, WhatsAppChannelConfig } from "./types";

const NOW = new Date("2026-11-16T12:00:00Z");
const config = { sessionIdleHours: 12, locale: "de", texts: {} } as unknown as WhatsAppChannelConfig;
const row = { id: "chA", agent: "agent1", enabled: true } as unknown as AgentChannelRow;
const job = (over: Partial<ChannelMessageJob> = {}): ChannelMessageJob => ({
  channelId: "chA", threadId: "t1", identity: "whatsapp:+4915112345678", userId: 7,
  messageId: "m1", text: "Wie reset ich den Aufzug?", newSession: false, ...over,
});
const KEY = runLockKey("chA", "whatsapp:+4915112345678");

const makeDeps = (over: Partial<RunDeps> = {}) => {
  const deps = {
    now: () => NOW,
    loadChannel: jest.fn(async () => ({ row, config })),
    lock: {
      acquire: jest.fn(async () => "tok-1" as string | null),
      release: jest.fn(async () => undefined),
      extend: jest.fn(async () => true),
    },
    markAnswered: jest.fn(async () => true),
    sessions: {
      findRecent: jest.fn(async () => "sess-old" as string | null),
      create: jest.fn(async () => "sess-new"),
    },
    stillAllowed: jest.fn(async () => true),
    runAgentTurn: jest.fn(async () => "Die Antwort"),
    transport: { post: jest.fn(async () => undefined), typing: jest.fn(async () => undefined) },
    ...over,
  };
  return deps as typeof deps & RunDeps;
};

describe("handleChannelMessage", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("builds an unambiguous lock key", () => {
    expect(runLockKey("a", "b:c")).toBe("channel-run:a:b:c");
    expect(RUN_LOCK_TTL_SECONDS).toBe(90);
  });

  it("reuses a recent session", async () => {
    const d = makeDeps();
    const r = await handleChannelMessage(job(), d);
    expect(d.sessions.findRecent).toHaveBeenCalledWith({ agentId: "agent1", userId: 7, channelId: "chA", idleHours: 12, now: NOW });
    expect(d.sessions.create).not.toHaveBeenCalled();
    expect(d.runAgentTurn).toHaveBeenCalledWith({ agentId: "agent1", userId: 7, sessionId: "sess-old", text: "Wie reset ich den Aufzug?" });
    expect(r).toEqual({ sessionId: "sess-old", posted: "answer" });
  });

  it("creates a session when none is recent", async () => {
    const d = makeDeps({ sessions: { findRecent: jest.fn(async () => null), create: jest.fn(async () => "sess-new") } });
    const r = await handleChannelMessage(job(), d);
    expect(d.sessions.create).toHaveBeenCalledWith({
      agentId: "agent1", userId: 7, title: "Wie reset ich den Aufzug?",
      channel: { type: "whatsapp", id: "chA", identity: "whatsapp:+4915112345678" },
    });
    expect(r.sessionId).toBe("sess-new");
  });

  it("creates a session when newSession is set even if a recent one exists", async () => {
    const d = makeDeps();
    const r = await handleChannelMessage(job({ newSession: true }), d);
    expect(d.sessions.findRecent).not.toHaveBeenCalled();
    expect(r.sessionId).toBe("sess-new");
  });

  it("cuts the title at 50 characters", async () => {
    const d = makeDeps();
    await handleChannelMessage(job({ newSession: true, text: "x".repeat(80) }), d);
    expect(d.sessions.create.mock.calls[0][0].title).toBe("x".repeat(50));
  });

  it("posts the answer as returned and releases the lock once", async () => {
    const d = makeDeps({ runAgentTurn: jest.fn(async () => "  **Antwort**\n") });
    const r = await handleChannelMessage(job(), d);
    expect(d.transport.post).toHaveBeenCalledTimes(1);
    expect(d.transport.post).toHaveBeenCalledWith("t1", "  **Antwort**\n");
    expect(r.posted).toBe("answer");
    expect(d.lock.acquire).toHaveBeenCalledWith(KEY, 90);
    expect(d.lock.release).toHaveBeenCalledTimes(1);
    expect(d.lock.release).toHaveBeenCalledWith(KEY, "tok-1");
  });

  it.each(["", "   \n\t"])("posts runFailed for an empty answer (%j)", async (answer) => {
    const d = makeDeps({ runAgentTurn: jest.fn(async () => answer) });
    const r = await handleChannelMessage(job(), d);
    expect(d.transport.post).toHaveBeenCalledTimes(1);
    expect(d.transport.post).toHaveBeenCalledWith("t1", replyText("runFailed", config));
    expect(r.posted).toBe("runFailed");
  });

  it("posts runFailed when the run throws and still releases the lock", async () => {
    const d = makeDeps({ runAgentTurn: jest.fn(async () => { throw new Error("boom"); }) });
    const r = await handleChannelMessage(job(), d);
    expect(d.transport.post).toHaveBeenCalledTimes(1);
    expect(d.transport.post).toHaveBeenCalledWith("t1", replyText("runFailed", config));
    expect(r).toEqual({ sessionId: "sess-old", posted: "runFailed" });
    expect(d.lock.release).toHaveBeenCalledTimes(1);
  });

  it("tells the user it is still working when the lock is not acquired, and does not release it", async () => {
    const d = makeDeps({ lock: { acquire: jest.fn(async () => null), release: jest.fn(async () => undefined), extend: jest.fn(async () => true) } });
    const r = await handleChannelMessage(job(), d);
    expect(r).toEqual({ sessionId: null, posted: "skipped" });
    expect(d.runAgentTurn).not.toHaveBeenCalled();
    expect(d.transport.post).toHaveBeenCalledTimes(1);
    expect(d.transport.post).toHaveBeenCalledWith("t1", replyText("stillWorking", config));
    expect(d.lock.release).not.toHaveBeenCalled();
  });

  it("a failing stillWorking notice is logged and swallowed", async () => {
    const d = makeDeps({
      lock: { acquire: jest.fn(async () => null), release: jest.fn(async () => undefined), extend: jest.fn(async () => true) },
      transport: { post: jest.fn(async () => { throw new Error("graph down for 4915112345678"); }), typing: jest.fn(async () => undefined) },
    });
    await expect(handleChannelMessage(job(), d)).resolves.toEqual({ sessionId: null, posted: "skipped" });
    expect(console.error).toHaveBeenCalled();
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain("4915112345678");
  });

  it.each([
    ["false", jest.fn(async () => false)],
    ["a throw", jest.fn(async () => { throw new Error("db down 4915112345678"); })],
  ])("skips without lock, post or run when stillAllowed is %s", async (_label, stillAllowed) => {
    const d = makeDeps({ stillAllowed });
    const r = await handleChannelMessage(job(), d);
    expect(r).toEqual({ sessionId: null, posted: "skipped" });
    expect(stillAllowed).toHaveBeenCalledWith(job(), row);
    expect(d.lock.acquire).not.toHaveBeenCalled();
    expect(d.runAgentTurn).not.toHaveBeenCalled();
    expect(d.transport.post).not.toHaveBeenCalled();
    const logged = JSON.stringify([(console.error as jest.Mock).mock.calls, (console.warn as jest.Mock).mock.calls]);
    expect(logged).not.toContain("4915112345678");
    expect(logged).not.toContain("Aufzug");
  });

  it("logs a failing run without the error message", async () => {
    const d = makeDeps({ runAgentTurn: jest.fn(async () => { throw new Error("insert ... 'Wie reset ich den Aufzug?' 4915112345678"); }) });
    await handleChannelMessage(job(), d);
    const logged = JSON.stringify((console.error as jest.Mock).mock.calls);
    expect(logged).toContain("chA");
    expect(logged).not.toContain("4915112345678");
    expect(logged).not.toContain("Aufzug");
    // an Error object would be printed with its message by console.error
    expect((console.error as jest.Mock).mock.calls.flat().some((a) => a instanceof Error)).toBe(false);
  });

  it("skips when the channel is missing or disabled, without taking the lock", async () => {
    for (const loaded of [null, { row: { ...row, enabled: false } as AgentChannelRow, config }]) {
      const d = makeDeps({ loadChannel: jest.fn(async () => loaded) });
      const r = await handleChannelMessage(job(), d);
      expect(r).toEqual({ sessionId: null, posted: "skipped" });
      expect(d.lock.acquire).not.toHaveBeenCalled();
      expect(d.transport.post).not.toHaveBeenCalled();
    }
  });

  it("types immediately and every 20 s while the run is pending, then stops", async () => {
    let finish!: (s: string) => void;
    const d = makeDeps({ runAgentTurn: jest.fn(() => new Promise<string>((res) => { finish = res; })) });
    const p = handleChannelMessage(job(), d);
    await jest.advanceTimersByTimeAsync(0);
    expect(d.transport.typing).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(40_000);
    expect(d.transport.typing).toHaveBeenCalledTimes(3);
    finish("fertig");
    await p;
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(d.transport.typing).toHaveBeenCalledTimes(3);
  });

  it("does not fail the job when typing rejects", async () => {
    const d = makeDeps({
      transport: { post: jest.fn(async () => undefined), typing: jest.fn(async () => { throw new Error("nope"); }) },
    });
    const warn = console.warn as jest.Mock;
    const r = await handleChannelMessage(job(), d);
    await jest.advanceTimersByTimeAsync(0);
    expect(r.posted).toBe("answer");
    expect(warn).toHaveBeenCalled();
  });

  it("does not fail the job when typing rejects on a later tick", async () => {
    let finish!: (s: string) => void;
    let n = 0;
    const d = makeDeps({
      runAgentTurn: jest.fn(() => new Promise<string>((res) => { finish = res; })),
      transport: { post: jest.fn(async () => undefined), typing: jest.fn(async () => { if (++n > 1) throw new Error("late"); }) },
    });
    const p = handleChannelMessage(job(), d);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(d.transport.typing).toHaveBeenCalledTimes(2);
    finish("ok");
    await expect(p).resolves.toEqual({ sessionId: "sess-old", posted: "answer" });
    expect(console.warn).toHaveBeenCalled();
  });

  it("a job finishing after its lock expired does not free the newer holder's lock", async () => {
    let holder: string | null = null;
    let seq = 0;
    const lock = {
      acquire: jest.fn(async () => { if (holder) return null; holder = `tok-${++seq}`; return holder; }),
      release: jest.fn(async (_k: string, t: string) => { if (holder === t) holder = null; }),
      extend: jest.fn(async (_k: string, t: string) => holder === t),
    };
    let finishA!: (s: string) => void;
    const a = makeDeps({ lock, runAgentTurn: jest.fn(() => new Promise<string>((res) => { finishA = res; })) });
    const pA = handleChannelMessage(job(), a);
    await jest.advanceTimersByTimeAsync(0);
    holder = null; // A's TTL expires
    const b = makeDeps({ lock, runAgentTurn: jest.fn(() => new Promise<string>(() => undefined)) });
    void handleChannelMessage(job({ messageId: "m2" }), b);
    await jest.advanceTimersByTimeAsync(0);
    expect(holder).toBe("tok-2");
    finishA("A");
    await pA;
    expect(lock.release).toHaveBeenCalledWith(KEY, "tok-1");
    expect(holder).toBe("tok-2");
    const c = makeDeps({ lock });
    expect((await handleChannelMessage(job({ messageId: "m3" }), c)).posted).toBe("skipped");
    jest.clearAllTimers(); // B never finishes in this test
  });

  it("clears the timer when the run throws", async () => {
    const d = makeDeps({ runAgentTurn: jest.fn(async () => { throw new Error("boom"); }) });
    await handleChannelMessage(job(), d);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("rethrows a post failure after releasing the lock", async () => {
    const d = makeDeps({ transport: { post: jest.fn(async () => { throw new Error("post failed"); }), typing: jest.fn(async () => undefined) } });
    await expect(handleChannelMessage(job(), d)).rejects.toThrow("post failed");
    expect(d.lock.release).toHaveBeenCalledTimes(1);
  });

  it("rethrows the post error when the runFailed notice itself fails", async () => {
    const d = makeDeps({
      runAgentTurn: jest.fn(async () => { throw new Error("boom"); }),
      transport: { post: jest.fn(async () => { throw new Error("post failed"); }), typing: jest.fn(async () => undefined) },
    });
    await expect(handleChannelMessage(job(), d)).rejects.toThrow("post failed");
    expect(d.lock.release).toHaveBeenCalledTimes(1);
  });

  it("posts runFailed, releases and rethrows when session creation throws", async () => {
    const d = makeDeps({ sessions: { findRecent: jest.fn(async () => null), create: jest.fn(async () => { throw new Error("db down"); }) } });
    await expect(handleChannelMessage(job(), d)).rejects.toThrow("db down");
    expect(d.runAgentTurn).not.toHaveBeenCalled();
    expect(d.transport.post).toHaveBeenCalledTimes(1);
    expect(d.transport.post).toHaveBeenCalledWith("t1", replyText("runFailed", config));
    expect(d.lock.release).toHaveBeenCalledTimes(1);
  });

  it("still rethrows the original error when the notice after a session failure also fails", async () => {
    const d = makeDeps({
      sessions: { findRecent: jest.fn(async () => { throw new Error("db down"); }), create: jest.fn() },
      transport: { post: jest.fn(async () => { throw new Error("post failed"); }), typing: jest.fn(async () => undefined) },
    });
    await expect(handleChannelMessage(job(), d)).rejects.toThrow("db down");
    expect(d.lock.release).toHaveBeenCalledTimes(1);
  });

  it("extends the lock on the typing timer with the owner token and the run lock TTL, until the run ends", async () => {
    let finish!: (s: string) => void;
    const d = makeDeps({ runAgentTurn: jest.fn(() => new Promise<string>((res) => { finish = res; })) });
    const p = handleChannelMessage(job(), d);
    await jest.advanceTimersByTimeAsync(0);
    expect(d.lock.extend).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(d.lock.extend).toHaveBeenCalledTimes(1);
    expect(d.lock.extend).toHaveBeenCalledWith(KEY, "tok-1", RUN_LOCK_TTL_SECONDS);
    await jest.advanceTimersByTimeAsync(40_000);
    expect(d.lock.extend).toHaveBeenCalledTimes(3);
    finish("fertig");
    await p;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(d.lock.extend).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["returns false", jest.fn(async () => false)],
    ["rejects", jest.fn(async () => { throw new Error("redis down 4915112345678"); })],
  ])("an extend that %s is logged and does not abort the run", async (_label, extend) => {
    let finish!: (s: string) => void;
    const d = makeDeps({
      lock: { acquire: jest.fn(async () => "tok-1"), release: jest.fn(async () => undefined), extend },
      runAgentTurn: jest.fn(() => new Promise<string>((res) => { finish = res; })),
    });
    const p = handleChannelMessage(job(), d);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(extend).toHaveBeenCalledTimes(1);
    finish("Die Antwort");
    await expect(p).resolves.toEqual({ sessionId: "sess-old", posted: "answer" });
    expect(d.transport.post).toHaveBeenCalledWith("t1", "Die Antwort");
    const logged = JSON.stringify([(console.error as jest.Mock).mock.calls, (console.warn as jest.Mock).mock.calls]);
    expect(logged).toContain("chA");
    expect(logged).not.toContain("4915112345678");
  });

  it("a lock whose owner died (no extend) lapses after its TTL; the re-queued job runs and answers", async () => {
    // a Redis-shaped lock with real expiry on the fake clock
    const store = new Map<string, { token: string; until: number }>();
    const live = (k: string) => {
      const e = store.get(k);
      if (e && e.until <= Date.now()) store.delete(k);
      return store.get(k);
    };
    let seq = 0;
    const lock = {
      acquire: jest.fn(async (k: string, ttl: number) => {
        if (live(k)) return null;
        const token = `tok-${++seq}`;
        store.set(k, { token, until: Date.now() + ttl * 1000 });
        return token;
      }),
      release: jest.fn(async (k: string, t: string) => { if (live(k)?.token === t) store.delete(k); }),
      extend: jest.fn(async (k: string, t: string, ttl: number) => {
        const e = live(k);
        if (!e || e.token !== t) return false;
        e.until = Date.now() + ttl * 1000;
        return true;
      }),
    };
    // the first execution took the lock and then its process died: nothing extends or releases it
    await lock.acquire(KEY, RUN_LOCK_TTL_SECONDS);
    const early = makeDeps({ lock });
    expect((await handleChannelMessage(job(), early)).posted).toBe("skipped"); // within the TTL: stillWorking
    await jest.advanceTimersByTimeAsync(RUN_LOCK_TTL_SECONDS * 1000);
    const requeued = makeDeps({ lock });
    expect(await handleChannelMessage(job(), requeued)).toEqual({ sessionId: "sess-old", posted: "answer" });
    expect(requeued.transport.post).toHaveBeenCalledWith("t1", "Die Antwort");
  });

  it("the answered marker is set right before the answer is posted", async () => {
    const order: string[] = [];
    const d = makeDeps({
      markAnswered: jest.fn(async () => { order.push("mark"); return true; }),
      transport: { post: jest.fn(async () => { order.push("post"); }), typing: jest.fn(async () => undefined) },
    });
    await handleChannelMessage(job(), d);
    expect(d.markAnswered).toHaveBeenCalledWith(job());
    expect(order).toEqual(["mark", "post"]);
  });

  it("a second execution of the same message id posts nothing, neither answer nor runFailed", async () => {
    for (const runAgentTurn of [jest.fn(async () => "Die Antwort"), jest.fn(async () => { throw new Error("boom"); })]) {
      const d = makeDeps({ runAgentTurn, markAnswered: jest.fn(async () => false) });
      expect(await handleChannelMessage(job(), d)).toEqual({ sessionId: "sess-old", posted: "skipped" });
      expect(d.transport.post).not.toHaveBeenCalled();
      expect(d.lock.release).toHaveBeenCalledWith(KEY, "tok-1");
    }
  });

  it("the runFailed notice of an executed run also goes through the marker", async () => {
    const d = makeDeps({ runAgentTurn: jest.fn(async () => "") });
    await handleChannelMessage(job(), d);
    expect(d.markAnswered).toHaveBeenCalledTimes(1);
    expect(d.transport.post).toHaveBeenCalledWith("t1", replyText("runFailed", config));
  });

  it("stillWorking for a lock miss does not use the marker", async () => {
    const d = makeDeps({ lock: { acquire: jest.fn(async () => null), release: jest.fn(async () => undefined), extend: jest.fn(async () => true) } });
    await handleChannelMessage(job(), d);
    expect(d.markAnswered).not.toHaveBeenCalled();
  });

  it("a marker that cannot be written is logged and the answer is still posted", async () => {
    const d = makeDeps({ markAnswered: jest.fn(async () => { throw new Error("redis down"); }) });
    expect((await handleChannelMessage(job(), d)).posted).toBe("answer");
    expect(d.transport.post).toHaveBeenCalledWith("t1", "Die Antwort");
    expect(console.error).toHaveBeenCalled();
  });
});
