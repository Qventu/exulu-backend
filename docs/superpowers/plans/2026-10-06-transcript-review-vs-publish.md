# Review vs Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reviewer sign off a transcript — and export it — without also publishing it to the knowledge base.

**Architecture:** `transcription_jobs` gains a `reviewed_at` timestamp and a `reviewed` status. Publication stays observable through the existing `saved_item_id`, so the two axes are independent: review is a job field, publication is the presence of a context item. A new `markReviewed` service method does everything `finalize` does except create the item; `finalize` is unchanged except that it now also accepts `reviewed` as a starting status and stamps `reviewed_at` when it is still null. Export gains a job-keyed route so a reviewed-but-unpublished transcript has something to export.

**Tech Stack:** TypeScript, knex/Postgres, hand-rolled GraphQL SDL (`src/graphql/schemas/index.ts`), Express routes, jest (backend); Next.js App Router, Apollo, next-intl, vitest (frontend).

**Spec:** `docs/superpowers/specs/2026-10-06-transcript-review-vs-publish-design.md`

## Global Constraints

- Two repos, one branch name `feat/transcript-review-state`: backend `../backend-review-state` off `develop`, frontend `../frontend-review-state` off `main`. Verify repo + branch in the same command as any commit.
- Frontend worktree `node_modules` must be **hard-linked** (`cp -al`), never symlinked — Turbopack breaks on a symlinked tree.
- **Measure both baselines before Task 1 and record them**; compare every later run against those numbers, not against zero. Backend `npx tsc --noEmit` and `npx jest` have pre-existing failures — the known-failing suites are `resolve-context-window`, `compact-session`, `email-inbound/intake`. Each new backend `.test.ts` adds exactly one structural eslint parse error; that is expected.
- Every new user-facing string needs a key in **both** `messages/en.json` and `messages/de.json`. `check-messages.js` only checks en/de parity, so a key missing from both passes parity and still renders raw — verify each key resolves at the path its namespace produces (`useTranslations("transcriptions")` + `t("document.x")` → `transcriptions.document.x`).
- Schema changes go in `src/postgres/core-schema.ts`; one-time backfills go in `src/postgres/init-exulu-db.ts` gated on `knex.schema.hasColumn`, never in a separate manual script.
- Commit prefix `feat:` / `fix:` / `test:` as appropriate; end every commit message with the trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Stage only the files each task names. Never `git add -A` or `git add .`.

## Review Focus

1. **A job reviewed but never published, then cancelled** — `cancelJob` must still work from `reviewed`; the row should leave the list without leaving a half-state. Pinned in Task 2.
2. **`finalize` called twice from `reviewed`** — the second call must upsert, not create a second item, and must not move `reviewed_at`. Pinned in Task 2.
3. **Export requested for a job that was never reviewed** — must refuse rather than serve the raw, uncorrected transcript as if it were signed off. Pinned in Task 4.
4. **Export of a reviewed job by someone who is not its owner** — the job-keyed route has no item RBAC to lean on, so it must apply the job's own ownership check. Pinned in Task 4.
5. **A `reviewed` job disappearing from the list** — the existing filter drops jobs whose status is `saved` or `cancelled`; `reviewed` must survive it, or a signed-off transcript vanishes with nothing to open. Pinned in Task 5.

---

### Task 1: The `reviewed_at` column and the `reviewed` status

**Files:**
- Modify: `src/postgres/core-schema.ts` (the `transcription_jobs` field list, beside `saved_item_id`)
- Modify: `src/exulu/transcription/service.ts` (the `JobStatus` union at `:36-43`, and `JobRow`)
- Modify: `src/postgres/init-exulu-db.ts` (backfill, beside the existing `transcriptions_items` block)
- Test: `src/postgres/core-schema.test.ts`

**Interfaces:**
- Produces: `JobStatus` including `"reviewed"`; `JobRow.reviewed_at: string | null`.

- [ ] **Step 1: Write the failing test**

In `src/postgres/core-schema.test.ts`, beside the existing transcription_jobs assertions:

```ts
it("transcription_jobs carries reviewed_at, so review is independent of publication", () => {
  const schema = coreSchemas.get().transcriptionJobsSchema();
  const names = schema.fields.map((f) => f.name);
  expect(names).toContain("reviewed_at");
  expect(names).toContain("saved_item_id");
});
```

`coreSchemas.get()` is how the surrounding tests in this file reach the schemas — match them.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/postgres/core-schema.test.ts -t "reviewed_at"`
Expected: FAIL — `reviewed_at` is not in the list.

- [ ] **Step 3: Add the column**

In `src/postgres/core-schema.ts`, in the `transcription_jobs` field list, directly after `{ name: "saved_item_id", type: "uuid", required: false },`:

```ts
    // Review is independent of publication: a transcript can be signed off
    // without entering the knowledge base. `saved_item_id` still answers
    // "published?"; this answers "reviewed?" (and when).
    { name: "reviewed_at", type: "date", required: false },
```

- [ ] **Step 4: Widen JobStatus**

In `src/exulu/transcription/service.ts`, replace the `JobStatus` union:

```ts
export type JobStatus =
  | "queued"
  | "transcribing"
  | "recording" // live browser recording in progress (chunks arriving)
  | "awaiting_review"
  | "reviewed" // signed off by a human; NOT in the knowledge base
  | "saved" // in the knowledge base (saved_item_id is set)
  | "failed"
  | "cancelled";
```

Add to the `JobRow` type, beside `saved_item_id`:

```ts
  reviewed_at: string | null;
```

and make sure `_rowFromDb` passes it through — follow exactly how the adjacent nullable columns are mapped in that function.

- [ ] **Step 5: Backfill already-published jobs**

In `src/postgres/init-exulu-db.ts`, after the `transcriptions_items` post_processing block:

```ts
  // Review/publish split (spec 2026-10-06): rows already in the knowledge
  // base were reviewed at the moment they were saved. Stamp them so the UI
  // does not show every historical transcript as "needs review".
  // Idempotent: the WHERE clause matches zero rows on every boot after the
  // first.
  if (await knex.schema.hasColumn("transcription_jobs", "reviewed_at")) {
    const stamped = await knex("transcription_jobs")
      .whereNotNull("saved_item_id")
      .whereNull("reviewed_at")
      .update({ reviewed_at: knex.ref("updatedAt") });
    if (stamped) {
      console.log(`[EXULU] Stamped reviewed_at on ${stamped} already-published transcripts.`);
    }
  }
```

- [ ] **Step 6: Run the test and the suite**

Run: `npx jest src/postgres/core-schema.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit` and `npx jest` — both at the baselines you recorded.

- [ ] **Step 7: Commit**

```bash
git add src/postgres/core-schema.ts src/postgres/core-schema.test.ts \
        src/postgres/init-exulu-db.ts src/exulu/transcription/service.ts
git commit -m "feat(transcripts): reviewed_at column and a reviewed job status

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `markReviewed`, and `finalize` accepting a reviewed job

**Files:**
- Modify: `src/exulu/transcription/service.ts` (new method beside `finalize` at `:364`; the status guard at `:370`)
- Test: `src/exulu/transcription/service.test.ts`

**Interfaces:**
- Consumes: `JobStatus` with `"reviewed"`, `JobRow.reviewed_at` (Task 1); the existing `FinalizeInput` type at `:60-68`.
- Produces:

```ts
// src/exulu/transcription/service.ts
async markReviewed(id: string, input: FinalizeInput): Promise<JobRow>
```

- [ ] **Step 1: Write the failing tests**

In `src/exulu/transcription/service.test.ts`. Read the top of that file first and reuse its existing `postgresClient` / `exuluApp` mocking style verbatim — do not invent a second harness.

```ts
describe("markReviewed", () => {
  it("signs the job off without creating a knowledge-base item", async () => {
    const row = jobRow({ status: "awaiting_review", reviewed_at: null });
    first.mockResolvedValue(row);
    const createItem = jest.fn();
    mockContext({ createItem });

    const result = await transcriptionService.markReviewed(row.id, {
      speakers: { SPEAKER_00: "Lena Brandt" },
    });

    expect(createItem).not.toHaveBeenCalled();
    expect(result.status).toBe("reviewed");
    expect(result.reviewed_at).toBeTruthy();
    expect(result.saved_item_id).toBeNull();
  });

  it("persists the corrections, which is what an export will read", async () => {
    // Nothing renders text here: the export builders work from
    // raw_segments + corrected_segments + speakers, all of which the job
    // already carries. Rendering a second copy onto the job would be a
    // duplicate that can drift from the corrections.
    const row = jobRow({ status: "awaiting_review" });
    first.mockResolvedValue(row);
    const corrected = [{ start: 0, end: 2, speaker: "SPEAKER_00", text: "Also." }];
    await transcriptionService.markReviewed(row.id, {
      speakers: { SPEAKER_00: "Lena Brandt" },
      corrected_segments: corrected,
    });
    const written = update.mock.calls.at(-1)?.[0];
    expect(JSON.parse(written.corrected_segments)).toEqual(corrected);
    expect(JSON.parse(written.speakers)).toEqual({ SPEAKER_00: "Lena Brandt" });
  });

  it("refuses a job that is already published", async () => {
    first.mockResolvedValue(jobRow({ status: "saved", saved_item_id: "item-1" }));
    await expect(
      transcriptionService.markReviewed("job-1", { speakers: {} }),
    ).rejects.toThrow(/saved/);
  });
});

describe("finalize from reviewed", () => {
  it("publishes a reviewed job and keeps its original reviewed_at", async () => {
    const reviewedAt = "2026-10-01T09:00:00.000Z";
    first.mockResolvedValue(jobRow({ status: "reviewed", reviewed_at: reviewedAt }));
    const createItem = jest.fn().mockResolvedValue({ item: { id: "item-9" } });
    mockContext({ createItem });

    const { row } = await transcriptionService.finalize("job-1", { speakers: {} });

    expect(createItem).toHaveBeenCalled();
    expect(row.status).toBe("saved");
    expect(row.reviewed_at).toBe(reviewedAt);
  });

  it("stamps reviewed_at when publishing straight from awaiting_review", async () => {
    first.mockResolvedValue(jobRow({ status: "awaiting_review", reviewed_at: null }));
    mockContext({ createItem: jest.fn().mockResolvedValue({ item: { id: "item-9" } }) });
    const { row } = await transcriptionService.finalize("job-1", { speakers: {} });
    expect(row.reviewed_at).toBeTruthy();
  });

  it("can still be cancelled after review", async () => {
    first.mockResolvedValue(jobRow({ status: "reviewed" }));
    const row = await transcriptionService.cancelJob("job-1");
    expect(row.status).toBe("cancelled");
  });
});
```

`jobRow` and `mockContext` are helpers you write at the top of this describe block if the file has no equivalent — keep them to the minimum these tests need.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx jest src/exulu/transcription/service.test.ts -t "markReviewed"`
Expected: FAIL — `transcriptionService.markReviewed is not a function`.

- [ ] **Step 3: Implement `markReviewed`**

In `src/exulu/transcription/service.ts`, directly above `finalize`:

```ts
  /**
   * Sign a transcript off without publishing it.
   *
   * Everything `finalize` does except creating the context item: the
   * corrections are persisted, but the transcript does not enter the
   * knowledge base and no agent can retrieve it. Publishing later goes
   * through `finalize`, which upserts from this state.
   *
   * Deliberately does NOT render transcript_text: that field belongs to the
   * context item (templates/contexts/transcriptions.ts), and the export
   * builders read raw_segments + corrected_segments + speakers, which the job
   * already has. A second rendered copy on the job could drift from the
   * corrections it was rendered from.
   *
   * Sharing stays intent-only here (spec §"What happens today"): RBAC lives on
   * the item, so an unpublished transcript is creator-only whatever
   * target_rights_mode says.
   */
  async markReviewed(id: string, input: FinalizeInput): Promise<JobRow> {
    const { db } = await postgresClient();
    const dbRow = await db(TABLE).where({ id }).first();
    if (!dbRow) throw new Error(`transcription_job ${id} not found`);
    const row = this._rowFromDb(dbRow);

    if (row.status !== "awaiting_review" && row.status !== "reviewed") {
      throw new Error(
        `transcription_job ${id} is in status '${row.status}'; can only mark reviewed from 'awaiting_review' or 'reviewed'`,
      );
    }
    if (!row.raw_segments) {
      throw new Error(`transcription_job ${id} has no raw_segments to review`);
    }

    // Same resolution rule as finalize: `!== undefined` so an explicit null
    // means "reset the correction", not "keep what is stored".
    const resolvedCorrected =
      input.corrected_segments !== undefined
        ? input.corrected_segments
        : (row.corrected_segments ?? null);

    const [updated] = await db(TABLE)
      .where({ id })
      .update({
        status: "reviewed" as JobStatus,
        reviewed_at: row.reviewed_at ?? new Date(),
        title: input.title ?? row.title,
        speakers: JSON.stringify(input.speakers),
        corrected_segments:
          resolvedCorrected === null ? null : JSON.stringify(resolvedCorrected),
        project_id: input.project_id ?? row.project_id ?? null,
        target_rights_mode: input.target_rights_mode ?? row.target_rights_mode ?? "private",
        target_rbac_users: JSON.stringify(input.target_rbac_users ?? row.target_rbac_users ?? []),
        target_rbac_roles: JSON.stringify(input.target_rbac_roles ?? row.target_rbac_roles ?? []),
        error: null,
        updatedAt: new Date(),
      })
      .returning("*");
    return this._rowFromDb(updated);
  },
```

- [ ] **Step 4: Let `finalize` start from `reviewed`**

In `finalize`, replace the status guard:

```ts
    if (
      row.status !== "awaiting_review" &&
      row.status !== "reviewed" &&
      row.status !== "saved"
    ) {
      throw new Error(
        `transcription_job ${id} is in status '${row.status}'; can only finalize from 'awaiting_review', 'reviewed' or 'saved'`,
      );
    }
```

In the final `update` call of `finalize`, add `reviewed_at` beside the status write so a one-step publish is also a review, while a job reviewed earlier keeps its original timestamp:

```ts
        reviewed_at: row.reviewed_at ?? new Date(),
```

- [ ] **Step 5: Run the tests**

Run: `npx jest src/exulu/transcription/service.test.ts`
Expected: PASS, including the pre-existing tests in that file.
Run: `npx tsc --noEmit` and `npx jest` — both at baseline.

- [ ] **Step 6: Commit**

```bash
git add src/exulu/transcription/service.ts src/exulu/transcription/service.test.ts
git commit -m "feat(transcripts): markReviewed, and finalize from a reviewed job

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The `transcriptionJobMarkReviewed` mutation

**Files:**
- Modify: `src/graphql/schemas/index.ts` (mutation list at `:859-867`; resolver beside `transcriptionJobFinalize` at `:2208`)

**Interfaces:**
- Consumes: `transcriptionService.markReviewed(id, FinalizeInput)` (Task 2).
- Produces: `transcriptionJobMarkReviewed(id: ID!, input: TranscriptionJobFinalizeInput!): transcription_job`.

- [ ] **Step 1: Add the mutation to the SDL**

`src/graphql/schemas/index.ts` is a shared, hand-rolled schema file. **APPEND only** — never regenerate a region of it. Add one line inside the existing transcription `mutationDefs` block:

```
    transcriptionJobMarkReviewed(id: ID!, input: TranscriptionJobFinalizeInput!): transcription_job
```

It reuses `TranscriptionJobFinalizeInput` deliberately: the payload is identical, and a parallel input type would drift.

- [ ] **Step 2: Add the resolver**

Directly after the `transcriptionJobFinalize` resolver:

```ts
  resolvers.Mutation["transcriptionJobMarkReviewed"] = async (_, args, context) => {
    await assertOwnsTranscriptionJob(args.id, context);
    return transcriptionService.markReviewed(args.id, {
      title: args.input.title,
      speakers: args.input.speakers,
      project_id: args.input.project_id ?? null,
      target_rights_mode: args.input.target_rights_mode ?? null,
      target_rbac_users: args.input.target_rbac_users ?? undefined,
      target_rbac_roles: args.input.target_rbac_roles ?? undefined,
      corrected_segments: args.input.corrected_segments,
    });
  };
```

The same ownership gate as finalize: review is a write to someone's transcript.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` — baseline.
Run: `npx jest` — baseline.
Then confirm by hand that the SDL still parses and the neighbouring mutations survived:

```bash
grep -c "transcriptionJobFinalize\|transcriptionJobMarkReviewed\|transcriptionJobCancel" src/graphql/schemas/index.ts
```
Expected: at least 6 (each appears in both the SDL and a resolver).

- [ ] **Step 4: Commit**

```bash
git add src/graphql/schemas/index.ts
git commit -m "feat(transcripts): transcriptionJobMarkReviewed mutation

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Job-keyed export

**Files:**
- Modify: `src/exulu/transcription/export-route.ts`
- Modify: `src/exulu/routes.ts` (wiring, beside the existing `registerTranscriptExportRoute` call — find with `grep -n "registerTranscriptExportRoute" src/exulu/routes.ts`)
- Test: `src/exulu/transcription/export-route.test.ts`

**Interfaces:**
- Consumes: `TranscriptExportItem` / `TranscriptExportOptions` and the three builders from `./transcript-export`; `JobRow.reviewed_at` (Task 1).
- Produces: `TRANSCRIPT_JOB_EXPORT_ROUTE_PATH = "/transcription-jobs/:jobId/export"`, and `TranscriptExportRouteDeps.getJob`.

- [ ] **Step 1: Write the failing tests**

In `src/exulu/transcription/export-route.test.ts`, reusing the file's existing express/supertest harness verbatim:

```ts
describe("GET /transcription-jobs/:jobId/export", () => {
  it("exports a reviewed job", async () => {
    const app = makeApp({
      getJob: async () => ({
        name: "Fertigungsplanung",
        raw_segments: [{ start: 0, end: 2, speaker: "SPEAKER_00", text: "Also." }],
        speakers: { SPEAKER_00: "Lena Brandt" },
        reviewed_at: "2026-10-01T09:00:00.000Z",
      }),
    });
    const res = await request(app).get("/transcription-jobs/job-1/export?format=md");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Lena Brandt");
  });

  it("refuses a job that has not been reviewed", async () => {
    // Exporting here would hand someone an uncorrected transcript that looks
    // signed off.
    const app = makeApp({
      getJob: async () => ({ name: "x", reviewed_at: null, raw_segments: [] }),
    });
    const res = await request(app).get("/transcription-jobs/job-1/export?format=md");
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/review/i);
  });

  it("404s a job the caller does not own", async () => {
    const app = makeApp({ getJob: async () => undefined });
    const res = await request(app).get("/transcription-jobs/job-1/export?format=md");
    expect(res.status).toBe(404);
  });

  it("rejects an unknown format before touching the job", async () => {
    const getJob = jest.fn();
    const app = makeApp({ getJob });
    const res = await request(app).get("/transcription-jobs/job-1/export?format=exe");
    expect(res.status).toBe(400);
    expect(getJob).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx jest src/exulu/transcription/export-route.test.ts -t "transcription-jobs"`
Expected: FAIL — 404 from express, the route does not exist.

- [ ] **Step 3: Add the route**

In `src/exulu/transcription/export-route.ts`, beside the existing constant and deps:

```ts
export const TRANSCRIPT_JOB_EXPORT_ROUTE_PATH = "/transcription-jobs/:jobId/export";
```

Extend `TranscriptExportRouteDeps`:

```ts
  /**
   * The job behind an unpublished transcript, or undefined when it is missing
   * or not the caller's. There is no item to hang RBAC on at this point, so
   * the implementation applies the job's own ownership check.
   */
  getJob?: (
    jobId: string,
    user: { id: number | string; role?: { id?: string } },
  ) => Promise<(TranscriptExportItem & { reviewed_at?: string | Date | null }) | undefined>;
```

Then register a second handler inside `registerTranscriptExportRoute`, after the item route. It is the item handler with two differences — the lookup, and the reviewed gate:

```ts
  app.get(TRANSCRIPT_JOB_EXPORT_ROUTE_PATH, async (req: Request, res: Response) => {
    if (!deps.getJob) {
      res.status(404).json({ detail: "Transcript not found." });
      return;
    }
    const auth = await deps.authenticate(req);
    if (!auth.user?.id) {
      res.status(auth.code ?? 401).json({ detail: auth.message ?? "Authentication required." });
      return;
    }

    const format = req.query.format as ExportFormat;
    if (!FORMATS.includes(format)) {
      res.status(400).json({ detail: `Query param 'format' must be one of ${FORMATS.join(", ")}.` });
      return;
    }

    const job = await deps.getJob(req.params.jobId as string, auth.user);
    if (!job) {
      res.status(404).json({ detail: "Transcript not found, or you do not have access to it." });
      return;
    }
    if (!job.reviewed_at) {
      // A draft's text is whatever the recogniser produced. Handing that out
      // as a document would pass an unchecked transcript off as a reviewed one.
      res.status(409).json({ detail: "This transcript has not been reviewed yet." });
      return;
    }

    const options: TranscriptExportOptions = {
      summary: flag(req.query.summary),
      timestamps: flag(req.query.timestamps),
      speakers: flag(req.query.speakers),
    };

    try {
      let body: string | Buffer;
      if (format === "csv") {
        body = buildTranscriptCsv(job, options);
      } else if (format === "srt") {
        body = buildTranscriptSrt(job, options);
      } else {
        const markdown = buildTranscriptMarkdown(job, options);
        body = format === "md" ? markdown : await deps.convert(markdown, format);
      }
      const filename = exportFilename(job.name ?? "transcript", "transcript", format);
      res.setHeader("Content-Type", exportContentType(format));
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
      res.send(body);
    } catch (err) {
      console.error("[EXULU] transcript job export failed", err);
      res.status(500).json({ detail: "Export failed." });
    }
  });
```

- [ ] **Step 4: Wire the real dependency**

In `src/exulu/routes.ts`, at the existing `registerTranscriptExportRoute(...)` call, add `getJob`. Reuse the same ownership helper the transcription mutations use (`assertOwnsTranscriptionJob` or its underlying check — read how the job routes in this file already authorise) and return undefined rather than throwing when the caller does not own it:

```ts
    getJob: async (jobId, user) => {
      const { db } = await postgresClient();
      const row = await db("transcription_jobs").where({ id: jobId }).first();
      if (!row) return undefined;
      if (String(row.created_by) !== String(user.id)) return undefined;
      return {
        name: row.title,
        recording_source: row.source,
        recorded_at: row.join_at ?? row.createdAt,
        duration_seconds: row.duration_seconds,
        language: row.language,
        speakers: parseJsonField(row.speakers),
        raw_segments: parseJsonField(row.raw_segments),
        corrected_segments: parseJsonField(row.corrected_segments),
        post_processing: parseJsonField(row.post_processing_outputs),
        reviewed_at: row.reviewed_at,
      };
    },
```

Match the file's existing import style for `postgresClient` and `parseJsonField` rather than adding new ones if they are already imported.

- [ ] **Step 5: Run the tests**

Run: `npx jest src/exulu/transcription/export-route.test.ts`
Expected: PASS, including the pre-existing item-route tests.
Run: `npx tsc --noEmit` and `npx jest` — baseline.

- [ ] **Step 6: Commit**

```bash
git add src/exulu/transcription/export-route.ts \
        src/exulu/transcription/export-route.test.ts src/exulu/routes.ts
git commit -m "feat(transcripts): export a reviewed job before it is published

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Frontend state derivation

**Files (frontend worktree):**
- Modify: `app/(application)/transcriptions/types.ts` (`TranscriptState` at `:530`, `JOB_STATE` at `:558`, the job-row filter at `:605`)
- Test: `app/(application)/transcriptions/types.test.ts`

**Interfaces:**
- Produces: `TranscriptState` including `"reviewed"`; `transcriptPublishState(job)`.

- [ ] **Step 1: Create the frontend worktree**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend
git worktree add -b feat/transcript-review-state ../frontend-review-state main
cp -al node_modules ../frontend-review-state/node_modules
```

`cp -al` hard-links; a symlinked `node_modules` breaks Turbopack. Verify with `ls ../frontend-review-state/node_modules | wc -l` (expect >1000). Then measure the baseline: `npx vitest run`, `npx eslint .`, `npx tsc --noEmit`.

- [ ] **Step 2: Write the failing tests**

In `app/(application)/transcriptions/types.test.ts`:

```ts
describe("transcriptPublishState", () => {
  it("reads the two axes off a job", () => {
    expect(transcriptPublishState({ status: "awaiting_review", saved_item_id: null })).toBe("draft");
    expect(transcriptPublishState({ status: "reviewed", saved_item_id: null })).toBe("reviewed");
    expect(transcriptPublishState({ status: "saved", saved_item_id: "item-1" })).toBe("published");
  });

  it("trusts saved_item_id over a lagging status", () => {
    // finalize writes the item before the status; a row caught in between is
    // published, whatever its status still says.
    expect(transcriptPublishState({ status: "reviewed", saved_item_id: "item-1" })).toBe("published");
  });
});

describe("mergeTranscriptRows with a reviewed job", () => {
  it("keeps a reviewed job in the list — it has no item to stand in for it", () => {
    const rows = mergeTranscriptRows(
      [{ id: "j1", status: "reviewed", saved_item_id: null, createdAt: "2026-10-01T00:00:00Z" } as never],
      [],
    );
    expect(rows.map((r) => r.id)).toContain("j1");
    expect(rows[0].state).toBe("reviewed");
  });

  it("still drops a job that produced an item", () => {
    const rows = mergeTranscriptRows(
      [{ id: "j1", status: "saved", saved_item_id: "i1", createdAt: "2026-10-01T00:00:00Z" } as never],
      [],
    );
    expect(rows).toHaveLength(0);
  });
});
```

Match `mergeTranscriptRows`' real signature — read its definition before writing the call.

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run app/\(application\)/transcriptions/types.test.ts`
Expected: FAIL — `transcriptPublishState` is not exported.

- [ ] **Step 4: Implement**

In `app/(application)/transcriptions/types.ts`, widen the state union:

```ts
export type TranscriptState =
  | "recording"
  | "queued"
  | "transcribing"
  | "needs_review"
  | "reviewed"
  | "failed"
  | "ready";
```

Map the new status:

```ts
const JOB_STATE: Partial<Record<JobStatus, TranscriptState>> = {
  recording: "recording",
  queued: "queued",
  transcribing: "transcribing",
  awaiting_review: "needs_review",
  reviewed: "reviewed",
  failed: "failed",
};
```

Add the derivation:

```ts
/**
 * Where a transcript stands on the two independent axes: reviewed by a
 * human, and present in the knowledge base. `saved_item_id` is the
 * authority on publication — the item is what agents retrieve — so it wins
 * over a status that has not caught up.
 */
export type TranscriptPublishState = "draft" | "reviewed" | "published";

export function transcriptPublishState(job: {
  status: JobStatus;
  saved_item_id?: string | null;
}): TranscriptPublishState {
  if (job.saved_item_id || job.status === "saved") return "published";
  if (job.status === "reviewed") return "reviewed";
  return "draft";
}
```

And stop the filter dropping reviewed jobs — it already only drops `saved` and `cancelled`, so confirm by reading it that `reviewed` survives, and add a comment there:

```ts
      // `reviewed` deliberately stays: it is signed off but has no item, so
      // nothing else in the list would represent it.
      if (job.status === "saved" || job.status === "cancelled") return false;
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run app/\(application\)/transcriptions/types.test.ts`
Expected: PASS.
Run: `npx vitest run`, `npx tsc --noEmit`, `npx eslint .` — all at the baseline you recorded.

- [ ] **Step 6: Commit**

```bash
git add "app/(application)/transcriptions/types.ts" "app/(application)/transcriptions/types.test.ts"
git commit -m "feat(transcripts): derive review and publication as two axes

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The third knowledge-base state and the two actions

**Files (frontend worktree):**
- Modify: `app/(application)/transcriptions/components/transcript-document.tsx` (the knowledge-base card; the header action block)
- Modify: `app/(application)/transcriptions/queries.ts` (the new mutation)
- Modify: `app/(application)/transcriptions/review/[jobId]/page.tsx` (wire mark-reviewed)
- Modify: `messages/en.json`, `messages/de.json`

**Interfaces:**
- Consumes: `transcriptPublishState` (Task 5); `transcriptionJobMarkReviewed` (Task 3).
- Produces: `TranscriptDocumentProps.publishState: TranscriptPublishState` replacing the boolean `published`, and `onMarkReviewed?: (draft: TranscriptDraft) => Promise<void>`.

- [ ] **Step 1: Add the mutation document**

In `app/(application)/transcriptions/queries.ts`, beside `FINALIZE_TRANSCRIPTION_JOB`:

```ts
export const MARK_TRANSCRIPTION_JOB_REVIEWED = gql`
  mutation MarkTranscriptionJobReviewed($id: ID!, $input: TranscriptionJobFinalizeInput!) {
    transcriptionJobMarkReviewed(id: $id, input: $input) {
      ${TRANSCRIPTION_JOB_FIELDS}
    }
  }
`;
```

- [ ] **Step 2: Add the copy**

To `messages/en.json` under `transcriptions`:

```json
"review": { "markReviewed": "Mark as reviewed", "markedReviewed": "Marked as reviewed" },
"document": {
  "kbReviewedTitle": "Reviewed, not published",
  "kbReviewedBody": "You have signed this transcript off. It is not in the knowledge base, so no agent can search it — publish it when you want that."
}
```

and the German:

```json
"review": { "markReviewed": "Als geprüft markieren", "markedReviewed": "Als geprüft markiert" },
"document": {
  "kbReviewedTitle": "Geprüft, nicht veröffentlicht",
  "kbReviewedBody": "Sie haben dieses Transkript freigegeben. Es ist nicht in der Wissensdatenbank, also kann es kein Agent durchsuchen — veröffentlichen Sie es, wenn Sie das möchten."
}
```

Merge into the existing objects; do not replace them.

- [ ] **Step 3: Swap the boolean for the three-way state**

In `transcript-document.tsx`, replace the `published?: boolean` prop with:

```ts
  /** Where this transcript stands: a draft, signed off but not in the
   *  knowledge base, or published. Drives the knowledge-base card and which
   *  primary action the header offers. */
  publishState?: TranscriptPublishState;
```

defaulting to `"draft"`, and update the three existing `published` reads to `publishState === "published"`. Then give the card its third branch:

```tsx
                <p className="flex items-center gap-2 text-sm font-medium">
                  <Library aria-hidden="true" className="size-4 shrink-0" />
                  {publishState === "published"
                    ? t("document.kbPublishedTitle")
                    : publishState === "reviewed"
                      ? t("document.kbReviewedTitle")
                      : t("document.kbDraftTitle")}
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {publishState === "published"
                    ? t("document.kbPublishedBody")
                    : publishState === "reviewed"
                      ? t("document.kbReviewedBody")
                      : t("document.kbDraftBody")}
                </p>
```

The card's action stays as it is: Publish when not published, Remove when published — a reviewed transcript offers Publish, which is the point.

- [ ] **Step 4: Add Mark as reviewed to the header**

In the editable header action block, before the sharing control, when `publishState !== "published"` and `onMarkReviewed` is set:

```tsx
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saving}
                  className="max-md:h-11"
                  onClick={() => void handleMarkReviewedClick()}
                >
                  {t("review.markReviewed")}
                </Button>
```

and add the handler beside `handleSaveClick`, built the same way — it assembles the identical `TranscriptDraft` and calls `onMarkReviewed` instead of `onSave`:

```tsx
  const handleMarkReviewedClick = async () => {
    if (!onMarkReviewed) return;
    setSaving(true);
    try {
      await onMarkReviewed(buildDraft());
    } finally {
      setSaving(false);
    }
  };
```

If `handleSaveClick` builds its draft inline rather than through a `buildDraft` helper, extract that construction into one `buildDraft()` used by both — two copies of the draft assembly is how the review flow lost `target_rbac_users` once before.

- [ ] **Step 5: Wire the review page**

In `review/[jobId]/page.tsx`, add a `markReviewed` mutation alongside `finalize`, a `handleMarkReviewed` built exactly like `handleSave` (same input object, same toast-on-failure, same rethrow so edit mode stays open), and pass both to the document:

```tsx
          publishState={transcriptPublishState(job)}
          onMarkReviewed={handleMarkReviewed}
```

On success, `toast.success(t("review.markedReviewed"))` and `router.push("/transcriptions")` — unlike publishing, there is no item to navigate to.

Update the detail page (`[itemId]/page.tsx`) to pass `publishState="published"` in place of the `published` boolean.

- [ ] **Step 6: Verify**

Run: `npx vitest run`, `npx tsc --noEmit`, `npx eslint .`, `node scripts/check-messages.js` — all at baseline, parity OK.
Then confirm each new key resolves:

```bash
node -e "const m=require('./messages/en.json').transcriptions; console.log(m.document.kbReviewedTitle, '|', m.review.markReviewed)"
node -e "const m=require('./messages/de.json').transcriptions; console.log(m.document.kbReviewedTitle, '|', m.review.markReviewed)"
```

- [ ] **Step 7: Commit**

```bash
git add "app/(application)/transcriptions/components/transcript-document.tsx" \
        "app/(application)/transcriptions/queries.ts" \
        "app/(application)/transcriptions/review/[jobId]/page.tsx" \
        "app/(application)/transcriptions/[itemId]/page.tsx" \
        messages/en.json messages/de.json
git commit -m "feat(transcripts): mark as reviewed, and a third knowledge-base state

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Export from a reviewed job, and the list

**Files (frontend worktree):**
- Modify: `app/(application)/transcriptions/components/export-menu.tsx` (`fetchExport` at `:121`, `ExportMenuProps`)
- Modify: `app/(application)/transcriptions/components/transcript-document.tsx` (the `<ExportMenu />` call, and showing it while reviewing)
- Modify: `app/(application)/transcriptions/hooks.ts` (`needsReviewCount` at `:152`)
- Test: `app/(application)/transcriptions/hooks.test.ts`

**Interfaces:**
- Consumes: `TRANSCRIPT_JOB_EXPORT_ROUTE_PATH` from Task 4; `TranscriptState` including `"reviewed"` (Task 5).

- [ ] **Step 1: Write the failing test**

In `app/(application)/transcriptions/hooks.test.ts`:

```ts
describe("needsReviewCount", () => {
  it("counts only what still needs a human, not what has been signed off", () => {
    const rows = [
      { state: "needs_review" },
      { state: "needs_review" },
      { state: "reviewed" },
      { state: "ready" },
    ] as never[];
    expect(countNeedsReview(rows)).toBe(2);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run app/\(application\)/transcriptions/hooks.test.ts -t needsReviewCount`
Expected: FAIL — `countNeedsReview` is not exported.

- [ ] **Step 3: Extract and use the count**

In `hooks.ts`, replace the inline filter at `:152` with an exported pure function and call it:

```ts
/** Rows still waiting on a human. A reviewed transcript is done, whether or
 *  not anyone chose to publish it. */
export function countNeedsReview(rows: { state: TranscriptState }[]): number {
  return rows.filter((row) => row.state === "needs_review").length;
}
```

- [ ] **Step 4: Teach ExportMenu about jobs**

In `export-menu.tsx`, change the props and the URL builder so one of the two ids is required:

```ts
export interface ExportMenuProps {
  /** A published transcript's item. */
  itemId?: string;
  /** A reviewed-but-unpublished transcript's job — the route refuses a job
   *  that has not been reviewed, so this is only passed once it has been. */
  jobId?: string;
}
```

```ts
  const path = itemId
    ? `transcription-items/${encodeURIComponent(itemId)}`
    : `transcription-jobs/${encodeURIComponent(jobId!)}`;
  const url =
    `${backend}/${path}/export?format=${format}` +
    `&summary=${options.summary ? 1 : 0}` +
    `&timestamps=${options.timestamps ? 1 : 0}` +
    `&speakers=${options.speakers ? 1 : 0}`;
```

Keep the existing `authorization: Bearer` header exactly as it is — that route is header-authenticated and a bare navigation 401s.

- [ ] **Step 5: Show Export while reviewing a signed-off transcript**

In `transcript-document.tsx`, the header currently renders `<ExportMenu itemId={item.id} />` only in read mode. Render it when `publishState !== "draft"`, passing whichever id exists:

```tsx
                {publishState !== "draft" && (
                  <ExportMenu
                    itemId={publishState === "published" ? item.id : undefined}
                    jobId={publishState === "reviewed" ? (item.job_id ?? item.id) : undefined}
                  />
                )}
```

- [ ] **Step 6: Verify**

Run: `npx vitest run`, `npx tsc --noEmit`, `npx eslint .` — baseline.
Run: `npx next build` — green, all four transcripts routes present.

- [ ] **Step 7: Commit**

```bash
git add "app/(application)/transcriptions/components/export-menu.tsx" \
        "app/(application)/transcriptions/components/transcript-document.tsx" \
        "app/(application)/transcriptions/hooks.ts" \
        "app/(application)/transcriptions/hooks.test.ts"
git commit -m "feat(transcripts): export a reviewed transcript, and count only unreviewed ones

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Whole-branch verification

**Files:** none — this task runs things and reports.

- [ ] **Step 1: Backend**

In `../backend-review-state`: `npx tsc --noEmit`, `npx jest`, `npm run lint`. Compare against the baselines recorded in Task 1, allowing one structural lint error per new `.test.ts`. Any other increase is a regression to fix before this task passes.

- [ ] **Step 2: Frontend**

In `../frontend-review-state`: `npx vitest run`, `npx eslint .`, `node scripts/check-messages.js`, `npx tsc --noEmit`, `npx next build`. Compare against the Task 5 baselines. If `tsc` reports errors inside `.next/`, delete `.next` and rebuild — those are stale generated types.

- [ ] **Step 3: End-to-end by hand**

Deploy backend before frontend. Then, against a transcript awaiting review:

1. **Mark as reviewed.** Confirm the row leaves the "Needs review" tab, stays in the list, and opens to a card reading "Reviewed, not published".
2. **Export it to Word** from that state. Confirm the document contains the corrections, not the raw transcript.
3. **Check it is not searchable.** Ask an agent with `transcriptions` retrieval about something only this transcript says; it must not find it.
4. **Publish it.** Confirm the card flips to "In the knowledge base", exactly one item appears in `/data/transcriptions`, and the same agent question now finds it.
5. **Re-publish** (edit and save again) and confirm no second item appears.
6. **Review then discard.** Confirm a reviewed transcript can still be discarded and leaves the list.
7. **Export an unreviewed draft** by URL (`/transcription-jobs/<id>/export?format=md`) and confirm a 409, not a document.
8. **A second user** requesting another user's job export gets a 404.

- [ ] **Step 4: Report**

Write the outcome — what passed, what failed, what was deferred — before requesting review.

## Notes for the executor

- **Two repos, one branch name.** Check `pwd` and `git branch --show-current` in the same command as any commit. Never commit from `../backend` or `../frontend`.
- **The backend is a library** (`@exulu/backend`) with no standalone server; backend changes are smoke-testable only through a consuming project — rebuild `dist` and restart it.
- **`src/graphql/schemas/index.ts` is shared and hand-rolled.** Append; never regenerate a region.
- **Do not add entries to `eslint.tier-exemptions.mjs`.** That list may only shrink. If something trips a tier rule, report it.
