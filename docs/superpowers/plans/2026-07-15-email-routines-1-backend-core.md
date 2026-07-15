# Email-Triggered Routines — Plan 1: Backend Core (Session-Backed Runs + Approvals + Runs API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every routine run session-backed (real `agent_sessions` row + persisted `agent_messages`), let approval-gated tools pause runs (`waiting_approval`) and auto-resume after an admin's chat approval, and expose the runs lifecycle over GraphQL (`routineRuns`, `routineRunsNeedingAttentionCount`, `cancelRoutineRun`, `retryRoutineRun`).

**Architecture:** New `src/exulu/routines/` modules (`run-session.ts`, `run-state.ts`, `flow-steps.ts`, `runs-query.ts`) hold the tested logic; `ee/workers.ts` (`processUiMessagesFlow` + workflow job handler + BullMQ event handlers) and `src/graphql/schemas/index.ts` are rewired to use them. `job_results` gains `trigger`/`trigger_metadata`/`session`/`workflow` columns (+ backfill + composite index in init-db), `workflow_templates` gains `auto_approve_tools`. All state transitions become CAS updates so pause/cancel/complete can never clobber each other.

**Tech Stack:** Node 22.18.0, TypeScript, Express 5, Apollo Server 5 (schema string-built in `src/graphql/schemas/index.ts`), Knex/pg, BullMQ, AI SDK v6 (`ai`), Jest + ts-jest.

## Global Constraints

- Repo: `/Users/daniel.claessen/Desktop/Projects/exulu/backend`; default branch `develop`; work on branch `feature/email-routines-backend-core` (parallel sessions use the primary checkout — prefer a sibling worktree per repo convention).
- Node v22.18.0 enforced by `preinstall`; do not touch `package.json` engines/scripts. This plan adds NO new dependencies.
- Tests: Jest + ts-jest; run a single file with `npm test -- --testPathPattern="<pattern>"`; full gates: `npm run type-check`, `npm run lint` (lints `src/` only — `ee/` changes are covered by type-check), `npm test`.
- Path aliases: `@SRC/*` → `src/*`, `@EE/*` → `ee/*`, `@EXULU_TYPES/*` → `types/*` (tsconfig + jest moduleNameMapper both).
- ESLint strict incl. `@typescript-eslint/no-floating-promises` — every promise in new code is awaited, `void`-ed with a comment, or `.catch()`-ed.
- Naming: "routine" is user-facing; code keeps `workflow_*` identifiers (tables, GraphQL args, BullMQ payloads).
- CROSS-PLAN CONTRACT: the module paths, export names, function signatures, and GraphQL SDL in this plan are FIXED — Plans 2 (email intake) and 3 (frontend) compile against them verbatim. Do not rename.
- Commits: conventional commits, one per task, each ending with the line `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Existing behavior must keep working: manual/cron routines now run session-backed, but headless callers of `processUiMessagesFlow` (no `sessionId`) behave exactly as today.
- One deliberate naming note: rbac rows copied to run sessions use `entity: "agent_session"` (singular) — that is what `applyAccessControl`/`RBACResolver`/`handleRBACUpdate` match on (`table.name.singular`); the contract's shorthand "agent_sessions" would produce rows the RBAC machinery never reads.

---

### Task 1: Branch + run states enum + `TERMINAL_JOB_STATES` + pruner fix

**Files:**
- Modify: `types/enums/jobs.ts` (whole file, currently 11 lines)
- Modify: `ee/queues/prune-job-results.ts` (replace hardcoded `TERMINAL_STATES`, lines 22 + module doc)
- Create: `ee/queues/prune-job-results.test.ts`

**Interfaces:**
- Produces: `export type JOB_STATUS = "completed" | "failed" | "delayed" | "active" | "waiting" | "paused" | "stuck" | "waiting_approval" | "filtered" | "cancelled"`; `JOB_STATUS_ENUM` gains the three new keys; `export const TERMINAL_JOB_STATES: JOB_STATUS[] = ["completed", "failed", "filtered", "cancelled"]`.
- Consumes: nothing new.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
git checkout develop && git pull && git checkout -b feature/email-routines-backend-core
```

- [ ] **Step 2: Write the failing test** — create `ee/queues/prune-job-results.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run it — expect FAIL**

```bash
npm test -- --testPathPattern="prune-job-results"
```

Expected: `FAIL` with `Module '"@EXULU_TYPES/enums/jobs"' has no exported member 'TERMINAL_JOB_STATES'` (ts-jest compile error).

- [ ] **Step 4: Implement** — replace the full contents of `types/enums/jobs.ts` with:

```typescript
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
```

- [ ] **Step 5: Point the pruner at the shared constant** — in `ee/queues/prune-job-results.ts`, apply two edits.

Edit 1 — replace:

```typescript
const MAX_TERMINAL = 10_000;
const PRUNE_EVERY = 100;
const TERMINAL_STATES = ["failed", "completed"];
```

with:

```typescript
import { TERMINAL_JOB_STATES } from "@EXULU_TYPES/enums/jobs";

const MAX_TERMINAL = 10_000;
const PRUNE_EVERY = 100;
```

Edit 2 — replace both usages (`.whereIn("state", TERMINAL_STATES)` appears twice) via replace-all:

```typescript
      .whereIn("state", TERMINAL_STATES)
```

with:

```typescript
      .whereIn("state", TERMINAL_JOB_STATES)
```

(Also update the module doc comment line `state failed/completed` to `states in TERMINAL_JOB_STATES` — cosmetic but keeps the doc honest.)

- [ ] **Step 6: Run it — expect PASS**

```bash
npm test -- --testPathPattern="prune-job-results"
```

Expected: `Tests: 3 passed`.

- [ ] **Step 7: Type-check and commit**

```bash
npm run type-check
git add types/enums/jobs.ts ee/queues/prune-job-results.ts ee/queues/prune-job-results.test.ts
git commit -m "feat(jobs): add waiting_approval/filtered/cancelled states + TERMINAL_JOB_STATES

Pruner now imports the shared terminal-state list instead of hardcoding
[failed, completed]; waiting_approval is non-terminal by construction.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Data model — schema columns, `BullMqJobData` fields, backfill + composite index

**Files:**
- Modify: `ee/schemas.ts` (`jobResultsSchema` fields array ~line 207-264; `workflowTemplatesSchema` fields array ~line 369-396)
- Modify: `ee/queues/decorator.ts` (`BullMqJobData` type, lines 31-63)
- Modify: `types/workflow.ts` (`ExuluWorkflow` interface)
- Modify: `src/postgres/init-exulu-db.ts` (add backfill + index block after the `transcriptions_items` migration, ~line 280)

**Interfaces:**
- Produces (contract-fixed):
  - `job_results` columns: `trigger` (text), `trigger_metadata` (json), `session` (text), `workflow` (text, indexed via composite index).
  - `workflow_templates` column: `auto_approve_tools` (boolean, default `false`).
  - `BullMqJobData` gains: `session?: string; jobResultId?: string; resumeFromIndex?: number; triggerSource?: "email" | "schedule" | "manual" | "api"; triggerMetadata?: Record<string, unknown>;`
  - Backfill: `job_results.workflow` from label pattern `workflow-run-<uuid>` (also stamps `type='workflow'` on those rows so the runs API's `type` filter matches pre-migration rows); composite index `(workflow, state, trigger, "createdAt")`.
- Consumes: `addMissingFields` in `init-exulu-db.ts` auto-adds any new schema field to existing tables on boot — the raw-SQL block only handles backfill + index.

This task is schema/config wiring — verification is type-check + SDL inspection (no brittle unit tests).

- [ ] **Step 1: Add `job_results` columns** — in `ee/schemas.ts`, inside `jobResultsSchema.fields`, replace the final field entry:

```typescript
        {
            name: "type",
            type: "text",
        },
    ],
};
```

with:

```typescript
        {
            name: "type",
            type: "text",
        },
        // Email-triggered routines (spec 2026-07-15 §3.3): run provenance +
        // session cross-link. `workflow` replaces label-substring filtering
        // (indexed via the composite index created in init-exulu-db.ts).
        // Pre-migration rows keep trigger = NULL (displayed as "—").
        {
            name: "trigger",
            type: "text",
        },
        {
            name: "trigger_metadata",
            type: "json",
        },
        {
            name: "session",
            type: "text",
        },
        {
            name: "workflow",
            type: "text",
            index: true,
        },
    ],
};
```

- [ ] **Step 2: Add `auto_approve_tools`** — in `ee/schemas.ts`, inside `workflowTemplatesSchema.fields`, replace:

```typescript
      {
        name: "steps_json",
        type: "json",
        required: true,
      },
    ],
  };
```

with:

```typescript
      {
        name: "steps_json",
        type: "json",
        required: true,
      },
      // Escape hatch for the approval behavior change (spec §5.2): when true
      // the run keeps the legacy blanket tool pre-approval and never pauses.
      {
        name: "auto_approve_tools",
        type: "boolean",
        default: false,
      },
    ],
  };
```

- [ ] **Step 3: Extend `ExuluWorkflow`** — in `types/workflow.ts`, replace:

```typescript
    agent: string;
    steps_json?: WorkflowStep[];
}
```

with:

```typescript
    agent: string;
    steps_json?: WorkflowStep[];
    /** Spec §5.2: true = legacy blanket tool pre-approval (run never pauses). */
    auto_approve_tools?: boolean;
}
```

- [ ] **Step 4: Extend `BullMqJobData`** — in `ee/queues/decorator.ts`, replace:

```typescript
  workflow?: string;
  embedder?: string;
  processor?: string;
  evaluation?: string;
  item?: string;
  context?: string;
};
```

with:

```typescript
  workflow?: string;
  embedder?: string;
  processor?: string;
  evaluation?: string;
  item?: string;
  context?: string;
  // Email-triggered routines (spec 2026-07-15): session-backed workflow runs.
  /** agent_sessions id to run in; when absent the worker creates one. */
  session?: string;
  /** Existing job_results row to UPDATE instead of INSERT (continuation/retry/email intake). */
  jobResultId?: string;
  /** Skip steps before this index (resume after approval pause / retry-from-step). */
  resumeFromIndex?: number;
  /** Persisted to job_results.trigger — run provenance for the runs views. */
  triggerSource?: "email" | "schedule" | "manual" | "api";
  /** Persisted to job_results.trigger_metadata (email: from/subject/message_id; schedule: cron). */
  triggerMetadata?: Record<string, unknown>;
};
```

- [ ] **Step 5: Backfill + composite index in init-db** — in `src/postgres/init-exulu-db.ts`, directly after the `transcriptions_items` block (which ends with `  }` before the commented-out `/*  if (!await knex.schema.hasTable('sessions')) {` block), replace:

```typescript
  /*  if (!await knex.schema.hasTable('sessions')) {
```

with:

```typescript
  // Email-triggered routines (spec 2026-07-15 §3.3): job_results gets an
  // explicit `workflow` column (added above by addMissingFields from
  // jobResultsSchema). One-time backfill parses the legacy label format
  // 'workflow-run-<workflow_template_id>' ('workflow-run-' = 13 chars) and
  // stamps type='workflow' so the runs API's type filter matches old rows.
  // Idempotent: the WHERE clause matches zero rows on every boot after the
  // first. `trigger` deliberately stays NULL for old rows (spec: don't guess).
  if (await knex.schema.hasColumn("job_results", "workflow")) {
    const backfilled = await knex.raw(
      `UPDATE job_results
          SET workflow = SUBSTRING(label FROM 14),
              type = COALESCE(type, 'workflow')
        WHERE label LIKE 'workflow-run-%'
          AND workflow IS NULL`,
    );
    if (backfilled?.rowCount) {
      console.log(
        `[EXULU] Backfilled job_results.workflow on ${backfilled.rowCount} rows from labels.`,
      );
    }
    // Runs views query by (workflow, state, trigger) ordered by createdAt.
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS job_results_workflow_state_trigger_created_idx
          ON job_results (workflow, state, trigger, "createdAt")`,
    );
  }

  /*  if (!await knex.schema.hasTable('sessions')) {
```

- [ ] **Step 6: Verify — type-check + SDL contains the new fields**

```bash
npm run type-check
npx tsx scripts/print-sdl.ts /tmp/sdl-check.graphql
grep -n "trigger_metadata\|auto_approve_tools" /tmp/sdl-check.graphql
```

Expected: type-check clean; grep shows `trigger_metadata: JSON` under `type job_result` / `Filterjob_result` and `auto_approve_tools: Boolean` under `type workflow_template` (the SDL generator auto-exposes schema fields).

- [ ] **Step 7: Run the existing core-schema test (guards schema registration) and commit**

```bash
npm test -- --testPathPattern="core-schema"
git add ee/schemas.ts ee/queues/decorator.ts types/workflow.ts src/postgres/init-exulu-db.ts
git commit -m "feat(routines): job_results run columns + auto_approve_tools + workflow backfill

Adds trigger/trigger_metadata/session/workflow to job_results and
auto_approve_tools to workflow_templates; BullMqJobData carries
session/jobResultId/resumeFromIndex/triggerSource/triggerMetadata.
init-db backfills workflow from 'workflow-run-<id>' labels and creates
the (workflow, state, trigger, createdAt) composite index.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Flow-step helpers — empty-safe email variables + pending-approval detection

**Files:**
- Create: `src/exulu/routines/flow-steps.ts`
- Create: `src/exulu/routines/flow-steps.test.ts`
- Modify: `src/exulu/auto-decline-stale-approvals.ts` (export the existing private predicate, line ~13)

**Interfaces:**
- Produces:
  - `export const EMAIL_RUN_VARIABLES: Set<string>` — `email_from`, `email_subject`, `email_body` (Plan 2's intake pre-populates exactly these into `jobData.inputs`).
  - `export const substituteVariablesInMessage = (message: UIMessage, variables?: Record<string, any>): void` — in-place `{var}` substitution; throws the existing error text for missing values; empty string/`0`/`false` are accepted ONLY for the three email variables.
  - `export const messageHasPendingApproval = (message: UIMessage | undefined): boolean`.
  - `src/exulu/auto-decline-stale-approvals.ts` exports `isPendingApprovalToolPart` (previously module-private).
- Consumes: `isPendingApprovalToolPart` (matches `type === "dynamic-tool" || type.startsWith("tool-")` with `state === "approval-requested"` and an `approval.id`).

- [ ] **Step 1: Write the failing test** — create `src/exulu/routines/flow-steps.test.ts`:

```typescript
import type { UIMessage } from "ai";
import {
  EMAIL_RUN_VARIABLES,
  messageHasPendingApproval,
  substituteVariablesInMessage,
} from "./flow-steps";

const msg = (text: string): UIMessage =>
  ({ id: "m1", role: "user", parts: [{ type: "text", text }] }) as UIMessage;

const textOf = (message: UIMessage): string => (message.parts[0] as { text: string }).text;

describe("substituteVariablesInMessage", () => {
  it("substitutes provided variables into text parts", () => {
    const message = msg("Hello {name}, order {order_id}");
    substituteVariablesInMessage(message, { name: "KONE", order_id: "42" });
    expect(textOf(message)).toBe("Hello KONE, order 42");
  });

  it("throws the legacy error for missing user variables", () => {
    const message = msg("Hello {name}");
    expect(() => substituteVariablesInMessage(message, {})).toThrow(
      "Value for variable name not provided in variables",
    );
  });

  it("still rejects empty strings for user-provided variables", () => {
    const message = msg("Hello {name}");
    expect(() => substituteVariablesInMessage(message, { name: "" })).toThrow(
      "Value for variable name not provided in variables",
    );
  });

  it("accepts empty strings for the auto-provided email variables (spec §4.5)", () => {
    const message = msg("From {email_from} Subject {email_subject} Body {email_body}");
    substituteVariablesInMessage(message, {
      email_from: "a@b.com",
      email_subject: "",
      email_body: "",
    });
    expect(textOf(message)).toBe("From a@b.com Subject  Body ");
  });

  it("email variables still throw when entirely absent", () => {
    const message = msg("{email_body}");
    expect(() => substituteVariablesInMessage(message, {})).toThrow(
      "Value for variable email_body not provided in variables",
    );
  });

  it("ignores non-text parts and repeated placeholders replace all occurrences", () => {
    const message = {
      id: "m2",
      role: "user",
      parts: [
        { type: "file", url: "s3://x", mediaType: "application/pdf", filename: "x.pdf" },
        { type: "text", text: "{a} and {a}" },
      ],
    } as unknown as UIMessage;
    substituteVariablesInMessage(message, { a: "x" });
    expect((message.parts[1] as { text: string }).text).toBe("x and x");
  });
});

describe("EMAIL_RUN_VARIABLES", () => {
  it("contains exactly the three auto-provided variables", () => {
    expect([...EMAIL_RUN_VARIABLES].sort()).toEqual(["email_body", "email_from", "email_subject"]);
  });
});

describe("messageHasPendingApproval", () => {
  const approvalPart = {
    type: "tool-create_offer",
    state: "approval-requested",
    approval: { id: "appr-1" },
  };

  it("detects a pending approval tool part on the message", () => {
    const message = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "…" }, approvalPart],
    } as unknown as UIMessage;
    expect(messageHasPendingApproval(message)).toBe(true);
  });

  it("is false for resolved approvals, plain messages, and undefined", () => {
    const resolved = {
      id: "a2",
      role: "assistant",
      parts: [{ ...approvalPart, state: "output-denied" }],
    } as unknown as UIMessage;
    expect(messageHasPendingApproval(resolved)).toBe(false);
    expect(messageHasPendingApproval(msg("hi"))).toBe(false);
    expect(messageHasPendingApproval(undefined)).toBe(false);
  });

  it("detects dynamic-tool parts too", () => {
    const message = {
      id: "a3",
      role: "assistant",
      parts: [{ ...approvalPart, type: "dynamic-tool" }],
    } as unknown as UIMessage;
    expect(messageHasPendingApproval(message)).toBe(true);
  });

  it("ignores answered approvals in state output-denied / approval-responded (deny path, spec §5.5)", () => {
    for (const state of ["output-denied", "approval-responded"]) {
      const message = {
        id: "a4",
        role: "assistant",
        parts: [{ ...approvalPart, state }],
      } as unknown as UIMessage;
      expect(messageHasPendingApproval(message)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

```bash
npm test -- --testPathPattern="flow-steps"
```

Expected: `Cannot find module './flow-steps'`.

- [ ] **Step 3: Export the predicate** — in `src/exulu/auto-decline-stale-approvals.ts`, replace:

```typescript
const isPendingApprovalToolPart = (part: unknown): part is PendingApprovalPart => {
```

with:

```typescript
export const isPendingApprovalToolPart = (part: unknown): part is PendingApprovalPart => {
```

- [ ] **Step 4: Implement** — create `src/exulu/routines/flow-steps.ts`:

```typescript
import type { UIMessage } from "ai";
import { isPendingApprovalToolPart } from "@SRC/exulu/auto-decline-stale-approvals";

/**
 * Variables auto-provided by the email intake pipeline (spec §4.5). An empty
 * subject or body is legal for an email, so these are empty-safe: only
 * undefined/null count as "not provided". User-provided variables keep the
 * legacy strict (truthy) validation.
 */
export const EMAIL_RUN_VARIABLES: Set<string> = new Set([
  "email_from",
  "email_subject",
  "email_body",
]);

/**
 * In-place `{variable_name}` substitution into a step message's text parts.
 * Extracted verbatim from processUiMessagesFlow (ee/workers.ts) with the
 * empty-safe email-variable rule added. Throws the pre-existing error text
 * when a value is missing so callers/tests relying on it keep working.
 */
export const substituteVariablesInMessage = (
  message: UIMessage,
  variables?: Record<string, any>,
): void => {
  for (const part of message.parts) {
    if (part.type !== "text") {
      continue;
    }
    const variableNames = [...part.text.matchAll(/{([^}]+)}/g)].map((match) => match[1]);
    for (const variableName of variableNames) {
      if (!variableName) {
        continue;
      }
      const variableValue = variables?.[variableName];
      const provided = EMAIL_RUN_VARIABLES.has(variableName)
        ? variableValue !== undefined && variableValue !== null
        : Boolean(variableValue);
      if (!provided) {
        throw new Error(
          `Value for variable ${variableName} not provided in variables for processing message flow. Either remove it from the messages, or provide it as an argument.`,
        );
      }
      part.text = part.text.replaceAll(`{${variableName}}`, String(variableValue));
    }
  }
};

/**
 * True when the (final) message of a step ended on an approval-requested tool
 * part — the pause signal for session-backed routine runs (spec §5.3).
 */
export const messageHasPendingApproval = (message: UIMessage | undefined): boolean =>
  !!message?.parts?.some((part) => isPendingApprovalToolPart(part));
```

- [ ] **Step 5: Run tests — expect PASS** (flow-steps AND the untouched auto-decline suite)

```bash
npm test -- --testPathPattern="flow-steps|auto-decline"
```

Expected: all pass (`Tests: 12 passed` for flow-steps + existing auto-decline tests).

- [ ] **Step 6: Commit**

```bash
git add src/exulu/routines/flow-steps.ts src/exulu/routines/flow-steps.test.ts src/exulu/auto-decline-stale-approvals.ts
git commit -m "feat(routines): step-variable substitution with empty-safe email vars + approval detection

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `createRunSession` — session + rbac snapshot (`src/exulu/routines/run-session.ts`)

**Files:**
- Create: `src/exulu/routines/run-session.ts`
- Create: `src/exulu/routines/run-session.test.ts`

**Interfaces:**
- Produces (CONTRACT-FIXED signature — Plan 2's intake calls this verbatim):

```typescript
export async function createRunSession(opts: {
  db: any;
  workflow: { id: string; name: string; agent: string; rights_mode?: string };
  userId: number;
  title: string;
  trigger: "email" | "schedule" | "manual" | "api";
  jobResultId?: string;
}): Promise<string>
```

  Creates an `agent_sessions` row (`metadata { routine_id, job_result_id, trigger }`), copies the routine's `rights_mode` and duplicates the routine's `rbac` rows (`entity: "workflow_template"`, `target_resource_id = routine.id`) as session rows (`entity: "agent_session"`, `target_resource_id = session.id`, rights preserved read→read/write→write), returns the session uuid.
  - Also produces: `export const isRunSessionMetadata = (metadata: unknown): boolean` — used by `provider.ts` in Task 6 to load full multi-author history for run sessions.
- Consumes: `rbac` table columns per `ee/rbac-update.ts` (`entity`, `access_type`, `target_resource_id`, `user_id`/`role_id`/`team_id`, `rights`, `createdAt`, `updatedAt`).

- [ ] **Step 1: Write the failing test** — create `src/exulu/routines/run-session.test.ts`:

```typescript
import { createRunSession, isRunSessionMetadata } from "./run-session";

const createFakeDb = (routineRbacRows: any[]) => {
  const inserted: { agent_sessions: any[]; rbac: any[] } = { agent_sessions: [], rbac: [] };
  const rbacWhereCalls: any[] = [];
  const db = {
    from(table: string) {
      if (table === "agent_sessions") {
        return {
          insert(row: any) {
            inserted.agent_sessions.push(row);
            return { returning: async () => [{ id: "session-uuid-1" }] };
          },
        };
      }
      if (table === "rbac") {
        return {
          where(criteria: any) {
            rbacWhereCalls.push(criteria);
            return { select: async () => routineRbacRows };
          },
          insert: async (rows: any[]) => {
            inserted.rbac.push(...rows);
            return rows.length;
          },
        };
      }
      throw new Error("unexpected table " + table);
    },
  };
  return { db, inserted, rbacWhereCalls };
};

const workflow = { id: "wf-1", name: "Spare parts", agent: "agent-1", rights_mode: "roles" };

describe("createRunSession", () => {
  it("creates the session with agent/user/title/rights_mode and run metadata", async () => {
    const { db, inserted } = createFakeDb([]);
    const sessionId = await createRunSession({
      db,
      workflow,
      userId: 7,
      title: "Spare parts — 2026-07-15",
      trigger: "manual",
      jobResultId: "jr-1",
    });

    expect(sessionId).toBe("session-uuid-1");
    const row = inserted.agent_sessions[0];
    expect(row.agent).toBe("agent-1");
    expect(row.user).toBe(7);
    expect(row.created_by).toBe(7);
    expect(row.title).toBe("Spare parts — 2026-07-15");
    expect(row.rights_mode).toBe("roles");
    expect(row.metadata).toEqual({ routine_id: "wf-1", job_result_id: "jr-1", trigger: "manual" });
  });

  it("defaults rights_mode to private and job_result_id to null", async () => {
    const { db, inserted } = createFakeDb([]);
    await createRunSession({
      db,
      workflow: { id: "wf-1", name: "R", agent: "agent-1" },
      userId: 7,
      title: "t",
      trigger: "schedule",
    });
    expect(inserted.agent_sessions[0].rights_mode).toBe("private");
    expect(inserted.agent_sessions[0].metadata.job_result_id).toBeNull();
  });

  it("duplicates the routine's rbac rows onto the session (entity agent_session)", async () => {
    const routineRows = [
      { entity: "workflow_template", access_type: "User", target_resource_id: "wf-1", user_id: 9, role_id: null, team_id: null, rights: "write" },
      { entity: "workflow_template", access_type: "Role", target_resource_id: "wf-1", user_id: null, role_id: "role-1", team_id: null, rights: "read" },
      { entity: "workflow_template", access_type: "Team", target_resource_id: "wf-1", user_id: null, role_id: null, team_id: "team-1", rights: "read" },
    ];
    const { db, inserted, rbacWhereCalls } = createFakeDb(routineRows);
    await createRunSession({ db, workflow, userId: 7, title: "t", trigger: "email" });

    expect(rbacWhereCalls[0]).toEqual({ entity: "workflow_template", target_resource_id: "wf-1" });
    expect(inserted.rbac).toHaveLength(3);
    for (const row of inserted.rbac) {
      expect(row.entity).toBe("agent_session");
      expect(row.target_resource_id).toBe("session-uuid-1");
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.updatedAt).toBeInstanceOf(Date);
    }
    expect(inserted.rbac[0]).toMatchObject({ access_type: "User", user_id: 9, rights: "write" });
    expect(inserted.rbac[1]).toMatchObject({ access_type: "Role", role_id: "role-1", rights: "read" });
    expect(inserted.rbac[2]).toMatchObject({ access_type: "Team", team_id: "team-1", rights: "read" });
  });

  it("skips the rbac insert when the routine has no rbac rows", async () => {
    const { db, inserted } = createFakeDb([]);
    await createRunSession({ db, workflow, userId: 7, title: "t", trigger: "api" });
    expect(inserted.rbac).toHaveLength(0);
  });
});

describe("isRunSessionMetadata", () => {
  it("is true for objects and JSON strings with job_result_id", () => {
    expect(isRunSessionMetadata({ job_result_id: "jr-1" })).toBe(true);
    expect(isRunSessionMetadata(JSON.stringify({ job_result_id: "jr-1" }))).toBe(true);
  });
  it("is false for null, plain sessions, and malformed strings", () => {
    expect(isRunSessionMetadata(null)).toBe(false);
    expect(isRunSessionMetadata(undefined)).toBe(false);
    expect(isRunSessionMetadata({})).toBe(false);
    expect(isRunSessionMetadata({ job_result_id: null })).toBe(false);
    expect(isRunSessionMetadata("not-json")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

```bash
npm test -- --testPathPattern="run-session"
```

Expected: `Cannot find module './run-session'`.

- [ ] **Step 3: Implement** — create `src/exulu/routines/run-session.ts`:

```typescript
/**
 * Session-backed routine runs (spec 2026-07-15 §3.4): every run gets a real
 * agent_sessions row so admins can preview the transcript and jump into the
 * chat to answer tool approvals.
 *
 * RBAC is copied from the routine as a POINT-IN-TIME snapshot because
 * agent_sessions access control binds even super admins (applyAccessControl
 * special-cases the table). Later changes to the routine's RBAC do not
 * retroactively update existing run sessions. rbac rows use the SINGULAR
 * entity name "agent_session" — that is what applyAccessControl /
 * RBACResolver / handleRBACUpdate match on (table.name.singular).
 */

export async function createRunSession(opts: {
  db: any;
  workflow: { id: string; name: string; agent: string; rights_mode?: string };
  userId: number;
  title: string;
  trigger: "email" | "schedule" | "manual" | "api";
  jobResultId?: string;
}): Promise<string> {
  const { db, workflow, userId, title, trigger, jobResultId } = opts;

  const inserted = await db
    .from("agent_sessions")
    .insert({
      agent: workflow.agent,
      user: userId,
      created_by: userId,
      title,
      rights_mode: workflow.rights_mode ?? "private",
      // Session ⇄ run cross-link; the agent-run route uses job_result_id to
      // resume a paused run after an approval turn (spec §5.5).
      metadata: {
        routine_id: workflow.id,
        job_result_id: jobResultId ?? null,
        trigger,
      },
    })
    .returning("id");

  const sessionId: string = inserted[0].id;

  const routineRbacRows: {
    access_type: string;
    user_id: number | null;
    role_id: string | null;
    team_id: string | null;
    rights: string;
  }[] = await db
    .from("rbac")
    .where({ entity: "workflow_template", target_resource_id: workflow.id })
    .select("*");

  if (routineRbacRows.length > 0) {
    const now = new Date();
    await db.from("rbac").insert(
      routineRbacRows.map((row) => ({
        entity: "agent_session",
        access_type: row.access_type,
        target_resource_id: sessionId,
        user_id: row.user_id ?? null,
        role_id: row.role_id ?? null,
        team_id: row.team_id ?? null,
        rights: row.rights,
        createdAt: now,
        updatedAt: now,
      })),
    );
  }

  return sessionId;
}

/**
 * True when an agent_sessions row belongs to a routine run (its metadata
 * carries job_result_id). Accepts the raw column value: object (pg jsonb)
 * or JSON string.
 */
export const isRunSessionMetadata = (metadata: unknown): boolean => {
  if (metadata == null) {
    return false;
  }
  let parsed: unknown = metadata;
  if (typeof metadata === "string") {
    try {
      parsed = JSON.parse(metadata);
    } catch {
      return false;
    }
  }
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    !!(parsed as { job_result_id?: unknown }).job_result_id
  );
};
```

- [ ] **Step 4: Run it — expect PASS**

```bash
npm test -- --testPathPattern="run-session"
```

Expected: `Tests: 6 passed`.

- [ ] **Step 5: Lint + commit**

```bash
npm run lint:errors
git add src/exulu/routines/run-session.ts src/exulu/routines/run-session.test.ts
git commit -m "feat(routines): createRunSession with point-in-time rbac snapshot

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Run-state CAS helpers + waiting-approval resume (`src/exulu/routines/run-state.ts`)

**Files:**
- Create: `src/exulu/routines/run-state.ts`
- Create: `src/exulu/routines/run-state.test.ts`

**Interfaces:**
- Produces (first two CONTRACT-FIXED; the rest are internal helpers this plan owns):

```typescript
export async function casJobResultState(db: any, jobResultId: string, from: string[], to: string): Promise<boolean>
export async function resumeRoutineRunIfWaiting(db: any, sessionId: string): Promise<boolean>
export const parseRunMetadata = (value: unknown): Record<string, any>
export async function upsertWorkflowRunStart(db: any, opts: {
  jobId: string; jobResultId?: string; label: string; state: string; workflow: string;
  session: string | null; trigger: string | null; triggerMetadata: Record<string, unknown> | null;
  bookkeeping: { run_as: { user?: number; role?: string }; inputs: Record<string, unknown>; queue_name: string };
  resumeFromIndex: number;
}): Promise<{ jobResultId: string; session: string | null; resumeFromIndex: number }>
export async function cancelRoutineRunRow(db: any, row: { id: string; job_id?: string | null; session?: string | null; metadata?: unknown }, queues: { list: Map<string, { use: () => Promise<any> }> }): Promise<void>
```

- Consumes: `queues as ExuluQueues` from `@EE/queues/queues` (`.list: Map<string, { …, use(): Promise<ExuluQueueConfig> }>` — provider workflow queues register here at boot in the API process too); `BullMqJobData` from Task 2; `JOB_STATUS_ENUM`/`uuid`; `clearStreamActive` (`@SRC/exulu/active-streams.ts`).
- `cancelRoutineRunRow` is the SINGLE cancel path (spec §5.6): the `cancelRoutineRun` resolver AND session deletion (`postprocessDeletion`) both call it in Task 10, so cancel behaves identically everywhere (CAS to cancelled + pending BullMQ job removal + stream-active cleanup).
- Run bookkeeping convention (used by the worker in Task 7 and the GraphQL retry in Task 10): `job_results.metadata` always carries `{ run_as: {user, role}, inputs, queue_name, current_step_index }` for workflow rows, so cancel/retry/resume can re-enqueue without the (ephemeral) Redis payload.

- [ ] **Step 1: Write the failing test** — create `src/exulu/routines/run-state.test.ts`:

```typescript
import { JOB_STATUS_ENUM } from "@EXULU_TYPES/enums/jobs";

jest.mock("@EE/queues/queues", () => ({
  queues: { list: new Map() },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { queues: queuesMock } = require("@EE/queues/queues") as {
  queues: { list: Map<string, { use: () => Promise<any> }> };
};

import {
  casJobResultState,
  parseRunMetadata,
  resumeRoutineRunIfWaiting,
  upsertWorkflowRunStart,
} from "./run-state";

type Calls = { name: string; args: any[] }[];

const makeJobResultsDb = (opts: { row?: any; update?: jest.Mock; insertId?: string }) => {
  const calls: Calls = [];
  const update = opts.update ?? jest.fn().mockResolvedValue(1);
  const builder: any = {
    where: (...args: any[]) => {
      calls.push({ name: "where", args });
      return builder;
    },
    whereIn: (...args: any[]) => {
      calls.push({ name: "whereIn", args });
      return builder;
    },
    orderBy: (...args: any[]) => {
      calls.push({ name: "orderBy", args });
      return builder;
    },
    first: async () => opts.row,
    update: (...args: any[]) => {
      calls.push({ name: "update", args });
      return update(...args);
    },
    insert: (...args: any[]) => {
      calls.push({ name: "insert", args });
      return { returning: async () => [{ id: opts.insertId ?? "jr-new" }] };
    },
  };
  const db: any = { from: jest.fn(() => builder) };
  return { db, calls, update };
};

afterEach(() => {
  queuesMock.list.clear();
  jest.clearAllMocks();
});

describe("parseRunMetadata", () => {
  it("parses JSON strings, passes objects through, and defaults to {}", () => {
    expect(parseRunMetadata('{"a":1}')).toEqual({ a: 1 });
    expect(parseRunMetadata({ a: 1 })).toEqual({ a: 1 });
    expect(parseRunMetadata(null)).toEqual({});
    expect(parseRunMetadata("boom{")).toEqual({});
  });
});

describe("casJobResultState", () => {
  it("returns true when a row transitioned and records the CAS clauses", async () => {
    const { db, calls } = makeJobResultsDb({});
    const moved = await casJobResultState(db, "jr-1", ["waiting", "active"], "cancelled");
    expect(moved).toBe(true);
    expect(calls.find((c) => c.name === "where")?.args).toEqual([{ id: "jr-1" }]);
    expect(calls.find((c) => c.name === "whereIn")?.args).toEqual(["state", ["waiting", "active"]]);
    expect(calls.find((c) => c.name === "update")?.args).toEqual([{ state: "cancelled" }]);
  });

  it("returns false when no row matched (CAS lost)", async () => {
    const { db } = makeJobResultsDb({ update: jest.fn().mockResolvedValue(0) });
    expect(await casJobResultState(db, "jr-1", ["failed"], "waiting")).toBe(false);
  });
});

describe("upsertWorkflowRunStart", () => {
  const bookkeeping = {
    run_as: { user: 7, role: "role-1" },
    inputs: { email_body: "" },
    queue_name: "workflow-queue",
  };
  const baseOpts = {
    jobId: "bull-1",
    label: "workflow-run-wf-1",
    state: "active",
    workflow: "wf-1",
    session: null,
    trigger: "email",
    triggerMetadata: { message_id: "<x@y>" },
    bookkeeping,
    resumeFromIndex: 0,
  };

  it("updates in place when jobResultId is provided (continuation/retry/email intake)", async () => {
    const { db, calls } = makeJobResultsDb({});
    const result = await upsertWorkflowRunStart(db, {
      ...baseOpts,
      jobResultId: "jr-9",
      session: "sess-9",
      resumeFromIndex: 3,
    });
    expect(result).toEqual({ jobResultId: "jr-9", session: "sess-9", resumeFromIndex: 3 });
    expect(calls.find((c) => c.name === "where")?.args).toEqual([{ id: "jr-9" }]);
    const updateArgs = calls.find((c) => c.name === "update")!.args[0];
    expect(updateArgs.job_id).toBe("bull-1");
    expect(updateArgs.workflow).toBe("wf-1");
    expect(updateArgs.trigger).toBe("email");
    expect(updateArgs.session).toBe("sess-9");
    expect(JSON.parse(updateArgs.metadata)).toEqual({ ...bookkeeping, current_step_index: 3 });
  });

  it("merges prior metadata on the jobResultId path — pre-pause tokens/messages survive (spec §5.7)", async () => {
    const existing = {
      id: "jr-9",
      metadata: JSON.stringify({
        tokens: {
          totalTokens: 500,
          reasoningTokens: 10,
          inputTokens: 300,
          outputTokens: 200,
          cachedInputTokens: 0,
        },
        messages: [{ id: "m-old" }],
        ...bookkeeping,
        current_step_index: 1,
      }),
    };
    const { db, calls } = makeJobResultsDb({ row: existing });
    await upsertWorkflowRunStart(db, {
      ...baseOpts,
      jobResultId: "jr-9",
      session: "sess-9",
      resumeFromIndex: 2,
    });
    const merged = JSON.parse(calls.find((c) => c.name === "update")!.args[0].metadata);
    expect(merged.tokens.totalTokens).toBe(500);
    expect(merged.messages).toEqual([{ id: "m-old" }]);
    expect(merged.queue_name).toBe("workflow-queue");
    expect(merged.current_step_index).toBe(2);
  });

  it("reuses an existing row by job_id on BullMQ attempt retries (session + progress survive)", async () => {
    const existing = {
      id: "jr-5",
      session: "sess-5",
      tries: 1,
      metadata: JSON.stringify({ ...bookkeeping, current_step_index: 2 }),
    };
    const { db, calls } = makeJobResultsDb({ row: existing });
    const result = await upsertWorkflowRunStart(db, baseOpts);
    expect(result).toEqual({ jobResultId: "jr-5", session: "sess-5", resumeFromIndex: 2 });
    const updateArgs = calls.find((c) => c.name === "update")!.args[0];
    expect(updateArgs.tries).toBe(2);
    expect(JSON.parse(updateArgs.metadata).current_step_index).toBe(2);
  });

  it("inserts a fresh row (type workflow, trigger stamped) otherwise", async () => {
    const { db, calls } = makeJobResultsDb({ row: undefined, insertId: "jr-new" });
    const result = await upsertWorkflowRunStart(db, baseOpts);
    expect(result).toEqual({ jobResultId: "jr-new", session: null, resumeFromIndex: 0 });
    const insertArgs = calls.find((c) => c.name === "insert")!.args[0];
    expect(insertArgs).toMatchObject({
      job_id: "bull-1",
      label: "workflow-run-wf-1",
      state: "active",
      tries: 1,
      type: "workflow",
      workflow: "wf-1",
      trigger: "email",
    });
    expect(JSON.parse(insertArgs.trigger_metadata)).toEqual({ message_id: "<x@y>" });
    expect(JSON.parse(insertArgs.metadata)).toEqual({ ...bookkeeping, current_step_index: 0 });
  });
});

describe("resumeRoutineRunIfWaiting", () => {
  const waitingRow = {
    id: "jr-1",
    state: JOB_STATUS_ENUM.waiting_approval,
    workflow: "wf-1",
    session: "sess-1",
    trigger: "email",
    trigger_metadata: { message_id: "<x@y>" },
    metadata: JSON.stringify({
      run_as: { user: 7, role: "role-1" },
      inputs: { email_body: "hello" },
      queue_name: "workflow-queue",
      current_step_index: 1,
    }),
  };

  const registerQueue = () => {
    const add = jest.fn().mockResolvedValue({ id: "bull-2" });
    queuesMock.list.set("workflow-queue", {
      use: async () => ({ queue: { add }, timeoutInSeconds: 180, retries: undefined, backoff: undefined }),
    });
    return add;
  };

  it("returns false when there is no run row or it is not waiting_approval", async () => {
    expect(await resumeRoutineRunIfWaiting(makeJobResultsDb({ row: undefined }).db, "sess-1")).toBe(false);
    expect(
      await resumeRoutineRunIfWaiting(
        makeJobResultsDb({ row: { ...waitingRow, state: "active" } }).db,
        "sess-1",
      ),
    ).toBe(false);
  });

  it("CAS-wins → enqueues the continuation with resumeFromIndex = current_step_index + 1", async () => {
    const add = registerQueue();
    const { db } = makeJobResultsDb({ row: waitingRow });
    const resumed = await resumeRoutineRunIfWaiting(db, "sess-1");
    expect(resumed).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
    const [jobName, jobData] = add.mock.calls[0];
    expect(jobName).toBe("workflow_run");
    expect(jobData).toMatchObject({
      type: "workflow",
      workflow: "wf-1",
      session: "sess-1",
      jobResultId: "jr-1",
      resumeFromIndex: 2,
      user: 7,
      role: "role-1",
      triggerSource: "email",
    });
    expect(jobData.inputs).toEqual({ email_body: "hello" });
  });

  it("CAS-loses → does not enqueue (double-approval safe)", async () => {
    const add = registerQueue();
    const { db } = makeJobResultsDb({ row: waitingRow, update: jest.fn().mockResolvedValue(0) });
    expect(await resumeRoutineRunIfWaiting(db, "sess-1")).toBe(false);
    expect(add).not.toHaveBeenCalled();
  });

  it("reverts the CAS and rethrows when the queue is missing", async () => {
    const update = jest.fn().mockResolvedValue(1);
    const { db } = makeJobResultsDb({ row: waitingRow, update });
    await expect(resumeRoutineRunIfWaiting(db, "sess-1")).rejects.toThrow(
      "not registered",
    );
    // First update: waiting_approval -> active. Second: revert active -> waiting_approval.
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][0]).toEqual({ state: JOB_STATUS_ENUM.waiting_approval });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

```bash
npm test -- --testPathPattern="run-state"
```

Expected: `Cannot find module './run-state'`.

- [ ] **Step 3: Implement** — create `src/exulu/routines/run-state.ts`:

```typescript
/**
 * job_results state machine for session-backed routine runs (spec §5).
 * ALL transitions are conditional updates (CAS) so pause / cancel / complete
 * can never clobber each other, and only the CAS winner may enqueue a
 * continuation job (double-approval safe).
 */
import { v4 as uuidv4 } from "uuid";
import { queues as ExuluQueues } from "@EE/queues/queues";
import type { BullMqJobData } from "@EE/queues/decorator";
import { JOB_STATUS_ENUM } from "@EXULU_TYPES/enums/jobs";
import { clearStreamActive } from "@SRC/exulu/active-streams.ts";

/** job_results.metadata / trigger_metadata arrive as jsonb objects or strings. */
export const parseRunMetadata = (value: unknown): Record<string, any> => {
  if (value == null) {
    return {};
  }
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, any>) : {};
};

/** UPDATE … WHERE id = ? AND state IN (from) → true iff a row transitioned. */
export async function casJobResultState(
  db: any,
  jobResultId: string,
  from: string[],
  to: string,
): Promise<boolean> {
  const updated: number = await db
    .from("job_results")
    .where({ id: jobResultId })
    .whereIn("state", from)
    .update({ state: to });
  return updated > 0;
}

/**
 * Worker-pickup upsert for workflow runs (Task 7 calls this at handler start).
 *
 * Three paths:
 * 1. data.jobResultId set (continuation / retry / email-intake-created row):
 *    UPDATE that row in place, MERGING its existing metadata so pre-pause
 *    tokens/messages survive the resume (spec §5.7) — same run identity
 *    across pauses.
 * 2. A row already exists for this BullMQ job id (attempt-level retry after
 *    the in-handler retry loop exhausted): reuse it, including its session
 *    and persisted current_step_index, and bump tries.
 * 3. Fresh run: INSERT with type/workflow/trigger stamped.
 *
 * metadata always carries the run bookkeeping { run_as, inputs, queue_name,
 * current_step_index } so cancel/retry/resume never need the Redis payload.
 */
export async function upsertWorkflowRunStart(
  db: any,
  opts: {
    jobId: string;
    jobResultId?: string;
    label: string;
    state: string;
    workflow: string;
    session: string | null;
    trigger: string | null;
    triggerMetadata: Record<string, unknown> | null;
    bookkeeping: {
      run_as: { user?: number; role?: string };
      inputs: Record<string, unknown>;
      queue_name: string;
    };
    resumeFromIndex: number;
  },
): Promise<{ jobResultId: string; session: string | null; resumeFromIndex: number }> {
  const triggerMetadataJson = opts.triggerMetadata ? JSON.stringify(opts.triggerMetadata) : null;
  const metadataJson = (currentStepIndex: number) =>
    JSON.stringify({ ...opts.bookkeeping, current_step_index: currentStepIndex });

  if (opts.jobResultId) {
    // Spec §5.7: a continuation must not lose the pre-pause metadata written
    // at pause time (tokens, messages) — MERGE the existing row's metadata,
    // then apply the bookkeeping + step pointer on top.
    const currentRow = await db.from("job_results").where({ id: opts.jobResultId }).first();
    const priorMetadata = parseRunMetadata(currentRow?.metadata);
    await db
      .from("job_results")
      .where({ id: opts.jobResultId })
      .update({
        job_id: opts.jobId,
        state: opts.state,
        workflow: opts.workflow,
        trigger: opts.trigger,
        trigger_metadata: triggerMetadataJson,
        ...(opts.session ? { session: opts.session } : {}),
        metadata: JSON.stringify({
          ...priorMetadata,
          ...opts.bookkeeping,
          current_step_index: opts.resumeFromIndex,
        }),
      });
    return {
      jobResultId: opts.jobResultId,
      session: opts.session,
      resumeFromIndex: opts.resumeFromIndex,
    };
  }

  const existing = await db.from("job_results").where({ job_id: opts.jobId }).first();
  if (existing) {
    const existingMetadata = parseRunMetadata(existing.metadata);
    const resumeFromIndex =
      typeof existingMetadata.current_step_index === "number"
        ? existingMetadata.current_step_index
        : opts.resumeFromIndex;
    await db
      .from("job_results")
      .where({ id: existing.id })
      .update({
        state: opts.state,
        workflow: opts.workflow,
        trigger: opts.trigger,
        trigger_metadata: triggerMetadataJson,
        metadata: metadataJson(resumeFromIndex),
        tries: (existing.tries ?? 0) + 1,
      });
    return {
      jobResultId: existing.id,
      session: existing.session ?? opts.session,
      resumeFromIndex,
    };
  }

  const inserted = await db
    .from("job_results")
    .insert({
      job_id: opts.jobId,
      label: opts.label,
      state: opts.state,
      result: null,
      metadata: metadataJson(opts.resumeFromIndex),
      tries: 1,
      type: "workflow",
      workflow: opts.workflow,
      session: opts.session,
      trigger: opts.trigger,
      trigger_metadata: triggerMetadataJson,
    })
    .returning("id");
  return {
    jobResultId: inserted[0].id,
    session: opts.session,
    resumeFromIndex: opts.resumeFromIndex,
  };
}

/**
 * Called by the agent-run route's onFinish (spec §5.5): when a chat turn on a
 * run session completes and the run is waiting_approval, CAS it to active and
 * enqueue the continuation (new BullMQ job id, SAME job_results row) starting
 * at current_step_index + 1. Only the CAS winner enqueues. On enqueue failure
 * the CAS is reverted so a later approval turn can try again.
 */
export async function resumeRoutineRunIfWaiting(db: any, sessionId: string): Promise<boolean> {
  const row = await db
    .from("job_results")
    .where({ session: sessionId })
    .orderBy("createdAt", "desc")
    .first();

  if (!row || row.state !== JOB_STATUS_ENUM.waiting_approval) {
    return false;
  }

  const metadata = parseRunMetadata(row.metadata);
  const queueName = typeof metadata.queue_name === "string" ? metadata.queue_name : undefined;

  const won = await casJobResultState(
    db,
    row.id,
    [JOB_STATUS_ENUM.waiting_approval],
    JOB_STATUS_ENUM.active,
  );
  if (!won) {
    return false;
  }

  try {
    const entry = queueName ? ExuluQueues.list.get(queueName) : undefined;
    if (!entry) {
      throw new Error(
        `Queue ${queueName ?? "<unknown>"} is not registered; cannot resume routine run ${row.id}.`,
      );
    }
    const queue = await entry.use();

    const currentStepIndex =
      typeof metadata.current_step_index === "number" ? metadata.current_step_index : 0;
    const runAs = (metadata.run_as ?? {}) as { user?: number; role?: string };

    const jobData: BullMqJobData = {
      label: `Workflow Run ${row.workflow}`,
      trigger: "api",
      timeoutInSeconds: queue.timeoutInSeconds || 180,
      type: "workflow",
      workflow: row.workflow,
      inputs: (metadata.inputs as Record<string, unknown>) ?? {},
      user: runAs.user,
      role: runAs.role,
      session: sessionId,
      jobResultId: row.id,
      resumeFromIndex: currentStepIndex + 1,
      triggerSource: (row.trigger as BullMqJobData["triggerSource"]) ?? undefined,
      triggerMetadata: row.trigger_metadata ? parseRunMetadata(row.trigger_metadata) : undefined,
    };

    await queue.queue.add("workflow_run", jobData, {
      jobId: uuidv4(),
      attempts: queue.retries || 3,
      removeOnComplete: 5000,
      removeOnFail: 10000,
      backoff: queue.backoff || { type: "exponential", delay: 2000 },
    });
    return true;
  } catch (error) {
    // Give a later approval turn another chance to resume.
    await casJobResultState(db, row.id, [JOB_STATUS_ENUM.active], JOB_STATUS_ENUM.waiting_approval);
    throw error;
  }
}

/**
 * Shared cancel path (spec §5.6): CAS the run to cancelled, best-effort
 * remove its pending BullMQ job, and release the session's stream-active
 * flag. Used by BOTH the cancelRoutineRun resolver and session deletion
 * (postprocessDeletion) so the two paths behave identically. A lost CAS
 * (row already terminal) is a silent no-op — callers that need to report
 * "not cancellable" check the row state before calling.
 */
export async function cancelRoutineRunRow(
  db: any,
  row: { id: string; job_id?: string | null; session?: string | null; metadata?: unknown },
  queues: { list: Map<string, { use: () => Promise<any> }> },
): Promise<void> {
  const cancelled = await casJobResultState(
    db,
    row.id,
    [JOB_STATUS_ENUM.waiting, JOB_STATUS_ENUM.active, JOB_STATUS_ENUM.waiting_approval],
    JOB_STATUS_ENUM.cancelled,
  );
  if (!cancelled) {
    return;
  }

  // Best-effort: remove the pending BullMQ job (an actively-processing job
  // cannot be removed — the CAS'd state makes its completion a no-op).
  const runMetadata = parseRunMetadata(row.metadata);
  if (row.job_id && typeof runMetadata.queue_name === "string") {
    try {
      const entry = queues.list.get(runMetadata.queue_name);
      if (entry) {
        const queueConfig = await entry.use();
        const job = await queueConfig.queue.getJob(row.job_id);
        if (job) {
          await job.remove();
        }
      }
    } catch (removeError) {
      console.warn(
        `[EXULU] could not remove BullMQ job ${row.job_id} for cancelled run ${row.id}.`,
        removeError instanceof Error ? removeError.message : String(removeError),
      );
    }
  }
  if (row.session) {
    clearStreamActive(row.session);
  }
}
```

- [ ] **Step 4: Run it — expect PASS**

```bash
npm test -- --testPathPattern="run-state"
```

Expected: `Tests: 11 passed`.

- [ ] **Step 5: Lint + commit**

```bash
npm run lint:errors && npm run type-check
git add src/exulu/routines/run-state.ts src/exulu/routines/run-state.test.ts
git commit -m "feat(routines): run-state CAS helpers + waiting-approval resume

casJobResultState / upsertWorkflowRunStart / resumeRoutineRunIfWaiting /
cancelRoutineRunRow: all job_results transitions are conditional updates;
only the CAS winner enqueues a continuation (resumeFromIndex =
current_step_index + 1, same job_results row, new BullMQ job id).
upsertWorkflowRunStart merges prior metadata on the jobResultId path so
pre-pause tokens/messages survive a resume; cancelRoutineRunRow is the
shared cancel path for the resolver and session deletion.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Session-backed `processUiMessagesFlow` (pause / resume / persistence) + run-session history loading

**Files:**
- Modify: `ee/workers.ts` (imports ~line 1-34; `processUiMessagesFlow` lines ~1317-1606; new `FlowStepError` class above it)
- Modify: `src/exulu/provider.ts` (`getAgentMessages` lines 1227-1244; `generateStream` history-loading block lines ~874-885)
- Create: `ee/workers.flow.test.ts`

**Interfaces:**
- Produces (CONTRACT-FIXED options + return field):
  - `processUiMessagesFlow` gains `sessionId?: string` (persist each step's messages to `agent_messages`, pass session to `generateStream`, hold `markStreamActive`/`clearStreamActive`), `resumeFromIndex?: number` (default 0; skip steps before index; when >0 reload prior history from `agent_messages`), `respectToolApprovals?: boolean` (when true DO NOT pass blanket `approvedTools`; after each step inspect the final message for state `approval-requested`); return value gains `pausedAtStepIndex?: number`.
  - `export class FlowStepError extends Error { readonly stepIndex: number }` (ee/workers.ts) — carries the failing step so Task 7's retry loop resumes there.
  - `getAgentMessages` gains `includeAllUsers?: boolean` (run sessions are multi-author: run identity + approving admin; `agent_messages.message_id` merges rewrite the `user` column, so per-user filtering would drop resolved approvals from reloaded history).
- Consumes: Task 3 helpers, Task 4 `isRunSessionMetadata`, `saveChat`/`getAgentMessages` (provider.ts), `markStreamActive`/`clearStreamActive` (`src/exulu/active-streams.ts`), `uuidv4` (already imported in workers.ts).
- Behavior guarantee: with NO `sessionId`, the function is byte-for-byte behavior-identical to today (headless, blanket approvals, no persistence) — `runEval`/inline callers unaffected.

- [ ] **Step 1: Write the failing test** — create `ee/workers.flow.test.ts`:

```typescript
import type { UIMessage } from "ai";

// ee/workers.ts pulls in the whole worker runtime; mock everything with
// side effects / heavy transitive imports. Specifiers match workers.ts's
// own import strings (moduleNameMapper resolves both aliased forms).
jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({ db: jest.fn() })),
}));
jest.mock("@SRC/utils/enabled-tools.ts", () => ({
  getEnabledTools: jest.fn(async () => []),
}));
jest.mock("@SRC/exulu/resolve-model.ts", () => ({
  resolveModel: jest.fn(async () => ({ apiKey: undefined, languageModel: {} })),
}));
jest.mock("@SRC/exulu/statistics", () => ({
  updateStatistic: jest.fn(async () => undefined),
}));
jest.mock("@SRC/exulu/storage.ts", () => ({ ExuluStorage: class {} }));
jest.mock("@SRC/exulu/context.ts", () => ({ getTableName: jest.fn() }));
jest.mock("@SRC/exulu/app/singleton", () => ({ exuluApp: { get: jest.fn() } }));
jest.mock("@SRC/exulu/provider.ts", () => ({
  saveChat: jest.fn(async () => undefined),
  getAgentMessages: jest.fn(async () => []),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const providerModule = require("@SRC/exulu/provider.ts") as {
  saveChat: jest.Mock;
  getAgentMessages: jest.Mock;
};

import { FlowStepError, processUiMessagesFlow } from "./workers";

const step = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

const assistant = (id: string, parts: any[]): UIMessage =>
  ({ id, role: "assistant", parts }) as UIMessage;

const approvalPart = {
  type: "tool-create_offer",
  state: "approval-requested",
  approval: { id: "appr-1" },
};

/**
 * Stub ExuluProvider: generateStream returns a fake AI-SDK stream whose
 * toUIMessageStream immediately finishes with [history + step + response].
 * `responses[n]` = assistant messages appended by the n-th generateStream call.
 * A response of `null` makes that call's stream error (onError + reject).
 */
const makeStubProvider = (responses: (UIMessage[] | null)[]) => {
  let call = 0;
  const generateStream = jest.fn(async (opts: any) => {
    const index = call++;
    const original: UIMessage[] = [...(opts.previousMessages ?? []), opts.message];
    return {
      originalMessages: original,
      previousMessages: opts.previousMessages ?? [],
      stream: {
        toUIMessageStream: (streamOpts: any) => ({
          async *[Symbol.asyncIterator]() {
            const response = responses[index];
            if (response === null) {
              streamOpts.onError(new Error("provider exploded"));
              return;
            }
            await streamOpts.onFinish({ messages: [...original, ...(response ?? [])] });
          },
        }),
      },
    };
  });
  return { provider: { generateStream } as any, generateStream };
};

const baseArgs = (provider: any) => ({
  providers: [] as any[],
  agent: { id: "agent-1", name: "Agent", model: "model-1", tools: [], instructions: "do" } as any,
  provider,
  contexts: [] as any[],
  user: { id: 7, role: { id: "role-1" } } as any,
  tools: [{ name: "Create Offer" }] as any[],
  config: {} as any,
});

afterEach(() => jest.clearAllMocks());

describe("processUiMessagesFlow (headless — unchanged legacy behavior)", () => {
  it("passes session undefined + blanket approvedTools and never persists", async () => {
    const { provider, generateStream } = makeStubProvider([[assistant("a1", [{ type: "text", text: "ok" }])]]);
    const result = await processUiMessagesFlow({
      ...baseArgs(provider),
      inputMessages: [step("s1", "hello")],
    });
    expect(generateStream).toHaveBeenCalledTimes(1);
    const opts = generateStream.mock.calls[0][0];
    expect(opts.session).toBeUndefined();
    expect(Array.isArray(opts.approvedTools)).toBe(true);
    expect(providerModule.saveChat).not.toHaveBeenCalled();
    expect(result.pausedAtStepIndex).toBeUndefined();
    expect(result.messages.map((m) => m.id)).toContain("a1");
  });
});

describe("processUiMessagesFlow (session-backed)", () => {
  it("passes the session, rewrites step ids, and persists at each step boundary", async () => {
    const { provider, generateStream } = makeStubProvider([
      [assistant("a1", [{ type: "text", text: "one" }])],
      [assistant("a2", [{ type: "text", text: "two" }])],
    ]);
    await processUiMessagesFlow({
      ...baseArgs(provider),
      inputMessages: [step("s1", "first"), step("s2", "second")],
      sessionId: "sess-1",
    });
    expect(generateStream).toHaveBeenCalledTimes(2);
    for (const call of generateStream.mock.calls) {
      expect(call[0].session).toBe("sess-1");
      // steps_json ids repeat across runs — persisted ids must be fresh:
      expect(call[0].message.id).toMatch(/^wfmsg-/);
    }
    expect(providerModule.saveChat).toHaveBeenCalledTimes(2);
    expect(providerModule.saveChat.mock.calls[0][0]).toMatchObject({ session: "sess-1", user: 7 });
  });

  it("drops the blanket approvedTools when respectToolApprovals is set", async () => {
    const { provider, generateStream } = makeStubProvider([[assistant("a1", [{ type: "text", text: "ok" }])]]);
    await processUiMessagesFlow({
      ...baseArgs(provider),
      inputMessages: [step("s1", "x")],
      sessionId: "sess-1",
      respectToolApprovals: true,
    });
    expect(generateStream.mock.calls[0][0].approvedTools).toBeUndefined();
  });

  it("pauses at the step whose final message requests approval and skips later steps", async () => {
    const { provider, generateStream } = makeStubProvider([
      [assistant("a1", [approvalPart])],
      [assistant("a2", [{ type: "text", text: "never reached" }])],
    ]);
    const result = await processUiMessagesFlow({
      ...baseArgs(provider),
      inputMessages: [step("s1", "gated"), step("s2", "after")],
      sessionId: "sess-1",
      respectToolApprovals: true,
    });
    expect(result.pausedAtStepIndex).toBe(0);
    expect(generateStream).toHaveBeenCalledTimes(1);
    // The paused transcript was persisted before returning:
    expect(providerModule.saveChat).toHaveBeenCalledTimes(1);
  });

  it("resumeFromIndex skips completed steps and reloads history from agent_messages", async () => {
    providerModule.getAgentMessages.mockResolvedValueOnce([
      { content: JSON.stringify(step("old-1", "first")) },
      { content: JSON.stringify(assistant("old-a1", [{ type: "text", text: "done" }])) },
    ]);
    const { provider, generateStream } = makeStubProvider([
      [assistant("a2", [{ type: "text", text: "resumed" }])],
    ]);
    const result = await processUiMessagesFlow({
      ...baseArgs(provider),
      inputMessages: [step("s1", "first"), step("s2", "second")],
      sessionId: "sess-1",
      resumeFromIndex: 1,
    });
    expect(providerModule.getAgentMessages).toHaveBeenCalledWith({
      session: "sess-1",
      includeAllUsers: true,
    });
    expect(generateStream).toHaveBeenCalledTimes(1); // only step index 1
    expect(generateStream.mock.calls[0][0].previousMessages.map((m: UIMessage) => m.id)).toEqual([
      "old-1",
      "old-a1",
    ]);
    expect(result.messages.map((m) => m.id)).toContain("a2");
  });

  it("wraps step failures in FlowStepError carrying the failing step index", async () => {
    const { provider } = makeStubProvider([
      [assistant("a1", [{ type: "text", text: "ok" }])],
      null, // step 1 explodes
    ]);
    const promise = processUiMessagesFlow({
      ...baseArgs(provider),
      inputMessages: [step("s1", "one"), step("s2", "two")],
      sessionId: "sess-1",
    });
    await expect(promise).rejects.toThrow("provider exploded");
    await promise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(FlowStepError);
      expect((error as FlowStepError).stepIndex).toBe(1);
    });
  });

  it("a rerun after a step-1 failure persists only steps >= 1 — no duplicate messages (spec §5.4/§9)", async () => {
    // First run: step 0 succeeds (one boundary persist), step 1 explodes.
    const first = makeStubProvider([
      [assistant("a1", [{ type: "text", text: "one" }])],
      null, // step 1 explodes
    ]);
    await expect(
      processUiMessagesFlow({
        ...baseArgs(first.provider),
        inputMessages: [step("s1", "one"), step("s2", "two")],
        sessionId: "sess-1",
      }),
    ).rejects.toThrow("provider exploded");
    expect(providerModule.saveChat).toHaveBeenCalledTimes(1); // step 0 only

    // Rerun from the failed step (what the worker's retry loop does with
    // FlowStepError.stepIndex): prior history reloads from agent_messages;
    // step 0 must NOT run or persist again.
    providerModule.saveChat.mockClear();
    providerModule.getAgentMessages.mockResolvedValueOnce([
      { content: JSON.stringify(step("old-s1", "one")) },
      { content: JSON.stringify(assistant("a1", [{ type: "text", text: "one" }])) },
    ]);
    const second = makeStubProvider([[assistant("a2", [{ type: "text", text: "two" }])]]);
    await processUiMessagesFlow({
      ...baseArgs(second.provider),
      inputMessages: [step("s1", "one"), step("s2", "two")],
      sessionId: "sess-1",
      resumeFromIndex: 1,
    });
    expect(second.generateStream).toHaveBeenCalledTimes(1); // only step index 1
    expect(providerModule.saveChat).toHaveBeenCalledTimes(1); // only the step-1 boundary
    const persisted = providerModule.saveChat.mock.calls[0][0].messages as UIMessage[];
    expect(persisted.map((m) => m.id)).toContain("a2");
    // Step 0's message reaches saveChat only via the reloaded history (same
    // ids — saveChat's message_id merge keeps it a no-op), never as a re-run.
    expect(persisted.filter((m) => m.id === "a1")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

```bash
npm test -- --testPathPattern="workers.flow"
```

Expected: compile error `Module '"./workers"' has no exported member 'FlowStepError'` (plus unknown-option errors for `sessionId`).

- [ ] **Step 3: Add `includeAllUsers` to `getAgentMessages`** — in `src/exulu/provider.ts`, replace:

```typescript
export const getAgentMessages = async ({
  session,
  user,
}: {
  session: string;
  user?: number;
}) => {
  const { db } = await postgresClient();
  console.log("[EXULU] getting agent messages for session: " + session + " and user: " + user);
  const messages = await db
    .from("agent_messages")
    .where({ session, user: user || null })
    .orderBy([
```

with:

```typescript
export const getAgentMessages = async ({
  session,
  user,
  includeAllUsers,
}: {
  session: string;
  user?: number;
  /**
   * Routine-run sessions are multi-author (run identity + approving admin),
   * and saveChat's message_id merge rewrites the user column — per-user
   * filtering would drop resolved approvals from reloaded history. Set by
   * generateStream for run sessions and by workflow resume reloads.
   */
  includeAllUsers?: boolean;
}) => {
  const { db } = await postgresClient();
  console.log("[EXULU] getting agent messages for session: " + session + " and user: " + user);
  const messages = await db
    .from("agent_messages")
    .where(includeAllUsers ? { session } : { session, user: user || null })
    .orderBy([
```

- [ ] **Step 4: Load full history for run sessions in `generateStream`** — in `src/exulu/provider.ts` (~line 874, inside `generateStream`), replace:

```typescript
    if (session) {
      const sessionData = await getSession({ sessionID: session });
      project = sessionData.project;
      sessionItems = sessionData.session_items;

      console.log("[EXULU] loading previous messages from session: " + session);
      const previousMessages = await getAgentMessages({
        session,
        user: user?.id,
      });
      previousMessagesContent = previousMessages.map((message) => JSON.parse(message.content));
    }
```

with:

```typescript
    if (session) {
      const sessionData = await getSession({ sessionID: session });
      project = sessionData.project;
      sessionItems = sessionData.session_items;

      console.log("[EXULU] loading previous messages from session: " + session);
      const previousMessages = await getAgentMessages({
        session,
        user: user?.id,
        // Run sessions (metadata.job_result_id) mix the run identity's
        // messages with the approving admin's turns — load them all so the
        // approval card resolves against the full transcript (spec §5.5).
        includeAllUsers: isRunSessionMetadata(sessionData.metadata),
      });
      previousMessagesContent = previousMessages.map((message) => JSON.parse(message.content));
    }
```

And add the import at the top of `src/exulu/provider.ts`, directly after the line `import { guardExtractedFileText } from "./tool-output-offload";`:

```typescript
import { isRunSessionMetadata } from "./routines/run-session";
```

(The other history-loading site in `generateSync` (~line 341) stays untouched — routine runs never flow through it, and its callers are single-user.)

- [ ] **Step 5: Add imports + `FlowStepError` to `ee/workers.ts`** — replace:

```typescript
import { updateStatistic } from "@SRC/exulu/statistics";
import type { ExuluProvider } from "@SRC/exulu/provider.ts";
import { exuluApp } from "@SRC/exulu/app/singleton";
```

with:

```typescript
import { updateStatistic } from "@SRC/exulu/statistics";
import type { ExuluProvider } from "@SRC/exulu/provider.ts";
import { saveChat, getAgentMessages } from "@SRC/exulu/provider.ts";
import { exuluApp } from "@SRC/exulu/app/singleton";
import { markStreamActive, clearStreamActive } from "@SRC/exulu/active-streams.ts";
import { messageHasPendingApproval, substituteVariablesInMessage } from "@SRC/exulu/routines/flow-steps.ts";

/**
 * Session-backed runs persist messages at each step boundary, so retries must
 * resume AT the failed step instead of re-running (and re-persisting) earlier
 * ones (spec §5.4). This wrapper carries the failing step index to the
 * workflow handler's retry loop.
 */
export class FlowStepError extends Error {
  public readonly stepIndex: number;
  constructor(stepIndex: number, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "FlowStepError";
    this.stepIndex = stepIndex;
  }
}
```

(Task 6 adds NO unused imports: the `createRunSession`/`casJobResultState`/`parseRunMetadata`/`upsertWorkflowRunStart` imports are added in Task 7 Step 1, where they are first used.)

- [ ] **Step 6: Extend the `processUiMessagesFlow` signature** — in `ee/workers.ts`, replace:

```typescript
export const processUiMessagesFlow = async ({
  providers,
  agent,
  provider,
  inputMessages,
  contexts,
  user,
  tools,
  config,
  variables,
  routine,
}: {
```

with:

```typescript
export const processUiMessagesFlow = async ({
  providers,
  agent,
  provider,
  inputMessages,
  contexts,
  user,
  tools,
  config,
  variables,
  routine,
  sessionId,
  resumeFromIndex,
  respectToolApprovals,
}: {
```

then replace:

```typescript
  routine?: { id: string; name: string };
}): Promise<{
  messages: UIMessage[];
  metadata: {
    tokens: {
      totalTokens: number;
      reasoningTokens: number;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
    };
    duration: number;
  };
}> => {
```

with:

```typescript
  routine?: { id: string; name: string };
  /**
   * Session-backed runs (spec §5.1): persist each step's messages to
   * agent_messages at the step boundary, pass the session to generateStream
   * (which reloads history from the DB per step), and hold the
   * stream-active flag for the session while executing.
   */
  sessionId?: string;
  /** Skip steps before this index (approval resume / retry-from-step). Default 0. */
  resumeFromIndex?: number;
  /**
   * When true, do NOT blanket-approve every tool — approval-gated tools pause
   * the run (pausedAtStepIndex). Routines with auto_approve_tools = true and
   * all legacy callers keep the blanket pre-approval (spec §5.2).
   */
  respectToolApprovals?: boolean;
}): Promise<{
  messages: UIMessage[];
  metadata: {
    tokens: {
      totalTokens: number;
      reasoningTokens: number;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
    };
    duration: number;
  };
  /** Set when the run paused on an approval-requested tool part (spec §5.3). */
  pausedAtStepIndex?: number;
}> => {
```

- [ ] **Step 7: Rewrite the step loop** — in `ee/workers.ts`, replace the ENTIRE region from `console.log("[EXULU] variables", variables);` down to the closing `return messageHistory;\n};` of the function (the current for-of loop, variable-substitution block, generateStream promise, and final return — verbatim current code shown in the recon at lines 1434-1606) with:

```typescript
  console.log("[EXULU] variables", variables);

  const startIndex = resumeFromIndex ?? 0;

  // Resume: prior steps already persisted their messages — reload them so the
  // returned transcript is complete. generateStream reloads its own copy from
  // the session per step; this keeps messageHistory (the return value +
  // previousMessages for headless callers) consistent with it.
  if (sessionId && startIndex > 0) {
    const priorRows = await getAgentMessages({ session: sessionId, includeAllUsers: true });
    messageHistory.messages = priorRows.map(
      (row: { content: string }) => JSON.parse(row.content) as UIMessage,
    );
  }

  if (sessionId) markStreamActive(sessionId);
  try {
    for (let stepIndex = 0; stepIndex < messagesWithoutPlaceholder.length; stepIndex++) {
      const currentMessage = messagesWithoutPlaceholder[stepIndex]!;
      if (stepIndex < startIndex) {
        continue;
      }
      console.log("[EXULU] running through the conversation");
      console.log("[EXULU] current index", stepIndex);
      console.log("[EXULU] current message", currentMessage);
      console.log("[EXULU] message history", messageHistory);

      // steps_json message ids repeat across runs of the same routine, and
      // agent_messages.message_id is globally unique (saveChat merges on it) —
      // persisted run messages need a fresh id per run.
      if (sessionId) {
        currentMessage.id = `wfmsg-${uuidv4()}`;
      }

      // Identify {variable_name} in the current message parts and replace them
      // with the values in variables. Throws when a required value is missing;
      // the auto-provided email variables are empty-safe (spec §4.5).
      substituteVariablesInMessage(currentMessage, variables);

      const statistics = {
        label: agent.name,
        trigger: "agent" as STATISTICS_LABELS,
      };

      try {
        messageHistory = await new Promise<{
          messages: UIMessage[];
          metadata: {
            tokens: {
              totalTokens: number;
              reasoningTokens: number;
              inputTokens: number;
              outputTokens: number;
              cachedInputTokens: number;
            };
            duration: number;
          };
        }>(async (resolve, reject) => {
          const startTime = Date.now();

          try {
            const result = await provider.generateStream({
              contexts,
              agent: agent,
              user,
              // Legacy blanket pre-approval unless this run respects
              // approvals (spec §5.2 — auto_approve_tools = false routines).
              approvedTools: respectToolApprovals
                ? undefined
                : tools.map((tool) => "tool-" + sanitizeToolName(tool.name)),
              instructions: agent.instructions,
              session: sessionId,
              previousMessages: messageHistory.messages,
              message: currentMessage,
              currentTools: enabledTools,
              allExuluTools: tools,
              languageModel: resolvedLanguageModel,
              providerapikey,
              toolConfigs: agent.tools,
              exuluConfig: config,
            });

            console.log("[EXULU] consuming stream for agent.");
            const stream = result.stream.toUIMessageStream({
              messageMetadata: ({ part }) => {
                console.log("[EXULU] part", part.type);
                if (part.type === "finish") {
                  return {
                    totalTokens: part.totalUsage.totalTokens,
                    reasoningTokens: part.totalUsage.reasoningTokens,
                    inputTokens: part.totalUsage.inputTokens,
                    outputTokens: part.totalUsage.outputTokens,
                    cachedInputTokens: part.totalUsage.cachedInputTokens,
                  };
                }
                return undefined;
              },
              originalMessages: result.originalMessages,
              sendReasoning: true,
              sendSources: true,
              onError: (error) => {
                console.error("[EXULU] Ui message stream error.", error);
                reject(new Error(error instanceof Error ? error.message : String(error)));
                return `Ui message stream error: ${error instanceof Error ? error.message : String(error)}`;
              },
              onFinish: async ({ messages }) => {
                const metadata = messages[messages.length - 1]?.metadata as any;
                console.log("[EXULU] Stream finished with messages:", messages);
                console.log("[EXULU] Stream metadata", metadata);
                await Promise.all([
                  updateStatistic({
                    name: "count",
                    label: statistics.label,
                    type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                    trigger: statistics.trigger,
                    count: 1,
                    user: user.id,
                    role: user?.role?.id,
                  }),
                  ...(metadata?.inputTokens
                    ? [
                        updateStatistic({
                          name: "inputTokens",
                          label: statistics.label,
                          type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                          trigger: statistics.trigger,
                          count: metadata?.inputTokens,
                          user: user.id,
                          role: user?.role?.id,
                        }),
                      ]
                    : []),
                  ...(metadata?.outputTokens
                    ? [
                        updateStatistic({
                          name: "outputTokens",
                          label: statistics.label,
                          type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                          trigger: statistics.trigger,
                          count: metadata?.outputTokens,
                        }),
                      ]
                    : []),
                ]);
                resolve({
                  messages,
                  metadata: {
                    tokens: {
                      totalTokens:
                        messageHistory.metadata.tokens.totalTokens + metadata?.totalTokens,
                      reasoningTokens:
                        messageHistory.metadata.tokens.reasoningTokens + metadata?.reasoningTokens,
                      inputTokens:
                        messageHistory.metadata.tokens.inputTokens + metadata?.inputTokens,
                      outputTokens:
                        messageHistory.metadata.tokens.outputTokens + metadata?.outputTokens,
                      cachedInputTokens:
                        messageHistory.metadata.tokens.cachedInputTokens +
                        metadata?.cachedInputTokens,
                    },
                    duration: messageHistory.metadata.duration + (Date.now() - startTime),
                  },
                });
              },
            });

            // Consume the stream to ensure it runs to completion & triggers onFinish
            for await (const message of stream) {
              console.log("[EXULU] message", message);
            }
          } catch (error: unknown) {
            console.error(
              `[EXULU] error generating stream for agent ${agent.name} (${agent.id}).`,
              error,
            );
            reject(new Error(error instanceof Error ? error.message : String(error)));
          }
        });
      } catch (error: unknown) {
        // Carry the failing step so the workflow handler's retry loop resumes
        // here instead of re-running (and re-persisting) earlier steps.
        throw new FlowStepError(stepIndex, error);
      }

      if (sessionId) {
        // Step boundary (spec §5.1): persist the accumulated transcript.
        // saveChat merges on message_id, so re-saving prior messages is
        // idempotent (no duplicates on resume or re-save).
        await saveChat({ session: sessionId, user: user.id, messages: messageHistory.messages });
      }

      if (respectToolApprovals && sessionId) {
        const lastMessage = messageHistory.messages[messageHistory.messages.length - 1];
        if (messageHasPendingApproval(lastMessage)) {
          console.log("[EXULU] run paused for tool approval at step", stepIndex);
          return { ...messageHistory, pausedAtStepIndex: stepIndex };
        }
      }
    }
  } finally {
    if (sessionId) clearStreamActive(sessionId);
  }
  console.log(
    "[EXULU] finished processing UI messages flow for agent, messages result",
    messageHistory,
  );
  return messageHistory;
};
```

Note: the old `let index = 0;` declaration (just above `let messageHistory`) is now unused — delete the two lines:

```typescript
  // Iterate through the conversation
  let index = 0;
```

and keep `let messageHistory` as-is.

- [ ] **Step 8: Run the new test — expect PASS**

```bash
npm test -- --testPathPattern="workers.flow"
```

Expected: `Tests: 7 passed`.

- [ ] **Step 9: Type-check + full test suite (guards legacy callers) + commit**

```bash
npm run type-check && npm test
git add ee/workers.ts src/exulu/provider.ts ee/workers.flow.test.ts
git commit -m "feat(routines): session-backed processUiMessagesFlow with pause/resume

sessionId persists each step's messages (fresh per-run message ids,
save-on-step-boundary via saveChat merge), resumeFromIndex skips
completed steps and reloads history, respectToolApprovals drops the
blanket pre-approval and pauses on approval-requested tool parts.
FlowStepError carries the failing step for retry-from-step. Run
sessions load multi-author history (getAgentMessages includeAllUsers).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Worker workflow handler — upsert-vs-insert, session creation, pause CAS, retry-from-step + CAS event handlers

**Files:**
- Modify: `ee/workers.ts` (imports ~line 1-34; workflow branch of the job handler, lines ~473-553; `completed` handler ~991-1016; `failed` handler ~1018-1042)

**Interfaces:**
- Consumes: Task 5 `upsertWorkflowRunStart`/`casJobResultState`/`parseRunMetadata`, Task 4 `createRunSession`, Task 6 `processUiMessagesFlow` options + `FlowStepError` (the run-session/run-state imports are added in Step 1 of this task — Task 6 deliberately adds no unused imports).
- Produces (behavior contract):
  - `data.jobResultId` set → UPDATE the existing `job_results` row (email intake / continuation / retry); otherwise reuse-by-`job_id` or INSERT.
  - Stamps `trigger` (from `data.triggerSource`), `trigger_metadata`, `workflow`, `session`, `type: "workflow"` and metadata bookkeeping `{ run_as, inputs, queue_name, current_step_index }`.
  - No `data.session` → `createRunSession(...)` under the run identity.
  - `pausedAtStepIndex` → persist `metadata.current_step_index` + CAS state → `waiting_approval` synchronously BEFORE the handler returns; pause is success, never retried.
  - Token accumulation (spec §5.7): the pause and completion writes sum the flow's token counts with any pre-pause token counts already on the row's metadata (kept there by `upsertWorkflowRunStart`'s metadata merge), so a paused-and-resumed run reports its full spend.
  - Retry loop passes `resumeFromIndex` of the failed step (`FlowStepError.stepIndex`); final failure persists progress for BullMQ attempt-level resume + `retryRoutineRun`.
  - `completed` handler CAS: `WHERE job_id = ? AND state = 'active'` (can no longer clobber `waiting_approval`/`cancelled`); `failed` handler refuses to overwrite `waiting_approval`/`cancelled`/`completed`.

The handler lives inside the `createWorkers` closure (Redis + BullMQ runtime) — impractical to unit-test directly; its extracted logic is covered by Tasks 5/6 tests, and this task verifies by type-check + full suite. (End-to-end pause/resume is exercised manually in Task 11.)

- [ ] **Step 1: Add the imports, then replace the workflow branch** — in `ee/workers.ts`, first insert the imports these handlers consume (first use is in this task) directly after the line `import { messageHasPendingApproval, substituteVariablesInMessage } from "@SRC/exulu/routines/flow-steps.ts";` added in Task 6:

```typescript
import { createRunSession } from "@SRC/exulu/routines/run-session.ts";
import { casJobResultState, parseRunMetadata, upsertWorkflowRunStart } from "@SRC/exulu/routines/run-state.ts";
```

Then replace the entire current `if (data.type === "workflow") { … }` block (verbatim current code at lines ~473-553, starting `if (data.type === "workflow") {` and ending with the `return { result: messages[messages.length - 1], … };\n            }` shown in the recon) with:

```typescript
            if (data.type === "workflow") {
              console.log("[EXULU] running a workflow job.", bullmqJob.name);

              const label = `workflow-run-${data.workflow}`;

              // Bookkeeping persisted in job_results.metadata so cancel /
              // retry / approval-resume can re-enqueue without the ephemeral
              // Redis payload (spec §5).
              const runBookkeeping = {
                run_as: { user: data.user, role: data.role },
                inputs: (data.inputs ?? {}) as Record<string, unknown>,
                queue_name: bullmqJob.queueName,
              };

              // Row first (before validation) so a payload/agent failure
              // still surfaces as a failed run row — same as today.
              const started = await upsertWorkflowRunStart(db, {
                jobId: bullmqJob.id!,
                jobResultId: data.jobResultId,
                label,
                state: await bullmqJob.getState(),
                workflow: data.workflow!,
                session: data.session ?? null,
                trigger: data.triggerSource ?? null,
                triggerMetadata: data.triggerMetadata ?? null,
                bookkeeping: runBookkeeping,
                resumeFromIndex: data.resumeFromIndex ?? 0,
              });
              const jobResultId = started.jobResultId;
              let resumeFromIndex = started.resumeFromIndex;

              const {
                agent,
                provider,
                user,
                workflow,
                messages: inputMessages,
              } = await validateWorkflowPayload(data, providers);

              // Session-backed runs (spec §3.4): reuse the session provided by
              // the enqueuer (email intake / continuation / retry / previous
              // BullMQ attempt), otherwise create one with the routine's rbac
              // snapshot under the run identity.
              let sessionId = started.session ?? undefined;
              if (!sessionId) {
                sessionId = await createRunSession({
                  db,
                  workflow: {
                    id: workflow.id,
                    name: workflow.name,
                    agent: workflow.agent,
                    rights_mode: workflow.rights_mode,
                  },
                  userId: user.id,
                  title: `${workflow.name} — ${new Date().toISOString()}`,
                  trigger: data.triggerSource ?? "api",
                  jobResultId,
                });
                await db.from("job_results").where({ id: jobResultId }).update({ session: sessionId });
              }

              const retries = 3;
              let attempts = 0;

              const promise = new Promise<{
                messages: UIMessage[];
                metadata: {
                  tokens: {
                    totalTokens: number;
                    reasoningTokens: number;
                    inputTokens: number;
                    outputTokens: number;
                    cachedInputTokens: number;
                  };
                  duration: number;
                };
                pausedAtStepIndex?: number;
              }>(async (resolve, reject) => {
                while (attempts < retries) {
                  try {
                    const messages = await processUiMessagesFlow({
                      providers,
                      agent,
                      provider,
                      inputMessages,
                      contexts,
                      user,
                      tools,
                      config,
                      variables: data.inputs,
                      // Tag LLM spend to this routine (cron + ad-hoc share this path).
                      routine: { id: workflow.id, name: workflow.name },
                      sessionId,
                      resumeFromIndex,
                      // Approval-gated tools pause unless the routine opted
                      // back into blanket pre-approval (spec §5.2).
                      respectToolApprovals: workflow.auto_approve_tools !== true,
                    });
                    resolve(messages);
                    break;
                  } catch (error: unknown) {
                    console.error(
                      `[EXULU] error processing UI messages flow for agent ${agent.name} (${agent.id}).`,
                      error instanceof Error ? error.message : String(error),
                    );
                    if (error instanceof FlowStepError) {
                      // Completed steps already persisted their messages —
                      // resume at the failed step (spec §5.4).
                      resumeFromIndex = error.stepIndex;
                    }
                    attempts++;
                    if (attempts >= retries) {
                      // Persist progress so BullMQ attempt-level retries and
                      // retryRoutineRun resume from the failed step.
                      try {
                        await db
                          .from("job_results")
                          .where({ id: jobResultId })
                          .update({
                            metadata: JSON.stringify({
                              ...runBookkeeping,
                              current_step_index: resumeFromIndex,
                            }),
                          });
                      } catch (persistError) {
                        console.error(
                          `[EXULU] failed to persist run progress for job ${bullmqJob.id}.`,
                          persistError,
                        );
                      }
                      reject(new Error(error instanceof Error ? error.message : String(error)));
                    }
                    await new Promise((resolve) => setTimeout(() => resolve(true), 2000));
                  }
                }
              });

              const result = await promise;
              const messages = result.messages;
              const metadata = result.metadata;

              // Token accumulation across pause/resume (spec §5.7): a resumed
              // continuation only counted its own steps — sum with any
              // pre-pause token counts persisted on the row (kept there by
              // upsertWorkflowRunStart's metadata merge). Fresh runs have no
              // prior tokens and pass through unchanged.
              const rowBeforeWrite = await db
                .from("job_results")
                .where({ id: jobResultId })
                .first();
              const priorTokens = parseRunMetadata(rowBeforeWrite?.metadata).tokens as
                | Record<string, number>
                | undefined;
              const tokens = {
                totalTokens: (priorTokens?.totalTokens ?? 0) + metadata.tokens.totalTokens,
                reasoningTokens:
                  (priorTokens?.reasoningTokens ?? 0) + metadata.tokens.reasoningTokens,
                inputTokens: (priorTokens?.inputTokens ?? 0) + metadata.tokens.inputTokens,
                outputTokens: (priorTokens?.outputTokens ?? 0) + metadata.tokens.outputTokens,
                cachedInputTokens:
                  (priorTokens?.cachedInputTokens ?? 0) + metadata.tokens.cachedInputTokens,
              };

              if (result.pausedAtStepIndex !== undefined) {
                // Pause is success (spec §5.3): persist progress and flip to
                // waiting_approval synchronously BEFORE returning — the
                // completed-handler CAS (state = active) can then never
                // clobber it. CAS keeps an admin cancel-during-pause intact.
                await db
                  .from("job_results")
                  .where({ id: jobResultId })
                  .update({
                    result:
                      messages.length > 0 ? JSON.stringify(messages[messages.length - 1]) : null,
                    metadata: JSON.stringify({
                      messages,
                      ...metadata,
                      tokens,
                      ...runBookkeeping,
                      current_step_index: result.pausedAtStepIndex,
                    }),
                  });
                await casJobResultState(
                  db,
                  jobResultId,
                  [JOB_STATUS_ENUM.active, JOB_STATUS_ENUM.waiting],
                  JOB_STATUS_ENUM.waiting_approval,
                );
                return {
                  result: messages[messages.length - 1],
                  metadata: {
                    messages,
                    ...metadata,
                    tokens,
                    ...runBookkeeping,
                    current_step_index: result.pausedAtStepIndex,
                  },
                };
              }

              return {
                result: messages[messages.length - 1], // last message
                metadata: {
                  messages,
                  ...metadata,
                  tokens,
                  ...runBookkeeping,
                  current_step_index: inputMessages.length - 1,
                },
              };
            }
```

Note on the retry backoff sleep: the replacement deliberately writes `setTimeout(() => resolve(true), 2000)` — the current code's `setTimeout((resolve) => resolve(true), 2000)` is a pre-existing shadowed-callback bug (the setTimeout parameter shadows the promise's `resolve`, which setTimeout invokes with `undefined`), fixed here while re-specifying the block.

- [ ] **Step 2: CAS the `completed` handler** — in `ee/workers.ts` (~line 1006), replace:

```typescript
        await db
          .from("job_results")
          .where({ job_id: job.id })
          .update({
            state: JOB_STATUS_ENUM.completed,
            result: returnvalue.result != null ? JSON.stringify(returnvalue.result) : null,
            metadata: returnvalue.metadata != null ? JSON.stringify(returnvalue.metadata) : null,
          });
```

with:

```typescript
        // CAS (spec §5.3): a paused run returns from the handler with state
        // already flipped to waiting_approval, and cancel may have won a race
        // — only an active row may be completed.
        await db
          .from("job_results")
          .where({ job_id: job.id, state: JOB_STATUS_ENUM.active })
          .update({
            state: JOB_STATUS_ENUM.completed,
            result: returnvalue.result != null ? JSON.stringify(returnvalue.result) : null,
            metadata: returnvalue.metadata != null ? JSON.stringify(returnvalue.metadata) : null,
          });
```

- [ ] **Step 3: Guard the `failed` handler** — in `ee/workers.ts` (~line 1024), replace:

```typescript
        await db.from("job_results").where({ job_id: job.id }).update({
          state: JOB_STATUS_ENUM.failed,
          error,
        });
```

with:

```typescript
        // CAS: never clobber a pause (success), an admin cancel, or a
        // completed row — e.g. a BullMQ lock-expiry "failure" arriving after
        // the run already paused for approval.
        await db
          .from("job_results")
          .where({ job_id: job.id })
          .whereNotIn("state", [
            JOB_STATUS_ENUM.waiting_approval,
            JOB_STATUS_ENUM.cancelled,
            JOB_STATUS_ENUM.completed,
          ])
          .update({
            state: JOB_STATUS_ENUM.failed,
            error,
          });
```

- [ ] **Step 4: Verify — type-check + full suite**

```bash
npm run type-check && npm test
```

Expected: clean type-check; all suites pass (the flow tests from Task 6 and run-state tests from Task 5 cover the extracted logic this handler composes).

- [ ] **Step 5: Commit** — this is the commit that ships the behavior change, so it carries the `BREAKING CHANGE:` footer (spec §9 — semantic-release turns conventional-commit footers into release notes):

```bash
git add ee/workers.ts
git commit -m "feat(routines): session-backed worker handler with pause CAS and retry-from-step

Workflow jobs upsert their job_results row (jobResultId update-vs-insert,
attempt-level reuse by job_id), stamp trigger/workflow/session/type and
run bookkeeping, create the run session when absent, pause via CAS to
waiting_approval before returning, and resume retries at the failed step.
completed/failed BullMQ handlers become conditional updates.

BREAKING CHANGE: routine runs now pause on approval-gated tools; set auto_approve_tools=true per routine to restore silent auto-approval

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Trigger stamping — `runWorkflow` ("manual"/"api") + `upsertWorkflowSchedule` ("schedule") + session-backed inline path

**Files:**
- Modify: `src/graphql/schemas/index.ts` (`upsertWorkflowSchedule` jobData ~line 1002; `runWorkflow` jobData ~line 1097 + inline no-queue branch ~lines 1130-1243)

**Interfaces:**
- Consumes: `BullMqJobData.triggerSource/triggerMetadata` (Task 2), `createRunSession` (Task 4).
- Produces: queued manual runs stamped `triggerSource: "manual"` (API-key callers: `"api"` per spec §3.3 — `user.type === "api"` distinguishes them; both values are inside the contract union); scheduled runs stamped `"schedule"` with `triggerMetadata: { cron }`; the inline no-queue path becomes session-backed but keeps blanket approvals (no worker exists to resume a pause in queue-less deployments).

GraphQL resolvers are string-built closures — verification is type-check + print-sdl (unchanged SDL) + full suite.

- [ ] **Step 1: Stamp scheduled runs** — in `src/graphql/schemas/index.ts`, inside `upsertWorkflowSchedule` (the jobData block FOLLOWED by `if (!queue) {` — this disambiguates it from runWorkflow's identical block), replace:

```typescript
    const jobData: BullMqJobData = {
      label: `Workflow Run ${workflow_template_id}`,
      trigger: "api",
      timeoutInSeconds: queue?.timeoutInSeconds || 180, // default to 3 minutes
      type: "workflow",
      workflow: workflow_template_id,
      inputs: args.variables,
      user: user.id,
      role: user.role?.id,
    };

    if (!queue) {
```

with:

```typescript
    const jobData: BullMqJobData = {
      label: `Workflow Run ${workflow_template_id}`,
      trigger: "api",
      timeoutInSeconds: queue?.timeoutInSeconds || 180, // default to 3 minutes
      type: "workflow",
      workflow: workflow_template_id,
      inputs: args.variables,
      user: user.id,
      role: user.role?.id,
      // Runs-view provenance (spec §3.3): fixes the bug where scheduled runs
      // were displayed as "api".
      triggerSource: "schedule",
      triggerMetadata: { cron: args.schedule },
    };

    if (!queue) {
```

- [ ] **Step 2: Stamp manual runs** — in `src/graphql/schemas/index.ts`, inside `runWorkflow` (the jobData block FOLLOWED by `if (queue) {`), replace:

```typescript
    const jobData: BullMqJobData = {
      label: `Workflow Run ${workflow_template_id}`,
      trigger: "api",
      timeoutInSeconds: queue?.timeoutInSeconds || 180, // default to 3 minutes
      type: "workflow",
      workflow: workflow_template_id,
      inputs: args.variables,
      user: user.id,
      role: user.role?.id,
    };

    if (queue) {
```

with:

```typescript
    const jobData: BullMqJobData = {
      label: `Workflow Run ${workflow_template_id}`,
      trigger: "api",
      timeoutInSeconds: queue?.timeoutInSeconds || 180, // default to 3 minutes
      type: "workflow",
      workflow: workflow_template_id,
      inputs: args.variables,
      user: user.id,
      role: user.role?.id,
      // Runs-view provenance (spec §3.3): UI-initiated runs are "manual",
      // API-key callers are "api".
      triggerSource: user.type === "api" ? "api" : "manual",
    };

    if (queue) {
```

- [ ] **Step 3: Session-back the inline (no-queue) path** — still in `runWorkflow`, replace:

```typescript
      const jobResult = await db
        .from("job_results")
        .insert({
          job_id: undefined,
          label: label,
          state: "active",
          result: null,
          metadata: {},
          tries: 1,
        })
        .returning("id");

      const jobResultId = jobResult[0].id;

      try {
        const {
          agent,
          provider,
          user,
          workflow,
          messages: inputMessages,
        } = await validateWorkflowPayload(jobData, providers);
```

with:

```typescript
      const jobResult = await db
        .from("job_results")
        .insert({
          job_id: undefined,
          label: label,
          state: "active",
          result: null,
          metadata: {},
          tries: 1,
          type: "workflow",
          workflow: workflow_template_id,
          trigger: jobData.triggerSource ?? null,
        })
        .returning("id");

      const jobResultId = jobResult[0].id;

      try {
        const {
          agent,
          provider,
          user,
          workflow,
          messages: inputMessages,
        } = await validateWorkflowPayload(jobData, providers);

        // Session-backed (spec §3.4) — but keep the legacy blanket approval:
        // without a queue there is no worker to resume a paused run.
        const sessionId = await createRunSession({
          db,
          workflow: {
            id: workflow.id,
            name: workflow.name,
            agent: workflow.agent,
            rights_mode: workflow.rights_mode,
          },
          userId: user.id,
          title: `${workflow.name} — ${new Date().toISOString()}`,
          trigger: jobData.triggerSource ?? "manual",
          jobResultId,
        });
        await db.from("job_results").where({ id: jobResultId }).update({ session: sessionId });
```

then, a few lines below, pass the session into the flow — replace:

```typescript
              const messages = await processUiMessagesFlow({
                providers,
                agent,
                provider,
                inputMessages,
                contexts,
                user,
                tools,
                config,
                variables: args.variables,
                // Tag LLM spend to this routine (direct one-shot path mirrors the queued path).
                routine: { id: workflow.id, name: workflow.name },
              });
```

with:

```typescript
              const messages = await processUiMessagesFlow({
                providers,
                agent,
                provider,
                inputMessages,
                contexts,
                user,
                tools,
                config,
                variables: args.variables,
                // Tag LLM spend to this routine (direct one-shot path mirrors the queued path).
                routine: { id: workflow.id, name: workflow.name },
                sessionId,
              });
```

- [ ] **Step 4: Add the import** — in `src/graphql/schemas/index.ts`, replace:

```typescript
import { processUiMessagesFlow, validateWorkflowPayload } from "@EE/workers.ts";
```

with:

```typescript
import { processUiMessagesFlow, validateWorkflowPayload } from "@EE/workers.ts";
import { createRunSession } from "@SRC/exulu/routines/run-session.ts";
```

- [ ] **Step 5: Verify + commit**

```bash
npm run type-check && npx tsx scripts/print-sdl.ts /tmp/sdl-check.graphql && npm test
git add src/graphql/schemas/index.ts
git commit -m "feat(routines): stamp trigger source on manual/api/scheduled runs

runWorkflow stamps manual (api for API-key callers), upsertWorkflowSchedule
stamps schedule + cron metadata; the inline no-queue path becomes
session-backed (blanket approvals kept — no worker to resume a pause).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Agent-run route resume hook (`onFinish` → `resumeRoutineRunIfWaiting`)

**Files:**
- Modify: `src/exulu/routes.ts` (`onFinish` of the agent-run stream, ~lines 908-923)

**Interfaces:**
- Consumes: `resumeRoutineRunIfWaiting(db, sessionId)` (Task 5); `db` is already in the route handler's scope.
- Produces: after an admin's chat turn on a run session persists (`saveChat`), a `waiting_approval` run CAS-resumes and enqueues its continuation. Errors are logged, never break the chat response.

Express closure — verification via type-check + suite (the resume logic itself is unit-tested in Task 5).

- [ ] **Step 1: Add the import** — in `src/exulu/routes.ts`, locate the existing import block (the file imports from `@SRC/exulu/active-streams` already — add directly after that import line):

```typescript
import { resumeRoutineRunIfWaiting } from "@SRC/exulu/routines/run-state";
```

- [ ] **Step 2: Hook `onFinish`** — in the agent-run route's `pipeUIMessageStreamToResponse onFinish` (NOT the worker's), replace:

```typescript
            if (headers.session && user?.id) {
              await saveChat({
                session: headers.session as string,
                user: user.id,
                messages: messages,
                model: resolvedModelId,
              });
              clearSessionCurrentTask(headers.session as string).catch(() => { });
            }
```

with:

```typescript
            if (headers.session && user?.id) {
              await saveChat({
                session: headers.session as string,
                user: user.id,
                messages: messages,
                model: resolvedModelId,
              });
              clearSessionCurrentTask(headers.session as string).catch(() => { });
              // Routine-run sessions (spec §5.5): an answered approval card
              // resumes the paused run — CAS winner enqueues the continuation.
              // Messages are saved first so the continuation reload sees the
              // resolved approval. Never let this break the chat response.
              try {
                const resumed = await resumeRoutineRunIfWaiting(db, headers.session as string);
                if (resumed) {
                  console.log("[EXULU] resumed routine run for session " + headers.session);
                }
              } catch (resumeError) {
                console.error(
                  "[EXULU] failed to resume routine run for session " + headers.session,
                  resumeError,
                );
              }
            }
```

- [ ] **Step 3: Verify + commit**

```bash
npm run type-check && npm run lint:errors
git add src/exulu/routes.ts
git commit -m "feat(routines): auto-resume paused runs after a chat approval turn

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: GraphQL runs API — `routineRuns`, needs-attention count, cancel, retry (+ session-delete cleanup)

**Files:**
- Create: `src/exulu/routines/runs-query.ts`
- Create: `src/exulu/routines/runs-query.test.ts`
- Modify: `src/graphql/schemas/index.ts` (typeDefs after `workflowSchedule` ~line 590; mutationDefs after `deleteWorkflowSchedule` ~line 634; modelDefs near `LiteLLMModel`; `JobStateEnum` interpolation ~line 2344; resolvers after the `runWorkflow` resolver closes ~line 1244; imports)
- Modify: `src/graphql/mutations/index.ts` (`postprocessDeletion` `agent_sessions` branch, ~line 78-89; imports)

**Interfaces:**
- Produces (CONTRACT-FIXED SDL — Plan 3 consumes verbatim):

```graphql
type RoutineRun { id: ID!  job_id: String  state: String!  trigger: String  trigger_metadata: JSON  session: String  workflow: String!  workflowName: String  agent: String  error: JSON  tries: Float  createdAt: Date  updatedAt: Date }
type RoutineRunPage { items: [RoutineRun!]!  total: Float! }
routineRuns(page: Int, limit: Int, workflow: ID, states: [String!], triggers: [String!], from: Date, to: Date, search: String, needsAttention: Boolean): RoutineRunPage
routineRunsNeedingAttentionCount: Float!
cancelRoutineRun(id: ID!): RoutineRun
retryRoutineRun(id: ID!): RoutineRun
```

- Semantics: `type='workflow'` rows only; workflow ids restricted to routines the caller can read via `applyAccessControl` on `workflow_templates` (which also enforces the `workflows` role); `search` = leftJoin `agent_sessions` on `job_results.session`, ILIKE on `title`; `needsAttention` ≡ `state='waiting_approval'`; `agent` = `workflow_templates.agent` (id — Plan 3 resolves slug-vs-id per the chat route's needs); cancel = shared `cancelRoutineRunRow` helper (CAS `waiting|active|waiting_approval → cancelled` + best-effort BullMQ job removal + `clearStreamActive`) — the SAME helper session deletion calls, so both paths behave identically (spec §5.6); retry = `failed|cancelled` only, re-enqueue with `resumeFromIndex = metadata.current_step_index ?? 0`, SAME `jobResultId`, new BullMQ job id.
- Also produces (internal, tested): `applyRoutineRunFilters(query, args, allowedWorkflowIds)` and `mapRoutineRunRow(row, routineById)` in `runs-query.ts`; `JobStateEnum` gains the three new states (spec §3.3 — jobs-dashboard filters must accept them).
- Consumes: `applyAccessControl` (already imported in schemas/index.ts), `checkRecordAccess` (already imported), `workflowTemplatesSchema` (`@EE/schemas`), Task 5 helpers (incl. `cancelRoutineRunRow`), `ExuluQueues` (already imported as `ExuluQueues`), `uuidv4` + `JOB_STATUS_ENUM` (already imported).

- [ ] **Step 1: Write the failing helper test** — create `src/exulu/routines/runs-query.test.ts`:

```typescript
import { JOB_STATUS_ENUM } from "@EXULU_TYPES/enums/jobs";
import { applyRoutineRunFilters, mapRoutineRunRow } from "./runs-query";

const makeRecorder = () => {
  const calls: { name: string; args: any[] }[] = [];
  const record = (name: string) =>
    (...args: any[]) => {
      calls.push({ name, args });
      return builder;
    };
  const builder: any = {
    where: record("where"),
    whereIn: record("whereIn"),
    leftJoin: record("leftJoin"),
  };
  return { builder, calls };
};

describe("applyRoutineRunFilters", () => {
  it("always scopes to workflow-type rows within the allowed routine ids", () => {
    const { builder, calls } = makeRecorder();
    applyRoutineRunFilters(builder, {}, ["wf-1", "wf-2"]);
    expect(calls[0]).toEqual({ name: "where", args: ["job_results.type", "workflow"] });
    expect(calls[1]).toEqual({ name: "whereIn", args: ["job_results.workflow", ["wf-1", "wf-2"]] });
  });

  it("applies states, triggers, needsAttention, and date filters", () => {
    const { builder, calls } = makeRecorder();
    const from = new Date("2026-07-01T00:00:00Z");
    const to = new Date("2026-07-15T00:00:00Z");
    applyRoutineRunFilters(
      builder,
      { states: ["failed"], triggers: ["email"], needsAttention: true, from, to },
      ["wf-1"],
    );
    expect(calls).toContainEqual({ name: "whereIn", args: ["job_results.state", ["failed"]] });
    expect(calls).toContainEqual({ name: "whereIn", args: ["job_results.trigger", ["email"]] });
    expect(calls).toContainEqual({
      name: "where",
      args: ["job_results.state", JOB_STATUS_ENUM.waiting_approval],
    });
    expect(calls).toContainEqual({ name: "where", args: ["job_results.createdAt", ">=", from] });
    expect(calls).toContainEqual({ name: "where", args: ["job_results.createdAt", "<=", to] });
  });

  it("search joins agent_sessions and ILIKEs the title", () => {
    const { builder, calls } = makeRecorder();
    applyRoutineRunFilters(builder, { search: "spare" }, ["wf-1"]);
    expect(calls).toContainEqual({
      name: "leftJoin",
      args: ["agent_sessions", "job_results.session", "agent_sessions.id"],
    });
    expect(calls).toContainEqual({
      name: "where",
      args: ["agent_sessions.title", "ilike", "%spare%"],
    });
  });

  it("skips optional filters when absent", () => {
    const { builder, calls } = makeRecorder();
    applyRoutineRunFilters(builder, { states: [], triggers: [] }, ["wf-1"]);
    expect(calls).toHaveLength(2); // type + workflow scope only
  });
});

describe("mapRoutineRunRow", () => {
  const routineById = new Map([["wf-1", { id: "wf-1", name: "Spare parts", agent: "agent-9" }]]);

  it("maps columns, parses json strings, and joins routine name + agent", () => {
    const run = mapRoutineRunRow(
      {
        id: "jr-1",
        job_id: "bull-1",
        state: "waiting_approval",
        trigger: "email",
        trigger_metadata: JSON.stringify({ from: "a@b.com", subject: "Hi" }),
        session: "sess-1",
        workflow: "wf-1",
        error: null,
        tries: 2,
        createdAt: "2026-07-15T09:00:00Z",
        updatedAt: "2026-07-15T09:05:00Z",
      },
      routineById,
    );
    expect(run).toMatchObject({
      id: "jr-1",
      job_id: "bull-1",
      state: "waiting_approval",
      trigger: "email",
      session: "sess-1",
      workflow: "wf-1",
      workflowName: "Spare parts",
      agent: "agent-9",
      tries: 2,
    });
    expect(run.trigger_metadata).toEqual({ from: "a@b.com", subject: "Hi" });
  });

  it("handles jsonb objects, unknown routines, and pre-migration null trigger", () => {
    const run = mapRoutineRunRow(
      {
        id: "jr-2",
        job_id: null,
        state: "completed",
        trigger: null,
        trigger_metadata: { cron: "0 3 * * *" },
        session: null,
        workflow: "wf-gone",
        error: { message: "boom" },
        tries: 1,
        createdAt: "2026-07-14T09:00:00Z",
        updatedAt: "2026-07-14T09:00:00Z",
      },
      routineById,
    );
    expect(run.workflowName).toBeNull();
    expect(run.agent).toBeNull();
    expect(run.trigger).toBeNull();
    expect(run.trigger_metadata).toEqual({ cron: "0 3 * * *" });
    expect(run.error).toEqual({ message: "boom" });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

```bash
npm test -- --testPathPattern="runs-query"
```

Expected: `Cannot find module './runs-query'`.

- [ ] **Step 3: Implement the helpers** — create `src/exulu/routines/runs-query.ts`:

```typescript
/**
 * Query building + row mapping for the routineRuns GraphQL API (spec §6).
 * job_results has no RBAC of its own — the resolvers restrict `workflow` to
 * the access-filtered routine-id set and these helpers do the rest with one
 * indexed query (composite index (workflow, state, trigger, createdAt)).
 */
import { JOB_STATUS_ENUM } from "@EXULU_TYPES/enums/jobs";
import { parseRunMetadata } from "./run-state";

export type RoutineRunsFilterArgs = {
  workflow?: string;
  states?: string[];
  triggers?: string[];
  from?: Date | string;
  to?: Date | string;
  search?: string;
  needsAttention?: boolean;
};

export const applyRoutineRunFilters = (
  query: any,
  args: RoutineRunsFilterArgs,
  allowedWorkflowIds: string[],
): any => {
  let q = query
    .where("job_results.type", "workflow")
    .whereIn("job_results.workflow", allowedWorkflowIds);
  if (args.states?.length) {
    q = q.whereIn("job_results.state", args.states);
  }
  if (args.triggers?.length) {
    q = q.whereIn("job_results.trigger", args.triggers);
  }
  if (args.needsAttention) {
    q = q.where("job_results.state", JOB_STATUS_ENUM.waiting_approval);
  }
  if (args.from) {
    q = q.where("job_results.createdAt", ">=", args.from);
  }
  if (args.to) {
    q = q.where("job_results.createdAt", "<=", args.to);
  }
  if (args.search) {
    // session ⇄ run is 1:1 — the join cannot fan out rows.
    q = q
      .leftJoin("agent_sessions", "job_results.session", "agent_sessions.id")
      .where("agent_sessions.title", "ilike", `%${args.search}%`);
  }
  return q;
};

/** json columns arrive as objects (pg jsonb) or strings — normalize either. */
const parseMaybeJson = (value: unknown): any => {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

export const mapRoutineRunRow = (
  row: any,
  routineById: Map<string, { id: string; name?: string; agent?: string }>,
): {
  id: string;
  job_id: string | null;
  state: string;
  trigger: string | null;
  trigger_metadata: any;
  session: string | null;
  workflow: string;
  workflowName: string | null;
  agent: string | null;
  error: any;
  tries: number | null;
  createdAt: unknown;
  updatedAt: unknown;
} => {
  const routine = row.workflow ? routineById.get(row.workflow) : undefined;
  return {
    id: row.id,
    job_id: row.job_id ?? null,
    state: row.state,
    trigger: row.trigger ?? null,
    trigger_metadata: parseMaybeJson(row.trigger_metadata),
    session: row.session ?? null,
    workflow: row.workflow,
    workflowName: routine?.name ?? null,
    agent: routine?.agent ?? null,
    error: parseMaybeJson(row.error),
    tries: row.tries ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

export { parseRunMetadata };
```

- [ ] **Step 4: Run it — expect PASS**

```bash
npm test -- --testPathPattern="runs-query"
```

Expected: `Tests: 6 passed`.

- [ ] **Step 5: Register the SDL** — in `src/graphql/schemas/index.ts`:

Edit 1 — after the `workflowSchedule` typeDef, replace:

```typescript
  typeDefs += `
    workflowSchedule(workflow: ID!): WorkflowScheduleResult
    `;
```

with:

```typescript
  typeDefs += `
    workflowSchedule(workflow: ID!): WorkflowScheduleResult
    `;

  // Routine runs (spec §6) — powers the per-routine Runs section and /runs.
  typeDefs += `
    routineRuns(page: Int, limit: Int, workflow: ID, states: [String!], triggers: [String!], from: Date, to: Date, search: String, needsAttention: Boolean): RoutineRunPage
    routineRunsNeedingAttentionCount: Float!
    `;
```

Edit 2 — after the `deleteWorkflowSchedule` mutationDef, replace:

```typescript
  mutationDefs += `
    deleteWorkflowSchedule(workflow: ID!): WorkflowScheduleReturnPayload
    `;
```

with:

```typescript
  mutationDefs += `
    deleteWorkflowSchedule(workflow: ID!): WorkflowScheduleReturnPayload
    `;

  mutationDefs += `
    cancelRoutineRun(id: ID!): RoutineRun
    retryRoutineRun(id: ID!): RoutineRun
    `;
```

Edit 3 — the output types: directly before the line `  modelDefs += `\ntype LiteLLMModel {`, insert:

```typescript
  modelDefs += `
type RoutineRun {
  id: ID!
  job_id: String
  state: String!
  trigger: String
  trigger_metadata: JSON
  session: String
  workflow: String!
  workflowName: String
  agent: String
  error: JSON
  tries: Float
  createdAt: Date
  updatedAt: Date
}

type RoutineRunPage {
  items: [RoutineRun!]!
  total: Float!
}
`;
```

Edit 4 — imports: replace

```typescript
import { createRunSession } from "@SRC/exulu/routines/run-session.ts";
```

(added in Task 8) with:

```typescript
import { createRunSession } from "@SRC/exulu/routines/run-session.ts";
import { cancelRoutineRunRow, casJobResultState, parseRunMetadata } from "@SRC/exulu/routines/run-state.ts";
import { applyRoutineRunFilters, mapRoutineRunRow } from "@SRC/exulu/routines/runs-query.ts";
import { workflowTemplatesSchema } from "@EE/schemas";
```

(No `clearStreamActive` import here — the shared `cancelRoutineRunRow` helper handles the stream-active cleanup itself.)

Edit 5 — the `JobStateEnum` interpolation (~line 2344): the jobs-dashboard enum currently emits only the seven legacy states, so GraphQL callers filtering `jobs(statusses: …)` by a new state would get an unknown-enum-value error. Replace:

```typescript
enum JobStateEnum {
  ${JOB_STATUS_ENUM.active}
  ${JOB_STATUS_ENUM.waiting}
  ${JOB_STATUS_ENUM.delayed}
  ${JOB_STATUS_ENUM.failed}
  ${JOB_STATUS_ENUM.completed}
  ${JOB_STATUS_ENUM.paused}
  ${JOB_STATUS_ENUM.stuck}
}
```

with:

```typescript
enum JobStateEnum {
  ${JOB_STATUS_ENUM.active}
  ${JOB_STATUS_ENUM.waiting}
  ${JOB_STATUS_ENUM.delayed}
  ${JOB_STATUS_ENUM.failed}
  ${JOB_STATUS_ENUM.completed}
  ${JOB_STATUS_ENUM.paused}
  ${JOB_STATUS_ENUM.stuck}
  ${JOB_STATUS_ENUM.waiting_approval}
  ${JOB_STATUS_ENUM.filtered}
  ${JOB_STATUS_ENUM.cancelled}
}
```

(`JOB_STATUS_ENUM` is already imported at the top of the file, and the keys were added in Task 1 — the interpolation stays key-driven so enum and type can never drift.)

- [ ] **Step 6: Add the resolvers** — in `src/graphql/schemas/index.ts`, directly AFTER the `runWorkflow` resolver's closing (`    }\n  };` followed by `  resolvers.Mutation["runEval"] = async (_, args, context, info) => {`), insert before the `runEval` line:

```typescript
  // ---- Routine runs API (spec §6) -------------------------------------
  // job_results has no RBAC — access derives from the parent routine:
  // applyAccessControl on workflow_templates also enforces the `workflows`
  // role, then a single indexed query fetches the rows (no per-row N+1).
  const readableRoutines = async (
    db: any,
    user: any,
  ): Promise<Map<string, { id: string; name: string; agent: string }>> => {
    const rows: { id: string; name: string; agent: string }[] = await applyAccessControl(
      workflowTemplatesSchema,
      db("workflow_templates").select("id", "name", "agent"),
      user,
    );
    return new Map(rows.map((row) => [row.id, row]));
  };

  const loadRoutineRunForWrite = async (db: any, user: any, id: string) => {
    const row = await db.from("job_results").where({ id }).first();
    if (!row || row.type !== "workflow" || !row.workflow) {
      throw new Error("Routine run not found.");
    }
    const routine = await db.from("workflow_templates").where({ id: row.workflow }).first();
    if (!routine) {
      throw new Error("Routine not found for this run.");
    }
    const hasAccess = await checkRecordAccess(routine, "write", user);
    if (!hasAccess) {
      throw new Error("You don't have access to this routine.");
    }
    return { row, routine };
  };

  resolvers.Query["routineRuns"] = async (_, args, context) => {
    const user = context.user;
    const { db } = await postgresClient();

    const routineById = await readableRoutines(db, user);
    let allowedIds = [...routineById.keys()];
    if (args.workflow) {
      allowedIds = allowedIds.filter((id) => id === args.workflow);
    }
    if (allowedIds.length === 0) {
      return { items: [], total: 0 };
    }

    const page = Math.max(1, args.page ?? 1);
    const limit = Math.min(100, Math.max(1, args.limit ?? 20));

    const countRows = await applyRoutineRunFilters(db("job_results"), args, allowedIds).count(
      "* as count",
    );
    const total = Number(countRows[0]?.count ?? 0);

    const rows = await applyRoutineRunFilters(db("job_results"), args, allowedIds)
      .select("job_results.*")
      .orderBy("job_results.createdAt", "desc")
      .offset((page - 1) * limit)
      .limit(limit);

    return {
      items: rows.map((row: any) => mapRoutineRunRow(row, routineById)),
      total,
    };
  };

  resolvers.Query["routineRunsNeedingAttentionCount"] = async (_, args, context) => {
    const user = context.user;
    const { db } = await postgresClient();
    const routineById = await readableRoutines(db, user);
    if (routineById.size === 0) {
      return 0;
    }
    const rows = await db("job_results")
      .where({ type: "workflow", state: JOB_STATUS_ENUM.waiting_approval })
      .whereIn("workflow", [...routineById.keys()])
      .count("* as count");
    return Number(rows[0]?.count ?? 0);
  };

  resolvers.Mutation["cancelRoutineRun"] = async (_, args, context) => {
    const user = context.user;
    const { db } = await postgresClient();
    const { row, routine } = await loadRoutineRunForWrite(db, user, args.id);

    const cancellable: string[] = [
      JOB_STATUS_ENUM.waiting,
      JOB_STATUS_ENUM.active,
      JOB_STATUS_ENUM.waiting_approval,
    ];
    if (!cancellable.includes(row.state)) {
      throw new Error(`Run is in state '${row.state}' and cannot be cancelled.`);
    }

    // Shared cancel path (spec §5.6): CAS to cancelled + best-effort BullMQ
    // job removal + stream-active cleanup — the SAME helper session deletion
    // (postprocessDeletion) uses. A lost CAS race after the check above is a
    // silent no-op (the run reached a terminal state concurrently).
    await cancelRoutineRunRow(db, row, ExuluQueues);

    const updated = await db.from("job_results").where({ id: row.id }).first();
    return mapRoutineRunRow(updated, new Map([[routine.id, routine]]));
  };

  resolvers.Mutation["retryRoutineRun"] = async (_, args, context) => {
    const user = context.user;
    const { db } = await postgresClient();
    const { row, routine } = await loadRoutineRunForWrite(db, user, args.id);

    if (row.state !== JOB_STATUS_ENUM.failed && row.state !== JOB_STATUS_ENUM.cancelled) {
      throw new Error(`Only failed or cancelled runs can be retried (state: '${row.state}').`);
    }

    const runMetadata = parseRunMetadata(row.metadata);
    const queueName =
      typeof runMetadata.queue_name === "string" ? runMetadata.queue_name : undefined;
    const entry = queueName ? ExuluQueues.list.get(queueName) : undefined;
    if (!entry) {
      // Pre-migration rows have no bookkeeping — an honest error beats a guess.
      throw new Error("No queue recorded for this run; it cannot be retried.");
    }
    const queueConfig = await entry.use();

    const moved = await casJobResultState(
      db,
      row.id,
      [JOB_STATUS_ENUM.failed, JOB_STATUS_ENUM.cancelled],
      JOB_STATUS_ENUM.waiting,
    );
    if (!moved) {
      throw new Error("Run state changed concurrently; retry aborted.");
    }
    await db.from("job_results").where({ id: row.id }).update({ error: null });

    const runAs = (runMetadata.run_as ?? {}) as { user?: number; role?: string };
    const jobData: BullMqJobData = {
      label: `Workflow Run ${row.workflow}`,
      trigger: "api",
      timeoutInSeconds: queueConfig.timeoutInSeconds || 180,
      type: "workflow",
      workflow: row.workflow,
      inputs: (runMetadata.inputs as Record<string, unknown>) ?? {},
      user: runAs.user ?? user.id,
      role: runAs.role ?? user.role?.id,
      session: row.session ?? undefined,
      jobResultId: row.id,
      // Resume from the failed step (spec §6) — 0 for runs that never started.
      resumeFromIndex:
        typeof runMetadata.current_step_index === "number" ? runMetadata.current_step_index : 0,
      triggerSource: (row.trigger as BullMqJobData["triggerSource"]) ?? undefined,
      triggerMetadata: row.trigger_metadata ? parseRunMetadata(row.trigger_metadata) : undefined,
    };
    await queueConfig.queue.add("workflow_run", jobData, {
      jobId: uuidv4(),
      attempts: queueConfig.retries || 3,
      removeOnComplete: 5000,
      removeOnFail: 10000,
      backoff: queueConfig.backoff || { type: "exponential", delay: 2000 },
    });

    const updated = await db.from("job_results").where({ id: row.id }).first();
    return mapRoutineRunRow(updated, new Map([[routine.id, routine]]));
  };

```

- [ ] **Step 7: Session-delete cleanup** — in `src/graphql/mutations/index.ts`, replace the `agent_sessions` branch of `postprocessDeletion`:

```typescript
    if (table.type === "agent_sessions") {
      if (!result.id) {
        return result;
      }
      const { db } = await postgresClient();
      // delete all messages for the session
      await db
        .from("agent_messages")
        .where({ session: result.id })
        .where({ session: result.id })
        .delete();
    }
```

with:

```typescript
    if (table.type === "agent_sessions") {
      if (!result.id) {
        return result;
      }
      const { db } = await postgresClient();
      // delete all messages for the session
      await db
        .from("agent_messages")
        .where({ session: result.id })
        .delete();
      // Routine runs (spec §3.4/§5.6): deleting a run's session cancels the
      // run with FULL cancel parity — the SAME shared helper as the
      // cancelRoutineRun resolver (CAS to cancelled, so terminal rows keep
      // their state + pending BullMQ job removal + stream-active cleanup) —
      // and removes the session's point-in-time rbac snapshot.
      const liveRuns = await db
        .from("job_results")
        .where({ session: result.id })
        .whereIn("state", [
          JOB_STATUS_ENUM.waiting,
          JOB_STATUS_ENUM.active,
          JOB_STATUS_ENUM.waiting_approval,
        ])
        .select("*");
      for (const run of liveRuns) {
        await cancelRoutineRunRow(db, run, ExuluQueues);
      }
      await db
        .from("rbac")
        .where({ entity: "agent_session", target_resource_id: result.id })
        .del();
    }
```

and add the imports at the top of `src/graphql/mutations/index.ts`, after `import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics.ts";`:

```typescript
import { JOB_STATUS_ENUM } from "@EXULU_TYPES/enums/jobs";
import { cancelRoutineRunRow } from "@SRC/exulu/routines/run-state.ts";
import { queues as ExuluQueues } from "@EE/queues/queues";
```

(Note the duplicated `.where({ session: result.id })` in the original is a pre-existing harmless bug — this edit also collapses it to one.)

- [ ] **Step 8: Verify the SDL** — print and inspect:

```bash
npm run type-check
npx tsx scripts/print-sdl.ts /tmp/sdl-check.graphql
grep -n "routineRuns\|RoutineRun\|cancelRoutineRun\|retryRoutineRun" /tmp/sdl-check.graphql
grep -n -A 11 "^enum JobStateEnum" /tmp/sdl-check.graphql | grep -n "waiting_approval\|filtered\|cancelled"
```

Expected: `routineRuns(page: Int, limit: Int, workflow: ID, states: [String!], triggers: [String!], from: Date, to: Date, search: String, needsAttention: Boolean): RoutineRunPage`, `routineRunsNeedingAttentionCount: Float!`, both mutations, and the `RoutineRun`/`RoutineRunPage` types — exactly matching the contract SDL above. The second grep shows `waiting_approval`, `filtered`, and `cancelled` inside the `JobStateEnum` block (Edit 5 landed).

- [ ] **Step 9: Full gates + commit**

```bash
npm run lint:errors && npm test
git add src/exulu/routines/runs-query.ts src/exulu/routines/runs-query.test.ts src/graphql/schemas/index.ts src/graphql/mutations/index.ts
git commit -m "feat(routines): routineRuns GraphQL API with needs-attention count, cancel, retry

routineRuns restricts rows to access-filtered routines (single indexed
query over the new composite index), joins session titles for search;
cancel and session deletion share cancelRoutineRunRow (CAS + best-effort
BullMQ removal + stream-active cleanup); retry re-enqueues the same
job_results row from the failed step. Deleting a run's session also
prunes its rbac snapshot. JobStateEnum now emits
waiting_approval/filtered/cancelled.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Full validation + manual smoke of the run lifecycle

**Files:** none created — verification only.

**Interfaces:** none.

- [ ] **Step 1: Full quality gates**

```bash
npm run validate
```

Expected: type-check clean, lint clean, all Jest suites pass (including the pre-existing 56 suites — proves legacy behavior intact).

- [ ] **Step 2: SDL contract snapshot** — regenerate and diff the contract surface one last time:

```bash
npx tsx scripts/print-sdl.ts /tmp/sdl-final.graphql
grep -A 14 "^type RoutineRun " /tmp/sdl-final.graphql
```

Expected: field list identical to the Task 10 contract block (Plan 3 copies this verbatim).

- [ ] **Step 3: Manual lifecycle smoke** (requires local Postgres + Redis + a routine whose agent has an approval-gated tool; skip gracefully if no dev stack is available and note it in the completion report):
  1. Boot the backend — init-db logs the backfill line at most once; `\d job_results` shows the new columns + `job_results_workflow_state_trigger_created_idx`.
  2. Run a routine via `runWorkflow` — `job_results` row has `trigger='manual'`, `workflow`, `session`, `type='workflow'`; `agent_sessions`/`agent_messages` rows exist; rbac rows with `entity='agent_session'` mirror the routine's.
  3. With an approval-gated tool and `auto_approve_tools=false`: run pauses (`state='waiting_approval'`, `metadata.current_step_index` set); open `/chat/<agent>/<session>`, approve the tool — run flips to `active`, continuation executes remaining steps, ends `completed`.
  4. Deny path: trigger another pause the same way, but DENY the tool in the chat — the run still resumes (`waiting_approval` → `active`), the agent adapts to the denial (tool part ends `output-denied`, no tool execution), remaining steps run, and the run ends `completed`.
  5. `cancelRoutineRun` on an active run → `cancelled`; `retryRoutineRun` → re-runs from the recorded step without duplicating `agent_messages` rows.
  6. Cron: re-save a schedule, let it fire → row stamped `trigger='schedule'`, `trigger_metadata.cron` set.

- [ ] **Step 4: Wrap up** — leave the branch for review (do NOT merge; Plans 2/3 build on it):

```bash
git log --oneline develop..HEAD
git push -u origin feature/email-routines-backend-core
```

Then use superpowers:finishing-a-development-branch to decide integration.

---

## Contract compliance notes (for the plan reviewer)

- All CONTRACT-FIXED names/signatures/SDL are implemented verbatim: `createRunSession`, `casJobResultState`, `resumeRoutineRunIfWaiting`, `processUiMessagesFlow` options + `pausedAtStepIndex`, `BullMqJobData` fields, `TERMINAL_JOB_STATES`, `RoutineRun`/`RoutineRunPage` SDL, `routineRuns`/`routineRunsNeedingAttentionCount`/`cancelRoutineRun`/`retryRoutineRun`.
- Deliberate refinements (documented in Global Constraints / Task 8): (1) session rbac rows use entity `"agent_session"` (singular — what the RBAC machinery actually matches); (2) `runWorkflow` stamps `"api"` instead of `"manual"` for API-key callers per spec §3.3 (both values are inside the contract's union type).
- `upsertWorkflowRunStart`, `parseRunMetadata`, `cancelRoutineRunRow`, `FlowStepError`, `applyRoutineRunFilters`, `mapRoutineRunRow`, `isRunSessionMetadata`, `EMAIL_RUN_VARIABLES` are internal helpers introduced by this plan (additive — no contract export is renamed or removed). Plan 2 may reuse `EMAIL_RUN_VARIABLES` for the intake's variable names.
