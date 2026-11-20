process.env.NEXTAUTH_SECRET = "test-secret";

import { getTransport, resetTransports, toInboundMessage, type TransportDeps } from "./chat-instance";
import { sealSecrets } from "./config";
import type { AgentChannelRow } from "./types";

type DmHandler = (thread: { id: string }, message: any) => Promise<void>;

const makeSdk = (options: { shutdownFails?: boolean } = {}) => {
  const chats: any[] = [];
  const adapters: any[] = [];
  class FakeChat {
    config: any;
    handlers: DmHandler[] = [];
    webhooks = { whatsapp: jest.fn(async (_request: Request) => new Response("ok", { status: 200 })) };
    initialize = jest.fn(async () => {});
    shutdown = jest.fn(async () => {
      if (options.shutdownFails) throw new Error("shutdown boom");
    });
    constructor(config: any) {
      this.config = config;
      chats.push(this);
    }
    onDirectMessage(handler: DmHandler) {
      this.handlers.push(handler);
    }
  }
  const createWhatsAppAdapter = jest.fn((config: any) => {
    const adapter = {
      config,
      postMessage: jest.fn(async () => ({ id: "out", threadId: "t", raw: {} })),
      startTyping: jest.fn(async () => {}),
      markAsRead: jest.fn(async () => {}),
    };
    adapters.push(adapter);
    return adapter;
  });
  const state = { fake: "state" };
  const createPostgresState = jest.fn(() => state);
  const load = jest.fn(async () => ({ Chat: FakeChat, createWhatsAppAdapter, createPostgresState }) as any);
  return { chats, adapters, state, createWhatsAppAdapter, createPostgresState, load };
};

const pool = { fake: "pool" } as any;

const makeRow = (over: Partial<AgentChannelRow> = {}): AgentChannelRow => ({
  id: "chan-1",
  agent: "agent-1",
  type: "whatsapp",
  enabled: true,
  config: { phoneNumberId: "111", displayNumber: "+49 30 1" },
  secrets: sealSecrets({ accessToken: "ACCESS", appSecret: "APPSECRET" }),
  verify_token: "VERIFY",
  updatedAt: new Date("2026-11-01T10:00:00Z"),
  ...over,
});

const deps = (sdk: ReturnType<typeof makeSdk>, onMessage = jest.fn(async () => {})): TransportDeps => ({
  pgPool: pool,
  onMessage,
  load: sdk.load,
});

beforeEach(() => resetTransports());

describe("getTransport: inbound and post-only instances", () => {
  const postOnly = (sdk: ReturnType<typeof makeSdk>): TransportDeps => ({ pgPool: pool, load: sdk.load });
  const deliver = (chat: any, threadId = "whatsapp:111:4915112345678") =>
    chat.handlers[0]({ id: threadId }, { id: "m1", text: "hi", attachments: [], author: { isMe: false } });

  it("a worker-style call first does not capture the server's webhooks", async () => {
    const sdk = makeSdk();
    const worker = await getTransport(makeRow(), postOnly(sdk));
    const onMessage = jest.fn(async () => {});
    const server = await getTransport(makeRow(), deps(sdk, onMessage));
    expect(server).not.toBe(worker);
    expect(sdk.chats).toHaveLength(2);
    expect(sdk.chats[0].handlers).toHaveLength(0);
    expect(sdk.chats[1].handlers).toHaveLength(1);
    await deliver(sdk.chats[1]);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("a server-style call first is not reused by the worker, and the server's handler still delivers", async () => {
    const sdk = makeSdk();
    const onMessage = jest.fn(async () => {});
    const server = await getTransport(makeRow(), deps(sdk, onMessage));
    const worker = await getTransport(makeRow(), postOnly(sdk));
    expect(worker).not.toBe(server);
    expect(await getTransport(makeRow(), deps(sdk, jest.fn()))).toBe(server);
    expect(await getTransport(makeRow(), postOnly(sdk))).toBe(worker);
    await deliver(sdk.chats[0]);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(sdk.chats[1].handlers).toHaveLength(0);
  });

  it("a post-only transport refuses webhooks", async () => {
    const sdk = makeSdk();
    const worker = await getTransport(makeRow(), postOnly(sdk));
    await expect(worker!.handleWebhook(new Request("http://localhost/x"))).rejects.toThrow(/post-only/);
    expect(sdk.chats[0].webhooks.whatsapp).not.toHaveBeenCalled();
  });

  it("a failing handler is logged without the error's message", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sdk = makeSdk();
      const onMessage = jest.fn(async () => {
        throw new Error("select * from channel_links where identity = '4915112345678'");
      });
      await getTransport(makeRow(), deps(sdk, onMessage));
      await deliver(sdk.chats[0]);
      expect(JSON.stringify(error.mock.calls)).toContain("chan-1");
      expect(error.mock.calls.flat().some((a) => a instanceof Error)).toBe(false);
      expect(JSON.stringify(error.mock.calls)).not.toContain("4915112345678");
    } finally {
      error.mockRestore();
    }
  });
});

describe("the SDK logger", () => {
  it("drops errors' messages, thread ids and bodies", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sdk = makeSdk();
      await getTransport(makeRow(), deps(sdk));
      const logger = sdk.chats[0].config.logger;
      logger.error("Message processing error", {
        error: new Error("insert '4915112345678' 'Wie tausche ich'"),
        threadId: "whatsapp:111:4915112345678",
        text: "Wie tausche ich",
      });
      logger.error("failed", new Error("to 4915112345678"));
      const out = JSON.stringify(error.mock.calls);
      expect(out).not.toContain("4915112345678");
      expect(out).not.toContain("Wie tausche");
      expect(error.mock.calls.flat().some((a) => a instanceof Error)).toBe(false);
    } finally {
      error.mockRestore();
    }
  });
});

describe("getTransport", () => {
  it("builds one Chat per channel and reuses it for the same row", async () => {
    const sdk = makeSdk();
    const row = makeRow();
    const a = await getTransport(row, deps(sdk));
    const b = await getTransport({ ...row, updatedAt: new Date(row.updatedAt as Date) }, deps(sdk));
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(sdk.chats).toHaveLength(1);
  });

  it("treats a Date and an ISO string for the same instant as the same row", async () => {
    const sdk = makeSdk();
    const a = await getTransport(makeRow(), deps(sdk));
    const b = await getTransport(makeRow({ updatedAt: "2026-11-01T10:00:00.000Z" }), deps(sdk));
    expect(b).toBe(a);
    expect(sdk.chats).toHaveLength(1);
  });

  it("builds one instance for two concurrent calls", async () => {
    const sdk = makeSdk();
    const [a, b] = await Promise.all([getTransport(makeRow(), deps(sdk)), getTransport(makeRow(), deps(sdk))]);
    expect(b).toBe(a);
    expect(sdk.chats).toHaveLength(1);
    expect(sdk.load).toHaveBeenCalledTimes(1);
  });

  it("builds a new instance when updatedAt changed and shuts the old one down", async () => {
    const sdk = makeSdk();
    const a = await getTransport(makeRow(), deps(sdk));
    const b = await getTransport(makeRow({ updatedAt: new Date("2026-11-02T10:00:00Z") }), deps(sdk));
    expect(b).not.toBe(a);
    expect(sdk.chats).toHaveLength(2);
    expect(sdk.chats[0].shutdown).toHaveBeenCalledTimes(1);
    expect(sdk.chats[1].shutdown).not.toHaveBeenCalled();
  });

  it("logs a failing shutdown of the old instance instead of throwing", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sdk = makeSdk({ shutdownFails: true });
      await getTransport(makeRow(), deps(sdk));
      const b = await getTransport(makeRow({ updatedAt: new Date("2026-11-02T10:00:00Z") }), deps(sdk));
      expect(b).not.toBeNull();
      await new Promise((r) => setImmediate(r));
      expect(error).toHaveBeenCalled();
      expect(JSON.stringify(error.mock.calls)).toContain("chan-1");
    } finally {
      error.mockRestore();
    }
  });

  it("constructs the SDK with the row's decrypted secrets, phone number id and verify token", async () => {
    const sdk = makeSdk();
    await getTransport(makeRow(), deps(sdk));
    expect(sdk.createWhatsAppAdapter).toHaveBeenCalledTimes(1);
    expect(sdk.createWhatsAppAdapter.mock.calls[0]![0]).toMatchObject({
      accessToken: "ACCESS",
      appSecret: "APPSECRET",
      phoneNumberId: "111",
      verifyToken: "VERIFY",
      userName: "exulu-agent",
    });
    expect(sdk.createPostgresState).toHaveBeenCalledWith(
      expect.objectContaining({ client: pool, keyPrefix: "exulu-channel", autoCreateSchema: false }),
    );
    const config = sdk.chats[0].config;
    expect(config.userName).toBe("exulu-agent");
    expect(config.concurrency).toBe("concurrent");
    expect(config.state).toBe(sdk.state);
    expect(config.adapters.whatsapp).toBe(sdk.adapters[0]);
    expect(sdk.chats[0].handlers).toHaveLength(1);
  });

  it.each([
    ["unreadable secrets", { secrets: "garbage" }],
    ["no secrets", { secrets: null }],
    ["no verify token", { verify_token: null }],
    ["an empty verify token", { verify_token: "" }],
    ["a config that does not parse", { config: { displayNumber: "+1" } }],
  ])("returns null and constructs nothing for %s", async (_label, over) => {
    const sdk = makeSdk();
    await expect(getTransport(makeRow(over as Partial<AgentChannelRow>), deps(sdk))).resolves.toBeNull();
    expect(sdk.load).not.toHaveBeenCalled();
    expect(sdk.chats).toHaveLength(0);
  });

  it("shuts down the cached instance when the row is no longer usable", async () => {
    const sdk = makeSdk();
    await getTransport(makeRow(), deps(sdk));
    await expect(
      getTransport(makeRow({ secrets: null, updatedAt: new Date("2026-11-03T10:00:00Z") }), deps(sdk)),
    ).resolves.toBeNull();
    await new Promise((r) => setImmediate(r));
    expect(sdk.chats[0].shutdown).toHaveBeenCalledTimes(1);
  });

  it("keeps the newer instance when an older row arrives after it", async () => {
    const sdk = makeSdk();
    const newer = await getTransport(makeRow({ updatedAt: new Date("2026-11-02T10:00:00Z") }), deps(sdk));
    const stale = await getTransport(makeRow(), deps(sdk));
    expect(stale).toBe(newer);
    expect(sdk.chats).toHaveLength(1);
    expect(sdk.chats[0].shutdown).not.toHaveBeenCalled();
  });

  it("does not rebuild on every call when updatedAt does not parse", async () => {
    const sdk = makeSdk();
    const a = await getTransport(makeRow({ updatedAt: "not a date" }), deps(sdk));
    const b = await getTransport(makeRow({ updatedAt: "not a date" }), deps(sdk));
    expect(b).toBe(a);
    expect(sdk.chats).toHaveLength(1);

    const sdk2 = makeSdk();
    resetTransports();
    const c = await getTransport(makeRow(), deps(sdk2));
    const d = await getTransport(makeRow({ updatedAt: "not a date" }), deps(sdk2));
    expect(d).toBe(c);
    expect(sdk2.chats).toHaveLength(1);
    expect(sdk2.chats[0].shutdown).not.toHaveBeenCalled();
  });

  it("keeps the old instance cached and running when the new build rejects", async () => {
    const sdk = makeSdk();
    const old = await getTransport(makeRow(), deps(sdk));
    const realLoad = sdk.load.getMockImplementation()!;
    sdk.load.mockImplementationOnce(async () => {
      throw new Error("import failed");
    });
    await expect(getTransport(makeRow({ updatedAt: new Date("2026-11-02T10:00:00Z") }), deps(sdk))).rejects.toThrow(
      "import failed",
    );
    sdk.load.mockImplementation(realLoad);
    await expect(getTransport(makeRow(), deps(sdk))).resolves.toBe(old);
    await new Promise((r) => setImmediate(r));
    expect(sdk.chats).toHaveLength(1);
    expect(sdk.chats[0].shutdown).not.toHaveBeenCalled();
  });

  it("retries after a failed build", async () => {
    const sdk = makeSdk();
    const realLoad = sdk.load.getMockImplementation()!;
    sdk.load.mockImplementationOnce(async () => {
      throw new Error("import failed");
    });
    await expect(getTransport(makeRow(), deps(sdk))).rejects.toThrow("import failed");
    sdk.load.mockImplementation(realLoad);
    await expect(getTransport(makeRow(), deps(sdk))).resolves.not.toBeNull();
    expect(sdk.chats).toHaveLength(1);
  });
});

describe("transport", () => {
  const build = async (onMessage = jest.fn(async () => {})) => {
    const sdk = makeSdk();
    const transport = (await getTransport(makeRow(), deps(sdk, onMessage)))!;
    return { sdk, transport, chat: sdk.chats[0], adapter: sdk.adapters[0], onMessage };
  };

  it("hands webhook requests to the whatsapp webhook", async () => {
    const { transport, chat } = await build();
    const request = new Request("https://x/hook", { method: "POST", body: "{}" });
    const response = await transport.handleWebhook(request);
    expect(response.status).toBe(200);
    expect(chat.webhooks.whatsapp).toHaveBeenCalledTimes(1);
    expect(chat.webhooks.whatsapp.mock.calls[0]![0]).toBe(request);
    expect(chat.webhooks.whatsapp.mock.calls[0]![1]).toBeUndefined();
  });

  it("forwards waitUntil to the SDK webhook", async () => {
    const { transport, chat } = await build();
    const request = new Request("https://x/hook", { method: "POST", body: "{}" });
    const options = { waitUntil: jest.fn() };
    await transport.handleWebhook(request, options);
    expect(chat.webhooks.whatsapp.mock.calls[0]![0]).toBe(request);
    expect(chat.webhooks.whatsapp.mock.calls[0]![1]).toBe(options);
  });

  it("posts markdown through the adapter after initializing", async () => {
    const { transport, chat, adapter } = await build();
    await transport.post("whatsapp:111:49151", "**Hallo**");
    expect(chat.initialize).toHaveBeenCalled();
    expect(adapter.postMessage).toHaveBeenCalledWith("whatsapp:111:49151", { markdown: "**Hallo**" });
  });

  it.each([[""], ["   \n\t "]])("refuses to post an empty message %p", async (text) => {
    const { transport, adapter } = await build();
    await expect(transport.post("whatsapp:111:49151", text)).rejects.toThrow(Error);
    expect(adapter.postMessage).not.toHaveBeenCalled();
  });

  it("leaves splitting a long message to the adapter", async () => {
    const { transport, adapter } = await build();
    const long = "a".repeat(5000);
    await transport.post("whatsapp:111:49151", long);
    expect(adapter.postMessage).toHaveBeenCalledTimes(1);
    expect(adapter.postMessage).toHaveBeenCalledWith("whatsapp:111:49151", { markdown: long });
  });

  it("shows typing and marks read through the adapter", async () => {
    const { transport, adapter } = await build();
    await transport.typing("whatsapp:111:49151");
    await transport.markRead("whatsapp:111:49151", "wamid.1");
    expect(adapter.startTyping).toHaveBeenCalledWith("whatsapp:111:49151");
    expect(adapter.markAsRead).toHaveBeenCalledWith("whatsapp:111:49151", "wamid.1");
  });

  it("passes a direct message to onMessage", async () => {
    const { chat, onMessage } = await build();
    await chat.handlers[0]({ id: "whatsapp:111:49151" }, {
      id: "wamid.1",
      text: "Hallo",
      attachments: [],
      author: { isMe: false },
    });
    expect(onMessage).toHaveBeenCalledWith({
      channelId: "chan-1",
      threadId: "whatsapp:111:49151",
      identity: "49151",
      messageId: "wamid.1",
      text: "Hallo",
      hasAttachments: false,
    });
  });

  it("ignores a message for another phone number of the same Meta app", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { chat, onMessage } = await build();
      await chat.handlers[0]({ id: "whatsapp:222:49151" }, {
        id: "wamid.4",
        text: "geheime Frage",
        attachments: [],
        author: { isMe: false },
      });
      expect(onMessage).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
      const logged = JSON.stringify(warn.mock.calls.map((c) => c.map(String)));
      expect(logged).toContain("chan-1");
      expect(logged).not.toContain("geheime Frage");

      await chat.handlers[0]({ id: "whatsapp:111:49151" }, {
        id: "wamid.5",
        text: "Hallo",
        attachments: [],
        author: { isMe: false },
      });
      expect(onMessage).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not pass the bot's own messages to onMessage", async () => {
    const { chat, onMessage } = await build();
    await chat.handlers[0]({ id: "whatsapp:111:49151" }, {
      id: "wamid.2",
      text: "echo",
      attachments: [],
      author: { isMe: true },
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("logs a throwing onMessage with the channel id only and lets the handler finish", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { chat } = await build(
        jest.fn(async () => {
          throw new Error("decide failed");
        }),
      );
      await expect(
        chat.handlers[0]({ id: "whatsapp:111:49151" }, {
          id: "wamid.3",
          text: "geheime Frage",
          attachments: [],
          author: { isMe: false },
        }),
      ).resolves.toBeUndefined();
      expect(error).toHaveBeenCalled();
      const logged = JSON.stringify(error.mock.calls.map((c) => c.map(String)));
      expect(logged).toContain("chan-1");
      expect(logged).not.toContain("geheime Frage");
    } finally {
      error.mockRestore();
    }
  });
});

describe("toInboundMessage", () => {
  it("takes the identity after the phone number id", () => {
    expect(toInboundMessage("c", "whatsapp:111:49151", { id: "m", text: "t", attachments: [] }).identity).toBe("49151");
  });
  it("keeps an identity that contains a colon", () => {
    expect(toInboundMessage("c", "whatsapp:111:US.134:9", { id: "m", text: "t", attachments: [] }).identity).toBe(
      "US.134:9",
    );
  });
  it("flags attachments", () => {
    const msg = toInboundMessage("c", "whatsapp:111:49151", { id: "m", text: "[Image]", attachments: [{}] });
    expect(msg).toEqual({
      channelId: "c",
      threadId: "whatsapp:111:49151",
      identity: "49151",
      messageId: "m",
      text: "[Image]",
      hasAttachments: true,
    });
  });
});
