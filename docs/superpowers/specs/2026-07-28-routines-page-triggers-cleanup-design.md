# Routines Page Cleanup — Queue Reorder + Grouped Triggers — Design

- **Date:** 2026-07-28
- **Status:** Approved (ready for implementation plan)
- **Repo:** `exulu/frontend` (frontend-only; no backend changes)
- **Surface:** the routine detail page `/workflows/[id]` (`RoutineWorkbench` + its sections)

## Problem

Two rough edges on the routine detail page:

1. **Queue placement.** The queue is critical config (a routine cannot run
   without it), but the Queue section currently sits near the bottom
   (`[basics, access, steps, schedule, triggers, runs, queue, danger]`), below
   Runs. It should be near the top.
2. **Scattered "ways to run this routine."** Schedule and Email trigger are two
   separate sections, and there is no in-product example for triggering a
   routine via the API. These three — Email, Schedule, API — are alternative
   ways to start a routine and belong together.

## Goals

- Move the **Queue** section directly above **Access** (right after Basics).
- Group **Email**, **Schedule**, and a new **API** panel into a single
  collapsible **"Triggers"** section presented as tabs.
- The **API** tab shows a copyable cURL example for the GraphQL `runWorkflow`
  mutation, prefilled with the routine's id and variable names.

## Non-goals

- No backend changes. No GraphQL schema/type/resolver changes.
- The email trigger's fields and semantics are untouched (we keep the "email"
  framing per the earlier decision; this is layout, not a webhook
  generalization).
- No change to the Schedule editor or Email trigger form behavior — only their
  container (they move from standalone sections into tabs).

## Decisions (settled)

| Question | Decision |
| --- | --- |
| Queue position | Directly above Access (after Basics). |
| Triggers grouping | Email / Schedule / API as **tabs** inside one collapsible "Triggers" section. |
| API example format | **cURL only** — one copyable command, mutation inlined, routine id + variables prefilled, `<API_KEY>` shown as `$EXULU_TOKEN`. |
| Schedule as its own nav item | Removed — folded into the Triggers group. |

## Design

### 1. Section order — `app/(application)/workflows/[id]/components/routine-workbench.tsx`

`ROUTINE_SECTION_IDS` becomes:

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

- `"queue"` moves up to index 1 (after `"basics"`, before `"access"`).
- `"schedule"` is removed (its content moves into the Triggers tab group).
- The JSX render order in the workbench must match this list exactly (the
  scroll-spy default active id depends on it): render `<QueueSection>` before
  `<AccessSection>`, and replace the separate `<ScheduleSection>` +
  `<TriggersSection>` mounts with a single grouped `<TriggersSection>`.
- `DEFAULT_ROUTINE_SECTION` stays `"basics"`.

`QueueSection` already takes `{...sectionProps}` (from the earlier queue
feature), so only its position changes.

### 2. Grouped Triggers section — file structure

Split by responsibility so each panel is a focused file:

- `sections/triggers.tsx` — **container**. Renders a collapsible `DetailSection`
  titled with `t("editor.sections.triggers")` (defaultOpen true, matching the
  page's other sections) wrapping a shadcn `<Tabs defaultValue="email">` with a
  `TabsList` (Email · Schedule · API) and three `TabsContent` panels. Anchored
  `<section id="triggers">` for scroll-spy is preserved. Receives
  `{ routine, editor, workbench }` (`RoutineSectionProps`); passes each panel
  what it needs.
- `sections/triggers/email-tab.tsx` — the **current email-trigger form body**
  lifted out of today's `triggers.tsx`, with its outer `DetailSection` wrapper
  removed (the container provides the section). Same GraphQL ops
  (`GET_WORKFLOW_TRIGGERS`, `UPSERT_WORKFLOW_EMAIL_TRIGGER`,
  `DELETE_WORKFLOW_TRIGGER`, `TEST_FIRE_WORKFLOW_TRIGGER`), same `trigger-config`
  helpers, same behavior. Takes `{ routine, access }`.
- `sections/triggers/schedule-tab.tsx` — the **current schedule body** lifted
  out of today's `schedule.tsx`, `DetailSection` wrapper removed. Same
  `GET_WORKFLOW_SCHEDULE` / `UPSERT_WORKFLOW_SCHEDULE` /
  `DELETE_WORKFLOW_SCHEDULE` + `ScheduleEditor`. Takes `{ routine, access }`.
- `sections/triggers/api-tab.tsx` — **new** (see §3). Takes `{ routine }`.

Today's standalone `sections/schedule.tsx` is removed (its body moves to
`schedule-tab.tsx`). Today's `sections/triggers.tsx` is rewritten as the
container; its email body moves to `email-tab.tsx`.

Tabs use the existing `components/ui/tabs.tsx` primitive.

### 3. API tab — `sections/triggers/api-tab.tsx`

Mirrors the existing `app/(application)/token/components/token-view.tsx` snippet
pattern. Reads the GraphQL endpoint from `ConfigContext.backend` (the same base
the app's Apollo client uses in `authenticated.tsx`; fall back to an empty base
so the command still renders). Builds a cURL string:

```ts
const backend = config?.backend || "";
const varsObject = Object.fromEntries(
  (routine.variables ?? []).map((name) => [name, "..."]),
);
const snippet = [
  `curl -X POST ${backend}/graphql \\`,
  `  -H "Authorization: Bearer $EXULU_TOKEN" \\`,
  `  -H "Content-Type: application/json" \\`,
  `  -d '${JSON.stringify({
    query:
      'mutation($variables: JSON) { runWorkflow(id: "' +
      routine.id +
      '", variables: $variables) { job } }',
    variables: { variables: varsObject },
  })}'`,
].join("\n");
```

Rendered with `CodeBlock` + `CodeBlockCopyButton` from
`components/ai-elements/code-block.tsx`. Above it, a one-line description and a
hint: *"Trigger this routine from anywhere with a personal API token"* linking to
`/token` (where `$EXULU_TOKEN` is issued). All strings via i18n.

### 4. i18n — `messages/en.json` + `messages/de.json`

- `routines.editor.sections.triggers`: `"Email trigger"` → **"Triggers"** (en);
  the DE equivalent likewise (e.g. `"E-Mail-Auslöser"` → `"Auslöser"`).
- Add `routines.triggers.tabs.email` / `.schedule` / `.api` (tab labels).
- Add `routines.triggers.api.description`, `routines.triggers.api.tokenHint`,
  `routines.triggers.api.tokenLink`, and a copy-button label
  (`routines.triggers.api.copy`).
- Existing `routines.triggers.*` (email) and `routines.schedule.*` keys are
  reused inside their tabs.
- `routines.editor.sections.schedule` is no longer referenced (schedule is a tab,
  not a nav section); leave the key or remove it — either is fine, but do not
  reference it from the nav.

### 5. Scroll-spy / nav

`SectionNav` renders one entry per id in `ROUTINE_SECTION_IDS` via
`t(\`editor.sections.${id}\`)`. With `"schedule"` removed and `"queue"`
repositioned, the nav updates automatically. Confirm the `"triggers"` label now
reads "Triggers" and the section still has `id="triggers"` so the anchor
resolves.

## Testing / verification

- The frontend has helper-level vitest but no component-test infra for these
  sections; verification is `npx tsc --noEmit` + `npm run lint` + `npm run build`
  + manual smoke:
  - Sections render in order: Basics, Queue, Access, Steps, Triggers, Runs,
    Danger; nav matches.
  - Triggers section shows three tabs; Email and Schedule behave exactly as
    before; API tab shows the cURL with the routine's real id + variable names
    and copies to clipboard.
  - No console errors; scroll-spy highlights the right section.
- If any pure helper is extracted (e.g. a `buildRunWorkflowCurl(routine, backend)`
  function), give it a vitest unit test (id/variables prefill, empty-variables
  case). Recommended: extract the snippet builder so it is unit-testable.

## Sequencing

1. Extract the email + schedule bodies into tab panels; add the API tab; build
   the Triggers container. (No behavior change to email/schedule.)
2. Reorder `ROUTINE_SECTION_IDS` + the workbench JSX (Queue above Access; single
   Triggers group; drop standalone Schedule).
3. i18n updates (en + de).
4. Verify (tsc/lint/build + manual smoke).
