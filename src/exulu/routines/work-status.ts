/**
 * Work statuses of routine runs (spec 2026-11-16-routine-work-status-design).
 *
 * A routine may define its own list of work statuses (workflow_templates.
 * work_statuses); each run carries one (job_results.work_status), separate
 * from the technical `state`. This module holds the pure rules: reading a
 * stored config defensively, validating one about to be saved, and deciding
 * whether a status write applies. The database side is work-status-store.ts.
 */

export type WorkStatus = { key: string; label: string; color?: string; done?: boolean };
export type WorkStatusConfig = { statuses: WorkStatus[]; default: string | null };
export type WorkStatusActor =
  | { kind: "user"; id: number }
  | { kind: "tool"; id: string; user?: number }
  | { kind: "agent"; user?: number }
  | { kind: "default" };

export const WORK_STATUS_KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

const EMPTY: WorkStatusConfig = { statuses: [], default: null };

const toObject = (raw: unknown): Record<string, unknown> | undefined => {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

/** Never throws. Anything unusable → { statuses: [], default: null }. */
export function parseWorkStatusConfig(raw: unknown): WorkStatusConfig {
  const obj = toObject(raw);
  if (!obj || !Array.isArray(obj.statuses)) return { ...EMPTY, statuses: [] };
  const seen = new Set<string>();
  const statuses: WorkStatus[] = [];
  for (const entry of obj.statuses) {
    if (!entry || typeof entry !== "object") continue;
    const { key, label, color, done } = entry as Record<string, unknown>;
    if (typeof key !== "string" || !WORK_STATUS_KEY_PATTERN.test(key) || seen.has(key)) continue;
    seen.add(key);
    statuses.push({
      key,
      label: typeof label === "string" && label.trim() ? label : key,
      ...(typeof color === "string" ? { color } : {}),
      ...(typeof done === "boolean" ? { done } : {}),
    });
  }
  const def = typeof obj.default === "string" && seen.has(obj.default) ? obj.default : null;
  return { statuses, default: def };
}

/**
 * Problems for a config about to be saved; [] when valid. null / undefined
 * and an empty list switch the feature off and are valid. Key immutability
 * is enforced by the settings UI: here a rename is indistinguishable from
 * remove + add, which is allowed.
 */
export function validateWorkStatusConfig(next: unknown, _previous?: unknown): string[] {
  if (next === null || next === undefined) return [];
  const obj = toObject(next);
  if (!obj) return ["work_statuses must be an object { statuses, default }"];
  if (!Array.isArray(obj.statuses)) return ["work_statuses.statuses must be a list"];
  const problems: string[] = [];
  const keys = new Set<string>();
  const doneKeys = new Set<string>();
  obj.statuses.forEach((entry, index) => {
    const { key, label, done } = (entry ?? {}) as Record<string, unknown>;
    if (typeof key !== "string" || !WORK_STATUS_KEY_PATTERN.test(key)) {
      problems.push(`status ${index + 1}: key ${JSON.stringify(key)} must match ${WORK_STATUS_KEY_PATTERN}`);
      return;
    }
    if (keys.has(key)) problems.push(`duplicate status key "${key}"`);
    keys.add(key);
    if (typeof label !== "string" || !label.trim()) problems.push(`status "${key}": label must not be empty`);
    if (done === true) doneKeys.add(key);
  });
  if (obj.statuses.length === 0) return problems;
  if (typeof obj.default !== "string" || !keys.has(obj.default)) {
    problems.push(`default ${JSON.stringify(obj.default ?? null)} must be one of the status keys`);
  } else if (doneKeys.has(obj.default)) {
    problems.push(`default "${obj.default}" must not be a done status`);
  }
  return problems;
}

export function isDoneStatus(config: WorkStatusConfig, key: string | null): boolean {
  if (!key) return false;
  return config.statuses.some((status) => status.key === key && status.done === true);
}

export type WorkStatusOrigin = "worker" | "chat" | "manual";
export type WorkStatusDecision =
  | { action: "write"; status: string | null }
  | { action: "skip"; reason: "human_set" | "unchanged" }
  | { action: "reject"; message: string };

/**
 * Whether a status write applies.
 *
 *  - worker: a tool or the agent during the worker's run. Never overrides a
 *    status a person set — a step retry re-runs tools and must not undo a
 *    person's decision.
 *  - chat: a tool or the agent in a turn a person started on the run's
 *    session. The person asked for the action, so the write applies.
 *  - manual: a person in the runs list. May also clear the status (null).
 */
export function decideWorkStatusWrite(input: {
  config: WorkStatusConfig;
  routineName: string;
  current: { status: string | null; updatedBy: WorkStatusActor | null };
  next: string | null;
  origin: WorkStatusOrigin;
}): WorkStatusDecision {
  const { config, routineName, current, next, origin } = input;
  if (next === null) {
    if (origin !== "manual") {
      return { action: "reject", message: "A work status can only be cleared by a person in the runs list." };
    }
    return current.status === null ? { action: "skip", reason: "unchanged" } : { action: "write", status: null };
  }
  if (config.statuses.length === 0) {
    return { action: "reject", message: `Routine "${routineName}" has no work statuses configured.` };
  }
  if (!config.statuses.some((status) => status.key === next)) {
    return {
      action: "reject",
      message: `Unknown work status "${next}" for routine "${routineName}". Allowed: ${config.statuses.map((s) => s.key).join(", ")}`,
    };
  }
  if (origin === "worker" && current.updatedBy?.kind === "user") {
    return { action: "skip", reason: "human_set" };
  }
  if (current.status === next) return { action: "skip", reason: "unchanged" };
  return { action: "write", status: next };
}
