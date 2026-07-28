# Routine Queue Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user pick a registered queue per routine (persisted to `workflow_templates.queue`, the single source of truth), expose the registered queues over GraphQL, and remove the deprecated agent-derived queue (`agent.workflows`) across backend and frontend.

**Architecture:** Backend gains a lightweight `queues: [AvailableQueue!]!` query sourced from `exuluApp.get().queues()` (the exact set the run paths validate against). The routine editor writes the chosen queue name into the already-writable `workflow_template.queue` field. The read-only agent-derived Queue section becomes an editable, required select; all `agent.workflows` plumbing (a dead GraphQL type + provider-field entry that is never populated) is deleted.

**Tech Stack:** TypeScript, GraphQL (graphql-tools, code-first SDL strings), BullMQ, Postgres (Knex), Jest (backend). Next.js App Router, Apollo Client, react-hook-form + zod, shadcn/ui, next-intl, Vitest (frontend).

## Global Constraints

- Queue value is the queue **name** (a `string`), matched against `ExuluQueueConfig.queue.name`. Not a UUID/FK.
- Backend queue list is sourced from `exuluApp.get().queues()`; the resolver returns `[]` on any failure (app/Redis not initialized).
- **No DB migration, no backfill.** `workflow_templates.queue` already exists (added by `addMissingFields`), stays nullable. Existing null routines stay null and are prompted to pick a queue; they remain run-blocked by the existing backend check until set.
- Queue is **required in the routine editor** (zod). The backend column stays nullable; run-time validation is unchanged.
- **Repurpose** the Queue section — keep `sections/queue.tsx`, the workbench Manage-queue overlay/QueuePanel, and the `routines.queue.*` i18n keys; flip only the data source (agent → `routine.queue`) and make it editable.
- **KEEP (do not remove):** `ee/workers.ts:504` (`queue_name: bullmqJob.queueName`), `src/exulu/routines/run-state.ts` `queue_name` handling (retry/resume), `role.workflows` RBAC, `src/graphql/resolvers/job-queues.ts`, `workflow_templates.queue`, the singular `queue(queue: QueueEnum!)` query + `QueueEnum`/`QueueResult`, and the eval queue-management UI.
- Backend path aliases: `@SRC/*` → `src/*`, `@EE/*` → `ee/*`, `@EXULU_TYPES/*` → `types/*`.
- End every commit message with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Verify repo+branch before each commit (parallel sessions can switch the primary checkout's branch). Backend tasks run in `exulu/backend`; frontend tasks in the `exulu/frontend` sibling worktree.

## Deploy coupling (read before shipping)

Task A2 removes the `workflows` field from the agent GraphQL type. Any deployed frontend that still selects `agent { workflows { ... } }` will get a GraphQL validation error. **Ship backend (Phase A) and the frontend teardown (Phase D) together**; do not deploy A2 to an environment still running a pre-Phase-D frontend. For local dev (newlkiag symlink), rebuild `dist` and restart the server, then rebuild the frontend.

## File Structure

**Backend (`exulu/backend`)**
- Create `src/graphql/available-queues.ts` — pure `resolveAvailableQueues` helper + `AvailableQueue` type.
- Create `src/graphql/available-queues.test.ts` — jest unit test.
- Modify `src/graphql/schemas/index.ts` — add `AvailableQueue` type + `queues` query + resolver (A1); delete `agent.workflows` type/field/import/comment (A2).
- Modify `src/graphql/utilities/provider-fields.ts` — drop `"workflows"` (A2).
- Modify `src/graphql/utilities/sanitize-and-hydrate-fields.ts` — drop unused `getQueue` import (A2).
- Delete `src/exulu/get-queue.ts` (A2).
- Modify `ee/workers.ts` — delete a stray TODO comment (A2).
- Regenerate `mintlify-docs/api-reference/graphql/schema.graphql` (A2).

**Frontend (`exulu/frontend`)**
- Modify `app/(application)/workflows/types.ts` — add `Routine.queue`; remove dead `agentQueueName` (B/D).
- Modify `app/(application)/workflows/queries.ts` — add `queue` to selections + UPDATE mutation; add `GET_AVAILABLE_QUEUES`; remove `workflows{}` from `GET_AGENT_BY_ID` (B/C/D).
- Modify `app/(application)/workflows/[id]/hooks.ts` — add `queue` to form+zod+save (B); repoint workbench `queueName` to `routine.queue` (C).
- Create `app/(application)/workflows/[id]/sections/queue-options.ts` + `.test.ts` — pure option-merge helper (C).
- Modify `app/(application)/workflows/[id]/sections/queue.tsx` — editable select (C).
- Modify `app/(application)/workflows/[id]/components/routine-workbench.tsx` — QueueSection mount (C).
- Modify `app/(application)/workflows/routines-client.tsx` — repoint `queueNameOf`; drop unused `useAgentsForPage` (C).
- Modify `messages/en.json` + `messages/de.json` — extend `routines.queue.*` (C).
- Modify `app/(application)/workflows/hooks.ts` — drop `AgentRecord.queueName` (D).
- Modify `queries/queries.ts`, `app/(application)/chat/queries.ts`, `app/(application)/agents/queries.ts`, `app/(application)/agents/edit/[id]/queries.ts` — remove `workflows{}` (D).
- Modify `types/models/agent.ts` — remove `workflows` field (D).

---

## Phase A — Backend: expose queues + remove dead agent.workflows

### Task A1: `queues` GraphQL query

**Files:**
- Create: `src/graphql/available-queues.ts`
- Test: `src/graphql/available-queues.test.ts`
- Modify: `src/graphql/schemas/index.ts` (imports near top; `modelDefs` near the `QueueResult` block ~L2560; `typeDefs` near `queue(queue: QueueEnum!)` ~L642; resolvers near `resolvers.Query["queue"]` ~L926)

**Interfaces:**
- Produces: `resolveAvailableQueues(getQueues: () => ExuluQueueConfig[]): AvailableQueue[]` where `interface AvailableQueue { name: string }`. GraphQL: `type AvailableQueue { name: String! }` and `Query.queues: [AvailableQueue!]!`.

- [ ] **Step 1: Write the failing test**

Create `src/graphql/available-queues.test.ts`:

```ts
import type { ExuluQueueConfig } from "@EXULU_TYPES/queue-config";
import { resolveAvailableQueues } from "./available-queues";

const cfg = (name: string) =>
  ({ queue: { name } }) as unknown as ExuluQueueConfig;

describe("resolveAvailableQueues", () => {
  it("maps registered queue configs to { name }", () => {
    expect(
      resolveAvailableQueues(() => [cfg("email_intake"), cfg("reports")]),
    ).toEqual([{ name: "email_intake" }, { name: "reports" }]);
  });

  it("returns [] when the accessor throws (app not initialized)", () => {
    expect(
      resolveAvailableQueues(() => {
        throw new Error("ExuluApp not initialized");
      }),
    ).toEqual([]);
  });

  it("returns [] when no queues are registered", () => {
    expect(resolveAvailableQueues(() => [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/graphql/available-queues.test.ts`
Expected: FAIL — cannot find module `./available-queues`.

- [ ] **Step 3: Write the helper**

Create `src/graphql/available-queues.ts`:

```ts
import type { ExuluQueueConfig } from "@EXULU_TYPES/queue-config";

/** API shape for a registered queue offered to the routine editor. */
export interface AvailableQueue {
  name: string;
}

/**
 * Maps registered queue configs to the API shape. Sourced from
 * `exuluApp.get().queues()` — the exact set the run paths validate against, so
 * a value offered here can never fail queue lookup at run time. Returns [] on
 * any failure (e.g. the app/Redis is not initialized in this process).
 */
export function resolveAvailableQueues(
  getQueues: () => ExuluQueueConfig[],
): AvailableQueue[] {
  try {
    return getQueues().map((config) => ({ name: config.queue.name }));
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/graphql/available-queues.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the type, query field, and resolver into the schema**

In `src/graphql/schemas/index.ts`, add the import next to the other `@SRC/graphql/...` imports near the top:

```ts
import { resolveAvailableQueues } from "@SRC/graphql/available-queues";
```

Add the object type next to the existing `type QueueResult` block (~L2560), following the same `modelDefs += \`...\`` style:

```ts
  modelDefs += `
    type AvailableQueue {
        name: String!
    }
    `;
```

Add the Query field next to the existing `queue(queue: QueueEnum!): QueueResult` block (~L642), following the same `typeDefs += \`...\`` style:

```ts
  typeDefs += `
    queues: [AvailableQueue!]!
    `;
```

Add the resolver next to `resolvers.Query["queue"]` (~L926):

```ts
  resolvers.Query["queues"] = async () =>
    resolveAvailableQueues(() => exuluApp.get().queues());
```

- [ ] **Step 6: Type-check the backend**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # confirm expected backend branch
git add src/graphql/available-queues.ts src/graphql/available-queues.test.ts src/graphql/schemas/index.ts
git commit -m "feat(graphql): queues query listing registered queues

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task A2: Remove dead `agent.workflows` plumbing + regenerate SDL

`agent.workflows` is declared in GraphQL and listed as a provider field but is never populated by any resolver — pure dead code. No runtime consumer exists on the backend.

**Files:**
- Modify: `src/graphql/schemas/index.ts` (L67 import; L126 field push; L1464 comment; L2635-2642 types)
- Modify: `src/graphql/utilities/provider-fields.ts` (L11)
- Modify: `src/graphql/utilities/sanitize-and-hydrate-fields.ts` (L15)
- Delete: `src/exulu/get-queue.ts`
- Modify: `ee/workers.ts` (L748 comment)
- Regenerate: `mintlify-docs/api-reference/graphql/schema.graphql`

- [ ] **Step 1: Delete the `getQueue` import in schemas/index.ts**

Remove this line (~L67):

```ts
import { getQueue } from "@SRC/exulu/get-queue.ts";
```

- [ ] **Step 2: Delete the `workflows` field push on the agent type**

Remove this line (~L126):

```ts
    fields.push("  workflows: AgentWorkflows");
```

- [ ] **Step 3: Delete the `AgentWorkflows` / `AgentWorkflowQueue` type defs**

Remove this block (~L2635-2642):

```ts
type AgentWorkflows {
    enabled: Boolean
    queue: AgentWorkflowQueue
}

type AgentWorkflowQueue {
    name: String
}
```

- [ ] **Step 4: Delete the stray TODO comment (~L1464)**

Remove the line reading `// todo allow setting queue on agent provider and then create a job with type "agent"` (exact wording may vary; it is the only `todo ... queue on agent` comment in this file).

- [ ] **Step 5: Remove `"workflows"` from `exuluProviderFields`**

In `src/graphql/utilities/provider-fields.ts`, delete the `"workflows",` entry (~L11) from the `exuluProviderFields` array. Ensure the array remains valid (no dangling comma issue).

- [ ] **Step 6: Remove the unused `getQueue` import in sanitize-and-hydrate-fields.ts**

Remove this line (~L15):

```ts
import { getQueue } from "@SRC/exulu/get-queue";
```

- [ ] **Step 7: Delete the stub file**

```bash
git rm src/exulu/get-queue.ts
```

(If it is still untracked rather than tracked, use `rm src/exulu/get-queue.ts`.)

- [ ] **Step 8: Remove the stray TODO comment in ee/workers.ts (~L748)**

Remove the `// todo allow setting queue on agent Provider and then create a job with type "agent"` comment line. **Do not touch L504** (`queue_name: bullmqJob.queueName`).

- [ ] **Step 9: Type-check + run backend tests**

Run: `npx tsc --noEmit`
Expected: no errors (no code referenced the deleted symbols).
Run: `npm test`
Expected: PASS (existing suite, incl. A1's `available-queues.test.ts`).

- [ ] **Step 10: Regenerate the GraphQL SDL doc**

Run (from the backend repo root):

```bash
npx tsx scripts/print-sdl.ts mintlify-docs/api-reference/graphql/schema.graphql
```

(Equivalent: `npm run sdl` from `mintlify-docs/`.) Confirm the diff drops `type AgentWorkflows`, `type AgentWorkflowQueue`, and the `workflows: AgentWorkflows` field on `type agent`, and adds `type AvailableQueue` + `queues: [AvailableQueue!]!` from Task A1.

- [ ] **Step 11: Rebuild dist**

Run: `npm run build`
Expected: `tsup` completes without errors.

- [ ] **Step 12: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # confirm expected backend branch
git add src/graphql/schemas/index.ts src/graphql/utilities/provider-fields.ts \
        src/graphql/utilities/sanitize-and-hydrate-fields.ts ee/workers.ts \
        mintlify-docs/api-reference/graphql/schema.graphql
git rm --cached src/exulu/get-queue.ts 2>/dev/null || true
git commit -m "refactor(graphql): remove dead agent.workflows queue plumbing

Deletes the never-populated AgentWorkflows GraphQL type + workflows
provider field + unused getQueue stub. workflow_templates.queue is the
single source of truth. Regenerates the SDL doc.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase B — Frontend: wire `routine.queue` through the data layer

Runs against the current backend (the `workflow_template.queue` field already exists and is writable via auto-CRUD). All frontend tasks run in the `exulu/frontend` sibling worktree.

### Task B1: Persist and read `routine.queue`

**Files:**
- Modify: `app/(application)/workflows/types.ts` (`Routine`)
- Modify: `app/(application)/workflows/queries.ts` (`TEMPLATE_ITEM_SELECTION`, `GET_WORKFLOW_TEMPLATE_BY_ID`, `UPDATE_WORKFLOW_TEMPLATE`)
- Modify: `app/(application)/workflows/[id]/hooks.ts` (`routineEditorSchema`, `useRoutineEditor`)

**Interfaces:**
- Produces: `Routine.queue?: string | null`; `RoutineFormValues.queue: string` (required); `UPDATE_WORKFLOW_TEMPLATE` accepts `$queue: String`.

- [ ] **Step 1: Add `queue` to the `Routine` type**

In `app/(application)/workflows/types.ts`, inside `interface Routine`, add after the `agent` field:

```ts
  /** Queue name the routine runs on (workflow_templates.queue). Required to run. */
  queue?: string | null;
```

- [ ] **Step 2: Select `queue` in the list + by-id queries**

In `app/(application)/workflows/queries.ts`, add `queue` to `TEMPLATE_ITEM_SELECTION` (after `agent`):

```
  id
  agent
  queue
  name
```

And to `GET_WORKFLOW_TEMPLATE_BY_ID`'s selection (after `agent`):

```
      id
      name
      agent
      queue
      description
```

- [ ] **Step 3: Add `$queue` to the update mutation**

In `UPDATE_WORKFLOW_TEMPLATE`, add the variable, the input mapping, and the returned field:

```graphql
  mutation UpdateWorkflowTemplate(
    $id: ID!
    $name: String
    $description: String
    $rights_mode: String
    $RBAC: RBACInput
    $steps_json: JSON
    $agent: String
    $queue: String
  ) {
    workflow_templatesUpdateOneById(
      id: $id
      input: {
        name: $name
        description: $description
        rights_mode: $rights_mode
        RBAC: $RBAC
        steps_json: $steps_json
        agent: $agent
        queue: $queue
      }
    ) {
      item {
        id
        name
        description
        created_by
        rights_mode
        agent
        queue
        variables
```

- [ ] **Step 4: Add `queue` to the editor form (required) + save**

In `app/(application)/workflows/[id]/hooks.ts`:

Add to `routineEditorSchema` (after `agent`):

```ts
  queue: z.string().min(1, { message: "A queue is required." }),
```

Add to `useRoutineEditor`'s `defaultValues` (after `agent`):

```ts
      queue: routine.queue ?? "",
```

Add to the `updateMutate` variables inside `save()` (after `agent: values.agent,`):

```ts
          queue: values.queue,
```

Add to the `discard()` `form.reset({...})` (after `agent`):

```ts
      queue: routine.queue ?? "",
```

- [ ] **Step 5: Type-check + lint**

Run: `npx tsc --noEmit`
Run: `npm run lint`
Expected: no errors. (The queue select UI arrives in Phase C; the form field exists but is not yet rendered — that is fine.)

- [ ] **Step 6: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # confirm expected frontend branch
git add "app/(application)/workflows/types.ts" \
        "app/(application)/workflows/queries.ts" \
        "app/(application)/workflows/[id]/hooks.ts"
git commit -m "feat(routines): persist routine.queue via editor form + queries

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase C — Frontend: repurpose the Queue section as an editable select

### Task C1: Queue-option merge helper

**Files:**
- Create: `app/(application)/workflows/[id]/sections/queue-options.ts`
- Test: `app/(application)/workflows/[id]/sections/queue-options.test.ts`

**Interfaces:**
- Produces: `mergeQueueOptions(available: QueueOption[], current?: string | null): QueueOption[]` where `interface QueueOption { name: string }`.

- [ ] **Step 1: Write the failing test**

Create `app/(application)/workflows/[id]/sections/queue-options.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { mergeQueueOptions } from "./queue-options";

describe("mergeQueueOptions", () => {
  it("returns available unchanged when current is registered", () => {
    const available = [{ name: "a" }, { name: "b" }];
    expect(mergeQueueOptions(available, "b")).toEqual(available);
  });

  it("prepends current when it is not registered", () => {
    expect(mergeQueueOptions([{ name: "a" }], "gone")).toEqual([
      { name: "gone" },
      { name: "a" },
    ]);
  });

  it("returns available unchanged when current is empty/null", () => {
    const available = [{ name: "a" }];
    expect(mergeQueueOptions(available, null)).toEqual(available);
    expect(mergeQueueOptions(available, "")).toEqual(available);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "app/(application)/workflows/[id]/sections/queue-options.test.ts"`
Expected: FAIL — cannot resolve `./queue-options`.

- [ ] **Step 3: Write the helper**

Create `app/(application)/workflows/[id]/sections/queue-options.ts`:

```ts
export interface QueueOption {
  name: string;
}

/**
 * Returns the available queues, guaranteeing the currently-selected queue is
 * present as an option even when it is not (or no longer) registered — mirrors
 * the Basics agent select, so an unregistered stored value stays visible and
 * changeable rather than rendering a blank trigger.
 */
export function mergeQueueOptions(
  available: QueueOption[],
  current?: string | null,
): QueueOption[] {
  if (!current || available.some((q) => q.name === current)) {
    return available;
  }
  return [{ name: current }, ...available];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run "app/(application)/workflows/[id]/sections/queue-options.test.ts"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add "app/(application)/workflows/[id]/sections/queue-options.ts" \
        "app/(application)/workflows/[id]/sections/queue-options.test.ts"
git commit -m "feat(routines): queue-option merge helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task C2: `GET_AVAILABLE_QUEUES` + editable Queue section + workbench repoint

**Files:**
- Modify: `app/(application)/workflows/queries.ts` (add `GET_AVAILABLE_QUEUES`)
- Modify: `app/(application)/workflows/[id]/sections/queue.tsx` (rewrite)
- Modify: `app/(application)/workflows/[id]/components/routine-workbench.tsx` (QueueSection mount)
- Modify: `app/(application)/workflows/[id]/hooks.ts` (`useRoutineWorkbench` queue source)
- Modify: `app/(application)/workflows/routines-client.tsx` (`queueNameOf` repoint; drop unused hook)
- Modify: `messages/en.json`, `messages/de.json` (extend `routines.queue.*`)

**Interfaces:**
- Consumes: `mergeQueueOptions` (C1); `RoutineSectionProps { routine, editor, workbench }`; `editor.form.control` with field `queue`; `workbench.openQueue(name)`.
- Produces: `GET_AVAILABLE_QUEUES` returning `{ queues: { name: string }[] }`.

- [ ] **Step 1: Add the `GET_AVAILABLE_QUEUES` query**

In `app/(application)/workflows/queries.ts`, add near the agent-resolution section:

```ts
/** Registered BullMQ queues (backend Query.queues) for the routine queue select. */
export const GET_AVAILABLE_QUEUES = gql`
  query GetAvailableQueues {
    queues {
      name
    }
  }
`;
```

- [ ] **Step 2: Rewrite the Queue section as an editable select**

Replace the entire contents of `app/(application)/workflows/[id]/sections/queue.tsx` with:

```tsx
"use client";

/**
 * QueueSection — editable select binding the routine's own queue
 * (workflow_templates.queue, the single source of truth) via the page-level
 * editor form. Options come from the backend's registered queues
 * (GET_AVAILABLE_QUEUES). The stored value is always shown as an option even if
 * it is no longer registered (see mergeQueueOptions), so the user can see and
 * change it. "Manage queue" opens the workbench QueuePanel Sheet for the
 * currently-selected queue.
 */

import { useQuery } from "@apollo/client";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { GET_AVAILABLE_QUEUES } from "../../queries";
import { mergeQueueOptions } from "./queue-options";
import type { RoutineSectionProps } from "./types";

export function QueueSection({ editor, workbench }: RoutineSectionProps) {
  const t = useTranslations("routines");
  const canWrite = workbench.access.canWrite;

  const { data, loading } = useQuery<{ queues?: { name: string }[] }>(
    GET_AVAILABLE_QUEUES,
    { fetchPolicy: "cache-first" },
  );

  const current = editor.form.watch("queue");
  const options = mergeQueueOptions(data?.queues ?? [], current);
  const noneAvailable = !loading && options.length === 0;

  return (
    <section id="queue" className="scroll-mt-20 space-y-4" tabIndex={-1}>
      <div className="space-y-1">
        <h2 className="text-lg font-medium">{t("queue.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("queue.description")}
        </p>
      </div>

      <Form {...editor.form}>
        <FormField
          control={editor.form.control}
          name="queue"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("queue.label")}</FormLabel>
              <div className="flex flex-wrap items-center gap-3">
                <FormControl>
                  <Select
                    value={field.value ?? ""}
                    onValueChange={field.onChange}
                    disabled={!canWrite || loading || noneAvailable}
                  >
                    <SelectTrigger className="w-64">
                      <SelectValue placeholder={t("queue.placeholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      {options.map((q) => (
                        <SelectItem key={q.name} value={q.name}>
                          <span className="capitalize">
                            {q.name.replaceAll("_", " ")}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormControl>
                {field.value ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => workbench.openQueue(field.value)}
                  >
                    {t("queue.manage")}
                  </Button>
                ) : null}
              </div>
              {noneAvailable ? (
                <p className="text-sm text-muted-foreground">
                  {t("queue.noneAvailable")}
                </p>
              ) : null}
              <FormMessage />
            </FormItem>
          )}
        />
      </Form>
    </section>
  );
}
```

- [ ] **Step 3: Update the QueueSection mount in the workbench**

In `app/(application)/workflows/[id]/components/routine-workbench.tsx`, replace:

```tsx
            <QueueSection
              queueName={workbench.queueName}
              onManageQueue={workbench.openQueue}
            />
```

with:

```tsx
            <QueueSection {...sectionProps} />
```

Leave the Queue Sheet / `QueuePanel` overlay block and the `import { QueueSection }` untouched.

- [ ] **Step 4: Repoint the workbench queue source to `routine.queue`**

In `app/(application)/workflows/[id]/hooks.ts`, inside `useRoutineWorkbench`, change:

```ts
  const queueName = agentRecord?.queueName ?? null;
```

to:

```ts
  const queueName = routine.queue ?? null;
```

(`agentRecord` is still used for `agentName`, so keep the `useAgentsForPage` call. `queueName` continues to feed `openRun` → `RunRoutineRequest.queue`.)

- [ ] **Step 5: Repoint `queueNameOf` in the list + drop the now-unused agents hook**

In `app/(application)/workflows/routines-client.tsx`:

Change the callback to read the routine's own field:

```ts
  // Resolve the routine's queue (used for run dialog wiring).
  const queueNameOf = React.useCallback(
    (routine: Routine): string | null => routine.queue ?? null,
    [],
  );
```

Then remove the now-unused `agentIds` memo (the `React.useMemo(() => items.map((r) => r.agent)...)` block) and the `const agents = useAgentsForPage(agentIds);` line, and drop `useAgentsForPage` from the import from `./hooks`. (Row agent-name display does not use this map — items are passed straight to `RoutineList`.)

- [ ] **Step 6: Extend the i18n `routines.queue` keys (en + de)**

In `messages/en.json`, replace the `routines.queue` object with (keep the existing `manage`, `sheetTitle`, `runPrefix`, `toast.cannotRetry`; replace `none`; add `description`, `label`, `placeholder`, `noneAvailable`):

```json
    "queue": {
      "title": "Queue",
      "description": "The queue this routine's runs are enqueued on.",
      "label": "Queue",
      "placeholder": "Select a queue",
      "noneAvailable": "No queues are registered. Register a queue in ExuluApp.create to run this routine.",
      "manage": "Manage queue",
      "sheetTitle": "Queue: {name}",
      "runPrefix": "Routine run:",
      "toast": {
        "cannotRetry": "Cannot retry — original routine reference missing"
      }
    },
```

In `messages/de.json`, replace the matching `routines.queue` object (the one at the routines path, ~L3697) with:

```json
    "queue": {
      "title": "Warteschlange",
      "description": "Die Warteschlange, in die Läufe dieser Routine eingereiht werden.",
      "label": "Warteschlange",
      "placeholder": "Warteschlange auswählen",
      "noneAvailable": "Es sind keine Warteschlangen registriert. Registriere eine Warteschlange in ExuluApp.create, um diese Routine auszuführen.",
      "manage": "Warteschlange verwalten",
      "sheetTitle": "Warteschlange: {name}",
      "runPrefix": "Routinelauf:",
      "toast": {
        "cannotRetry": "Wiederholung nicht möglich — Referenz zur ursprünglichen Routine fehlt"
      }
    },
```

(Preserve each file's existing `manage`/`sheetTitle`/`runPrefix`/`toast` wording if it differs from the above; only add the four new keys and replace `none`.)

- [ ] **Step 7: Verify — helper tests, type-check, lint**

Run: `npx vitest run "app/(application)/workflows/[id]/sections/queue-options.test.ts"`
Expected: PASS.
Run: `npx tsc --noEmit`
Run: `npm run lint`
Expected: no errors. In particular, confirm no "unused variable" error for `useAgentsForPage`/`agents` in `routines-client.tsx`.

- [ ] **Step 8: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add "app/(application)/workflows/queries.ts" \
        "app/(application)/workflows/[id]/sections/queue.tsx" \
        "app/(application)/workflows/[id]/components/routine-workbench.tsx" \
        "app/(application)/workflows/[id]/hooks.ts" \
        "app/(application)/workflows/routines-client.tsx" \
        messages/en.json messages/de.json
git commit -m "feat(routines): editable queue select bound to routine.queue

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase D — Frontend: remove agent-derived queue plumbing

After Phase C no runtime code reads the agent-derived queue. Delete the orphaned selections and types. **Ship with Phase A (see Deploy coupling).**

### Task D1: Delete agent `workflows{}` selections + `AgentRecord.queueName` + dead types

**Files:**
- Modify: `app/(application)/workflows/hooks.ts` (`AgentRecord`, `useAgentsForPage`)
- Modify: `app/(application)/workflows/queries.ts` (`GET_AGENT_BY_ID`)
- Modify: `queries/queries.ts`, `app/(application)/chat/queries.ts`, `app/(application)/agents/queries.ts`, `app/(application)/agents/edit/[id]/queries.ts`
- Modify: `types/models/agent.ts`
- Modify: `app/(application)/workflows/types.ts` (`Routine.agentQueueName`, `RunRoutineRequest.queue` doc)

- [ ] **Step 1: Strip `queueName` from `useAgentsForPage`**

In `app/(application)/workflows/hooks.ts`:

Remove `queueName?: string | null;` from the `AgentRecord` interface.

In the `.then(({ data }) => {...})` mapping, remove the `queueName: data.agentById.workflows?.queue?.name ?? null,` line and the inline `workflows?: {...}` field from the `client.query<{ agentById?: {...} }>` type argument, leaving:

```ts
          .query<{
            agentById?: {
              id: string;
              name: string;
            };
          }>({
```

and the returned record:

```ts
            return {
              id: data.agentById.id,
              name: data.agentById.name,
            } satisfies AgentRecord;
```

- [ ] **Step 2: Remove `workflows{}` from `GET_AGENT_BY_ID` (routines)**

In `app/(application)/workflows/queries.ts`, reduce `GET_AGENT_BY_ID` to:

```ts
export const GET_AGENT_BY_ID = gql`
  query RoutinesGetAgentById($id: ID!) {
    agentById(id: $id) {
      id
      name
    }
  }
`;
```

- [ ] **Step 3: Remove `workflows{}` from the other four agent queries**

Delete the following block wherever it appears in each file (it is the only `workflows {` selection in each):

```
      workflows {
        enabled
        queue {
          name
        }
      }
```

- `queries/queries.ts` (~L130-135)
- `app/(application)/chat/queries.ts` (~L52-57)
- `app/(application)/agents/queries.ts` (~L132-137)
- `app/(application)/agents/edit/[id]/queries.ts` (~L93-98) — also update the nearby comment (~L63) that lists `workflows` among fetched-but-unsurfaced fields.

- [ ] **Step 4: Remove the `workflows` field from the frontend agent type**

In `types/models/agent.ts`, delete the block (~L32-37):

```ts
    workflows?: {
        enabled: boolean;
        queue?: {
            name: string;
        };
    };
```

- [ ] **Step 5: Remove the dead `agentQueueName` field + fix the run-request doc**

In `app/(application)/workflows/types.ts`:

Delete the `Routine.agentQueueName` field:

```ts
  /** Agent queue (if any); populated by useAgentsForPage. */
  agentQueueName?: string | null;
```

Update the `RunRoutineRequest.queue` doc comment from "Resolved at row-press from the agent's queue" to:

```ts
  /** The routine's queue (workflow_templates.queue); undefined -> immediate. */
  queue?: string;
```

- [ ] **Step 6: Verify — type-check, lint, build**

Run: `npx tsc --noEmit`
Run: `npm run lint`
Run: `npm run build`
Expected: all pass; grep confirms no remaining references:

```bash
rg -n "workflows\s*\{|queueName|agentQueueName|AgentWorkflows" "app/(application)/workflows" "queries" "app/(application)/chat" "app/(application)/agents" "types/models/agent.ts"
```

Expected: no matches for agent-derived queue (matches for `role.workflows`, eval `queueName` in `evals/**`, or `workflow_templates` are unrelated and out of these paths).

- [ ] **Step 7: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add "app/(application)/workflows/hooks.ts" \
        "app/(application)/workflows/queries.ts" \
        "app/(application)/workflows/types.ts" \
        "queries/queries.ts" \
        "app/(application)/chat/queries.ts" \
        "app/(application)/agents/queries.ts" \
        "app/(application)/agents/edit/[id]/queries.ts" \
        "types/models/agent.ts"
git commit -m "refactor(routines): remove agent-derived queue plumbing

Agent.workflows queue is deprecated; routine.queue is the single source
of truth. Drops the workflows{} selections, AgentRecord.queueName, the
frontend agent.workflows type, and the dead Routine.agentQueueName.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Manual smoke test (after all phases)

1. In a dev app, register a custom queue via `ExuluApp.create({ queues: [...] })` and start the backend (`npm run build` + restart / newlkiag symlink).
2. Query `{ queues { name } }` in GraphQL — confirm it lists the built-in `email_intake` / `eval_runs` plus the custom queue; confirm `{ __type(name: "AgentWorkflows") { name } }` returns null.
3. In the frontend, open a routine → Queue section shows the select; pick the custom queue; Save.
4. Reload — the selection persists (`workflow_template.queue`).
5. Trigger the routine (Run button, or the email/schedule path) — confirm the job enqueues on the chosen queue and the run dialog shows "Queued on &lt;queue&gt;".
6. Open a legacy routine with no queue — the select shows the "Select a queue" placeholder and Save is blocked by the required validation until a queue is chosen.

## Deferred (not in this plan)

- A "no queue set" **badge on the routines list rows** (`routine-row.tsx`). The editor's required select + placeholder is the primary prompt; a list badge is a nice-to-have to be added following the existing row-badge pattern.
- Full `next build`-based CI wiring for the new vitest helper tests (repo currently has no test CI step).

## Self-Review

- **Spec coverage:** Queue list API → A1. `workflow.queue` writable/persisted → B1 (field already exposed by backend auto-CRUD). Editable required select, repurposed section → C2 + B1 (zod required). Agent.workflows teardown (backend) → A2. Agent-derived teardown (frontend) → D1. KEEP list honored (no task touches `run-state.ts`/`workers.ts:504`/`role.workflows`/`job-queues.ts`/eval queues). No backfill/migration → none added. Manual smoke covers run paths.
- **Placeholders:** none — every code step carries concrete code; the only deferrals are explicitly listed under "Deferred" (not inside tasks).
- **Type consistency:** `AvailableQueue { name }` (A1) matches GraphQL `AvailableQueue { name: String! }` and the frontend `{ queues: { name }[] }` (C2). `mergeQueueOptions(available, current)` signature (C1) matches its call in `queue.tsx` (C2). `RoutineFormValues.queue` (B1) matches `editor.form` field `queue` used in `queue.tsx` (C2) and the `save()` variable (B1). `Routine.queue` (B1) matches the workbench (C2) and `routines-client` (C2) reads.
