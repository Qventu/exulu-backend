# Transcripts stage 3: admin settings and summaries for every source — Design

**Date:** 2026-09-30
**Status:** Drafted (pending user review)
**Branch:** `feat/transcripts-settings` (worktree `../backend-transcripts-settings`, off `develop` a15abca).
A frontend worktree on the same branch name is created when implementation starts.
**Related:**
- `docs/superpowers/specs/2026-09-29-transcripts-redesign-design.md` — stages 1–2, now merged
- `docs/superpowers/specs/2026-09-30-context-embedder-settings-design.md` — the embedder picker this page reuses
- Designer deliverable: `Projects/exulu/redesigns/Transcripts Redesign.pdf`, artboard 5 ("Transcript settings")
- Developer handoff: `Projects/exulu/redesigns/Transcripts redesign — developer handoff.md`, stage 3
- `src/exulu/entities/config.ts` and `src/exulu/embedder-settings.ts` — the two existing code-default / DB-override implementations this generalises

## Summary

Stage 3 of the Transcripts redesign. Two halves:

1. **An admin settings page** at `/transcriptions/settings` — sources and their status, meeting-bot defaults,
   defaults for new transcripts, the knowledge base and its agents, and meeting-video retention. Most of
   what it configures lives in environment variables today and cannot change without a deploy.
2. **Summaries for every source** — the upload pipeline gains the post-processing that meeting bots and
   live recordings already have.

Record mode, the third item in the handoff's stage 3, shipped in September and was re-housed into the
composer dialog during stage 1. Nothing further is needed for it.

**Reuse first.** The settings store is `platform_configurations`, as with entity models and embedders.
The embedder picker is the widget promoted in the embedder work. Upload post-processing reuses
`recallService.runPostProcessing` verbatim — the same runner, the same atomic claim, the same
idempotence — rather than growing a second implementation. **No new tables.**

## Decisions (from brainstorming, 2026-09-30)

| Topic | Decision |
|---|---|
| Env vars | **Stored value overrides env, env overrides the code default**, with a `source` discriminator shown in the UI. Existing deployments keep working untouched until an admin edits something. Rejected: making the DB the only source (silently ignoring an env var after upgrade will confuse whoever deploys it) and leaving env read-only (does not deliver the design's point). |
| Automatic summaries | **On by default for every new transcript from every source, switchable off per transcript** in the composer's options row. Accepted cost: an upload now triggers LLM calls whether or not anyone reads the summary. |
| Settings storage shape | **One key**, `transcripts_settings`, holding a JSON object — not one key per value. |
| Precedence helper | Extract **one** generic resolver and use it here. Do **not** retrofit entity models or embedders in this spec. |
| Admin gate | `super_admin`, matching the embedder mutation and the destructive mutations at `src/graphql/mutations/index.ts:909,951`. |
| Recall cost rate | Ships as a **configurable setting**, not a hardcoded constant, so the cost estimate works the day the number arrives instead of blocking the stage. |

## 1. The settings store

`platform_configurations`, one row, `config_key = "transcripts_settings"`, `config_value` a JSON object:

```ts
export type TranscriptsSettings = {
  botName: string | null;
  notifyChat: boolean | null;
  recordersMayOverrideBot: boolean | null;
  defaultRightsMode: ExuluRightsMode | null;
  summaryPresets: { prompt_id: string; agent_id: string }[] | null;
  videoRetentionHours: number | "forever" | null;
  storeVideoLocally: boolean | null;
  monthlyRecordingLimitMinutes: number | "none" | null;
  videoStorageCostPerHour: number | null;  // the Recall contract rate
};
```

**Why one key rather than nine.** These values are edited together on one page and read together on
every composer open. A single row makes a save atomic and a read one query, where nine keys would give
nine round-trips and nine ways to be half-applied. That deliberately departs from the one-key-per-value
shape used by entity models and embedders, which are single values with unrelated lifecycles.

Every field is nullable and **null means exactly one thing: "not set here"** — the resolver then falls
through to env, then to the code default. Clearing a field in the UI writes null, restoring the env/code
value; it does not write the resolved value back, which would freeze today's env into the database
invisibly.

That is why two fields carry a string sentinel rather than reusing null for a real value:
`videoRetentionHours: "forever"` and `monthlyRecordingLimitMinutes: "none"` are deliberate admin
choices, and they must be distinguishable from "no opinion, use the env var". Collapsing either onto
null would make an admin's explicit "keep videos forever" silently revert to the 90-day env default —
the same class of bug as an empty string overriding a fallback.

## 2. The precedence resolver

This is the third code-default / DB-override / effective-value implementation in the codebase
(`entities/config.ts`, `embedder-settings.ts`, and now this). Rather than hand-roll a third copy that
drifts, extract one small generic helper in `src/exulu/platform-setting.ts`:

```ts
export type SettingSource = "database" | "env" | "code";
export interface ResolvedSetting<T> {
  value: T;
  source: SettingSource;
}
export function resolveSetting<T>(
  stored: T | null | undefined,
  envValue: T | null | undefined,
  codeDefault: T,
): ResolvedSetting<T>;
```

Pure, trivially testable, no database access of its own — the caller supplies the three candidates. The
settings service reads the row once and resolves each field through it.

**Not in scope:** retrofitting `entities/config.ts` or `embedder-settings.ts` onto this helper. They
work, they are covered by tests, and rewriting them here would be unrelated churn in two files this
stage otherwise never touches. The helper exists so the *next* one does not become a fourth copy.

## 3. What each setting overrides

| Setting | Env var it overrides | Code default today |
|---|---|---|
| `botName` | — (none exists) | `DEFAULT_BOT_NAME` in `recall/service.ts:39`, currently `"Company Notetaker"` — **becomes `"IMP Notetaker"`** |
| `notifyChat` | — | the per-request default in `meetingBotStart` |
| `videoRetentionHours` | `RECALL_RECORDING_RETENTION_HOURS` | `RECALL_RECORDING_RETENTION_DEFAULT_HOURS` (2160) |
| `storeVideoLocally` | `RECALL_STORE_VIDEO_LOCALLY` | false |
| `monthlyRecordingLimitMinutes` | `TOTAL_MAX_RECORDINGS_DURATION_PER_MONTH` | none (no cap) |
| `defaultRightsMode` | — | `"private"` |
| `summaryPresets` | — | `[]` |
| `videoStorageCostPerHour` | — | none (estimate hidden until set) |

`recordersMayOverrideBot` is new and governs the UI only: when false, the meeting composer hides its bot-name
and notice fields and the workspace values are used.

The four functions in `src/exulu/recall/env.ts` that read these env vars become the **env layer** of the
resolver rather than the source of truth. Their signatures do not change; a settings-aware wrapper calls
them. That keeps every existing caller working and confines the change to one file.

## 4. Summaries for every source

The only pipeline change in this stage, and it closes a real gap: `transcriptionJobStart` accepts no
post-processing prompts, and the whisper polling loop never calls the runner, so an uploaded file can
never produce a summary. Meetings and live recordings both already do.

- `TranscriptionJobStartInput` gains `post_processing_prompts: [PostProcessingPromptInput!]`, the exact
  input type the meeting and live-recording mutations already use.
- `StartJobInput` and `transcriptionService.startJob` persist it to the existing
  `transcription_jobs.post_processing_prompts` column. No schema change — the column is already there.
- In `_applyJobUpdate`, where a completed whisper job is set to `awaiting_review`
  (`src/exulu/transcription/service.ts:261`), fire `recallService.runPostProcessing(id)` the same way
  `liveRecordingService.stop` does at `live-recording.ts:181` — `void`-ed with a `.catch` so a failing
  summary never blocks the transcript becoming reviewable.

`runPostProcessing` already no-ops when a row has no prompts, already claims the batch atomically before
spending, and already refuses to double-run. Nothing about it changes.

**Seeding from workspace presets.** All three composers pre-check the workspace `summaryPresets` in their
post-processing picker, and the user may uncheck them for one recording. The presets are read when the
composer opens, not stamped onto the job at save time, so changing the workspace default does not
retroactively alter transcripts already in flight.

## 5. The page

`/transcriptions/settings` — a static segment, so it wins over `[itemId]` exactly as `review` does.
Admin-gated on `super_admin`; a non-admin reaching it sees a plain "Ask an admin" state rather than a
404, because the nav entry is reachable from the Transcripts header's "…" menu.

Five collapsible sections, one open at a time, each with a one-line summary of its current values. A
section whose state needs attention shows its summary in amber and opens first.

| Section | Contents |
|---|---|
| Sources | Upload (Whisper), Meeting bot (Recall.ai), Record here (chat transcription model): status from `/config`, a **Test** action per source, and the transcriptions context's embedder picker |
| Meeting bot | Bot name, recording-notice switch, whether recorders may override them |
| Defaults for new transcripts | Default sharing, summary presets that run automatically |
| Knowledge base and agents | Agents whose retrieval config includes `transcriptions` and what they may do, plus a link into Knowledge |
| Meeting video | Retention (7 / 30 / 90 days / forever), hours stored, and the cost estimate once a rate is set |

Right column: the existing monthly recording-time card (`meetingRecordingUsage`) only.

**The embedder picker is a reuse, not a rebuild.** The `StageEmbedder` widget promoted in the embedder
work renders here against the `transcriptions` context. That is also the fix path for "Ask about this
transcript": the Sources section is where an admin discovers the context is unconfigured.

**Test actions** are the one other piece of new backend surface: a per-source reachability check
(`GET /transcription-sources/:source/test`) that pings the configured service and returns ok / an
actionable error. Whisper and Recall each have a client already; "Record here" resolves its model through
the LiteLLM catalogue. This is deliberately a liveness check, not a full round-trip — it answers "is this
configured and reachable", which is what an admin looking at a red dot needs.

## 6. Error handling

- **Settings read fails** → log and fall through to env/code, exactly as the embedder settings do. An
  unreadable row must never stop a composer opening or a bot joining.
- **A stored preset references a deleted prompt or agent** → the composer skips it with a warning rather
  than failing to open, and the settings page marks it "no longer available" so an admin can remove it.
  This is reachable: prompts and agents are deleted independently of this page.
- **A Test action fails** → the section shows the service's own message, not a generic failure. That
  message is the whole value of the button.
- **Upload post-processing fails** → unchanged from today's behaviour for meetings: the failure is
  recorded on the job's outputs and surfaces as a re-runnable card in review. The transcript still saves.
- **Two admins save concurrently** → last write wins on the single row. The page re-reads after save, so
  the loser sees the winner's values rather than silently keeping stale ones on screen.

## 7. Testing

Backend (jest), on the pure and near-pure pieces:
- `resolveSetting` across all three layers, including a stored `false`/`0` beating an env value (the
  classic falsy-override bug this helper exists to get right once).
- The settings service's per-field resolution and the null-clears-to-fallback rule.
- `startJob` persisting prompts, and `_applyJobUpdate` firing the runner exactly once on completion and
  never on `running`/`failed`/`cancelled`.
- That a settings read failure degrades to env/code rather than throwing.

Frontend (vitest, node-only): the section-summary derivation as a pure function. The page is verified by
hand.

**Manual verification required:** set a bot name and confirm a newly dispatched bot uses it; upload a
file with a preset attached and confirm the summary appears in review; unset a value and confirm the env
value returns with `source: "env"` shown.

## 8. Out of scope

Per-person and per-project usage breakdown; the "Never reviewed" card; the monthly-cap **editor** (the
cap remains a setting, but the breakdown UI is stage 4) — all stage 4, even though the mockup places them
on this page. Also stage 4: speaker suggestions and merge, the People filter, unreviewed reminders,
highlight actions, interactive action-item checkboxes, the project vocabulary list, and calendar
scheduling, which has no design.

Not in this spec: retrofitting the two existing override implementations onto the new helper; changing
the transcription engines, diarization, or the Recall integration itself; and the four gaps recorded in
the stage 1–2 page doc, which remain open follow-ups.
