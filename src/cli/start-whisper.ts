#!/usr/bin/env node
/**
 * CLI entry: launches the standalone whisper transcription server, supervised
 * for restarts and shutdown signals.
 *
 *   npm run start:whisper
 *   npx @exulu/backend exulu-start-whisper
 *
 * Env vars (all optional unless noted):
 *   WHISPER_HOST        bind host (default 127.0.0.1)
 *   WHISPER_PORT        bind port (default 9000)
 *   WHISPER_MODEL       whisper model id (default large-v3)
 *   WHISPER_DEVICE      auto|cuda|mps|cpu (default auto)
 *   WHISPER_BATCH_SIZE  inference batch (default 4)
 *   HF_AUTH_TOKEN       hugging face token; without it diarization is off
 */

// Load .env from the current working directory before anything reads
// process.env. The supervisor passes process.env straight to the Python
// child, so HF_AUTH_TOKEN / WHISPER_* vars defined in .env need to be in
// process.env by the time spawn() runs.
import "dotenv/config";

import { getPackageRoot } from "../utils/python-setup";
import { startWhisperSupervisor } from "../exulu/transcription/supervisor";

const main = async () => {
  const packageRoot = getPackageRoot();
  try {
    await startWhisperSupervisor({ packageRoot });
  } catch (err) {
    console.error(`[EXULU-WHISPER] ${(err as Error).message}`);
    process.exit(1);
  }
  // The supervisor task runs forever; signal handlers in the supervisor
  // module trigger graceful shutdown on SIGINT/SIGTERM.
  await new Promise(() => {});
};

main().catch((err) => {
  console.error(`[EXULU-WHISPER] Unexpected error: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
