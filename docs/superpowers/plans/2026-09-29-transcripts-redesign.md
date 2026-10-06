# Transcripts Redesign (stages 1–2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/transcriptions` from a three-group job queue into a document library where every recording can be read, corrected, asked about and exported.

**Architecture:** Items-first. The home unions the existing creator-only `transcription_jobs` pagination (in progress) with the generic RBAC'd `transcriptions_itemsPagination` (ready), so sharing, search, filters, export and agent retrieval all reuse the knowledge item's existing rights. Corrections live in a `corrected_segments` column beside the untouched engine output. Reading view and review page are one component in two modes.

**Tech Stack:** Backend — TypeScript, Express, knex, GraphQL (hand-rolled schema builder), jest + ts-jest. Frontend — Next.js 16 App Router, React 19, Apollo Client, shadcn/ui, Tailwind, next-intl, vitest (node environment only).

**Spec:** `docs/superpowers/specs/2026-09-29-transcripts-redesign-design.md`

**Repos:** backend worktree `../backend-transcripts-redesign`, frontend worktree `../frontend-transcripts-redesign`, both on branch `feat/transcripts-redesign`. Backend tasks run in the backend worktree, frontend tasks in the frontend worktree. **Never edit one repo from the other's directory.**

## Global Constraints

- **Column naming.** The new item column is `recording_source`, never `source` — `convertContextToTableDefinition` already injects a `source` field on every context and the name would collide.
- **Migrations.** Declaring a field on `transcriptionsContext.fields` or `transcriptionJobsSchema.fields` is sufficient; `addMissingFields` adds the column on boot for new and existing databases. Do **not** hand-write a column migration. Only the one-time *backfill* gets a hand-written block, and it goes in `src/postgres/init-exulu-db.ts`.
- **Teams sharing stays hidden.** `ALLOWED_MODES` remains `["private", "users", "roles", "public"]`. The backend does not store teams.
- **Vocabulary.** UI says "Transcripts" (de: "Transkripte"). The knowledge base keeps the name "Transcriptions". Never show a product brand — say "the IMP" or "the agent". Default bot name "IMP Notetaker".
- **No violet or purple** in any new UI. Use the existing design tokens.
- **Touch targets** below `md` are at least 44 px (`max-md:h-11`). Icon-only buttons carry an `aria-label`.
- **Hide, never disable**, any control whose backend is stage 3 or 4.
- **Known baselines — do not treat as regressions.** Backend: 9 `tsc --noEmit` errors, 4 failing jest suites, 156 lint findings. Frontend: 1 failing vitest (`nav-config agents:read`) and one pre-existing eslint error in `app/(application)/data/components/entity-types.tsx`. Record the counts before you start; a task fails review only if it *adds* to them.
- **Commit per task**, conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `test:`), and end every commit message with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## Review Focus

These are the input classes the spec implies but that no feature step naturally exercises. Each one has its test added to the task that owns the code, named in brackets.

1. **A segment whose text contains a double quote, a comma and a newline** — the CSV export must quote and escape it so the file still parses as four columns, not silently split a row. *Test in Task 5.*
2. **A transcript with zero segments, or segments but no `post_processing` output** — every export format must produce a valid empty document rather than throwing or emitting `undefined`. *Tests in Tasks 4 and 5; the reading view's equivalent is Task 10 step 10, by hand.*
3. **A `corrected_segments` array shorter, longer, or reordered relative to `raw_segments`** — `effectiveSegments` must return the corrected array verbatim and never zip the two by index. *Test in Task 2.*
4. **An item the user may read but not write, opened at `?edit=1`** — the correction UI must not offer Save, and if the server rejects a write anyway the user sees a readable message, not a GraphQL error dump. The server half is already covered by `validateWriteAccess`; the UI half has **no automated test** — this repo has no component-test harness (vitest is node-only), so it is pinned by Task 12 step 10, by hand.
5. **One half of the home union failing** (items errors, jobs succeeds, or vice versa) — the page must render the half that worked with an inline error for the other, never a blank page. The hook returns the two errors separately (Task 7) but asserting on the rendered page needs a component test this repo cannot run — pinned by Task 8 step 6, by hand.

Items 4 and 5 are the two the executor is most likely to skip precisely because there is no failing test to make them go green. They are not optional.

---

# Stage 1 — the library

Tasks 1–10. At the end of Task 10 the feature is shippable: merged home, one composer, reading view, ask box, vocabulary. No transcript is editable yet.

---

### Task 1: Item columns and the backfill

**Files:**
- Modify: `src/templates/contexts/transcriptions.ts`
- Modify: `src/exulu/transcription/build-transcript-item.ts`
- Modify: `src/postgres/init-exulu-db.ts` (insert after the `contextDatabases` call — find it with `grep -n "contextDatabases(" src/postgres/init-exulu-db.ts`)
- Test: `src/exulu/transcription/build-transcript-item.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: five new columns on `transcriptions_items` — `recording_source: string`, `job_id: string`, `recorded_at: Date`, `speaker_count: number`, `project_id: string`. `buildTranscriptItemInput` now fills them. Task 7 and Task 10 read them.

- [ ] **Step 1: Write the failing tests**

Append to `src/exulu/transcription/build-transcript-item.test.ts`:

```ts
describe("buildTranscriptItemInput — denormalised list columns", () => {
  it("carries the pipeline source and the job id", () => {
    const item = buildTranscriptItemInput(
      args({ row: row({ id: "job-42", source: "recall" }) }),
    );
    expect(item.recording_source).toBe("recall");
    expect(item.job_id).toBe("job-42");
  });

  it("defaults the source to whisper when the row predates the column", () => {
    const item = buildTranscriptItemInput(args({ row: row({ source: null }) }));
    expect(item.recording_source).toBe("whisper");
  });

  it("uses join_at as recorded_at for a scheduled meeting", () => {
    const item = buildTranscriptItemInput(
      args({
        row: row({
          source: "recall",
          join_at: "2026-09-10T07:00:00.000Z",
          createdAt: "2026-09-10T09:31:00.000Z",
        }),
      }),
    );
    expect(item.recorded_at).toBe("2026-09-10T07:00:00.000Z");
  });

  it("falls back to the job's createdAt when there is no join_at", () => {
    const item = buildTranscriptItemInput(
      args({ row: row({ join_at: null, createdAt: "2026-09-21T12:00:00.000Z" }) }),
    );
    expect(item.recorded_at).toBe("2026-09-21T12:00:00.000Z");
  });

  it("counts distinct speaker labels, not segments", () => {
    const item = buildTranscriptItemInput(
      args({
        row: row({
          raw_segments: [
            { start: 0, end: 1, text: "a", speaker: "SPEAKER_00" },
            { start: 1, end: 2, text: "b", speaker: "SPEAKER_01" },
            { start: 2, end: 3, text: "c", speaker: "SPEAKER_00" },
          ],
        }),
      }),
    );
    expect(item.speaker_count).toBe(2);
  });

  it("reports zero speakers when there are no segments", () => {
    const item = buildTranscriptItemInput(args({ row: row({ raw_segments: [] }) }));
    expect(item.speaker_count).toBe(0);
  });

  it("carries the project id so the row meta and filter need no join", () => {
    const item = buildTranscriptItemInput(
      args({ row: row({ project_id: "proj-7" }) }),
    );
    expect(item.project_id).toBe("proj-7");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/transcription/build-transcript-item.test.ts`
Expected: FAIL — `item.recording_source` is `undefined`.

- [ ] **Step 3: Declare the five fields on the context**

In `src/templates/contexts/transcriptions.ts`, add to the `fields` array after the `video` field:

```ts
    // Denormalised for the Transcripts home list (spec 2026-09-29 §2.1): the
    // list renders thousands of rows and must not parse raw_segments or join
    // projects per row. NOT named `source` —
    // convertContextToTableDefinition already injects a `source` column
    // (the ingestion source) on every context.
    { name: "recording_source", type: "text", index: true },
    // Back-link to the transcription_jobs row (audio, video, re-review).
    { name: "job_id", type: "uuid" },
    // When the recording happened, not when the item was last touched —
    // the home groups This week / Earlier on this.
    { name: "recorded_at", type: "date", index: true },
    { name: "speaker_count", type: "number" },
    // Read-side copy; projects.project_items stays the source of truth.
    { name: "project_id", type: "uuid", index: true },
```

- [ ] **Step 4: Fill them in the item builder**

In `src/exulu/transcription/build-transcript-item.ts`, add before the closing `});` of the returned object:

```ts
  // Denormalised list columns (spec §2.1).
  recording_source: row.source ?? "whisper",
  job_id: row.id,
  recorded_at: row.join_at ?? row.createdAt,
  speaker_count: new Set(
    (row.raw_segments ?? []).map((segment: { speaker: string }) => segment.speaker),
  ).size,
  project_id: row.project_id ?? undefined,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/exulu/transcription/build-transcript-item.test.ts`
Expected: PASS, all suites in the file.

- [ ] **Step 6: Add the backfill block**

In `src/postgres/init-exulu-db.ts`, immediately after the `await contextDatabases(contexts)` call, insert:

```ts
  // One-time backfill of the Transcripts home list columns (spec
  // 2026-09-29 §2.1). addMissingFields has just added the columns as NULL;
  // it cannot populate them from another table. Idempotent: matches zero
  // rows on every boot after the first.
  if (
    (await knex.schema.hasTable("transcriptions_items")) &&
    (await knex.schema.hasColumn("transcriptions_items", "recording_source"))
  ) {
    const backfilled = await knex.raw(
      `UPDATE transcriptions_items AS i
          SET recording_source = COALESCE(j.source, 'whisper'),
              job_id           = j.id,
              recorded_at      = COALESCE(j.join_at, j."createdAt"),
              project_id       = j.project_id
         FROM transcription_jobs AS j
        WHERE j.saved_item_id = i.id
          AND i.recording_source IS NULL`,
    );
    if (backfilled?.rowCount) {
      console.log(
        `[EXULU] Backfilled transcripts list columns on ${backfilled.rowCount} rows.`,
      );
    }
  }
```

`speaker_count` is deliberately not backfilled: it would mean parsing every stored `raw_segments` blob at boot. Rows saved before this change show no speaker count until their next save, which Task 10's row renderer handles by omitting the segment.

- [ ] **Step 7: Verify the build still type-checks**

Run: `npx tsc --noEmit 2>&1 | tail -20`
Expected: the same 9 pre-existing errors, none in the three files you touched.

- [ ] **Step 8: Commit**

```bash
git add src/templates/contexts/transcriptions.ts \
        src/exulu/transcription/build-transcript-item.ts \
        src/exulu/transcription/build-transcript-item.test.ts \
        src/postgres/init-exulu-db.ts
git commit -m "feat(transcripts): denormalised list columns on transcript items

Adds recording_source, job_id, recorded_at, speaker_count and project_id so
the merged Transcripts home can render rows and filter without parsing
raw_segments or joining projects per row. Columns migrate themselves via
addMissingFields; a one-time backfill fills existing rows from
transcription_jobs.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `effectiveSegments` and timestamped rendering

**Files:**
- Modify: `src/exulu/transcription/transcript-text.ts`
- Test: `src/exulu/transcription/transcript-text.test.ts`

**Interfaces:**
- Consumes: `RawSegment`, `SpeakerMap` from this module (already exported).
- Produces:
  - `effectiveSegments(raw: RawSegment[] | null | undefined, corrected: RawSegment[] | null | undefined): RawSegment[]`
  - `formatClock(seconds: number): string` → `"mm:ss"`, or `"h:mm:ss"` past an hour. **Note:** the frontend's `app/(application)/transcriptions/types.ts` already has its own `formatClock` returning unpadded `"m:ss"` for inline segment times. They are separate modules in separate repos and must stay that way — do not "unify" them; the export formats need the padding, the inline UI does not.
  - `renderTranscript(segments, speakers, options?: { timestamps?: boolean })` — the third argument is new and defaults to `{ timestamps: false }`, so every existing caller is unchanged.
  Tasks 3, 4, 5 and 11 all consume these.

- [ ] **Step 1: Write the failing tests**

Append to `src/exulu/transcription/transcript-text.test.ts`:

```ts
import { effectiveSegments, formatClock } from "./transcript-text";

describe("effectiveSegments", () => {
  const raw = [seg(0, 1, "raw one", "SPEAKER_00"), seg(1, 2, "raw two", "SPEAKER_01")];

  it("returns raw when there are no corrections", () => {
    expect(effectiveSegments(raw, null)).toEqual(raw);
    expect(effectiveSegments(raw, undefined)).toEqual(raw);
  });

  it("returns the corrected array verbatim, never zipped with raw", () => {
    // Shorter, longer and reordered corrections must all survive intact:
    // zipping by index would resurrect deleted text or drop added text.
    const shorter = [seg(0, 1, "fixed", "SPEAKER_00")];
    expect(effectiveSegments(raw, shorter)).toEqual(shorter);

    const longer = [...raw, seg(2, 3, "added", "SPEAKER_00")];
    expect(effectiveSegments(raw, longer)).toEqual(longer);

    const reordered = [raw[1], raw[0]];
    expect(effectiveSegments(raw, reordered)).toEqual(reordered);
  });

  it("prefers an empty corrected array over raw — the user deleted everything", () => {
    expect(effectiveSegments(raw, [])).toEqual([]);
  });

  it("returns an empty array when both are absent", () => {
    expect(effectiveSegments(null, null)).toEqual([]);
    expect(effectiveSegments(undefined, undefined)).toEqual([]);
  });
});

describe("formatClock", () => {
  it("renders mm:ss below an hour", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(9)).toBe("00:09");
    expect(formatClock(1278)).toBe("21:18");
  });

  it("renders h:mm:ss at and past an hour", () => {
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(3661)).toBe("1:01:01");
  });

  it("floors fractional seconds and clamps negatives to zero", () => {
    expect(formatClock(9.87)).toBe("00:09");
    expect(formatClock(-5)).toBe("00:00");
  });
});

describe("renderTranscript with timestamps", () => {
  it("prefixes each block with its start time in brackets", () => {
    const out = renderTranscript(
      [seg(1278, 1299, "Then let's fix the dates.", "SPEAKER_00")],
      { SPEAKER_00: "Anja Keller" },
      { timestamps: true },
    );
    expect(out).toBe("Anja Keller [21:18]: Then let's fix the dates.");
  });

  it("uses the FIRST segment's time when consecutive segments collapse", () => {
    const out = renderTranscript(
      [
        seg(60, 65, "One.", "SPEAKER_00"),
        seg(65, 70, "Two.", "SPEAKER_00"),
      ],
      { SPEAKER_00: "Anja" },
      { timestamps: true },
    );
    expect(out).toBe("Anja [01:00]: One. Two.");
  });

  it("is off by default so existing callers are unchanged", () => {
    const out = renderTranscript([seg(1278, 1299, "Hi", "SPEAKER_00")], {});
    expect(out).toBe("SPEAKER_00: Hi");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/transcription/transcript-text.test.ts`
Expected: FAIL — `effectiveSegments is not a function`.

- [ ] **Step 3: Implement**

In `src/exulu/transcription/transcript-text.ts`, add above `renderTranscript`:

```ts
/**
 * The segments a reader should see: the user's corrections when they exist,
 * otherwise the untouched engine output.
 *
 * Returns the corrected array VERBATIM — never merged or zipped with raw.
 * A correction pass may delete, add or reorder blocks, so index-wise
 * merging would resurrect deleted text. An empty corrected array is a
 * deliberate "the user removed everything", not a missing value.
 */
export const effectiveSegments = (
  raw: RawSegment[] | null | undefined,
  corrected: RawSegment[] | null | undefined,
): RawSegment[] => corrected ?? raw ?? [];

/** "mm:ss", or "h:mm:ss" once the recording passes an hour. */
export const formatClock = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

export type RenderTranscriptOptions = {
  /**
   * Prefix each block with `[mm:ss]`. Used when the transcript is fed to a
   * post-processing prompt, so a summary can cite passages the reading view
   * turns back into seeks (spec §3.1). Off for the stored transcript_text.
   */
  timestamps?: boolean;
};
```

Then replace the body of `renderTranscript` with:

```ts
export const renderTranscript = (
  segments: RawSegment[],
  speakers: SpeakerMap,
  options: RenderTranscriptOptions = {},
): string => {
  if (!segments || segments.length === 0) return "";

  const blocks: { speaker: string; start: number; text: string }[] = [];
  for (const seg of segments) {
    const text = (seg.text ?? "").trim();
    if (!text) continue;
    const label = speakers[seg.speaker] ?? seg.speaker ?? "unknown";
    const last = blocks[blocks.length - 1];
    if (last && last.speaker === label) {
      last.text = `${last.text} ${text}`.trim();
    } else {
      blocks.push({ speaker: label, start: seg.start, text });
    }
  }

  return blocks
    .map((b) =>
      options.timestamps
        ? `${b.speaker} [${formatClock(b.start)}]: ${b.text}`
        : `${b.speaker}: ${b.text}`,
    )
    .join("\n");
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/exulu/transcription/transcript-text.test.ts`
Expected: PASS — the pre-existing `renderTranscript` tests still pass unchanged, which is the point of defaulting `timestamps` to false.

- [ ] **Step 5: Commit**

```bash
git add src/exulu/transcription/transcript-text.ts src/exulu/transcription/transcript-text.test.ts
git commit -m "feat(transcripts): effectiveSegments and timestamped rendering

effectiveSegments picks corrections over raw engine output and returns them
verbatim, so a correction pass may delete, add or reorder blocks. renderTranscript
gains an opt-in timestamps mode for post-processing prompts; the default is
unchanged so transcript_text keeps its current shape.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Feed post-processing a timestamped transcript

**Files:**
- Modify: `src/exulu/recall/service.ts` (in `_runOnePrompt` — find with `grep -n "const transcriptText = renderTranscript" src/exulu/recall/service.ts`)
- Test: `src/exulu/recall/service.test.ts`

**Interfaces:**
- Consumes: `renderTranscript(segments, speakers, { timestamps: true })` from Task 2.
- Produces: nothing new. Post-processing prompts now receive `Speaker [mm:ss]: text` lines, so their output may contain `[mm:ss]` citations for Task 10's linkifier.

- [ ] **Step 1: Write the failing test**

Find the existing describe block that exercises `_runOnePrompt` (`grep -n "_runOnePrompt\|generateText" src/exulu/recall/service.test.ts`) and add a test in the same style as its neighbours, asserting on the prompt string handed to the mocked `generateText`:

```ts
it("feeds the prompt a timestamped transcript so summaries can cite passages", async () => {
  // The reading view turns [mm:ss] in an output back into a seek; the model
  // can only emit them if it saw them.
  await recallService.runOnePostProcessing("job-1", "prompt-1", "agent-1");

  const { prompt } = generateTextMock.mock.calls[0][0];
  expect(prompt).toContain("[21:18]");
  expect(prompt).not.toMatch(/^\s*SPEAKER_\d+: /m);
});
```

Adjust the job fixture in that file so its `raw_segments` contain a segment starting at `1278` seconds. Match the file's existing mocking style for `generateText` — read the top of `src/exulu/recall/service.test.ts` first and reuse its mock name rather than inventing `generateTextMock` if it already has one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/exulu/recall/service.test.ts -t "timestamped transcript"`
Expected: FAIL — the prompt contains `SPEAKER_00: …` with no bracketed time.

- [ ] **Step 3: Pass the option**

In `_runOnePrompt`, change:

```ts
      const transcriptText = renderTranscript(
        job.raw_segments ?? [],
        job.speakers ?? {},
      );
```

to:

```ts
      // Timestamped on purpose: a summary that can cite [mm:ss] becomes
      // clickable in the reading view (spec §3.1). The stored
      // transcript_text stays untimestamped.
      const transcriptText = renderTranscript(
        job.raw_segments ?? [],
        job.speakers ?? {},
        { timestamps: true },
      );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/exulu/recall/service.test.ts`
Expected: PASS, and no other test in the suite regresses.

- [ ] **Step 5: Commit**

```bash
git add src/exulu/recall/service.ts src/exulu/recall/service.test.ts
git commit -m "feat(transcripts): give post-processing prompts a timestamped transcript

A summary can only cite [mm:ss] passages if the model saw them. The stored
transcript_text is unaffected.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The transcript markdown builder

**Files:**
- Create: `src/exulu/transcription/transcript-export.ts`
- Create: `src/exulu/transcription/transcript-export.test.ts`

**Interfaces:**
- Consumes: `RawSegment`, `SpeakerMap`, `effectiveSegments`, `formatClock` from Task 2.
- Produces:

```ts
export type TranscriptExportItem = {
  name?: string | null;
  recording_source?: string | null;
  recorded_at?: string | Date | null;
  duration_seconds?: number | null;
  language?: string | null;
  speakers?: SpeakerMap | null;
  raw_segments?: RawSegment[] | null;
  corrected_segments?: RawSegment[] | null;
  post_processing?: { prompt_name: string | null; status: string; output: string | null }[] | null;
};
export type TranscriptExportOptions = { summary: boolean; timestamps: boolean; speakers: boolean };
export function buildTranscriptMarkdown(item: TranscriptExportItem, options: TranscriptExportOptions): string;
```

Task 5 consumes both. `corrected_segments` is read here even though Task 11 adds the column — the field is optional, so stage 1 simply never populates it.

- [ ] **Step 1: Write the failing tests**

Create `src/exulu/transcription/transcript-export.test.ts`:

```ts
import { buildTranscriptMarkdown, type TranscriptExportItem } from "./transcript-export";

const item = (over: Partial<TranscriptExportItem> = {}): TranscriptExportItem => ({
  name: "Kick-off Comfort-Line",
  recording_source: "recall",
  recorded_at: "2026-09-10T09:00:00.000Z",
  duration_seconds: 3494,
  language: "de",
  speakers: { SPEAKER_00: "Anja Keller", SPEAKER_01: "Marco Schulz" },
  raw_segments: [
    { start: 1278, end: 1299, text: "Then let's fix the dates.", speaker: "SPEAKER_00" },
    { start: 1300, end: 1324, text: "Week 46 works for us.", speaker: "SPEAKER_01" },
  ],
  corrected_segments: null,
  post_processing: [
    { prompt_name: "Meeting summary", status: "done", output: "The team agreed the scope." },
  ],
  ...over,
});

const all = { summary: true, timestamps: true, speakers: true };

describe("buildTranscriptMarkdown", () => {
  it("opens with the title as an H1", () => {
    expect(buildTranscriptMarkdown(item(), all)).toMatch(/^# Kick-off Comfort-Line\n/);
  });

  it("includes the summary section when summary is on", () => {
    const md = buildTranscriptMarkdown(item(), all);
    expect(md).toContain("## Meeting summary");
    expect(md).toContain("The team agreed the scope.");
  });

  it("omits the summary section when summary is off", () => {
    const md = buildTranscriptMarkdown(item(), { ...all, summary: false });
    expect(md).not.toContain("Meeting summary");
    expect(md).toContain("Then let's fix the dates.");
  });

  it("skips failed post-processing outputs rather than printing the error", () => {
    const md = buildTranscriptMarkdown(
      item({ post_processing: [{ prompt_name: "Summary", status: "failed", output: null }] }),
      all,
    );
    expect(md).not.toContain("Summary");
  });

  it("renders a block as bold speaker, bracketed time, then text", () => {
    expect(buildTranscriptMarkdown(item(), all)).toContain(
      "**Anja Keller** [21:18]\n\nThen let's fix the dates.",
    );
  });

  it("drops the timestamp when timestamps are off", () => {
    const md = buildTranscriptMarkdown(item(), { ...all, timestamps: false });
    expect(md).toContain("**Anja Keller**\n\nThen let's fix the dates.");
    expect(md).not.toContain("[21:18]");
  });

  it("falls back to raw labels when speaker names are off", () => {
    const md = buildTranscriptMarkdown(item(), { ...all, speakers: false });
    expect(md).toContain("**SPEAKER_00**");
    expect(md).not.toContain("Anja Keller");
  });

  it("prefers corrected segments over raw", () => {
    const md = buildTranscriptMarkdown(
      item({
        corrected_segments: [
          { start: 1278, end: 1299, text: "Then let us fix the dates.", speaker: "SPEAKER_00" },
        ],
      }),
      all,
    );
    expect(md).toContain("Then let us fix the dates.");
    expect(md).not.toContain("Then let's fix the dates.");
  });

  it("produces a valid document for a transcript with no segments and no summary", () => {
    const md = buildTranscriptMarkdown(
      item({ raw_segments: [], corrected_segments: null, post_processing: null }),
      all,
    );
    expect(md).toMatch(/^# Kick-off Comfort-Line\n/);
    expect(md).not.toContain("undefined");
    expect(md).not.toContain("null");
  });

  it("names an untitled transcript rather than emitting an empty heading", () => {
    const md = buildTranscriptMarkdown(item({ name: null }), all);
    expect(md).toMatch(/^# Transcript\n/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/transcription/transcript-export.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the builder**

Create `src/exulu/transcription/transcript-export.ts`:

```ts
/**
 * Renders a saved transcript item into the export formats offered by the
 * reading view's Export menu (spec 2026-09-29 §3.2).
 *
 * Pure on purpose: the route around it needs a live db and the app
 * singleton, so this module is where the formats are actually testable.
 * Every format reads effectiveSegments, so an export always reflects the
 * user's corrections rather than the raw engine output.
 */
import {
  effectiveSegments,
  formatClock,
  type RawSegment,
  type SpeakerMap,
} from "./transcript-text";

export type TranscriptExportItem = {
  name?: string | null;
  recording_source?: string | null;
  recorded_at?: string | Date | null;
  duration_seconds?: number | null;
  language?: string | null;
  speakers?: SpeakerMap | null;
  raw_segments?: RawSegment[] | null;
  corrected_segments?: RawSegment[] | null;
  post_processing?:
    | { prompt_name: string | null; status: string; output: string | null }[]
    | null;
};

export type TranscriptExportOptions = {
  summary: boolean;
  timestamps: boolean;
  speakers: boolean;
};

type Block = { label: string; start: number; text: string };

/** Consecutive segments by the same resolved speaker collapse into one block. */
const toBlocks = (
  item: TranscriptExportItem,
  useSpeakerNames: boolean,
): Block[] => {
  const segments = effectiveSegments(item.raw_segments, item.corrected_segments);
  const names = item.speakers ?? {};
  const blocks: Block[] = [];
  for (const segment of segments) {
    const text = (segment.text ?? "").trim();
    if (!text) continue;
    const raw = segment.speaker || "unknown";
    const label = useSpeakerNames ? (names[raw] ?? raw) : raw;
    const last = blocks[blocks.length - 1];
    if (last && last.label === label) {
      last.text = `${last.text} ${text}`.trim();
    } else {
      blocks.push({ label, start: segment.start, text });
    }
  }
  return blocks;
};

const metaLine = (item: TranscriptExportItem): string => {
  const parts: string[] = [];
  if (item.recording_source) parts.push(item.recording_source);
  if (item.recorded_at) parts.push(new Date(item.recorded_at).toISOString().slice(0, 10));
  if (item.duration_seconds != null) parts.push(formatClock(item.duration_seconds));
  if (item.language) parts.push(item.language);
  return parts.join(" · ");
};

export function buildTranscriptMarkdown(
  item: TranscriptExportItem,
  options: TranscriptExportOptions,
): string {
  const sections: string[] = [`# ${item.name?.trim() || "Transcript"}`];

  const meta = metaLine(item);
  if (meta) sections.push(meta);

  if (options.summary) {
    for (const output of item.post_processing ?? []) {
      // A failed run has no content worth exporting; printing its error
      // into someone's Word document would be worse than omitting it.
      if (output.status !== "done" || !output.output?.trim()) continue;
      sections.push(`## ${output.prompt_name ?? "Summary"}`);
      sections.push(output.output.trim());
    }
  }

  const blocks = toBlocks(item, options.speakers);
  if (blocks.length > 0) {
    sections.push("## Transcript");
    for (const block of blocks) {
      const heading = options.timestamps
        ? `**${block.label}** [${formatClock(block.start)}]`
        : `**${block.label}**`;
      sections.push(`${heading}\n\n${block.text}`);
    }
  }

  return `${sections.join("\n\n")}\n`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/exulu/transcription/transcript-export.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/exulu/transcription/transcript-export.ts src/exulu/transcription/transcript-export.test.ts
git commit -m "feat(transcripts): markdown builder for transcript export

Builds the export document per request so the three Include options (summary,
timestamps, speaker names) can vary without storing a field. Reads
effectiveSegments, so exports always carry the user's corrections.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: CSV and SRT builders

**Files:**
- Modify: `src/exulu/transcription/transcript-export.ts`
- Modify: `src/exulu/transcription/transcript-export.test.ts`

**Interfaces:**
- Consumes: `TranscriptExportItem`, `TranscriptExportOptions`, the private `toBlocks` from Task 4.
- Produces:
  - `buildTranscriptCsv(item: TranscriptExportItem, options: TranscriptExportOptions): string`
  - `buildTranscriptSrt(item: TranscriptExportItem, options: TranscriptExportOptions): string`

  CSV is **per segment**, not per block — the spec's sample shows one row per block of speech with its own start and end. SRT is per segment for the same reason.

- [ ] **Step 1: Write the failing tests**

Append to `src/exulu/transcription/transcript-export.test.ts`:

```ts
import { buildTranscriptCsv, buildTranscriptSrt } from "./transcript-export";

describe("buildTranscriptCsv", () => {
  it("writes a header row and hh:mm:ss times", () => {
    const lines = buildTranscriptCsv(item(), all).trimEnd().split("\n");
    expect(lines[0]).toBe("start,end,speaker,text");
    expect(lines[1]).toBe(
      '00:21:18,00:21:39,Anja Keller,"Then let\'s fix the dates."',
    );
  });

  it("escapes a quote, a comma and a newline so the row stays four columns", () => {
    // RFC 4180: double the quote, wrap the field. A naive join would turn
    // this one segment into three broken rows.
    const csv = buildTranscriptCsv(
      item({
        raw_segments: [
          {
            start: 0,
            end: 1,
            text: 'He said "yes, absolutely".\nThen he left.',
            speaker: "SPEAKER_00",
          },
        ],
      }),
      all,
    );
    const body = csv.trimEnd().split("\n").slice(1).join("\n");
    expect(body).toBe(
      '00:00:00,00:00:01,Anja Keller,"He said ""yes, absolutely"".\nThen he left."',
    );
  });

  it("drops the time columns when timestamps are off", () => {
    const lines = buildTranscriptCsv(item(), { ...all, timestamps: false })
      .trimEnd()
      .split("\n");
    expect(lines[0]).toBe("speaker,text");
  });

  it("falls back to raw labels when speaker names are off", () => {
    expect(buildTranscriptCsv(item(), { ...all, speakers: false })).toContain("SPEAKER_00");
  });

  it("emits a header-only file for a transcript with no segments", () => {
    const csv = buildTranscriptCsv(item({ raw_segments: [], corrected_segments: null }), all);
    expect(csv).toBe("start,end,speaker,text\n");
  });
});

describe("buildTranscriptSrt", () => {
  it("numbers cues from 1 and uses comma-separated milliseconds", () => {
    expect(buildTranscriptSrt(item(), all)).toBe(
      "1\n00:21:18,000 --> 00:21:39,000\nAnja Keller: Then let's fix the dates.\n\n" +
        "2\n00:21:40,000 --> 00:22:04,000\nMarco Schulz: Week 46 works for us.\n",
    );
  });

  it("keeps fractional seconds as milliseconds", () => {
    const srt = buildTranscriptSrt(
      item({
        raw_segments: [{ start: 1.25, end: 2.5, text: "Hi", speaker: "SPEAKER_00" }],
      }),
      all,
    );
    expect(srt).toContain("00:00:01,250 --> 00:00:02,500");
  });

  it("omits the speaker prefix when speaker names are off and labels are raw", () => {
    const srt = buildTranscriptSrt(item(), { ...all, speakers: false });
    expect(srt).toContain("SPEAKER_00: Then let's fix the dates.");
  });

  it("returns an empty string for a transcript with no segments", () => {
    expect(buildTranscriptSrt(item({ raw_segments: [], corrected_segments: null }), all)).toBe("");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/transcription/transcript-export.test.ts`
Expected: FAIL — `buildTranscriptCsv is not a function`.

- [ ] **Step 3: Implement both builders**

Append to `src/exulu/transcription/transcript-export.ts`:

```ts
/** "hh:mm:ss" from the start of the recording — the CSV time format. */
const formatCsvTime = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
};

/** "hh:mm:ss,mmm" — the SRT cue format (comma before milliseconds). */
const formatSrtTime = (seconds: number): string => {
  const clamped = Math.max(0, seconds);
  const ms = String(Math.round((clamped % 1) * 1000)).padStart(3, "0");
  return `${formatCsvTime(clamped)},${ms}`;
};

/**
 * RFC 4180: a field containing a quote, comma, CR or LF is wrapped in
 * quotes with its own quotes doubled. Skipping this turns one segment
 * containing a comma into two broken columns.
 */
const csvField = (value: string): string =>
  /["\n\r,]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

const resolveLabel = (
  item: TranscriptExportItem,
  rawSpeaker: string,
  useSpeakerNames: boolean,
): string => {
  const raw = rawSpeaker || "unknown";
  return useSpeakerNames ? ((item.speakers ?? {})[raw] ?? raw) : raw;
};

export function buildTranscriptCsv(
  item: TranscriptExportItem,
  options: TranscriptExportOptions,
): string {
  const header = options.timestamps
    ? "start,end,speaker,text"
    : "speaker,text";
  const rows = effectiveSegments(item.raw_segments, item.corrected_segments)
    .filter((segment) => (segment.text ?? "").trim().length > 0)
    .map((segment) => {
      const label = resolveLabel(item, segment.speaker, options.speakers);
      const text = (segment.text ?? "").trim();
      const cells = options.timestamps
        ? [formatCsvTime(segment.start), formatCsvTime(segment.end), label, text]
        : [label, text];
      return cells.map(csvField).join(",");
    });
  return [header, ...rows].join("\n") + "\n";
}

export function buildTranscriptSrt(
  item: TranscriptExportItem,
  options: TranscriptExportOptions,
): string {
  const cues = effectiveSegments(item.raw_segments, item.corrected_segments)
    .filter((segment) => (segment.text ?? "").trim().length > 0)
    .map((segment, index) => {
      const label = resolveLabel(item, segment.speaker, options.speakers);
      const text = (segment.text ?? "").trim();
      return (
        `${index + 1}\n` +
        `${formatSrtTime(segment.start)} --> ${formatSrtTime(segment.end)}\n` +
        `${label}: ${text}\n`
      );
    });
  return cues.length === 0 ? "" : cues.join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/exulu/transcription/transcript-export.test.ts`
Expected: PASS, including the Task 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/exulu/transcription/transcript-export.ts src/exulu/transcription/transcript-export.test.ts
git commit -m "feat(transcripts): CSV and SRT export builders

CSV is RFC 4180 quoted so a segment containing a quote, comma or newline
stays one four-column row. SRT numbers cues from 1 with comma-separated
milliseconds. Both read effectiveSegments.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The export route

**Files:**
- Create: `src/exulu/transcription/export-route.ts`
- Create: `src/exulu/transcription/export-route.test.ts`
- Modify: `src/exulu/markdown-export.ts`
- Modify: `src/exulu/markdown-export.test.ts`
- Modify: `src/exulu/routes.ts` (import near line 68 beside `registerLiveRecordingChunkRoute`; call it beside the other route registrations)

**Interfaces:**
- Consumes: `buildTranscriptMarkdown`, `buildTranscriptCsv`, `buildTranscriptSrt` (Tasks 4–5); `exportMarkdown`, `exportFilename`, `exportContentType` from `src/exulu/markdown-export.ts`.
- Produces: `GET /transcription-items/:itemId/export`, and a widened `ExportFormat = "docx" | "pdf" | "md" | "csv" | "srt"`. Task 13 (the frontend Export menu) calls this route.

Follow the **dependency-injection route pattern** established by `src/exulu/transcription/chunk-route.ts`: the module exports `registerTranscriptExportRoute(app, deps)` taking its collaborators as arguments, so the HTTP contract is unit-testable without a live app. Read `chunk-route.ts` and `chunk-route.test.ts` first and mirror their structure.

- [ ] **Step 1: Widen `ExportFormat` and write its failing tests**

Append to `src/exulu/markdown-export.test.ts`:

```ts
describe("exportContentType — transcript formats", () => {
  it("maps the three new transcript formats", () => {
    expect(exportContentType("md")).toBe("text/markdown; charset=utf-8");
    expect(exportContentType("csv")).toBe("text/csv; charset=utf-8");
    expect(exportContentType("srt")).toBe("application/x-subrip; charset=utf-8");
  });

  it("still maps the two office formats", () => {
    expect(exportContentType("docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(exportContentType("pdf")).toBe("application/pdf");
  });
});

describe("exportFilename — transcript formats", () => {
  it("uses the new extensions", () => {
    expect(exportFilename("Kick-off Comfort-Line", "transcript", "srt")).toBe(
      "Kick-off_Comfort-Line_-_transcript.srt",
    );
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest src/exulu/markdown-export.test.ts`
Expected: FAIL — `exportContentType("md")` returns the PDF type (the current implementation is a binary ternary).

- [ ] **Step 3: Widen the type and the two mappers**

In `src/exulu/markdown-export.ts`, replace the `ExportFormat` type and `exportContentType`:

```ts
/**
 * docx and pdf go through pandoc/LibreOffice (exportMarkdown below). md, csv
 * and srt are built as text by the transcript export builders and never
 * reach a converter.
 */
export type ExportFormat = "docx" | "pdf" | "md" | "csv" | "srt";

const CONTENT_TYPES: Record<ExportFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  srt: "application/x-subrip; charset=utf-8",
};

export function exportContentType(format: ExportFormat): string {
  return CONTENT_TYPES[format];
}
```

And guard `exportMarkdown` so a text format can never reach pandoc — replace its first line:

```ts
export async function exportMarkdown(markdown: string, format: ExportFormat): Promise<Buffer> {
  if (format !== "docx" && format !== "pdf") {
    throw new Error(`exportMarkdown only converts docx and pdf, got '${format}'`);
  }
  const workDir = await mkdtemp(join(tmpdir(), "exulu-md-export-"));
```

`exportFilename` needs no change — it already appends `.${format}`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx jest src/exulu/markdown-export.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route tests**

Create `src/exulu/transcription/export-route.test.ts`, mirroring the deps-injection style of `chunk-route.test.ts`:

```ts
import express from "express";
import request from "supertest";

import { registerTranscriptExportRoute, type TranscriptExportRouteDeps } from "./export-route";

const ITEM = {
  name: "Kick-off Comfort-Line",
  recording_source: "recall",
  recorded_at: "2026-09-10T09:00:00.000Z",
  duration_seconds: 3494,
  language: "de",
  speakers: { SPEAKER_00: "Anja Keller" },
  raw_segments: [
    { start: 1278, end: 1299, text: "Then let's fix the dates.", speaker: "SPEAKER_00" },
  ],
  corrected_segments: null,
  post_processing: null,
};

const app = (over: Partial<TranscriptExportRouteDeps> = {}) => {
  const server = express();
  registerTranscriptExportRoute(server, {
    authenticate: async () => ({ user: { id: 7 } }),
    getItem: async () => ITEM,
    convert: async () => Buffer.from("DOCX"),
    ...over,
  });
  return server;
};

describe("GET /transcription-items/:itemId/export", () => {
  it("401s when the caller is not authenticated", async () => {
    const res = await request(
      app({ authenticate: async () => ({ code: 401, message: "Authentication required" }) }),
    ).get("/transcription-items/item-1/export?format=md");
    expect(res.status).toBe(401);
  });

  it("400s on a format it does not know", async () => {
    const res = await request(app()).get("/transcription-items/item-1/export?format=xlsx");
    expect(res.status).toBe(400);
  });

  it("404s when the item is missing or unreadable", async () => {
    // getItem goes through the context's own getItems({ user }), so an item
    // the caller may not read comes back undefined — the same 404 either way,
    // deliberately: a 403 would confirm the transcript exists.
    const res = await request(app({ getItem: async () => undefined })).get(
      "/transcription-items/item-1/export?format=md",
    );
    expect(res.status).toBe(404);
  });

  it("serves markdown with a download filename", async () => {
    const res = await request(app()).get("/transcription-items/item-1/export?format=md");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.text).toContain("# Kick-off Comfort-Line");
  });

  it("serves csv with a header row", async () => {
    const res = await request(app()).get("/transcription-items/item-1/export?format=csv");
    expect(res.text.split("\n")[0]).toBe("start,end,speaker,text");
  });

  it("serves srt cues", async () => {
    const res = await request(app()).get("/transcription-items/item-1/export?format=srt");
    expect(res.text).toContain("00:21:18,000 --> 00:21:39,000");
  });

  it("routes docx through the converter", async () => {
    const convert = jest.fn(async () => Buffer.from("DOCX"));
    const res = await request(app({ convert })).get(
      "/transcription-items/item-1/export?format=docx",
    );
    expect(res.status).toBe(200);
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it("defaults all three include options to on and honours an explicit 0", async () => {
    const on = await request(app()).get("/transcription-items/item-1/export?format=md");
    expect(on.text).toContain("[21:18]");

    const off = await request(app()).get(
      "/transcription-items/item-1/export?format=md&timestamps=0",
    );
    expect(off.text).not.toContain("[21:18]");
  });

  it("500s with a generic message when the converter fails", async () => {
    const res = await request(
      app({
        convert: async () => {
          throw new Error("pandoc: command not found");
        },
      }),
    ).get("/transcription-items/item-1/export?format=docx");
    expect(res.status).toBe(500);
    expect(res.body.detail).toBe("Export failed.");
    expect(JSON.stringify(res.body)).not.toContain("pandoc");
  });
});
```

If `supertest` is not already a dev dependency (`grep -n supertest package.json`), do not add it — instead call the registered handler directly the way `chunk-route.test.ts` does, keeping the same assertions.

- [ ] **Step 6: Run them to verify they fail**

Run: `npx jest src/exulu/transcription/export-route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement the route module**

Create `src/exulu/transcription/export-route.ts`:

```ts
/**
 * GET /transcription-items/:itemId/export — the reading view's Export menu.
 *
 * Deliberately not the generic markdown-field route
 * (routes.ts /contexts/:contextId/items/:itemId/export): the three Include
 * options mean the document is built per request, so there is no stored
 * field to point at, and csv/srt fall out of the same builders.
 *
 * Built from injected deps so the HTTP contract is unit-testable
 * (export-route.test.ts); routes.ts wires the real ones.
 *
 * Design doc: docs/superpowers/specs/2026-09-29-transcripts-redesign-design.md §3.2
 */
import type { Express, Request, Response } from "express";

import { exportContentType, exportFilename, type ExportFormat } from "../markdown-export";
import {
  buildTranscriptCsv,
  buildTranscriptMarkdown,
  buildTranscriptSrt,
  type TranscriptExportItem,
  type TranscriptExportOptions,
} from "./transcript-export";

export const TRANSCRIPT_EXPORT_ROUTE_PATH = "/transcription-items/:itemId/export";

const FORMATS: ExportFormat[] = ["md", "docx", "pdf", "csv", "srt"];

export type TranscriptExportRouteDeps = {
  authenticate: (
    req: Request,
  ) => Promise<{ user?: { id: number | string; role?: { id?: string } } | null; code?: number; message?: string }>;
  /** Reads through the context's own getItems({ user }), so RBAC applies. */
  getItem: (
    itemId: string,
    user: { id: number | string; role?: { id?: string } },
  ) => Promise<TranscriptExportItem | undefined>;
  /** markdown-export.exportMarkdown — docx/pdf only. */
  convert: (markdown: string, format: "docx" | "pdf") => Promise<Buffer>;
};

/** A query flag is on unless it is explicitly "0" or "false". */
const flag = (value: unknown): boolean => value !== "0" && value !== "false";

export function registerTranscriptExportRoute(
  app: Express,
  deps: TranscriptExportRouteDeps,
): void {
  app.get(TRANSCRIPT_EXPORT_ROUTE_PATH, async (req: Request, res: Response) => {
    const auth = await deps.authenticate(req);
    if (!auth.user?.id) {
      res.status(auth.code || 401).json({ detail: auth.message ?? "Authentication required." });
      return;
    }

    const format = req.query.format as ExportFormat;
    if (!FORMATS.includes(format)) {
      res.status(400).json({ detail: `Query param 'format' must be one of ${FORMATS.join(", ")}.` });
      return;
    }

    const item = await deps.getItem(req.params.itemId as string, auth.user);
    if (!item) {
      // Same 404 for "missing" and "not allowed" — a 403 would confirm the
      // transcript exists to someone who may not know that.
      res.status(404).json({ detail: "Transcript not found, or you do not have access to it." });
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
        body = buildTranscriptCsv(item, options);
      } else if (format === "srt") {
        body = buildTranscriptSrt(item, options);
      } else {
        const markdown = buildTranscriptMarkdown(item, options);
        body = format === "md" ? markdown : await deps.convert(markdown, format);
      }

      const filename = exportFilename(item.name ?? "transcript", "transcript", format);
      res.setHeader("Content-Type", exportContentType(format));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(filename)}"`,
      );
      res.send(body);
    } catch (err) {
      console.error("[EXULU] transcript export failed", err);
      res.status(500).json({ detail: "Export failed." });
    }
  });
}
```

- [ ] **Step 8: Run the route tests to verify they pass**

Run: `npx jest src/exulu/transcription/export-route.test.ts`
Expected: PASS.

- [ ] **Step 9: Wire it in `routes.ts`**

Add beside the existing chunk-route import (around line 68):

```ts
import { registerTranscriptExportRoute } from "./transcription/export-route.ts";
```

and register it next to the call to `registerLiveRecordingChunkRoute` (find it with `grep -n "registerLiveRecordingChunkRoute(" src/exulu/routes.ts`):

```ts
  registerTranscriptExportRoute(app, {
    authenticate: (req) => requestValidators.authenticate(req),
    getItem: async (itemId, user) => {
      const context = contexts?.find((c) => c.id === "transcriptions");
      if (!context) return undefined;
      const [item] = await context.getItems({
        filters: [{ id: { eq: itemId } }],
        fields: [
          "name",
          "recording_source",
          "recorded_at",
          "duration_seconds",
          "language",
          "speakers",
          "raw_segments",
          "corrected_segments",
          "post_processing",
        ],
        user: user as any,
        role: (user as any).role?.id,
      });
      return item as never;
    },
    convert: (markdown, format) => exportMarkdown(markdown, format),
  });
```

`exportMarkdown` is already imported at the top of `routes.ts` (line 5).

- [ ] **Step 10: Type-check and commit**

Run: `npx tsc --noEmit 2>&1 | tail -20`
Expected: the same 9 pre-existing errors, none in the files you touched.

```bash
git add src/exulu/transcription/export-route.ts \
        src/exulu/transcription/export-route.test.ts \
        src/exulu/markdown-export.ts \
        src/exulu/markdown-export.test.ts \
        src/exulu/routes.ts
git commit -m "feat(transcripts): export route for md, docx, pdf, csv and srt

Builds the document per request so the Include options can vary, reusing the
pandoc/LibreOffice helper for docx and pdf. Item access goes through the
context's own getItems, so the same RBAC applies as everywhere else the
transcript is readable; a hidden item 404s rather than 403s.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The merged home data layer

**Files (frontend worktree):**
- Modify: `app/(application)/transcriptions/types.ts`
- Modify: `app/(application)/transcriptions/queries.ts`
- Modify: `app/(application)/transcriptions/hooks.ts`
- Test: `app/(application)/transcriptions/types.test.ts`

**Interfaces:**
- Consumes: `GET_ITEMS` and `PAGINATION_POSTFIX` from `app/(application)/data/queries.ts`; the existing `GET_TRANSCRIPTION_JOBS`.
- Produces:

```ts
export type TranscriptRowKind = "job" | "item";
export type TranscriptState =
  | "recording" | "queued" | "transcribing" | "needs_review" | "failed" | "ready";
export type TranscriptRow = {
  kind: TranscriptRowKind;
  id: string;                  // job id for kind "job", item id for kind "item"
  href: string;                // where the primary action goes
  title: string;
  state: TranscriptState;
  summaryLine: string | null;
  recordedAt: string;          // ISO
  source: JobSource | null;
  durationSeconds: number | null;
  speakerCount: number | null;
  projectId: string | null;
  rightsMode: Mode | null;
  createdBy: number | null;
  job?: Job;                   // present for kind "job" — the row renderer needs bot status etc.
};
export type TranscriptTab = "all" | "needs_review" | "mine" | "shared";
export function mergeTranscriptRows(jobs: Job[], items: TranscriptItem[]): TranscriptRow[];
export function filterTranscriptRows(rows: TranscriptRow[], tab: TranscriptTab, currentUserId: number): TranscriptRow[];
export function groupTranscriptRows(rows: TranscriptRow[], now: Date): { thisWeek: TranscriptRow[]; earlier: TranscriptRow[] };
```

Task 8 renders these.

- [ ] **Step 1: Write the failing tests**

Append to `app/(application)/transcriptions/types.test.ts`:

```ts
import {
  mergeTranscriptRows,
  filterTranscriptRows,
  groupTranscriptRows,
  type TranscriptItem,
} from "./types";

function item(overrides: Partial<TranscriptItem>): TranscriptItem {
  return {
    id: "item-1",
    name: "Kick-off Comfort-Line",
    recording_source: "recall",
    job_id: "job-1",
    recorded_at: "2026-09-10T09:00:00.000Z",
    duration_seconds: 3494,
    speaker_count: 6,
    project_id: "proj-1",
    rights_mode: "private",
    created_by: 1,
    post_processing: null,
    ...overrides,
  };
}

describe("mergeTranscriptRows", () => {
  it("keeps in-progress jobs and ready items in one list", () => {
    const rows = mergeTranscriptRows(
      [job({ id: "job-9", status: "awaiting_review", title: "Fertigungsplanung" })],
      [item({ id: "item-1" })],
    );
    expect(rows.map((r) => r.id).sort()).toEqual(["item-1", "job-9"]);
  });

  it("never lists a saved job twice — its content is the item", () => {
    // The jobs query only asks for ACTIVE_STATUSES, but a job can be saved
    // between the two queries resolving. It must not appear beside its item.
    const rows = mergeTranscriptRows(
      [job({ id: "job-1", status: "saved", saved_item_id: "item-1" })],
      [item({ id: "item-1", job_id: "job-1" })],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("item");
  });

  it("points a needs-review job at the review route and an item at the reading view", () => {
    const rows = mergeTranscriptRows(
      [job({ id: "job-9", status: "awaiting_review" })],
      [item({ id: "item-1" })],
    );
    expect(rows.find((r) => r.id === "job-9")!.href).toBe("/transcriptions/review/job-9");
    expect(rows.find((r) => r.id === "item-1")!.href).toBe("/transcriptions/item-1");
  });

  it("sorts newest first by recorded_at across both sources", () => {
    const rows = mergeTranscriptRows(
      [job({ id: "older-job", status: "awaiting_review", createdAt: "2026-09-01T00:00:00Z" })],
      [item({ id: "newer-item", recorded_at: "2026-09-20T00:00:00.000Z" })],
    );
    expect(rows.map((r) => r.id)).toEqual(["newer-item", "older-job"]);
  });

  it("maps job statuses onto display states", () => {
    const rows = mergeTranscriptRows(
      [
        job({ id: "a", status: "recording" }),
        job({ id: "b", status: "transcribing" }),
        job({ id: "c", status: "awaiting_review" }),
        job({ id: "d", status: "failed" }),
      ],
      [],
    );
    expect(rows.map((r) => r.state).sort()).toEqual(
      ["failed", "needs_review", "recording", "transcribing"],
    );
  });

  it("leaves speakerCount null for an item saved before the column existed", () => {
    const rows = mergeTranscriptRows([], [item({ speaker_count: null })]);
    expect(rows[0].speakerCount).toBeNull();
  });
});

describe("filterTranscriptRows", () => {
  const rows = mergeTranscriptRows(
    [job({ id: "job-9", status: "awaiting_review" })],
    [item({ id: "mine", created_by: 1 }), item({ id: "theirs", created_by: 2 })],
  );

  it("'all' keeps everything", () => {
    expect(filterTranscriptRows(rows, "all", 1)).toHaveLength(3);
  });

  it("'needs_review' keeps only jobs awaiting review", () => {
    expect(filterTranscriptRows(rows, "needs_review", 1).map((r) => r.id)).toEqual(["job-9"]);
  });

  it("'mine' keeps items I created", () => {
    expect(filterTranscriptRows(rows, "mine", 1).map((r) => r.id)).toEqual(["mine"]);
  });

  it("'shared' keeps readable items I did NOT create", () => {
    expect(filterTranscriptRows(rows, "shared", 1).map((r) => r.id)).toEqual(["theirs"]);
  });
});

describe("groupTranscriptRows", () => {
  const now = new Date("2026-09-29T12:00:00.000Z");

  it("puts the last seven days in This week and the rest in Earlier", () => {
    const rows = mergeTranscriptRows(
      [],
      [
        item({ id: "recent", recorded_at: "2026-09-26T09:00:00.000Z" }),
        item({ id: "old", recorded_at: "2026-09-10T09:00:00.000Z" }),
      ],
    );
    const { thisWeek, earlier } = groupTranscriptRows(rows, now);
    expect(thisWeek.map((r) => r.id)).toEqual(["recent"]);
    expect(earlier.map((r) => r.id)).toEqual(["old"]);
  });

  it("treats a future recorded_at as this week rather than hiding it", () => {
    // A scheduled meeting bot has a join_at in the future; the row must not
    // fall off the bottom of the list.
    const rows = mergeTranscriptRows([], [item({ id: "scheduled", recorded_at: "2026-10-02T09:00:00.000Z" })]);
    expect(groupTranscriptRows(rows, now).thisWeek.map((r) => r.id)).toEqual(["scheduled"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run "app/(application)/transcriptions/types.test.ts"`
Expected: FAIL — `mergeTranscriptRows is not a function`.

- [ ] **Step 3: Add the types and pure helpers**

Append to `app/(application)/transcriptions/types.ts`:

```ts
/** A saved transcript as it comes back from transcriptions_itemsPagination. */
export type TranscriptItem = {
  id: string;
  name: string | null;
  recording_source: JobSource | null;
  job_id: string | null;
  recorded_at: string | null;
  duration_seconds: number | null;
  speaker_count: number | null;
  project_id: string | null;
  rights_mode: Mode | null;
  created_by: number | null;
  post_processing: PostProcessingOutput[] | string | null;
};

export type TranscriptRowKind = "job" | "item";

export type TranscriptState =
  | "recording"
  | "queued"
  | "transcribing"
  | "needs_review"
  | "failed"
  | "ready";

export type TranscriptRow = {
  kind: TranscriptRowKind;
  id: string;
  href: string;
  title: string;
  state: TranscriptState;
  summaryLine: string | null;
  recordedAt: string;
  source: JobSource | null;
  durationSeconds: number | null;
  speakerCount: number | null;
  projectId: string | null;
  rightsMode: Mode | null;
  createdBy: number | null;
  /** Only for kind "job" — the row renderer needs bot status, error, chunk heartbeat. */
  job?: Job;
};

export type TranscriptTab = "all" | "needs_review" | "mine" | "shared";

const JOB_STATE: Partial<Record<JobStatus, TranscriptState>> = {
  recording: "recording",
  queued: "queued",
  transcribing: "transcribing",
  awaiting_review: "needs_review",
  failed: "failed",
};

/** First non-empty post-processing output, trimmed to one line for the row. */
function itemSummaryLine(item: TranscriptItem): string | null {
  const outputs = parsePostProcessingOutputs(item.post_processing);
  const first = outputs.find((o) => o.status === "done" && o.output?.trim());
  if (!first?.output) return null;
  return first.output.trim().split("\n")[0] ?? null;
}

/**
 * One list across the two stores (spec §1.1). In-progress work comes from
 * transcription_jobs (creator-only); everything ready comes from the RBAC'd
 * knowledge items. A saved job contributes nothing — its content IS the item —
 * which is what keeps the union duplicate-free.
 */
export function mergeTranscriptRows(
  jobs: Job[],
  items: TranscriptItem[],
): TranscriptRow[] {
  const itemRows: TranscriptRow[] = items.map((item) => ({
    kind: "item",
    id: item.id,
    href: `/transcriptions/${item.id}`,
    title: item.name?.trim() || "Untitled transcript",
    state: "ready",
    summaryLine: itemSummaryLine(item),
    recordedAt: item.recorded_at ?? new Date(0).toISOString(),
    source: item.recording_source ?? null,
    durationSeconds: item.duration_seconds,
    speakerCount: item.speaker_count,
    projectId: item.project_id,
    rightsMode: item.rights_mode,
    createdBy: item.created_by,
  }));

  const claimedJobIds = new Set(
    items.map((item) => item.job_id).filter((id): id is string => !!id),
  );

  const jobRows: TranscriptRow[] = jobs
    .filter((job) => {
      // A job that already produced an item is represented by that item.
      if (job.status === "saved" || job.status === "cancelled") return false;
      if (job.saved_item_id) return false;
      return !claimedJobIds.has(job.id);
    })
    .map((job) => ({
      kind: "job",
      id: job.id,
      href: `/transcriptions/review/${job.id}`,
      title: displayTitle(job),
      state: JOB_STATE[job.status] ?? "queued",
      summaryLine: null,
      recordedAt: job.join_at ?? job.createdAt,
      source: job.source ?? null,
      durationSeconds: job.duration_seconds,
      speakerCount: null,
      projectId: job.project_id,
      rightsMode: job.target_rights_mode,
      createdBy: job.created_by,
      job,
    }));

  return [...itemRows, ...jobRows].sort(
    (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
  );
}

export function filterTranscriptRows(
  rows: TranscriptRow[],
  tab: TranscriptTab,
  currentUserId: number,
): TranscriptRow[] {
  switch (tab) {
    case "needs_review":
      return rows.filter((row) => row.state === "needs_review");
    case "mine":
      return rows.filter(
        (row) => row.kind === "item" && row.createdBy === currentUserId,
      );
    case "shared":
      return rows.filter(
        (row) => row.kind === "item" && row.createdBy !== currentUserId,
      );
    default:
      return rows;
  }
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function groupTranscriptRows(
  rows: TranscriptRow[],
  now: Date,
): { thisWeek: TranscriptRow[]; earlier: TranscriptRow[] } {
  const cutoff = now.getTime() - WEEK_MS;
  const thisWeek: TranscriptRow[] = [];
  const earlier: TranscriptRow[] = [];
  for (const row of rows) {
    // A scheduled meeting bot's join_at is in the future; it belongs at the
    // top of the list, not silently in Earlier.
    if (new Date(row.recordedAt).getTime() >= cutoff) thisWeek.push(row);
    else earlier.push(row);
  }
  return { thisWeek, earlier };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run "app/(application)/transcriptions/types.test.ts"`
Expected: PASS.

- [ ] **Step 5: Add the items query**

Append to `app/(application)/transcriptions/queries.ts`:

```ts
/**
 * Saved transcripts, through the generic per-context pagination. Items carry
 * the RBAC the home's Shared-with-me tab, search and filters all rely on, so
 * this needs no bespoke resolver (spec §1.1).
 */
export const GET_TRANSCRIPT_ITEMS = gql`
  query TranscriptItems(
    $page: Int!
    $limit: Int!
    $filters: [FilterTranscriptions_items]
    $sort: SortBy = { field: "recorded_at", direction: DESC }
  ) {
    transcriptions_itemsPagination(page: $page, limit: $limit, filters: $filters, sort: $sort) {
      pageInfo {
        itemCount
        hasNextPage
      }
      items {
        id
        name
        recording_source
        job_id
        recorded_at
        duration_seconds
        speaker_count
        project_id
        rights_mode
        created_by
        post_processing
      }
    }
  }
`;
```

- [ ] **Step 6: Rewrite the hook**

In `app/(application)/transcriptions/hooks.ts`, replace `useTranscriptionJobs` with `useTranscripts`. Keep the existing jobs query and its conditional polling verbatim; add the items query beside it, and surface the two errors separately so Task 8 can render a half list.

```ts
export interface TranscriptsResult {
  rows: TranscriptRow[];
  /** Saved jobs that share a meeting_url with a currently-failed job — the
   *  input to findRecoveredJob. Empty unless something actually failed. */
  recoveredJobs: Job[];
  needsReviewCount: number;
  initialLoading: boolean;
  /** Set when the in-progress half failed; the ready half may still be fine. */
  jobsError?: Error;
  /** Set when the ready half failed; the in-progress half may still be fine. */
  itemsError?: Error;
  canLoadMore: boolean;
  loadMore: () => void;
  refetchAll: () => void;
}

const ITEMS_PAGE_SIZE = 50;

export function useTranscripts(search: string): TranscriptsResult {
  const active = useQuery<JobsResult>(GET_TRANSCRIPTION_JOBS, {
    variables: { filters: [{ status: { in: [...ACTIVE_STATUSES] } }] },
    fetchPolicy: "cache-and-network",
  });

  const [limit, setLimit] = React.useState(ITEMS_PAGE_SIZE);
  const items = useQuery<{
    transcriptions_itemsPagination: {
      pageInfo?: { itemCount?: number | null; hasNextPage?: boolean | null } | null;
      items: TranscriptItem[];
    };
  }>(GET_TRANSCRIPT_ITEMS, {
    variables: {
      page: 1,
      limit,
      filters: search
        ? [{ archived: { eq: false }, name: { contains: search } }]
        : [{ archived: { eq: false } }],
    },
    fetchPolicy: "cache-and-network",
  });

  const jobs = React.useMemo(
    () => active.data?.transcription_jobsPagination?.items ?? [],
    [active.data],
  );
  const transcripts = React.useMemo(
    () => items.data?.transcriptions_itemsPagination?.items ?? [],
    [items.data],
  );

  const rows = React.useMemo(
    () => mergeTranscriptRows(jobs, transcripts),
    [jobs, transcripts],
  );

  // Poll only while something is genuinely in motion — unchanged from the
  // previous hook (page-doc ladder row 3).
  const hasRunning = jobs.some(
    (job) =>
      job.status === "queued" ||
      job.status === "transcribing" ||
      job.status === "recording",
  );
  const { startPolling, stopPolling } = active;
  React.useEffect(() => {
    if (!hasRunning) return;
    startPolling(POLL_INTERVAL_MS);
    return () => stopPolling();
  }, [hasRunning, startPolling, stopPolling]);

  // findRecoveredJob (the 2026-09-22 "4 recordings reported lost" incident)
  // links a failed meeting job to the retry that succeeded. Both are
  // creator-only job rows and only the creator sees the failed one, so the
  // lookup stays on the jobs side — one targeted query, and only when there
  // is actually a failed meeting job to explain.
  const failedMeetingUrls = React.useMemo(
    () =>
      jobs
        .filter((job) => job.status === "failed" && !!job.meeting_url)
        .map((job) => job.meeting_url as string),
    [jobs],
  );
  const recovered = useQuery<JobsResult>(GET_TRANSCRIPTION_JOBS, {
    skip: failedMeetingUrls.length === 0,
    variables: {
      filters: [{ status: { eq: "saved" }, meeting_url: { in: failedMeetingUrls } }],
    },
    fetchPolicy: "cache-and-network",
  });
  const recoveredJobs = React.useMemo(
    () => recovered.data?.transcription_jobsPagination?.items ?? [],
    [recovered.data],
  );

  const { refetch: refetchJobs } = active;
  const { refetch: refetchItems } = items;

  return {
    rows,
    recoveredJobs,
    needsReviewCount: rows.filter((row) => row.state === "needs_review").length,
    initialLoading:
      (active.loading && !active.data) || (items.loading && !items.data),
    jobsError: active.error as Error | undefined,
    itemsError: items.error as Error | undefined,
    canLoadMore:
      !!items.data?.transcriptions_itemsPagination?.pageInfo?.hasNextPage,
    loadMore: () => setLimit((current) => current + ITEMS_PAGE_SIZE),
    refetchAll: () => {
      void refetchJobs();
      void refetchItems();
    },
  };
}
```

Add the imports it needs (`GET_TRANSCRIPT_ITEMS`, `mergeTranscriptRows`, `TranscriptItem`, `TranscriptRow`). Leave `useRecordingUsage`, `useProjectOptions`, `useTicker` and `usePostProcessingOptions` untouched.

- [ ] **Step 7: Verify the suite and lint**

Run: `npx vitest run "app/(application)/transcriptions"` and `npx eslint "app/(application)/transcriptions"`
Expected: tests PASS; lint reports nothing new.

- [ ] **Step 8: Commit**

```bash
git add "app/(application)/transcriptions/types.ts" \
        "app/(application)/transcriptions/types.test.ts" \
        "app/(application)/transcriptions/queries.ts" \
        "app/(application)/transcriptions/hooks.ts"
git commit -m "feat(transcripts): merge jobs and saved transcripts into one list

useTranscripts unions the creator-only jobs query with the RBAC'd
transcriptions items pagination, so Shared with me, search and filters come
from the item's existing rights instead of a new resolver. A saved job is
represented by its item, never listed twice. The two halves surface their
errors separately so one failure cannot blank the page.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The home page

**Files (frontend worktree):**
- Modify: `app/(application)/transcriptions/page.tsx`
- Create: `app/(application)/transcriptions/components/transcript-row.tsx`
- Create: `app/(application)/transcriptions/components/in-progress-strip.tsx`
- Modify: `messages/en.json`, `messages/de.json`

**Interfaces:**
- Consumes: `useTranscripts`, `filterTranscriptRows`, `groupTranscriptRows`, `TranscriptRow`, `TranscriptTab` (Task 7); `JobRow` and `findRecoveredJob` (existing).
- Produces: `/transcriptions`, plus these two component contracts. Write them exactly as given — Task 12 does not touch them, but a reviewer checks them against Task 7's types.

```tsx
// components/transcript-row.tsx
export interface TranscriptRowProps {
  row: TranscriptRow;
  currentUserId: number;
  /** Faint until any row is selected (design: "checkboxes are faint until something is selected"). */
  anySelected: boolean;
  selected: boolean;
  /** Absent for kind "job" — bulk actions apply to knowledge items only. */
  onSelectedChange?: (selected: boolean) => void;
}

// components/in-progress-strip.tsx
export interface InProgressStripProps {
  /** recording | queued | transcribing rows, collapsed behind "N in progress". */
  running: TranscriptRow[];
  /** Never folded away — always rendered below the strip. */
  failed: TranscriptRow[];
  /** From useTranscripts; fed to findRecoveredJob per failed row. */
  recoveredJobs: Job[];
  onChanged: () => void;
}
```

- [ ] **Step 1: Add the i18n keys**

Add to the `transcriptions` object in `messages/en.json`:

```json
"tabs": { "all": "All", "needsReview": "Needs review", "mine": "Mine", "shared": "Shared with me" },
"groups": { "thisWeek": "This week", "earlier": "Earlier" },
"inProgress": { "label": "{count, plural, one {# in progress} other {# in progress}}", "expand": "Show what is running", "collapse": "Hide" },
"row": { "review": "Review", "open": "Open", "onlyYou": "Only you", "everyone": "Everyone", "sharedWithYou": "Shared with you", "people": "{count, plural, one {# person} other {# people}}", "speakers": "{count, plural, one {# speaker} other {# speakers}}", "summaryPending": "Summary runs when you save the review" },
"errors": { "inProgressFailed": "The list of recordings in progress could not be loaded.", "transcriptsFailed": "Saved transcripts could not be loaded." },
"filter": { "label": "Filter", "source": "Source", "project": "Project", "date": "Date", "clear": "Clear filters" }
```

and the German equivalents in `messages/de.json`, using "Transkripte" for the page and these state labels from the handoff: `Aufnahme läuft`, `In Warteschlange`, `Wird transkribiert`, `Prüfung nötig`, `Bereit`, `Fehlgeschlagen`.

Run `node scripts/check-messages.js` — it must report no missing keys in either locale.

- [ ] **Step 2: Build the row component**

Create `app/(application)/transcriptions/components/transcript-row.tsx` rendering one `TranscriptRow`: checkbox (faint until something is selected, disabled with a tooltip for `kind: "job"`), title, an amber "Needs review" `Badge` when `state === "needs_review"`, the summary line (or `row.summaryPending` for a needs-review row), the meta line (`source · date · duration · speakers · project`, omitting any segment whose value is null so a pre-backfill row degrades quietly), the access indicator (lock + Only you for `private`, people icon + count otherwise, "Shared with you" when `createdBy !== currentUserId`), and one action `Button` linking to `row.href` labelled Review or Open.

- [ ] **Step 3: Build the in-progress strip**

Create `app/(application)/transcriptions/components/in-progress-strip.tsx`: a collapsed `<button aria-expanded>` reading "N in progress" with a one-line summary, expanding to the existing `JobRow` for each running job. **Failed jobs always render below the strip, never inside it** — a problem is never folded away. Keep the existing `findRecoveredJob` linkage: when the visible rows contain failed meeting jobs, the strip is handed the saved jobs the hook fetched for that purpose.

- [ ] **Step 4: Rewrite the page**

Rewrite `page.tsx` around `useTranscripts(query)`: `PageHeader` with the "…" menu and the primary "New transcript" button, a tab row (All / Needs review with an amber count / Mine / Shared with me) with search to its right and one Filter button, the in-progress strip, then `groupTranscriptRows` rendering This week / Earlier sections of `TranscriptRow`.

Keep from the current page: the `?new=1` composer convention, `MobileTopbarAction`, the recording-usage bar, the `PageShell variant="content"` wrapper (widen `max-w-4xl` to the default), the empty state, and `data-demo-id="transcriptions"`.

Render `jobsError` and `itemsError` as inline `Alert`s above the list rather than replacing it, so one failed half never blanks the page.

Add a redirect for the old deep link at the top of the page component:

```tsx
  // The review sheet became a page (spec §1.2); keep old links working.
  const legacyReviewId = searchParams.get("review");
  React.useEffect(() => {
    if (legacyReviewId) router.replace(`/transcriptions/review/${legacyReviewId}`);
  }, [legacyReviewId, router]);
```

- [ ] **Step 5: Wire the bulk bar**

Import `ItemsActionBar` and `BulkAccessDialog` from `app/(application)/data/[ctx]/components/` and mount them when the selection is non-empty, passing only item-kind ids. Share uses the existing `BULK_UPDATE_ITEM_RBAC(context)` mutation from `app/(application)/data/queries.ts`. Read those three files first and match their prop contracts exactly rather than guessing.

- [ ] **Step 6: Verify**

Run: `npx vitest run "app/(application)/transcriptions"`, `npx eslint "app/(application)/transcriptions"`, `node scripts/check-messages.js`
Expected: tests PASS, no new lint findings, no missing message keys.

Then run the app (`npm run dev`) and confirm by hand: the tabs filter, the in-progress strip expands, a failed job shows below it with its recovery action, grouping splits This week / Earlier, and selecting a row reveals the bulk bar.

- [ ] **Step 7: Commit**

```bash
git add "app/(application)/transcriptions" messages/en.json messages/de.json
git commit -m "feat(transcripts): one home list with tabs, in-progress strip and bulk actions

Replaces the three status groups with a single list across jobs and saved
transcripts. Problems are never folded away: failed jobs sit below the
collapsed in-progress strip with their reason and one recovery action. Bulk
share, move and delete reuse the knowledge action bar and bulk RBAC mutation.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: One composer dialog

**Files (frontend worktree):**
- Create: `app/(application)/transcriptions/components/new-transcript-dialog.tsx`
- Modify: `app/(application)/transcriptions/components/composer.tsx`
- Modify: `app/(application)/transcriptions/components/meeting-composer.tsx`
- Modify: `app/(application)/transcriptions/components/record-composer.tsx`
- Modify: `app/(application)/transcriptions/page.tsx`
- Modify: `messages/en.json`, `messages/de.json`

**Interfaces:**
- Consumes: the three existing composer components and the `ConfigContext` flags `whisper.enabled`, `recall.enabled`, `transcription.enabled`.
- Produces:

```tsx
// components/new-transcript-dialog.tsx
export type ComposerMode = "audio" | "meeting" | "record";

export interface NewTranscriptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A job was started — the home refetches. The dialog closes itself, except
   *  in record mode, where the recorder owns its own close-out. */
  onStarted: () => void;
}
```

Nothing later depends on it.

- [ ] **Step 1: Add the i18n keys**

Add to `transcriptions.composer` in both locales:

```json
"dialogTitle": "New transcript",
"notSetUp": "Not set up in this workspace yet.",
"notSetUpHint": "An admin can connect it in Transcript settings.",
"askAdmin": "Ask an admin",
"optionsSummaryLabel": "Project, sharing and summaries",
"optionsChange": "Change"
```

- [ ] **Step 2: Build the dialog shell**

Create `new-transcript-dialog.tsx`: a `Dialog` with `DialogContent className="sm:max-w-[680px]"`, `DialogTitle` from `composer.dialogTitle`, and a three-way source switch built from `ToggleGroup` over `["audio", "meeting", "record"]`.

Unlike today's `enabledModes`, **every** source renders. A source whose flag is off renders as a disabled `ToggleGroupItem`; selecting it is impossible, and when it is the only source the body shows the not-set-up note plus the "Ask an admin" link instead of a composer. Mobile ordering still puts `record` first (`useIsMobile()`), and an active recording still pins the surface to `record` and hides the switch.

- [ ] **Step 3: Move the composers inside**

Render the three existing composers in the dialog body. Remove each one's own Cancel button and outer card chrome — the dialog owns the footer now — and pass the primary action label up so the footer can read "Start transcription", "Send bot now" or "Start recording". Do not touch their internal logic: the live recorder's close-out (`pendingCloseout` / `activeJobId` / `beginCloseout`) must keep working exactly as it does today.

- [ ] **Step 4: Collapse the options into a summary row**

In each composer, replace the always-open Project / Sharing / summary-preset block with a `<button aria-expanded>` showing the current values on one line ("Comfort-Line · Only me · Meeting summary, Action items") and a "Change" affordance that expands the existing controls unchanged. The chevron rotates 180° when open.

- [ ] **Step 5: Mount it from the page**

In `page.tsx`, replace the inline composer block with `<NewTranscriptDialog open={composerVisible} onOpenChange={(open) => !open && closeComposer()} onStarted={refetchAll} />`.

- [ ] **Step 6: Verify**

Run: `npx eslint "app/(application)/transcriptions"`, `node scripts/check-messages.js`
Then by hand, with the dev server: all three sources appear; an unconfigured one is disabled with the note; upload, meeting-bot and record each still start a job; a recording in progress reopens the dialog pinned to Record and the close-out still uploads.

- [ ] **Step 7: Commit**

```bash
git add "app/(application)/transcriptions" messages/en.json messages/de.json
git commit -m "feat(transcripts): one New transcript dialog for all three sources

Re-houses the upload, meeting-bot and record composers behind one source
switch. An unconfigured source now stays visible with an ask-an-admin note
instead of vanishing, and project/sharing/summary options collapse into a
summary row. The live-recording close-out path is untouched.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Reading view and the ask box

**Files (frontend worktree):**
- Create: `app/(application)/transcriptions/[itemId]/page.tsx`
- Create: `app/(application)/transcriptions/components/transcript-document.tsx`
- Create: `app/(application)/transcriptions/components/ask-box.tsx`
- Create: `app/(application)/transcriptions/linkify.ts`
- Create: `app/(application)/transcriptions/linkify.test.ts`
- Modify: `app/(application)/transcriptions/queries.ts`
- Modify: `app/(application)/chat/components/composer.tsx`
- Modify: `messages/en.json`, `messages/de.json`

**Interfaces:**
- Consumes: `AudioTimeline`, `MeetingVideoPlayer`, `speakerColor`, `parseSegments`, `parseSpeakers`, `parsePostProcessingOutputs` (all existing in this feature module); `ItemAccessSection` from `data/[ctx]/components/`.
- Produces `parseTimestampRefs` plus the two component contracts below. **Task 12 renders `TranscriptDocument` with `mode="edit"`, so these names and types are a contract, not a suggestion.**

```tsx
// linkify.ts
export function parseTimestampRefs(
  markdown: string,
): { text: string; seconds: number | null }[];

// components/transcript-document.tsx
export interface TranscriptDocumentProps {
  item: TranscriptItemDetail;          // GET_TRANSCRIPT_ITEM's shape
  mode: "read" | "edit";
  /** edit mode only; absent in read mode. Task 12 wires these. */
  onSave?: (draft: TranscriptDraft) => Promise<void>;
  onDiscard?: () => void;
  /** False when the viewer may read but not write — edit mode renders
   *  read-only with an explanation instead of a Save button. */
  canWrite?: boolean;
}

export type TranscriptDraft = {
  title: string;
  speakers: Record<string, string>;
  correctedSegments: Segment[] | null;   // null = untouched, do not write
  projectId: string | null;
  rightsMode: Mode;
  rbacUsers: RbacUser[];
  rbacRoles: RbacRole[];
};

// components/ask-box.tsx
export interface AskBoxProps {
  itemId: string;
  /** Two questions that fill the input without sending. */
  suggestions: string[];
}
```

- [ ] **Step 1: Write the failing linkifier tests**

Create `app/(application)/transcriptions/linkify.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parseTimestampRefs } from "./linkify";

describe("parseTimestampRefs", () => {
  it("splits a bracketed mm:ss reference out of the surrounding prose", () => {
    expect(parseTimestampRefs("We agreed the scope [21:40] and moved on.")).toEqual([
      { text: "We agreed the scope ", seconds: null },
      { text: "21:40", seconds: 1300 },
      { text: " and moved on.", seconds: null },
    ]);
  });

  it("handles h:mm:ss", () => {
    expect(parseTimestampRefs("[1:02:03]")).toEqual([{ text: "1:02:03", seconds: 3723 }]);
  });

  it("finds several references in one line", () => {
    const parts = parseTimestampRefs("First [00:30] then [01:00].");
    expect(parts.filter((p) => p.seconds !== null).map((p) => p.seconds)).toEqual([30, 60]);
  });

  it("leaves text with no references as one plain part", () => {
    expect(parseTimestampRefs("Nothing to link here.")).toEqual([
      { text: "Nothing to link here.", seconds: null },
    ]);
  });

  it("ignores a bracketed value that is not a time", () => {
    // Markdown links and footnotes must survive untouched.
    expect(parseTimestampRefs("See [the doc](x) and [1].")).toEqual([
      { text: "See [the doc](x) and [1].", seconds: null },
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(parseTimestampRefs("")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run "app/(application)/transcriptions/linkify.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the linkifier**

Create `app/(application)/transcriptions/linkify.ts`:

```ts
/**
 * Splits post-processing output into plain text and [mm:ss] / [h:mm:ss]
 * passage references, which the reading view renders as seek buttons.
 *
 * This is the whole of the spec's "passage references" feature: the
 * timestamped transcript (backend §3.1) lets a summary prompt cite a time,
 * and this turns the citation back into a seek. No stored reference model.
 */
const TIMESTAMP = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;

const toSeconds = (clock: string): number => {
  const parts = clock.split(":").map(Number);
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
};

export function parseTimestampRefs(
  markdown: string,
): { text: string; seconds: number | null }[] {
  if (!markdown) return [];
  const parts: { text: string; seconds: number | null }[] = [];
  let cursor = 0;
  for (const match of markdown.matchAll(TIMESTAMP)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      parts.push({ text: markdown.slice(cursor, start), seconds: null });
    }
    parts.push({ text: match[1], seconds: toSeconds(match[1]) });
    cursor = start + match[0].length;
  }
  if (cursor < markdown.length) {
    parts.push({ text: markdown.slice(cursor), seconds: null });
  }
  return parts;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run "app/(application)/transcriptions/linkify.test.ts"`
Expected: PASS.

- [ ] **Step 5: Add the single-item query**

Append to `app/(application)/transcriptions/queries.ts` a `GET_TRANSCRIPT_ITEM` selecting the same fields as `GET_TRANSCRIPT_ITEMS` plus `transcript_text`, `raw_segments`, `corrected_segments`, `speakers`, `language`, `audio_s3key`, `video_s3key`, `recall_recording_id`, `RBAC { type users { id rights } roles { id rights } }`, filtered by `[{ id: { eq: $id } }]` through `transcriptions_itemsPagination` with `limit: 1`.

- [ ] **Step 6: Build `transcript-document.tsx`**

Three columns, sharing one scroll region below a sticky header:

- **Header** — title, `Share`, `Export ▾` (Task 13 fills the menu; render the trigger disabled-free but with only "Copy text" until then), an `OverflowMenu` ("Correct text and speakers" → `?edit=1`, "Move to project", "Open in library" → `/data/transcriptions/<id>`, "Delete"). Meta line plus an access pill whose popover reuses `ItemAccessSection`.
- **Left** — chapters, parsed from a post-processing output containing a `## Chapters` heading; each `- [mm:ss] Title` line becomes a seek button. The column renders nothing when no output supplies chapters.
- **Centre** — Summary and Action items from the remaining post-processing outputs, rendered through `parseTimestampRefs` so citations seek; then the transcript blocks (reuse the existing merge-consecutive-speakers logic and `speakerColor` from `review-sheet.tsx` — move that logic here, it is shared with Task 12).
- **Right** — `MeetingVideoPlayer` with its deletion date when the item has a video, then `<AskBox />`.

`mode="edit"` is accepted now and ignored until Task 12, so the prop contract is stable.

Empty content must render as an empty document, not a crash: no segments → a quiet "This transcript has no text." line; no post-processing → no Summary heading at all.

- [ ] **Step 7: Build `ask-box.tsx`**

An input, an agent chip opening a picker, a send button, two suggested questions and one explainer line. The picker lists agents whose retrieval config includes the `transcriptions` context first under "Can search Transcriptions", then the rest under "Gets this transcript attached to the chat". The last-used agent id is remembered in `localStorage` under `transcripts:lastAskAgent`. Send navigates to:

```ts
router.push(
  `/chat/${agentId}?items=${encodeURIComponent(`transcriptions/${itemId}`)}&q=${encodeURIComponent(question)}`,
);
```

Suggested questions fill the input and do not send.

- [ ] **Step 8: Teach chat the two new params**

In `app/(application)/chat/components/composer.tsx`, beside the existing `initialPromptId` read (line ~273), read `items` and `q`. On mount only: seed the textarea from `q`, and add each gid in `items` through the controller's existing session-item add path — the same call the ItemsSelectionModal makes, so pinning behaves identically. Guard with a ref so a re-render cannot re-seed and a user's edit is never overwritten.

- [ ] **Step 9: Build the page**

`app/(application)/transcriptions/[itemId]/page.tsx` — a thin client page that reads `params.itemId`, runs `GET_TRANSCRIPT_ITEM`, and renders `<TranscriptDocument item mode={searchParams.get("edit") === "1" ? "edit" : "read"} />`, with a skeleton while loading and an `EmptyState variant="error"` with a retry when the item is missing.

- [ ] **Step 10: Verify**

Run: `npx vitest run "app/(application)/transcriptions"`, `npx eslint "app/(application)/transcriptions" "app/(application)/chat"`, `node scripts/check-messages.js`
Then by hand: open a saved transcript, click a `[mm:ss]` in the summary and confirm the player seeks; pick an agent and send a question, confirming the chat opens with the transcript pinned and the question in the box; open a transcript with no summary and confirm the page renders.

- [ ] **Step 11: Commit**

```bash
git add "app/(application)/transcriptions" "app/(application)/chat/components/composer.tsx" messages/en.json messages/de.json
git commit -m "feat(transcripts): reading view with chapters, summary and ask box

A saved transcript becomes a page: chapters, summary and action items from
post-processing with [mm:ss] citations that seek the player, the transcript
itself, and an ask box that opens a chat with the transcript pinned through
the existing session-items path. Chat gains ?items= and ?q= deep links.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

**Stage 1 ships here.** Deploy backend before frontend. Verify the four flows by hand — upload, meeting bot, record, and reading a shared transcript as the person it was shared with — before starting Task 11.

---

# Stage 2 — the document

---

### Task 11: The `corrected_segments` column

**Files (backend worktree):**
- Modify: `src/postgres/core-schema.ts` (in `transcriptionJobsSchema`, after `last_chunk_at`)
- Modify: `src/templates/contexts/transcriptions.ts`
- Modify: `src/exulu/transcription/service.ts`
- Modify: `src/exulu/transcription/build-transcript-item.ts`
- Modify: `src/graphql/schemas/index.ts` (`TranscriptionJobFinalizeInput`)
- Test: `src/exulu/transcription/build-transcript-item.test.ts`

**Interfaces:**
- Consumes: `effectiveSegments` (Task 2).
- Produces: `corrected_segments` on both tables; `TranscriptionJobFinalizeInput.corrected_segments: JSON`; `FinalizeInput.corrected_segments?: RawSegment[] | null`. Task 12 sends it.

- [ ] **Step 1: Write the failing test**

Append to `src/exulu/transcription/build-transcript-item.test.ts`:

```ts
describe("buildTranscriptItemInput — corrections", () => {
  it("carries corrected_segments onto the item", () => {
    const corrected = [{ start: 0, end: 1, text: "hi there", speaker: "SPEAKER_00" }];
    const item = buildTranscriptItemInput(args({ row: row({ corrected_segments: corrected }) }));
    expect(item.corrected_segments).toEqual(corrected);
  });

  it("leaves corrected_segments undefined when nothing was corrected", () => {
    expect(buildTranscriptItemInput(args()).corrected_segments).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/exulu/transcription/build-transcript-item.test.ts`
Expected: FAIL — `undefined` where the array was expected.

- [ ] **Step 3: Declare the column on both tables**

In `src/postgres/core-schema.ts`, inside `transcriptionJobsSchema.fields` after `last_chunk_at`:

```ts
    // User corrections to the transcript text. raw_segments stays the
    // untouched engine output so a correction can always be reset and
    // diarization can be re-run (spec 2026-09-29 §2.2).
    { name: "corrected_segments", type: "json" },
```

In `src/templates/contexts/transcriptions.ts`, after `raw_segments`:

```ts
    { name: "corrected_segments", type: "json", editable: false },
```

- [ ] **Step 4: Carry it through finalize**

In `build-transcript-item.ts`, add to the returned object:

```ts
  corrected_segments: row.corrected_segments ?? undefined,
```

In `service.ts`, add `corrected_segments?: RawSegment[] | null` to `FinalizeInput` and `JobRow`, persist it in the finalize `update(...)`, and change the transcript render to:

```ts
    const transcriptText = renderTranscript(
      effectiveSegments(row.raw_segments, input.corrected_segments ?? row.corrected_segments),
      input.speakers,
    );
```

importing `effectiveSegments` alongside `renderTranscript`. Add `corrected_segments` to `_rowFromDb`'s `parseJsonField` list.

- [ ] **Step 5: Expose it on the GraphQL input**

In `src/graphql/schemas/index.ts`, add to `input TranscriptionJobFinalizeInput`:

```graphql
      corrected_segments: JSON
```

and pass `corrected_segments: args.input.corrected_segments` through in the `transcriptionJobFinalize` resolver.

- [ ] **Step 6: Run the tests and type-check**

Run: `npx jest src/exulu/transcription/` then `npx tsc --noEmit 2>&1 | tail -20`
Expected: tests PASS; the same 9 pre-existing type errors.

- [ ] **Step 7: Commit**

```bash
git add src/postgres/core-schema.ts src/templates/contexts/transcriptions.ts \
        src/exulu/transcription/service.ts src/exulu/transcription/build-transcript-item.ts \
        src/exulu/transcription/build-transcript-item.test.ts src/graphql/schemas/index.ts
git commit -m "feat(transcripts): corrected_segments beside the engine output

raw_segments stays untouched so a correction can be reset and diarization
re-run; finalize renders transcript_text from effectiveSegments, which
re-embeds the corrected text through the context's existing onInsert vectors.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: The review page

**Files (frontend worktree):**
- Create: `app/(application)/transcriptions/review/[jobId]/page.tsx`
- Create: `app/(application)/transcriptions/components/speakers-panel.tsx`
- Create: `app/(application)/transcriptions/components/find-replace.tsx`
- Create: `app/(application)/transcriptions/components/review-checklist.tsx`
- Modify: `app/(application)/transcriptions/components/transcript-document.tsx`
- Modify: `app/(application)/transcriptions/types.ts` and `types.test.ts`
- Delete: `app/(application)/transcriptions/components/review-sheet.tsx`
- Modify: `messages/en.json`, `messages/de.json`

**Interfaces:**
- Consumes: `TranscriptDocument` (Task 10), `AudioTimeline`, `RBACControl`, `ConfirmDialog`, `PostProcessingResults` (lift it out of `review-sheet.tsx` before deleting the file), `FINALIZE_TRANSCRIPTION_JOB`, `CANCEL_TRANSCRIPTION_JOB`, `UPDATE_ITEM("transcriptions")`.
- Produces `applyFindReplace` in `types.ts` plus the three component contracts below.

```tsx
export function applyFindReplace(
  segments: Segment[],
  find: string,
  replace: string,
  matchCase: boolean,
): { segments: Segment[]; count: number };

// components/speakers-panel.tsx
export interface SpeakersPanelProps {
  /** Distinct raw labels in document order. */
  rawSpeakers: string[];
  /** raw label -> typed name; "" means still unnamed. */
  names: Record<string, string>;
  onNameChange: (rawSpeaker: string, name: string) => void;
  /** Share of total speech time, keyed by raw label, 0-1. */
  talkShare: Record<string, number>;
  /** Seeks the player to that speaker's first block and plays ~4s. */
  onHear: (rawSpeaker: string) => void;
}

// components/find-replace.tsx
export interface FindReplaceProps {
  segments: Segment[];
  onReplaceAll: (next: Segment[]) => void;
}

// components/review-checklist.tsx
export interface ReviewChecklistProps {
  titleSet: boolean;
  unnamedSpeakerCount: number;
  hasSummary: boolean;
  sharingChosen: boolean;
}
```

`ReviewChecklist` renders the header status button and its popover. It reports; it never gates — **nothing on the checklist may disable Save.**

- [ ] **Step 1: Write the failing find-and-replace tests**

Append to `app/(application)/transcriptions/types.test.ts`:

```ts
import { applyFindReplace, type Segment } from "./types";

const segs = (...texts: string[]): Segment[] =>
  texts.map((text, i) => ({ start: i, end: i + 1, text, speaker: "SPEAKER_00" }));

describe("applyFindReplace", () => {
  it("replaces every occurrence and reports the count", () => {
    const { segments, count } = applyFindReplace(
      segs("Zet Cad is slow", "open Zet Cad"),
      "Zet Cad",
      "ZWCAD",
      false,
    );
    expect(segments.map((s) => s.text)).toEqual(["ZWCAD is slow", "open ZWCAD"]);
    expect(count).toBe(2);
  });

  it("counts multiple hits inside one segment", () => {
    expect(applyFindReplace(segs("a a a"), "a", "b", false).count).toBe(3);
  });

  it("is case-insensitive by default and case-sensitive on request", () => {
    expect(applyFindReplace(segs("Zet cad"), "zet cad", "ZWCAD", false).count).toBe(1);
    expect(applyFindReplace(segs("Zet cad"), "zet cad", "ZWCAD", true).count).toBe(0);
  });

  it("treats the needle as literal text, not a regular expression", () => {
    // A user typing "(1)" must not blow up or match nothing.
    const { segments, count } = applyFindReplace(segs("item (1) here"), "(1)", "(2)", false);
    expect(count).toBe(1);
    expect(segments[0].text).toBe("item (2) here");
  });

  it("never changes timestamps or speakers", () => {
    const before = segs("one", "two");
    const { segments } = applyFindReplace(before, "one", "1", false);
    expect(segments.map((s) => [s.start, s.end, s.speaker])).toEqual(
      before.map((s) => [s.start, s.end, s.speaker]),
    );
  });

  it("returns the input unchanged for an empty needle", () => {
    const before = segs("one");
    const { segments, count } = applyFindReplace(before, "", "x", false);
    expect(segments).toEqual(before);
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run "app/(application)/transcriptions/types.test.ts"`
Expected: FAIL — `applyFindReplace is not a function`.

- [ ] **Step 3: Implement it**

Append to `app/(application)/transcriptions/types.ts`:

```ts
const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Bulk correction across the transcript. Only `text` changes — start, end
 * and speaker are preserved, which is what makes "Timestamps stay in place"
 * true and lets the audio ribbon keep working after a replace.
 *
 * The needle is escaped: a user typing "(1)" means those three characters,
 * not a capture group.
 */
export function applyFindReplace(
  segments: Segment[],
  find: string,
  replace: string,
  matchCase: boolean,
): { segments: Segment[]; count: number } {
  if (!find) return { segments, count: 0 };
  const pattern = new RegExp(escapeRegExp(find), matchCase ? "g" : "gi");
  let count = 0;
  const next = segments.map((segment) => {
    const hits = segment.text.match(pattern);
    if (!hits) return segment;
    count += hits.length;
    return { ...segment, text: segment.text.replace(pattern, replace) };
  });
  return { segments: next, count };
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run "app/(application)/transcriptions/types.test.ts"`
Expected: PASS.

- [ ] **Step 5: Add edit mode to `transcript-document.tsx`**

With `mode="edit"`: each transcript block becomes editable on click (a `textarea` sized to its content; blur commits to local segment state; Escape reverts that block). The speaker label gains a "Name speaker" link when the label is still raw. The right column swaps the video/ask panel for `<SpeakersPanel />`, and a pinned footer holds the `AudioTimeline` and the Save / Discard actions.

- [ ] **Step 6: Build the three new components**

`speakers-panel.tsx` — one row per distinct speaker with its colour dot, name and an amber "Needs a name" badge; one row open at a time, showing a name input, a "Hear" button (seeks the player to that speaker's first block and plays about four seconds) and talk share (that speaker's summed segment duration over the total). Speaker suggestions and Merge are stage 4 and must not appear.

`find-replace.tsx` — hidden behind a button; find, replace, a live match count from `applyFindReplace`, a match-case toggle, and Replace all. Replaced words render in the success token until save. The "remembered for the project" vocabulary list is stage 4 and must not appear.

`review-checklist.tsx` — the header status button reading "N speakers unnamed" (amber) or "Ready to save" (green), opening a popover listing Title, Speakers named, Summary and action items, Who can see it. Pure derivation from local state. **Nothing on it blocks saving.**

- [ ] **Step 7: Build the review page**

`review/[jobId]/page.tsx` loads the job with `GET_TRANSCRIPTION_JOB` and renders `<TranscriptDocument mode="edit" />`. Save calls `FINALIZE_TRANSCRIPTION_JOB` with `{ title, speakers, corrected_segments, project_id, target_rights_mode, target_rbac_users, target_rbac_roles }`, then `router.replace('/transcriptions/' + item_id)`. Discard opens the shared `ConfirmDialog` and calls `CANCEL_TRANSCRIPTION_JOB`.

- [ ] **Step 8: Handle the read-only edit case**

In `[itemId]/page.tsx` with `?edit=1`, derive write access from the item's `RBAC` and `created_by` the same way `useItemEditor` does — read `app/(application)/data/[ctx]/components/use-item-editor.ts` and reuse its check rather than writing a second one. Without write access, render the document in read mode with an inline `Alert`: "You can read this transcript but not correct it. Ask {owner} or an admin." Do not render Save. If the server rejects a write anyway, catch it and toast that message rather than the raw GraphQL error.

Add the conflict guard: refetch on window focus and, if `updatedAt` moved since load, warn before saving.

- [ ] **Step 9: Delete the sheet and update the page**

Lift `PostProcessingResults` out of `review-sheet.tsx` into its own file first, then delete `review-sheet.tsx` and remove its import and the `reviewId` branch from `page.tsx`. The legacy `?review=` redirect added in Task 8 stays.

- [ ] **Step 10: Verify**

Run: `npx vitest run "app/(application)/transcriptions"`, `npx eslint "app/(application)/transcriptions"`, `node scripts/check-messages.js`
Then by hand: correct a sentence and confirm the timestamp does not move; run a replace-all; name a speaker and confirm every block relabels live; save and confirm the redirect to the reading view shows the corrected text; open a transcript shared read-only at `?edit=1` and confirm there is no Save button.

- [ ] **Step 11: Commit**

```bash
git add "app/(application)/transcriptions" messages/en.json messages/de.json
git commit -m "feat(transcripts): review page with correction, find-replace and speakers panel

Review graduates from a side sheet to a page that is the reading view in edit
mode. Corrections change only segment text, so timestamps and the audio ribbon
survive. Read-only viewers opening ?edit=1 get a clear message instead of a
Save button that would fail.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: The Export menu

**Files (frontend worktree):**
- Create: `app/(application)/transcriptions/components/export-menu.tsx`
- Modify: `app/(application)/transcriptions/components/transcript-document.tsx`
- Modify: `messages/en.json`, `messages/de.json`

**Interfaces:**
- Consumes: the route from Task 6, and the backend base URL from `ConfigContext.backend`.
- Produces:

```tsx
// components/export-menu.tsx
export type ExportIncludeOptions = {
  summary: boolean;
  timestamps: boolean;
  speakers: boolean;
};

export interface ExportMenuProps {
  itemId: string;
}
```

The three options default to `true` and persist under `transcripts:exportOptions`. Nothing further depends on this.

- [ ] **Step 1: Add the i18n keys**

```json
"export": {
  "label": "Export",
  "copyText": "Copy text",
  "copied": "Transcript copied",
  "copyFailed": "Could not copy the transcript",
  "markdown": "Markdown (.md)",
  "word": "Word document (.docx)",
  "pdf": "PDF (.pdf)",
  "csv": "CSV (.csv)",
  "srt": "Subtitles (.srt)",
  "include": "Include",
  "includeSummary": "Summary and action items",
  "includeTimestamps": "Timestamps",
  "includeSpeakers": "Speaker names"
}
```

- [ ] **Step 2: Build the menu**

A `DropdownMenu` with the three Include checkboxes at the top (default on, persisted under `transcripts:exportOptions` in `localStorage`, wrapped in try/catch so a browser blocking site data still renders), then Copy text and the five downloads.

A download builds the URL and navigates:

```ts
const url = `${backend}/transcription-items/${itemId}/export?format=${format}` +
  `&summary=${options.summary ? 1 : 0}` +
  `&timestamps=${options.timestamps ? 1 : 0}` +
  `&speakers=${options.speakers ? 1 : 0}`;
window.location.href = url;
```

Copy text fetches the same URL with `format=md` and writes `await response.text()` to the clipboard, so the clipboard and the `.md` file can never diverge. On a non-OK response, show a destructive toast with `export.copyFailed` and leave the menu open.

- [ ] **Step 3: Mount it in the header**

Replace the Task 10 placeholder trigger in `transcript-document.tsx` with `<ExportMenu itemId={item.id} />`, read mode only.

- [ ] **Step 4: Verify**

Run: `npx eslint "app/(application)/transcriptions"`, `node scripts/check-messages.js`
Then by hand, against a running backend: download all five formats, open the `.docx` and the `.csv`, toggle each Include option off and confirm the corresponding content disappears, and confirm Copy text puts the same markdown on the clipboard.

- [ ] **Step 5: Commit**

```bash
git add "app/(application)/transcriptions" messages/en.json messages/de.json
git commit -m "feat(transcripts): Export menu with five formats and include options

Copy text and the five downloads all go through the one server-side builder,
so the clipboard and the .md file cannot diverge. Include options persist per
viewer and degrade quietly when a browser blocks site data.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Vocabulary and the page doc

**Files (frontend worktree):**
- Modify: `messages/en.json`, `messages/de.json`
- Modify: `design/pages/transcriptions.md`

**Interfaces:** none.

- [ ] **Step 1: Sweep the strings**

Navigation, page title and library read "Transcripts" (en) / "Transkripte" (de). Replace any product-brand mention with "the IMP" or "the agent". The default bot-name placeholder is "IMP Notetaker". The seven states use the handoff's German labels. The knowledge base keeps the name "Transcriptions".

Run `node scripts/check-messages.js` and `grep -rn "Transkription" messages/de.json` — the only survivors should be ones that genuinely mean the act of transcribing.

- [ ] **Step 2: Rewrite the page doc**

`design/pages/transcriptions.md` still describes the June 2026 queue. Replace its Current state, disclosure ladder and inventory with the shipped design: the five routes, the union data spine, the three-source dialog, the document component in two modes, and the export route. Keep the file's existing structure and heading style. Link the spec.

- [ ] **Step 3: Commit**

```bash
git add messages/en.json messages/de.json design/pages/transcriptions.md
git commit -m "docs(transcripts): Transcripts vocabulary and a rewritten page doc

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Whole-branch verification

**Files:** none — this task only runs things and reports.

- [ ] **Step 1: Backend suite**

In `../backend-transcripts-redesign`: `npm run type-check`, `npm run lint`, `npx jest`.
Compare against the recorded baselines (9 / 156 / 4 failing suites). Any increase is a regression to fix before this task passes.

- [ ] **Step 2: Frontend suite**

In `../frontend-transcripts-redesign`: `npx vitest run`, `npm run lint`, `node scripts/check-messages.js`, `npm run build`.
Baselines: 1 failing vitest, 1 eslint error in `entity-types.tsx`. The build must succeed.

- [ ] **Step 3: End-to-end by hand**

Deploy the backend first, then the frontend. Walk every flow: upload → review → save → read → export; meeting bot → review → save; record on a phone → close-out → review → save; open a transcript shared with you as the recipient; correct a saved transcript; ask an agent about a transcript and confirm the answer cites it.

- [ ] **Step 4: Report**

Write the outcome — what passed, what failed, what was deferred — before requesting review.

## Notes for the executor

- **Two repos, one branch name.** Check `pwd` and `git branch --show-current` in the same command as any commit. Parallel sessions move the primary checkouts' branches; never commit from `../backend` or `../frontend`.
- **`npm run dev` in the frontend worktree** runs `select-env` first and needs a backend to talk to. Daniel's loop is the newlkiag dev setup; ask before assuming an environment.
- **The backend is a library** (`@exulu/backend`) with no standalone server, so backend changes are only smoke-testable through a consuming project — rebuild `dist` and restart that server.
