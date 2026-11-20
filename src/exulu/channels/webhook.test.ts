import {
  createChannelWebhookHandler,
  toWebRequest,
  WEBHOOK_BACKGROUND_WAIT_MS,
  type ChannelWebhookDeps,
} from "./webhook";
import type { ChannelTransport } from "./chat-instance";
import type { AgentChannelRow } from "./types";

const CHANNEL_ID = "8f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";

const makeRow = (over: Partial<AgentChannelRow> = {}): AgentChannelRow => ({
  id: CHANNEL_ID,
  agent: "agent-1",
  type: "whatsapp",
  enabled: true,
  config: {},
  secrets: "sealed",
  verify_token: "verify-secret",
  updatedAt: "2026-11-20T00:00:00Z",
  ...over,
});

const makeTransport = (
  handle: ChannelTransport["handleWebhook"] = async () => new Response("ok", { status: 200 }),
): ChannelTransport & { handleWebhook: jest.Mock } => ({
  handleWebhook: jest.fn(handle),
  post: jest.fn(async () => {}),
  typing: jest.fn(async () => {}),
  markRead: jest.fn(async () => {}),
});

const makeDeps = (over: Partial<ChannelWebhookDeps> = {}): ChannelWebhookDeps & Record<string, jest.Mock> =>
  ({
    entitled: jest.fn(() => true),
    rateLimitExceeded: jest.fn(() => false),
    redisAvailable: jest.fn(async () => true),
    loadChannel: jest.fn(async () => makeRow()),
    transportFor: jest.fn(async () => makeTransport()),
    ...over,
  }) as any;

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  sent: boolean;
  status(code: number): FakeRes;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  send(body: unknown): void;
}
const makeRes = (): FakeRes => {
  const res: FakeRes = {
    statusCode: 200,
    headers: {},
    body: undefined,
    sent: false,
    status(code) {
      res.statusCode = code;
      return res;
    },
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value;
    },
    json(body) {
      res.body = body;
      res.sent = true;
    },
    send(body) {
      res.body = body;
      res.sent = true;
    },
  };
  return res;
};

const makeReq = (over: Record<string, unknown> = {}) =>
  ({
    method: "POST",
    originalUrl: `/webhooks/whatsapp/${CHANNEL_ID}`,
    params: { channelId: CHANNEL_ID },
    headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=abc" },
    body: Buffer.from('{"entry":[]}'),
    ...over,
  }) as any;

const run = async (deps: ChannelWebhookDeps, req = makeReq()) => {
  const res = makeRes();
  await createChannelWebhookHandler(deps)(req, res as any);
  return res;
};

let errorSpy: jest.SpyInstance;
beforeEach(() => {
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
  jest.useRealTimers();
});

describe("createChannelWebhookHandler: status codes in order", () => {
  it("rate limit first: 429 even when nothing else would pass", async () => {
    const deps = makeDeps({
      rateLimitExceeded: jest.fn(() => true),
      entitled: jest.fn(() => false),
      loadChannel: jest.fn(async () => undefined),
    });
    const res = await run(deps);
    expect(res.statusCode).toBe(429);
    expect(deps.loadChannel).not.toHaveBeenCalled();
  });

  it("not entitled: 503 before any database call", async () => {
    const deps = makeDeps({ entitled: jest.fn(() => false) });
    const res = await run(deps);
    expect(res.statusCode).toBe(503);
    expect(deps.loadChannel).not.toHaveBeenCalled();
  });

  it("a channel id that is not a uuid is 404 without a database call", async () => {
    const deps = makeDeps();
    const res = await run(deps, makeReq({ params: { channelId: "../../etc" } }));
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ detail: "not found" });
    expect(deps.loadChannel).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown", undefined],
    ["disabled", makeRow({ enabled: false })],
    ["not whatsapp", makeRow({ type: "telegram" as any })],
  ])("%s channel: 404 with the same body", async (_label, row) => {
    const deps = makeDeps({ loadChannel: jest.fn(async () => row) });
    const res = await run(deps);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ detail: "not found" });
    expect(deps.transportFor).not.toHaveBeenCalled();
  });

  it("a disabled channel with Redis down is 404, not 503", async () => {
    const deps = makeDeps({
      loadChannel: jest.fn(async () => makeRow({ enabled: false })),
      redisAvailable: jest.fn(async () => false),
    });
    const res = await run(deps);
    expect(res.statusCode).toBe(404);
    expect(deps.redisAvailable).not.toHaveBeenCalled();
  });

  it("Redis unavailable: 503", async () => {
    const deps = makeDeps({ redisAvailable: jest.fn(async () => false) });
    const res = await run(deps);
    expect(res.statusCode).toBe(503);
    expect(deps.transportFor).not.toHaveBeenCalled();
  });

  it("no transport (bad credentials): 503 and an error naming the channel id only", async () => {
    const deps = makeDeps({ transportFor: jest.fn(async () => null) });
    const res = await run(deps);
    expect(res.statusCode).toBe(503);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain(CHANNEL_ID);
    expect(logged).not.toContain("verify-secret");
    expect(logged).not.toContain("sealed");
    expect(logged).not.toContain("entry");
  });

  it("a failing channel lookup is 503 and leaks nothing, not even to the log", async () => {
    const deps = makeDeps({
      loadChannel: jest.fn(async () =>
        Promise.reject(Object.assign(new Error(`select * from "agent_channels" where "id" = '${CHANNEL_ID}' - db down`), { code: "ECONNREFUSED" })),
      ),
    });
    const res = await run(deps);
    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain("db down");
    expect(JSON.stringify(errorSpy.mock.calls)).toContain("ECONNREFUSED");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("db down");
    expect(errorSpy.mock.calls.flat().some((a) => a instanceof Error)).toBe(false);
  });
});

describe("createChannelWebhookHandler: SDK pass-through", () => {
  it("writes the SDK response status, headers and body for a GET challenge", async () => {
    const transport = makeTransport(async (request) => {
      const challenge = new URL(request.url).searchParams.get("hub.challenge") ?? "";
      return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
    });
    const deps = makeDeps({ transportFor: jest.fn(async () => transport) });
    const res = await run(
      deps,
      makeReq({
        method: "GET",
        originalUrl: `/webhooks/whatsapp/${CHANNEL_ID}?hub.mode=subscribe&hub.challenge=12345&hub.verify_token=x`,
        body: undefined,
        headers: {},
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain");
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect((res.body as Buffer).toString()).toBe("12345");
  });

  it("passes a non-200 SDK answer through (e.g. a bad signature)", async () => {
    const transport = makeTransport(async () => new Response("Invalid signature", { status: 401 }));
    const res = await run(makeDeps({ transportFor: jest.fn(async () => transport) }));
    expect(res.statusCode).toBe(401);
    expect((res.body as Buffer).toString()).toBe("Invalid signature");
  });

  it("hands the SDK the exact raw body bytes", async () => {
    const raw = Buffer.from('{"a":"ü\\u00fc","b":  1}\n');
    let seen: Buffer | null = null;
    const transport = makeTransport(async (request) => {
      seen = Buffer.from(await request.arrayBuffer());
      return new Response("ok", { status: 200 });
    });
    await run(makeDeps({ transportFor: jest.fn(async () => transport) }), makeReq({ body: raw }));
    expect(seen).not.toBeNull();
    expect(Buffer.compare(seen as unknown as Buffer, raw)).toBe(0);
  });

  it("does not respond until a pending background task has settled", async () => {
    let resolveTask!: () => void;
    let resSentWhenTaskDone: boolean | null = null;
    const res = makeRes();
    const transport = makeTransport(async (_request, options) => {
      options?.waitUntil?.(
        new Promise<void>((resolve) => {
          resolveTask = () => {
            resSentWhenTaskDone = res.sent;
            resolve();
          };
        }),
      );
      return new Response("ok", { status: 200 });
    });
    const done = createChannelWebhookHandler(makeDeps({ transportFor: jest.fn(async () => transport) }))(
      makeReq(),
      res as any,
    );
    await new Promise((r) => setImmediate(r));
    expect(res.sent).toBe(false);
    resolveTask();
    await done;
    expect(resSentWhenTaskDone).toBe(false);
    expect(res.sent).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("a rejecting background task is logged with the channel id and does not change the response", async () => {
    const transport = makeTransport(async (_request, options) => {
      options?.waitUntil?.(Promise.reject(new Error("message text: hello 4915112345678")));
      return new Response("ok", { status: 200 });
    });
    const res = await run(makeDeps({ transportFor: jest.fn(async () => transport) }));
    expect(res.statusCode).toBe(200);
    expect((res.body as Buffer).toString()).toBe("ok");
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain(CHANNEL_ID);
    expect(logged).not.toContain("4915112345678");
    expect(logged).not.toContain("hello");
  });

  it("stops waiting after the bound, responds, and clears its timer", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.useFakeTimers();
    const transport = makeTransport(async (_request, options) => {
      options?.waitUntil?.(new Promise(() => {})); // never settles
      return new Response("ok", { status: 200 });
    });
    const res = makeRes();
    const done = createChannelWebhookHandler(makeDeps({ transportFor: jest.fn(async () => transport) }))(
      makeReq(),
      res as any,
    );
    await jest.advanceTimersByTimeAsync(WEBHOOK_BACKGROUND_WAIT_MS - 1);
    expect(res.sent).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await done;
    expect(res.sent).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(jest.getTimerCount()).toBe(0);
    expect(WEBHOOK_BACKGROUND_WAIT_MS).toBe(8000);
    expect(JSON.stringify(warn.mock.calls)).toContain(CHANNEL_ID);
    warn.mockRestore();
  });

  it("clears the timer when the tasks settle first", async () => {
    jest.useFakeTimers();
    const transport = makeTransport(async (_request, options) => {
      options?.waitUntil?.(Promise.resolve());
      return new Response("ok", { status: 200 });
    });
    const res = makeRes();
    const done = createChannelWebhookHandler(makeDeps({ transportFor: jest.fn(async () => transport) }))(
      makeReq(),
      res as any,
    );
    await jest.advanceTimersByTimeAsync(0);
    await done;
    expect(res.sent).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("an SDK that throws is a 500 without detail and the log names only the channel", async () => {
    const transport = makeTransport(async () => {
      throw new Error("Unexpected token in {\"text\":\"secret question\"}");
    });
    const res = await run(makeDeps({ transportFor: jest.fn(async () => transport) }));
    expect(res.statusCode).toBe(500);
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain(CHANNEL_ID);
    expect(logged).not.toContain("secret question");
  });
});

describe("toWebRequest", () => {
  it("preserves method, query string, the signature header and the exact body", async () => {
    const raw = Buffer.from([0x7b, 0x22, 0xc3, 0xbc, 0x22, 0x7d, 0x0a, 0x00, 0xff]);
    const req = makeReq({
      originalUrl: `/webhooks/whatsapp/${CHANNEL_ID}?a=1&b=two%20words`,
      headers: { "x-hub-signature-256": "sha256=deadbeef", "content-type": "application/json", host: "example.com" },
    });
    const request = toWebRequest(req, raw);
    expect(request.method).toBe("POST");
    const url = new URL(request.url);
    expect(url.pathname).toBe(`/webhooks/whatsapp/${CHANNEL_ID}`);
    expect(url.search).toBe("?a=1&b=two%20words");
    expect(request.headers.get("x-hub-signature-256")).toBe("sha256=deadbeef");
    expect(Buffer.compare(Buffer.from(await request.arrayBuffer()), raw)).toBe(0);
  });

  it("sends no body for GET", async () => {
    const request = toWebRequest(makeReq({ method: "GET", headers: {} }), Buffer.alloc(0));
    expect(request.method).toBe("GET");
    expect(request.body).toBeNull();
  });

  it("keeps repeated headers", () => {
    const request = toWebRequest(makeReq({ headers: { "x-multi": ["a", "b"] } }), Buffer.alloc(0));
    expect(request.headers.get("x-multi")).toBe("a, b");
  });
});
