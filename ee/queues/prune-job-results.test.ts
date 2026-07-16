import { TERMINAL_JOB_STATES } from "@EXULU_TYPES/enums/jobs";
import { maybePruneJobResults } from "./prune-job-results";

describe("TERMINAL_JOB_STATES", () => {
  it("is the single source of truth for prunable terminal states", () => {
    expect(TERMINAL_JOB_STATES).toEqual(["completed", "failed", "filtered", "cancelled"]);
  });

  it("never contains live or paused states", () => {
    for (const state of ["waiting", "active", "delayed", "paused", "waiting_approval", "stuck"]) {
      expect(TERMINAL_JOB_STATES).not.toContain(state);
    }
  });
});

describe("maybePruneJobResults", () => {
  it("prunes only TERMINAL_JOB_STATES rows (every 100th call)", async () => {
    const whereInCalls: any[][] = [];
    const builder: any = {
      whereIn: (...args: any[]) => {
        whereInCalls.push(args);
        return builder;
      },
      orderBy: () => builder,
      offset: () => builder,
      limit: () => builder,
      first: async () => undefined, // under cap: nothing to delete
      where: () => builder,
      del: async () => 0,
    };
    const db: any = jest.fn(() => builder);

    // The module-level counter only reaches the prune body every 100th call.
    for (let i = 0; i < 100; i++) {
      await maybePruneJobResults(db);
    }

    expect(whereInCalls.length).toBeGreaterThanOrEqual(1);
    expect(whereInCalls[0]).toEqual(["state", TERMINAL_JOB_STATES]);
  });
});
