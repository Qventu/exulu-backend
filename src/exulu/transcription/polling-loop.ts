/**
 * Background polling loop that reconciles transcription_jobs against the
 * whisper server. Started from ExuluApp.create() iff TRANSCRIPTION_SERVER
 * is set. Stopped on SIGTERM/SIGINT.
 */

import { transcriptionService } from "./service";

const POLL_INTERVAL_MS = 5_000;
const MAX_PER_TICK = 50;

let timer: NodeJS.Timeout | null = null;
let stopped = false;

const tick = async (): Promise<void> => {
  if (stopped) return;
  try {
    await transcriptionService.pollOnce(MAX_PER_TICK);
  } catch (err) {
    console.error(`[EXULU-TRANSCRIPTION] polling tick failed: ${(err as Error).message}`);
  } finally {
    if (!stopped) {
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    }
  }
};

export const startTranscriptionPollingLoop = (): void => {
  if (timer) return; // already running
  stopped = false;
  timer = setTimeout(tick, POLL_INTERVAL_MS);
  const stop = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
};
