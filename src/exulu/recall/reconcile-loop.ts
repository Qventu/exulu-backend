/**
 * Background reconciliation loop for Recall meeting jobs. The webhook route
 * ACKs with 2xx before processing and Recall never redelivers an ACKed event,
 * so a crash/restart mid-processing would strand jobs in queued/transcribing
 * forever. This loop periodically re-drives stuck rows from Recall's own
 * state (see recallService.reconcileOnce). Started from ExuluApp.create()
 * iff Recall is configured. Stopped on SIGTERM/SIGINT.
 */

import { recallService } from "./service";

const RECONCILE_INTERVAL_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let stopped = false;

const tick = async (): Promise<void> => {
  if (stopped) return;
  try {
    const acted = await recallService.reconcileOnce();
    if (acted > 0) {
      console.log(`[EXULU-RECALL] reconcile tick recovered ${acted} job(s)`);
    }
  } catch (err) {
    console.error(
      `[EXULU-RECALL] reconcile tick failed: ${(err as Error).message}`,
    );
  } finally {
    if (!stopped) {
      timer = setTimeout(tick, RECONCILE_INTERVAL_MS);
    }
  }
};

export const startRecallReconcileLoop = (): void => {
  if (timer) return; // already running
  stopped = false;
  timer = setTimeout(tick, RECONCILE_INTERVAL_MS);
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
