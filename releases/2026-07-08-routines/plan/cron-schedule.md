# Feature plan — Cron scheduling with presets

Part of `releases/2026-07-08-routines/` (the /workflows → routines redesign).

## Sources of truth

- Design doc: `frontend/design/pages/workflows.md` — ladder items 22 (current
  schedule + next run + delete), 23 (cron presets), 24 (custom cron + validation
  + cheat sheet); UX issue #13 (prefill round-trip: "editing" must not mean
  retyping)
- Frontend commits: `58e5010` (redesign /workflows per workflows.md 2.12 —
  introduces `ScheduleEditor` + `cron-presets.ts`), `9e63d8e` (promotes the
  routine panel to the `/workflows/[id]` subpage; `ScheduleSection` with
  `defaultOpen=true`)
- UI code: `frontend/app/(application)/workflows/components/schedule-editor.tsx`
  (two-tab editor), `frontend/app/(application)/workflows/[id]/sections/schedule.tsx`
  (section wrapper, next-run line, Save/Remove), `frontend/app/(application)/workflows/cron-presets.ts`
  (`CRON_PRESETS` + `matchPreset` prefill), `components/primitives/detail-section.tsx`,
  `components/primitives/relative-time.tsx`
- On-screen copy: `frontend/messages/en.json` → `routines.schedule.*` (verbatim
  below). Preset labels/descriptions live in code, not i18n
  (`cron-presets.ts`, deliberate — reproduced verbatim below).
- GraphQL: `GET_WORKFLOW_SCHEDULE` / `UPSERT_WORKFLOW_SCHEDULE` /
  `DELETE_WORKFLOW_SCHEDULE` in `frontend/app/(application)/workflows/queries.ts`;
  backend resolvers in `backend/src/graphql/schemas/index.ts`

## What shipped

Every routine's `/workflows/[id]` workbench has a **Schedule** section
(open by default, cron chip in the header):

- **Next run line** — server-computed (`workflowSchedule.next`), rendered as
  "Next run" + a relative `<time>` ("in 7 hours") above the editor. Updates
  after Save (refetch), not while picking.
- **Two-tab ScheduleEditor** — **Presets** tab: a Select of 7 presets, each
  with a label + one-line description; picking one immediately echoes the
  resulting cron expression in a muted box beneath ("CRON expression" +
  `font-mono` code). **Custom CRON** tab: free-text input with live
  `cron-validator` feedback (inline error, destructive border) and a
  collapsible "Format help" cheat sheet.
- **Prefill round-trip** — `matchPreset()` on mount: a saved cron that matches
  a preset opens the Presets tab pre-selected; anything else opens Custom with
  the value filled in. Tab switches preserve the last value per mode.
- **Save/Update + Remove** — wired to `upsertWorkflowSchedule` /
  `deleteWorkflowSchedule`; button label swaps Save schedule → Update schedule
  when a schedule exists; Remove sits behind the shared ConfirmDialog.

Before: scheduling lived in a per-row dialog on the list page that did not
prefill the existing cron — editing meant retyping. Now it is a first-class
section on the routine's own page, prefilled, validated inline.

## Hook

**Agents that work while you sleep.**

## Surface area

UI feature (Schedule section + ScheduleEditor) + a real developer surface
(schedule GraphQL API: one upsert mutation, one query that returns the
server-computed next run). One short on picking a preset; Custom-tab
validation, cheat sheet, prefill mechanics and Remove flow are page prose
within this feature's section.

## Short — `cron-schedule` (1920×1080, 9.5s)

One slice, ONE user action: pick **"Weekdays at 09:00"** from the Presets
dropdown → the CRON expression echo updates beneath and "Update schedule"
enables.

Scenario: a routine that ALREADY has a saved schedule (`0 0 * * *`, "Every day
at 00:00"). This is the honest way to have both the expression echo and the
next-run line on screen: the echo reacts to the pick instantly; the "Next run"
line belongs to the saved schedule (it only updates after Save — see
Deviations).

### Demo arc (timed beats)

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.40 | Hook enters: pill "Routines" (#E2EBFF bg / #1E69DC text), H1 "Agents that work **while you sleep**." (em words #7033FF) — no sub-line | Entrance |
| 0.40–1.90 | Hook holds static (1.5s) | ≥1.4s floor for 6-word line |
| 1.90–2.35 | Hook crossfades out, Schedule section card fades in (rest state below: header chip `0 0 * * *`, "Next run in 7 hours", Presets tab active, Select shows "Every day at 00:00", echo box `0 0 * * *`, disabled "Update schedule" + "Remove schedule") | Pivot |
| 2.35–2.90 | Cursor glides to the Select trigger | Approach |
| 2.90–3.15 | Click → dropdown opens (popover, ~150ms zoom-in, shadow-md); all 7 presets listed, check mark on "Every day at 00:00" | Open |
| 3.15–4.10 | Dropdown holds while the cursor glides down; last ~350ms hovering "Weekdays at 09:00" (row bg #E2EBFF, label #1E69DC) | Read + target |
| 4.10–4.35 | Click item → dropdown closes; trigger now "Weekdays at 09:00"; echo code swaps to `0 9 * * 1-5`; "Update schedule" enables (full #7033FF) | The one action lands |
| 4.35–5.15 | New state holds completely still (800ms) | ≥600ms post-action hold |
| 5.15–5.50 | Soft highlight sweep (#E2EBFF wash) enters over the echo box ("CRON expression" + `0 9 * * 1-5`) | Point at the payoff element |
| 5.50–7.00 | Highlight holds, everything else still (1.5s) | Read floor for label + code |
| 7.00–7.30 | Highlight fades out | Clear stage |
| 7.30–7.70 | Payoff caption enters (lower third): "Pick a preset — no cron syntax required." | Entrance |
| 7.70–9.50 | Payoff holds still (1.8s); last 600ms completely still = loop resting frame | ≥1.8s floor + clean loop |

### Reconstruction cues (build the real UI, verbatim)

**Framing.** Real surface is the `/workflows/[id]` workbench column
(`mx-auto max-w-3xl space-y-12`, `routine-workbench.tsx:178`). For the short,
render the Schedule section as a centered card ~1120px wide on the #FDFDFD
canvas with the house radial purple wash (matches the 07-07/07-08 shorts);
inner content column ~680px centered in the card (~48px padding) to mirror the
real max-w-3xl column. Inter, tracking -0.025em; cron strings in
JetBrains Mono. Border #E7E7EE, radius ~6px, subtle shadow.

**Section header** (`DetailSection`, collapsible, open):

- Chevron-down icon (16px, muted #525252, pointing down = open) + h3
  **"Schedule"** (`text-sm font-medium`) + meta chip: `0 0 * * *`
  (`font-mono text-xs`, muted #525252) — the saved cron, from
  `routines.schedule.title` + the `meta` code element in `schedule.tsx`.

**Section body** (`space-y-3`, top to bottom — this exact order; the next-run
line sits ABOVE the editor, not under the dropdown):

1. Next-run line: **"Next run"** + relative time **"in 7 hours"**
   (`text-xs text-muted-foreground`, one line: "Next run in 7 hours").
   `RelativeTime` output uses Intl.RelativeTimeFormat — "in 7 hours", no "at".
2. Tabs (`space-y-3`): TabsList = full-width 2-col grid, h-40px, bg #F5F5F5,
   rounded ~6px, 4px padding. Active trigger **"Presets"** (bg #FDFDFD,
   `shadow-sm`, text #000); inactive trigger **"Custom CRON"** (muted
   #525252). `text-sm font-medium`, centered.
3. Label **"Select a preset"** (`text-sm font-medium`).
4. Select trigger: h-40px, full-width, border #E7E7EE, rounded ~6px, px-12px,
   `text-sm`, chevron-down right (16px, 50% opacity). Closed trigger shows the
   selected preset LABEL only, single line ("Every day at 00:00" → after the
   pick "Weekdays at 09:00"); the description is line-clamped away.
5. Expression echo box (`rounded-md bg-muted p-2` → bg #F5F5F5, ~6px radius,
   8px padding): line 1 **"CRON expression"** (`text-xs`, muted #525252);
   line 2 the cron in JetBrains Mono `text-sm`, #000: `0 0 * * *` at rest →
   **`0 9 * * 1-5`** after the pick.
6. Button row (`flex gap-2`): primary Button **"Update schedule"** (#7033FF
   bg, white text, rounded ~6px, h-40px) — DISABLED at rest (50% opacity;
   nothing pending yet), enables to full purple when the pick lands. Outline
   Button **"Remove schedule"** (border #E7E7EE, bg transparent, black text)
   with a Trash2 icon (16px) left of the label — present throughout (a
   schedule exists).

**Dropdown (SelectContent)** — popover bg #FCFCFC, border #E7E7EE, rounded
~6px, shadow-md, width = trigger width, opens below with 4px offset. 7 items,
each `py-1.5 pl-8 pr-2`: label (`text-sm font-medium`, #000) over description
(`text-xs`, muted #525252). Check icon (16px) in the left gutter of the
selected item only. Verbatim, in this order (from `CRON_PRESETS`):

1. **"Every day at 00:00"** — "Runs once daily at midnight" ← check mark here at open
2. **"Every hour"** — "Runs at the start of every hour"
3. **"Weekdays at 09:00"** — "Monday to Friday at 9 AM" ← the pick
4. **"Every 15 minutes"** — "Runs 4 times per hour"
5. **"Every 30 minutes"** — "Runs twice per hour"
6. **"Weekly on Sunday 00:00"** — "Every Sunday at midnight"
7. **"Monthly on 1st at 09:00"** — "First day of month at 9 AM"

Hover state on the target item: bg #E2EBFF (accent), label text #1E69DC
(accent-foreground); description keeps muted #525252.

**Motion.** Cursor + motion conventions identical to the 07-07 shorts:
power2.out, 150–350ms, no bounce, no glow. Dropdown open/close ~150ms
fade+zoom (Radix default). The echo-code swap is an instant text change (no
per-character animation) — it is a React re-render in the real product.

## Code snippet decision

**Yes — GraphQL.** Scheduling is a real API surface: one mutation upserts the
cron, one query returns the schedule plus the server-computed next run. Both
operations are the editor's own, from
`frontend/app/(application)/workflows/queries.ts` (query trimmed to the
fields that matter):

Anchor line: "Schedules are a first-class API — one mutation to set, one query
for the server-computed next run:"

```graphql
mutation UpsertWorkflowSchedule($workflow: ID!, $schedule: String!) {
  upsertWorkflowSchedule(workflow: $workflow, schedule: $schedule) {
    status
  }
}

query GetWorkflowSchedule($workflow: ID!) {
  workflowSchedule(workflow: $workflow) {
    schedule
    next
  }
}
```

(12 lines, real operation/field names; `next` is the ISO timestamp of the next
scheduled run.)

## Page prose within this feature's section (beyond the video)

- **Prefill round-trip** (workflows.md UX #13): editing never means retyping.
  `matchPreset()` normalizes whitespace and matches the saved cron against the
  presets — a match opens the Presets tab pre-selected; anything else (incl.
  alternate forms like `0 0 * * SUN`) opens the Custom tab with the value
  filled in, by design. Tab switches preserve the last value per mode.
- **Custom CRON tab**: free-text input (placeholder `0 12 * * *`) validated
  live with `cron-validator`; invalid input shows the inline error **"Invalid
  CRON expression. Format: minute hour day month weekday"** with a destructive
  border (#E54B50) — and never propagates upstream. A quiet **"Format help"**
  disclosure expands a cheat sheet: format line **"minute hour day month
  weekday"** plus ranges — "minute: 0–59", "hour: 0–23", "day: 1–31",
  "month: 1–12", "weekday: 0–7 (0 and 7 are Sunday)".
- **Next run is server truth**: `workflowSchedule.next` is computed by the
  backend and refetched after save — the UI never guesses the next fire time.
- **Remove** sits behind the shared ConfirmDialog: **"Remove schedule?"** —
  "Remove the cron schedule for "{name}". The routine stays — only the
  automatic schedule is removed." Confirm label **"Remove"**. (Use a neutral
  routine name like 'Quarterly report' if illustrated.)
- Save button label is state-aware: **"Save schedule"** (new) /
  **"Update schedule"** (existing) / **"Saving…"**; success toasts
  **"Schedule saved"** / **"Schedule removed"**.

## Deviations from the brief (reality wins)

1. **No "weekly Monday morning" preset exists.** The 7 presets are fixed
   (list above); the closest morning preset is **"Weekdays at 09:00"**
   (`0 9 * * 1-5`) — the short uses that.
2. **The next-run line does not appear/update when a preset is picked.** It
   renders ABOVE the editor (not beneath the dropdown) and comes from
   `workflowSchedule.next` — it exists only for a SAVED schedule and updates
   after Save + refetch. The short therefore uses the edit scenario (saved
   daily schedule) so "Next run in 7 hours" is honestly on screen the whole
   time, while the pick's immediate feedback is the expression echo + the
   enabling "Update schedule" button.
