import { createHash } from "crypto";
import {
  actOnDecision,
  channelJobOptions,
  enqueueChannelMessage,
  seenKey,
  CHANNEL_JOB_NAME,
  CHANNEL_JOB_TIMEOUT_SECONDS,
  SEEN_TTL_SECONDS,
} from "./act";
import type { ChannelTransport } from "./chat-instance";
import type { InboundMessage } from "./decide";
import { RUN_LOCK_TTL_SECONDS, type ChannelMessageJob } from "./run";
import { replyText } from "./texts";
import type { WhatsAppChannelConfig } from "./types";

const config: WhatsAppChannelConfig = {
  phoneNumberId: "pn-1",
  displayNumber: "+49 30 1234",
  linkTtlDays: 7,
  sessionIdleHours: 8,
  locale: "de",
  texts: {},
};

const msg: InboundMessage = {
  channelId: "chan-1",
  threadId: "whatsapp:pn-1:4915112345678",
  identity: "4915112345678",
  messageId: "wamid.HBgNNDkxNTExMjM0NTY3OBUCABIYFjNFQjBEQ0Y=",
  text: "Wie tausche ich das Relais?",
  hasAttachments: false,
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

class FakeStore {
  values = new Map<string, string>();
  ttls = new Map<string, number>();
  async set(key: string, value: string, opts: { EX: number; NX?: true }) {
    if (opts.NX && this.values.has(key)) return null;
    this.values.set(key, value);
    this.ttls.set(key, opts.EX);
    return "OK";
  }
  async del(key: string) {
    this.ttls.delete(key);
    return this.values.delete(key) ? 1 : 0;
  }
}

const makeTransport = (over: Partial<ChannelTransport> = {}) =>
  ({
    handleWebhook: jest.fn(),
    post: jest.fn(async () => {}),
    typing: jest.fn(async () => {}),
    markRead: jest.fn(async () => {}),
    ...over,
  }) as unknown as ChannelTransport & Record<string, jest.Mock>;

const logged = (spy: jest.SpyInstance) => JSON.stringify(spy.mock.calls);
const hasErrorObject = (spy: jest.SpyInstance) => spy.mock.calls.flat().some((a) => a instanceof Error);

let warn: jest.SpyInstance;
let error: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  error = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

describe("actOnDecision", () => {
  it("reply posts the rendered text to the thread", async () => {
    const transport = makeTransport();
    const enqueue = jest.fn();
    const linkUrl = "https://newton.example/public/agents/a/link/whatsapp";
    await actOnDecision(msg, { kind: "reply", key: "linkRequired", vars: { linkUrl } }, {
      config,
      transport,
      enqueue,
      store: new FakeStore(),
    });
    expect(transport.post).toHaveBeenCalledWith(msg.threadId, replyText("linkRequired", config, { linkUrl }));
    expect((transport.post as jest.Mock).mock.calls[0][1]).toContain(linkUrl);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("silent posts nothing and enqueues nothing", async () => {
    const transport = makeTransport();
    const enqueue = jest.fn();
    await actOnDecision(msg, { kind: "silent" }, { config, transport, enqueue, store: new FakeStore() });
    expect(transport.post).not.toHaveBeenCalled();
    expect(transport.typing).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("run marks the message seen, enqueues the job, then marks read and starts typing", async () => {
    const order: string[] = [];
    const transport = makeTransport({
      markRead: jest.fn(async () => void order.push("markRead")),
      typing: jest.fn(async () => void order.push("typing")),
    });
    const enqueue = jest.fn(async () => void order.push("enqueue"));
    const store = new FakeStore();
    await actOnDecision(msg, { kind: "run", userId: 7, newSession: true }, { config, transport, enqueue, store });
    const job: ChannelMessageJob = {
      channelId: "chan-1",
      threadId: msg.threadId,
      identity: msg.identity,
      userId: 7,
      messageId: msg.messageId,
      text: msg.text,
      newSession: true,
    };
    expect(enqueue).toHaveBeenCalledWith(job);
    expect(transport.markRead).toHaveBeenCalledWith(msg.threadId, msg.messageId);
    expect(order[0]).toBe("enqueue");
    expect(transport.post).not.toHaveBeenCalled();
    const key = `channel-seen:chan-1:${sha(msg.messageId)}`;
    expect(seenKey("chan-1", msg.messageId)).toBe(key);
    expect(store.values.get(key)).toBe("1");
    expect(store.ttls.get(key)).toBe(86400);
    expect(SEEN_TTL_SECONDS).toBe(86400);
  });

  it("a second delivery of the same message id is not enqueued and does nothing else", async () => {
    const store = new FakeStore();
    const enqueue = jest.fn(async () => {});
    await actOnDecision(msg, { kind: "run", userId: 7, newSession: false }, { config, transport: makeTransport(), enqueue, store });
    const transport = makeTransport();
    await actOnDecision(msg, { kind: "run", userId: 7, newSession: false }, { config, transport, enqueue, store });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(transport.post).not.toHaveBeenCalled();
    expect(transport.markRead).not.toHaveBeenCalled();
    expect(transport.typing).not.toHaveBeenCalled();
  });

  it("run survives a throwing typing and markRead, logging without the error message", async () => {
    const transport = makeTransport({
      typing: jest.fn(async () => {
        throw new Error("graph 400 for 4915112345678");
      }),
      markRead: jest.fn(() => {
        throw new Error("graph 400 for 4915112345678");
      }),
    });
    const enqueue = jest.fn(async () => {});
    await expect(
      actOnDecision(msg, { kind: "run", userId: 7, newSession: false }, { config, transport, enqueue, store: new FakeStore() }),
    ).resolves.toBeUndefined();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(logged(warn)).not.toContain("4915112345678");
    expect(logged(warn)).not.toContain("Relais");
    expect(hasErrorObject(warn)).toBe(false);
  });

  it("a failing enqueue frees the seen key, posts runFailed and logs safely", async () => {
    const transport = makeTransport();
    const store = new FakeStore();
    const enqueue = jest.fn(async () => {
      throw new Error("ERR redis 'Wie tausche ich das Relais?' 4915112345678");
    });
    await expect(
      actOnDecision(msg, { kind: "run", userId: 7, newSession: false }, { config, transport, enqueue, store }),
    ).resolves.toBeUndefined();
    expect(store.values.has(seenKey("chan-1", msg.messageId))).toBe(false);
    expect(transport.post).toHaveBeenCalledWith(msg.threadId, replyText("runFailed", config));
    expect(transport.typing).not.toHaveBeenCalled();
    expect(logged(error)).toContain("chan-1");
    expect(logged(error)).not.toContain("4915112345678");
    expect(logged(error)).not.toContain("Relais");
    expect(hasErrorObject(error)).toBe(false);
  });

  it("a failing runFailed notice after a failed enqueue is logged and swallowed", async () => {
    const transport = makeTransport({
      post: jest.fn(async () => {
        throw new Error("graph down");
      }),
    });
    const enqueue = jest.fn(async () => {
      throw new Error("redis down");
    });
    await expect(
      actOnDecision(msg, { kind: "run", userId: 7, newSession: false }, { config, transport, enqueue, store: new FakeStore() }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(2);
  });
});

describe("enqueueChannelMessage", () => {
  const job: ChannelMessageJob = {
    channelId: "chan-1",
    threadId: msg.threadId,
    identity: msg.identity,
    userId: 7,
    messageId: msg.messageId,
    text: msg.text,
    newSession: false,
  };

  it("adds a channel_message job with a hashed id, one attempt and no retention", async () => {
    const add = jest.fn(async () => ({}));
    await enqueueChannelMessage({ add }, job);
    expect(add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = add.mock.calls[0] as unknown as [string, any, any];
    expect(name).toBe(CHANNEL_JOB_NAME);
    expect(name).toBe("channel_message");
    expect(data.type).toBe("channel_message");
    expect(data.inputs).toEqual(job);
    expect(opts).toEqual({
      jobId: `wa:${sha(msg.messageId).slice(0, 32)}`,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });
  });

  it("the job id contains no part of the message id", () => {
    const { jobId } = channelJobOptions(msg.messageId);
    expect(jobId).toMatch(/^wa:[0-9a-f]{32}$/);
    for (let i = 0; i + 6 <= msg.messageId.length; i++) {
      expect(jobId).not.toContain(msg.messageId.slice(i, i + 6));
    }
  });

  it("the run lock outlives the job timeout", () => {
    expect(RUN_LOCK_TTL_SECONDS).toBeGreaterThan(CHANNEL_JOB_TIMEOUT_SECONDS);
  });
});
