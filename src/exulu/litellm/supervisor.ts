import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveLiteLLMTarget, isLiteLLMClientMode, setLiteLLMClientMode } from "./env";

// Where the LiteLLM admin UI is mounted on the Exulu server. Lives here (not
// in routes.ts, which also needs it) so this module keeps its zero-app-import
// graph — pulling routes.ts into a unit test loads the whole server.
export const LITELLM_UI_PATH = "/litellm-admin";
/**
 * Spawns the LiteLLM proxy as a child process when EXULU_USE_LITELLM=true,
 * supervises it (exponential-backoff respawn capped at 5 consecutive crashes),
 * exposes a memoized readiness promise consumers can await before issuing
 * requests, and shuts the child down cleanly on Exulu shutdown signals.
 *
 * The package root is passed in by the caller (ExuluApp boot path) so this
 * module stays free of import.meta.url, making it cleanly unit-testable.
 *
 * Design doc: docs/superpowers/specs/2026-05-23-litellm-proxy-integration-design.md
 */

export type SupervisorState =
  | "idle"
  | "starting"
  | "ready"
  | "respawning"
  | "stopped"
  | "given_up";

type SupervisorInternal = {
  child: ChildProcess | undefined;
  state: SupervisorState;
  crashCount: number;
  backoffMs: number;
  readyPromise: Promise<void> | undefined;
  shutdownRequested: boolean;
};

const MAX_CRASHES = 5;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
// Boot-time / per-spawn readiness budget. 90s accommodates cold-start
// environments (e.g. Cloud Run scale-to-zero) where the Python interpreter,
// LiteLLM imports, and Postgres connection through a Cloud SQL Auth Proxy
// sidecar all happen in series on a CPU-throttled container.
const READY_TIMEOUT_MS = 90_000;
// Runtime wait budget for callers of waitForLiteLLMReady(). Independent of
// the boot-time budget — by the time a request arrives, the supervisor has
// already been trying for a while, so this can be shorter.
const WAIT_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 200;
const SHUTDOWN_GRACE_MS = 5_000;

const internal: SupervisorInternal = {
  child: undefined,
  state: "idle",
  crashCount: 0,
  backoffMs: INITIAL_BACKOFF_MS,
  readyPromise: undefined,
  shutdownRequested: false,
};

/**
 * Whether LiteLLM mode is enabled via env var.
 */
export const isLiteLLMEnabled = (): boolean =>
  process.env.EXULU_USE_LITELLM === "true";

const resolveConfig = (packageRoot: string) => {
  const host = process.env.LITELLM_HOST ?? "127.0.0.1";
  const port = process.env.LITELLM_PORT ?? "4000";
  const masterKey = process.env.LITELLM_MASTER_KEY;
  // Default to the consumer's CWD, not packageRoot — when @exulu/backend is
  // consumed as an npm dependency, packageRoot lives under node_modules where
  // the operator can't reasonably drop a config file. CWD is the project root
  // they ran Exulu from. LITELLM_CONFIG_PATH still wins, and if relative it
  // resolves against CWD via node's fs APIs.
  const configPath =
    process.env.LITELLM_CONFIG_PATH ??
    resolve(process.cwd(), "./config.litellm.yaml");
  const venvBin = resolve(packageRoot, "ee/python/.venv/bin");
  const venvPython = resolve(venvBin, "python");
  const litellmBin = resolve(venvBin, "litellm");
  return { host, port, masterKey, configPath, venvBin, venvPython, litellmBin };
};

const log = (line: string) => console.log(`[EXULU-LITELLM] ${line}`);

/**
 * Poll http://host:port/health/liveliness until 200 OK or timeout.
 *
 * /health requires the master key in LiteLLM; /health/liveliness is the
 * unauthenticated liveness probe specifically intended for boot-time
 * supervisors and k8s probes. (The misspelling is LiteLLM's, not ours.)
 */
const pollHealth = async (host: string, port: string): Promise<void> => {
  const url = `http://${host}:${port}/health/liveliness`;
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
    `LiteLLM did not become ready at ${url} within ${READY_TIMEOUT_MS}ms`,
  );
};

const spawnLiteLLM = (cfg: ReturnType<typeof resolveConfig>): ChildProcess => {
  log(
    `Spawning LiteLLM: ${cfg.litellmBin} --config ${cfg.configPath} --port ${cfg.port} --host ${cfg.host}`,
  );

  // Neutralize env vars that conflict with LiteLLM's CLI flags. LiteLLM's
  // click-based CLI reads DEBUG as the value for its `--debug` boolean flag,
  // and any value other than 0/1/true/false/etc. crashes the process. Node's
  // `debug` package convention is DEBUG=<namespace-filter> (e.g.
  // "http-proxy-middleware*"), which is incompatible.
  //
  // Stripping DEBUG from the spawn env is not enough on its own: LiteLLM's
  // proxy_cli imports `dotenv` and calls `load_dotenv()` early in startup,
  // which loads any `.env` file from the working directory into os.environ
  // *after* we've handed env to the child. python-dotenv defaults to
  // override=False, so an explicit DEBUG already present in the child's env
  // wins over a value in `.env`. We therefore pin DEBUG="false" rather than
  // just deleting it — that way it survives whatever load_dotenv finds, and
  // click parses it as a valid boolean.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { DEBUG: _debug, ...rest } = process.env;
  const childEnv: Record<string, string | undefined> = {
    ...rest,
    DEBUG: "false",
  };

  // Tell LiteLLM to mount itself under the prefix Exulu reverse-proxies the
  // admin UI from, so its internal asset URLs, redirects, and SSO callbacks
  // all include the path.
  //
  // The env var is intentionally namespaced (not LITELLM_UI_PATH) because
  // LiteLLM itself reads LITELLM_UI_PATH and treats it as a filesystem path
  // to the UI directory — setting that to a URL path silently breaks the
  // UI mount inside LiteLLM.
  if (LITELLM_UI_PATH && !process.env.SERVER_ROOT_PATH) {
    childEnv.SERVER_ROOT_PATH = LITELLM_UI_PATH;
  }

  // SAFETY: Do NOT prepend the venv's bin directory to PATH for the child.
  // When LiteLLM has a `database_url` configured, it auto-shells out to
  // `prisma` for schema management on startup, and `prisma db push
  // --accept-data-loss` will drop any tables in the public schema that are
  // not in LiteLLM's Prisma schema. Pointing LiteLLM at a database shared
  // with another application (e.g. Exulu's own Postgres) would result in
  // silent, total data loss — without any operator confirmation, from a
  // background process. By keeping the venv off PATH the prisma CLI is
  // unreachable from the LiteLLM child, its schema-management probe fails
  // closed, and the operator must run `prisma db push` manually (ideally
  // against a database used *only* by LiteLLM).
  //
  // If a future change ever needs the venv's bin on PATH for some other
  // reason, that change MUST also (1) refuse to start when database_url is
  // configured and the target database contains non-LiteLLM_* tables, AND
  // (2) never invoke prisma operations with --accept-data-loss.

  const child = spawn(
    cfg.litellmBin,
    [
      "--config",
      cfg.configPath,
      "--port",
      cfg.port,
      "--host",
      cfg.host,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    },
  );

  child.stdout?.on("data", (chunk: Buffer) => {
    chunk
      .toString()
      .split("\n")
      .filter((l) => l.length > 0)
      .forEach((l) => log(l));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    chunk
      .toString()
      .split("\n")
      .filter((l) => l.length > 0)
      .forEach((l) => log(`stderr: ${l}`));
  });

  return child;
};

const supervise = async (cfg: ReturnType<typeof resolveConfig>) => {
  while (!internal.shutdownRequested && internal.crashCount < MAX_CRASHES) {
    internal.state = internal.crashCount === 0 ? "starting" : "respawning";
    internal.child = spawnLiteLLM(cfg);

    const exitPromise = new Promise<number | null>((resolveFn) => {
      internal.child!.on("exit", (code) => resolveFn(code));
    });

    try {
      // Wait for ready or for child to exit (whichever first).
      await Promise.race([
        pollHealth(cfg.host, cfg.port).then(() => "ready" as const),
        exitPromise.then((code) => ({ exited: code })),
      ]);
    } catch (err) {
      log(`Readiness probe failed: ${(err as Error).message}`);
      // kill the child if it's still alive; the exit handler will trigger respawn
      try {
        internal.child?.kill("SIGTERM");
      } catch {
        // already dead
      }
    }

    if (!internal.child?.killed && internal.child?.exitCode === null) {
      internal.state = "ready";
      internal.crashCount = 0;
      internal.backoffMs = INITIAL_BACKOFF_MS;
      log("LiteLLM is ready.");
    }

    // Wait for the child to exit (it stays running until shutdown or crash).
    const code = await exitPromise;
    internal.state = "respawning";
    internal.child = undefined;

    if (internal.shutdownRequested) {
      log("Child exited during shutdown; supervisor stopping.");
      internal.state = "stopped";
      return;
    }

    internal.crashCount += 1;
    log(
      `LiteLLM exited (code=${code}). Crash ${internal.crashCount}/${MAX_CRASHES}. ` +
        `Respawning in ${internal.backoffMs}ms.`,
    );
    if (internal.crashCount >= MAX_CRASHES) {
      log(
        "LiteLLM keeps crashing — fix the config and restart Exulu. " +
          "Giving up on respawn.",
      );
      internal.state = "given_up";
      return;
    }
    await new Promise((r) => setTimeout(r, internal.backoffMs));
    internal.backoffMs = Math.min(internal.backoffMs * 2, MAX_BACKOFF_MS);
  }
};

/**
 * Module-level package root. Set by the ExuluApp boot path before calling
 * startLiteLLMSupervisor(). Tests inject a fake path directly.
 */
let _packageRoot: string | undefined;

/**
 * Set the package root once at boot. The caller (ExuluApp) knows where
 * @exulu/backend is installed via its own discovery (python-setup.ts already
 * does this). Keeps this module free of import.meta.url so it's cleanly
 * unit-testable in jest's CommonJS environment.
 */
export const setLiteLLMPackageRoot = (root: string): void => {
  _packageRoot = root;
};

/**
 * Switch this process into LiteLLM *client* mode: it connects to an
 * externally-managed proxy (spawned by the Exulu HTTP server process, or a
 * standalone proxy) rather than spawning and supervising its own.
 *
 * This is the correct mode for worker processes. The supervisor's `internal`
 * state is per-process; a worker runs as a separate Node process from the
 * server and never goes through express.init() (where the supervisor is
 * started), so without this it would try to spawn its own proxy — colliding
 * with the server's on LITELLM_PORT — or, lacking a package root, fail with
 * "package root not set" even though a healthy proxy is already running.
 *
 * No-op if this process has already started its own supervisor (e.g. a
 * combined server+worker process): that process owns a proxy and keeps using
 * it. Idempotent. Readiness is resolved lazily by waitForLiteLLMReady() via a
 * health probe, so this never blocks boot and tolerates the proxy coming up
 * after the worker.
 */
export const enableLiteLLMClientMode = (): void => {
  if (internal.readyPromise) return;
  setLiteLLMClientMode(true);
};

/**
 * Start the LiteLLM supervisor. Idempotent — calling twice is a no-op (returns
 * the existing ready promise).
 *
 * Behavior:
 *   - EXULU_USE_LITELLM not set: returns early, no-op.
 *   - LITELLM_MASTER_KEY missing: throws synchronously.
 *   - Package root not set: throws (caller must invoke setLiteLLMPackageRoot first).
 *   - Config path missing: logs error, keeps Exulu running, returns. resolveModel
 *     will surface LITELLM_NOT_READY for every agent request until the operator
 *     fixes the config and restarts.
 *   - Python venv missing: logs error, returns.
 */
export const startLiteLLMSupervisor = async (
  options: { packageRoot?: string } = {},
): Promise<void> => {
  if (!isLiteLLMEnabled()) return;

  if (internal.readyPromise) {
    return internal.readyPromise;
  }

  // Validate the master key first (the most common misconfig) so the error
  // surfaces clearly even if the caller forgot to set the package root too.
  if (!process.env.LITELLM_MASTER_KEY) {
    throw new Error(
      "EXULU_USE_LITELLM is true but LITELLM_MASTER_KEY is not set. " +
        "Set LITELLM_MASTER_KEY to a strong secret and restart Exulu.",
    );
  }

  const packageRoot = options.packageRoot ?? _packageRoot;
  if (!packageRoot) {
    throw new Error(
      "LiteLLM supervisor: package root not set. Call setLiteLLMPackageRoot() " +
        "from the boot path before starting the supervisor.",
    );
  }
  const cfg = resolveConfig(packageRoot);

  if (!existsSync(cfg.configPath)) {
    log(
      `LiteLLM config not found at ${cfg.configPath}. ` +
        `Copy ee/python/.litellm/config.yaml.example to that path, edit it, ` +
        `and restart Exulu. LiteLLM will NOT be started until then.`,
    );
    internal.state = "given_up";
    return;
  }

  if (!existsSync(cfg.litellmBin)) {
    log(
      `LiteLLM binary not found at ${cfg.litellmBin}. The Python venv may not ` +
        `be set up. Run setupPythonEnvironment() from @exulu/backend, then restart.`,
    );
    internal.state = "given_up";
    return;
  }

  internal.readyPromise = (async () => {
    // Kick off the supervisor loop in the background and resolve as soon as the
    // first readiness check passes. If supervise() exits with given_up before
    // that, we surface a clear rejection.
    supervise(cfg);
    const deadline = Date.now() + READY_TIMEOUT_MS + 5_000;
    while (Date.now() < deadline) {
      if (internal.state === "ready") return;
      if (internal.state === "given_up") {
        throw new Error("LiteLLM supervisor gave up before becoming ready.");
      }
      await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
    }
    throw new Error("Timed out waiting for LiteLLM supervisor readiness.");
  })();

  registerShutdownHandlers();

  return internal.readyPromise;
};

/**
 * Await this from resolveModel() before issuing the first request.
 *
 * Reads `internal.state` directly rather than returning the cached boot-time
 * `readyPromise`. If the boot-time promise rejected because LiteLLM was slow
 * to come up on a cold start, the `supervise()` loop keeps respawning and
 * may bring LiteLLM healthy seconds later — observing current state lets
 * the instance self-heal instead of staying permanently broken until the
 * container is killed.
 */
export const waitForLiteLLMReady = async (): Promise<void> => {
  if (!isLiteLLMEnabled()) return;

  // Client mode: connect to an externally-managed proxy instead of supervising
  // one. Probe its health endpoint once and cache readiness. Self-healing: if
  // the proxy isn't up yet (e.g. a worker booted before the server), this
  // request fails fast and the next call re-probes — far better than hanging
  // for the full boot-time budget, and job-level retries cover the gap.
  if (isLiteLLMClientMode()) {
    if (internal.state === "ready") return;
    const { baseUrl, authHeaders, remote } = resolveLiteLLMTarget();
    const url = remote ? `${baseUrl}/v1/models` : `${baseUrl}/health/liveliness`;
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers: remote ? authHeaders : {} });
    } catch (err) {
      throw new Error(
        `LiteLLM proxy not reachable at ${url} (is the Exulu server process ` +
          `running?): ${(err as Error).message}`,
      );
    }
    if (!res.ok) {
      throw new Error(
        `LiteLLM proxy health probe at ${url} returned ${res.status}.`,
      );
    }
    internal.state = "ready";
    return;
  }

  if (!internal.readyPromise) {
    // Supervisor was never started — start it now. This covers test paths and
    // unusual boot sequences where resolveModel runs before startLiteLLMSupervisor.
    return startLiteLLMSupervisor();
  }

  // Read through getSupervisorState() (not internal.state directly) so the
  // value isn't subject to TS narrowing across the await — supervise() is
  // mutating internal.state from outside this function's control flow.
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const s = getSupervisorState();
    if (s === "ready") return;
    if (s === "given_up") {
      throw new Error("LiteLLM supervisor has given up.");
    }
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  throw new Error("Timed out waiting for LiteLLM to become ready.");
};

const stopLiteLLM = (signal: NodeJS.Signals = "SIGTERM") => {
  internal.shutdownRequested = true;
  const child = internal.child;
  if (!child) return;
  try {
    child.kill(signal);
  } catch {
    // already dead
  }
  // Force-kill if it hasn't exited after the grace period.
  setTimeout(() => {
    try {
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGKILL");
      }
    } catch {
      // ignore
    }
  }, SHUTDOWN_GRACE_MS).unref();
};

let shutdownHandlersRegistered = false;
const registerShutdownHandlers = () => {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;
  process.on("SIGINT", () => stopLiteLLM("SIGTERM"));
  process.on("SIGTERM", () => stopLiteLLM("SIGTERM"));
  process.on("exit", () => stopLiteLLM("SIGTERM"));
};

/**
 * Returns the current supervisor state. Exposed for tests + debugging endpoints.
 */
export const getSupervisorState = (): SupervisorState => internal.state;

/**
 * Test-only: reset internal state. Don't call from production code.
 */
export const __resetSupervisorForTesting = () => {
  internal.child = undefined;
  internal.state = "idle";
  internal.crashCount = 0;
  internal.backoffMs = INITIAL_BACKOFF_MS;
  internal.readyPromise = undefined;
  internal.shutdownRequested = false;
  shutdownHandlersRegistered = false;
  _packageRoot = undefined;
  setLiteLLMClientMode(false);
};
