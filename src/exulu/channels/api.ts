import { randomBytes } from "crypto";
import type { Express, Request, Response } from "express";
import type { Knex } from "knex";
import type { User } from "@EXULU_TYPES/models/user";
import { checkLicense } from "@EE/entitlements.ts";
import { channelAccessAllowed, type GuestAgent } from "./access";
import { createChannelAuditor } from "./audit";
import {
  ChannelConfigError,
  canEnableChannel,
  channelView,
  maskIdentity,
  parseChannelConfig,
  readSecrets,
  sealSecrets,
} from "./config";
import { CODE_TTL_SECONDS, issueCode, type KeyValueStore } from "./link-codes";
import { createLinkStore, linkState } from "./links";
import { safeError } from "./log";
import type { AgentChannelRow, ChannelSecrets, ChannelView, WhatsAppChannelConfig } from "./types";

/**
 * HTTP API for the agent editor (admin) and the customer's link page (spec §5.5, §6).
 * Every response is built from `apiChannelView` plus explicitly listed fields: the access
 * token, app secret and sealed `secrets` never leave, and `verify_token` leaves exactly once,
 * in the PUT that creates the row. Nothing here logs a body, a secret, an identity or a code.
 */

export const GRAPH_HOST = "https://graph.facebook.com";
export const GRAPH_VERSION = "v25.0";
export const TEST_TIMEOUT_MS = 10_000;
export const CODE_ISSUE_LIMIT = 5;
export const CODE_ISSUE_WINDOW_SECONDS = 600;

const TYPE = "whatsapp" as const;
const TABLE = "agent_channels";
const LOG = "[EXULU-CHANNEL]";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE_NUMBER_ID_RE = /^\d{1,32}$/;
const PUT_KEYS = new Set(["enabled", "config", "secrets"]);
const SECRET_KEYS = ["accessToken", "appSecret"] as const;
const NOT_FOUND = { detail: "Not found." };

/** The agent fields the API reads: access (RBAC) and the guest gate. */
export type ChannelApiAgent = GuestAgent & {
  id: string;
  created_by?: unknown;
  RBAC?: unknown;
};

export interface ChannelApiDeps {
  authenticate(req: Request): Promise<{ error?: boolean; code?: number; message?: string; user?: User }>;
  getDb(): Promise<Knex>;
  /** The Redis slice for link codes; null when Redis is not available. */
  getStore(): Promise<KeyValueStore | null>;
  loadAgent(id: string): Promise<ChannelApiAgent | undefined>;
  checkRecordAccess(record: unknown, request: "write", user: User): Promise<boolean>;
  /** channels && queues */
  entitled(): boolean;
  fetch?: typeof fetch;
  now?(): Date;
  /** defaults to process.env.BACKEND */
  backendUrl?(): string | undefined;
}

/** ChannelView plus whether the stored config is unusable. Never add secret material. */
export type ApiChannelView = ChannelView & { configInvalid: boolean };

const EMPTY_CONFIG: WhatsAppChannelConfig = {
  phoneNumberId: "",
  displayNumber: "",
  linkTtlDays: 7,
  sessionIdleHours: 8,
  locale: "de",
  texts: {},
};

/**
 * channelView, except that a row whose stored config does not parse is returned as
 * unusable (`configInvalid`, empty config) instead of failing the request: the editor must
 * still be able to load it in order to fix it.
 */
export const apiChannelView = (row: AgentChannelRow): ApiChannelView => {
  try {
    return { ...channelView(row), configInvalid: false };
  } catch (error) {
    if (!(error instanceof ChannelConfigError)) throw error;
    return {
      id: row.id,
      agent: row.agent,
      type: row.type,
      enabled: row.enabled,
      config: { ...EMPTY_CONFIG, texts: {} },
      hasSecrets: !!row.secrets,
      needsCredentials: readSecrets(row) === null,
      configInvalid: true,
    };
  }
};

const tryParseConfig = (raw: unknown): WhatsAppChannelConfig | null => {
  try {
    return parseChannelConfig(raw);
  } catch {
    return null;
  }
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export const buildWaUrl = (displayNumber: string, code: string): string | null => {
  const digits = displayNumber.replace(/\D/g, "");
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(code)}` : null;
};

const loadChannel = async (db: Knex, agentId: string): Promise<AgentChannelRow | undefined> =>
  db(TABLE).where({ agent: agentId, type: TYPE }).first();

// The auditor only uses its store to de-duplicate code_lockout, which these routes never send.
const NO_DEDUP = { set: async () => "OK" as string | null };
const auditFor = (channelId: string, agentId?: string) =>
  createChannelAuditor({ channelId, agentId, kv: NO_DEDUP });

/** Counts this issue; true from the 6th code within 600 s of the first, per user. */
const codeIssueLimitExceeded = async (kv: KeyValueStore, userId: number): Promise<boolean> => {
  const key = `channel-link:issued:${userId}`;
  // set NX EX first, so the counter can never exist without its expiry
  await kv.set(key, "0", { EX: CODE_ISSUE_WINDOW_SECONDS, NX: true });
  return (await kv.incr(key)) > CODE_ISSUE_LIMIT;
};

// --- auto-disable and clean-up (called from the agent mutations) -------------------------

/**
 * The channel tables exist only with the `channels` licence (core-schema), so every helper
 * below is a no-op without it. Read at call time: the licence is an environment variable.
 */
const channelsLicensed = (): boolean => checkLicense()["channels"] === true;

/** Turns off every channel of this agent; bumps updatedAt so cached transports are dropped. */
export const disableChannelsForAgent = async (db: Knex, agentId: string, now: Date = new Date()): Promise<void> => {
  if (!channelsLicensed()) return;
  await db(TABLE).where({ agent: agentId, enabled: true }).update({ enabled: false, updatedAt: now });
};

/** After an agent write: disable its channels when the agent can no longer carry one. */
export const syncChannelsWithGuestAccess = async (
  db: Knex,
  agent: { id: string; guest_access?: boolean | null; guest_auth_mode?: string | null },
): Promise<void> => {
  if (!channelsLicensed() || !agent?.id) return;
  if (!canEnableChannel(agent).ok) await disableChannelsForAgent(db, agent.id);
};

/** There are no foreign keys on the channel tables: an agent's deletion removes them here. */
export const deleteChannelsForAgent = async (db: Knex, agentId: string): Promise<void> => {
  if (!channelsLicensed()) return;
  const rows: { id: string }[] = await db(TABLE).where({ agent: agentId }).select("id");
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) await db("channel_links").whereIn("channel", ids).del();
  await db(TABLE).where({ agent: agentId }).del();
};

const touchesGuestFields = (input: unknown): boolean =>
  isPlainObject(input) && ("guest_access" in input || "guest_auth_mode" in input);

/**
 * For the generic agent mutations, after an agent write. Never throws: the agent write has
 * already happened, and the inbound gate (channelAccessAllowed) refuses a channel whose agent
 * is no longer guest-accessible, so a failed clean-up is a logged inconsistency only.
 */
export const afterAgentWrite = async (db: Knex, agent: unknown, changedFields: unknown): Promise<void> => {
  if (!touchesGuestFields(changedFields) || !isPlainObject(agent) || typeof agent.id !== "string") return;
  if (!channelsLicensed()) return;
  try {
    await syncChannelsWithGuestAccess(db, agent as { id: string });
  } catch (error) {
    console.error(`${LOG} disabling the channels of agent ${agent.id} failed`, safeError(error));
  }
};

/** For the generic agent mutations, after an agent delete. Never throws (see afterAgentWrite). */
export const afterAgentDelete = async (db: Knex, agentId: unknown): Promise<void> => {
  if (typeof agentId !== "string" || agentId === "") return;
  if (!channelsLicensed()) return;
  try {
    await deleteChannelsForAgent(db, agentId);
  } catch (error) {
    console.error(`${LOG} removing the channels of agent ${agentId} failed`, safeError(error));
  }
};

// --- routes -------------------------------------------------------------------------------

type Handler = (req: Request, res: Response) => Promise<void>;

export const registerChannelApi = (app: Express, deps: ChannelApiDeps): void => {
  const now = () => (deps.now ? deps.now() : new Date());
  const doFetch = (...args: Parameters<typeof fetch>) => (deps.fetch ?? fetch)(...args);

  const route =
    (name: string, fn: Handler) =>
    async (req: Request, res: Response): Promise<void> => {
      res.setHeader("Cache-Control", "no-store");
      try {
        await fn(req, res);
      } catch (error) {
        console.error(`${LOG} api ${name} failed`, safeError(error));
        if (!res.headersSent) res.status(500).json({ detail: "Internal error." });
      }
    };

  const loadAgent = async (id: string): Promise<ChannelApiAgent | undefined> => {
    if (!UUID_RE.test(id)) return undefined;
    try {
      return (await deps.loadAgent(id)) ?? undefined;
    } catch {
      // exuluApp.agent throws for an unknown id
      return undefined;
    }
  };

  const signedIn = async (req: Request, res: Response): Promise<User | null> => {
    const auth = await deps.authenticate(req);
    if (!auth.user?.id) {
      res.status(auth.code || 401).json({ detail: auth.message || "Authentication required." });
      return null;
    }
    return auth.user;
  };

  /**
   * Admin gate, in this order: signed in (401), the agent exists (404, also for a
   * non-uuid id), write access on THAT agent (403). Write access is the agent editor's own
   * rule (the generic agent mutations' validateWriteAccess): super admin, or the role's
   * `agents: "write"` plus record-level write access via checkRecordAccess.
   */
  const adminAgent = async (req: Request, res: Response): Promise<{ user: User; agent: ChannelApiAgent } | null> => {
    const user = await signedIn(req, res);
    if (!user) return null;
    const agent = await loadAgent(String(req.params.agentId ?? ""));
    if (!agent) {
      res.status(404).json({ detail: "Agent not found." });
      return null;
    }
    const roleAllows = user.super_admin === true || user.role?.agents === "write";
    if (!roleAllows || !(await deps.checkRecordAccess(agent, "write", user))) {
      res.status(403).json({ detail: "You don't have write access to this agent." });
      return null;
    }
    return { user, agent };
  };

  const webhookUrl = (row: AgentChannelRow | undefined): string | null => {
    const base = (deps.backendUrl ? deps.backendUrl() : process.env.BACKEND)?.trim().replace(/\/+$/, "");
    return row && base ? `${base}/webhooks/whatsapp/${encodeURIComponent(row.id)}` : null;
  };

  const base = "/agents/:agentId/channels/whatsapp";

  app.get(
    base,
    route("get channel", async (req, res) => {
      const gate = await adminAgent(req, res);
      if (!gate) return;
      const row = await loadChannel(await deps.getDb(), gate.agent.id);
      res.json({
        channel: row ? apiChannelView(row) : null,
        webhookUrl: webhookUrl(row),
        canEnable: canEnableChannel(gate.agent),
      });
    }),
  );

  app.put(
    base,
    route("put channel", async (req, res) => {
      const gate = await adminAgent(req, res);
      if (!gate) return;
      const { agent } = gate;
      const body: unknown = req.body;
      const bad = (field: string, detail: string) => res.status(400).json({ detail, field });

      // 1. Shape. secrets is write-only and never echoed.
      if (!isPlainObject(body)) return void bad("body", "The body must be a JSON object.");
      for (const key of Object.keys(body)) {
        if (!PUT_KEYS.has(key)) return void bad(key, `Unknown field "${key}".`);
      }
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
        return void bad("enabled", "enabled must be a boolean.");
      }
      let config: WhatsAppChannelConfig | undefined;
      if (body.config !== undefined) {
        try {
          config = parseChannelConfig(body.config);
        } catch (error) {
          if (error instanceof ChannelConfigError) return void bad(error.field, error.message);
          throw error;
        }
      }
      const incoming: Partial<ChannelSecrets> = {};
      if (body.secrets !== undefined) {
        if (!isPlainObject(body.secrets)) return void bad("secrets", "secrets must be an object.");
        for (const key of Object.keys(body.secrets)) {
          if (!(SECRET_KEYS as readonly string[]).includes(key)) return void bad("secrets", "Unknown secret field.");
        }
        for (const key of SECRET_KEYS) {
          const value = body.secrets[key];
          if (value === undefined) continue;
          if (typeof value !== "string") return void bad(`secrets.${key}`, `${key} must be a string.`);
          // an empty string means "leave unchanged", never "clear"
          if (value !== "") incoming[key] = value;
        }
      }

      const db = await deps.getDb();
      const existing = await loadChannel(db, agent.id);

      // 2. Secrets merge: a partial update keeps the other stored secret; sealed secrets are
      // always complete, so one that would stay missing is rejected.
      let sealed: string | undefined;
      if (incoming.accessToken !== undefined || incoming.appSecret !== undefined) {
        const stored = existing ? readSecrets(existing) : null;
        const merged = {
          accessToken: incoming.accessToken ?? stored?.accessToken ?? "",
          appSecret: incoming.appSecret ?? stored?.appSecret ?? "",
        };
        for (const key of SECRET_KEYS) {
          if (merged[key] === "") return void bad(`secrets.${key}`, `${key} is required.`);
        }
        sealed = sealSecrets(merged);
      }

      // 3. Enabling, in this order: entitlements, the agent's guest mode, credentials, config.
      if (body.enabled === true) {
        const refuse = (reason: string, detail: string) => res.status(409).json({ detail, reason });
        if (!deps.entitled()) return void refuse("not_entitled", "The channels and queues entitlements are required.");
        const can = canEnableChannel(agent);
        if (!can.ok) {
          return void refuse(
            can.reason,
            can.reason === "guest_access_off"
              ? "Guest access must be on for this agent."
              : 'Guest access must be in "regular" (sign-in) mode.',
          );
        }
        const hasSecrets = sealed !== undefined || (existing ? readSecrets(existing) !== null : false);
        if (!hasSecrets) return void refuse("needs_credentials", "An access token and an app secret are required.");
        const effective = config ?? (existing ? tryParseConfig(existing.config) : null);
        if (!effective || effective.phoneNumberId.trim() === "") {
          return void refuse("invalid_config", "A valid configuration with a phone number ID is required.");
        }
      }

      // 4. Upsert on the unique (agent, type) index. The verify token is only ever part of
      // the INSERT, so an existing row keeps its own; every write bumps updatedAt.
      const changes: Record<string, unknown> = { updatedAt: now() };
      if (body.enabled !== undefined) changes.enabled = body.enabled;
      if (config) changes.config = JSON.stringify(config);
      if (sealed) changes.secrets = sealed;
      const verifyToken = randomBytes(24).toString("base64url");
      const [row] = (await db(TABLE)
        .insert({
          agent: agent.id,
          type: TYPE,
          enabled: false,
          config: null,
          secrets: null,
          ...changes,
          verify_token: verifyToken,
        })
        .onConflict(["agent", "type"])
        .merge(changes)
        .returning("*")) as [AgentChannelRow];
      // the row was created by this request exactly when it carries the token generated here
      const created = row.verify_token === verifyToken;
      res.json(created ? { channel: apiChannelView(row), verifyToken } : { channel: apiChannelView(row) });
    }),
  );

  app.post(
    `${base}/test`,
    route("test channel", async (req, res) => {
      const gate = await adminAgent(req, res);
      if (!gate) return;
      const row = await loadChannel(await deps.getDb(), gate.agent.id);
      if (!row) return void res.status(404).json({ detail: "Channel not found." });
      const result = (ok: boolean, detail: string) => res.json({ ok, detail });

      const secrets = readSecrets(row);
      if (!secrets) return void result(false, "No access token and app secret are stored.");
      const config = tryParseConfig(row.config);
      if (!config) return void result(false, "The channel configuration is incomplete.");
      if (!PHONE_NUMBER_ID_RE.test(config.phoneNumberId)) {
        return void result(false, "The phone number ID must contain digits only.");
      }

      const url = `${GRAPH_HOST}/${GRAPH_VERSION}/${config.phoneNumberId}?fields=display_phone_number,verified_name`;
      let response: globalThis.Response;
      try {
        response = await doFetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${secrets.accessToken}`, Accept: "application/json" },
          redirect: "manual",
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        });
      } catch (error) {
        console.warn(`${LOG} connection test on channel ${row.id} failed`, safeError(error));
        const name = (error as { name?: unknown } | null)?.name;
        return void result(
          false,
          name === "TimeoutError" || name === "AbortError"
            ? `Meta did not answer within ${TEST_TIMEOUT_MS / 1000} seconds.`
            : "Meta could not be reached.",
        );
      }

      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        return void result(false, "Meta answered with an unexpected redirect.");
      }
      let json: any = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      const clean = (v: unknown): string | null => {
        if (typeof v !== "string" || v.trim() === "") return null;
        if (v.includes(secrets.accessToken) || v.includes(secrets.appSecret)) return null;
        return v.slice(0, 300);
      };
      if (response.ok) {
        const name = clean(json?.verified_name);
        const number = clean(json?.display_phone_number);
        // a 2xx that is not Graph's answer for a phone number (not JSON, fields missing) is no proof
        if (!name || !number) return void result(false, "Meta answered, but not with the expected phone number details.");
        return void result(true, `Connected: ${name}, ${number}`);
      }
      result(false, clean(json?.error?.message) ?? `Meta answered with HTTP ${response.status}.`);
    }),
  );

  app.get(
    `${base}/links`,
    route("list links", async (req, res) => {
      const gate = await adminAgent(req, res);
      if (!gate) return;
      const db = await deps.getDb();
      const row = await loadChannel(db, gate.agent.id);
      if (!row) return void res.json({ links: [] });
      const at = now();
      const links = await createLinkStore(db).listForChannel(row.id);
      res.json({
        links: links.map((l) => ({
          id: l.id,
          identityMasked: maskIdentity(l.identity),
          userId: l.user,
          linked_at: l.linked_at,
          expires_at: l.expires_at,
          last_seen_at: l.last_seen_at,
          state: linkState(l, at).state,
        })),
      });
    }),
  );

  app.delete(
    `${base}/links/:linkId`,
    route("revoke link", async (req, res) => {
      const gate = await adminAgent(req, res);
      if (!gate) return;
      const notFound = () => res.status(404).json({ detail: "Link not found." });
      const linkId = String(req.params.linkId ?? "");
      if (!UUID_RE.test(linkId)) return void notFound();
      const db = await deps.getDb();
      const row = await loadChannel(db, gate.agent.id);
      if (!row) return void notFound();
      // the link must belong to THIS agent's channel
      const link = await db("channel_links").where({ id: linkId, channel: row.id }).first();
      if (!link) return void notFound();
      if (!link.revoked_at) {
        await createLinkStore(db).revoke(link.id, now());
        await auditFor(row.id, row.agent)({ type: "revoked", identity: link.identity, userId: link.user });
      }
      res.status(204).end();
    }),
  );

  // --- the signed-in customer's link page ---------------------------------------------

  /** The agent's usable channel for a customer, or null (one 404 body for every miss). */
  const customerChannel = async (
    req: Request,
    opts: { requireEnabled: boolean },
  ): Promise<{ db: Knex; agent: ChannelApiAgent; row: AgentChannelRow } | null> => {
    const agent = await loadAgent(String(req.params.id ?? ""));
    if (!agent) return null;
    const db = await deps.getDb();
    const row = await loadChannel(db, agent.id);
    if (!row) return null;
    if (opts.requireEnabled && !row.enabled) return null;
    return { db, agent, row };
  };

  app.post(
    "/public-agents/:id/channels/whatsapp/link-code",
    route("issue link code", async (req, res) => {
      const user = await signedIn(req, res);
      if (!user) return;
      if (!deps.entitled()) return void res.status(404).json(NOT_FOUND);
      const found = await customerChannel(req, { requireEnabled: true });
      const config = found ? tryParseConfig(found.row.config) : null;
      // canEnableChannel too: evaluateGuestChatAccess lets any signed-in user through whenever
      // guest_access is on, whatever the mode, so a channel left enabled on a public- or
      // password-mode agent (failed or raced auto-disable) must not issue codes
      if (!found || !config || !canEnableChannel(found.agent).ok) return void res.status(404).json(NOT_FOUND);
      const { db, agent, row } = found;

      // the same check the inbound gate and the worker run, so linking and messaging agree
      const allowed = await channelAccessAllowed({
        db,
        loadAgent: (id) => loadAgent(id),
        agentId: agent.id,
        channelId: row.id,
        userId: user.id,
      });
      if (!allowed) return void res.status(403).json({ detail: "You don't have access to this agent." });

      let store: KeyValueStore | null = null;
      try {
        store = await deps.getStore();
      } catch (error) {
        console.error(`${LOG} link code store unavailable on channel ${row.id}`, safeError(error));
      }
      const unavailable = () => res.status(503).json({ detail: "Linking is temporarily unavailable." });
      if (!store) return void unavailable();

      let code: string;
      try {
        if (await codeIssueLimitExceeded(store, user.id)) {
          return void res.status(429).json({ detail: "Too many requests. Try again later." });
        }
        code = await issueCode(store, { channelId: row.id, userId: user.id });
      } catch (error) {
        console.error(`${LOG} issuing a link code on channel ${row.id} failed`, safeError(error));
        return void unavailable();
      }

      const links = await createLinkStore(db).listForUser(row.id, user.id);
      res.json({
        code,
        expiresInSeconds: CODE_TTL_SECONDS,
        waUrl: buildWaUrl(config.displayNumber, code),
        // the caller's own links on this channel; unlinked (revoked) ones are gone for them
        links: links
          .filter((l) => !l.revoked_at)
          .map((l) => ({ id: l.id, identityMasked: maskIdentity(l.identity), expires_at: l.expires_at })),
      });
    }),
  );

  app.delete(
    "/public-agents/:id/channels/whatsapp/links/:linkId",
    route("unlink", async (req, res) => {
      const user = await signedIn(req, res);
      if (!user) return;
      const linkId = String(req.params.linkId ?? "");
      if (!UUID_RE.test(linkId)) return void res.status(404).json(NOT_FOUND);
      // unlinking stays possible while the channel is disabled
      const found = await customerChannel(req, { requireEnabled: false });
      if (!found) return void res.status(404).json(NOT_FOUND);
      const { db, row } = found;
      // only the caller's own link on THIS agent's channel
      const link = await db("channel_links").where({ id: linkId, channel: row.id, user: user.id }).first();
      if (!link) return void res.status(404).json(NOT_FOUND);
      if (!link.revoked_at) {
        await createLinkStore(db).revoke(link.id, now());
        await auditFor(row.id, row.agent)({ type: "unlinked", identity: link.identity, userId: link.user });
      }
      res.status(204).end();
    }),
  );
};
