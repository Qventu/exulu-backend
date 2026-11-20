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
    lock: { acquire: jest.fn(async () => "tok-1" as string | null), release: jest.fn(async () => undefined) },
    sessions: {
      findRecent: jest.fn(async () => "sess-old" as string | null),
      create: jest.fn(async () => "sess-new"),
    },
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
    expect(RUN_LOCK_TTL_SECONDS).toBe(900);
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
    expect(d.lock.acquire).toHaveBeenCalledWith(KEY, 900);
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

  it("skips when the lock is not acquired and does not release it", async () => {
    const d = makeDeps({ lock: { acquire: jest.fn(async () => null), release: jest.fn(async () => undefined) } });
    const r = await handleChannelMessage(job(), d);
    expect(r).toEqual({ sessionId: null, posted: "skipped" });
    expect(d.runAgentTurn).not.toHaveBeenCalled();
    expect(d.transport.post).not.toHaveBeenCalled();
    expect(d.lock.release).not.toHaveBeenCalled();
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
});
