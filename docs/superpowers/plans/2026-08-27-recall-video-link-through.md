# Recall Video Link-Through Implementation Plan (Sub-project A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Recall.ai meeting video reachable from a saved transcript item, and bound recording retention to 90 days.

**Architecture:** Recall already records a mixed MP4 for every bot and already retains it. Four changes expose it: widen the client types to stop discarding `video_mixed`, send an explicit `recording_config` so retention is deliberate, add a `getRecordingVideoUrl` resolver that callers invoke per use (signed URLs expire in 6h and must never be cached), and carry `recall_recording_id` onto the saved transcriptions item so a consuming project can get from a transcript to its video.

**Tech Stack:** TypeScript, jest + ts-jest, knex, Recall.ai API v1.

**Spec:** `docs/superpowers/specs/2026-08-27-recall-video-training-guides-design.md`

## Global Constraints

- Node.js **v22.18.0** exactly — `preinstall` hard-fails on any other version.
- Test runner: `npx jest <path>` (`npm test` runs the whole suite). Config: `jest.config.cjs`, preset `ts-jest`, `testMatch: ["**/*.test.ts", "**/*.spec.ts"]`.
- Path aliases: `@SRC/*` → `src/*`, `@EXULU_TYPES/*` → `types/*`, `@EE/*` → `ee/*`.
- Retention value is **2160 hours (90 days)** — exact.
- Video URL field path is **`media_shortcuts.video_mixed.data.download_url`** — exact.
- This repo uses **semantic-release**. Commit types drive the published version: use `feat:` for the new resolver (minor bump), `fix:` for the retention and column-sync changes. algikiag consumes `@exulu/backend` at `^3.2.0`, so a minor bump reaches it.
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Work happens in the worktree `/Users/daniel.claessen/Desktop/Projects/exulu/backend-training-guides` on branch `feat/recall-video-training-guides`. Verify with `git branch --show-current` in the same command as any commit.

---

### Task 1: Expose the video URL

**Files:**
- Modify: `src/exulu/recall/client.ts:157-183` (add `video_mixed` to both `media_shortcuts` shapes)
- Modify: `src/exulu/recall/service.ts` (add `getRecordingVideoUrl` to `recallService`, which begins at `:133`)
- Modify: `src/index.ts` (add the public export)
- Test: `src/exulu/recall/service.test.ts` (append a describe block; `retrieveRecordingSpy` already exists at `:45`)

**Interfaces:**
- Consumes: `recallClient.retrieveRecording(recordingId)` from `./client`.
- Produces: `recallService.getRecordingVideoUrl(recordingId: string): Promise<string | null>`, re-exported as `ExuluRecall.getRecordingVideoUrl`. Sub-project B's pipeline calls this at step 0.

- [ ] **Step 1: Write the failing tests**

Append to `src/exulu/recall/service.test.ts`:

```ts
describe("getRecordingVideoUrl", () => {
  beforeEach(() => {
    retrieveRecordingSpy.mockReset();
  });

  it("returns the video_mixed download url", async () => {
    retrieveRecordingSpy.mockResolvedValueOnce({
      id: "rec-1",
      media_shortcuts: {
        video_mixed: {
          id: "vm-1",
          format: "mp4",
          status: { code: "done" },
          data: { download_url: "https://s3/video.mp4?X-Amz-Expires=21600" },
        },
      },
    });

    await expect(recallService.getRecordingVideoUrl("rec-1")).resolves.toBe(
      "https://s3/video.mp4?X-Amz-Expires=21600",
    );
  });

  it("returns null when the recording carries no video artifact", async () => {
    retrieveRecordingSpy.mockResolvedValueOnce({
      id: "rec-1",
      media_shortcuts: { transcript: { id: "t-1" } },
    });

    await expect(recallService.getRecordingVideoUrl("rec-1")).resolves.toBeNull();
  });

  it("returns null while the video is still processing", async () => {
    retrieveRecordingSpy.mockResolvedValueOnce({
      id: "rec-1",
      media_shortcuts: {
        video_mixed: { id: "vm-1", status: { code: "processing" }, data: {} },
      },
    });

    await expect(recallService.getRecordingVideoUrl("rec-1")).resolves.toBeNull();
  });

  it("returns null instead of throwing when the recording is gone", async () => {
    retrieveRecordingSpy.mockRejectedValueOnce(new Error("Recall API 404"));

    await expect(recallService.getRecordingVideoUrl("rec-1")).resolves.toBeNull();
  });

  it("re-resolves on every call — signed urls expire in 6h and must not be cached", async () => {
    const rec = (url: string) => ({
      id: "rec-1",
      media_shortcuts: {
        video_mixed: { id: "vm-1", status: { code: "done" }, data: { download_url: url } },
      },
    });
    retrieveRecordingSpy
      .mockResolvedValueOnce(rec("url-1"))
      .mockResolvedValueOnce(rec("url-2"));

    await expect(recallService.getRecordingVideoUrl("rec-1")).resolves.toBe("url-1");
    await expect(recallService.getRecordingVideoUrl("rec-1")).resolves.toBe("url-2");
    expect(retrieveRecordingSpy).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/recall/service.test.ts -t "getRecordingVideoUrl"`
Expected: FAIL — `recallService.getRecordingVideoUrl is not a function`

- [ ] **Step 3: Widen the client types**

In `src/exulu/recall/client.ts`, add this type above `RecallBot`:

```ts
/** Mixed video artifact. `data.download_url` is a signed S3 URL valid ~6h. */
export type RecallVideoMixed = {
  id?: string;
  format?: string | null;
  status?: { code?: string | null } | null;
  data?: { download_url?: string };
};
```

Then add `video_mixed?: RecallVideoMixed;` to the `media_shortcuts` object in **both** `RecallBot.recordings[]` (`:157-159`) and `RecallRecording` (`:180-182`), alongside the existing `transcript` entry.

- [ ] **Step 4: Implement the resolver**

Add to the `recallService` object in `src/exulu/recall/service.ts`, directly after `_transcriptDownloadUrl` (which ends at `:409`):

```ts
  /**
   * Fresh signed URL for a recording's mixed MP4, or null when there is no
   * usable video (still processing, no video artifact, recording expired or
   * deleted).
   *
   * Never cache the result: the URL carries X-Amz-Expires=21600, so it dies
   * after six hours. Resolve at point of use.
   */
  async getRecordingVideoUrl(recordingId: string): Promise<string | null> {
    try {
      const recording = await recallClient.retrieveRecording(recordingId);
      const video = recording?.media_shortcuts?.video_mixed;
      if (!video) return null;
      // Absent status means the artifact predates status reporting; treat as ready.
      if (video.status?.code && video.status.code !== "done") return null;
      return video.data?.download_url ?? null;
    } catch (err) {
      log(
        `could not resolve video url for recording ${recordingId}: ${(err as Error).message}`,
      );
      return null;
    }
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/exulu/recall/service.test.ts -t "getRecordingVideoUrl"`
Expected: PASS, 5 tests

- [ ] **Step 6: Export it from the package**

In `src/index.ts`, following the existing `export const ExuluX = {...}` namespace idiom (see `ExuluJobs` at `:61`), add:

```ts
export { ExuluRecall } from "./exulu/recall/public";
```

Create `src/exulu/recall/public.ts`:

```ts
import { recallService } from "./service";

/** Public Recall surface for consuming projects. */
export const ExuluRecall = {
  /**
   * Fresh signed URL for a recording's mixed MP4, or null. Resolve at point
   * of use — the URL expires after six hours.
   */
  getRecordingVideoUrl: (recordingId: string): Promise<string | null> =>
    recallService.getRecordingVideoUrl(recordingId),
};
```

- [ ] **Step 7: Type-check**

Run: `npm run type-check`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git branch --show-current   # must print feat/recall-video-training-guides
git add src/exulu/recall/client.ts src/exulu/recall/service.ts \
        src/exulu/recall/public.ts src/exulu/recall/service.test.ts src/index.ts
git commit -m "feat(recall): resolve mixed video download urls

video_mixed arrives on every recording payload and was being discarded.
Widens the client types and adds getRecordingVideoUrl, exported as
ExuluRecall for consuming projects.

Returns null rather than throwing for the four not-available cases
(no artifact, still processing, expired, deleted) so callers branch on a
value instead of a catch. Never cached: the signed URL carries
X-Amz-Expires=21600.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Explicit recording_config with 90-day retention

**Files:**
- Modify: `src/exulu/recall/client.ts:210-229` (extract the payload, add `recording_config`)
- Test: `src/exulu/recall/client.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `CreateBotInput` (already defined at `client.ts:140-147`).
- Produces: `buildCreateBotPayload(input: CreateBotInput): Record<string, unknown>` and `RECORDING_RETENTION_HOURS: number`, both exported from `./client`.

**Why extract a pure function:** `createBot` goes through `request()`, which calls `assertRecallConfigured()` and needs live env. `client.test.ts` only mocks `global.fetch` and never exercises `request`. A pure payload builder is testable without env plumbing, and the payload is the part with the actual risk.

- [ ] **Step 1: Write the failing tests**

Append to `src/exulu/recall/client.test.ts`:

```ts
import { buildCreateBotPayload, RECORDING_RETENTION_HOURS } from "./client";

describe("buildCreateBotPayload", () => {
  const base = {
    meeting_url: "https://meet.google.com/abc-defg-hij",
    join_at: "2026-08-27T10:00:00.000Z",
  };

  it("requests a mixed mp4 explicitly rather than relying on server defaults", () => {
    const payload = buildCreateBotPayload(base) as any;
    expect(payload.recording_config.video_mixed_mp4).toEqual({});
    expect(payload.recording_config.video_mixed_layout).toBe("speaker_view");
  });

  it("keeps participant events and meeting metadata that the defaults provided", () => {
    const payload = buildCreateBotPayload(base) as any;
    expect(payload.recording_config.participant_events).toEqual({});
    expect(payload.recording_config.meeting_metadata).toEqual({});
  });

  it("sets a 90 day timed retention", () => {
    const payload = buildCreateBotPayload(base) as any;
    expect(RECORDING_RETENTION_HOURS).toBe(2160);
    expect(payload.recording_config.retention).toEqual({
      type: "timed",
      hours: 2160,
    });
  });

  it("passes meeting_url and join_at through unchanged", () => {
    const payload = buildCreateBotPayload(base) as any;
    expect(payload.meeting_url).toBe(base.meeting_url);
    expect(payload.join_at).toBe(base.join_at);
  });

  it("omits bot_name and chat when not requested", () => {
    const payload = buildCreateBotPayload(base) as any;
    expect(payload.bot_name).toBeUndefined();
    expect(payload.chat).toBeUndefined();
  });

  it("pins an on-join chat notice when requested", () => {
    const payload = buildCreateBotPayload({
      ...base,
      bot_name: "Company Notetaker",
      notifyChat: { message: "This meeting is being recorded." },
    }) as any;

    expect(payload.bot_name).toBe("Company Notetaker");
    expect(payload.chat.on_bot_join).toEqual({
      send_to: "everyone",
      message: "This meeting is being recorded.",
      pin: true,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/recall/client.test.ts -t "buildCreateBotPayload"`
Expected: FAIL — `buildCreateBotPayload is not a function`

- [ ] **Step 3: Implement the payload builder**

In `src/exulu/recall/client.ts`, add above `export const recallClient`:

```ts
/** 90 days. Bounded on purpose — Recall's account default is `forever`. */
export const RECORDING_RETENTION_HOURS = 2160;

/**
 * Create Bot request body.
 *
 * recording_config is sent in full rather than partially. The Recall docs do
 * not state whether a partial config merges with or replaces the server-side
 * defaults; under replace semantics, sending only `retention` would silently
 * disable video recording. Spelling out the defaults makes the request correct
 * under either reading. The values here mirror what Recall applied when we
 * sent no config at all.
 */
export const buildCreateBotPayload = (input: CreateBotInput) => ({
  meeting_url: input.meeting_url,
  join_at: input.join_at,
  ...(input.bot_name ? { bot_name: input.bot_name } : {}),
  recording_config: {
    video_mixed_mp4: {},
    video_mixed_layout: "speaker_view",
    participant_events: {},
    meeting_metadata: {},
    retention: { type: "timed", hours: RECORDING_RETENTION_HOURS },
  },
  ...(input.notifyChat
    ? {
        chat: {
          on_bot_join: {
            send_to: "everyone",
            message: input.notifyChat.message,
            pin: true,
          },
        },
      }
    : {}),
});
```

Then replace the body of `createBot` (`:210-229`) with:

```ts
  /** POST /bot — schedule/launch a bot for a meeting. */
  createBot: (input: CreateBotInput): Promise<RecallBot> =>
    request<RecallBot>("/bot/", {
      method: "POST",
      body: JSON.stringify(buildCreateBotPayload(input)),
    }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/exulu/recall/client.test.ts`
Expected: PASS — the 6 new tests plus the 11 existing `fetch_with_retry` tests

- [ ] **Step 5: Confirm the existing service tests still pass**

Run: `npx jest src/exulu/recall/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # must print feat/recall-video-training-guides
git add src/exulu/recall/client.ts src/exulu/recall/client.test.ts
git commit -m "fix(recall): bound recording retention to 90 days

createBot sent no recording_config, so Recall applied account defaults —
including retention 'forever' for workspaces created after 2025-06-12.
Storage then accrues indefinitely at \$0.000069 per recording-hour per
hour beyond day 7, on a setting nobody chose.

Sends the full config rather than just retention: the docs do not say
whether a partial config merges or replaces, and under replace semantics
a retention-only body would silently disable video recording.

Not retroactive — existing recordings stay 'forever'.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Sync missing columns on existing context tables

**Files:**
- Create: `src/exulu/context-fields-for-sync.ts`
- Create: `src/exulu/context-fields-for-sync.test.ts`
- Modify: `src/postgres/init-exulu-db.ts:320-336` (`contextDatabases`)

**Interfaces:**
- Consumes: `ExuluContext.fields` (`ExuluContextFieldDefinition[]`, defined at `src/exulu/context.ts:55-73`); `addMissingFields(knex, tableName, fields, skipFields?)` (module-private, `init-exulu-db.ts:42-68`); `getTableName(id)` from `@SRC/exulu/table-names`.
- Produces: `contextFieldsForSync(context): { name: string; type: string; default?: unknown; unique?: boolean }[]`.

**Why this task exists:** `contextDatabases` only calls `createItemsTable` when the table is *absent*. There is no column sync for existing context tables, so adding a field to any ExuluContext does nothing on a deployed instance and the next `createItem` throws on the missing column. Task 4 adds a field, so this must land first.

**The `_s3key` trap:** `createItemsTable` renames `file` fields to `<name>_s3key` before calling `mapType` (`context.ts:1233`). `addMissingFields` sanitizes but does not suffix. Passing context fields to it raw would create a wrongly-named column for every file field — on algikiag that is 20 contexts with `document` and `markdown` file fields each. The mapping function exists to close exactly this gap.

- [ ] **Step 1: Write the failing tests**

Create `src/exulu/context-fields-for-sync.test.ts`:

```ts
import { contextFieldsForSync } from "./context-fields-for-sync";

const ctx = (fields: any[]) => ({ fields }) as any;

describe("contextFieldsForSync", () => {
  it("suffixes file fields with _s3key to match createItemsTable", () => {
    expect(contextFieldsForSync(ctx([{ name: "document", type: "file" }]))).toEqual([
      { name: "document_s3key", type: "file" },
    ]);
  });

  it("leaves non-file fields untouched", () => {
    expect(contextFieldsForSync(ctx([{ name: "language", type: "text" }]))).toEqual([
      { name: "language", type: "text" },
    ]);
  });

  it("drops fields missing a name or a type", () => {
    const out = contextFieldsForSync(
      ctx([
        { name: "keep", type: "text" },
        { name: "", type: "text" },
        { name: "no_type" },
        { type: "text" },
      ]),
    );
    expect(out).toEqual([{ name: "keep", type: "text" }]);
  });

  it("preserves default and unique so mapType can apply them", () => {
    const out = contextFieldsForSync(
      ctx([{ name: "code", type: "text", unique: true, default: "x" }]),
    );
    expect(out[0]).toMatchObject({ name: "code", unique: true, default: "x" });
  });

  it("returns an empty array for a context with no fields", () => {
    expect(contextFieldsForSync(ctx([]))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/context-fields-for-sync.test.ts`
Expected: FAIL — cannot find module `./context-fields-for-sync`

- [ ] **Step 3: Implement the mapping**

Create `src/exulu/context-fields-for-sync.ts`:

```ts
import type { ExuluContext } from "./context";

/**
 * Context field definitions in the shape addMissingFields expects, with file
 * fields renamed to <name>_s3key.
 *
 * createItemsTable applies that suffix when it creates the table
 * (context.ts:1233) but addMissingFields does not, so feeding it raw context
 * fields would add a second, wrongly-named column for every file field.
 * addMissingFields sanitizes the name itself, so no sanitizing here.
 */
export const contextFieldsForSync = (
  context: Pick<ExuluContext, "fields">,
): { name: string; type: string; default?: unknown; unique?: boolean }[] =>
  (context.fields ?? [])
    .filter((field) => !!field?.name && !!field?.type)
    .map((field) => ({
      ...field,
      name: field.type === "file" ? `${field.name}_s3key` : field.name,
    })) as { name: string; type: string; default?: unknown; unique?: boolean }[];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/exulu/context-fields-for-sync.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Wire it into bootstrap**

In `src/postgres/init-exulu-db.ts`, add to the imports at the top:

```ts
import { contextFieldsForSync } from "@SRC/exulu/context-fields-for-sync";
import { getTableName } from "@SRC/exulu/table-names";
```

Then replace `contextDatabases` (`:320-336`) with:

```ts
const contextDatabases = async (contexts: ExuluContext[]) => {
  const { db: knex } = await postgresClient();
  for (const context of contexts) {
    const itemsTableExists = await context.tableExists();
    if (!itemsTableExists) {
      console.log("[EXULU] items table does not exist, creating it.");
      await context.createItemsTable();
    } else {
      // createItemsTable only runs for absent tables, so a field added to an
      // existing context would never get its column and the next createItem
      // would throw. Idempotent: addMissingFields gates on hasColumn.
      await addMissingFields(
        knex,
        getTableName(context.id),
        contextFieldsForSync(context),
      );
    }
    const chunksTableExists = await context.chunksTableExists();
    if (!chunksTableExists && context.embedder) {
      console.log("[EXULU] chunks table does not exist, creating it.");
      await context.createChunksTable();
    }
    // Create the entity-layer tables/columns for graph-enabled contexts.
    // No-op when the entity layer is disabled (no types declared/configured).
    await ensureEntityTables(context);
  }
};
```

- [ ] **Step 6: Type-check and run the full suite**

Run: `npm run type-check && npx jest src/`
Expected: no type errors; all tests pass

- [ ] **Step 7: Commit**

```bash
git branch --show-current   # must print feat/recall-video-training-guides
git add src/exulu/context-fields-for-sync.ts \
        src/exulu/context-fields-for-sync.test.ts \
        src/postgres/init-exulu-db.ts
git commit -m "fix(contexts): add missing columns to existing context tables on boot

contextDatabases only called createItemsTable when the table was absent,
so adding a field to an existing ExuluContext created no column and the
next createItem threw. Core schema tables already got this treatment via
addMissingFields; context tables never did.

File fields need the _s3key suffix createItemsTable applies but
addMissingFields does not — without contextFieldsForSync this would add a
second, wrongly-named column for every file field.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Carry recall_recording_id onto the saved transcript item

**Files:**
- Modify: `src/templates/contexts/transcriptions.ts:15-26` (add the field)
- Create: `src/exulu/transcription/build-transcript-item.ts`
- Create: `src/exulu/transcription/build-transcript-item.test.ts`
- Modify: `src/exulu/transcription/service.ts:65-88` (`JobRow`), `:340-354` (use the extracted builder)

**Interfaces:**
- Consumes: `JobRow`, `Item`, `ExuluRightsMode` (all already imported in `service.ts`).
- Produces: `buildTranscriptItemInput({ row, title, speakers, transcriptText, rightsMode, isReSave }): Item`.

**Why extract:** `finalize` needs a live db and app singleton, so the item construction is not reachable by a unit test in place. The spec calls for a test that `recall_recording_id` survives finalize; extracting the pure item-shaping step makes that testable and leaves `finalize` doing orchestration only.

- [ ] **Step 1: Write the failing tests**

Create `src/exulu/transcription/build-transcript-item.test.ts`:

```ts
import { buildTranscriptItemInput } from "./build-transcript-item";

const row = (over: Partial<any> = {}): any => ({
  id: "job-1",
  audio_s3key: "bucket/audio.webm",
  title: "Stored title",
  status: "awaiting_review",
  raw_segments: [{ start: 0, end: 1, text: "hi", speaker: "SPEAKER_00" }],
  language: "de",
  duration_seconds: 1860,
  saved_item_id: null,
  created_by: 7,
  recall_recording_id: null,
  post_processing_outputs: null,
  ...over,
});

const args = (over: Partial<any> = {}) => ({
  row: row(),
  title: undefined,
  speakers: { SPEAKER_00: "Jörg" },
  transcriptText: "Jörg: hi",
  rightsMode: "private" as const,
  isReSave: false,
  ...over,
});

describe("buildTranscriptItemInput", () => {
  it("carries recall_recording_id through so the video stays reachable", () => {
    const item = buildTranscriptItemInput(
      args({ row: row({ recall_recording_id: "rec-9" }) }),
    );
    expect(item.recall_recording_id).toBe("rec-9");
  });

  it("omits recall_recording_id for a whisper upload", () => {
    const item = buildTranscriptItemInput(args());
    expect(item.recall_recording_id).toBeUndefined();
  });

  it("carries the id on re-save too", () => {
    const item = buildTranscriptItemInput(
      args({
        row: row({ recall_recording_id: "rec-9", saved_item_id: "item-1", status: "saved" }),
        isReSave: true,
      }),
    );
    expect(item.id).toBe("item-1");
    expect(item.recall_recording_id).toBe("rec-9");
  });

  it("prefers an explicit title over the stored one", () => {
    expect(buildTranscriptItemInput(args({ title: "New title" })).name).toBe("New title");
    expect(buildTranscriptItemInput(args()).name).toBe("Stored title");
  });

  it("falls back to 'Transcript' when no title exists anywhere", () => {
    expect(buildTranscriptItemInput(args({ row: row({ title: null }) })).name).toBe(
      "Transcript",
    );
  });

  it("omits the id on first save so createItem inserts", () => {
    expect(buildTranscriptItemInput(args()).id).toBeUndefined();
  });

  it("maps the remaining transcript fields", () => {
    const item = buildTranscriptItemInput(args());
    expect(item).toMatchObject({
      transcript_text: "Jörg: hi",
      audio_s3key: "bucket/audio.webm",
      language: "de",
      duration_seconds: 1860,
      rights_mode: "private",
      created_by: 7,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/transcription/build-transcript-item.test.ts`
Expected: FAIL — cannot find module `./build-transcript-item`

- [ ] **Step 3: Add the context field**

In `src/templates/contexts/transcriptions.ts`, add to `fields` after `raw_segments`:

```ts
    // Link back to the Recall recording so the mixed video stays reachable
    // (resolve a fresh URL via ExuluRecall.getRecordingVideoUrl — it expires
    // after six hours). Null for Whisper uploads.
    { name: "recall_recording_id", type: "text" },
```

- [ ] **Step 4: Add the field to JobRow**

In `src/exulu/transcription/service.ts`, add to the `JobRow` type (which ends at `:88`), beside the existing `post_processing_outputs` entry:

```ts
  /** Recall recording id — the handle for the meeting video. Null for Whisper. */
  recall_recording_id?: string | null;
```

- [ ] **Step 5: Implement the builder**

Create `src/exulu/transcription/build-transcript-item.ts`:

```ts
import type { Item } from "@EXULU_TYPES/models/item";
import type { ExuluRightsMode } from "@EXULU_TYPES/rbac-rights-modes";

/**
 * Shapes a finalized transcription job into the knowledge item that gets
 * written to the transcriptions context.
 *
 * Pure on purpose: finalize needs a live db and the app singleton, so this is
 * the only part of the save path a unit test can reach.
 */
export const buildTranscriptItemInput = ({
  row,
  title,
  speakers,
  transcriptText,
  rightsMode,
  isReSave,
}: {
  row: any;
  title?: string;
  speakers: unknown;
  transcriptText: string;
  rightsMode: ExuluRightsMode;
  isReSave: boolean;
}): Item => ({
  // Carrying the id on re-save makes context.createItem upsert in place.
  ...(isReSave && row.saved_item_id ? { id: row.saved_item_id } : {}),
  name: title ?? row.title ?? "Transcript",
  transcript_text: transcriptText,
  audio_s3key: row.audio_s3key,
  language: row.language ?? undefined,
  duration_seconds: row.duration_seconds ?? undefined,
  speakers,
  raw_segments: row.raw_segments,
  // Recall meeting-bot post-processing results (null for Whisper jobs).
  post_processing: row.post_processing_outputs ?? undefined,
  // Handle for the meeting video; null for Whisper uploads.
  recall_recording_id: row.recall_recording_id ?? undefined,
  rights_mode: rightsMode,
  created_by: row.created_by,
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest src/exulu/transcription/build-transcript-item.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 7: Use the builder in finalize**

In `src/exulu/transcription/service.ts`, add the import at the top:

```ts
import { buildTranscriptItemInput } from "./build-transcript-item";
```

Replace the `itemInput` literal (`:340-354`) with:

```ts
    const itemInput: Item = buildTranscriptItemInput({
      row,
      title: input.title,
      speakers: input.speakers,
      transcriptText,
      rightsMode,
      isReSave,
    });
```

- [ ] **Step 8: Type-check and run the full suite**

Run: `npm run type-check && npx jest src/`
Expected: no type errors; all tests pass

- [ ] **Step 9: Commit**

```bash
git branch --show-current   # must print feat/recall-video-training-guides
git add src/templates/contexts/transcriptions.ts \
        src/exulu/transcription/service.ts \
        src/exulu/transcription/build-transcript-item.ts \
        src/exulu/transcription/build-transcript-item.test.ts
git commit -m "feat(transcriptions): carry recall_recording_id onto saved items

The recording id lived only on the transcription_jobs row, which a
consuming project cannot reach, so a saved transcript had no path back to
its meeting video. Adds the field to the transcriptions context and
carries it through finalize.

Extracts the item-shaping step from finalize, which needs a live db and
the app singleton and so was not reachable by a unit test.

Depends on the context column sync — without it the new field gets no
column on already-deployed instances.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Verify against a live bot

Not automatable — the risk this closes is that Recall's `recording_config` turns out to *replace* rather than merge with defaults, which no test in this repo can detect.

- [ ] **Step 1: Deploy the release to an environment with Recall configured**

Confirm `RECALL_REGION`, `RECALL_API_KEY` and `RECALL_WORKSPACE_VERIFICATION_SECRET` are set and `recallEnabled()` returns true.

- [ ] **Step 2: Start a meeting bot and inspect the config Recall echoes back**

Start a bot through the transcriptions UI, then retrieve it:

```bash
curl -s -H "Authorization: $RECALL_API_KEY" \
  "https://$RECALL_REGION.recall.ai/api/v1/bot/$BOT_ID/" \
  | jq '.recording_config'
```

Expected:

```json
{
  "video_mixed_mp4": {},
  "video_mixed_layout": "speaker_view",
  "retention": { "type": "timed", "hours": 2160 },
  ...
}
```

**If `video_mixed_mp4` is absent, stop.** Partial configs replace rather than merge and video recording is now off — revert Task 2 and re-scope.

- [ ] **Step 3: Confirm the video resolves after the meeting**

Once the meeting ends and `recording.done` has fired, check that the recording carries a video artifact and that `expires_at` is ~90 days out:

```bash
curl -s -H "Authorization: $RECALL_API_KEY" \
  "https://$RECALL_REGION.recall.ai/api/v1/recording/$RECORDING_ID/" \
  | jq '{expires_at, video: .media_shortcuts.video_mixed.status.code}'
```

Expected: `video` is `"done"`, `expires_at` roughly 90 days after the recording completed.

- [ ] **Step 4: Confirm the id reached the saved item**

Save the transcript through the review UI, then check the item:

```sql
SELECT id, name, recall_recording_id FROM transcriptions_items ORDER BY "createdAt" DESC LIMIT 1;
```

Expected: `recall_recording_id` is populated and matches `$RECORDING_ID`.

- [ ] **Step 5: Record the outcome in the spec**

Tick the "Confirm post-deploy that an explicit `recording_config` preserves `video_mixed_mp4`" item under Open items in the spec, noting the bot id used. Commit with `docs(recall): confirm recording_config preserves video defaults`.

---

## Definition of done

- `npx jest src/` passes
- `npm run type-check` passes
- A live bot echoes back `video_mixed_mp4` and a 2160-hour timed retention
- A saved transcript item carries a `recall_recording_id` that resolves to a playable URL
- Released to npm, so sub-project B can bump `@exulu/backend`
