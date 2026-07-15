# Email-Triggered Routines — Plan 3: Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the frontend for email-triggered, session-backed routine runs — TriggersSection, RunsSection v2, global `/runs` page with nav badge, chat run banner, and the super-admin email-intake settings surface — fully gated behind two schema flags so it merges before the backend (Plans 1+2) ships.

**Architecture:** All new cross-feature code lives in `lib/routine-runs/`, `lib/email-inbound/` and `components/widgets/routine-runs/` because eslint feature isolation forbids `app/(application)/<feature>` folders importing each other, and the shell tier (`components/shell/**`) forbids importing `app/*`. The two schema flags are defined in `lib/routine-runs/flags.ts` and **re-exported** from `app/(application)/workflows/schema-flags.ts` (the contract location) so both import paths work. Every new surface renders nothing (or its legacy fallback) while the flags are `false`.

**Tech Stack:** Next.js App Router (Next 16, Turbopack), React 19, Apollo Client (`useQuery`/`useMutation`, `gql`), next-intl (`messages/en.json` + `messages/de.json`), shadcn/ui components, vitest (node env, `*.test.ts` pure modules only), eslint 9 flat config with tier/feature boundaries.

## Global Constraints

- **Repo for ALL code changes:** `/Users/daniel.claessen/Desktop/Projects/exulu/frontend` (default branch **main** — the backend repo's develop branch is NOT touched by this plan; this plan file is the only backend-repo artifact).
- Backend-repo conventions (context only, no backend code in this plan): Node v22.18.0 enforced by preinstall; Jest+ts-jest, single test: `npm test -- --testPathPattern="<pattern>"`; path aliases `@SRC/*` `@EE/*` `@EXULU_TYPES/*`; eslint strict incl. no-floating-promises.
- Naming: "routine" user-facing / `workflow_*` in code; runs are `job_results` rows exposed via the Plan-1 `routineRuns` API.
- Commit style: conventional commits ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Frontend test runner: **vitest** (`npm test` = `vitest run`; single file: `npx vitest run <path>`); node environment; only `lib/**/*.test.ts`, `components/**/*.test.ts`, `app/**/*.test.ts` are picked up — React components are NOT unit-testable here, so component tasks verify via `npm run lint` + `npm run build` + manual walkthrough.
- i18n: every new string in BOTH `messages/en.json` and `messages/de.json` (real German); parity gate: `npm run check-messages`.
- Formatting gate: `npx prettier --write <changed files>` before every commit (`npm run prettier` is a CI check).
- eslint boundaries (hard errors): `components/shell/**` may NOT import `@/app/*`; `components/widgets/**` may NOT import `@/app/*` or `@/components/shell/*`; `app/(application)/<feature>/**` may NOT import another feature's folder. `lib/**` and `@apollo/client` are importable from shell, widgets, and features.
- GraphQL contract (FIXED, from Plans 1+2 — consume verbatim): `routineRuns(page, limit, workflow, states, triggers, from, to, search, needsAttention): RoutineRunPage`, `routineRunsNeedingAttentionCount: Float!`, `cancelRoutineRun(id)`, `retryRoutineRun(id)`, `workflowTriggers(workflow)`, `upsertWorkflowEmailTrigger(workflow, enabled, config)`, `deleteWorkflowTrigger(id)`, `emailInboundConfig`, `updateEmailInboundConfig(provider, inbound_domain, enabled, signing_key)`.
- Chat links: `/chat/<agent>/<session>` where `<agent>` is the **agent id** (verified: `app/(application)/chat/[agent]/[session]/page.tsx:95-99` passes the param straight into `agentById(id: agent)`). `RoutineRun.agent` carries the agent id (= `workflow_templates.agent`), so no slug resolution is needed.
- Branch: create `feature/email-routines-frontend` off `main` in the frontend repo before Task 1 (per repo convention use a sibling worktree with symlinked `node_modules` if the primary checkout is busy).

---

### Task 1: `lib/routine-runs` foundation — flags, types, presentation helpers (TDD), GraphQL operations

**Files:**
- Create: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/lib/routine-runs/flags.ts`
- Create: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/lib/routine-runs/types.ts`
- Create: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/lib/routine-runs/presentation.test.ts`
- Create: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/lib/routine-runs/presentation.ts`
- Create: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/lib/routine-runs/queries.ts`
- Modify: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/workflows/schema-flags.ts` (append re-export at end of file, after line 76 `export const ROUTINES_AGENTS_BATCH_SUPPORTED = false;`)

**Interfaces:**
- Consumes: nothing (pure foundation).
- Produces (exact signatures other tasks import):
  - `flags.ts`: `export const ROUTINES_RUNS_V2_SUPPORTED = false;` `export const ROUTINES_EMAIL_TRIGGER_SUPPORTED = false;`
  - `types.ts`: `export interface RoutineRun { id: string; job_id?: string | null; state: string; trigger?: string | null; trigger_metadata?: RoutineRunTriggerMetadata | null; session?: string | null; workflow: string; workflowName?: string | null; agent?: string | null; error?: unknown; tries?: number | null; createdAt?: string | null; updatedAt?: string | null }` and `export interface RoutineRunPage { items: RoutineRun[]; total: number }`
  - `presentation.ts`: `ALL_RUN_STATES`, `NON_FILTERED_STATES`, `RUN_TRIGGERS`, `KNOWN_FILTERED_REASONS`, `RUN_STATE_BADGE`, `mapRunDot(state?: string)`, `runTitle(run)`, `triggerBadge(run)`, `canCancelRun(state)`, `canRetryRun(state)`, `isTerminalRunState(state)`, `needsAttention(state)`, `filteredReason(run)`, `formatRunDuration(createdAt, updatedAt, state)`, `RunsFilterState`, `DEFAULT_RUNS_FILTER`, `buildRoutineRunsVariables(filter, opts)`
  - `queries.ts`: `ROUTINE_RUNS`, `ROUTINE_RUNS_ATTENTION_COUNT`, `CANCEL_ROUTINE_RUN`, `RETRY_ROUTINE_RUN`, `ROUTINE_RUN_FOR_SESSION`, `ROUTINE_NAME_BY_ID` (all Apollo `DocumentNode`s)

**Steps:**

- [ ] 1.1 In the frontend repo, create the branch:
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && git checkout main && git pull && git checkout -b feature/email-routines-frontend
  ```

- [ ] 1.2 Write the failing test `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/lib/routine-runs/presentation.test.ts`:

```ts
// Unit tests for the pure runs-v2 presentation/query-shaping helpers.
// No React, no Apollo — vitest node environment.

import { describe, expect, it } from "vitest";

import {
  ALL_RUN_STATES,
  buildRoutineRunsVariables,
  canCancelRun,
  canRetryRun,
  DEFAULT_RUNS_FILTER,
  filteredReason,
  formatRunDuration,
  isTerminalRunState,
  KNOWN_FILTERED_REASONS,
  mapRunDot,
  needsAttention,
  NON_FILTERED_STATES,
  RUN_STATE_BADGE,
  RUN_TRIGGERS,
  runTitle,
  triggerBadge,
} from "@/lib/routine-runs/presentation";

describe("state catalogue", () => {
  it("contains the three Plan-1 states on top of the legacy seven", () => {
    expect(ALL_RUN_STATES).toEqual([
      "waiting",
      "active",
      "completed",
      "failed",
      "delayed",
      "paused",
      "stuck",
      "waiting_approval",
      "filtered",
      "cancelled",
    ]);
  });

  it("NON_FILTERED_STATES excludes exactly 'filtered'", () => {
    expect(NON_FILTERED_STATES).toEqual(
      ALL_RUN_STATES.filter((state) => state !== "filtered"),
    );
  });

  it("every state has a badge class", () => {
    for (const state of ALL_RUN_STATES) {
      expect(RUN_STATE_BADGE[state]).toBeTruthy();
    }
  });

  it("RUN_TRIGGERS matches the backend trigger enum", () => {
    expect(RUN_TRIGGERS).toEqual(["email", "schedule", "manual", "api"]);
  });

  it("KNOWN_FILTERED_REASONS matches the Plan-2 FilteredReason union", () => {
    expect(KNOWN_FILTERED_REASONS).toEqual([
      "sender_not_allowed",
      "filter",
      "rate_limited",
      "duplicate",
      "auto_reply",
    ]);
  });
});

describe("mapRunDot", () => {
  it("waiting_approval is a pulsing warning dot", () => {
    expect(mapRunDot("waiting_approval")).toEqual({
      status: "warning",
      pulse: true,
    });
  });
  it("filtered and cancelled are muted", () => {
    expect(mapRunDot("filtered")).toEqual({ status: "muted", pulse: false });
    expect(mapRunDot("cancelled")).toEqual({ status: "muted", pulse: false });
  });
  it("legacy states keep the RunsSection mapping", () => {
    expect(mapRunDot("completed")).toEqual({ status: "success", pulse: false });
    expect(mapRunDot("failed")).toEqual({ status: "error", pulse: false });
    expect(mapRunDot("active")).toEqual({ status: "info", pulse: true });
    expect(mapRunDot("waiting")).toEqual({ status: "info", pulse: false });
    expect(mapRunDot(undefined)).toEqual({ status: "muted", pulse: false });
  });
});

describe("action predicates", () => {
  it("cancel is allowed from waiting/active/waiting_approval only", () => {
    expect(canCancelRun("waiting")).toBe(true);
    expect(canCancelRun("active")).toBe(true);
    expect(canCancelRun("waiting_approval")).toBe(true);
    expect(canCancelRun("completed")).toBe(false);
    expect(canCancelRun("failed")).toBe(false);
    expect(canCancelRun("filtered")).toBe(false);
  });
  it("retry is allowed from failed/cancelled only", () => {
    expect(canRetryRun("failed")).toBe(true);
    expect(canRetryRun("cancelled")).toBe(true);
    expect(canRetryRun("waiting_approval")).toBe(false);
    expect(canRetryRun("completed")).toBe(false);
  });
  it("terminal states mirror TERMINAL_JOB_STATES from Plan 1", () => {
    expect(isTerminalRunState("completed")).toBe(true);
    expect(isTerminalRunState("failed")).toBe(true);
    expect(isTerminalRunState("filtered")).toBe(true);
    expect(isTerminalRunState("cancelled")).toBe(true);
    expect(isTerminalRunState("waiting_approval")).toBe(false);
    expect(isTerminalRunState("active")).toBe(false);
  });
  it("needsAttention is exactly waiting_approval", () => {
    expect(needsAttention("waiting_approval")).toBe(true);
    expect(needsAttention("failed")).toBe(false);
  });
});

describe("row presentation", () => {
  it("runTitle prefers the email subject, falls back to workflowName, then empty", () => {
    expect(
      runTitle({
        trigger_metadata: { subject: "Ersatzteil DX-9" },
        workflowName: "Spare parts",
      }),
    ).toBe("Ersatzteil DX-9");
    expect(
      runTitle({ trigger_metadata: {}, workflowName: "Spare parts" }),
    ).toBe("Spare parts");
    expect(runTitle({ trigger_metadata: { subject: "   " } })).toBe("");
  });

  it("triggerBadge carries the sender for email runs", () => {
    expect(
      triggerBadge({
        trigger: "email",
        trigger_metadata: { from: "service@kone.com" },
      }),
    ).toEqual({ key: "email", detail: "service@kone.com" });
    expect(triggerBadge({ trigger: "email" })).toEqual({ key: "email" });
    expect(triggerBadge({ trigger: "schedule" })).toEqual({ key: "schedule" });
    expect(triggerBadge({ trigger: "manual" })).toEqual({ key: "manual" });
    expect(triggerBadge({ trigger: "api" })).toEqual({ key: "api" });
    // Pre-migration rows: trigger NULL renders "—" (design §7.2).
    expect(triggerBadge({ trigger: null })).toEqual({ key: "none" });
    expect(triggerBadge({})).toEqual({ key: "none" });
  });

  it("filteredReason reads trigger_metadata.filtered_reason", () => {
    expect(
      filteredReason({ trigger_metadata: { filtered_reason: "auto_reply" } }),
    ).toBe("auto_reply");
    expect(filteredReason({ trigger_metadata: {} })).toBeUndefined();
    expect(filteredReason({})).toBeUndefined();
  });

  it("formatRunDuration renders only for terminal runs with sane timestamps", () => {
    const start = "2026-07-15T10:00:00.000Z";
    expect(formatRunDuration(start, "2026-07-15T10:00:03.000Z", "completed")).toBe("3s");
    expect(formatRunDuration(start, "2026-07-15T10:01:05.000Z", "failed")).toBe("1m 5s");
    expect(formatRunDuration(start, "2026-07-15T12:03:00.000Z", "cancelled")).toBe("2h 3m");
    expect(formatRunDuration(start, "2026-07-15T10:01:05.000Z", "active")).toBeNull();
    expect(formatRunDuration(undefined, "2026-07-15T10:01:05.000Z", "completed")).toBeNull();
    expect(formatRunDuration(start, "2026-07-15T09:00:00.000Z", "completed")).toBeNull();
  });
});

describe("buildRoutineRunsVariables", () => {
  it("default filter excludes filtered rows via an explicit states list", () => {
    expect(
      buildRoutineRunsVariables(DEFAULT_RUNS_FILTER, { limit: 20 }),
    ).toEqual({ page: 1, limit: 20, states: NON_FILTERED_STATES });
  });

  it("showFiltered drops the states restriction entirely", () => {
    expect(
      buildRoutineRunsVariables(
        { ...DEFAULT_RUNS_FILTER, showFiltered: true },
        { limit: 20 },
      ),
    ).toEqual({ page: 1, limit: 20 });
  });

  it("an explicit state wins over the showFiltered default", () => {
    expect(
      buildRoutineRunsVariables(
        { ...DEFAULT_RUNS_FILTER, state: "waiting_approval" },
        { limit: 20 },
      ),
    ).toEqual({ page: 1, limit: 20, states: ["waiting_approval"] });
  });

  it("passes workflow scope, trigger, needsAttention, trimmed search and page", () => {
    expect(
      buildRoutineRunsVariables(
        {
          ...DEFAULT_RUNS_FILTER,
          trigger: "email",
          needsAttention: true,
          search: "  kone  ",
          page: 3,
        },
        { workflow: "wf-1", limit: 50 },
      ),
    ).toEqual({
      page: 3,
      limit: 50,
      workflow: "wf-1",
      states: NON_FILTERED_STATES,
      triggers: ["email"],
      needsAttention: true,
      search: "kone",
    });
  });

  it("serializes datetime-local from/to values as ISO strings", () => {
    const vars = buildRoutineRunsVariables(
      { ...DEFAULT_RUNS_FILTER, from: "2026-07-01T00:00", to: "2026-07-15T12:30" },
      { limit: 20 },
    );
    // TZ-agnostic: the ISO string must round-trip to the same instant the
    // local datetime-local string denotes on this machine.
    expect(new Date(vars.from as string).getTime()).toBe(
      new Date("2026-07-01T00:00").getTime(),
    );
    expect(new Date(vars.to as string).getTime()).toBe(
      new Date("2026-07-15T12:30").getTime(),
    );
  });
});
```

- [ ] 1.3 Run it — expected FAIL (module not found):
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx vitest run lib/routine-runs
  ```
  Expected output: `Error: Failed to load ... Cannot find module '@/lib/routine-runs/presentation'` (or "failed to resolve import").

- [ ] 1.4 Create `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/lib/routine-runs/flags.ts`:

```ts
/**
 * Schema-gating flags for the email-triggered-routines feature set
 * (design doc 2026-07-15, backend Plans 1+2).
 *
 * These are the canonical definitions. They live in lib/ (not in
 * app/(application)/workflows/schema-flags.ts like the other ROUTINES_*
 * flags) because eslint tier/feature boundaries forbid components/shell and
 * the runs/chat/configuration features from importing the workflows feature.
 * app/(application)/workflows/schema-flags.ts RE-EXPORTS both flags so the
 * workflows feature keeps its single import point.
 *
 * All flags default to FALSE — flip each in ONE place once the backend
 * capability is confirmed by introspection against a deployed backend.
 */

/**
 * Plan-1 runs API: `routineRuns`, `routineRunsNeedingAttentionCount`,
 * `cancelRoutineRun`, `retryRoutineRun`, plus job_results columns
 * trigger/trigger_metadata/session/workflow and states
 * waiting_approval/filtered/cancelled.
 *
 * Gates: RunsSection v2 (workflows feature), the global /runs page + nav
 * entry + sidebar badge, and the chat run-session banner.
 * Fallback (false): RunsSection keeps today's GET_JOB_RESULTS_LIGHT
 * label-substring listing; /runs renders an EmptyState; no nav entry, no
 * badge, no banner.
 */
export const ROUTINES_RUNS_V2_SUPPORTED = false;

/**
 * Plan-2 triggers/config API: `workflowTriggers`,
 * `upsertWorkflowEmailTrigger`, `deleteWorkflowTrigger`,
 * `emailInboundConfig`, `updateEmailInboundConfig`.
 *
 * Gates: the routine workbench TriggersSection and the super-admin
 * /configuration/email surface.
 * Fallback (false): the Triggers section is filtered out of the workbench
 * section list; /configuration/email renders an EmptyState.
 */
export const ROUTINES_EMAIL_TRIGGER_SUPPORTED = false;
```

- [ ] 1.5 Create `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/lib/routine-runs/types.ts`:

```ts
/**
 * Hand-maintained types for the Plan-1 `routineRuns` GraphQL API (contract
 * SDL in docs/superpowers/specs/2026-07-15-email-triggered-routines-design.md
 * §6). Keep in sync with the backend; same convention as types/models/*.
 */

/** trigger_metadata JSON — email runs carry from/subject/message_id, schedule runs carry cron, filtered rows add filtered_reason/failed_rule. */
export interface RoutineRunTriggerMetadata {
  from?: string;
  subject?: string;
  message_id?: string;
  filtered_reason?: string;
  failed_rule?: string;
  cron?: string;
}

export interface RoutineRun {
  id: string;
  job_id?: string | null;
  state: string;
  /** 'email' | 'schedule' | 'manual' | 'api' — NULL for pre-migration rows. */
  trigger?: string | null;
  trigger_metadata?: RoutineRunTriggerMetadata | null;
  /** agent_sessions id of the session-backed run (NULL for filtered rows). */
  session?: string | null;
  workflow: string;
  workflowName?: string | null;
  /** Agent id (workflow_templates.agent) — the /chat/[agent] route param. */
  agent?: string | null;
  error?: unknown;
  tries?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface RoutineRunPage {
  items: RoutineRun[];
  total: number;
}
```

- [ ] 1.6 Create `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/lib/routine-runs/presentation.ts`:

```ts
/**
 * Pure presentation + query-shaping helpers for routine runs (runs v2).
 * No React, no Apollo, no i18n — components resolve labels; this module
 * resolves structure. Unit-tested in presentation.test.ts.
 */

import type { RoutineRun } from "./types";

/** All states job_results can carry once Plan 1 ships (types/enums/jobs.ts). */
export const ALL_RUN_STATES = [
  "waiting",
  "active",
  "completed",
  "failed",
  "delayed",
  "paused",
  "stuck",
  "waiting_approval",
  "filtered",
  "cancelled",
] as const;
export type RunState = (typeof ALL_RUN_STATES)[number];

/** Default runs-list view: everything except cheap `filtered` email rows. */
export const NON_FILTERED_STATES: RunState[] = ALL_RUN_STATES.filter(
  (state) => state !== "filtered",
);

/** BullMqJobData.triggerSource values (Plan 1). */
export const RUN_TRIGGERS = ["email", "schedule", "manual", "api"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** Plan-2 guards.ts FilteredReason union. */
export const KNOWN_FILTERED_REASONS = [
  "sender_not_allowed",
  "filter",
  "rate_limited",
  "duplicate",
  "auto_reply",
] as const;

/**
 * Badge classes per state. Legacy seven mirror the RunsSection STATE_BADGE
 * map byte-for-byte; waiting_approval is the prominent amber "Needs
 * attention" (design §7.2); filtered/cancelled are muted terminal rows.
 */
export const RUN_STATE_BADGE: Record<string, string> = {
  completed: "bg-success/15 text-success border-success/30",
  failed: "bg-destructive/15 text-destructive border-destructive/30",
  stuck: "bg-destructive/15 text-destructive border-destructive/30",
  active: "bg-info/15 text-info border-info/30",
  waiting: "bg-info/15 text-info border-info/30",
  delayed: "bg-warning/15 text-warning border-warning/30",
  paused: "bg-muted text-muted-foreground border-border",
  waiting_approval: "bg-warning/15 text-warning border-warning/40 font-medium",
  filtered: "bg-muted text-muted-foreground border-border",
  cancelled: "bg-muted text-muted-foreground border-border",
};

export interface RunDot {
  status: "success" | "warning" | "error" | "info" | "muted";
  pulse: boolean;
}

/** StatusDot mapping — superset of the legacy RunsSection mapDot(). */
export function mapRunDot(state?: string): RunDot {
  switch (state) {
    case "completed":
      return { status: "success", pulse: false };
    case "failed":
    case "stuck":
      return { status: "error", pulse: false };
    case "active":
      return { status: "info", pulse: true };
    case "waiting":
    case "delayed":
    case "paused":
      return { status: "info", pulse: false };
    case "waiting_approval":
      return { status: "warning", pulse: true };
    case "filtered":
    case "cancelled":
    default:
      return { status: "muted", pulse: false };
  }
}

/** Row preview title: email subject → routine name → "" (design §7.2). */
export function runTitle(
  run: Pick<RoutineRun, "trigger_metadata" | "workflowName">,
): string {
  const subject = run.trigger_metadata?.subject;
  if (typeof subject === "string" && subject.trim() !== "") return subject;
  return run.workflowName ?? "";
}

export interface TriggerBadge {
  key: RunTrigger | "none";
  detail?: string;
}

/** Trigger badge: `email · sender@…` / schedule / manual / api / "—". */
export function triggerBadge(
  run: Pick<RoutineRun, "trigger" | "trigger_metadata">,
): TriggerBadge {
  const trigger = run.trigger;
  if (!(RUN_TRIGGERS as readonly string[]).includes(trigger ?? "")) {
    return { key: "none" };
  }
  if (trigger === "email") {
    const from = run.trigger_metadata?.from;
    return typeof from === "string" && from !== ""
      ? { key: "email", detail: from }
      : { key: "email" };
  }
  return { key: trigger as RunTrigger };
}

/** cancelRoutineRun CAS domain: waiting | active | waiting_approval. */
export function canCancelRun(state: string): boolean {
  return state === "waiting" || state === "active" || state === "waiting_approval";
}

/** retryRoutineRun domain: failed | cancelled only (design §6). */
export function canRetryRun(state: string): boolean {
  return state === "failed" || state === "cancelled";
}

/** Mirrors Plan 1 TERMINAL_JOB_STATES. */
export function isTerminalRunState(state: string): boolean {
  return (
    state === "completed" ||
    state === "failed" ||
    state === "filtered" ||
    state === "cancelled"
  );
}

export function needsAttention(state: string): boolean {
  return state === "waiting_approval";
}

export function filteredReason(
  run: Pick<RoutineRun, "trigger_metadata">,
): string | undefined {
  const reason = run.trigger_metadata?.filtered_reason;
  return typeof reason === "string" && reason !== "" ? reason : undefined;
}

/** "3s" / "1m 5s" / "2h 3m" for terminal runs; null otherwise. */
export function formatRunDuration(
  createdAt?: string | null,
  updatedAt?: string | null,
  state?: string,
): string | null {
  if (!state || !isTerminalRunState(state)) return null;
  if (!createdAt || !updatedAt) return null;
  const start = new Date(createdAt).getTime();
  const end = new Date(updatedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  const totalSeconds = Math.round((end - start) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** UI filter-bar state (widget-owned; page resets ride every patch). */
export interface RunsFilterState {
  /** "all" or one RunState. */
  state: string;
  /** "all" or one RunTrigger. */
  trigger: string;
  /** datetime-local strings (empty = unset). */
  from?: string;
  to?: string;
  search: string;
  needsAttention: boolean;
  showFiltered: boolean;
  page: number;
}

export const DEFAULT_RUNS_FILTER: RunsFilterState = {
  state: "all",
  trigger: "all",
  search: "",
  needsAttention: false,
  showFiltered: false,
  page: 1,
};

/**
 * Map the UI filter state onto the exact `routineRuns` variables (contract
 * §6). Filtered rows are excluded by DEFAULT via an explicit states list —
 * the backend has no "not filtered" operator.
 */
export function buildRoutineRunsVariables(
  filter: RunsFilterState,
  opts: { workflow?: string; limit: number },
): Record<string, unknown> {
  const vars: Record<string, unknown> = {
    page: filter.page,
    limit: opts.limit,
  };
  if (opts.workflow) vars.workflow = opts.workflow;
  if (filter.state !== "all") {
    vars.states = [filter.state];
  } else if (!filter.showFiltered) {
    vars.states = NON_FILTERED_STATES;
  }
  if (filter.trigger !== "all") vars.triggers = [filter.trigger];
  if (filter.from) vars.from = new Date(filter.from).toISOString();
  if (filter.to) vars.to = new Date(filter.to).toISOString();
  const search = filter.search.trim();
  if (search !== "") vars.search = search;
  if (filter.needsAttention) vars.needsAttention = true;
  return vars;
}
```

- [ ] 1.7 Run the test again — expected PASS (all tests green):
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx vitest run lib/routine-runs
  ```

- [ ] 1.8 Create `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/lib/routine-runs/queries.ts` (operations consume the Plan-1 SDL verbatim; `ROUTINE_RUN_FOR_SESSION`/`ROUTINE_NAME_BY_ID` ride existing auto-generated by-id queries):

```ts
/**
 * GraphQL operations for the Plan-1 routine-runs API. Lives in lib/ so the
 * workflows feature, the runs feature, the chat feature AND the shell badge
 * can all import it (eslint feature isolation forbids cross-feature imports).
 *
 * Every operation except ROUTINE_RUN_DETAIL-style by-id lookups is gated by
 * ROUTINES_RUNS_V2_SUPPORTED at the CALL SITE (skip:) — the documents
 * themselves are inert strings.
 */

import { gql } from "@apollo/client";

const ROUTINE_RUN_SELECTION = `
  id
  job_id
  state
  trigger
  trigger_metadata
  session
  workflow
  workflowName
  agent
  error
  tries
  createdAt
  updatedAt
`;

export const ROUTINE_RUNS = gql`
  query RoutineRuns(
    $page: Int
    $limit: Int
    $workflow: ID
    $states: [String!]
    $triggers: [String!]
    $from: Date
    $to: Date
    $search: String
    $needsAttention: Boolean
  ) {
    routineRuns(
      page: $page
      limit: $limit
      workflow: $workflow
      states: $states
      triggers: $triggers
      from: $from
      to: $to
      search: $search
      needsAttention: $needsAttention
    ) {
      items {
        ${ROUTINE_RUN_SELECTION}
      }
      total
    }
  }
`;

export const ROUTINE_RUNS_ATTENTION_COUNT = gql`
  query RoutineRunsNeedingAttentionCount {
    routineRunsNeedingAttentionCount
  }
`;

export const CANCEL_ROUTINE_RUN = gql`
  mutation CancelRoutineRun($id: ID!) {
    cancelRoutineRun(id: $id) {
      ${ROUTINE_RUN_SELECTION}
    }
  }
`;

export const RETRY_ROUTINE_RUN = gql`
  mutation RetryRoutineRun($id: ID!) {
    retryRoutineRun(id: $id) {
      ${ROUTINE_RUN_SELECTION}
    }
  }
`;

/**
 * Chat banner lookup: session.metadata.job_result_id → run state. Uses the
 * existing auto-generated job_resultById; `trigger`/`workflow` are Plan-1
 * columns, so callers MUST skip this unless ROUTINES_RUNS_V2_SUPPORTED.
 */
export const ROUTINE_RUN_FOR_SESSION = gql`
  query RoutineRunForSession($id: ID!) {
    job_resultById(id: $id) {
      id
      state
      trigger
      workflow
    }
  }
`;

/** Minimal routine name lookup for the chat banner (existing schema). */
export const ROUTINE_NAME_BY_ID = gql`
  query RoutineNameForRunBanner($id: ID!) {
    workflow_templateById(id: $id) {
      id
      name
    }
  }
`;
```

- [ ] 1.9 Append the re-export to `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/workflows/schema-flags.ts` — Edit, old_string:

```ts
export const ROUTINES_AGENTS_BATCH_SUPPORTED = false;
```

new_string:

```ts
export const ROUTINES_AGENTS_BATCH_SUPPORTED = false;

/**
 * Email-triggered-routines flags (design 2026-07-15). Defined in
 * lib/routine-runs/flags.ts because shell + runs/chat/configuration features
 * consume them and may not import this feature folder; re-exported here so
 * the workflows feature keeps ONE flag import point. Flip them THERE.
 */
export {
  ROUTINES_EMAIL_TRIGGER_SUPPORTED,
  ROUTINES_RUNS_V2_SUPPORTED,
} from "@/lib/routine-runs/flags";
```

- [ ] 1.10 Verify: lint + full test suite:
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npm run lint && npm test
  ```
  Expected: 0 errors, all vitest suites (including the pre-existing `lib/rights.test.ts`, `components/shell/nav-config.test.ts`) pass.

- [ ] 1.11 Format + commit:
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx prettier --write lib/routine-runs "app/(application)/workflows/schema-flags.ts" && git add lib/routine-runs "app/(application)/workflows/schema-flags.ts" && git commit -m "feat(runs): lib/routine-runs foundation — flags, types, presentation helpers, runs-v2 GraphQL ops

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

### Task 2: Shared runs-list widget (`components/widgets/routine-runs/runs-list.tsx`) + `routineRuns` i18n namespace

**Files:**
- Create: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/components/widgets/routine-runs/runs-list.tsx`
- Modify: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/messages/en.json` (insert new top-level `routineRuns` namespace after the `routines` object, anchor at line ~3620-3621)
- Modify: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/messages/de.json` (same anchor, German)

**Interfaces:**
- Consumes (Task 1): `ROUTINE_RUNS`, `CANCEL_ROUTINE_RUN`, `RETRY_ROUTINE_RUN` from `@/lib/routine-runs/queries`; every presentation helper from `@/lib/routine-runs/presentation`; `RoutineRun`, `RoutineRunPage` from `@/lib/routine-runs/types`.
- Produces: `export interface RoutineRunsListProps { workflow?: string; showRoutineColumn?: boolean; defaultNeedsAttention?: boolean; pageSize?: number }` and `export function RoutineRunsList(props: RoutineRunsListProps): JSX element` — consumed by Task 3 (per-routine section) and Task 4 (global page).
- Tier rules honored: widgets may import `@apollo/client`, `@/lib/*`, `@/components/primitives/*`, `@/components/ui/*` — NOT `@/app/*` or `@/components/shell/*`.

**Steps:**

- [ ] 2.1 Create `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/components/widgets/routine-runs/runs-list.tsx` (complete file):

```tsx
"use client";

/**
 * RoutineRunsList — the runs-v2 list (email-triggered routines design
 * §7.2/§7.3): filter bar (state, trigger source, date range, text search,
 * needs-attention lens, show-filtered toggle) above expandable run rows with
 * Open session / Cancel / Retry actions.
 *
 * Lives in the widgets tier because BOTH the per-routine Runs section
 * (app/(application)/workflows) and the global /runs page
 * (app/(application)/runs) render it, and feature folders may not import
 * each other (eslint feature isolation) — widgets + lib are the shared
 * altitude.
 *
 * Callers gate rendering behind ROUTINES_RUNS_V2_SUPPORTED — this component
 * assumes the Plan-1 `routineRuns` API exists.
 */

import { useMutation, useQuery } from "@apollo/client";
import {
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Info,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/primitives/confirm-dialog";
import { EmptyState } from "@/components/primitives/empty-state";
import { RelativeTime } from "@/components/primitives/relative-time";
import { StatusDot } from "@/components/primitives/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  ALL_RUN_STATES,
  buildRoutineRunsVariables,
  canCancelRun,
  canRetryRun,
  DEFAULT_RUNS_FILTER,
  filteredReason,
  formatRunDuration,
  KNOWN_FILTERED_REASONS,
  mapRunDot,
  RUN_STATE_BADGE,
  RUN_TRIGGERS,
  runTitle,
  triggerBadge,
  type RunsFilterState,
} from "@/lib/routine-runs/presentation";
import {
  CANCEL_ROUTINE_RUN,
  RETRY_ROUTINE_RUN,
  ROUTINE_RUNS,
} from "@/lib/routine-runs/queries";
import type { RoutineRun, RoutineRunPage } from "@/lib/routine-runs/types";
import { cn } from "@/lib/utils";

export interface RoutineRunsListProps {
  /** Scope to one routine (per-routine Runs section). Omit = global page. */
  workflow?: string;
  /** Prefix each row with the routine name (global page only). */
  showRoutineColumn?: boolean;
  /** Start with the needs-attention lens on (global page default). */
  defaultNeedsAttention?: boolean;
  pageSize?: number;
}

export function RoutineRunsList({
  workflow,
  showRoutineColumn = false,
  defaultNeedsAttention = false,
  pageSize = 20,
}: RoutineRunsListProps) {
  const t = useTranslations("routineRuns");

  const [filter, setFilter] = React.useState<RunsFilterState>({
    ...DEFAULT_RUNS_FILTER,
    needsAttention: defaultNeedsAttention,
  });
  const [searchInput, setSearchInput] = React.useState("");
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [showRawById, setShowRawById] = React.useState<Record<string, boolean>>(
    {},
  );
  const [cancelTarget, setCancelTarget] = React.useState<RoutineRun | null>(
    null,
  );

  // Debounced text search — 300 ms, resets to page 1 on change.
  React.useEffect(() => {
    const handle = window.setTimeout(() => {
      setFilter((f) =>
        f.search === searchInput.trim()
          ? f
          : { ...f, search: searchInput.trim(), page: 1 },
      );
    }, 300);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  const { data, loading, refetch } = useQuery<{
    routineRuns?: RoutineRunPage;
  }>(ROUTINE_RUNS, {
    variables: buildRoutineRunsVariables(filter, { workflow, limit: pageSize }),
    fetchPolicy: "cache-and-network",
  });

  const [cancelMutate] = useMutation(CANCEL_ROUTINE_RUN);
  const [retryMutate, retryState] = useMutation(RETRY_ROUTINE_RUN);

  const runs = data?.routineRuns?.items ?? [];
  const total = data?.routineRuns?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const patchFilter = (patch: Partial<RunsFilterState>) =>
    setFilter((f) => ({ ...f, ...patch, page: 1 }));

  const stateLabel = (state: string) =>
    (ALL_RUN_STATES as readonly string[]).includes(state)
      ? t(`state.${state}`)
      : state;

  const handleConfirmCancel = async () => {
    if (!cancelTarget) return;
    try {
      await cancelMutate({ variables: { id: cancelTarget.id } });
      toast.success(t("toast.cancelled"));
      await refetch();
    } catch (err) {
      toast.error(t("toast.cancelFailed"), {
        description: (err as Error).message,
      });
      throw err; // keep ConfirmDialog open
    }
  };

  const handleRetry = async (run: RoutineRun) => {
    try {
      await retryMutate({ variables: { id: run.id } });
      toast.success(t("toast.retried"));
      await refetch();
    } catch (err) {
      toast.error(t("toast.retryFailed"), {
        description: (err as Error).message,
      });
    }
  };

  return (
    <div className="space-y-3">
      {/* Filter bar (design §7.2: state, trigger source, date range, search) */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={filter.state}
          onValueChange={(value) => patchFilter({ state: value })}
        >
          <SelectTrigger className="w-44" aria-label={t("filters.state")}>
            <SelectValue placeholder={t("filters.allStates")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("filters.allStates")}</SelectItem>
            {ALL_RUN_STATES.map((state) => (
              <SelectItem key={state} value={state}>
                {stateLabel(state)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filter.trigger}
          onValueChange={(value) => patchFilter({ trigger: value })}
        >
          <SelectTrigger className="w-36" aria-label={t("filters.trigger")}>
            <SelectValue placeholder={t("filters.allTriggers")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("filters.allTriggers")}</SelectItem>
            {RUN_TRIGGERS.map((trigger) => (
              <SelectItem key={trigger} value={trigger}>
                {t(`trigger.${trigger}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          type="datetime-local"
          className="w-fit"
          value={filter.from ?? ""}
          onChange={(e) => patchFilter({ from: e.target.value || undefined })}
          aria-label={t("filters.from")}
        />
        <Input
          type="datetime-local"
          className="w-fit"
          value={filter.to ?? ""}
          onChange={(e) => patchFilter({ to: e.target.value || undefined })}
          aria-label={t("filters.to")}
        />

        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t("filters.searchPlaceholder")}
          className="w-48"
          aria-label={t("filters.searchPlaceholder")}
        />

        <Button
          type="button"
          size="sm"
          variant={filter.needsAttention ? "default" : "outline"}
          aria-pressed={filter.needsAttention}
          onClick={() =>
            patchFilter({ needsAttention: !filter.needsAttention })
          }
        >
          {t("filters.needsAttention")}
        </Button>

        <div className="flex items-center gap-2">
          <Switch
            id="show-filtered-runs"
            checked={filter.showFiltered}
            onCheckedChange={(checked) =>
              patchFilter({ showFiltered: checked })
            }
            disabled={filter.state !== "all"}
          />
          <Label
            htmlFor="show-filtered-runs"
            className="text-xs text-muted-foreground"
          >
            {t("filters.showFiltered")}
          </Label>
        </div>
      </div>

      {/* List */}
      {loading && runs.length === 0 ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, idx) => (
            <Skeleton key={idx} className="h-14 w-full" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <EmptyState
          variant="quiet"
          icon={Info}
          title={t("emptyTitle")}
          description={t("emptyDescription")}
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-md border">
          {runs.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              showRoutineColumn={showRoutineColumn}
              expanded={expandedId === run.id}
              onToggle={() =>
                setExpandedId((id) => (id === run.id ? null : run.id))
              }
              showRaw={!!showRawById[run.id]}
              onToggleRaw={() =>
                setShowRawById((m) => ({ ...m, [run.id]: !m[run.id] }))
              }
              onCancel={() => setCancelTarget(run)}
              onRetry={() => handleRetry(run)}
              retrying={retryState.loading}
              stateLabel={stateLabel}
              t={t}
            />
          ))}
        </ul>
      )}

      {/* Pagination (routineRuns returns items + total, pages are 1-based) */}
      {pageCount > 1 ? (
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span>{t("pagination", { page: filter.page, pages: pageCount })}</span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t("previousPage")}
            disabled={filter.page <= 1}
            onClick={() => setFilter((f) => ({ ...f, page: f.page - 1 }))}
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t("nextPage")}
            disabled={filter.page >= pageCount}
            onClick={() => setFilter((f) => ({ ...f, page: f.page + 1 }))}
          >
            <ChevronRight aria-hidden="true" className="size-4" />
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={!!cancelTarget}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
        title={t("cancelConfirm.title")}
        description={t("cancelConfirm.description")}
        variant="destructive"
        confirmLabel={t("cancelConfirm.confirmLabel")}
        onConfirm={handleConfirmCancel}
      />
    </div>
  );
}

interface RunRowProps {
  run: RoutineRun;
  showRoutineColumn: boolean;
  expanded: boolean;
  onToggle: () => void;
  showRaw: boolean;
  onToggleRaw: () => void;
  onCancel: () => void;
  onRetry: () => void;
  retrying: boolean;
  stateLabel: (state: string) => string;
  t: ReturnType<typeof useTranslations>;
}

function RunRow({
  run,
  showRoutineColumn,
  expanded,
  onToggle,
  showRaw,
  onToggleRaw,
  onCancel,
  onRetry,
  retrying,
  stateLabel,
  t,
}: RunRowProps) {
  const mapped = mapRunDot(run.state);
  const badge = triggerBadge(run);
  const title = runTitle(run);
  const duration = formatRunDuration(run.createdAt, run.updatedAt, run.state);
  const reason = filteredReason(run);
  const reasonLabel = reason
    ? (KNOWN_FILTERED_REASONS as readonly string[]).includes(reason)
      ? t(`filteredReason.${reason}`)
      : reason
    : null;
  const errorText = run.error
    ? typeof run.error === "string"
      ? run.error
      : JSON.stringify(run.error)
    : null;

  const triggerLabel =
    badge.key === "none"
      ? t("trigger.none")
      : badge.detail
        ? `${t(`trigger.${badge.key}`)} · ${badge.detail}`
        : t(`trigger.${badge.key}`);

  return (
    <li className={cn(run.state === "filtered" && "opacity-60")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          "flex w-full min-h-11 items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50",
          expanded && "bg-muted/30",
        )}
      >
        <StatusDot status={mapped.status} pulse={mapped.pulse} />
        <Badge
          variant="outline"
          className={cn(RUN_STATE_BADGE[run.state] ?? "")}
        >
          {stateLabel(run.state)}
        </Badge>
        <Badge
          variant="outline"
          className="max-w-44 truncate font-normal text-muted-foreground"
        >
          {triggerLabel}
        </Badge>
        <span className="hidden min-w-0 flex-1 truncate text-sm sm:inline">
          {showRoutineColumn && run.workflowName ? (
            <span className="text-muted-foreground">
              {run.workflowName}
              {title !== "" && title !== run.workflowName ? " — " : ""}
            </span>
          ) : null}
          {title !== run.workflowName || !showRoutineColumn ? title : null}
        </span>
        {run.createdAt ? (
          <RelativeTime
            date={run.createdAt}
            className="ml-auto shrink-0 text-xs text-muted-foreground sm:ml-0"
          />
        ) : null}
        {duration ? (
          <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground md:inline">
            {duration}
          </span>
        ) : null}
        <ChevronDown
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded ? (
        <div className="space-y-3 border-t bg-muted/10 px-3 py-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            {run.trigger_metadata?.from ? (
              <>
                <dt className="font-medium text-muted-foreground">
                  {t("row.from")}
                </dt>
                <dd className="min-w-0 break-all">
                  {run.trigger_metadata.from}
                </dd>
              </>
            ) : null}
            {run.trigger_metadata?.subject ? (
              <>
                <dt className="font-medium text-muted-foreground">
                  {t("row.subject")}
                </dt>
                <dd className="min-w-0 break-all">
                  {run.trigger_metadata.subject}
                </dd>
              </>
            ) : null}
            {run.trigger_metadata?.message_id ? (
              <>
                <dt className="font-medium text-muted-foreground">
                  {t("row.messageId")}
                </dt>
                <dd className="min-w-0 break-all font-mono">
                  {run.trigger_metadata.message_id}
                </dd>
              </>
            ) : null}
            {run.trigger_metadata?.cron ? (
              <>
                <dt className="font-medium text-muted-foreground">
                  {t("row.cron")}
                </dt>
                <dd className="font-mono">{run.trigger_metadata.cron}</dd>
              </>
            ) : null}
            {reasonLabel ? (
              <>
                <dt className="font-medium text-muted-foreground">
                  {t("row.filteredReason")}
                </dt>
                <dd>{reasonLabel}</dd>
              </>
            ) : null}
            {run.trigger_metadata?.failed_rule ? (
              <>
                <dt className="font-medium text-muted-foreground">
                  {t("row.failedRule")}
                </dt>
                <dd className="min-w-0 break-all font-mono">
                  {run.trigger_metadata.failed_rule}
                </dd>
              </>
            ) : null}
            {typeof run.tries === "number" && run.tries > 0 ? (
              <>
                <dt className="font-medium text-muted-foreground">
                  {t("row.tries")}
                </dt>
                <dd className="tabular-nums">{run.tries}</dd>
              </>
            ) : null}
          </dl>

          {errorText ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <p className="mb-1 flex items-center gap-2 text-sm font-medium text-destructive">
                <AlertCircle aria-hidden="true" className="size-4" />
                {t("row.errorHeading")}
              </p>
              <p className="break-all text-xs text-destructive">{errorText}</p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {run.session && run.agent ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/chat/${run.agent}/${run.session}`}>
                  {t("row.openSession")}
                </Link>
              </Button>
            ) : null}
            {canCancelRun(run.state) ? (
              <Button variant="outline" size="sm" onClick={onCancel}>
                {t("row.cancel")}
              </Button>
            ) : null}
            {canRetryRun(run.state) ? (
              <Button
                variant="outline"
                size="sm"
                disabled={retrying}
                onClick={onRetry}
              >
                {t("row.retry")}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggleRaw}
              className="-ml-2"
            >
              {showRaw ? t("row.hideRaw") : t("row.showRaw")}
            </Button>
          </div>

          {showRaw ? (
            <pre className="max-h-64 overflow-auto rounded-md border bg-background p-3 font-mono text-xs">
              {JSON.stringify(run, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
```

- [ ] 2.2 Add the `routineRuns` i18n namespace to `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/messages/en.json`. Edit — old_string (unique: end of the `routines` object at lines 3620-3622, followed by the top-level `settings`):

```json
    "runActionLabel": "Run"
  },
  "settings": {
```

new_string:

```json
    "runActionLabel": "Run"
  },
  "routineRuns": {
    "filters": {
      "state": "State",
      "allStates": "All states",
      "trigger": "Trigger",
      "allTriggers": "All triggers",
      "from": "From",
      "to": "To",
      "searchPlaceholder": "Search runs…",
      "needsAttention": "Needs attention",
      "showFiltered": "Show filtered"
    },
    "state": {
      "waiting": "Waiting",
      "active": "Active",
      "completed": "Completed",
      "failed": "Failed",
      "delayed": "Delayed",
      "paused": "Paused",
      "stuck": "Stuck",
      "waiting_approval": "Needs attention",
      "filtered": "Filtered",
      "cancelled": "Cancelled"
    },
    "trigger": {
      "email": "Email",
      "schedule": "Schedule",
      "manual": "Manual",
      "api": "API",
      "none": "—"
    },
    "filteredReason": {
      "sender_not_allowed": "Sender not allowed",
      "filter": "Did not match filter rules",
      "rate_limited": "Rate limited",
      "duplicate": "Duplicate",
      "auto_reply": "Auto-reply"
    },
    "row": {
      "openSession": "Open session",
      "cancel": "Cancel run",
      "retry": "Retry run",
      "showRaw": "Show raw JSON",
      "hideRaw": "Hide raw JSON",
      "errorHeading": "Error",
      "filteredReason": "Filtered because",
      "failedRule": "Failed rule",
      "messageId": "Message ID",
      "from": "From",
      "subject": "Subject",
      "cron": "Cron",
      "tries": "Attempts"
    },
    "cancelConfirm": {
      "title": "Cancel this run?",
      "description": "The run is stopped and marked as cancelled. Steps that already ran are not undone.",
      "confirmLabel": "Cancel run"
    },
    "toast": {
      "cancelled": "Run cancelled",
      "cancelFailed": "Could not cancel run",
      "retried": "Run re-queued",
      "retryFailed": "Could not retry run"
    },
    "emptyTitle": "No runs",
    "emptyDescription": "No runs match the current filters.",
    "pagination": "Page {page} of {pages}",
    "previousPage": "Previous page",
    "nextPage": "Next page"
  },
  "settings": {
```

- [ ] 2.3 Add the German namespace to `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/messages/de.json`. Edit — old_string (same anchor shape, German value at line 3620):

```json
    "runActionLabel": "Ausführen"
  },
  "settings": {
```

new_string:

```json
    "runActionLabel": "Ausführen"
  },
  "routineRuns": {
    "filters": {
      "state": "Status",
      "allStates": "Alle Status",
      "trigger": "Auslöser",
      "allTriggers": "Alle Auslöser",
      "from": "Von",
      "to": "Bis",
      "searchPlaceholder": "Läufe durchsuchen…",
      "needsAttention": "Erfordert Aufmerksamkeit",
      "showFiltered": "Gefilterte anzeigen"
    },
    "state": {
      "waiting": "Wartend",
      "active": "Aktiv",
      "completed": "Abgeschlossen",
      "failed": "Fehlgeschlagen",
      "delayed": "Verzögert",
      "paused": "Pausiert",
      "stuck": "Hängt fest",
      "waiting_approval": "Erfordert Aufmerksamkeit",
      "filtered": "Gefiltert",
      "cancelled": "Abgebrochen"
    },
    "trigger": {
      "email": "E-Mail",
      "schedule": "Zeitplan",
      "manual": "Manuell",
      "api": "API",
      "none": "—"
    },
    "filteredReason": {
      "sender_not_allowed": "Absender nicht erlaubt",
      "filter": "Filterregeln nicht erfüllt",
      "rate_limited": "Rate-Limit erreicht",
      "duplicate": "Duplikat",
      "auto_reply": "Automatische Antwort"
    },
    "row": {
      "openSession": "Unterhaltung öffnen",
      "cancel": "Lauf abbrechen",
      "retry": "Erneut ausführen",
      "showRaw": "Rohdaten anzeigen",
      "hideRaw": "Rohdaten ausblenden",
      "errorHeading": "Fehler",
      "filteredReason": "Gefiltert wegen",
      "failedRule": "Fehlgeschlagene Regel",
      "messageId": "Message-ID",
      "from": "Von",
      "subject": "Betreff",
      "cron": "Cron",
      "tries": "Versuche"
    },
    "cancelConfirm": {
      "title": "Diesen Lauf abbrechen?",
      "description": "Der Lauf wird gestoppt und als abgebrochen markiert. Bereits ausgeführte Schritte werden nicht rückgängig gemacht.",
      "confirmLabel": "Lauf abbrechen"
    },
    "toast": {
      "cancelled": "Lauf abgebrochen",
      "cancelFailed": "Lauf konnte nicht abgebrochen werden",
      "retried": "Lauf erneut eingereiht",
      "retryFailed": "Lauf konnte nicht erneut gestartet werden"
    },
    "emptyTitle": "Keine Läufe",
    "emptyDescription": "Keine Läufe entsprechen den aktuellen Filtern.",
    "pagination": "Seite {page} von {pages}",
    "previousPage": "Vorherige Seite",
    "nextPage": "Nächste Seite"
  },
  "settings": {
```

- [ ] 2.4 Verify: message parity + lint + typecheck-via-build (the widget has no consumer yet — the build proves it compiles):
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npm run check-messages && npm run lint && npm run build
  ```
  Expected: check-messages exits 0 (no missing keys), eslint 0 errors, build succeeds.

- [ ] 2.5 Format + commit:
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx prettier --write components/widgets/routine-runs && git add components/widgets/routine-runs messages/en.json messages/de.json && git commit -m "feat(runs): shared RoutineRunsList widget with filter bar, attention lens and run actions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

### Task 3: RunsSection v2 branch in the routine workbench

**Files:**
- Modify: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/workflows/[id]/sections/runs.tsx` (rename the current exported component to `LegacyRunsSection`, add a flag dispatcher + v2 body; lines 116-188 of the current file)

**Interfaces:**
- Consumes: `RoutineRunsList` (Task 2), `ROUTINES_RUNS_V2_SUPPORTED` from `../../schema-flags` (Task 1 re-export).
- Produces: `RunsSection({ routine, onRetry })` — SAME external signature as today; `routine-workbench.tsx` needs NO change in this task.

**Steps:**

- [ ] 3.1 Edit `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/workflows/[id]/sections/runs.tsx`. First, extend the imports — old_string:

```tsx
import { GET_JOB_RESULTS_LIGHT, GET_JOB_RESULT_BY_ID } from "../../queries";
import type { Routine } from "../../types";
```

new_string:

```tsx
import { RoutineRunsList } from "@/components/widgets/routine-runs/runs-list";

import { GET_JOB_RESULTS_LIGHT, GET_JOB_RESULT_BY_ID } from "../../queries";
import { ROUTINES_RUNS_V2_SUPPORTED } from "../../schema-flags";
import type { Routine } from "../../types";
```

- [ ] 3.2 Same file: replace the component head with a dispatcher + v2 + legacy rename. Old_string (current lines 116-129):

```tsx
export interface RunsSectionProps {
  routine: Routine;
  /** Subpage hosts the run dialog → row "Retry" calls back here. */
  onRetry?: (prefill: Record<string, string>) => void;
}

export function RunsSection({ routine, onRetry }: RunsSectionProps) {
  const t = useTranslations("routines");
  const tCommon = useTranslations("common");
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [showRawById, setShowRawById] = React.useState<Record<string, boolean>>(
    {},
  );
```

new_string:

```tsx
export interface RunsSectionProps {
  routine: Routine;
  /** Subpage hosts the run dialog → row "Retry" calls back here (legacy path only). */
  onRetry?: (prefill: Record<string, string>) => void;
}

/**
 * Flag dispatcher (design §7.2): runs-v2 renders the shared RoutineRunsList
 * widget scoped to this routine (real `workflow` column filter, trigger
 * badges, needs-attention, cancel/retry/open-session). Fallback keeps the
 * byte-for-byte legacy list below. Two components — never conditional hooks.
 */
export function RunsSection(props: RunsSectionProps) {
  if (ROUTINES_RUNS_V2_SUPPORTED) {
    return <RunsSectionV2 routine={props.routine} />;
  }
  return <LegacyRunsSection {...props} />;
}

function RunsSectionV2({ routine }: { routine: Routine }) {
  const t = useTranslations("routines");
  return (
    <section id="runs" className="scroll-mt-20" tabIndex={-1}>
      <DetailSection title={t("runs.title")} defaultOpen={true}>
        <RoutineRunsList workflow={routine.id} />
      </DetailSection>
    </section>
  );
}

function LegacyRunsSection({ routine, onRetry }: RunsSectionProps) {
  const t = useTranslations("routines");
  const tCommon = useTranslations("common");
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [showRawById, setShowRawById] = React.useState<Record<string, boolean>>(
    {},
  );
```

  (The rest of the old `RunsSection` body — the `useQuery(GET_JOB_RESULTS_LIGHT...)` call through the closing brace at line 188 — stays untouched and now belongs to `LegacyRunsSection`. The `RunRow` helper below it is unchanged.)

- [ ] 3.3 Verify: lint + build; then a both-branches smoke check — temporarily set `ROUTINES_RUNS_V2_SUPPORTED = true` in `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/lib/routine-runs/flags.ts`, run `npm run build` again (proves the v2 branch compiles end-to-end), then revert the flag to `false`:
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npm run lint && npm run build
  ```
  Expected: both builds succeed; `git diff lib/routine-runs/flags.ts` is empty after the revert.

- [ ] 3.4 Format + commit:
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx prettier --write "app/(application)/workflows/[id]/sections/runs.tsx" && git add "app/(application)/workflows/[id]/sections/runs.tsx" && git commit -m "feat(routines): RunsSection v2 behind ROUTINES_RUNS_V2_SUPPORTED — shared widget, legacy list preserved

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

### Task 4: Global `/runs` page, nav entry, and polled sidebar badge

**Files:**
- Create: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/runs/layout.tsx`
- Create: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/runs/page.tsx`
- Create: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/runs/runs-client.tsx`
- Create: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/components/shell/use-runs-attention.ts`
- Modify: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/components/shell/nav-config.ts` (icon import line ~13-37; new entry after the `routines` row at lines 188-195)
- Modify: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/components/shell/nav-config.test.ts` (flag-aware expected id lists)
- Modify: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/components/shell/nav-item.tsx` (optional `badge` prop; label span block lines ~103-129, sharedProps lines ~131-136, tooltip lines ~168-183)
- Modify: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/components/shell/nav-group.tsx` (thread `badges` prop; props interface lines ~51-75, menu render lines ~159-165)
- Modify: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/components/shell/app-sidebar.tsx` (hook + badges pass-through; imports lines ~30-53, body lines ~74-92, NavGroup render lines ~136-146)
- Modify: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/messages/en.json` + `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/messages/de.json` (`navigation.runs` + new top-level `runs` namespace)

**Interfaces:**
- Consumes: `ROUTINES_RUNS_V2_SUPPORTED` from `@/lib/routine-runs/flags` (shell may import lib, NOT app), `ROUTINE_RUNS_ATTENTION_COUNT` from `@/lib/routine-runs/queries`, `RoutineRunsList` (Task 2), `guardRoute` from `@/lib/route-guard`, `can`/`RightsUser` from `@/lib/rights`.
- Produces: `useRunsAttentionCount(user: RightsUser | null | undefined): number` (shell hook, ~10s poll, 60s error backoff); `NavItemProps.badge?: number`; `NavGroupProps.badges?: Readonly<Partial<Record<string, number>>>`; nav entry `{ id: "runs", group: "build", route: "/runs", requires: { area: "workflows", level: "read" } }` present iff `ROUTINES_RUNS_V2_SUPPORTED`.

**Steps:**

- [ ] 4.1 TDD the nav table change. Edit `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/components/shell/nav-config.test.ts` to make the expectations flag-aware. Old_string:

```ts
import type { RightArea, RightsUser } from "@/lib/rights";
import type { UserRole } from "@/types/models/user-role";
```

new_string:

```ts
import type { RightArea, RightsUser } from "@/lib/rights";
import { ROUTINES_RUNS_V2_SUPPORTED } from "@/lib/routine-runs/flags";
import type { UserRole } from "@/types/models/user-role";

/** The runs entry ships flag-gated (email-routines design §7.3). */
const RUNS_ROWS = ROUTINES_RUNS_V2_SUPPORTED ? ["runs"] : [];
```

- [ ] 4.2 Same test file — splice `RUNS_ROWS` into every expected list that contains `"routines"`. Four edits:

  (a) old_string:
```ts
      "skills",
      "routines",
      "automation",
      "feedback",
      "evals",
```
  new_string:
```ts
      "skills",
      "routines",
      ...RUNS_ROWS,
      "automation",
      "feedback",
      "evals",
```

  (b) old_string:
```ts
  it("workflows:read → routines + automation (n8n flag on)", () => {
    expect(ids(userWith({ workflows: "read" }))).toEqual([
      "home",
      ...ALL_USER_BODY,
      "routines",
      "automation",
      ...FOOTER,
    ]);
  });
```
  new_string:
```ts
  it("workflows:read → routines + runs (flagged) + automation (n8n flag on)", () => {
    expect(ids(userWith({ workflows: "read" }))).toEqual([
      "home",
      ...ALL_USER_BODY,
      "routines",
      ...RUNS_ROWS,
      "automation",
      ...FOOTER,
    ]);
  });
```

  (c) old_string:
```ts
    ).toEqual([
      "agents",
      "knowledge",
      "prompts",
      "skills",
      "routines",
      "automation",
      "feedback",
    ]);
```
  new_string:
```ts
    ).toEqual([
      "agents",
      "knowledge",
      "prompts",
      "skills",
      "routines",
      ...RUNS_ROWS,
      "automation",
      "feedback",
    ]);
```

  (d) old_string:
```ts
    ).toEqual([
      "agents",
      "knowledge",
      "prompts",
      "skills",
      "routines",
      "automation",
    ]);
```
  new_string:
```ts
    ).toEqual([
      "agents",
      "knowledge",
      "prompts",
      "skills",
      "routines",
      ...RUNS_ROWS,
      "automation",
    ]);
```

- [ ] 4.3 Same test file — add an active-route case inside the `describe("activeEntryFor` block. Old_string:

```ts
  it("matches the root path to Home", () => {
    expect(activeEntryFor("/")?.id).toBe("home");
  });
```

new_string:

```ts
  it("matches the root path to Home", () => {
    expect(activeEntryFor("/")?.id).toBe("home");
  });

  it("matches /runs to the flag-gated runs entry", () => {
    expect(activeEntryFor("/runs")?.id ?? null).toBe(
      ROUTINES_RUNS_V2_SUPPORTED ? "runs" : null,
    );
  });
```

- [ ] 4.4 Prove both flag branches. With the flag still `false`, run:
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx vitest run components/shell/nav-config.test.ts
  ```
  Expected: PASS (RUNS_ROWS is empty). Then temporarily set `ROUTINES_RUNS_V2_SUPPORTED = true` in `lib/routine-runs/flags.ts` and re-run — expected FAIL: `expected [ …, 'routines', 'automation', … ] to deeply equal [ …, 'routines', 'runs', 'automation', … ]` (the entry doesn't exist yet). Keep the flag at `true` until step 4.6 verifies, then revert.

- [ ] 4.5 Add the nav entry. Edit `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/components/shell/nav-config.ts`:

  (a) icon import — old_string:
```ts
import {
  BarChart3,
  BookCheck,
  Bot,
  Brain,
```
  new_string:
```ts
import {
  Activity,
  BarChart3,
  BookCheck,
  Bot,
  Brain,
```

  (b) flag import — old_string:
```ts
import { can, type Requirement, type RightsUser } from "@/lib/rights";
```
  new_string:
```ts
import { can, type Requirement, type RightsUser } from "@/lib/rights";
import { ROUTINES_RUNS_V2_SUPPORTED } from "@/lib/routine-runs/flags";
```
  (Note: `@/lib/*` is legal in the shell tier — only `@/app/*` is banned, which is why the flag lives in lib.)

  (c) the entry, directly after the `routines` row — old_string:
```ts
  {
    id: "routines",
    group: "build",
    route: "/workflows",
    i18nKey: "navigation.routines",
    icon: ListChecks,
    // Read role gets the item + read-only page (workflows.md row 187).
    requires: { area: "workflows", level: "read" },
  },
```
  new_string:
```ts
  {
    id: "routines",
    group: "build",
    route: "/workflows",
    i18nKey: "navigation.routines",
    icon: ListChecks,
    // Read role gets the item + read-only page (workflows.md row 187).
    requires: { area: "workflows", level: "read" },
  },
  // Global runs console (email-routines design §7.3) — ships flag-gated so
  // the frontend can merge before the Plan-1 backend. The /runs layout
  // guards with the same inline requirement (flag-independent).
  ...(ROUTINES_RUNS_V2_SUPPORTED
    ? ([
        {
          id: "runs",
          group: "build",
          route: "/runs",
          i18nKey: "navigation.runs",
          icon: Activity,
          requires: { area: "workflows", level: "read" },
        },
      ] as const)
    : []),
```

- [ ] 4.6 Re-run the nav tests (flag still `true` from step 4.4) — expected PASS. Then revert `lib/routine-runs/flags.ts` to `ROUTINES_RUNS_V2_SUPPORTED = false` and run once more — expected PASS again:
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx vitest run components/shell/nav-config.test.ts && git diff --stat lib/routine-runs/flags.ts
  ```
  Expected final state: tests green, `git diff` on flags.ts empty.

- [ ] 4.7 Create the badge hook `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/components/shell/use-runs-attention.ts`:

```ts
"use client";

/**
 * useRunsAttentionCount — the sidebar's needs-attention badge feed
 * (email-routines design §7.3): polls routineRunsNeedingAttentionCount
 * every ~10 s, backing off to 60 s while the query errors (recovers on the
 * next success). Zero network unless ROUTINES_RUNS_V2_SUPPORTED AND the
 * account can read workflows — mirrors the /runs nav entry's gate exactly.
 *
 * Shell tier: lib + Apollo imports only (no app/*).
 */

import { useQuery } from "@apollo/client";
import * as React from "react";

import { can, type RightsUser } from "@/lib/rights";
import { ROUTINES_RUNS_V2_SUPPORTED } from "@/lib/routine-runs/flags";
import { ROUTINE_RUNS_ATTENTION_COUNT } from "@/lib/routine-runs/queries";

const BASE_POLL_MS = 10_000;
const ERROR_POLL_MS = 60_000;

export function useRunsAttentionCount(
  user: RightsUser | null | undefined,
): number {
  const [pollInterval, setPollInterval] = React.useState(BASE_POLL_MS);

  const enabled =
    ROUTINES_RUNS_V2_SUPPORTED &&
    !!user &&
    can(user, { area: "workflows", level: "read" });

  const { data } = useQuery<{
    routineRunsNeedingAttentionCount?: number;
  }>(ROUTINE_RUNS_ATTENTION_COUNT, {
    skip: !enabled,
    pollInterval,
    fetchPolicy: "no-cache",
    onCompleted: () => setPollInterval(BASE_POLL_MS),
    onError: () => setPollInterval(ERROR_POLL_MS),
  });

  if (!enabled) return 0;
  const count = data?.routineRunsNeedingAttentionCount;
  return typeof count === "number" && count > 0 ? Math.round(count) : 0;
}
```

- [ ] 4.8 Add the badge to `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/components/shell/nav-item.tsx`. Three edits:

  (a) props — old_string:
```ts
  /**
   * Fires on activation. Required for route-less entries (`route: null`,
   * e.g. send-feedback opens the FeedbackDialog); the mobile drawer also
   * uses it to close on navigate.
   */
  onSelect?: (entry: NavEntry) => void;
  className?: string;
}
```
  new_string:
```ts
  /**
   * Fires on activation. Required for route-less entries (`route: null`,
   * e.g. send-feedback opens the FeedbackDialog); the mobile drawer also
   * uses it to close on navigate.
   */
  onSelect?: (entry: NavEntry) => void;
  /**
   * Numeric attention badge (e.g. runs needing approval). Hidden at 0;
   * capped at "99+". Rail mode surfaces the count in the tooltip instead
   * of a chip. Announced to AT via the aria-label.
   */
  badge?: number;
  className?: string;
}
```

  (b) destructure + display value + label + chip. Old_string:
```tsx
const NavItem = React.forwardRef<HTMLLIElement, NavItemProps>(
  ({ entry, shortcut, onSelect, className }, ref) => {
    const t = useTranslations();
    const pathname = usePathname();
    const { state, isMobile } = useSidebar();
    const reducedMotion = useReducedMotion() ?? false;

    const label = t(entry.i18nKey);
    const Icon = entry.icon;
```
  new_string:
```tsx
const NavItem = React.forwardRef<HTMLLIElement, NavItemProps>(
  ({ entry, shortcut, onSelect, badge, className }, ref) => {
    const t = useTranslations();
    const pathname = usePathname();
    const { state, isMobile } = useSidebar();
    const reducedMotion = useReducedMotion() ?? false;

    const label = t(entry.i18nKey);
    const badgeCount =
      typeof badge === "number" && badge > 0
        ? badge > 99
          ? "99+"
          : String(badge)
        : null;
    const ariaLabel = badgeCount ? `${label} (${badgeCount})` : label;
    const Icon = entry.icon;
```

  (c) render the chip after the animated label span. Old_string:
```tsx
        </AnimatePresence>
      </>
    );

    const sharedProps = {
      "aria-label": label,
```
  new_string:
```tsx
        </AnimatePresence>
        {badgeCount && !isRail ? (
          <span
            aria-hidden="true"
            className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-warning/15 px-1.5 text-[11px] font-medium tabular-nums text-warning"
          >
            {badgeCount}
          </span>
        ) : null}
      </>
    );

    const sharedProps = {
      "aria-label": ariaLabel,
```

  (d) tooltip count for rail mode. Old_string:
```tsx
            <span>{label}</span>
            {shortcut ? (
```
  new_string:
```tsx
            <span>{label}</span>
            {badgeCount ? (
              <span className="tabular-nums text-warning">{badgeCount}</span>
            ) : null}
            {shortcut ? (
```

- [ ] 4.9 Thread badges through `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/components/shell/nav-group.tsx`. Two edits:

  (a) old_string:
```ts
  /** Forwarded to every item (e.g. the mobile drawer closes on navigate). */
  onSelect?: (entry: NavEntry) => void;
  className?: string;
}
```
  new_string:
```ts
  /** Forwarded to every item (e.g. the mobile drawer closes on navigate). */
  onSelect?: (entry: NavEntry) => void;
  /** Per-entry-id attention counts, forwarded to NavItem's `badge`. */
  badges?: Readonly<Partial<Record<string, number>>>;
  className?: string;
}
```

  (b) old_string (add `badges` to the destructure — current lines 94-106):
```tsx
    {
      group,
      entries,
      collapsible = false,
      suppressHeader = false,
      first = false,
      onSelect,
      className,
    },
```
  new_string:
```tsx
    {
      group,
      entries,
      collapsible = false,
      suppressHeader = false,
      first = false,
      onSelect,
      badges,
      className,
    },
```

  (c) old_string:
```tsx
    const menu = (
      <SidebarMenu aria-labelledby={suppressHeader ? undefined : labelId}>
        {entries.map((entry) => (
          <NavItem key={entry.id} entry={entry} onSelect={onSelect} />
        ))}
      </SidebarMenu>
    );
```
  new_string:
```tsx
    const menu = (
      <SidebarMenu aria-labelledby={suppressHeader ? undefined : labelId}>
        {entries.map((entry) => (
          <NavItem
            key={entry.id}
            entry={entry}
            onSelect={onSelect}
            badge={badges?.[entry.id]}
          />
        ))}
      </SidebarMenu>
    );
```

- [ ] 4.10 Wire the hook in `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/components/shell/app-sidebar.tsx`. Two edits:

  (a) old_string:
```tsx
import { NavGroup } from "@/components/shell/nav-group";
import { NavItem } from "@/components/shell/nav-item";
```
  new_string:
```tsx
import { NavGroup } from "@/components/shell/nav-group";
import { NavItem } from "@/components/shell/nav-item";
import { useRunsAttentionCount } from "@/components/shell/use-runs-attention";
```

  (b) old_string:
```tsx
  const tree = React.useMemo<SidebarTree>(
    () => (user ? groupsFor(user, config ?? {}) : EMPTY_TREE),
    [user, config],
  );
```
  new_string:
```tsx
  const tree = React.useMemo<SidebarTree>(
    () => (user ? groupsFor(user, config ?? {}) : EMPTY_TREE),
    [user, config],
  );

  // Needs-attention badge on the flag-gated /runs entry (design §7.3).
  const runsAttentionCount = useRunsAttentionCount(user);
  const badges = React.useMemo<Partial<Record<string, number>>>(
    () => ({ runs: runsAttentionCount }),
    [runsAttentionCount],
  );
```

  (c) old_string:
```tsx
          <NavGroup
            key={view.group}
            group={view.group}
            entries={view.entries}
            collapsible={view.collapsible}
            suppressHeader={tree.suppressGroupHeaders}
            first={index === 0}
            onSelect={handleSelect}
          />
```
  new_string:
```tsx
          <NavGroup
            key={view.group}
            group={view.group}
            entries={view.entries}
            collapsible={view.collapsible}
            suppressHeader={tree.suppressGroupHeaders}
            first={index === 0}
            onSelect={handleSelect}
            badges={badges}
          />
```

- [ ] 4.11 Create the route. `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/runs/layout.tsx`:

```tsx
// Server-side route guard for /runs — same predicate as the flag-gated nav
// entry (workflows:read). Guarded with an INLINE requirement (not the nav id)
// because the nav entry only exists while ROUTINES_RUNS_V2_SUPPORTED is true,
// and guardRoute("runs") would throw on the id while the flag is off.
import type { ReactNode } from "react";

import { guardRoute } from "@/lib/route-guard";

export default async function RunsLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (await guardRoute({ area: "workflows", level: "read" })) ?? children;
}
```

- [ ] 4.12 Create `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/runs/page.tsx`:

```tsx
/**
 * /runs — global runs console (email-routines design §7.3). Thin server
 * page; the guard lives in layout.tsx. `?workflow=<id>` (used by the chat
 * run banner) pre-scopes the list to one routine.
 */
import { RunsClient } from "./runs-client";

export const dynamic = "force-dynamic";

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ workflow?: string }>;
}) {
  const { workflow } = await searchParams;
  return <RunsClient workflow={workflow} />;
}
```

- [ ] 4.13 Create `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/runs/runs-client.tsx`:

```tsx
"use client";

/**
 * RunsClient — the /runs page body: PageHeader + the shared RoutineRunsList
 * across all readable routines (routine column on, needs-attention lens on
 * by default — design §7.3). Honest EmptyState while the backend flag is
 * off (the nav entry is hidden then; this covers direct URL hits).
 */

import { Activity } from "lucide-react";
import { useTranslations } from "next-intl";

import { EmptyState } from "@/components/primitives/empty-state";
import { PageHeader } from "@/components/primitives/page-header";
import { PageShell } from "@/components/primitives/page-shell";
import { RoutineRunsList } from "@/components/widgets/routine-runs/runs-list";
import { ROUTINES_RUNS_V2_SUPPORTED } from "@/lib/routine-runs/flags";

export function RunsClient({ workflow }: { workflow?: string }) {
  const t = useTranslations("runs");

  if (!ROUTINES_RUNS_V2_SUPPORTED) {
    return (
      <PageShell variant="content">
        <EmptyState
          variant="quiet"
          icon={Activity}
          title={t("unavailableTitle")}
          description={t("unavailableDescription")}
        />
      </PageShell>
    );
  }

  return (
    <PageShell variant="content">
      <PageHeader title={t("title")} description={t("description")} />
      <RoutineRunsList
        workflow={workflow}
        showRoutineColumn
        defaultNeedsAttention={!workflow}
      />
    </PageShell>
  );
}
```

- [ ] 4.14 i18n. `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/messages/en.json` — two edits:

  (a) navigation label — old_string:
```json
    "routines": "Routines",
    "search": "Search…",
```
  new_string:
```json
    "routines": "Routines",
    "runs": "Runs",
    "search": "Search…",
```

  (b) page namespace — old_string (the anchor Task 2 left in place):
```json
  "settings": {
```
  new_string:
```json
  "runs": {
    "title": "Runs",
    "description": "Every routine run across your workspace — items needing attention first.",
    "unavailableTitle": "Runs isn't available yet",
    "unavailableDescription": "This page needs a backend that supports the routine-runs API."
  },
  "settings": {
```
  (`"settings": {` at two-space indent is unique — `navigation.settings` is a string, not an object.)

- [ ] 4.15 `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/messages/de.json` — same two edits:

  (a) old_string:
```json
    "routines": "Routinen",
    "search": "Suchen…",
```
  new_string:
```json
    "routines": "Routinen",
    "runs": "Läufe",
    "search": "Suchen…",
```

  (b) old_string:
```json
  "settings": {
```
  new_string:
```json
  "runs": {
    "title": "Läufe",
    "description": "Alle Routine-Läufe in Ihrem Arbeitsbereich — Einträge mit Handlungsbedarf zuerst.",
    "unavailableTitle": "Läufe ist noch nicht verfügbar",
    "unavailableDescription": "Diese Seite benötigt ein Backend, das die Routine-Läufe-API unterstützt."
  },
  "settings": {
```

- [ ] 4.16 Verify:
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npm run check-messages && npm run lint && npm test && npm run build
  ```
  Expected: all green (nav tests pass with the flag false; `/runs` compiles as a static-guarded dynamic route).

- [ ] 4.17 Format + commit:
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx prettier --write "app/(application)/runs" components/shell/use-runs-attention.ts components/shell/nav-config.ts components/shell/nav-config.test.ts components/shell/nav-item.tsx components/shell/nav-group.tsx components/shell/app-sidebar.tsx && git add "app/(application)/runs" components/shell messages/en.json messages/de.json && git commit -m "feat(runs): global /runs page, flag-gated nav entry and polled needs-attention badge

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

### Task 5: Chat session banner for run-linked sessions

**Files:**
- Modify: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/chat/queries.ts` (add `metadata` to `GET_AGENT_SESSION_BY_ID`, lines 235-261 — `agent_sessions.metadata` is an EXISTING core-schema json field, `src/postgres/core-schema.ts:85-88`, so no flag is needed on the selection)
- Create: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/chat/components/run-session-banner.tsx`
- Modify: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/chat/components/session-screen.tsx` (mount the banner between ChatHeader and MessageColumn, lines 62-65)
- Modify: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/messages/en.json` + `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/messages/de.json` (`chat.runBanner.*`)

**Interfaces:**
- Consumes: `ROUTINE_RUN_FOR_SESSION`, `ROUTINE_NAME_BY_ID` from `@/lib/routine-runs/queries` (Task 1); `RUN_STATE_BADGE`, `ALL_RUN_STATES`, `isTerminalRunState`, `triggerBadge` from `@/lib/routine-runs/presentation`; `AgentSession` from `@/types/models/agent-session` (already has `metadata: any`); Plan-1 session metadata contract `{ routine_id, job_result_id, trigger }`.
- Produces: `RunSessionBanner({ session }: { session: AgentSession })` — renders `null` unless `ROUTINES_RUNS_V2_SUPPORTED` AND `session.metadata.job_result_id` is set, so mounting it unconditionally is safe today.

**Steps:**

- [ ] 5.1 Edit `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/chat/queries.ts` — old_string:

```graphql
        title
        agent
        created_by
        rights_mode
        session_items
        project
```

new_string:

```graphql
        title
        agent
        created_by
        rights_mode
        session_items
        metadata
        project
```

- [ ] 5.2 Create `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/chat/components/run-session-banner.tsx`:

```tsx
"use client";

/**
 * RunSessionBanner — slim banner above the conversation when the opened
 * session belongs to a routine run (email-routines design §7.4): routine
 * name, trigger, live run state, link back to the run (global /runs page,
 * pre-scoped to the routine). The approval card itself is the untouched
 * tool-call-approval.tsx; this banner only reflects the run's state — it
 * polls every 10 s while the run is non-terminal so a resolved approval
 * shows the resumed state without a manual refresh.
 *
 * Renders null unless ROUTINES_RUNS_V2_SUPPORTED and the session's Plan-1
 * metadata cross-link ({ routine_id, job_result_id, trigger }) is present —
 * mounting it unconditionally in SessionScreen is free today.
 *
 * Data via lib/routine-runs (chat may not import the workflows feature —
 * eslint feature isolation). Both lookups use errorPolicy "all": a caller
 * without routine read access simply gets no name / no run row, and the
 * banner degrades gracefully (fallback name) or hides (no run row).
 */

import { useQuery } from "@apollo/client";
import { ListChecks } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ROUTINES_RUNS_V2_SUPPORTED } from "@/lib/routine-runs/flags";
import {
  ALL_RUN_STATES,
  isTerminalRunState,
  RUN_STATE_BADGE,
  triggerBadge,
} from "@/lib/routine-runs/presentation";
import {
  ROUTINE_NAME_BY_ID,
  ROUTINE_RUN_FOR_SESSION,
} from "@/lib/routine-runs/queries";
import { cn } from "@/lib/utils";
import type { AgentSession } from "@/types/models/agent-session";

import { CHAT_COLUMN } from "./chat-shell";

/** Plan-1 session.metadata cross-link shape (design §3.4). */
interface RunLinkMetadata {
  routine_id?: string;
  job_result_id?: string;
  trigger?: string;
}

const POLL_MS = 10_000;

export function RunSessionBanner({ session }: { session: AgentSession }) {
  const t = useTranslations("chat.runBanner");
  const tState = useTranslations("routineRuns.state");
  const tTrigger = useTranslations("routineRuns.trigger");

  const meta = (session.metadata ?? null) as RunLinkMetadata | null;
  const jobResultId =
    typeof meta?.job_result_id === "string" && meta.job_result_id !== ""
      ? meta.job_result_id
      : null;
  const routineId =
    typeof meta?.routine_id === "string" && meta.routine_id !== ""
      ? meta.routine_id
      : null;
  const enabled = ROUTINES_RUNS_V2_SUPPORTED && jobResultId !== null;

  const { data, stopPolling } = useQuery<{
    job_resultById?: {
      id: string;
      state: string;
      trigger?: string | null;
      workflow?: string | null;
    } | null;
  }>(ROUTINE_RUN_FOR_SESSION, {
    variables: { id: jobResultId ?? "" },
    skip: !enabled,
    pollInterval: POLL_MS,
    fetchPolicy: "cache-and-network",
    errorPolicy: "all",
  });

  const run = data?.job_resultById ?? null;

  // Terminal runs never change again — stop the poller.
  React.useEffect(() => {
    if (run && isTerminalRunState(run.state)) stopPolling();
  }, [run, stopPolling]);

  const { data: routineData } = useQuery<{
    workflow_templateById?: { id: string; name?: string | null } | null;
  }>(ROUTINE_NAME_BY_ID, {
    variables: { id: routineId ?? "" },
    skip: !enabled || routineId === null,
    fetchPolicy: "cache-first",
    errorPolicy: "all",
  });

  if (!enabled || !run) return null;

  const routineName =
    routineData?.workflow_templateById?.name ?? t("fallbackName");
  const badge = triggerBadge({
    trigger: typeof meta?.trigger === "string" ? meta.trigger : run.trigger,
    trigger_metadata: null,
  });
  const stateLabel = (ALL_RUN_STATES as readonly string[]).includes(run.state)
    ? tState(run.state)
    : run.state;
  const runsHref = run.workflow ? `/runs?workflow=${run.workflow}` : "/runs";

  return (
    <div className={cn(CHAT_COLUMN, "shrink-0 pt-2")}>
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
        <ListChecks
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 truncate">
          {t("label", { name: routineName })}
        </span>
        {badge.key !== "none" ? (
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {tTrigger(badge.key)}
          </Badge>
        ) : null}
        <Badge
          variant="outline"
          className={cn(RUN_STATE_BADGE[run.state] ?? "")}
        >
          {stateLabel}
        </Badge>
        <Button asChild variant="ghost" size="sm" className="ml-auto">
          <Link href={runsHref}>{t("viewRun")}</Link>
        </Button>
      </div>
    </div>
  );
}
```

- [ ] 5.3 Mount it in `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/chat/components/session-screen.tsx`. Two edits:

  (a) old_string:
```tsx
import { useChatSession } from "../hooks";
import { CHAT_COLUMN } from "./chat-shell";
import { ChatHeader } from "./chat-header";
```
  new_string:
```tsx
import { useChatSession } from "../hooks";
import { CHAT_COLUMN } from "./chat-shell";
import { ChatHeader } from "./chat-header";
import { RunSessionBanner } from "./run-session-banner";
```

  (b) old_string:
```tsx
        <ChatHeader controller={controller} />

        {/* Conversation — MessageColumn owns the scroll container (V2). */}
        <MessageColumn controller={controller} />
```
  new_string:
```tsx
        <ChatHeader controller={controller} />

        {/* Run-linked sessions get a slim banner (design §7.4) — renders
            null unless the session carries Plan-1 run metadata. */}
        {initialSession ? <RunSessionBanner session={initialSession} /> : null}

        {/* Conversation — MessageColumn owns the scroll container (V2). */}
        <MessageColumn controller={controller} />
```

- [ ] 5.4 i18n. `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/messages/en.json` — old_string:

```json
  "chat": {
    "agentSelect": {
```

new_string:

```json
  "chat": {
    "runBanner": {
      "label": "Routine run — {name}",
      "fallbackName": "Routine",
      "viewRun": "View run"
    },
    "agentSelect": {
```

- [ ] 5.5 `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/messages/de.json` — old_string:

```json
  "chat": {
    "agentSelect": {
```

new_string:

```json
  "chat": {
    "runBanner": {
      "label": "Routine-Lauf — {name}",
      "fallbackName": "Routine",
      "viewRun": "Lauf anzeigen"
    },
    "agentSelect": {
```

- [ ] 5.6 Verify:
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npm run check-messages && npm run lint && npm run build
  ```
  Expected: all green. The `metadata` selection addition is safe against today's backend (existing core-schema field); with the flag off the banner component renders null and issues zero queries (`skip: true`).

- [ ] 5.7 Format + commit:
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx prettier --write "app/(application)/chat/components/run-session-banner.tsx" "app/(application)/chat/components/session-screen.tsx" "app/(application)/chat/queries.ts" && git add "app/(application)/chat" messages/en.json messages/de.json && git commit -m "feat(chat): run-session banner linking run-backed sessions to their routine run

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

### Task 6: TriggersSection in the routine workbench (config helpers TDD, GraphQL ops, section, registration, i18n)

**Files:**
- Create: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/workflows/[id]/sections/trigger-config.test.ts`
- Create: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/workflows/[id]/sections/trigger-config.ts`
- Create: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/lib/email-inbound/queries.ts` (shared with Task 7's admin surface — features may not import each other)
- Create: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/workflows/[id]/sections/triggers.tsx`
- Modify: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/workflows/queries.ts` (append trigger ops after `DELETE_WORKFLOW_SCHEDULE`, line ~236)
- Modify: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/workflows/[id]/components/routine-workbench.tsx` (section ids line 83-91, filter lines 116-122, JSX line 187, imports lines 73-79)
- Modify: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/messages/en.json` + `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/messages/de.json` (`routines.triggers.*` + `routines.editor.sections.triggers`)

**Interfaces:**
- Consumes: `upsertWorkflowEmailTrigger(workflow: ID!, enabled: Boolean!, config: JSON!)`, `workflowTriggers(workflow: ID!)`, `deleteWorkflowTrigger(id: ID!)`, `emailInboundConfig` (Plan-2 contract, verbatim); `ROUTINES_EMAIL_TRIGGER_SUPPORTED` from `../../schema-flags`; `RoutineAccess` from `../../types`; `UserContext` from `@/app/(application)/authenticated` (root-level file — NOT a feature folder, so the cross-feature ban does not apply; precedent: `components/message-renderer.tsx:23`).
- Produces:
  - `trigger-config.ts`: `FILTER_FIELDS`, `FilterField`, `EmailTriggerFilterRule`, `EmailTriggerConfig`, `WorkflowTriggerRow`, `DEFAULT_EMAIL_TRIGGER_CONFIG`, `MAX_FILTER_PATTERN_LENGTH = 200`, `isValidSenderEntry(entry: string): boolean`, `validateFilterPattern(pattern: string): PatternValidation`, `normalizeEmailTriggerConfig(input: unknown): EmailTriggerConfig`
  - `lib/email-inbound/queries.ts`: `EmailInboundConfig` interface, `EMAIL_INBOUND_CONFIG`, `UPDATE_EMAIL_INBOUND_CONFIG`
  - `triggers.tsx`: `TriggersSection({ routine, access }: { routine: Routine; access: RoutineAccess })`
- RBAC note (design §3.1): triggers carry NO RBAC payload — the server checks routine write access (users/roles/**teams** included) + `workflows: write` and captures `run_as_user`/`run_as_role` itself. The frontend therefore sends no rights data here, so the historical teams-drop bug cannot recur in this payload; the RBAC-carrying routine create/update payloads are untouched by this plan.

**Steps:**

- [ ] 6.1 Write the failing test `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/workflows/[id]/sections/trigger-config.test.ts`:

```ts
// Unit tests for the email-trigger config helpers (pure module).

import { describe, expect, it } from "vitest";

import {
  DEFAULT_EMAIL_TRIGGER_CONFIG,
  FILTER_FIELDS,
  isValidSenderEntry,
  MAX_FILTER_PATTERN_LENGTH,
  normalizeEmailTriggerConfig,
  validateFilterPattern,
} from "./trigger-config";

describe("FILTER_FIELDS", () => {
  it("matches the design §3.1 field union", () => {
    expect(FILTER_FIELDS).toEqual(["from", "subject", "body", "attachment_name"]);
  });
});

describe("isValidSenderEntry", () => {
  it("accepts exact addresses (case-insensitive)", () => {
    expect(isValidSenderEntry("service@kone.com")).toBe(true);
    expect(isValidSenderEntry("Service@KONE.com")).toBe(true);
    expect(isValidSenderEntry("first.last+tag@sub.example.co")).toBe(true);
  });
  it("accepts *@domain globs", () => {
    expect(isValidSenderEntry("*@kone.com")).toBe(true);
    expect(isValidSenderEntry("*@sub.example.co")).toBe(true);
  });
  it("rejects everything else", () => {
    expect(isValidSenderEntry("")).toBe(false);
    expect(isValidSenderEntry("   ")).toBe(false);
    expect(isValidSenderEntry("kone.com")).toBe(false);
    expect(isValidSenderEntry("@kone.com")).toBe(false);
    expect(isValidSenderEntry("*@")).toBe(false);
    expect(isValidSenderEntry("a b@kone.com")).toBe(false);
    expect(isValidSenderEntry("*@*.com")).toBe(false);
    expect(isValidSenderEntry("user@nodot")).toBe(false);
  });
});

describe("validateFilterPattern", () => {
  it("accepts a sane regex", () => {
    expect(validateFilterPattern("Ersatzteil|spare part")).toEqual({ ok: true });
  });
  it("rejects empty / whitespace-only", () => {
    expect(validateFilterPattern("")).toEqual({ ok: false, reason: "empty" });
    expect(validateFilterPattern("   ")).toEqual({ ok: false, reason: "empty" });
  });
  it("rejects patterns over the 200-char server cap (design §8)", () => {
    expect(MAX_FILTER_PATTERN_LENGTH).toBe(200);
    expect(validateFilterPattern("a".repeat(201))).toEqual({
      ok: false,
      reason: "too_long",
    });
    expect(validateFilterPattern("a".repeat(200))).toEqual({ ok: true });
  });
  it("rejects syntactically invalid regexes", () => {
    expect(validateFilterPattern("([unclosed")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("normalizeEmailTriggerConfig", () => {
  it("fills the design §3.1 defaults from nothing", () => {
    expect(normalizeEmailTriggerConfig(undefined)).toEqual(
      DEFAULT_EMAIL_TRIGGER_CONFIG,
    );
    expect(DEFAULT_EMAIL_TRIGGER_CONFIG).toEqual({
      allowed_senders: [],
      filters: [],
      filtered_run_retention: 200,
      rate_limit_per_hour: 60,
      sender_rate_limit_per_hour: 10,
    });
  });
  it("keeps valid values and drops malformed entries", () => {
    expect(
      normalizeEmailTriggerConfig({
        allowed_senders: ["a@b.co", "", 5, "*@kone.com"],
        filters: [
          { field: "subject", pattern: "spare" },
          { field: "nope", pattern: "x" },
          "garbage",
        ],
        filtered_run_retention: 50,
        rate_limit_per_hour: 120,
        sender_rate_limit_per_hour: 5,
      }),
    ).toEqual({
      allowed_senders: ["a@b.co", "*@kone.com"],
      filters: [{ field: "subject", pattern: "spare" }],
      filtered_run_retention: 50,
      rate_limit_per_hour: 120,
      sender_rate_limit_per_hour: 5,
    });
  });
  it("clamps numbers (retention ≥ 0, rates ≥ 1) and falls back on junk", () => {
    // Retention 0 is intentionally allowed: the backend accepts retention 0 = keep no filtered rows (contract-aligned).
    const normalized = normalizeEmailTriggerConfig({
      filtered_run_retention: -3,
      rate_limit_per_hour: 0,
      sender_rate_limit_per_hour: "abc",
    });
    expect(normalized.filtered_run_retention).toBe(0);
    expect(normalized.rate_limit_per_hour).toBe(1);
    expect(normalized.sender_rate_limit_per_hour).toBe(10);
  });
});
```

- [ ] 6.2 Run it — expected FAIL (`Cannot find module './trigger-config'`):
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx vitest run "app/(application)/workflows/[id]/sections/trigger-config.test.ts"
  ```

- [ ] 6.3 Create `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/workflows/[id]/sections/trigger-config.ts`:

```ts
/**
 * Pure helpers + types for the email-trigger editor (design §3.1/§8).
 * Client-side pre-validation only — the server re-validates (length cap +
 * safe-regex) on upsertWorkflowEmailTrigger; this module keeps the form
 * honest before the round-trip. Unit-tested in trigger-config.test.ts.
 */

export const FILTER_FIELDS = [
  "from",
  "subject",
  "body",
  "attachment_name",
] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export interface EmailTriggerFilterRule {
  field: FilterField;
  pattern: string;
}

export interface EmailTriggerConfig {
  allowed_senders: string[];
  filters: EmailTriggerFilterRule[];
  filtered_run_retention: number;
  rate_limit_per_hour: number;
  sender_rate_limit_per_hour: number;
}

/** workflowTriggers row (Plan-2 WorkflowTrigger SDL). config arrives as JSON. */
export interface WorkflowTriggerRow {
  id: string;
  workflow: string;
  type: string;
  enabled: boolean;
  address: string;
  config: unknown;
  run_as_user?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export const DEFAULT_EMAIL_TRIGGER_CONFIG: EmailTriggerConfig = {
  allowed_senders: [],
  filters: [],
  filtered_run_retention: 200,
  rate_limit_per_hour: 60,
  sender_rate_limit_per_hour: 10,
};

/** Server cap (design §8) — mirrored client-side for instant feedback. */
export const MAX_FILTER_PATTERN_LENGTH = 200;

const DOMAIN_PATTERN =
  "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+";
const EXACT_SENDER_RE = new RegExp(`^[^\\s@*]+@${DOMAIN_PATTERN}$`);
const GLOB_SENDER_RE = new RegExp(`^\\*@${DOMAIN_PATTERN}$`);

/** Allowlist entry: exact address or `*@domain` glob (design §4.4 step 3). */
export function isValidSenderEntry(entry: string): boolean {
  const value = entry.trim().toLowerCase();
  if (value === "") return false;
  if (value.startsWith("*@")) return GLOB_SENDER_RE.test(value);
  return EXACT_SENDER_RE.test(value);
}

export type PatternValidation =
  | { ok: true }
  | { ok: false; reason: "empty" | "too_long" | "invalid" };

export function validateFilterPattern(pattern: string): PatternValidation {
  if (pattern.trim() === "") return { ok: false, reason: "empty" };
  if (pattern.length > MAX_FILTER_PATTERN_LENGTH) {
    return { ok: false, reason: "too_long" };
  }
  try {
    new RegExp(pattern);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true };
}

function clampInt(value: unknown, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.round(parsed));
}

/** Defensive parse of the trigger's config JSON into a fully-shaped form model. */
export function normalizeEmailTriggerConfig(input: unknown): EmailTriggerConfig {
  const raw = (input ?? {}) as Partial<Record<keyof EmailTriggerConfig, unknown>>;
  const senders = Array.isArray(raw.allowed_senders)
    ? raw.allowed_senders.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim() !== "",
      )
    : [];
  const filters = Array.isArray(raw.filters)
    ? raw.filters.filter((rule): rule is EmailTriggerFilterRule => {
        if (!rule || typeof rule !== "object") return false;
        const candidate = rule as { field?: unknown; pattern?: unknown };
        return (
          typeof candidate.pattern === "string" &&
          (FILTER_FIELDS as readonly string[]).includes(
            candidate.field as string,
          )
        );
      })
    : [];
  return {
    allowed_senders: senders,
    filters,
    filtered_run_retention: clampInt(
      raw.filtered_run_retention,
      DEFAULT_EMAIL_TRIGGER_CONFIG.filtered_run_retention,
      0,
    ),
    rate_limit_per_hour: clampInt(
      raw.rate_limit_per_hour,
      DEFAULT_EMAIL_TRIGGER_CONFIG.rate_limit_per_hour,
      1,
    ),
    sender_rate_limit_per_hour: clampInt(
      raw.sender_rate_limit_per_hour,
      DEFAULT_EMAIL_TRIGGER_CONFIG.sender_rate_limit_per_hour,
      1,
    ),
  };
}
```

- [ ] 6.4 Run the test again — expected PASS:
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx vitest run "app/(application)/workflows/[id]/sections/trigger-config.test.ts"
  ```

- [ ] 6.5 Create `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/lib/email-inbound/queries.ts` (Plan-2 config API — shared by the workflows TriggersSection CTA check and Task 7's admin surface):

```ts
/**
 * GraphQL operations + type for the Plan-2 email-inbound platform config.
 * super_admin-only on the backend; the signing key is WRITE-ONLY and never
 * returned (has_signing_key indicates presence). Lives in lib/ because both
 * the workflows feature (not-configured CTA) and the configuration feature
 * (admin surface) consume it.
 */

import { gql } from "@apollo/client";

export interface EmailInboundConfig {
  provider?: string | null;
  inbound_domain?: string | null;
  enabled?: boolean | null;
  last_webhook_at?: string | null;
  webhook_url?: string | null;
  has_signing_key?: boolean | null;
}

const EMAIL_INBOUND_SELECTION = `
  provider
  inbound_domain
  enabled
  last_webhook_at
  webhook_url
  has_signing_key
`;

export const EMAIL_INBOUND_CONFIG = gql`
  query EmailInboundConfig {
    emailInboundConfig {
      ${EMAIL_INBOUND_SELECTION}
    }
  }
`;

export const UPDATE_EMAIL_INBOUND_CONFIG = gql`
  mutation UpdateEmailInboundConfig(
    $provider: String
    $inbound_domain: String
    $enabled: Boolean
    $signing_key: String
  ) {
    updateEmailInboundConfig(
      provider: $provider
      inbound_domain: $inbound_domain
      enabled: $enabled
      signing_key: $signing_key
    ) {
      ${EMAIL_INBOUND_SELECTION}
    }
  }
`;
```

- [ ] 6.6 Append the trigger operations to `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/workflows/queries.ts`. Edit — old_string:

```ts
export const DELETE_WORKFLOW_SCHEDULE = gql`
  mutation DeleteWorkflowSchedule($workflow: ID!) {
    deleteWorkflowSchedule(workflow: $workflow) {
      status
    }
  }
`;
```

new_string:

```ts
export const DELETE_WORKFLOW_SCHEDULE = gql`
  mutation DeleteWorkflowSchedule($workflow: ID!) {
    deleteWorkflowSchedule(workflow: $workflow) {
      status
    }
  }
`;

/* ------------------------------------------------------------------------- */
/* Email trigger (Plan-2 API — every call site is gated by
   ROUTINES_EMAIL_TRIGGER_SUPPORTED; the documents are inert until then). */

const WORKFLOW_TRIGGER_SELECTION = `
  id
  workflow
  type
  enabled
  address
  config
  run_as_user
  createdAt
  updatedAt
`;

export const GET_WORKFLOW_TRIGGERS = gql`
  query GetWorkflowTriggers($workflow: ID!) {
    workflowTriggers(workflow: $workflow) {
      ${WORKFLOW_TRIGGER_SELECTION}
    }
  }
`;

export const UPSERT_WORKFLOW_EMAIL_TRIGGER = gql`
  mutation UpsertWorkflowEmailTrigger(
    $workflow: ID!
    $enabled: Boolean!
    $config: JSON!
  ) {
    upsertWorkflowEmailTrigger(
      workflow: $workflow
      enabled: $enabled
      config: $config
    ) {
      ${WORKFLOW_TRIGGER_SELECTION}
    }
  }
`;

export const DELETE_WORKFLOW_TRIGGER = gql`
  mutation DeleteWorkflowTrigger($id: ID!) {
    deleteWorkflowTrigger(id: $id) {
      id
    }
  }
`;
```

- [ ] 6.7 Create `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/workflows/[id]/sections/triggers.tsx` (complete file — mirrors the ScheduleSection pattern: DetailSection wrapper, Apollo, inline save/delete, toast contract):

```tsx
"use client";

/**
 * TriggersSection — per-routine email trigger editor for /workflows/[id]
 * (email-routines design §7.1). Mirrors the ScheduleSection pattern:
 * anchored <section> for useScrollSpy, DetailSection wrapper, Apollo
 * queries/mutations with the standard toast contract, ConfirmDialog delete.
 *
 * - Gated by ROUTINES_EMAIL_TRIGGER_SUPPORTED (also filtered out of the
 *   workbench section list — the null return here is defense in depth).
 * - "Not configured" CTA: emailInboundConfig is super_admin-only, so ONLY a
 *   definitive SA answer can veto the form. Non-SA admins get an authz error
 *   (errorPolicy "all") and see the form optimistically — the upsert
 *   mutation is the authoritative server-side gate and surfaces "email
 *   inbound not configured" as a save error.
 * - No RBAC payload: the server checks routine write access (incl. teams)
 *   + workflows:write and captures run_as_user/run_as_role itself (§3.1).
 * - The address is generated server-side on first save; the form is
 *   remounted per trigger identity (key=) so state hydrates without effects.
 */

import { useMutation, useQuery } from "@apollo/client";
import { Mail, Plus, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import { UserContext } from "@/app/(application)/authenticated";
import { ConfirmDialog } from "@/components/primitives/confirm-dialog";
import { CopyField } from "@/components/primitives/copy-field";
import { DetailSection } from "@/components/primitives/detail-section";
import { EmptyState } from "@/components/primitives/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  EMAIL_INBOUND_CONFIG,
  type EmailInboundConfig,
} from "@/lib/email-inbound/queries";

import {
  DELETE_WORKFLOW_TRIGGER,
  GET_WORKFLOW_TRIGGERS,
  UPSERT_WORKFLOW_EMAIL_TRIGGER,
} from "../../queries";
import { ROUTINES_EMAIL_TRIGGER_SUPPORTED } from "../../schema-flags";
import type { Routine, RoutineAccess } from "../../types";
import {
  DEFAULT_EMAIL_TRIGGER_CONFIG,
  FILTER_FIELDS,
  isValidSenderEntry,
  normalizeEmailTriggerConfig,
  validateFilterPattern,
  type EmailTriggerFilterRule,
  type FilterField,
  type WorkflowTriggerRow,
} from "./trigger-config";

export interface TriggersSectionProps {
  routine: Routine;
  access: RoutineAccess;
}

export function TriggersSection({ routine, access }: TriggersSectionProps) {
  const t = useTranslations("routines");
  const userContext = React.useContext(UserContext);
  const isSuperAdmin = userContext?.user?.super_admin === true;

  const configQuery = useQuery<{
    emailInboundConfig?: EmailInboundConfig | null;
  }>(EMAIL_INBOUND_CONFIG, {
    skip: !ROUTINES_EMAIL_TRIGGER_SUPPORTED,
    fetchPolicy: "cache-first",
    errorPolicy: "all",
  });

  const { data, loading, refetch } = useQuery<{
    workflowTriggers?: WorkflowTriggerRow[];
  }>(GET_WORKFLOW_TRIGGERS, {
    variables: { workflow: routine.id },
    skip: !ROUTINES_EMAIL_TRIGGER_SUPPORTED,
    fetchPolicy: "cache-and-network",
  });

  if (!ROUTINES_EMAIL_TRIGGER_SUPPORTED) return null;

  const trigger =
    (data?.workflowTriggers ?? []).find((row) => row.type === "email") ?? null;
  const inbound = configQuery.data?.emailInboundConfig;
  const knownNotConfigured =
    !configQuery.loading &&
    !configQuery.error &&
    (!inbound || inbound.enabled !== true || !inbound.inbound_domain);

  return (
    <section id="triggers" className="scroll-mt-20" tabIndex={-1}>
      <DetailSection
        title={t("triggers.title")}
        defaultOpen={true}
        meta={
          trigger
            ? trigger.enabled
              ? t("triggers.metaEnabled")
              : t("triggers.metaDisabled")
            : t("triggers.metaNone")
        }
      >
        {knownNotConfigured ? (
          <EmptyState
            variant="quiet"
            icon={Mail}
            title={t("triggers.notConfigured.title")}
            description={t("triggers.notConfigured.description")}
            action={
              isSuperAdmin
                ? {
                    label: t("triggers.notConfigured.cta"),
                    href: "/configuration/email",
                  }
                : undefined
            }
          />
        ) : loading && !data ? (
          <p className="text-sm text-muted-foreground">
            {t("triggers.loading")}
          </p>
        ) : (
          <TriggerForm
            key={trigger?.id ?? "new"}
            routine={routine}
            access={access}
            trigger={trigger}
            onSaved={refetch}
          />
        )}
      </DetailSection>
    </section>
  );
}

interface TriggerFormProps {
  routine: Routine;
  access: RoutineAccess;
  trigger: WorkflowTriggerRow | null;
  onSaved: () => Promise<unknown>;
}

function TriggerForm({ routine, access, trigger, onSaved }: TriggerFormProps) {
  const t = useTranslations("routines");
  const initial = React.useMemo(
    () =>
      trigger
        ? normalizeEmailTriggerConfig(trigger.config)
        : DEFAULT_EMAIL_TRIGGER_CONFIG,
    [trigger],
  );

  const [enabled, setEnabled] = React.useState(trigger?.enabled ?? false);
  const [senders, setSenders] = React.useState<string[]>(
    initial.allowed_senders,
  );
  const [senderInput, setSenderInput] = React.useState("");
  const [filters, setFilters] = React.useState<EmailTriggerFilterRule[]>(
    initial.filters,
  );
  const [retention, setRetention] = React.useState(
    initial.filtered_run_retention,
  );
  const [ratePerHour, setRatePerHour] = React.useState(
    initial.rate_limit_per_hour,
  );
  const [senderRate, setSenderRate] = React.useState(
    initial.sender_rate_limit_per_hour,
  );
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  const [upsertMutate, upsertState] = useMutation(
    UPSERT_WORKFLOW_EMAIL_TRIGGER,
  );
  const [deleteMutate, deleteState] = useMutation(DELETE_WORKFLOW_TRIGGER);

  const config = {
    allowed_senders: senders,
    filters,
    filtered_run_retention: retention,
    rate_limit_per_hour: ratePerHour,
    sender_rate_limit_per_hour: senderRate,
  };
  const dirty =
    (trigger?.enabled ?? false) !== enabled ||
    JSON.stringify(config) !== JSON.stringify(initial);
  const filtersValid = filters.every(
    (rule) => validateFilterPattern(rule.pattern).ok,
  );
  const disabled =
    !access.canWrite || upsertState.loading || deleteState.loading;

  const addSender = () => {
    const value = senderInput.trim().toLowerCase();
    if (value === "") return;
    if (!isValidSenderEntry(value)) {
      toast.error(t("triggers.toast.invalidSender"));
      return;
    }
    if (!senders.includes(value)) setSenders((prev) => [...prev, value]);
    setSenderInput("");
  };

  const handleSave = async () => {
    if (!filtersValid) {
      toast.error(t("triggers.toast.invalidFilters"));
      return;
    }
    try {
      await upsertMutate({
        variables: { workflow: routine.id, enabled, config },
      });
      toast.success(t("triggers.toast.saved"));
      await onSaved();
    } catch (err) {
      toast.error(t("triggers.toast.saveFailed"), {
        description: (err as Error).message,
      });
    }
  };

  const handleConfirmDelete = async () => {
    if (!trigger) return;
    try {
      await deleteMutate({ variables: { id: trigger.id } });
      toast.success(t("triggers.toast.deleted"));
      await onSaved();
    } catch (err) {
      toast.error(t("triggers.toast.deleteFailed"), {
        description: (err as Error).message,
      });
      throw err; // keep ConfirmDialog open
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Switch
          id="email-trigger-enabled"
          checked={enabled}
          onCheckedChange={setEnabled}
          disabled={disabled}
        />
        <Label htmlFor="email-trigger-enabled">{t("triggers.enable")}</Label>
      </div>

      {trigger?.address ? (
        <CopyField value={trigger.address} label={t("triggers.addressLabel")} />
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("triggers.addressPending")}
        </p>
      )}

      {/* Allowed senders — chips (exact address or *@domain glob) */}
      <div className="space-y-2">
        <Label htmlFor="trigger-sender-input">
          {t("triggers.senders.label")}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t("triggers.senders.hint")}
        </p>
        {senders.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {senders.map((sender) => (
              <Badge
                key={sender}
                variant="secondary"
                className="gap-1 font-mono text-xs"
              >
                {sender}
                {access.canWrite ? (
                  <button
                    type="button"
                    aria-label={t("triggers.senders.remove", { sender })}
                    onClick={() =>
                      setSenders((prev) => prev.filter((s) => s !== sender))
                    }
                    className="ml-0.5 rounded-full hover:text-destructive"
                  >
                    <X aria-hidden="true" className="size-3" />
                  </button>
                ) : null}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("triggers.senders.empty")}
          </p>
        )}
        {access.canWrite ? (
          <div className="flex gap-2">
            <Input
              id="trigger-sender-input"
              value={senderInput}
              onChange={(e) => setSenderInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addSender();
                }
              }}
              placeholder={t("triggers.senders.placeholder")}
              className="max-w-xs font-mono"
              disabled={disabled}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addSender}
              disabled={disabled}
            >
              <Plus aria-hidden="true" className="mr-1 size-4" />
              {t("triggers.senders.add")}
            </Button>
          </div>
        ) : null}
      </div>

      {/* Filter rules — field select + regex input rows, validated live */}
      <div className="space-y-2">
        <Label>{t("triggers.filters.label")}</Label>
        <p className="text-xs text-muted-foreground">
          {t("triggers.filters.hint")}
        </p>
        {filters.map((rule, index) => {
          const validation = validateFilterPattern(rule.pattern);
          return (
            <div key={index} className="flex flex-wrap items-start gap-2">
              <Select
                value={rule.field}
                onValueChange={(field) =>
                  setFilters((prev) =>
                    prev.map((r, i) =>
                      i === index ? { ...r, field: field as FilterField } : r,
                    ),
                  )
                }
                disabled={disabled}
              >
                <SelectTrigger
                  className="w-44"
                  aria-label={t("triggers.filters.field")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FILTER_FIELDS.map((field) => (
                    <SelectItem key={field} value={field}>
                      {t(`triggers.filters.fields.${field}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Input
                  value={rule.pattern}
                  onChange={(e) =>
                    setFilters((prev) =>
                      prev.map((r, i) =>
                        i === index ? { ...r, pattern: e.target.value } : r,
                      ),
                    )
                  }
                  placeholder={t("triggers.filters.patternPlaceholder")}
                  className="font-mono"
                  aria-label={t("triggers.filters.pattern")}
                  disabled={disabled}
                />
                {!validation.ok ? (
                  <p className="text-xs text-destructive">
                    {t(`triggers.filters.invalid.${validation.reason}`)}
                  </p>
                ) : null}
              </div>
              {access.canWrite ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("triggers.filters.remove")}
                  onClick={() =>
                    setFilters((prev) => prev.filter((_, i) => i !== index))
                  }
                  disabled={disabled}
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                </Button>
              ) : null}
            </div>
          );
        })}
        {access.canWrite ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setFilters((prev) => [...prev, { field: "subject", pattern: "" }])
            }
            disabled={disabled}
          >
            <Plus aria-hidden="true" className="mr-1 size-4" />
            {t("triggers.filters.add")}
          </Button>
        ) : null}
      </div>

      {/* Retention + rate limits */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="trigger-retention">
            {t("triggers.limits.retention")}
          </Label>
          <Input
            id="trigger-retention"
            type="number"
            min={0}
            value={retention}
            onChange={(e) =>
              setRetention(Math.max(0, parseInt(e.target.value || "0", 10)))
            }
            disabled={disabled}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="trigger-rate">{t("triggers.limits.perHour")}</Label>
          <Input
            id="trigger-rate"
            type="number"
            min={1}
            value={ratePerHour}
            onChange={(e) =>
              setRatePerHour(Math.max(1, parseInt(e.target.value || "1", 10)))
            }
            disabled={disabled}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="trigger-sender-rate">
            {t("triggers.limits.perSenderPerHour")}
          </Label>
          <Input
            id="trigger-sender-rate"
            type="number"
            min={1}
            value={senderRate}
            onChange={(e) =>
              setSenderRate(Math.max(1, parseInt(e.target.value || "1", 10)))
            }
            disabled={disabled}
          />
        </div>
      </div>

      {/* Operator hint (design §8): approval-gate externally-visible tools. */}
      <p className="text-xs text-muted-foreground">
        {t("triggers.securityHint")}
      </p>

      {access.canWrite ? (
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={handleSave}
            disabled={!dirty || !filtersValid || upsertState.loading}
          >
            {upsertState.loading
              ? t("triggers.saving")
              : trigger
                ? t("triggers.update")
                : t("triggers.save")}
          </Button>
          {trigger ? (
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(true)}
              disabled={deleteState.loading}
            >
              <Trash2 aria-hidden="true" className="mr-2 size-4" />
              {t("triggers.remove")}
            </Button>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("triggers.delete.title")}
        description={t("triggers.delete.description", { name: routine.name })}
        variant="destructive"
        onConfirm={handleConfirmDelete}
        confirmLabel={t("triggers.delete.confirmLabel")}
      />
    </div>
  );
}
```

  > **Note on the not-configured CTA (`href: "/configuration/email"`):** this route is created in Task 7; within this plan the link is dead until Task 7 lands — both tasks precede any flag flip.

- [ ] 6.8 Register the section in `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/workflows/[id]/components/routine-workbench.tsx`. Four edits:

  (a) imports — old_string:
```tsx
import { RunsSection } from "../sections/runs";
import { ScheduleSection } from "../sections/schedule";
import { StepsSection } from "../sections/steps";
```
  new_string:
```tsx
import { RunsSection } from "../sections/runs";
import { ScheduleSection } from "../sections/schedule";
import { StepsSection } from "../sections/steps";
import { TriggersSection } from "../sections/triggers";
```

  (b) flag import — old_string:
```tsx
import { RUN_WORKFLOW } from "../../queries";
import type { Routine } from "../../types";
```
  new_string:
```tsx
import { RUN_WORKFLOW } from "../../queries";
import { ROUTINES_EMAIL_TRIGGER_SUPPORTED } from "../../schema-flags";
import type { Routine } from "../../types";
```

  (c) section id table (order is authoritative — JSX must match) — old_string:
```ts
export const ROUTINE_SECTION_IDS = [
  "basics",
  "access",
  "steps",
  "schedule",
  "runs",
  "queue",
  "danger",
] as const;
```
  new_string:
```ts
export const ROUTINE_SECTION_IDS = [
  "basics",
  "access",
  "steps",
  "schedule",
  "triggers",
  "runs",
  "queue",
  "danger",
] as const;
```

  (d) nav filter — old_string:
```tsx
  const sectionIds = React.useMemo(
    () =>
      ROUTINE_SECTION_IDS.filter(
        (id) => id !== "danger" || workbench.access.canDelete,
      ),
    [workbench.access.canDelete],
  );
```
  new_string:
```tsx
  const sectionIds = React.useMemo(
    () =>
      ROUTINE_SECTION_IDS.filter(
        (id) =>
          (id !== "danger" || workbench.access.canDelete) &&
          (id !== "triggers" || ROUTINES_EMAIL_TRIGGER_SUPPORTED),
      ),
    [workbench.access.canDelete],
  );
```

  (e) JSX (after ScheduleSection, before RunsSection — matches the id order) — old_string:
```tsx
            <ScheduleSection routine={routine} access={workbench.access} />
            <RunsSection
```
  new_string:
```tsx
            <ScheduleSection routine={routine} access={workbench.access} />
            <TriggersSection routine={routine} access={workbench.access} />
            <RunsSection
```

- [ ] 6.9 i18n. `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/messages/en.json` — two edits:

  (a) section label — old_string:
```json
      "sections": {
        "basics": "Basics",
        "access": "Access",
        "steps": "Steps",
        "schedule": "Schedule",
        "runs": "Runs",
        "queue": "Queue",
        "danger": "Danger zone"
      },
```
  new_string:
```json
      "sections": {
        "basics": "Basics",
        "access": "Access",
        "steps": "Steps",
        "schedule": "Schedule",
        "triggers": "Email trigger",
        "runs": "Runs",
        "queue": "Queue",
        "danger": "Danger zone"
      },
```

  (b) the `routines.triggers` namespace — old_string (unique single line):
```json
    "runActionLabel": "Run"
```
  new_string:
```json
    "triggers": {
      "title": "Email trigger",
      "metaNone": "Not set up",
      "metaEnabled": "Enabled",
      "metaDisabled": "Disabled",
      "loading": "Loading email trigger…",
      "enable": "Start this routine when an email arrives",
      "addressLabel": "Inbound address",
      "addressPending": "The dedicated address is generated when you save the trigger for the first time.",
      "senders": {
        "label": "Allowed senders",
        "hint": "Exact addresses or *@domain wildcards. Leave empty to allow every sender.",
        "empty": "All senders allowed.",
        "placeholder": "service@example.com or *@example.com",
        "add": "Add",
        "remove": "Remove {sender}"
      },
      "filters": {
        "label": "Filter rules",
        "hint": "Regular expressions — ALL rules must match, otherwise the email is recorded as filtered and no run starts.",
        "field": "Field",
        "fields": {
          "from": "From",
          "subject": "Subject",
          "body": "Body",
          "attachment_name": "Attachment name"
        },
        "pattern": "Pattern",
        "patternPlaceholder": "Ersatzteil|spare part",
        "add": "Add filter",
        "remove": "Remove filter",
        "invalid": {
          "empty": "Pattern must not be empty.",
          "too_long": "Pattern must be 200 characters or fewer.",
          "invalid": "Not a valid regular expression."
        }
      },
      "limits": {
        "retention": "Keep filtered runs",
        "perHour": "Max. emails per hour",
        "perSenderPerHour": "Max. per sender per hour"
      },
      "securityHint": "Emails are untrusted input. Approval-gate any tool with external effects (for example sending email or creating offers) on the agent this routine uses.",
      "save": "Save trigger",
      "update": "Update trigger",
      "saving": "Saving…",
      "remove": "Remove trigger",
      "delete": {
        "title": "Remove email trigger?",
        "description": "\"{name}\" will no longer start when emails arrive. The generated address stops working immediately.",
        "confirmLabel": "Remove trigger"
      },
      "toast": {
        "saved": "Email trigger saved",
        "saveFailed": "Could not save email trigger",
        "deleted": "Email trigger removed",
        "deleteFailed": "Could not remove email trigger",
        "invalidSender": "Enter a full address or a *@domain wildcard",
        "invalidFilters": "Fix the invalid filter rules before saving"
      },
      "notConfigured": {
        "title": "Email intake isn't configured",
        "description": "A super admin needs to connect the inbound email provider before routines can receive email.",
        "cta": "Open email settings"
      }
    },
    "runActionLabel": "Run"
```

- [ ] 6.10 `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/messages/de.json` — two edits:

  (a) old_string:
```json
      "sections": {
        "basics": "Grundlagen",
        "access": "Zugriff",
        "steps": "Schritte",
        "schedule": "Zeitplan",
        "runs": "Läufe",
        "queue": "Warteschlange",
        "danger": "Gefahrenzone"
      },
```
  new_string:
```json
      "sections": {
        "basics": "Grundlagen",
        "access": "Zugriff",
        "steps": "Schritte",
        "schedule": "Zeitplan",
        "triggers": "E-Mail-Auslöser",
        "runs": "Läufe",
        "queue": "Warteschlange",
        "danger": "Gefahrenzone"
      },
```

  (b) old_string:
```json
    "runActionLabel": "Ausführen"
```
  new_string:
```json
    "triggers": {
      "title": "E-Mail-Auslöser",
      "metaNone": "Nicht eingerichtet",
      "metaEnabled": "Aktiviert",
      "metaDisabled": "Deaktiviert",
      "loading": "E-Mail-Auslöser wird geladen…",
      "enable": "Diese Routine starten, wenn eine E-Mail eintrifft",
      "addressLabel": "Eingangsadresse",
      "addressPending": "Die dedizierte Adresse wird beim ersten Speichern des Auslösers erzeugt.",
      "senders": {
        "label": "Erlaubte Absender",
        "hint": "Exakte Adressen oder *@domain-Platzhalter. Leer lassen, um alle Absender zuzulassen.",
        "empty": "Alle Absender erlaubt.",
        "placeholder": "service@example.com oder *@example.com",
        "add": "Hinzufügen",
        "remove": "{sender} entfernen"
      },
      "filters": {
        "label": "Filterregeln",
        "hint": "Reguläre Ausdrücke — ALLE Regeln müssen zutreffen, sonst wird die E-Mail als gefiltert protokolliert und kein Lauf gestartet.",
        "field": "Feld",
        "fields": {
          "from": "Absender",
          "subject": "Betreff",
          "body": "Inhalt",
          "attachment_name": "Anhangsname"
        },
        "pattern": "Muster",
        "patternPlaceholder": "Ersatzteil|spare part",
        "add": "Filter hinzufügen",
        "remove": "Filter entfernen",
        "invalid": {
          "empty": "Das Muster darf nicht leer sein.",
          "too_long": "Das Muster darf höchstens 200 Zeichen lang sein.",
          "invalid": "Kein gültiger regulärer Ausdruck."
        }
      },
      "limits": {
        "retention": "Gefilterte Läufe aufbewahren",
        "perHour": "Max. E-Mails pro Stunde",
        "perSenderPerHour": "Max. pro Absender pro Stunde"
      },
      "securityHint": "E-Mails sind nicht vertrauenswürdige Eingaben. Versehen Sie alle Werkzeuge mit Außenwirkung (z. B. E-Mail-Versand oder Angebotserstellung) beim Agenten dieser Routine mit einer Freigabepflicht.",
      "save": "Auslöser speichern",
      "update": "Auslöser aktualisieren",
      "saving": "Wird gespeichert…",
      "remove": "Auslöser entfernen",
      "delete": {
        "title": "E-Mail-Auslöser entfernen?",
        "description": "\"{name}\" startet nicht mehr bei eingehenden E-Mails. Die erzeugte Adresse funktioniert sofort nicht mehr.",
        "confirmLabel": "Auslöser entfernen"
      },
      "toast": {
        "saved": "E-Mail-Auslöser gespeichert",
        "saveFailed": "E-Mail-Auslöser konnte nicht gespeichert werden",
        "deleted": "E-Mail-Auslöser entfernt",
        "deleteFailed": "E-Mail-Auslöser konnte nicht entfernt werden",
        "invalidSender": "Geben Sie eine vollständige Adresse oder einen *@domain-Platzhalter ein",
        "invalidFilters": "Korrigieren Sie die ungültigen Filterregeln vor dem Speichern"
      },
      "notConfigured": {
        "title": "E-Mail-Eingang ist nicht konfiguriert",
        "description": "Ein Super-Admin muss zuerst den Anbieter für eingehende E-Mails verbinden, bevor Routinen E-Mails empfangen können.",
        "cta": "E-Mail-Einstellungen öffnen"
      }
    },
    "runActionLabel": "Ausführen"
```

- [ ] 6.11 Verify (both flag branches, same drill as 3.3):
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npm run check-messages && npm run lint && npm test && npm run build
  ```
  Then temporarily set BOTH flags to `true` in `lib/routine-runs/flags.ts`, run `npm run build` again (the TriggersSection branch compiles), revert the flags, confirm `git diff lib/routine-runs/flags.ts` is empty. Expected: everything green in both configurations.

- [ ] 6.12 Format + commit:
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx prettier --write "app/(application)/workflows/[id]/sections/trigger-config.ts" "app/(application)/workflows/[id]/sections/trigger-config.test.ts" "app/(application)/workflows/[id]/sections/triggers.tsx" "app/(application)/workflows/queries.ts" "app/(application)/workflows/[id]/components/routine-workbench.tsx" lib/email-inbound && git add "app/(application)/workflows" lib/email-inbound messages/en.json messages/de.json && git commit -m "feat(routines): email TriggersSection — allowlist chips, regex filter rules, limits, generated address

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

### Task 7: Super-admin email-intake settings surface (`/configuration/email`) + final verification

**Files:**
- Create: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/configuration/email/page.tsx` (the existing `/configuration/layout.tsx` guard — `guardRoute("configuration")`, super_admin — covers this nested segment automatically)
- Create: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/configuration/components/email-intake-view.tsx`
- Modify: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/messages/en.json` + `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/messages/de.json` (`configuration.emailIntake.*`)

**Interfaces:**
- Consumes: `EMAIL_INBOUND_CONFIG`, `UPDATE_EMAIL_INBOUND_CONFIG`, `EmailInboundConfig` from `@/lib/email-inbound/queries` (Task 6); `ROUTINES_EMAIL_TRIGGER_SUPPORTED` from `@/lib/routine-runs/flags`; primitives `PageShell`, `PageHeader`, `FormSection`, `CopyField`, `RelativeTime`, `EmptyState`.
- Produces: `EmailIntakeView()` — the page body reached by the TriggersSection CTA (`/configuration/email`, Task 6). Signing key is a write-only password input (`has_signing_key` drives the placeholder; the value is NEVER echoed back — contract: the API never returns it).

**Steps:**

- [ ] 7.1 Create `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/configuration/email/page.tsx`:

```tsx
/**
 * /configuration/email — email-intake platform settings (email-routines
 * design §7.5). Super-admin only: the parent /configuration layout.tsx
 * guards ALL nested segments via guardRoute("configuration"). Thin page per
 * codebase-structure §1.1; the surface lives in components/.
 */
import { EmailIntakeView } from "../components/email-intake-view";

export const dynamic = "force-dynamic";

export default function EmailIntakePage() {
  return <EmailIntakeView />;
}
```

- [ ] 7.2 Create `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/configuration/components/email-intake-view.tsx`:

```tsx
"use client";

/**
 * EmailIntakeView — the /configuration/email surface (email-routines design
 * §7.5): provider (Mailgun EU, fixed for v1), inbound domain, WRITE-ONLY
 * signing key, global enable switch, webhook URL with copy button, the §4.1
 * setup checklist (incl. the explicit "message retention = 0" step) and the
 * last-webhook-received timestamp as the setup-verification signal.
 *
 * The signing key is never returned by the API (has_signing_key only) — the
 * input stays empty; a non-empty value on save REPLACES the stored key
 * (rotation = overwrite, design §3.5).
 */

import { useMutation, useQuery } from "@apollo/client";
import { Mail } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import { CopyField } from "@/components/primitives/copy-field";
import { EmptyState } from "@/components/primitives/empty-state";
import { FormSection } from "@/components/primitives/form-section";
import { PageHeader } from "@/components/primitives/page-header";
import { PageShell } from "@/components/primitives/page-shell";
import { RelativeTime } from "@/components/primitives/relative-time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  EMAIL_INBOUND_CONFIG,
  UPDATE_EMAIL_INBOUND_CONFIG,
  type EmailInboundConfig,
} from "@/lib/email-inbound/queries";
import { ROUTINES_EMAIL_TRIGGER_SUPPORTED } from "@/lib/routine-runs/flags";

const CHECKLIST_STEPS = [
  "step1",
  "step2",
  "step3",
  "step4",
  "step5",
  "step6",
] as const;

export function EmailIntakeView() {
  const t = useTranslations("configuration.emailIntake");
  const tNav = useTranslations("navigation");

  const { data, loading, refetch } = useQuery<{
    emailInboundConfig?: EmailInboundConfig | null;
  }>(EMAIL_INBOUND_CONFIG, {
    skip: !ROUTINES_EMAIL_TRIGGER_SUPPORTED,
    fetchPolicy: "cache-and-network",
  });

  if (!ROUTINES_EMAIL_TRIGGER_SUPPORTED) {
    return (
      <PageShell variant="narrow">
        <EmptyState
          variant="quiet"
          icon={Mail}
          title={t("unavailableTitle")}
          description={t("unavailableDescription")}
        />
      </PageShell>
    );
  }

  const config = data?.emailInboundConfig ?? null;

  return (
    <PageShell variant="narrow">
      <PageHeader
        title={t("title")}
        description={t("description")}
        breadcrumb={{ label: tNav("configuration"), href: "/configuration" }}
      />
      {loading && data === undefined ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <EmailIntakeForm config={config} onSaved={refetch} />
      )}
    </PageShell>
  );
}

function EmailIntakeForm({
  config,
  onSaved,
}: {
  config: EmailInboundConfig | null;
  onSaved: () => Promise<unknown>;
}) {
  const t = useTranslations("configuration.emailIntake");

  const [enabled, setEnabled] = React.useState(config?.enabled === true);
  const [domain, setDomain] = React.useState(config?.inbound_domain ?? "");
  const [signingKey, setSigningKey] = React.useState("");
  const [mutate, mutation] = useMutation(UPDATE_EMAIL_INBOUND_CONFIG);

  const dirty =
    enabled !== (config?.enabled === true) ||
    domain.trim() !== (config?.inbound_domain ?? "") ||
    signingKey.trim() !== "";

  const handleSave = async () => {
    try {
      await mutate({
        variables: {
          provider: "mailgun-eu",
          inbound_domain: domain.trim(),
          enabled,
          ...(signingKey.trim() !== ""
            ? { signing_key: signingKey.trim() }
            : {}),
        },
      });
      toast.success(t("toast.saved"));
      setSigningKey("");
      await onSaved();
    } catch (err) {
      toast.error(t("toast.saveFailed"), {
        description: (err as Error).message,
      });
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <FormSection title={t("provider")} description={t("providerMailgunEu")}>
        <div className="flex items-center gap-3">
          <Switch
            id="email-intake-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={mutation.loading}
          />
          <Label htmlFor="email-intake-enabled">{t("enabled")}</Label>
        </div>
        <div className="flex max-w-md flex-col gap-1">
          <Label htmlFor="email-intake-domain">{t("domainLabel")}</Label>
          <Input
            id="email-intake-domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder={t("domainPlaceholder")}
            className="font-mono"
            disabled={mutation.loading}
          />
        </div>
        <div className="flex max-w-md flex-col gap-1">
          <Label htmlFor="email-intake-signing-key">
            {t("signingKeyLabel")}
          </Label>
          <Input
            id="email-intake-signing-key"
            type="password"
            autoComplete="off"
            value={signingKey}
            onChange={(e) => setSigningKey(e.target.value)}
            placeholder={
              config?.has_signing_key
                ? t("signingKeyStored")
                : t("signingKeyPlaceholder")
            }
            disabled={mutation.loading}
          />
        </div>
        <div>
          <Button onClick={handleSave} disabled={!dirty || mutation.loading}>
            {mutation.loading ? t("saving") : t("save")}
          </Button>
        </div>
      </FormSection>

      <Separator />

      <FormSection title={t("webhookUrlLabel")} description={t("webhookUrlHint")}>
        {config?.webhook_url ? (
          <CopyField value={config.webhook_url} label={t("webhookUrlLabel")} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("webhookUrlPending")}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {t("lastWebhookLabel")}{" "}
          {config?.last_webhook_at ? (
            <RelativeTime date={config.last_webhook_at} />
          ) : (
            t("lastWebhookNever")
          )}
        </p>
      </FormSection>

      <Separator />

      <FormSection title={t("checklistTitle")}>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
          {CHECKLIST_STEPS.map((step) => (
            <li key={step}>{t(`checklist.${step}`)}</li>
          ))}
        </ol>
      </FormSection>
    </div>
  );
}
```

- [ ] 7.3 i18n. `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/messages/en.json` — old_string (line ~2025-2026):

```json
  "configuration": {
    "description": "White-label IMP for your organization — changes apply to every user.",
```

new_string:

```json
  "configuration": {
    "description": "White-label IMP for your organization — changes apply to every user.",
    "emailIntake": {
      "title": "Email intake",
      "description": "Inbound email for routines — provider, domain and webhook credentials.",
      "enabled": "Enable email intake",
      "provider": "Provider",
      "providerMailgunEu": "Mailgun (EU region) — the only supported provider in v1.",
      "domainLabel": "Inbound domain",
      "domainPlaceholder": "mail.your-company.com",
      "signingKeyLabel": "Webhook signing key",
      "signingKeyStored": "A signing key is stored — enter a new value to replace it.",
      "signingKeyPlaceholder": "Paste the Mailgun HTTP webhook signing key",
      "webhookUrlLabel": "Webhook URL",
      "webhookUrlHint": "Point your Mailgun route's forward() action at this URL.",
      "webhookUrlPending": "Save the settings once to see the webhook URL.",
      "lastWebhookLabel": "Last webhook received:",
      "lastWebhookNever": "never — send a test email once DNS and the route are set up.",
      "checklistTitle": "Setup checklist",
      "checklist": {
        "step1": "Create a Mailgun EU account and add the receiving domain (e.g. mail.your-company.com).",
        "step2": "Publish the MX records (mxa.eu.mailgun.org, mxb.eu.mailgun.org) and the TXT verification records.",
        "step3": "Create ONE catch-all route: match_recipient(\".*@your-domain\") → forward to the webhook URL below → stop().",
        "step4": "Set the account/domain message retention to 0 and verify it explicitly — retention is NOT a per-route setting.",
        "step5": "Copy the domain's HTTP webhook signing key into the field above and enable email intake.",
        "step6": "Send a test email and confirm \"Last webhook received\" updates."
      },
      "save": "Save settings",
      "saving": "Saving…",
      "toast": {
        "saved": "Email intake settings saved",
        "saveFailed": "Could not save email intake settings"
      },
      "unavailableTitle": "Email intake isn't available yet",
      "unavailableDescription": "This surface needs a backend that supports the email-inbound API."
    },
```

- [ ] 7.4 `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/messages/de.json` — old_string:

```json
  "configuration": {
    "description": "Gestalten Sie das IMP im Stil Ihrer Organisation — Änderungen gelten für alle Benutzer.",
```

new_string:

```json
  "configuration": {
    "description": "Gestalten Sie das IMP im Stil Ihrer Organisation — Änderungen gelten für alle Benutzer.",
    "emailIntake": {
      "title": "E-Mail-Eingang",
      "description": "Eingehende E-Mails für Routinen — Anbieter, Domain und Webhook-Zugangsdaten.",
      "enabled": "E-Mail-Eingang aktivieren",
      "provider": "Anbieter",
      "providerMailgunEu": "Mailgun (EU-Region) — der einzige unterstützte Anbieter in v1.",
      "domainLabel": "Eingangsdomain",
      "domainPlaceholder": "mail.ihre-firma.de",
      "signingKeyLabel": "Webhook-Signaturschlüssel",
      "signingKeyStored": "Ein Signaturschlüssel ist hinterlegt — neuen Wert eingeben, um ihn zu ersetzen.",
      "signingKeyPlaceholder": "Mailgun HTTP-Webhook-Signaturschlüssel einfügen",
      "webhookUrlLabel": "Webhook-URL",
      "webhookUrlHint": "Richten Sie die forward()-Aktion Ihrer Mailgun-Route auf diese URL.",
      "webhookUrlPending": "Speichern Sie die Einstellungen einmal, um die Webhook-URL zu sehen.",
      "lastWebhookLabel": "Letzter Webhook empfangen:",
      "lastWebhookNever": "noch nie — senden Sie eine Test-E-Mail, sobald DNS und Route eingerichtet sind.",
      "checklistTitle": "Einrichtungs-Checkliste",
      "checklist": {
        "step1": "Mailgun-EU-Konto anlegen und die Empfangsdomain hinzufügen (z. B. mail.ihre-firma.de).",
        "step2": "MX-Einträge (mxa.eu.mailgun.org, mxb.eu.mailgun.org) und TXT-Verifizierungseinträge veröffentlichen.",
        "step3": "EINE Catch-all-Route anlegen: match_recipient(\".*@ihre-domain\") → forward auf die Webhook-URL unten → stop().",
        "step4": "Die Nachrichtenspeicherung des Kontos/der Domain auf 0 setzen und explizit prüfen — die Speicherdauer ist KEINE Routen-Einstellung.",
        "step5": "Den HTTP-Webhook-Signaturschlüssel der Domain in das Feld oben kopieren und den E-Mail-Eingang aktivieren.",
        "step6": "Eine Test-E-Mail senden und prüfen, dass sich \"Letzter Webhook empfangen\" aktualisiert."
      },
      "save": "Einstellungen speichern",
      "saving": "Wird gespeichert…",
      "toast": {
        "saved": "E-Mail-Eingangseinstellungen gespeichert",
        "saveFailed": "E-Mail-Eingangseinstellungen konnten nicht gespeichert werden"
      },
      "unavailableTitle": "E-Mail-Eingang ist noch nicht verfügbar",
      "unavailableDescription": "Diese Oberfläche benötigt ein Backend, das die E-Mail-Eingangs-API unterstützt."
    },
```

- [ ] 7.5 Verify Task 7 in isolation:
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npm run check-messages && npm run lint && npm run build
  ```
  Expected: all green.

- [ ] 7.6 **Final whole-plan verification** (flags OFF — the shipping state):
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npm run check-messages && npm run lint && npm test && npm run build
  ```
  Then the both-flags-ON compile drill one last time: set both consts in `lib/routine-runs/flags.ts` to `true`, `npm test && npm run build`, revert both to `false`, confirm `git status` shows a clean flags.ts.

- [ ] 7.7 Manual walkthrough (flags OFF, `npm run dev` against any backend) — everything must look EXACTLY like before this branch:
  - `/workflows/<id>`: no "Email trigger" section in the nav or body; Runs section identical to main (legacy list, inline expand, Retry prefill).
  - Sidebar: no "Runs" entry, no badge, zero `routineRuns*` network requests (check the network tab).
  - `/runs` by URL: AccessDenied without workflows:read; quiet "isn't available yet" EmptyState with it.
  - `/configuration/email` by URL: AccessDenied for non-SA; quiet EmptyState for SA.
  - Open any chat session: no banner, no `job_resultById` polling.
- [ ] 7.8 Manual walkthrough (flags ON, requires a Plans-1+2 backend — record as the flag-flip release checklist if none is deployed yet):
  - Routine workbench → Email trigger: not-configured CTA (SA sees "Open email settings" → `/configuration/email`); after configuring: save trigger → address appears with copy button; add/remove sender chips (bad entries toasted); invalid regex shows inline error and blocks save; delete via ConfirmDialog.
  - Task 6 CTA link resolves: as SA with email intake not yet configured, click the "Open email settings" CTA in the workbench's Email trigger EmptyState and confirm it lands on the Task 7 `/configuration/email` page (renders the EmailIntakeView, not a 404) — this closes the Task 6 → Task 7 forward reference.
  - Runs section: filter by state/trigger/date/search; waiting_approval rows show amber "Needs attention"; "Show filtered" reveals muted filtered rows with reason; Open session lands on `/chat/<agent>/<session>`; Cancel (confirm) and Retry re-queue update the row after refetch.
  - `/runs`: defaults to the Needs-attention lens; routine name column; badge in the sidebar counts waiting_approval runs and updates within ~10 s of an approval pause; badge disappears at 0.
  - Chat session of a run: banner shows routine name + trigger + state; resolve the approval card → banner flips to active/completed within one poll; "View run" opens `/runs?workflow=<id>`.
  - `/configuration/email`: save domain + signing key (input clears, has_signing_key placeholder appears on reload); webhook URL copies; "Last webhook received" updates after a Mailgun test POST.

- [ ] 7.9 Format + commit:
  ```bash
  cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx prettier --write "app/(application)/configuration/email" "app/(application)/configuration/components/email-intake-view.tsx" && git add "app/(application)/configuration" messages/en.json messages/de.json && git commit -m "feat(configuration): super-admin email-intake settings surface with setup checklist

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

## Flag-flip release note (post-backend-deploy, NOT part of this plan's execution)

When Plans 1+2 are deployed and verified by introspection: flip `ROUTINES_RUNS_V2_SUPPORTED` and/or `ROUTINES_EMAIL_TRIGGER_SUPPORTED` to `true` in `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/lib/routine-runs/flags.ts` (ONE file), run `npm test && npm run build`, and execute the 7.8 walkthrough. No other file changes — everything in this plan keys off those two consts.

## Contract-deviation register

- **None on the GraphQL contract** — every operation consumes the fixed SDL verbatim (names, args, field lists).
- **Flag location nuance (not a deviation):** the two flags are *defined* in `lib/routine-runs/flags.ts` and *re-exported* from `app/(application)/workflows/schema-flags.ts` (the contract location), because eslint hard-errors forbid `components/shell/**` and the runs/chat/configuration features from importing the workflows feature folder. Both contract import paths work.
- **`/chat/[agent]` semantics verified:** the route param is the agent **id** (chat page passes it to `agentById(id:)`), which is exactly what `RoutineRun.agent` carries — no slug resolution added.
