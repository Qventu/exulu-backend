import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Spawns the standalone Whisper HTTP server (uvicorn + FastAPI) as a child
 * process, supervises it (exponential-backoff respawn capped at 5 crashes),
 * and exposes a memoized readiness promise.
 *
 * Unlike the LiteLLM supervisor, this one is NOT auto-started by the main
 * ExuluApp boot path. It runs as its own process group via
 * `npx @exulu/backend exulu-start-whisper`, so devs can place transcription
 * on a separate (typically GPU) machine and point the main app at it via
 * the TRANSCRIPTION_SERVER env var.
 *
 * Design doc: docs/superpowers/specs/2026-05-28-transcription-feature-design.md
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
// First-run model download (~3 GB for large-v3) can take a while on a slow
// connection; we'd rather wait than restart and re-download. Subsequent boots
// are fast because the model is cached in ~/.cache/huggingface.
const READY_TIMEOUT_MS = 30 * 60_000;
const READY_POLL_INTERVAL_MS = 500;
const SHUTDOWN_GRACE_MS = 5_000;

const internal: SupervisorInternal = {
  child: undefined,
  state: "idle",
  crashCount: 0,
  backoffMs: INITIAL_BACKOFF_MS,
  readyPromise: undefined,
  shutdownRequested: false,
};

const resolveConfig = (packageRoot: string) => {
  const host = process.env.WHISPER_HOST ?? "127.0.0.1";
  const port = process.env.WHISPER_PORT ?? "9876";
  const venvBin = resolve(packageRoot, "ee/python/.venv/bin");
  const venvPython = resolve(venvBin, "python");
  const cwd = resolve(packageRoot, "ee/python/transcription");
  return { host, port, venvBin, venvPython, cwd };
};

const log = (line: string) => {
  // The Python side already emits "[EXULU-WHISPER] …" on its own lines (so it
  // looks consistent when run standalone). Don't double-prefix when those
  // lines reach us via the child's stdout.
  const text = line.startsWith("[EXULU-WHISPER]") ? line : `[EXULU-WHISPER] ${line}`;
  console.log(text);
};

const pollHealth = async (host: string, port: string): Promise<void> => {
  const url = `http://${host}:${port}/healthz`;
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
    `Whisper server did not become ready at ${url} within ${READY_TIMEOUT_MS}ms`,
  );
};

const spawnWhisper = (cfg: ReturnType<typeof resolveConfig>): ChildProcess => {
  log(
    `Spawning: ${cfg.venvPython} -m uvicorn server:app --host ${cfg.host} --port ${cfg.port}`,
  );

  const child = spawn(
    cfg.venvPython,
    [
      "-m",
      "uvicorn",
      "server:app",
      "--host",
      cfg.host,
      "--port",
      cfg.port,
      "--log-level",
      "info",
    ],
    {
      cwd: cfg.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
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
    internal.child = spawnWhisper(cfg);

    const exitPromise = new Promise<number | null>((resolveFn) => {
      internal.child!.on("exit", (code) => resolveFn(code));
    });

    try {
      await Promise.race([
        pollHealth(cfg.host, cfg.port).then(() => "ready" as const),
        exitPromise.then((code) => ({ exited: code })),
      ]);
    } catch (err) {
      log(`Readiness probe failed: ${(err as Error).message}`);
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
      log("Whisper server is ready.");
    }

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
      `Whisper server exited (code=${code}). Crash ${internal.crashCount}/${MAX_CRASHES}. ` +
        `Respawning in ${internal.backoffMs}ms.`,
    );
    if (internal.crashCount >= MAX_CRASHES) {
      log(
        "Whisper server keeps crashing — fix the install (try `npx @exulu/backend setup-python --force`) " +
          "and re-run `npx @exulu/backend exulu-start-whisper`. Giving up.",
      );
      internal.state = "given_up";
      return;
    }
    await new Promise((r) => setTimeout(r, internal.backoffMs));
    internal.backoffMs = Math.min(internal.backoffMs * 2, MAX_BACKOFF_MS);
  }
};

/**
 * Start the Whisper supervisor. Idempotent.
 *
 * Validates: venv python exists, transcription cwd exists.
 * Surfaces clear errors when prerequisites are missing.
 */
export const startWhisperSupervisor = async (
  options: { packageRoot: string },
): Promise<void> => {
  if (internal.readyPromise) {
    return internal.readyPromise;
  }

  const cfg = resolveConfig(options.packageRoot);

  if (!existsSync(cfg.venvPython)) {
    throw new Error(
      `Whisper supervisor: Python venv not found at ${cfg.venvPython}. ` +
        `Run \`npx @exulu/backend setup-python\` first.`,
    );
  }
  if (!existsSync(cfg.cwd)) {
    throw new Error(
      `Whisper supervisor: transcription scripts not found at ${cfg.cwd}. ` +
        `The @exulu/backend package may be corrupt; reinstall it.`,
    );
  }

  internal.readyPromise = (async () => {
    supervise(cfg);
    const deadline = Date.now() + READY_TIMEOUT_MS + 5_000;
    while (Date.now() < deadline) {
      if (internal.state === "ready") return;
      if (internal.state === "given_up") {
        throw new Error("Whisper supervisor gave up before becoming ready.");
      }
      await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
    }
    throw new Error("Timed out waiting for whisper supervisor readiness.");
  })();

  registerShutdownHandlers();

  return internal.readyPromise;
};

const stopWhisper = (signal: NodeJS.Signals = "SIGTERM") => {
  internal.shutdownRequested = true;
  const child = internal.child;
  if (!child) return;
  try {
    child.kill(signal);
  } catch {
    // already dead
  }
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
  process.on("SIGINT", () => stopWhisper("SIGTERM"));
  process.on("SIGTERM", () => stopWhisper("SIGTERM"));
  process.on("exit", () => stopWhisper("SIGTERM"));
};

export const getSupervisorState = (): SupervisorState => internal.state;

export const __resetSupervisorForTesting = () => {
  internal.child = undefined;
  internal.state = "idle";
  internal.crashCount = 0;
  internal.backoffMs = INITIAL_BACKOFF_MS;
  internal.readyPromise = undefined;
  internal.shutdownRequested = false;
  shutdownHandlersRegistered = false;
};
