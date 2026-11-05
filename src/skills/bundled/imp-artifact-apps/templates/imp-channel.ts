/**
 * The artifact's half of the IMP agent-panel channel: the identity handshake
 * (v1, unchanged) plus the host/artifact announcements layered on top of the
 * same port (v2 — see references/identity-handshake.md for the full message
 * table). Copy this file into an artifact's `src/lib/` rather than writing a
 * handshake by hand (SKILL.md).
 *
 * The parent side lives in the frontend repository
 * (`app/artifacts/[artifact_name]/artifact-frame.tsx` and
 * `lib/artifacts/agent-panel-protocol.ts`). The wire shapes are declared a
 * SECOND time here, deliberately: an artifact is authored in a repository
 * that cannot import from the IMP frontend, and there is no shared package.
 * Both sides stamp every v2 message with `CHANNEL_V`, so a drift between the
 * two declarations surfaces at runtime as a rejected version rather than as
 * silent misbehaviour on whichever side forgot to update.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE DISPATCHER
 * ---------------------------------------------------------------------------
 * The client this replaces (mevakipi/artifact-pitch/src/lib/identity.ts)
 * reassigns `port.onmessage` on every `refresh()` call, to a handler that
 * only understands a grant or a denial. Only one function can hold
 * `port.onmessage` at a time — so while a refresh is in flight, any
 * unsolicited message the host sends (a viewport resize, a progress bump, an
 * open-panel ack for a request made moments earlier) arrives at that
 * refresh-only handler, matches neither branch, and is silently dropped. The
 * symptom is "sometimes the artifact doesn't update", and it is expensive to
 * chase because it only reproduces when a refresh happens to be in flight.
 *
 * `connectImp` assigns `port.onmessage` to ONE dispatcher, exactly once, for
 * the lifetime of the channel. It switches on `data.type` and routes to
 * whichever registered handler cares — a pending identity exchange
 * (connect's own grant, or a later `refresh()`), a viewport/progress
 * subscriber, or a pending `openPanel` ack. None of these can starve another:
 * a refresh in flight still lets a progress bump reach `onProgress` the same
 * tick it arrives.
 *
 * ---------------------------------------------------------------------------
 * ORDERING THIS MODULE RELIES ON
 * ---------------------------------------------------------------------------
 * The host posts `exulu:host:info` and (when a panel is already open) a
 * seeded `exulu:panel:viewport` on the port synchronously, as part of the
 * SAME handoff that transfers the port — both land before any `await` on the
 * host's side can let the grant's own fetch resolve. So by the time the
 * grant arrives and `connectImp`'s promise settles, `host.panel`
 * and `host.slots` already hold their final values for this frame load; see
 * `references/identity-handshake.md` for why "final" means "until the next
 * navigation", not "until the assignment changes".
 */

// --- injectable window, unchanged from the v1 client (no browser needed) --

export type PortLike = {
  postMessage(m: unknown): void;
  onmessage: ((e: { data: any }) => void) | null;
  start?: () => void;
};

export type MessageLike = { data: any; ports?: readonly PortLike[] };

export type HandshakeWindow = {
  addEventListener(t: "message", h: (e: MessageLike) => void): void;
  removeEventListener(t: "message", h: (e: MessageLike) => void): void;
  parent: { postMessage(m: unknown, targetOrigin: string): void };
};

// --- v1 identity handshake (unchanged wire shape and version) -------------

export const IDENTITY_V = 1;

export type Grant = {
  token: string;
  backendOrigin: string;
  user: { email: string | null; name: string | null };
};

export type IdentityResult = { ok: true; grant: Grant } | { ok: false; reason: string };

// --- v2 agent-panel channel (mirrors lib/artifacts/agent-panel-protocol.ts) -

export const CHANNEL_V = 2;

export interface PanelSlot {
  key: string;
  label: string;
}

/**
 * The artifact's end of the channel. `grant` is a snapshot taken when
 * `connectImp` resolved — exactly like the v1 client, it is never mutated by
 * a later `refresh()`; use the `Grant` the resolved `IdentityResult` carries.
 */
export interface ImpChannel {
  grant: Grant;
  /** Ask the parent to re-mint using its own session. One call per 401 — concurrent callers should single-flight this themselves (see identity-handshake.md); a second call in flight replaces the first's resolver, which then times out. */
  refresh(): Promise<IdentityResult>;
  /** What this host told the artifact once, right after the handshake: whether a panel exists at all, and which slots are assigned. Never re-announced within a frame load. */
  host: { panel: boolean; slots: PanelSlot[] };
  /** Fires on every `exulu:panel:viewport` the host sends. Can fire immediately: a panel already open when this artifact connects is seeded on the handoff. Returns an unsubscribe. */
  onViewport(cb: (v: { width: number; open: boolean }) => void): () => void;
  /** Fires on every `exulu:session:progress` bump. Can fire immediately on connect — reopening a panel on a session with existing tool-call history bumps once on mount — so register this before doing anything else, not after a user action. Returns an unsubscribe. */
  onProgress(cb: (reason: "tool" | "turn") => void): () => void;
  /** Asks the host to open `slot`'s panel with an optional prefilled prompt and knowledge items/files. Resolves `true`/`false` on the host's ack, or `false` if no ack arrives — never hangs, so a caller can safely re-enable its own button on settle. */
  openPanel(slot: string, opts?: { prompt?: string; items?: string[]; files?: string[] }): Promise<boolean>;
}

/** Validates a `postMessage` payload as a v1 grant. Mirrors the v1 client's own `asGrant` exactly — not re-derived, so a future protocol change to one is a conscious change to both. */
function asGrant(data: any): Grant | null {
  if (data?.type !== "exulu:identity:grant" || data?.v !== IDENTITY_V) return null;
  if (typeof data.token !== "string" || typeof data.backendOrigin !== "string") return null;
  if (typeof data.user !== "object" || data.user === null) return null;
  return { token: data.token, backendOrigin: data.backendOrigin, user: data.user };
}

/**
 * Projects an untrusted `slots` value down to `{key,label}` pairs, dropping
 * anything malformed rather than passing it through. The host already does
 * this projection on its side (agent ids never cross this channel at all),
 * but rebuilding here too means a host-side bug that leaked a wider object
 * cannot hand it to whatever picker UI an artifact renders off `host.slots`.
 */
function sanitizeSlots(value: unknown): PanelSlot[] {
  if (!Array.isArray(value)) return [];
  const result: PanelSlot[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const key = (entry as Record<string, unknown>).key;
    const label = (entry as Record<string, unknown>).label;
    if (typeof key !== "string" || typeof label !== "string") continue;
    result.push({ key, label });
  }
  return result;
}

/** Re-asked every 300ms until the channel arrives — see the module header and `references/identity-handshake.md` for why. */
const HANDSHAKE_RETRY_MS = 300;

/**
 * Establishes the channel: the v1 identity handshake, then one dispatcher
 * for everything that arrives on the resulting port for as long as the
 * artifact lives.
 *
 * `timeoutMs` bounds the initial handshake AND is reused as the budget for
 * every later `refresh()` and `openPanel()` round-trip — one knob rather than
 * three unexplained magic numbers, on the view that a host slow enough to
 * miss one of these is slow enough to miss any of them.
 */
export function connectImp(win: HandshakeWindow, timeoutMs = 10_000): Promise<ImpChannel> {
  return new Promise<ImpChannel>((resolve, reject) => {
    let settled = false;
    let port: PortLike | null = null;
    let retry: ReturnType<typeof setInterval> | undefined;

    // --- state the dispatcher maintains for the life of the channel -------
    const host: { panel: boolean; slots: PanelSlot[] } = { panel: false, slots: [] };
    const viewportSubs = new Set<(v: { width: number; open: boolean }) => void>();
    const progressSubs = new Set<(reason: "tool" | "turn") => void>();
    const openWaiters = new Map<string, (accepted: boolean) => void>();
    // Whichever identity exchange is currently outstanding: the initial
    // grant this very promise is waiting on, or a later refresh() call.
    // Cleared the instant its answer arrives, by the dispatcher below — not
    // by whoever set it — so a message that fails validation (wrong
    // version, wrong shape) leaves it in place for the real answer to still
    // land on.
    let pendingIdentity: ((result: IdentityResult) => void) | null = null;

    const stopHandshake = (): void => {
      clearTimeout(timer);
      if (retry !== undefined) clearInterval(retry);
      win.removeEventListener("message", onWindowMessage);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopHandshake();
      reject(new Error("No answer from the IMP (identity timeout)."));
    }, timeoutMs);

    /**
     * THE single dispatcher (see the module header's "WHY ONE DISPATCHER").
     * Assigned exactly once below, when the port arrives, and never
     * reassigned — every message that reaches this port for the rest of the
     * channel's life, whatever it is, comes through here.
     */
    const onPortMessage = (e: { data: any }): void => {
      const data = e.data;
      if (!data || typeof data !== "object") return;
      switch (data.type) {
        case "exulu:identity:grant": {
          const grant = asGrant(data);
          if (!grant) return; // wrong version or malformed: ignored, pendingIdentity left in place
          const deliverTo = pendingIdentity;
          pendingIdentity = null;
          deliverTo?.({ ok: true, grant });
          return;
        }
        case "exulu:identity:denied": {
          if (data.v !== IDENTITY_V) return;
          const deliverTo = pendingIdentity;
          pendingIdentity = null;
          deliverTo?.({ ok: false, reason: String(data.reason) });
          return;
        }
        case "exulu:host:info": {
          if (data.v !== CHANNEL_V) return;
          host.panel = data.panel === true;
          host.slots = sanitizeSlots(data.slots);
          return;
        }
        case "exulu:panel:viewport": {
          if (data.v !== CHANNEL_V) return;
          if (typeof data.width !== "number" || typeof data.open !== "boolean") return;
          const v = { width: data.width, open: data.open };
          for (const cb of viewportSubs) cb(v);
          return;
        }
        case "exulu:session:progress": {
          if (data.v !== CHANNEL_V) return;
          if (data.reason !== "tool" && data.reason !== "turn") return;
          for (const cb of progressSubs) cb(data.reason);
          return;
        }
        case "exulu:panel:open:ack": {
          if (data.v !== CHANNEL_V) return;
          if (typeof data.slot !== "string") return;
          const resolveOpen = openWaiters.get(data.slot);
          resolveOpen?.(data.accepted === true);
          return;
        }
        default:
          return; // unknown type: ignored, not an error — a future host message an older artifact doesn't know about must not throw
      }
    };

    /** Ask the parent to re-mint using its own session — single round-trip over the established port, through the one dispatcher above. */
    const refresh = (): Promise<IdentityResult> => {
      return new Promise<IdentityResult>((resolveRefresh) => {
        if (!port) {
          resolveRefresh({ ok: false, reason: "no-port" });
          return;
        }
        let done = false;
        const refreshTimer = setTimeout(() => {
          if (done) return;
          done = true;
          pendingIdentity = null;
          resolveRefresh({ ok: false, reason: "timeout" });
        }, timeoutMs);
        pendingIdentity = (result) => {
          if (done) return;
          done = true;
          clearTimeout(refreshTimer);
          resolveRefresh(result);
        };
        port.postMessage({ type: "exulu:identity:refresh", v: IDENTITY_V });
      });
    };

    const onViewport = (cb: (v: { width: number; open: boolean }) => void): (() => void) => {
      viewportSubs.add(cb);
      return () => viewportSubs.delete(cb);
    };

    const onProgress = (cb: (reason: "tool" | "turn") => void): (() => void) => {
      progressSubs.add(cb);
      return () => progressSubs.delete(cb);
    };

    /**
     * Asks the host to open a panel; resolves on the matching ack or on
     * timeout — see `ImpChannel.openPanel`'s doc comment for why it never
     * hangs. Keyed by `slot`: calling this again for the SAME slot before its
     * first call's ack has arrived replaces that call's waiter, which then
     * only ever resolves on its own timeout — the same "one in flight at a
     * time" contract `refresh()` has, and one a caller shouldn't hit anyway
     * if (as intended) its own button disables until the promise settles.
     */
    const openPanel = (
      slot: string,
      opts?: { prompt?: string; items?: string[]; files?: string[] },
    ): Promise<boolean> => {
      return new Promise<boolean>((resolveOpen) => {
        if (!port) {
          resolveOpen(false);
          return;
        }
        let done = false;
        const ackTimer = setTimeout(() => settle(false), timeoutMs);
        function settle(accepted: boolean): void {
          if (done) return;
          done = true;
          clearTimeout(ackTimer);
          openWaiters.delete(slot);
          resolveOpen(accepted);
        }
        openWaiters.set(slot, settle);
        const message: Record<string, unknown> = { type: "exulu:panel:open", v: CHANNEL_V, slot };
        if (opts?.prompt !== undefined) message.prompt = opts.prompt;
        if (opts?.items !== undefined) message.items = opts.items;
        if (opts?.files !== undefined) message.files = opts.files;
        port.postMessage(message);
      });
    };

    const onWindowMessage = (e: MessageLike): void => {
      if (e.data?.type !== "exulu:identity:channel" || e.data?.v !== IDENTITY_V) return;
      const p = e.ports?.[0];
      if (!p) return;
      port = p;
      p.onmessage = onPortMessage;
      p.start?.();

      // From here on the initial grant/denial answers through the same
      // dispatcher as everything else this channel ever carries.
      // `pendingIdentity` is what resolves (or rejects) THIS connectImp()
      // call specifically; refresh() below replaces it with its own resolver
      // once this one has fired.
      pendingIdentity = (result) => {
        if (settled) return;
        settled = true;
        stopHandshake();
        if (result.ok) {
          resolve({ grant: result.grant, host, refresh, onViewport, onProgress, openPanel });
        } else {
          reject(new Error(`Identity denied: ${result.reason}`));
        }
      };
    };

    // Listener first, then ask — and keep asking until answered. Both carry
    // comments in the v1 client explaining why, and neither changes here:
    // the parent answers at most one request per frame load, so a reply
    // arriving before this listener exists is lost for good; and the parent's
    // own listener is registered in a client effect that does not exist
    // until its bundle has hydrated, while this iframe runs as soon as the
    // parent's HTML is parsed — asking once therefore loses the request in
    // the ordinary case, not a rare one. Re-asking costs nothing once
    // answered: the parent ignores every request after the first it answers,
    // and the interval is cleared the instant this settles.
    win.addEventListener("message", onWindowMessage);
    const ask = (): void => win.parent.postMessage({ type: "exulu:identity:request", v: IDENTITY_V }, "*");
    ask();
    retry = setInterval(() => {
      if (settled) {
        if (retry !== undefined) clearInterval(retry);
        return;
      }
      ask();
    }, HANDSHAKE_RETRY_MS);
  });
}
