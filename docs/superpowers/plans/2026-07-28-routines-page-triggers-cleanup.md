# Routines Page Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the routine detail page, move Queue above Access and group Email / Schedule / a new API trigger into one tabbed "Triggers" section whose API tab shows a copyable `runWorkflow` cURL example.

**Architecture:** Frontend-only restructure of `RoutineWorkbench` and its sections. The email-trigger and schedule bodies are lifted verbatim into tab panels under a new `sections/triggers/` folder; a rewritten `sections/triggers.tsx` becomes a `DetailSection` + shadcn `Tabs` container. A new API tab renders a cURL snippet built by a pure, unit-tested helper. No backend/GraphQL/type changes.

**Tech Stack:** Next.js App Router, React, next-intl, shadcn/ui (`Tabs`, `DetailSection`), Apollo Client (unchanged ops), `CodeBlock`/`CodeBlockCopyButton` (ai-elements), Vitest (helper unit test only).

## Global Constraints

- **Frontend repo only:** `exulu/frontend`. No backend, GraphQL schema, resolver, or type changes.
- **No behavior change to the email trigger or schedule editor** — only their container moves (standalone sections → tabs). Same GraphQL ops, same helpers, same handlers.
- **Section order** becomes exactly `["basics", "queue", "access", "steps", "triggers", "runs", "danger"]`; Queue sits directly above Access. The workbench JSX render order MUST match this list (scroll-spy default active id depends on it).
- **Triggers UI:** one collapsible `DetailSection` titled `t("editor.sections.triggers")` (`defaultOpen` true) wrapping `<Tabs defaultValue="email">` with tabs Email · Schedule · API. Section keeps `id="triggers"`.
- **API tab:** cURL only, mirroring `app/(application)/token/components/token-view.tsx`; endpoint from `ConfigContext.backend`; header `Authorization: Bearer $EXULU_TOKEN`; `runWorkflow` mutation with the routine's `id` and variable names prefilled; rendered with `CodeBlock` + `CodeBlockCopyButton`.
- Every commit message ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Verify repo+branch before each commit.
- Verification: `npx tsc --noEmit` + `npm run lint` + `npm run build`, plus `npx vitest run` for the helper. There is no component-test infra for these sections; UI is verified by build + manual smoke.

## File Structure

```
app/(application)/workflows/[id]/sections/
  triggers.tsx                     ← REWRITTEN: DetailSection + Tabs container
  schedule.tsx                     ← DELETED (body moves to triggers/schedule-tab.tsx)
  triggers/
    build-curl.ts                  ← NEW: buildRunWorkflowCurl(routine, backend)
    build-curl.test.ts             ← NEW: vitest
    api-tab.tsx                    ← NEW: ApiTriggerTab
    email-tab.tsx                  ← NEW: EmailTriggerTab (lifted from old triggers.tsx)
    schedule-tab.tsx               ← NEW: ScheduleTab (lifted from schedule.tsx)
app/(application)/workflows/[id]/components/routine-workbench.tsx  ← MODIFIED: reorder + fold
messages/en.json, messages/de.json ← MODIFIED: labels + tab/api keys
```

Path note (relative-import depth): files in `sections/triggers/` are **one level deeper** than `sections/`. When lifting bodies, adjust: `../../queries`→`../../../queries`, `../../types`→`../../../types`, `../../components/...`→`../../../components/...`, `./trigger-config`→`../trigger-config`. Absolute `@/...` imports are unchanged.

---

### Task 1: `buildRunWorkflowCurl` helper

**Files:**
- Create: `app/(application)/workflows/[id]/sections/triggers/build-curl.ts`
- Test: `app/(application)/workflows/[id]/sections/triggers/build-curl.test.ts`

**Interfaces:**
- Produces: `buildRunWorkflowCurl(routine: Routine, backend: string): string`.

- [ ] **Step 1: Write the failing test**

Create `app/(application)/workflows/[id]/sections/triggers/build-curl.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { Routine } from "../../../types";
import { buildRunWorkflowCurl } from "./build-curl";

const routine = (over: Partial<Routine>): Routine =>
  ({
    id: "abc-123",
    name: "R",
    agent: "a",
    created_by: 1,
    rights_mode: "private",
    RBAC: { users: [], roles: [], teams: [] },
    createdAt: "",
    updatedAt: "",
    ...over,
  }) as Routine;

function parseBody(curl: string) {
  const m = curl.match(/-d '([\s\S]*)'$/);
  if (!m) throw new Error("no -d body found");
  return JSON.parse(m[1]);
}

describe("buildRunWorkflowCurl", () => {
  it("targets the given endpoint with a bearer-token header", () => {
    const out = buildRunWorkflowCurl(routine({ id: "xyz" }), "https://api.test");
    expect(out).toContain("curl -X POST https://api.test/graphql");
    expect(out).toContain('-H "Authorization: Bearer $EXULU_TOKEN"');
  });

  it("prefills the routine id and its variable names in the mutation body", () => {
    const body = parseBody(
      buildRunWorkflowCurl(
        routine({ id: "xyz", variables: ["topic", "count"] }),
        "https://api.test",
      ),
    );
    expect(body.query).toContain('runWorkflow(id: "xyz"');
    expect(body.variables).toEqual({ variables: { topic: "...", count: "..." } });
  });

  it("renders empty variables when the routine has none", () => {
    const body = parseBody(buildRunWorkflowCurl(routine({ variables: [] }), ""));
    expect(body.variables).toEqual({ variables: {} });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "app/(application)/workflows/[id]/sections/triggers/build-curl.test.ts"`
Expected: FAIL — cannot resolve `./build-curl`.

- [ ] **Step 3: Write the helper**

Create `app/(application)/workflows/[id]/sections/triggers/build-curl.ts`:

```ts
import type { Routine } from "../../../types";

/**
 * Builds a copyable cURL command that triggers a routine via the GraphQL
 * `runWorkflow` mutation. The routine id and its variable names are prefilled;
 * the caller supplies a bearer token via the `$EXULU_TOKEN` shell variable.
 * `backend` is the API base URL (e.g. `ConfigContext.backend`); an empty base
 * still renders a valid command shape ending in `/graphql`.
 */
export function buildRunWorkflowCurl(routine: Routine, backend: string): string {
  const varsObject = Object.fromEntries(
    (routine.variables ?? []).map((name) => [name, "..."]),
  );
  const body = JSON.stringify({
    query:
      'mutation($variables: JSON) { runWorkflow(id: "' +
      routine.id +
      '", variables: $variables) { job } }',
    variables: { variables: varsObject },
  });
  return [
    `curl -X POST ${backend}/graphql \\`,
    `  -H "Authorization: Bearer $EXULU_TOKEN" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${body}'`,
  ].join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run "app/(application)/workflows/[id]/sections/triggers/build-curl.test.ts"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # confirm expected frontend branch
git add "app/(application)/workflows/[id]/sections/triggers/build-curl.ts" \
        "app/(application)/workflows/[id]/sections/triggers/build-curl.test.ts"
git commit -m "feat(routines): runWorkflow cURL builder for the API trigger tab

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: API trigger tab

**Files:**
- Create: `app/(application)/workflows/[id]/sections/triggers/api-tab.tsx`
- Modify: `messages/en.json`, `messages/de.json` (add `routines.triggers.api.*`)

**Interfaces:**
- Consumes: `buildRunWorkflowCurl` (Task 1); `ConfigContext` (`config?.backend`) from `@/components/shell/config-context`; `CodeBlock`, `CodeBlockCopyButton` from `@/components/ai-elements/code-block`.
- Produces: `ApiTriggerTab({ routine }: { routine: Routine })`.

- [ ] **Step 1: Create the API tab component**

Create `app/(application)/workflows/[id]/sections/triggers/api-tab.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import * as React from "react";

import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { ConfigContext } from "@/components/shell/config-context";

import type { Routine } from "../../../types";
import { buildRunWorkflowCurl } from "./build-curl";

export interface ApiTriggerTabProps {
  routine: Routine;
}

export function ApiTriggerTab({ routine }: ApiTriggerTabProps) {
  const t = useTranslations("routines");
  const config = React.useContext(ConfigContext);
  const snippet = React.useMemo(
    () => buildRunWorkflowCurl(routine, config?.backend || ""),
    [routine, config],
  );

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {t("triggers.api.description")}
      </p>
      <CodeBlock code={snippet} language="bash">
        <CodeBlockCopyButton />
      </CodeBlock>
      <p className="text-xs text-muted-foreground">
        {t("triggers.api.tokenHint")}{" "}
        <Link href="/token" className="underline underline-offset-2">
          {t("triggers.api.tokenLink")}
        </Link>
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Add the API i18n keys (en + de)**

In `messages/en.json`, inside the `routines.triggers` object (its opening `"triggers": {` is at ~L3841), add:

```json
      "api": {
        "description": "Trigger this routine programmatically by calling the GraphQL API.",
        "tokenHint": "Authenticate with a personal API token —",
        "tokenLink": "get one here."
      },
```

In `messages/de.json`, inside the matching `routines.triggers` object, add:

```json
      "api": {
        "description": "Löse diese Routine programmatisch über die GraphQL-API aus.",
        "tokenHint": "Authentifiziere dich mit einem persönlichen API-Token —",
        "tokenLink": "hier erhältst du eines."
      },
```

- [ ] **Step 3: Verify — type-check, lint, JSON validity**

Run: `npx tsc --noEmit`
Run: `npm run lint`
Run: `node -e "require('./messages/en.json'); require('./messages/de.json'); console.log('json ok')"`
Expected: no errors in the touched files; JSON parses. (The component is not mounted yet — that happens in Task 3; an unused-but-exported component is fine.)

- [ ] **Step 4: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add "app/(application)/workflows/[id]/sections/triggers/api-tab.tsx" \
        messages/en.json messages/de.json
git commit -m "feat(routines): API trigger tab with copyable runWorkflow cURL

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Grouped Triggers container + Email/Schedule tab panels

Lift the email + schedule bodies into tab panels and rewrite `triggers.tsx` as the tabbed container. The container keeps the same `{ routine, access }` props as today, so the workbench mount is unchanged. **Known intermediate state at the end of this task:** the workbench still mounts the standalone `<ScheduleSection>` *and* the new grouped `<TriggersSection>` (which now has a Schedule tab), so Schedule appears twice until Task 4 removes the standalone. This compiles and the tabs work; Task 4 finalizes.

**Files:**
- Create: `app/(application)/workflows/[id]/sections/triggers/email-tab.tsx` (lifted from current `triggers.tsx`)
- Create: `app/(application)/workflows/[id]/sections/triggers/schedule-tab.tsx` (lifted from `schedule.tsx`)
- Rewrite: `app/(application)/workflows/[id]/sections/triggers.tsx` (container)
- Modify: `messages/en.json`, `messages/de.json` (tab labels + rename Triggers nav label)

**Interfaces:**
- Consumes: `ApiTriggerTab` (Task 2); `Tabs, TabsList, TabsTrigger, TabsContent` from `@/components/ui/tabs`; `DetailSection` from `@/components/primitives/detail-section`.
- Produces: `EmailTriggerTab({ routine, access })`, `ScheduleTab({ routine, access })`, and the rewritten `TriggersSection({ routine, access })`.

- [ ] **Step 1: Create `email-tab.tsx` by lifting the current email body**

Copy the ENTIRE current `app/(application)/workflows/[id]/sections/triggers.tsx` into `app/(application)/workflows/[id]/sections/triggers/email-tab.tsx`, then apply exactly these changes:

1. Fix relative import depth (one level deeper): `from "../../queries"` → `from "../../../queries"`; `from "../../types"` → `from "../../../types"`; `from "./trigger-config"` → `from "../trigger-config"`.
2. Remove the now-unused import `import { DetailSection } from "@/components/primitives/detail-section";`.
3. Rename the exported component `TriggersSection` → `EmailTriggerTab` and its props interface `TriggersSectionProps` → `EmailTriggerTabProps`.
4. Replace that component's `return (...)` (the `<section id="triggers"><DetailSection ...> … </DetailSection></section>` block) with just its inner content:

```tsx
  return loading && !data ? (
    <p className="text-sm text-muted-foreground">{t("triggers.loading")}</p>
  ) : (
    <TriggerForm
      key={trigger?.id ?? "new"}
      routine={routine}
      access={access}
      trigger={trigger}
      onSaved={refetch}
    />
  );
```

Leave everything else (the `useQuery`, `trigger` derivation, `TriggerForm`, the `TEST_PAYLOAD_*` constants, all types and handlers) byte-identical.

- [ ] **Step 2: Create `schedule-tab.tsx` by lifting the schedule body**

Copy the ENTIRE current `app/(application)/workflows/[id]/sections/schedule.tsx` into `app/(application)/workflows/[id]/sections/triggers/schedule-tab.tsx`, then:

1. Fix relative import depth: `from "../../components/schedule-editor"` → `from "../../../components/schedule-editor"`; `from "../../queries"` → `from "../../../queries"`; `from "../../types"` → `from "../../../types"`.
2. Remove the now-unused import `import { DetailSection } from "@/components/primitives/detail-section";`.
3. Rename `ScheduleSection` → `ScheduleTab` and `ScheduleSectionProps` → `ScheduleTabProps`.
4. Replace that component's `return (...)` (the `<section id="schedule"><DetailSection ...> … </DetailSection></section>` block) with a fragment holding just its inner content — the `<div className="space-y-3"> … </div>` body and the `<ConfirmDialog … />` that follows it:

```tsx
  return (
    <>
      <div className="space-y-3">
        {loading && !current ? (
          <p className="text-sm text-muted-foreground">{t("schedule.loading")}</p>
        ) : null}

        {current?.next ? (
          <p className="text-xs text-muted-foreground">
            {t("schedule.nextRun")} <RelativeTime date={current.next} />
          </p>
        ) : null}

        <ScheduleEditor
          value={currentCron}
          onChange={setPendingCron}
          disabled={
            !access.canWrite || upsertState.loading || deleteState.loading
          }
        />

        {access.canWrite ? (
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={handleSave}
              disabled={
                !pendingCron ||
                pendingCron === currentCron ||
                upsertState.loading
              }
            >
              {upsertState.loading
                ? t("schedule.saving")
                : currentCron
                  ? t("schedule.update")
                  : t("schedule.save")}
            </Button>
            {currentCron ? (
              <Button
                variant="outline"
                onClick={() => setDeleteOpen(true)}
                disabled={deleteState.loading}
              >
                <Trash2 aria-hidden="true" className="mr-2 size-4" />
                {t("schedule.remove")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("schedule.delete.title")}
        description={t("schedule.delete.description", { name: routine.name })}
        variant="destructive"
        onConfirm={handleConfirmDelete}
        confirmLabel={t("schedule.delete.confirmLabel")}
      />
    </>
  );
```

Leave the hooks/handlers above the `return` byte-identical. (`schedule.tsx` itself is deleted in Task 4.)

- [ ] **Step 3: Rewrite `triggers.tsx` as the tabbed container**

Replace the ENTIRE contents of `app/(application)/workflows/[id]/sections/triggers.tsx` with:

```tsx
"use client";

/**
 * TriggersSection — the routine's "ways to run it" grouped into one collapsible
 * section with tabs: Email (inbound webhook trigger), Schedule (cron), and API
 * (copyable runWorkflow cURL). Each tab body lives in its own focused file under
 * ./triggers/. Keeps id="triggers" for scroll-spy.
 */

import { useTranslations } from "next-intl";
import * as React from "react";

import { DetailSection } from "@/components/primitives/detail-section";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type { Routine, RoutineAccess } from "../../types";
import { ApiTriggerTab } from "./triggers/api-tab";
import { EmailTriggerTab } from "./triggers/email-tab";
import { ScheduleTab } from "./triggers/schedule-tab";

export interface TriggersSectionProps {
  routine: Routine;
  access: RoutineAccess;
}

export function TriggersSection({ routine, access }: TriggersSectionProps) {
  const t = useTranslations("routines");

  return (
    <section id="triggers" className="scroll-mt-20" tabIndex={-1}>
      <DetailSection title={t("editor.sections.triggers")} defaultOpen={true}>
        <Tabs defaultValue="email">
          <TabsList>
            <TabsTrigger value="email">{t("triggers.tabs.email")}</TabsTrigger>
            <TabsTrigger value="schedule">
              {t("triggers.tabs.schedule")}
            </TabsTrigger>
            <TabsTrigger value="api">{t("triggers.tabs.api")}</TabsTrigger>
          </TabsList>
          <TabsContent value="email">
            <EmailTriggerTab routine={routine} access={access} />
          </TabsContent>
          <TabsContent value="schedule">
            <ScheduleTab routine={routine} access={access} />
          </TabsContent>
          <TabsContent value="api">
            <ApiTriggerTab routine={routine} />
          </TabsContent>
        </Tabs>
      </DetailSection>
    </section>
  );
}
```

- [ ] **Step 4: Add tab-label i18n + rename the Triggers nav label (en + de)**

In `messages/en.json`:
- Change `routines.editor.sections.triggers` (~L3756) from `"Email trigger"` to `"Triggers"`.
- Inside the `routines.triggers` object, add:
```json
      "tabs": {
        "email": "Email",
        "schedule": "Schedule",
        "api": "API"
      },
```

In `messages/de.json`:
- Change `routines.editor.sections.triggers` (~L3756) from `"E-Mail-Auslöser"` to `"Auslöser"`.
- Inside the `routines.triggers` object, add:
```json
      "tabs": {
        "email": "E-Mail",
        "schedule": "Zeitplan",
        "api": "API"
      },
```

(Leave the now-unused `routines.editor.sections.schedule` key in place — it is dropped from the nav list in Task 4, so nothing references it; removing it from the large JSON is unnecessary.)

- [ ] **Step 5: Verify — type-check, lint, JSON validity**

Run: `npx tsc --noEmit`
Run: `npm run lint`
Run: `node -e "require('./messages/en.json'); require('./messages/de.json'); console.log('json ok')"`
Expected: clean. `triggers.tsx`, `email-tab.tsx`, `schedule-tab.tsx` all resolve their imports; the workbench still compiles (unchanged `TriggersSection` props; `ScheduleSection` still exists).

- [ ] **Step 6: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add "app/(application)/workflows/[id]/sections/triggers.tsx" \
        "app/(application)/workflows/[id]/sections/triggers/email-tab.tsx" \
        "app/(application)/workflows/[id]/sections/triggers/schedule-tab.tsx" \
        messages/en.json messages/de.json
git commit -m "feat(routines): group Email/Schedule/API into a tabbed Triggers section

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Workbench reorder + fold (Queue above Access, drop standalone Schedule)

**Files:**
- Modify: `app/(application)/workflows/[id]/components/routine-workbench.tsx`
- Delete: `app/(application)/workflows/[id]/sections/schedule.tsx`

**Interfaces:**
- Consumes: the rewritten `TriggersSection` (Task 3) — same `{ routine, access }` props; `QueueSection`, `AccessSection`, `BasicsSection` unchanged.

- [ ] **Step 1: Reorder `ROUTINE_SECTION_IDS`**

In `routine-workbench.tsx`, replace the `ROUTINE_SECTION_IDS` array with:

```ts
export const ROUTINE_SECTION_IDS = [
  "basics",
  "queue",
  "access",
  "steps",
  "triggers",
  "runs",
  "danger",
] as const;
```

(`"schedule"` removed; `"queue"` moved to index 1.) Leave `DEFAULT_ROUTINE_SECTION = "basics"` unchanged.

- [ ] **Step 2: Remove the standalone Schedule import + mount**

- Delete the import line `import { ScheduleSection } from "../sections/schedule";`.
- Delete the JSX `<ScheduleSection routine={routine} access={workbench.access} />`.

- [ ] **Step 3: Move the Queue section above Access**

Move the `<QueueSection {...sectionProps} />` mount so it renders immediately after `<BasicsSection {...sectionProps} />` and before `<AccessSection {...sectionProps} />`. The section block should now read in this order:

```tsx
            <BasicsSection {...sectionProps} />
            <QueueSection {...sectionProps} />
            <AccessSection {...sectionProps} />
            <StepsSection
              routine={routine}
              stepsJson={editor.stepsJson}
              canWrite={workbench.access.canWrite}
              onOpenSheet={workbench.openStepsSheet}
            />
            <TriggersSection routine={routine} access={workbench.access} />
            <RunsSection
              routine={routine}
              onRetry={(prefill) => workbench.openRun(prefill)}
            />
            <DangerSection {...sectionProps} />
```

(`TriggersSection` mount is unchanged — it's now the grouped container.)

- [ ] **Step 4: Update the header comment's section list**

In the top-of-file JSDoc block, update the section list to match the new order/grouping:

```
 *        <BasicsSection />     (id="basics")
 *        <QueueSection />      (id="queue")
 *        <AccessSection />     (id="access")
 *        <StepsSection />      (id="steps")
 *        <TriggersSection />   (id="triggers") — Email · Schedule · API tabs
 *        <RunsSection />       (id="runs")
 *        <DangerSection />     (id="danger") — Delete (canDelete only)
```

- [ ] **Step 5: Delete the now-unused standalone schedule section**

```bash
git rm "app/(application)/workflows/[id]/sections/schedule.tsx"
```

- [ ] **Step 6: Verify — type-check, lint, build**

Run: `npx tsc --noEmit`
Expected: clean; no reference to the deleted `ScheduleSection`/`schedule.tsx` remains (grep to confirm):
```bash
rg -n "sections/schedule\"|ScheduleSection" "app/(application)/workflows"
```
Expected: no matches.
Run: `npm run lint`
Run: `npm run build`
Expected: all pass.

- [ ] **Step 7: Manual smoke (author confirms)**

On `/workflows/<id>`: sections appear in order **Basics, Queue, Access, Steps, Triggers, Runs, Danger**; the SectionNav matches and no "Schedule" nav item remains. The Triggers section shows three tabs — **Email** (identical to before), **Schedule** (identical to before), **API** (cURL with the routine's real id + variable names, copy button works, `$EXULU_TOKEN` placeholder, endpoint = `<config.backend>/graphql`). Scroll-spy highlights the right section; no console errors.

- [ ] **Step 8: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add "app/(application)/workflows/[id]/components/routine-workbench.tsx"
git rm --cached "app/(application)/workflows/[id]/sections/schedule.tsx" 2>/dev/null || true
git commit -m "feat(routines): reorder sections (queue above access) + fold schedule into Triggers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** Queue above Access → Task 4 (§1/§3). Grouped Email/Schedule/API tabs → Task 3 (container) + Task 2 (API tab). API cURL example (mirrors token-view, config.backend, `$EXULU_TOKEN`, `runWorkflow` id+vars, CodeBlock) → Task 1 (helper) + Task 2 (tab). Schedule folded / standalone removed → Task 3 (tab) + Task 4 (delete + nav). i18n label/keys → Tasks 2, 3. No backend changes → none present. Unit-testable snippet builder (spec §"Testing") → Task 1.
- **Placeholder scan:** none — every code step carries full code; lift steps give exact rename + import-depth changes + the replacement `return` blocks verbatim.
- **Type consistency:** `buildRunWorkflowCurl(routine, backend)` (Task 1) matches its call in `api-tab.tsx` (Task 2). `ApiTriggerTab({routine})`, `EmailTriggerTab({routine, access})`, `ScheduleTab({routine, access})` (Tasks 2/3) match the container's usage (Task 3). Container `TriggersSection({routine, access})` matches the unchanged workbench mount (Task 4). i18n keys used (`triggers.api.*`, `triggers.tabs.*`, `editor.sections.triggers`) are all added in Tasks 2/3.
