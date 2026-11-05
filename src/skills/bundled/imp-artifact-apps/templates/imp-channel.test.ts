import {
  CHANNEL_V,
  IDENTITY_V,
  connectImp,
  type HandshakeWindow,
  type MessageLike,
  type PortLike,
} from "./imp-channel";

/**
 * A fake `window` good enough to drive the handshake without a browser:
 * `addEventListener`/`removeEventListener` keep a plain list of handlers, and
 * `deliver` plays a message to all of them synchronously — mirroring how a
 * real `postMessage` event reaches every listener in the same task.
 */
function createFakeWindow() {
  const listeners: Array<(e: MessageLike) => void> = [];
  const posted: unknown[] = [];
  const win: HandshakeWindow = {
    addEventListener: (_t, h) => {
      listeners.push(h);
    },
    removeEventListener: (_t, h) => {
      const i = listeners.indexOf(h);
      if (i >= 0) listeners.splice(i, 1);
    },
    parent: {
      postMessage: (m) => {
        posted.push(m);
      },
    },
  };
  return {
    win,
    posted,
    listenerCount: () => listeners.length,
    deliver(e: MessageLike) {
      for (const h of [...listeners]) h(e);
    },
  };
}

/** A fake `MessagePort`: records everything posted on it, and `deliver` plays an inbound message into whatever handler currently holds `onmessage`. */
function createFakePort() {
  const sent: unknown[] = [];
  const port: PortLike & { sent: unknown[] } = {
    postMessage: (m: unknown) => {
      sent.push(m);
    },
    onmessage: null,
    start: () => {},
    sent,
  };
  return {
    port,
    sent,
    deliver(data: unknown) {
      port.onmessage?.({ data });
    },
  };
}

const grantMessage = (overrides: Partial<Record<string, unknown>> = {}) => ({
  type: "exulu:identity:grant",
  v: IDENTITY_V,
  token: "tok-1",
  backendOrigin: "https://backend.example",
  user: { email: "a@b.com", name: "A" },
  ...overrides,
});

/**
 * Drives a fake window + port through the handshake up to (but not including)
 * delivering the grant, so each test can insert whatever host announcements
 * or timing it cares about before finishing the connect.
 *
 * Everything here runs synchronously relative to `connectImp`'s own executor
 * (a `new Promise(executor)` body runs synchronously on construction), so no
 * `await`/microtask flush is needed between these steps.
 */
function openChannel() {
  const fakeWindow = createFakeWindow();
  const fakePort = createFakePort();
  const connecting = connectImp(fakeWindow.win, 1_000);
  fakeWindow.deliver({ data: { type: "exulu:identity:channel", v: IDENTITY_V }, ports: [fakePort.port] });
  return { fakeWindow, fakePort, connecting };
}

describe("connectImp", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("resolves with the grant, as the v1 client did", async () => {
    const { fakePort, connecting } = openChannel();
    fakePort.deliver(grantMessage());
    const channel = await connecting;
    expect(channel.grant).toEqual({
      token: "tok-1",
      backendOrigin: "https://backend.example",
      user: { email: "a@b.com", name: "A" },
    });
  });

  test("registers the message listener before posting the first request", async () => {
    // Load-bearing v1 behaviour: the parent answers at most once per frame
    // load, so a reply landing before this iframe is listening is lost for
    // good. A regression that posts first and listens second would still
    // "work" against this fake window (delivery is synchronous either way),
    // so this asserts the ORDER directly rather than only the outcome.
    const fakeWindow = createFakeWindow();
    const fakePort = createFakePort();
    const order: string[] = [];
    const originalAdd = fakeWindow.win.addEventListener.bind(fakeWindow.win);
    const originalPost = fakeWindow.win.parent.postMessage.bind(fakeWindow.win.parent);
    fakeWindow.win.addEventListener = (t, h) => {
      order.push("listen");
      originalAdd(t, h);
    };
    fakeWindow.win.parent.postMessage = (m, o) => {
      order.push("ask");
      originalPost(m, o);
    };
    const connecting = connectImp(fakeWindow.win, 1_000);
    expect(order[0]).toBe("listen");
    expect(order).toContain("ask");
    // Finish the handshake so no retry interval or overall timeout is left
    // running past the test.
    fakeWindow.deliver({ data: { type: "exulu:identity:channel", v: IDENTITY_V }, ports: [fakePort.port] });
    fakePort.deliver(grantMessage());
    await connecting;
  });

  test("a progress event delivered DURING an in-flight refresh is not swallowed", async () => {
    // The regression this task exists for: the old client reassigned
    // `port.onmessage` for the duration of a refresh() round-trip, so any
    // unrelated message landing in that window (a host announcement) was
    // handed to a handler that only understood grant/denied and silently
    // dropped it. One dispatcher, set once, means a progress bump and a
    // refresh in flight are independent.
    const { fakePort, connecting } = openChannel();
    fakePort.deliver(grantMessage());
    const channel = await connecting;

    const seen: Array<"tool" | "turn"> = [];
    channel.onProgress((reason) => seen.push(reason));

    const refreshing = channel.refresh();

    // Arrives before the refresh's own answer — exactly the ordering that
    // broke the old client.
    fakePort.deliver({ type: "exulu:session:progress", v: CHANNEL_V, reason: "tool" });
    expect(seen).toEqual(["tool"]);

    fakePort.deliver(grantMessage({ token: "tok-2" }));
    const result = await refreshing;
    expect(result).toEqual({
      ok: true,
      grant: { token: "tok-2", backendOrigin: "https://backend.example", user: { email: "a@b.com", name: "A" } },
    });
  });

  test("host info populates host.panel and host.slots", async () => {
    const { fakePort, connecting } = openChannel();
    // Ordering fact: host info arrives on the port before the grant, and
    // connect() reads the host off it.
    fakePort.deliver({
      type: "exulu:host:info",
      v: CHANNEL_V,
      panel: true,
      slots: [{ key: "analyse", label: "Analyse" }],
    });
    fakePort.deliver(grantMessage());
    const channel = await connecting;
    expect(channel.host).toEqual({ panel: true, slots: [{ key: "analyse", label: "Analyse" }] });
  });

  test("host defaults to no panel when no host info ever arrives", async () => {
    // A v1-only artifact talking to a host that never sends `exulu:host:info`
    // (or a share route that announces `panel:false` — either way, nothing
    // before the grant should leave `host` undefined.
    const { fakePort, connecting } = openChannel();
    fakePort.deliver(grantMessage());
    const channel = await connecting;
    expect(channel.host).toEqual({ panel: false, slots: [] });
  });

  test("onViewport and onProgress return working unsubscribes", async () => {
    const { fakePort, connecting } = openChannel();
    fakePort.deliver(grantMessage());
    const channel = await connecting;

    const viewportCalls: Array<{ width: number; open: boolean }> = [];
    const unsubscribeViewport = channel.onViewport((v) => viewportCalls.push(v));
    const progressCalls: Array<"tool" | "turn"> = [];
    const unsubscribeProgress = channel.onProgress((r) => progressCalls.push(r));

    fakePort.deliver({ type: "exulu:panel:viewport", v: CHANNEL_V, width: 640, open: true });
    fakePort.deliver({ type: "exulu:session:progress", v: CHANNEL_V, reason: "turn" });
    expect(viewportCalls).toEqual([{ width: 640, open: true }]);
    expect(progressCalls).toEqual(["turn"]);

    unsubscribeViewport();
    unsubscribeProgress();

    fakePort.deliver({ type: "exulu:panel:viewport", v: CHANNEL_V, width: 320, open: false });
    fakePort.deliver({ type: "exulu:session:progress", v: CHANNEL_V, reason: "tool" });
    // Unchanged: the unsubscribed callbacks received nothing further.
    expect(viewportCalls).toEqual([{ width: 640, open: true }]);
    expect(progressCalls).toEqual(["turn"]);
  });

  test("openPanel resolves true on an accepted ack and false on a rejected one", async () => {
    const { fakePort, connecting } = openChannel();
    fakePort.deliver(grantMessage());
    const channel = await connecting;

    const accepted = channel.openPanel("analyse", { prompt: "Summarise this" });
    expect(fakePort.sent).toEqual([
      { type: "exulu:panel:open", v: CHANNEL_V, slot: "analyse", prompt: "Summarise this" },
    ]);
    fakePort.deliver({ type: "exulu:panel:open:ack", v: CHANNEL_V, slot: "analyse", accepted: true });
    expect(await accepted).toBe(true);

    const rejected = channel.openPanel("other-slot");
    fakePort.deliver({ type: "exulu:panel:open:ack", v: CHANNEL_V, slot: "other-slot", accepted: false, reason: "unknown-slot" });
    expect(await rejected).toBe(false);
  });

  test("openPanel resolves false rather than hanging when no ack arrives", async () => {
    // Review Focus 5 from the artifact's side — the button must re-enable.
    jest.useFakeTimers();
    const { fakePort, connecting } = openChannel();
    fakePort.deliver(grantMessage());
    const channel = await connecting;

    const pending = channel.openPanel("analyse");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(true);
    expect(await pending).toBe(false);
  });

  test("messages with the wrong version are ignored", async () => {
    const { fakePort, connecting } = openChannel();
    fakePort.deliver(grantMessage());
    const channel = await connecting;

    const viewportCalls: Array<{ width: number; open: boolean }> = [];
    channel.onViewport((v) => viewportCalls.push(v));
    const progressCalls: Array<"tool" | "turn"> = [];
    channel.onProgress((r) => progressCalls.push(r));

    // Stamped v:1 (the identity handshake's own version) rather than
    // CHANNEL_V — must not be read as a v2 channel message.
    fakePort.deliver({ type: "exulu:panel:viewport", v: 1, width: 640, open: true });
    fakePort.deliver({ type: "exulu:session:progress", v: 1, reason: "turn" });
    expect(viewportCalls).toEqual([]);
    expect(progressCalls).toEqual([]);

    // A denied/grant stamped with the wrong version must not be read as v1
    // either (asserted via refresh(), which only ever settles on a v1 reply).
    const refreshing = channel.refresh();
    fakePort.deliver({ type: "exulu:identity:grant", v: CHANNEL_V, token: "x", backendOrigin: "https://x", user: { email: null, name: null } });
    fakePort.deliver(grantMessage({ token: "tok-3" }));
    const result = await refreshing;
    expect(result).toEqual({
      ok: true,
      grant: { token: "tok-3", backendOrigin: "https://backend.example", user: { email: "a@b.com", name: "A" } },
    });
  });
});
