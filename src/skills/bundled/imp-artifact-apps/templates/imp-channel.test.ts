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

  test("a denial during the initial handshake rejects connectImp", async () => {
    const { fakePort, connecting } = openChannel();
    fakePort.deliver({ type: "exulu:identity:denied", v: IDENTITY_V, reason: "not-logged-in" });
    await expect(connecting).rejects.toThrow("Identity denied: not-logged-in");
  });

  test("a denial during refresh() resolves { ok: false, reason }, it does not reject", async () => {
    // Unchanged v1 contract: refresh() never throws — a caller checks
    // `result.ok` and decides whether to show "reload the IMP tab" itself.
    const { fakePort, connecting } = openChannel();
    fakePort.deliver(grantMessage());
    const channel = await connecting;

    const refreshing = channel.refresh();
    fakePort.deliver({ type: "exulu:identity:denied", v: IDENTITY_V, reason: "session-expired" });
    expect(await refreshing).toEqual({ ok: false, reason: "session-expired" });
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

  test("a host:info message stamped with the wrong version is ignored", async () => {
    // Same `data.v !== CHANNEL_V` guard as viewport/progress, applied to
    // host:info specifically — stamped IDENTITY_V (1) rather than CHANNEL_V.
    const { fakePort, connecting } = openChannel();
    fakePort.deliver({
      type: "exulu:host:info",
      v: IDENTITY_V,
      panel: true,
      slots: [{ key: "analyse", label: "Analyse" }],
    });
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

  test("openPanel puts items and files on the wire, not just prompt", async () => {
    // `items`/`files` are exactly what the attachment chain carries end to
    // end; a dropped array here would surface downstream as "the agent
    // didn't get my documents" with nothing pointing back to this call.
    const { fakePort, connecting } = openChannel();
    fakePort.deliver(grantMessage());
    const channel = await connecting;

    const opening = channel.openPanel("analyse", {
      prompt: "Summarise this",
      items: ["item-1", "item-2"],
      files: ["file-1"],
    });
    expect(fakePort.sent).toEqual([
      {
        type: "exulu:panel:open",
        v: CHANNEL_V,
        slot: "analyse",
        prompt: "Summarise this",
        items: ["item-1", "item-2"],
        files: ["file-1"],
      },
    ]);
    fakePort.deliver({ type: "exulu:panel:open:ack", v: CHANNEL_V, slot: "analyse", accepted: true });
    expect(await opening).toBe(true);
  });

  test("a panel:open:ack message stamped with the wrong version is ignored", async () => {
    // Same `data.v !== CHANNEL_V` guard, applied to the ack specifically. If
    // the wrong-version message below were read, it would resolve `opening`
    // to `false` right away and delete the slot's waiter — leaving the
    // correctly versioned ack that follows with nothing to settle, so
    // `await opening` would come back `false` instead of `true`.
    const { fakePort, connecting } = openChannel();
    fakePort.deliver(grantMessage());
    const channel = await connecting;

    const opening = channel.openPanel("analyse");
    fakePort.deliver({ type: "exulu:panel:open:ack", v: IDENTITY_V, slot: "analyse", accepted: false });
    fakePort.deliver({ type: "exulu:panel:open:ack", v: CHANNEL_V, slot: "analyse", accepted: true });
    expect(await opening).toBe(true);
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

  test("re-asks every 300ms until the channel arrives, and stops asking once settled", async () => {
    // Load-bearing in the COMMON case, not an edge case: the parent's own
    // listener doesn't exist until its bundle has hydrated, while this
    // iframe runs as soon as the parent's HTML is parsed, so without this
    // retry the handshake simply fails on a normal page load.
    jest.useFakeTimers();
    const fakeWindow = createFakeWindow();
    const fakePort = createFakePort();
    const connecting = connectImp(fakeWindow.win, 10_000);

    expect(fakeWindow.posted).toHaveLength(1); // the initial ask(), before any retry fires

    await jest.advanceTimersByTimeAsync(300);
    expect(fakeWindow.posted).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(300);
    expect(fakeWindow.posted).toHaveLength(3);

    // The channel (and then the grant) finally arrive.
    fakeWindow.deliver({ data: { type: "exulu:identity:channel", v: IDENTITY_V }, ports: [fakePort.port] });
    fakePort.deliver(grantMessage());
    await connecting;

    // Settling must stop the interval — advancing well past several more
    // retry windows posts nothing further.
    const postedAtSettle = fakeWindow.posted.length;
    await jest.advanceTimersByTimeAsync(900);
    expect(fakeWindow.posted).toHaveLength(postedAtSettle);
  });
});
