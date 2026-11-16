import { z } from "zod";
import { ExuluTool } from "@SRC/exulu/tool";
import type { RoutineHandleInternal } from "@SRC/exulu/routines/routine-handle";

export const SET_ROUTINE_STATUS_TOOL_ID = "set_routine_status";

/**
 * Built-in tool that lets the agent set the work status of the routine run
 * its turn belongs to (spec 2026-11-16-routine-work-status-design). Offered
 * only inside a routine run whose routine has work statuses; the input is an
 * enum of exactly those keys, so the model cannot invent a value. Hard facts
 * (an offer was created) are better set by the tool that established them,
 * via `routine.runs.current.update` in its own execute.
 */
export function createRoutineStatusTool(handle: RoutineHandleInternal | undefined): ExuluTool | undefined {
  if (!handle || handle.statuses.length === 0) return undefined;
  const keys = handle.statuses.map((status) => status.key) as [string, ...string[]];
  const labelOf = (key: string) => handle.statuses.find((status) => status.key === key)?.label ?? key;

  return new ExuluTool({
    id: SET_ROUTINE_STATUS_TOOL_ID,
    name: "Set routine status",
    description:
      `Sets the work status of this run of the routine "${handle.name}" for the people working the run list. ` +
      "Use it when the step instructions tell you to, with exactly one of these values: " +
      handle.statuses.map((status) => `${status.key} — ${status.label}`).join("; ") +
      ".",
    category: "routines",
    type: "function",
    needsApproval: false,
    inputSchema: z.object({
      status: z.enum(keys).describe("The work status key to set."),
    }),
    config: [],
    execute: async ({ status }: { status: string }) => {
      const decision = await handle.runs.current.updateWithResult({ status });
      if (decision?.action === "skip" && decision.reason === "human_set") {
        return {
          result: `A person already set the status to "${labelOf(handle.runs.current.status ?? "")}"; left unchanged.`,
        };
      }
      if (decision?.action === "skip") return { result: `Status is already "${labelOf(status)}".` };
      return { result: `Status set to "${labelOf(status)}".` };
    },
  });
}
