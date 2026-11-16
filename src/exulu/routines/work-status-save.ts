import { validateWorkStatusConfig } from "./work-status";

/** Throws when a work_statuses value about to be saved is invalid; undefined = field not part of the write. */
export function assertWorkStatusConfigSavable(next: unknown, previous?: unknown): void {
  if (next === undefined) return;
  const problems = validateWorkStatusConfig(next, previous);
  if (problems.length > 0) {
    throw new Error(`Invalid work statuses: ${problems.join("; ")}`);
  }
}

const GUARDED = ["workflow_templatesCreateOne", "workflow_templatesUpdateOne", "workflow_templatesUpdateOneById"];

/**
 * Wraps the generated routine write mutations so an invalid `work_statuses`
 * input is rejected before anything is written (spec: unique, well-formed
 * keys; default exists and is not a done status).
 */
export function guardRoutineWorkStatusWrites(mutations: Record<string, any>): void {
  for (const name of GUARDED) {
    const original = mutations[name];
    if (typeof original !== "function") continue;
    mutations[name] = async (parent: unknown, args: any, context: unknown, info: unknown) => {
      assertWorkStatusConfigSavable(args?.input?.work_statuses);
      return original(parent, args, context, info);
    };
  }
}
