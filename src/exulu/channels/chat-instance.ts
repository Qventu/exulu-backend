import type { Pool } from "pg";
import type { Chat, Logger, Message, Thread } from "chat";
import type { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import type { createPostgresState } from "@chat-adapter/state-pg";
import { parseChannelConfig, readSecrets } from "./config";
import type { InboundMessage } from "./decide";
import type { AgentChannelRow } from "./types";

/**
 * The only file that talks to the Chat SDK. Type-only imports above are erased at
 * runtime; the packages are ESM only and jest runs our sources as CommonJS, so the
 * runtime modules are loaded with `await import()` in `loadSdk` (or a test stub).
 */
export interface SdkModules {
  Chat: typeof Chat;
  createWhatsAppAdapter: typeof createWhatsAppAdapter;
  createPostgresState: typeof createPostgresState;
}

export interface WebhookOptions {
  /** Receives the background handling task; the caller awaits it before responding. */
  waitUntil?(task: Promise<unknown>): void;
}

export interface ChannelTransport {
  handleWebhook(request: Request, options?: WebhookOptions): Promise<Response>;
  post(threadId: string, markdown: string): Promise<void>;
  typing(threadId: string): Promise<void>;
  markRead(threadId: string, messageId: string): Promise<void>;
}

export interface TransportDeps {
  pgPool: Pool;
  /** server passes decide+act; worker passes a no-op */
  onMessage(msg: InboundMessage): Promise<void>;
  /** test seam; default dynamically imports the three packages */
  load?: () => Promise<SdkModules>;
}

const USER_NAME = "exulu-agent";
const KEY_PREFIX = "exulu-channel";
const LOG_PREFIX = "[EXULU-CHANNEL]";

const loadSdk = async (): Promise<SdkModules> => {
  const [chat, whatsapp, statePg] = await Promise.all([
    import("chat"),
    import("@chat-adapter/whatsapp"),
    import("@chat-adapter/state-pg"),
  ]);
  return {
    Chat: chat.Chat,
    createWhatsAppAdapter: whatsapp.createWhatsAppAdapter,
    createPostgresState: statePg.createPostgresState,
  };
};

// The SDK logs webhook bodies (message text, phone numbers) at debug level and Graph
// error bodies on failure. Debug is dropped; body-like fields are redacted.
const REDACTED_KEYS = new Set(["body", "bodyPreview", "text"]);
const redact = (arg: unknown): unknown => {
  if (arg === null || typeof arg !== "object" || arg instanceof Error || Array.isArray(arg)) {
    return arg;
  }
  return Object.fromEntries(
    Object.entries(arg as Record<string, unknown>).map(([k, v]) => [k, REDACTED_KEYS.has(k) ? "[redacted]" : v]),
  );
};
const sdkLogger = (prefix: string): Logger => ({
  child: (p) => sdkLogger(`${prefix}:${p}`),
  debug: () => {},
  info: (m, ...args) => console.info(`${LOG_PREFIX} ${prefix}`, m, ...args.map(redact)),
  warn: (m, ...args) => console.warn(`${LOG_PREFIX} ${prefix}`, m, ...args.map(redact)),
  error: (m, ...args) => console.error(`${LOG_PREFIX} ${prefix}`, m, ...args.map(redact)),
});

export const toInboundMessage = (
  channelId: string,
  threadId: string,
  message: { id: string; text: string; attachments: unknown[] },
): InboundMessage => ({
  channelId,
  threadId,
  // whatsapp:<phoneNumberId>:<identity>; the identity is opaque
  identity: threadId.split(":").slice(2).join(":"),
  messageId: message.id,
  text: message.text,
  hasAttachments: message.attachments.length > 0,
});

interface CacheEntry {
  updatedAt: number;
  promise: Promise<Built>;
}
interface Built {
  transport: ChannelTransport;
  shutdown(): Promise<void>;
}

/** The instance in use per channel id; only successfully built instances land here. */
const cache = new Map<string, CacheEntry>();
/** A build in progress per channel id, shared by concurrent callers. */
const pending = new Map<string, CacheEntry>();

export const resetTransports = (): void => {
  cache.clear();
  pending.clear();
};

const timeOf = (value: string | Date): number => new Date(value).getTime();

/**
 * Only a strictly newer row replaces an instance: a stale row (read before an edit, or
 * by another process at another moment) must not tear down the current one. An
 * unparseable incoming time is never newer; an unparseable cached time is replaced once.
 */
const isNewer = (incoming: number, cached: number): boolean =>
  !Number.isNaN(incoming) && (Number.isNaN(cached) || incoming > cached);

const shutDown = (channelId: string, entry: CacheEntry): void => {
  entry.promise
    .then((built) => built.shutdown())
    .catch((error) => console.error(`${LOG_PREFIX} shutting down the chat instance of channel ${channelId} failed`, error));
};

interface Settings {
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
}

/** null for a badly configured row; never throws for one. */
const settingsOf = (row: AgentChannelRow): Settings | null => {
  const secrets = readSecrets(row);
  if (!secrets || !row.verify_token) {
    return null;
  }
  let phoneNumberId: string;
  try {
    phoneNumberId = parseChannelConfig(row.config).phoneNumberId;
  } catch {
    return null;
  }
  return { phoneNumberId, ...secrets, verifyToken: row.verify_token };
};

const build = async (channelId: string, settings: Settings, deps: TransportDeps): Promise<Built> => {
  const sdk = await (deps.load ?? loadSdk)();
  const logger = sdkLogger(`channel ${channelId}`);
  const adapter = sdk.createWhatsAppAdapter({
    accessToken: settings.accessToken,
    appSecret: settings.appSecret,
    phoneNumberId: settings.phoneNumberId,
    verifyToken: settings.verifyToken,
    userName: USER_NAME,
    logger: logger.child("whatsapp"),
  });
  const state = sdk.createPostgresState({
    client: deps.pgPool,
    keyPrefix: KEY_PREFIX,
    autoCreateSchema: false,
    logger: logger.child("state"),
  });
  const chat = new sdk.Chat({
    userName: USER_NAME,
    adapters: { whatsapp: adapter },
    state,
    // our own run lock decides; the SDK must not hold or drop messages
    concurrency: "concurrent",
    logger,
  });

  // Meta delivers every number of an app to the same callback, signed with the same app
  // secret, and the adapter takes the thread's number from the payload without checking it.
  const ownThreadPrefix = `whatsapp:${settings.phoneNumberId}:`;

  chat.onDirectMessage(async (thread: Thread, message: Message) => {
    // The SDK already skips the bot's own messages; this keeps that true here.
    if (message.author?.isMe) {
      return;
    }
    if (!thread.id.startsWith(ownThreadPrefix)) {
      console.warn(`${LOG_PREFIX} channel ${channelId} ignored a message for another phone number`);
      return;
    }
    try {
      await deps.onMessage(toInboundMessage(channelId, thread.id, message));
    } catch (error) {
      // channel id only: the message text and the sender stay out of the log
      console.error(`${LOG_PREFIX} handling a message on channel ${channelId} failed`, error);
    }
  });

  // Outside a webhook the adapter has no chat reference (no state, no typing target)
  // until initialized; initialize() is idempotent.
  const ready = () => chat.initialize();

  const transport: ChannelTransport = {
    handleWebhook: (request, options) => chat.webhooks.whatsapp(request, options),
    post: async (threadId, markdown) => {
      if (markdown.trim() === "") {
        throw new Error("refusing to post an empty message");
      }
      await ready();
      // the adapter splits at WhatsApp's 4096-character limit itself
      await adapter.postMessage(threadId, { markdown });
    },
    typing: async (threadId) => {
      await ready();
      await adapter.startTyping(threadId);
    },
    markRead: async (threadId, messageId) => {
      await ready();
      await adapter.markAsRead(threadId, messageId);
    },
  };
  return { transport, shutdown: () => chat.shutdown() };
};

const startBuild = (channelId: string, updatedAt: number, settings: Settings, deps: TransportDeps): CacheEntry => {
  const entry: CacheEntry = { updatedAt, promise: build(channelId, settings, deps) };
  pending.set(channelId, entry);
  // Install only after success, so a failed build leaves the current instance usable.
  entry.promise.then(
    () => {
      if (pending.get(channelId) === entry) {
        pending.delete(channelId);
      }
      const current = cache.get(channelId);
      if (current && !isNewer(updatedAt, current.updatedAt)) {
        // a newer instance was installed meanwhile; this one is not used
        shutDown(channelId, entry);
        return;
      }
      cache.set(channelId, entry);
      if (current) {
        shutDown(channelId, current);
      }
    },
    () => {
      if (pending.get(channelId) === entry) {
        pending.delete(channelId);
      }
    },
  );
  return entry;
};

export const getTransport = async (row: AgentChannelRow, deps: TransportDeps): Promise<ChannelTransport | null> => {
  const settings = settingsOf(row);
  const updatedAt = timeOf(row.updatedAt);
  const current = cache.get(row.id);
  if (!settings) {
    if (current && isNewer(updatedAt, current.updatedAt)) {
      cache.delete(row.id);
      shutDown(row.id, current);
    }
    return null;
  }
  if (current && !isNewer(updatedAt, current.updatedAt)) {
    return (await current.promise).transport;
  }
  const inFlight = pending.get(row.id);
  const entry =
    inFlight && !isNewer(updatedAt, inFlight.updatedAt) ? inFlight : startBuild(row.id, updatedAt, settings, deps);
  const built = await entry.promise;
  // a newer instance may have been installed while this build ran
  const installed = cache.get(row.id);
  return installed && installed !== entry && !isNewer(entry.updatedAt, installed.updatedAt)
    ? (await installed.promise).transport
    : built.transport;
};
