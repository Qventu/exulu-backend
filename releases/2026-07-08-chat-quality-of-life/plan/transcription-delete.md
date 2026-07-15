# Feature plan — Saved-transcription deletion (with optional knowledge-item cascade)

## Sources of truth

- Spec: `frontend/docs/superpowers/specs/2026-07-07-delete-saved-transcription-entries-design.md` (commit `45f7cf9`)
- Code (commits `2d2d5e4`, `b2397cc`, 07-07):
  - `frontend/app/(application)/transcriptions/components/job-row.tsx`
    (trash button lines 267–276; ConfirmDialog wiring 316–328; cascade order:
    KB item first, then the job — each failure keeps the dialog open)
  - `frontend/app/(application)/transcriptions/queries.ts:102`
    `RemoveSavedTranscriptItem` → `transcriptions_itemsRemoveOneById`; `:88`
    `REMOVE_TRANSCRIPTION_JOB` → `transcription_jobsRemoveOneById`
  - `frontend/components/primitives/confirm-dialog.tsx` (the single
    destructive-confirm primitive; `options` = cascade checkboxes)
- On-screen copy: `frontend/messages/en.json` → `transcriptions.row.*`,
  `transcriptions.confirmDelete.*`, `transcriptions.toasts.*` (verbatim below)

## What shipped

Saved rows on the `/transcriptions` page finally have a delete. A third
right-aligned action (ghost trash icon) opens the shared ConfirmDialog with a
per-delete choice: remove just the entry, or also cascade-delete the saved
transcript from the knowledge base (checkbox, unchecked by default, only shown
when a linked KB item exists). On failure the dialog stays open for retry;
success toasts "Transcription entry deleted" and the row leaves the Saved group.
No backend changes — both mutations already existed.

## Hook

**Delete the entry, keep the transcript — or cascade. Your call, per delete.**

## Surface area

UI feature (`/transcriptions` page). Recipe E flavor (data-deletion needs
gravitas): calm motion, `power2.out`, no bounce — plus Recipe A screen
reconstruction.

## Reconstruction cues (verbatim from the shipped code)

- **Saved row** (list item, light card row with border): left — file-type icon
  (FileAudio, muted box), name e.g. `Customer discovery call.m4a`
  (font-medium text-sm), status line `text-xs text-muted-foreground`:
  `Saved` (+ `Updated` timestamp). Right — actions
  `flex shrink-0 items-center gap-2`:
  1. ghost sm **`Open in library`** + ExternalLink icon `size-3.5`
  2. outline sm **`Edit`**
  3. ghost icon-only trash: Trash2 `size-4`, classes
     `text-muted-foreground hover:text-destructive md:w-8 md:px-0`,
     aria-label **`Delete`**
- **ConfirmDialog** (AlertDialog, centered, dimmed backdrop):
  - Title: **`Delete saved transcription?`**
  - Description: **`This removes the entry from this page. The saved transcript
    stays in the knowledge base unless you also select it below.`**
  - Cascade checkbox row (shadcn Checkbox + label):
    **`Also delete the saved transcript from the knowledge base`**
  - Footer: outline **`Cancel`** + destructive **`Delete`** (red #E54B50,
    white text; Loader2 spinner while pending)
- Toasts: success **`Transcription entry deleted`**; failure
  **`Couldn't delete the entry`**.

## Short D — `transcription-delete-cascade` (1920×1080, 9.4s)

One slice: the trash click; the reactive change is the dialog with the cascade
checkbox. We do NOT also click Delete — that would be a second action.

| t (s) | What's on screen | Why |
|---|---|---|
| 0.0–0.4 | Hook enters: **"Saved transcriptions, now deletable"** | Entrance |
| 0.4–1.9 | Hook holds still (1.5s) | ≥1.4s floor (4 words) |
| 1.9–2.3 | Hook exits; the Saved row crossfades in (page context: a "Saved" group header above the row is enough) | Pivot |
| 2.3–2.9 | Row sits still | Establish (0.6s) |
| 2.9–3.7 | Cursor glides to the trash icon; icon tints destructive on hover | Approach |
| 3.7–4.0 | Click → backdrop dims, ConfirmDialog fades/scales in (measured, power2.out) | The action |
| 4.0–4.7 | Dialog holds completely still (0.7s) | Breath after action |
| 4.7–6.4 | Single soft highlight sweep across the checkbox row (background tint fade in/out); nothing else moves — viewer reads the description + checkbox | The differentiator; ~1.7s read window |
| 6.4–6.8 | Payoff enters (upper area): **"Remove the entry — the knowledge item is your call."** | Entrance |
| 6.8–8.8 | Payoff holds still (2.0s) | ≥1.8s floor (full sentence) |
| 8.8–9.4 | Resting frame — fully still (0.6s) | Clean loop |

Note: checkbox stays **unchecked** (the shipped default). No bouncy motion —
this is a data-deletion surface; it must feel measured and trustworthy.

## Prose for the page section (beyond the video)

- Cascade order is safe: the KB item is deleted first; if that fails the dialog
  stays open with an error toast and you can still delete just the entry.
- The checkbox only appears when a linked knowledge item exists.
- Row-level only, by design — no delete inside the ReviewSheet, no bulk delete.

## Code snippet decision

**No snippet.** Pure UI composition of existing primitives; the spec's non-goal
is explicit: "No backend changes — both mutations already exist." The
`RemoveSavedTranscriptItem` operation lives in the route-local
`app/(application)/transcriptions/queries.ts`, not the sanctioned
`frontend/queries/queries.ts` snippet source, and the underlying generated CRUD
mutation is not new.
