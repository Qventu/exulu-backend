import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  HERMES_HOST,
  getIdleTimeoutMs,
  getMaxGateways,
  getPortRange,
  getProfileDir,
  isHermesEnabled,
  resolveHermesBin,
} from "./config";

/**
 * Supervises a *pool* of Hermes gateway processes — one per active profile.
 *
 * Unlike the LiteLLM supervisor (a single long-lived child), Hermes runs one
 * `hermes gateway` process per profile, each on its own port, because Hermes
 * has no built-in multi-profile router. This module owns the runtime concerns:
 * lazy spawn on first use, a bounded port pool, health polling, crash respawn
 * with backoff, and idle eviction (LRU) so we don't accumulate processes for
 * agents that have gone quiet.
 *
 * Separation of concerns: the *provisioner* writes a profile's durable identity
 * (config.yaml, SOUL.md, skills). This supervisor injects the runtime API-server
 * params (port, key, host) via the child's environment so port allocation stays
 * entirely owned here and a profile dir is portable across ports/restarts.
 *
 * Design doc: docs/superpowers/specs/2026-06-03-hermes-agent-mode-design.md
 */

export type GatewayState =
  | "starting"
  | "ready"
  | "respawning"
  | "stopped"
  | "given_up";

export type GatewayHandle = {
  /** Base URL for the OpenAI-compatible / runs API, e.g. http://127.0.0.1:8651/v1 */
  baseUrl: string;
  /** Bearer token the run-stream adapter must send (Authorization: Bearer …). */
  apiKey: string;
};

type GatewayInstance = {
  profileId: string;
  profileDir: string;
  port: number;
  apiKey: string;
  child: ChildProcess | undefined;
  state: GatewayState;
  crashCount: number;
  backoffMs: number;
  lastUsedAt: number;
  /**
   * Resolves to a ready handle once the gateway passes its health check.
   * Stored synchronously before any await so concurrent ensureGateway() calls
   * for the same profile share one spawn (single-flight).
   */
  readyPromise: Promise<GatewayHandle>;
  stopRequested: boolean;
};

const MAX_CRASHES = 5;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 200;
const SHUTDOWN_GRACE_MS = 5_000;
const SWEEP_INTERVAL_MS = 60_000;

const gateways = new Map<string, GatewayInstance>();
let sweeper: NodeJS.Timeout | undefined;
let shutdownHandlersRegistered = false;

const log = (line: string) => console.log(`[EXULU-HERMES] ${line}`);

const generateApiKey = (): string => randomBytes(24).toString("hex");

/** Ports currently claimed by live (non-stopped) gateways. */
const usedPorts = (): Set<number> => {
  const set = new Set<number>();
  for (const g of gateways.values()) {
    if (g.state !== "stopped") set.add(g.port);
  }
  return set;
};

/**
 * Allocate a free port from the configured range, evicting the
 * least-recently-used idle gateway if the pool is already at its cap.
 * Throws only when every port is in use AND nothing can be evicted (all
 * gateways are mid-flight / equally fresh) — callers surface that as a clear
 * "capacity" error rather than crashing.
 */
const allocatePort = async (): Promise<number> => {
  const { start, end } = getPortRange();
  const max = getMaxGateways();

  const liveCount = [...gateways.values()].filter(
    (g) => g.state !== "stopped",
  ).length;

  // Enforce the LRU cap first so we never exceed HERMES_MAX_GATEWAYS even if
  // the port range is wider than the cap.
  if (liveCount >= max) {
    const victim = pickLruVictim();
    if (!victim) {
      throw new Error(
        `Hermes gateway pool is full (${liveCount}/${max}) and no gateway is idle enough to evict. ` +
          `Increase HERMES_MAX_GATEWAYS / HERMES_PORT_RANGE or retry shortly.`,
      );
    }
    await stopGateway(victim.profileId);
  }

  const taken = usedPorts();
  for (let p = start; p <= end; p++) {
    if (!taken.has(p)) return p;
  }

  // Range exhausted but cap not hit — evict LRU and reuse its port.
  const victim = pickLruVictim();
  if (victim) {
    const port = victim.port;
    await stopGateway(victim.profileId);
    return port;
  }
  throw new Error(
    `Hermes port range ${start}-${end} is exhausted and no gateway can be evicted.`,
  );
};

/** Least-recently-used live gateway, or undefined if none exist. */
const pickLruVictim = (): GatewayInstance | undefined => {
  let victim: GatewayInstance | undefined;
  for (const g of gateways.values()) {
    if (g.state === "stopped") continue;
    if (!victim || g.lastUsedAt < victim.lastUsedAt) victim = g;
  }
  return victim;
};

const pollHealth = async (port: number): Promise<void> => {
  const url = `http://${HERMES_HOST}:${port}/health`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Hermes gateway did not become ready at ${url} within ${READY_TIMEOUT_MS}ms`,
  );
};

const spawnChild = (instance: GatewayInstance): ChildProcess => {
  const bin = resolveHermesBin() ?? "hermes";
  log(
    `Spawning gateway for profile "${instance.profileId}" on port ${instance.port} (${bin} gateway)`,
  );

  // Inject the API-server runtime params via the child env so the supervisor
  // owns port/key allocation. These override anything in the profile's .env.
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    HERMES_HOME: instance.profileDir,
    API_SERVER_ENABLED: "true",
    API_SERVER_HOST: HERMES_HOST,
    API_SERVER_PORT: String(instance.port),
    API_SERVER_KEY: instance.apiKey,
  };

  const child = spawn(bin, ["gateway"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });

  const tag = `[${instance.profileId}]`;
  child.stdout?.on("data", (chunk: Buffer) => {
    chunk
      .toString()
      .split("\n")
      .filter((l) => l.length > 0)
      .forEach((l) => log(`${tag} ${l}`));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    chunk
      .toString()
      .split("\n")
      .filter((l) => l.length > 0)
      .forEach((l) => log(`${tag} stderr: ${l}`));
  });

  child.on("exit", (code) => {
    if (instance.stopRequested || instance.state === "stopped") return;
    instance.crashCount += 1;
    instance.child = undefined;
    if (instance.crashCount >= MAX_CRASHES) {
      log(
        `${tag} gateway keeps crashing (${instance.crashCount}/${MAX_CRASHES}); giving up. ` +
          `Fix the profile config and retry.`,
      );
      instance.state = "given_up";
      return;
    }
    instance.state = "respawning";
    log(
      `${tag} gateway exited (code=${code}). Crash ${instance.crashCount}/${MAX_CRASHES}. ` +
        `Respawning in ${instance.backoffMs}ms.`,
    );
    setTimeout(() => {
      if (instance.stopRequested) return;
      instance.child = spawnChild(instance);
      instance.backoffMs = Math.min(instance.backoffMs * 2, MAX_BACKOFF_MS);
    }, instance.backoffMs).unref();
  });

  return child;
};

/**
 * Ensure a ready gateway exists for `profileId` and return its base URL + key.
 *
 * The profile dir must already be provisioned (config.yaml etc.) — call the
 * provisioner before this. Idempotent and single-flight: concurrent calls for
 * the same profile share one spawn; an already-ready gateway is reused and its
 * idle clock reset.
 */
export const ensureGateway = async (
  profileId: string,
): Promise<GatewayHandle> => {
  if (!isHermesEnabled()) {
    throw new Error("ensureGateway called but ENABLE_HERMES_AGENT is not 'true'.");
  }

  const existing = gateways.get(profileId);
  if (existing && existing.state !== "stopped" && existing.state !== "given_up") {
    existing.lastUsedAt = Date.now();
    return existing.readyPromise;
  }

  const profileDir = getProfileDir(profileId);
  if (!existsSync(profileDir)) {
    throw new Error(
      `Hermes profile dir not found at ${profileDir}. Provision the profile before starting its gateway.`,
    );
  }

  const port = await allocatePort();
  const apiKey = generateApiKey();
  const baseUrl = `http://${HERMES_HOST}:${port}/v1`;

  const instance: GatewayInstance = {
    profileId,
    profileDir,
    port,
    apiKey,
    child: undefined,
    state: "starting",
    crashCount: 0,
    backoffMs: INITIAL_BACKOFF_MS,
    lastUsedAt: Date.now(),
    stopRequested: false,
    // placeholder; reassigned synchronously below
    readyPromise: Promise.resolve({ baseUrl, apiKey }),
  };

  instance.readyPromise = (async () => {
    instance.child = spawnChild(instance);
    await pollHealth(port);
    instance.state = "ready";
    instance.crashCount = 0;
    instance.backoffMs = INITIAL_BACKOFF_MS;
    instance.lastUsedAt = Date.now();
    log(`Gateway for "${profileId}" is ready at ${baseUrl}`);
    return { baseUrl, apiKey };
  })();

  gateways.set(profileId, instance);
  ensureSweeper();
  registerShutdownHandlers();

  try {
    return await instance.readyPromise;
  } catch (err) {
    // Spawn/health failed — tear down so the next call retries cleanly.
    await stopGateway(profileId);
    throw err;
  }
};

/** Stop and remove a single gateway. Safe to call repeatedly. */
export const stopGateway = async (profileId: string): Promise<void> => {
  const instance = gateways.get(profileId);
  if (!instance) return;
  instance.stopRequested = true;
  instance.state = "stopped";
  const child = instance.child;
  gateways.delete(profileId);
  if (!child) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // already dead
  }
  setTimeout(() => {
    try {
      if (!child.killed && child.exitCode === null) child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, SHUTDOWN_GRACE_MS).unref();
};

/** Periodic sweep that evicts gateways idle longer than the configured timeout. */
const ensureSweeper = () => {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const idleMs = getIdleTimeoutMs();
    const now = Date.now();
    for (const [profileId, g] of gateways) {
      if (g.state === "ready" && now - g.lastUsedAt > idleMs) {
        log(`Evicting idle gateway "${profileId}" (idle ${Math.round((now - g.lastUsedAt) / 1000)}s)`);
        void stopGateway(profileId);
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();
};

const stopAll = () => {
  for (const profileId of [...gateways.keys()]) void stopGateway(profileId);
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
};

const registerShutdownHandlers = () => {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;
  process.on("SIGINT", stopAll);
  process.on("SIGTERM", stopAll);
  process.on("exit", stopAll);
};

/** Snapshot of pool state for tests / debug endpoints. */
export const getGatewayPoolStatus = () =>
  [...gateways.values()].map((g) => ({
    profileId: g.profileId,
    port: g.port,
    state: g.state,
    lastUsedAt: g.lastUsedAt,
    crashCount: g.crashCount,
  }));

/** Test-only: tear down all gateways and reset module state. */
export const __resetGatewaysForTesting = () => {
  stopAll();
  gateways.clear();
  shutdownHandlersRegistered = false;
};
