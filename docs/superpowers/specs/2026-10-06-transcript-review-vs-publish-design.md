# Separating "reviewed" from "published to the knowledge base" — Design

**Date:** 2026-10-06
**Status:** Drafted (pending review)
**Related:**
- `docs/superpowers/specs/2026-09-29-transcripts-redesign-design.md` — stages 1–2
- `docs/superpowers/specs/2026-09-30-transcripts-settings-design.md` — stage 3
- `src/exulu/transcription/service.ts` — `finalize`, `cancelJob`, `JobStatus`
- `src/exulu/transcription/export-route.ts` — the item-keyed export endpoint

## Summary

Reviewing a transcript and putting it in the knowledge base are currently the
same action. They should be two.

A reviewer who wants to confirm a transcript is correct and export it to Word,
without making it searchable by every agent with access, cannot do that today.
The only way out of "needs review" is to publish.

This separates the two, with no change to what either action does on its own.

## What happens today

`finalize` (`service.ts:359`) is the only transition out of `awaiting_review`
short of cancelling, and it does three things at once:

1. renders the corrected transcript into `transcript_text`,
2. **creates the `transcriptions` context item** — the knowledge-base entry —
   and applies the job's RBAC and project linkage to it,
3. sets `status: "saved"` and records `saved_item_id`.

Two consequences that are easy to miss:

- **Export requires publication.** The endpoint is
  `GET /transcription-items/:itemId/export` (`export-route.ts:25`). No item
  means no export, so "check it, export it, don't publish it" is not
  expressible.
- **Sharing only exists on the item.** `target_rights_mode` /
  `target_rbac_users` / `target_rbac_roles` sit on the job as *intent*; they
  become real RBAC when the item is created. An unpublished transcript is
  therefore creator-only no matter what those fields say.

The frontend derives its tabs from status alone: `awaiting_review` maps to
`needs_review` (`types.ts:562`), and the list drops jobs whose status is
`saved` or `cancelled` because the item represents them instead
(`types.ts:607`).

## The two axes

| | not published | published |
|---|---|---|
| **needs review** | today's draft | — (not reachable, and shouldn't be) |
| **reviewed** | **new** | today's `saved` |

Publishing without reviewing stays impossible on purpose: publishing is what
writes the corrected text, so it implies the reviewer has signed off.

## Decisions

| Topic | Decision |
|---|---|
| Representing review | A new `reviewed_at` timestamp, plus a new `reviewed` value in `JobStatus`. Publication stays observable through the existing `saved_item_id`. |
| Why not a boolean | A timestamp answers "when", costs the same, and reads naturally in the UI ("reviewed yesterday"). |
| Why not derive review from status alone | The two axes are independent; a single linear status cannot express "reviewed, not published" without a combinatorial status list. |
| Publishing from `awaiting_review` | **Stays.** Today's one-step review-and-publish is the common path and should not grow a second click. |
| Export | Gains a job-keyed route so a reviewed transcript can be exported before (or without) publication. |
| Sharing on an unpublished transcript | Stays intent-only, and the UI says so. Making RBAC real without an item would mean a second permission surface for the same object. |
| Unpublishing | Still out of scope — see "Out of scope". |

## Data model

One new column on `transcription_jobs`:

```ts
{ name: "reviewed_at", type: "date", required: false }
```

Added to the schema in `src/postgres/core-schema.ts`; context tables
auto-migrate through `addMissingFields`, so no hand-written migration block is
needed (see the stage 1–2 spec's note on `contextDatabases`).

`JobStatus` gains one value:

```ts
export type JobStatus =
  | "queued" | "transcribing" | "recording"
  | "awaiting_review"
  | "reviewed"          // new: signed off, not in the knowledge base
  | "saved"             // in the knowledge base
  | "failed" | "cancelled";
```

The derived state a client should use:

| `status` | `saved_item_id` | means |
|---|---|---|
| `awaiting_review` | null | needs review |
| `reviewed` | null | reviewed, not published |
| `saved` | set | reviewed and published |

`reviewed_at` is set on the first transition into either `reviewed` or
`saved`, and is never cleared.

## Transitions

```
awaiting_review ──markReviewed──▶ reviewed ──publish──▶ saved
       │                                                  ▲
       └──────────────────publish─────────────────────────┘
```

- **`transcriptionJobMarkReviewed(id, input)`** — new. Persists the same
  corrections `finalize` would (speakers, `corrected_segments`, title,
  sharing intent, project), renders `transcript_text` so an export has
  something to serve, sets `reviewed_at` and `status: "reviewed"`. Creates
  no item.
- **`transcriptionJobFinalize`** — unchanged in behaviour, now also accepted
  from `reviewed`. Sets `reviewed_at` if it is still null.
- **`cancelJob`** — unchanged, and still reachable from `reviewed`.

Re-editing a published transcript keeps today's path: `finalize` from `saved`
upserts the existing item.

## What changes

**Backend**
- `core-schema.ts`: the `reviewed_at` column.
- `service.ts`: the `reviewed` status, `markReviewed`, `finalize` accepting
  `reviewed` and stamping `reviewed_at`.
- `schemas/index.ts`: the `transcriptionJobMarkReviewed` mutation, mirroring
  `transcriptionJobFinalize`'s input type.
- `export-route.ts`: a second route, `GET /transcription-jobs/:jobId/export`,
  serving the same formats from the job's rendered text. Same header auth,
  same format set; it refuses a job with no `transcript_text` (i.e. one that
  has not been reviewed) rather than exporting a raw transcript by accident.

**Frontend**
- `types.ts`: a `reviewed` row state and its mapping; the job-row filter stops
  dropping `reviewed` jobs, so they stay in the list with no item.
- The knowledge-base card gains its third state: *Reviewed, not published*,
  with Publish as the action.
- The review screen's primary action becomes **Mark as reviewed**, with
  **Publish to knowledge base** beside it — both available, neither implying
  the other.
- `ExportMenu` takes a job id when there is no item yet.
- The list's "Needs review" tab counts only `awaiting_review`; reviewed rows
  appear under All/Mine with a quieter badge.

**Migration.** Existing `saved` jobs are reviewed and published; backfill
`reviewed_at = updatedAt` for them in `init-db.ts`, gated on the column
existing, per the project convention. Nothing else moves.

## Error handling

- **Mark-reviewed fails mid-way** — the job keeps `awaiting_review` and
  records `error`, exactly as `finalize` already does on item-creation
  failure. The reviewer retries; nothing is half-applied, because the only
  write is one row update.
- **Export of an unreviewed job** — 409 with a message naming the reason,
  not a silent raw-transcript export.
- **Publish of an already-published job** — unchanged: upsert.
- **A reviewed job whose recording is deleted by retention** — unaffected;
  the rendered text lives on the job.

## Testing

Backend (jest):
- `markReviewed` from `awaiting_review` sets `reviewed_at`, status and
  `transcript_text`, and creates no item.
- `finalize` from `reviewed` publishes and leaves `reviewed_at` at its
  original value.
- `finalize` from `awaiting_review` still stamps `reviewed_at` (the one-step
  path).
- `markReviewed` from `saved` is refused.
- The job export route refuses a job with no `transcript_text`.

Frontend (vitest): the three-way state derivation as a pure function —
status + `saved_item_id` → `needs_review` | `reviewed` | `published`.

**Manual:** review without publishing, export the result to Word, then
publish it later and confirm the item appears once and the agent can find it.

## Out of scope

- **Unpublishing** — removing an item from the knowledge base while keeping
  the transcript. Still no backend concept for it; the only removal is
  delete. Worth its own decision, not a rider on this one.
- Making sharing real before publication.
- Bulk mark-as-reviewed from the list.
- Any change to what publishing itself does.

## Open questions

1. **Should a reviewed-but-unpublished transcript be shareable?** Today's
   answer here is no (sharing needs an item). If a reviewer expects "confirm,
   export, send to a colleague", they will hit this. Acceptable for now?
2. **Should "Mark as reviewed" or "Publish" be the primary action** on the
   review screen? This spec puts Publish second but equally weighted. If most
   transcripts are meant to end up in the knowledge base, Publish should stay
   primary.
