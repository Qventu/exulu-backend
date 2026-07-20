export type JOB_STATUS =
  | "completed"
  | "failed"
  | "delayed"
  | "active"
  | "waiting"
  | "paused"
  | "stuck"
  // Email-triggered routines (spec 2026-07-15): run paused on an
  // approval-requested tool part. NON-terminal — never pruned.
  | "waiting_approval"
  // Email arrived but a guard filtered it (reason in trigger_metadata).
  | "filtered"
  // Admin cancelled the run.
  | "cancelled";

export const JOB_STATUS_ENUM = {
    completed: "completed",
    failed: "failed",
    delayed: "delayed",
    active: "active",
    waiting: "waiting",
    paused: "paused",
    stuck: "stuck",
    waiting_approval: "waiting_approval",
    filtered: "filtered",
    cancelled: "cancelled"
  };

/**
 * Single source of truth for terminal job_results states (spec §3.3).
 * The pruner may delete these; waiting/active/delayed/paused/waiting_approval
 * are live and must never be pruned. `stuck` is defined-but-unwritten and is
 * deliberately NOT terminal.
 */
export const TERMINAL_JOB_STATES: JOB_STATUS[] = ["completed", "failed", "filtered", "cancelled"];
