import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import type { ChannelTransport } from "./chat-instance";
import { safeError } from "./log";
import type { AgentChannelRow } from "./types";

export interface ChannelWebhookDeps {
  /** channels && queues */
  entitled(): boolean;
  rateLimitExceeded(): boolean;
  redisAvailable(): Promise<boolean>;
  loadChannel(id: string): Promise<AgentChannelRow | undefined>;
  transportFor(row: AgentChannelRow): Promise<ChannelTransport | null>;
  /**
   * Called after the SDK's response has been written; must not block (the wiring starts
   * the throttled chat state purge and does not wait for it).
   */
  purgeChatState?(): void;
}

/** Upper bound for the SDK's background work (decide + enqueue) before Meta gets its answer. */
export const WEBHOOK_BACKGROUND_WAIT_MS = 8000;

const LOG_PREFIX = "[EXULU-CHANNEL]";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same fixed-window shape as routineWebhookRateLimitExceeded, with its own counter so the
// two public webhooks cannot starve each other.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 300;
let rateWindowStart = 0;
let rateWindowCount = 0;
export const channelWebhookRateLimitExceeded = (now: number = Date.now()): boolean => {
  if (now - rateWindowStart >= RATE_WINDOW_MS) {
    rateWindowStart = now;
    rateWindowCount = 0;
  }
  rateWindowCount += 1;
  return rateWindowCount > RATE_MAX_REQUESTS;
};

/**
 * Builds the Web `Request` the SDK expects. The body is the raw bytes captured by the
 * route's `express.raw`, untouched: the signature is computed over them. The host part of
 * the URL is fixed; only the path and query are taken from the request.
 */
export const toWebRequest = (req: ExpressRequest, rawBody: Buffer): Request => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, String(v));
  }
  const method = (req.method ?? "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(`http://localhost${req.originalUrl ?? "/"}`, {
    method,
    headers,
    body: hasBody ? new Uint8Array(rawBody) : undefined,
  });
};

/** Waits for the tasks, at most `ms`; the timer is always cleared. */
const settleWithin = async (tasks: Promise<unknown>[], ms: number): Promise<PromiseSettledResult<unknown>[] | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(tasks),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const writeResponse = async (res: ExpressResponse, response: Response): Promise<void> => {
  const body = Buffer.from(await response.arrayBuffer());
  res.status(response.status);
  response.headers.forEach((value, name) => {
    // express sets its own length for the buffer it sends
    if (name.toLowerCase() !== "content-length") res.setHeader(name, value);
  });
  res.send(body);
};

/**
 * `GET`/`POST /webhooks/whatsapp/:channelId`. Checks in order: rate limit (429),
 * entitlement (503), channel id shape and channel (404, one body for every reason),
 * Redis (503), credentials (503); then the SDK answers. Nothing here reveals whether a
 * channel exists, and no log line carries the body, the message, a token or a secret.
 */
export const createChannelWebhookHandler =
  (deps: ChannelWebhookDeps) =>
  async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    if (deps.rateLimitExceeded()) {
      res.status(429).json({ detail: "Too many requests." });
      return;
    }
    if (!deps.entitled()) {
      res.status(503).json({ detail: "Channels are not available." });
      return;
    }

    const channelId = String((req.params as Record<string, unknown> | undefined)?.channelId ?? "");
    if (!UUID.test(channelId)) {
      res.status(404).json({ detail: "not found" });
      return;
    }

    let row: AgentChannelRow | undefined;
    try {
      row = await deps.loadChannel(channelId);
    } catch (error) {
      console.error(`${LOG_PREFIX} webhook channel lookup failed`, safeError(error));
      res.status(503).json({ detail: "temporarily unavailable" });
      return;
    }
    if (!row || !row.enabled || row.type !== "whatsapp") {
      res.status(404).json({ detail: "not found" });
      return;
    }

    let transport: ChannelTransport | null;
    try {
      if (!(await deps.redisAvailable())) {
        res.status(503).json({ detail: "temporarily unavailable" });
        return;
      }
      transport = await deps.transportFor(row);
    } catch (error) {
      console.error(`${LOG_PREFIX} webhook setup failed on channel ${channelId}`, safeError(error));
      res.status(503).json({ detail: "temporarily unavailable" });
      return;
    }
    if (!transport) {
      console.error(`${LOG_PREFIX} channel ${channelId} has no usable credentials`);
      res.status(503).json({ detail: "temporarily unavailable" });
      return;
    }

    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const tasks: Promise<unknown>[] = [];
      const response = await transport.handleWebhook(toWebRequest(req, rawBody), {
        waitUntil: (task) => {
          tasks.push(task);
        },
      });
      // The SDK answers before the message handler ran; a 200 to Meta should mean
      // "decided and, if applicable, enqueued".
      if (tasks.length > 0) {
        const settled = await settleWithin(tasks, WEBHOOK_BACKGROUND_WAIT_MS);
        if (settled === null) {
          console.warn(`${LOG_PREFIX} channel ${channelId} answered before its message handling finished`);
        } else if (settled.some((s) => s.status === "rejected")) {
          console.error(`${LOG_PREFIX} message handling failed on channel ${channelId}`);
        }
      }
      await writeResponse(res, response);
    } catch (error) {
      console.error(`${LOG_PREFIX} webhook handling failed on channel ${channelId}`, safeError(error));
      if (!res.headersSent) res.status(500).json({ detail: "internal error" });
      return;
    }

    try {
      deps.purgeChatState?.();
    } catch (error) {
      console.error(`${LOG_PREFIX} chat state purge could not be started`, safeError(error));
    }
  };
