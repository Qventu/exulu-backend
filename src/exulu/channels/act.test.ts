import {
  actOnDecision,
  channelJobOptions,
  enqueueChannelMessage,
  CHANNEL_JOB_NAME,
  CHANNEL_JOB_TIMEOUT_SECONDS,
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
  messageId: "wamid.ABC",
  text: "Wie tausche ich das Relais?",
  hasAttachments: false,
};

const makeTransport = (over: Partial<ChannelTransport> = {}) =>
  ({
    handleWebhook: jest.fn(),
    post: jest.fn(async () => {}),
    typing: jest.fn(async () => {}),
    markRead: jest.fn(async () => {}),
    ...over,
  }) as unknown as ChannelTransport & Record<string, jest.Mock>;

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("actOnDecision", () => {
  it("reply posts the rendered text to the thread", async () => {
    const transport = makeTransport();
    const enqueue = jest.fn();
    const linkUrl = "https://newton.example/public/agents/a/link/whatsapp";
    await actOnDecision(msg, { kind: "reply", key: "linkRequired", vars: { linkUrl } }, { config, transport, enqueue });
    expect(transport.post).toHaveBeenCalledWith(msg.threadId, replyText("linkRequired", config, { linkUrl }));
    expect((transport.post as jest.Mock).mock.calls[0][1]).toContain(linkUrl);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("silent posts nothing and enqueues nothing", async () => {
    const transport = makeTransport();
    const enqueue = jest.fn();
    await actOnDecision(msg, { kind: "silent" }, { config, transport, enqueue });
    expect(transport.post).not.toHaveBeenCalled();
    expect(transport.typing).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("run enqueues the job, then marks read and starts typing", async () => {
    const order: string[] = [];
    const transport = makeTransport({
      markRead: jest.fn(async () => void order.push("markRead")),
      typing: jest.fn(async () => void order.push("typing")),
    });
    const enqueue = jest.fn(async () => void order.push("enqueue"));
    await actOnDecision(msg, { kind: "run", userId: 7, newSession: true }, { config, transport, enqueue });
    const job: ChannelMessageJob = {
      channelId: "chan-1",
      threadId: msg.threadId,
      identity: msg.identity,
      userId: 7,
      messageId: "wamid.ABC",
      text: msg.text,
      newSession: true,
    };
    expect(enqueue).toHaveBeenCalledWith(job);
    expect(transport.markRead).toHaveBeenCalledWith(msg.threadId, "wamid.ABC");
    expect(order[0]).toBe("enqueue");
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("run survives a throwing typing and markRead, logging without the message", async () => {
    const transport = makeTransport({
      typing: jest.fn(async () => {
        throw new Error("graph 400");
      }),
      markRead: jest.fn(() => {
        throw new Error("graph 400");
      }),
    });
    const enqueue = jest.fn(async () => {});
    await expect(
      actOnDecision(msg, { kind: "run", userId: 7, newSession: false }, { config, transport, enqueue }),
    ).resolves.toBeUndefined();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("4915112345678");
    expect(logged).not.toContain("Relais");
  });

  it("a failing enqueue rejects (so nothing claims the message is being answered)", async () => {
    const transport = makeTransport();
    const enqueue = jest.fn(async () => {
      throw new Error("redis down");
    });
    await expect(
      actOnDecision(msg, { kind: "run", userId: 7, newSession: false }, { config, transport, enqueue }),
    ).rejects.toThrow("redis down");
    expect(transport.typing).not.toHaveBeenCalled();
  });
});

describe("enqueueChannelMessage", () => {
  const job: ChannelMessageJob = {
    channelId: "chan-1",
    threadId: msg.threadId,
    identity: msg.identity,
    userId: 7,
    messageId: "wamid.ABC",
    text: msg.text,
    newSession: false,
  };

  it("adds a channel_message job keyed by the WhatsApp message id, without retries", async () => {
    const add = jest.fn(async () => ({}));
    await enqueueChannelMessage({ add }, job);
    expect(add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = add.mock.calls[0] as unknown as [string, any, any];
    expect(name).toBe(CHANNEL_JOB_NAME);
    expect(name).toBe("channel_message");
    expect(data.type).toBe("channel_message");
    expect(data.inputs).toEqual(job);
    expect(opts.jobId).toBe("wa:wamid.ABC");
    expect(opts.attempts).toBe(1);
    expect(opts.backoff).toBeUndefined();
  });

  it("the run lock outlives the job timeout", () => {
    expect(RUN_LOCK_TTL_SECONDS).toBeGreaterThan(CHANNEL_JOB_TIMEOUT_SECONDS);
  });

  it("keeps finished jobs for 24 hours so a redelivery within a day stays a no-op", () => {
    const opts = channelJobOptions("wamid.ABC");
    expect(opts.removeOnComplete).toEqual({ age: 86400 });
    expect(opts.removeOnFail).toEqual({ age: 86400 });
  });
});
