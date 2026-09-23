# Live Recording on the Transcripts Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Record on this device" mode to `/transcriptions` that records the microphone in the browser, streams silence-aligned audio chunks to the backend for interim transcription, and lands the result as a normal `transcription_jobs` draft (`awaiting_review`) with the full audio attached.

**Architecture:** The browser runs two `MediaRecorder`s on one microphone stream: a segment recorder restarted at silence boundaries every 20–60 s (each blob is POSTed to a new `POST /transcription-jobs/:id/chunks` route that reuses `transcribeAudio()` and appends a `RawSegment` with a compare-and-swap on a new `chunk_count` column) and a continuous master recorder whose blob is uploaded to S3 at stop. Two GraphQL mutations open and close the row (`source='live'`, new status `recording`); from `awaiting_review` on, the existing review sheet, `finalize()` and `runPostProcessing()` run unchanged. No new environment variables.

**Tech Stack:** Backend: Node/TypeScript, Express, multer, knex/Postgres (jsonb), Apollo GraphQL, jest (+ supertest for the route). Frontend: Next.js app router, React, Apollo Client, shadcn/ui, next-intl (en/de), Uppy S3, vitest (node environment, pure `*.test.ts` modules only).

**Spec:** `docs/superpowers/specs/2026-09-23-live-recording-transcription-design.md` (backend repo). Read it first; every task below argues from it.

## Global Constraints

- **Two repos, two worktrees.** Backend: `/Users/daniel.claessen/Desktop/Projects/exulu/backend`, default branch `develop`. Frontend: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend`, default branch `main` (there is NO develop). Other sessions use the primary checkouts, so all work happens in sibling worktrees: `../backend-live-recording` (branch `feat/live-recording` off `develop`) and `../frontend-live-recording` (branch `feat/live-recording` off `main`). Backend worktree may symlink `node_modules`; the frontend worktree needs hard-linked `node_modules` (`cp -al`) because Turbopack rejects symlinks.
- **Verify repo + branch in the same shell command as every commit** (`git rev-parse --show-toplevel && git branch --show-current && git commit …`).
- **No new environment variables.** Feature gate = `isLiteLLMEnabled() && !!process.env.TRANSCRIPTION_MODEL` (the composer-mic gate).
- **Chunk route contract:** multipart, field `file` (mimetype must start with `audio/`), fields `seq` (int ≥ 0), `offset_ms` (int ≥ 0), `duration_ms` (int > 0), optional `skipped="true"`; 25 MB cap (`MAX_TRANSCRIBE_BYTES`, shared with `/transcribe`); responses `200 { seq, text, chunk_count, duplicate? }`, `409 { detail, kind: "not_recording" | "out_of_order", chunk_count? }`, `503` when disabled, `401/403/404/400/413/502/500` as `{ detail }`.
- **Segments:** one `RawSegment { start, end, text, speaker: "unknown" }` per chunk, `start = offset_ms/1000`, `end = (offset_ms+duration_ms)/1000`; silent/skipped chunks are stored with `text: ""` so `raw_segments[seq]` always exists.
- **Statuses/sources:** new status `"recording"`, new source `"live"`. `finalize()` is untouched.
- **Client constants:** `MIN_CHUNK_MS = 20_000`, `MAX_CHUNK_MS = 60_000`, `SILENCE_MIN_MS = 500`, `SILENCE_DBFS = -50`, `MAX_RECORDING_MS = 4 * 60 * 60 * 1000`, `audioBitsPerSecond: 64_000`, master recorder timeslice `60_000`.
- **Retry policy:** network / 429 / 5xx → retry forever with backoff `min(30_000, 1000 * 2^attempt)`; 400 / 413 / 415 → send the same `seq` with `skipped=true` and continue; 409 `not_recording` → abort; 409 `out_of_order` → abort as a client bug. The queue never skips a `seq`.
- **Copy (both locales, always edited together):** `composer.modeAudio` → "Upload a file" / "Datei hochladen"; `composer.modeMeeting` → "Invite a meeting bot" / "Meeting-Bot einladen"; new `composer.modeRecord` → "Record on this device" / "Auf diesem Gerät aufnehmen". Every string goes through `useTranslations("transcriptions")` (mic-permission strings reuse `useTranslations("chat")` → `composer.mic*`).
- **Frontend tests are pure-module vitest tests** (`vitest.config.ts`: `environment: "node"`, `*.test.ts` only). React components and DOM APIs are verified by `tsc --noEmit`, `eslint`, `next build` and the manual smoke in Task 16 — never write a `.test.tsx`.
- **Backend tests are jest** with the module-mock + chainable db-fake pattern from `src/exulu/recall/service.test.ts`. Path aliases `@SRC/*`, `@EXULU_TYPES/*`, `@EE/*` work in jest.
- **Commit messages** end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **A chunk that arrives after the row left `recording`** (Finish/Discard from another device) must be refused with 409 `not_recording` and never appended — Task 4 (`appendChunk` → `not_recording`) and Task 6 (route returns 409 before calling `transcribe`).
2. **A `skipped=true` chunk without a file** must append an empty placeholder and advance `chunk_count`, otherwise every later chunk is `out_of_order` forever — Task 4 (empty text appended) and Task 6 (skip path never calls `transcribe`).
3. **A silent chunk** (Gemini returns `""`) must still occupy its `seq` — Task 6 (`transcribe` resolves `{ text: "" }` → 200 and `appendChunk` called with `text: ""`).
4. **The composer mic must be byte-for-byte unchanged**: `transcribeAudio` without `priorText`/`tags` sends exactly today's body — Task 3 regression test.
5. **The client queue must never advance past a failing `seq`** and must send a skip marker only for deterministic rejections — Task 10 (`ChunkQueue` tests for retry-forever, skip-on-400, abort-on-409).

---

## Part A — Backend (`../backend-live-recording`, branch `feat/live-recording` off `develop`)

### Task 0: Worktree + verify-first spike (Gemini prior-text hint) — human-required

**Files:** none in the repo (throwaway script in the scratchpad).

- [ ] **Step 1: Create the backend worktree**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
git worktree add ../backend-live-recording -b feat/live-recording develop
ln -s /Users/daniel.claessen/Desktop/Projects/exulu/backend/node_modules ../backend-live-recording/node_modules
cd ../backend-live-recording && git branch --show-current && npx jest src/exulu/transcribe.test.ts 2>&1 | tail -5
```
Expected: branch `feat/live-recording`, existing transcribe tests PASS through the symlinked `node_modules`.

- [ ] **Step 2: Record two consecutive clips (Daniel)** — two ~30 s voice memos in a row, same speaker, German or English, saved as `part1.m4a` and `part2.m4a` in the scratchpad directory. The second clip should start mid-sentence if possible.

- [ ] **Step 3: Run the hint comparison against local LiteLLM (:4000, `gemini-transcribe`)**

Save as `<scratchpad>/prior-text-spike.py` and run `python3 prior-text-spike.py part1.m4a part2.m4a`:

```python
import base64, json, os, sys, urllib.request

BASE = os.environ.get("LITELLM_BASE", "http://127.0.0.1:4000")
KEY = os.environ["LITELLM_MASTER_KEY"]
MODEL = os.environ.get("TRANSCRIPTION_MODEL", "gemini-transcribe")
SYSTEM = ("You are a speech-to-text transcription engine. Detect the language actually spoken "
          "and transcribe it word-for-word in that same language. Never translate. Output only "
          "the transcript text — no quotes, labels, or commentary. If there is no intelligible "
          "speech, output nothing.")

def transcribe(path, prior=None):
    data = base64.b64encode(open(path, "rb").read()).decode()
    fmt = "mp4" if path.endswith((".m4a", ".mp4")) else path.rsplit(".", 1)[-1]
    text = "Transcribe this audio."
    if prior:
        text = ("Transcribe this audio. It is one part of a longer recording. "
                f"The previous part ended with: «{prior[-300:]}». "
                "Continue from there — do not repeat that text, do not summarise, do not add speaker labels.")
    body = {"model": MODEL, "temperature": 0, "reasoning_effort": "disable",
            "messages": [{"role": "system", "content": SYSTEM},
                         {"role": "user", "content": [{"type": "text", "text": text},
                                                      {"type": "input_audio", "input_audio": {"data": data, "format": fmt}}]}]}
    req = urllib.request.Request(f"{BASE}/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))["choices"][0]["message"]["content"].strip()

p1 = transcribe(sys.argv[1])
print("PART 1:\n", p1, "\n")
print("PART 2 without hint:\n", transcribe(sys.argv[2]), "\n")
print("PART 2 with hint:\n", transcribe(sys.argv[2], prior=p1), "\n")
```

- [ ] **Step 4: Decide** — the hint passes if "PART 2 with hint" (a) does not repeat the tail of part 1, (b) starts with the first words actually spoken in part 2, and (c) is not shorter than "PART 2 without hint". If it fails, keep `priorText` support in the code (Task 3) but set `LIVE_PRIOR_TEXT_ENABLED = false` in Task 6's route so the hint is not sent; record the outcome as a one-line note at the top of this plan's Task 6.

### Task 1: Schema columns and status type

**Files:**
- Modify: `src/postgres/core-schema.ts:698-741` (the `transcriptionJobsSchema` fields array, after the `video` field)
- Modify: `src/exulu/transcription/service.ts:35-41` (`JobStatus`) and `:66-95` (`JobRow`)
- Test: `src/postgres/core-schema.test.ts`

**Interfaces:**
- Produces: columns `chunk_count` (number, default 0) and `last_chunk_at` (date) on `transcription_jobs`; `JobStatus` includes `"recording"`; `JobRow` has `chunk_count`, `last_chunk_at`, `source`.

- [ ] **Step 1: Write the failing test** — append to `src/postgres/core-schema.test.ts`:

```ts
describe("transcription_jobs schema (live recording columns)", () => {
  test("declares chunk_count (default 0) and last_chunk_at", () => {
    const schema = coreSchemas.get().transcriptionJobsSchema();
    const chunkCount = schema.fields.find((f) => f.name === "chunk_count");
    const lastChunkAt = schema.fields.find((f) => f.name === "last_chunk_at");
    expect(chunkCount).toMatchObject({ type: "number", default: 0 });
    expect(lastChunkAt).toMatchObject({ type: "date" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/postgres/core-schema.test.ts -t "live recording"`
Expected: FAIL — `expect(received).toMatchObject` with `received: undefined`.

- [ ] **Step 3: Add the columns** — in `src/postgres/core-schema.ts`, directly after `{ name: "video", type: "file" },` inside `transcriptionJobsSchema.fields`:

```ts
    // Live (browser-microphone) recordings — spec
    // docs/superpowers/specs/2026-09-23-live-recording-transcription-design.md §2.
    // chunk_count is the NEXT expected chunk seq; the chunk route appends with
    // a compare-and-swap on it, so retries and duplicates can never double-append.
    { name: "chunk_count", type: "number", default: 0 },
    // Heartbeat of the last accepted chunk; shown in the queue row.
    { name: "last_chunk_at", type: "date" },
```

- [ ] **Step 4: Extend the service types** — in `src/exulu/transcription/service.ts` change `JobStatus` to:

```ts
export type JobStatus =
  | "queued"
  | "transcribing"
  | "recording" // live browser recording in progress (chunks arriving)
  | "awaiting_review"
  | "saved"
  | "failed"
  | "cancelled";
```

and add to the `JobRow` type, after `recall_recording_id`:

```ts
  /** "whisper" | "recall" | "live" — which pipeline drives the row. */
  source?: string | null;
  /** Live recordings: next expected chunk seq (CAS target for the chunk route). */
  chunk_count?: number | null;
  /** Live recordings: when the last chunk was accepted. */
  last_chunk_at?: string | null;
```

- [ ] **Step 5: Run the tests and type-check**

Run: `npx jest src/postgres/core-schema.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend-live-recording && git rev-parse --show-toplevel && git branch --show-current && \
git add src/postgres/core-schema.ts src/postgres/core-schema.test.ts src/exulu/transcription/service.ts && \
git commit -m "feat(transcription): chunk_count/last_chunk_at columns + recording status for live recordings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 2: Shared ownership check (`authorize.ts`)

**Files:**
- Create: `src/exulu/transcription/authorize.ts`
- Create: `src/exulu/transcription/authorize.test.ts`
- Modify: `src/graphql/schemas/index.ts:1988-2005` (replace the closure body with a call to the shared helper)

**Interfaces:**
- Produces: `assertOwnsTranscriptionJob(db, user, id): Promise<void>` throwing `TranscriptionJobAccessError` (`code: 403 | 404`). Used by Task 5 resolvers and Task 6 route.

- [ ] **Step 1: Write the failing test** — `src/exulu/transcription/authorize.test.ts`:

```ts
import { assertOwnsTranscriptionJob, TranscriptionJobAccessError } from "./authorize";

// Minimal knex-shaped fake: db.from(table).select([...]).where({id}).first()
const dbWith = (row: unknown) => {
  const first = jest.fn(async () => row);
  const db = { from: jest.fn(() => ({ select: () => ({ where: () => ({ first }) }) })) };
  return { db, first };
};

describe("assertOwnsTranscriptionJob", () => {
  it("rejects when there is no user (403) without touching the db", async () => {
    const { db } = dbWith(null);
    await expect(assertOwnsTranscriptionJob(db, null, "job-1")).rejects.toMatchObject({ code: 403 });
    expect(db.from).not.toHaveBeenCalled();
  });

  it("lets a super admin through without reading the row", async () => {
    const { db } = dbWith(null);
    await expect(assertOwnsTranscriptionJob(db, { id: 9, super_admin: true }, "job-1")).resolves.toBeUndefined();
    expect(db.from).not.toHaveBeenCalled();
  });

  it("404s when the row does not exist", async () => {
    const { db } = dbWith(undefined);
    await expect(assertOwnsTranscriptionJob(db, { id: 1 }, "missing")).rejects.toMatchObject({ code: 404 });
  });

  it("lets anyone act on a public row", async () => {
    const { db } = dbWith({ created_by: "2", rights_mode: "public" });
    await expect(assertOwnsTranscriptionJob(db, { id: 1 }, "job-1")).resolves.toBeUndefined();
  });

  it("compares created_by (text) against user.id (int) as strings", async () => {
    const { db } = dbWith({ created_by: "7", rights_mode: "private" });
    await expect(assertOwnsTranscriptionJob(db, { id: 7 }, "job-1")).resolves.toBeUndefined();
  });

  it("403s a stranger on a private row", async () => {
    const { db } = dbWith({ created_by: "7", rights_mode: "private" });
    const err = await assertOwnsTranscriptionJob(db, { id: 8 }, "job-1").catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptionJobAccessError);
    expect(err.code).toBe(403);
    expect(err.message).toBe("Not authorized to act on this transcription job");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/exulu/transcription/authorize.test.ts`
Expected: FAIL — `Cannot find module './authorize'`.

- [ ] **Step 3: Create `src/exulu/transcription/authorize.ts`**

```ts
/**
 * Ownership check shared by the custom transcription GraphQL resolvers
 * (transcriptionJobFinalize/Cancel, runTranscriptPostProcessing,
 * recordingVideoUrl, liveRecordingStop) and the live-recording chunk REST
 * route. Mirrors createMutations.validateWriteAccess for RBAC tables:
 * super-admins pass, public rows pass, otherwise only the creator.
 *
 * `created_by` is a text column while `user.id` is an integer SERIAL, so the
 * comparison is string-based — a raw `===` fails for the legitimate creator
 * ("1" === 1 → false). Matches utils/check-record-access.ts.
 */
export class TranscriptionJobAccessError extends Error {
  constructor(
    public readonly code: 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = "TranscriptionJobAccessError";
  }
}

export type TranscriptionJobUser = {
  id: number | string;
  super_admin?: boolean | null;
};

// `db` is a knex instance; only .from().select().where().first() is used.
export async function assertOwnsTranscriptionJob(
  db: any,
  user: TranscriptionJobUser | null | undefined,
  id: string,
): Promise<void> {
  if (!user) throw new TranscriptionJobAccessError(403, "Authentication required");
  if (user.super_admin === true) return;
  const row = await db
    .from("transcription_jobs")
    .select(["created_by", "rights_mode"])
    .where({ id })
    .first();
  if (!row) throw new TranscriptionJobAccessError(404, `transcription_job ${id} not found`);
  if (row.rights_mode === "public") return;
  if (row.created_by != null && String(row.created_by) === String(user.id)) return;
  throw new TranscriptionJobAccessError(403, "Not authorized to act on this transcription job");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/exulu/transcription/authorize.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Point the resolvers at the shared helper** — in `src/graphql/schemas/index.ts` add the import next to the other transcription imports (line ~45):

```ts
import { assertOwnsTranscriptionJob as assertOwnsTranscriptionJobShared } from "@SRC/exulu/transcription/authorize";
```

and replace the whole local `const assertOwnsTranscriptionJob = async (id: string, context: any) => { … }` closure (lines ~1988-2005, keep the comment above it) with:

```ts
  const assertOwnsTranscriptionJob = async (id: string, context: any) =>
    assertOwnsTranscriptionJobShared(context.db, context.user, id);
```

The four existing call sites (`transcriptionJobFinalize`, `transcriptionJobCancel`, `runTranscriptPostProcessing`, `recordingVideoUrl`) stay untouched; error messages are identical to before.

- [ ] **Step 6: Type-check and run the transcription suites**

Run: `npx tsc --noEmit && npx jest src/exulu/transcription src/exulu/recall`
Expected: no type errors; all PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend-live-recording && git rev-parse --show-toplevel && git branch --show-current && \
git add src/exulu/transcription/authorize.ts src/exulu/transcription/authorize.test.ts src/graphql/schemas/index.ts && \
git commit -m "refactor(transcription): extract assertOwnsTranscriptionJob for reuse by REST routes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 3: `transcribeAudio` gains `priorText` and `tags`

**Files:**
- Modify: `src/exulu/transcribe.ts:51-57` (`TranscribeArgs`), `:83-96` (audio path form), `:116-141` (chat body)
- Test: `src/exulu/transcribe.test.ts` (append to the `transcribeAudio routing` describe block)

**Interfaces:**
- Produces: `transcribeAudio({ file, language?, priorText?, tags? })`, `buildTranscribeUserText(priorText?)`, `PRIOR_TEXT_MAX_CHARS = 300`. Consumed by Task 6.

- [ ] **Step 1: Write the failing tests** — append inside `describe("transcribeAudio routing", …)` in `src/exulu/transcribe.test.ts` (they reuse the `beforeEach` env setup and `audioArgs()` helper already in the file):

```ts
  it("keeps today's exact chat body when neither priorText nor tags are given (composer regression lock)", async () => {
    findLiteLLMModel.mockResolvedValue({ upstream_model: "vertex_ai/gemini-2.5-flash" });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "x" } }] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await transcribeAudio(audioArgs());

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(Object.keys(body).sort()).toEqual(["messages", "model", "reasoning_effort", "temperature"]);
    expect(body.messages[1].content[0]).toEqual({ type: "text", text: "Transcribe this audio." });
  });

  it("appends the prior-text continuity hint (clipped to the last 300 chars) on the chat path", async () => {
    findLiteLLMModel.mockResolvedValue({ upstream_model: "vertex_ai/gemini-2.5-flash" });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "x" } }] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const prior = "a".repeat(250) + "b".repeat(100); // 350 chars → last 300 = 200 a's + 100 b's

    await transcribeAudio({ ...audioArgs(), priorText: prior });

    const text: string = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
      .messages[1].content[0].text;
    expect(text).toMatch(/^Transcribe this audio\. It is one part of a longer recording\./);
    expect(text).toContain("«" + "a".repeat(200) + "b".repeat(100) + "»");
    expect(text).not.toContain("a".repeat(201));
    expect(text).toMatch(/do not repeat that text/);
  });

  it("sends tags as metadata.tags on the chat path", async () => {
    findLiteLLMModel.mockResolvedValue({ upstream_model: "vertex_ai/gemini-2.5-flash" });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "x" } }] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await transcribeAudio({ ...audioArgs(), tags: ["user_id_7", "project_id_p1"] });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.metadata).toEqual({ tags: ["user_id_7", "project_id_p1"] });
  });

  it("passes priorText as the whisper `prompt` form field on the audio path", async () => {
    findLiteLLMModel.mockResolvedValue({ upstream_model: "whisper-1" });
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ text: "hallo" }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await transcribeAudio({ ...audioArgs(), priorText: "wir sprachen über" });

    const form = (fetchMock.mock.calls[0][1] as RequestInit).body as FormData;
    expect(form.get("prompt")).toBe("wir sprachen über");
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest src/exulu/transcribe.test.ts`
Expected: the regression-lock test PASSES already; the other three FAIL (`priorText`/`tags` are not in `TranscribeArgs` → TS error, or assertions on the body fail).

- [ ] **Step 3: Implement** — in `src/exulu/transcribe.ts`:

Replace the `TranscribeArgs` type with:

```ts
type TranscribeArgs = {
  file: { buffer: Buffer; originalname: string; mimetype: string };
  // ISO-639-1 language code (e.g. "de", "en"). Whisper path only — the Gemini
  // path deliberately ignores it (see transcribeViaChat).
  language?: string;
  /**
   * Live recordings: the tail of the previous chunk's transcript. Gemini path:
   * appended to the user turn as a continuity hint (clipped to
   * PRIOR_TEXT_MAX_CHARS); whisper path: sent as the `prompt` hint field.
   */
  priorText?: string;
  /** LiteLLM spend-attribution tags (buildTags). Gemini path only (metadata.tags). */
  tags?: string[];
};

export const PRIOR_TEXT_MAX_CHARS = 300;

/** User-turn text for the Gemini path; with a prior tail it becomes a continuity instruction. */
export function buildTranscribeUserText(priorText?: string): string {
  const tail = (priorText ?? "").trim();
  if (!tail) return "Transcribe this audio.";
  const clipped = tail.length > PRIOR_TEXT_MAX_CHARS ? tail.slice(-PRIOR_TEXT_MAX_CHARS) : tail;
  return (
    "Transcribe this audio. It is one part of a longer recording. " +
    `The previous part ended with: «${clipped}». ` +
    "Continue from there — do not repeat that text, do not summarise, do not add speaker labels."
  );
}
```

In `transcribeViaAudioEndpoint`, after `if (args.language) form.append("language", args.language);` add:

```ts
  if (args.priorText?.trim()) form.append("prompt", args.priorText.trim().slice(-PRIOR_TEXT_MAX_CHARS));
```

In `transcribeViaChat`, change the `body` literal to:

```ts
  const body = {
    model,
    temperature: 0,
    reasoning_effort: "disable",
    messages: [
      { role: "system", content: TRANSCRIBE_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: buildTranscribeUserText(args.priorText) },
          {
            type: "input_audio",
            input_audio: { data: args.file.buffer.toString("base64"), format },
          },
        ],
      },
    ],
    // LiteLLM reads metadata.tags for tag-based spend tracking (same mechanism
    // as resolve-ocr.ts). Omitted entirely when empty so the composer's body is
    // byte-for-byte unchanged.
    ...(args.tags && args.tags.length > 0 ? { metadata: { tags: args.tags } } : {}),
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/exulu/transcribe.test.ts && npx tsc --noEmit`
Expected: PASS (all, including the four new ones); no type errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend-live-recording && git rev-parse --show-toplevel && git branch --show-current && \
git add src/exulu/transcribe.ts src/exulu/transcribe.test.ts && \
git commit -m "feat(transcribe): optional prior-text continuity hint and LiteLLM spend tags

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 4: Live recording service (`live-recording.ts`)

**Files:**
- Create: `src/exulu/transcription/live-recording.ts`
- Create: `src/exulu/transcription/live-recording.test.ts`

**Interfaces:**
- Consumes: `recallService.runPostProcessing(jobId)` (`src/exulu/recall/service.ts:454`, generic on job id), `isLiteLLMEnabled()` (`src/exulu/litellm/supervisor.ts`), `RawSegment` (`./transcript-text`).
- Produces (used by Tasks 5, 6):
  - `liveRecordingEnabled(): boolean`, `LIVE_RECORDING_DISABLED_MESSAGE: string`
  - `liveRecordingService.start(input: LiveRecordingStartInput): Promise<LiveJobRow>`
  - `liveRecordingService.appendChunk(input: AppendChunkInput): Promise<AppendChunkResult>`
  - `liveRecordingService.stop(id: string, input: LiveRecordingStopInput): Promise<LiveJobRow>`
  - types `LiveRecordingStartInput`, `AppendChunkInput`, `AppendChunkResult`, `LiveRecordingStopInput`, `LiveJobRow`

- [ ] **Step 1: Write the failing tests** — `src/exulu/transcription/live-recording.test.ts`:

```ts
/**
 * liveRecordingService — row insert shape, the compare-and-swap chunk append,
 * and the stop transition. Same module-mock + chainable db-fake pattern as
 * src/exulu/recall/service.test.ts, plus `db.raw` (the append uses jsonb ||).
 */
const runPostProcessingSpy = jest.fn(async () => []);
jest.mock("@SRC/exulu/recall/service", () => ({
  recallService: { runPostProcessing: (...args: any[]) => runPostProcessingSpy(...args) },
}));

const isLiteLLMEnabledSpy = jest.fn(() => true);
jest.mock("@SRC/exulu/litellm/supervisor", () => ({
  isLiteLLMEnabled: () => isLiteLLMEnabledSpy(),
}));

const calls: Record<string, any[][]> = {};
const firstResults: Record<string, any[]> = {};
const updateResults: Record<string, number[]> = {};

const record = (table: string, name: string, builder: any) =>
  (...args: any[]) => {
    (calls[`${table}.${name}`] ||= []).push(args);
    return builder;
  };

const builderFor = (table: string) => {
  const builder: any = {};
  for (const m of ["where", "select", "whereIn", "whereNotIn", "orderBy"]) {
    builder[m] = record(table, m, builder);
  }
  builder.first = jest.fn(async () => (firstResults[table] ||= []).shift());
  // update(): `await` → affected count; `.returning("*")` → [] when count is 0.
  builder.update = (values: any) => {
    (calls[`${table}.update`] ||= []).push([values]);
    const count = (updateResults[table] ||= []).shift() ?? 1;
    const thenable: any = Promise.resolve(count);
    thenable.returning = jest.fn(async () => (count === 0 ? [] : [{ id: "jr-1", ...values }]));
    return thenable;
  };
  builder.insert = (values: any) => {
    (calls[`${table}.insert`] ||= []).push([values]);
    return { returning: jest.fn(async () => [{ id: "jr-1", ...values }]) };
  };
  return builder;
};

const db: any = jest.fn((table: string) => builderFor(table));
db.from = (table: string) => builderFor(table);
db.raw = (sql: string, bindings?: unknown[]) => ({ __raw: sql, bindings });
jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({ db })),
}));

import {
  liveRecordingEnabled,
  liveRecordingService,
  LIVE_RECORDING_DISABLED_MESSAGE,
} from "./live-recording";

const JOBS = "transcription_jobs";

beforeEach(() => {
  for (const store of [calls, firstResults, updateResults]) {
    for (const key of Object.keys(store)) delete store[key];
  }
  jest.clearAllMocks();
  isLiteLLMEnabledSpy.mockReturnValue(true);
  process.env.TRANSCRIPTION_MODEL = "gemini-transcribe";
});

describe("liveRecordingEnabled", () => {
  it("requires LiteLLM and TRANSCRIPTION_MODEL", () => {
    expect(liveRecordingEnabled()).toBe(true);
    delete process.env.TRANSCRIPTION_MODEL;
    expect(liveRecordingEnabled()).toBe(false);
    process.env.TRANSCRIPTION_MODEL = "x";
    isLiteLLMEnabledSpy.mockReturnValue(false);
    expect(liveRecordingEnabled()).toBe(false);
    expect(LIVE_RECORDING_DISABLED_MESSAGE).toMatch(/TRANSCRIPTION_MODEL/);
  });
});

describe("start", () => {
  it("inserts a live/recording row with chunk_count 0 and an empty segments array", async () => {
    const row = await liveRecordingService.start({
      userId: 7,
      title: "Standup",
      language: null,
      project_id: "p1",
      target_rights_mode: "users",
      target_rbac_users: [{ id: 3, rights: "read" }],
      target_rbac_roles: null,
      post_processing_prompts: [{ prompt_id: "pr1", agent_id: "ag1" }],
    });

    const [values] = calls[`${JOBS}.insert`][0];
    expect(values).toMatchObject({
      source: "live",
      status: "recording",
      chunk_count: 0,
      raw_segments: "[]",
      title: "Standup",
      project_id: "p1",
      target_rights_mode: "users",
      target_rbac_users: JSON.stringify([{ id: 3, rights: "read" }]),
      target_rbac_roles: null,
      post_processing_prompts: JSON.stringify([{ prompt_id: "pr1", agent_id: "ag1" }]),
      rights_mode: "private",
      created_by: 7,
    });
    expect(row.id).toBe("jr-1");
    expect(row.status).toBe("recording");
  });

  it("normalises an empty prompt list to NULL and defaults rights to private", async () => {
    await liveRecordingService.start({ userId: 1, post_processing_prompts: [] });
    const [values] = calls[`${JOBS}.insert`][0];
    expect(values.post_processing_prompts).toBeNull();
    expect(values.target_rights_mode).toBe("private");
    expect(values.title).toBeNull();
  });
});

describe("appendChunk", () => {
  const input = { id: "jr-1", seq: 2, text: "hello there", offsetMs: 40_000, durationMs: 30_000 };

  it("appends with a compare-and-swap on chunk_count and returns the new count", async () => {
    updateResults[JOBS] = [1];

    const result = await liveRecordingService.appendChunk(input);

    expect(result).toEqual({ kind: "appended", chunkCount: 3 });
    expect(calls[`${JOBS}.where`][0][0]).toEqual({ id: "jr-1", status: "recording", chunk_count: 2 });
    const [values] = calls[`${JOBS}.update`][0];
    expect(values.chunk_count).toBe(3);
    expect(values.last_chunk_at).toBeInstanceOf(Date);
    // jsonb append of exactly one segment, seconds from the recording origin.
    expect(values.raw_segments.__raw).toMatch(/COALESCE\(raw_segments, '\[\]'::jsonb\) \|\| \?::jsonb/);
    expect(JSON.parse(values.raw_segments.bindings[0])).toEqual([
      { start: 40, end: 70, text: "hello there", speaker: "unknown" },
    ]);
    expect(values.duration_seconds.__raw).toMatch(/GREATEST/);
    expect(values.duration_seconds.bindings).toEqual([70]);
    // No re-read needed on the happy path.
    expect(calls[`${JOBS}.first`]).toBeUndefined();
  });

  it("stores a silent chunk with empty text so raw_segments[seq] always exists", async () => {
    updateResults[JOBS] = [1];
    await liveRecordingService.appendChunk({ ...input, text: "" });
    const [values] = calls[`${JOBS}.update`][0];
    expect(JSON.parse(values.raw_segments.bindings[0])[0].text).toBe("");
  });

  it("returns the stored text for a duplicate seq instead of appending twice", async () => {
    updateResults[JOBS] = [0];
    firstResults[JOBS] = [
      {
        status: "recording",
        chunk_count: 3,
        raw_segments: [
          { start: 0, end: 20, text: "one", speaker: "unknown" },
          { start: 20, end: 40, text: "two", speaker: "unknown" },
          { start: 40, end: 70, text: "three", speaker: "unknown" },
        ],
      },
    ];

    const result = await liveRecordingService.appendChunk({ ...input, seq: 1 });

    expect(result).toEqual({ kind: "duplicate", text: "two", chunkCount: 3 });
  });

  it("tolerates raw_segments arriving as a JSON string on the duplicate path", async () => {
    updateResults[JOBS] = [0];
    firstResults[JOBS] = [
      { status: "recording", chunk_count: 1, raw_segments: JSON.stringify([{ start: 0, end: 20, text: "one", speaker: "unknown" }]) },
    ];
    const result = await liveRecordingService.appendChunk({ ...input, seq: 0 });
    expect(result).toEqual({ kind: "duplicate", text: "one", chunkCount: 1 });
  });

  it("reports out_of_order when seq is ahead of chunk_count", async () => {
    updateResults[JOBS] = [0];
    firstResults[JOBS] = [{ status: "recording", chunk_count: 1, raw_segments: [] }];
    const result = await liveRecordingService.appendChunk({ ...input, seq: 3 });
    expect(result).toEqual({ kind: "out_of_order", chunkCount: 1 });
  });

  it("refuses to append once the row has left 'recording'", async () => {
    updateResults[JOBS] = [0];
    firstResults[JOBS] = [{ status: "awaiting_review", chunk_count: 5, raw_segments: [] }];
    const result = await liveRecordingService.appendChunk(input);
    expect(result).toEqual({ kind: "not_recording", status: "awaiting_review" });
  });

  it("throws when the row is gone", async () => {
    updateResults[JOBS] = [0];
    firstResults[JOBS] = [undefined];
    await expect(liveRecordingService.appendChunk(input)).rejects.toThrow(/not found/);
  });
});

describe("stop", () => {
  it("moves a recording row to awaiting_review, stores the audio key + client duration, and kicks off post-processing", async () => {
    updateResults[JOBS] = [1];

    const row = await liveRecordingService.stop("jr-1", { audio_s3key: "bucket/user_7/x.webm", duration_seconds: 3601.5 });

    expect(calls[`${JOBS}.where`][0][0]).toEqual({ id: "jr-1", status: "recording" });
    const [values] = calls[`${JOBS}.update`][0];
    expect(values).toMatchObject({ status: "awaiting_review", audio_s3key: "bucket/user_7/x.webm", duration_seconds: 3601.5 });
    expect(row.status).toBe("awaiting_review");
    await Promise.resolve(); // let the fire-and-forget call schedule
    expect(runPostProcessingSpy).toHaveBeenCalledWith("jr-1");
  });

  it("keeps the server-side duration and audio when the client sends nulls (Finish on an abandoned row)", async () => {
    updateResults[JOBS] = [1];
    await liveRecordingService.stop("jr-1", { audio_s3key: null, duration_seconds: null });
    const [values] = calls[`${JOBS}.update`][0];
    expect(values).not.toHaveProperty("audio_s3key");
    expect(values).not.toHaveProperty("duration_seconds");
    expect(values.status).toBe("awaiting_review");
  });

  it("refuses to stop a row that is not recording and does not run post-processing", async () => {
    updateResults[JOBS] = [0];
    firstResults[JOBS] = [{ id: "jr-1", status: "saved" }];
    await expect(liveRecordingService.stop("jr-1", {})).rejects.toThrow(/status 'saved'/);
    expect(runPostProcessingSpy).not.toHaveBeenCalled();
  });

  it("does not fail the stop when post-processing rejects", async () => {
    updateResults[JOBS] = [1];
    runPostProcessingSpy.mockRejectedValueOnce(new Error("llm down"));
    await expect(liveRecordingService.stop("jr-1", {})).resolves.toMatchObject({ status: "awaiting_review" });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest src/exulu/transcription/live-recording.test.ts`
Expected: FAIL — `Cannot find module './live-recording'`.

- [ ] **Step 3: Create `src/exulu/transcription/live-recording.ts`**

```ts
/**
 * liveRecordingService — the browser-microphone ("Record on this device")
 * pipeline for transcription_jobs rows with source='live'.
 *
 * - start:       insert the row in status 'recording' (chunk_count 0).
 * - appendChunk: one compare-and-swap UPDATE that appends a RawSegment to
 *                raw_segments (jsonb ||) iff status='recording' AND
 *                chunk_count = seq. Retries/duplicates are idempotent; the
 *                sequence can never have holes.
 * - stop:        'recording' → 'awaiting_review' (+ audio key, duration), then
 *                fire-and-forget post-processing exactly like Recall does.
 *
 * Everything after 'awaiting_review' (review sheet, finalize, saved item) is
 * the shared transcription pipeline and untouched.
 *
 * Design doc: docs/superpowers/specs/2026-09-23-live-recording-transcription-design.md
 */
import { postgresClient } from "@SRC/postgres/client";
import { isLiteLLMEnabled } from "@SRC/exulu/litellm/supervisor";
import { recallService } from "@SRC/exulu/recall/service";
import type { ExuluRightsMode } from "@EXULU_TYPES/rbac-rights-modes";
import type { RawSegment } from "./transcript-text";

const TABLE = "transcription_jobs";
const log = (msg: string) => console.log(`[EXULU-LIVE-RECORDING] ${msg}`);

export const LIVE_RECORDING_DISABLED_MESSAGE =
  "Speech-to-text is not enabled on this deployment. " +
  "Set EXULU_USE_LITELLM=true and TRANSCRIPTION_MODEL in the environment.";

/** Same gate as the composer mic (/transcribe): LiteLLM on + a transcription model. */
export function liveRecordingEnabled(): boolean {
  return isLiteLLMEnabled() && Boolean(process.env.TRANSCRIPTION_MODEL);
}

export type LiveRecordingStartInput = {
  userId: number;
  title?: string | null;
  language?: string | null;
  project_id?: string | null;
  target_rights_mode?: ExuluRightsMode | null;
  target_rbac_users?: { id: number; rights: "read" | "write" }[] | null;
  target_rbac_roles?: { id: string; rights: "read" | "write" }[] | null;
  post_processing_prompts?: { prompt_id: string; agent_id: string }[] | null;
};

export type AppendChunkInput = {
  id: string;
  /** 0-based chunk index; must equal the row's chunk_count to be accepted. */
  seq: number;
  text: string;
  offsetMs: number;
  durationMs: number;
};

export type AppendChunkResult =
  | { kind: "appended"; chunkCount: number }
  | { kind: "duplicate"; text: string; chunkCount: number }
  | { kind: "out_of_order"; chunkCount: number }
  | { kind: "not_recording"; status: string };

export type LiveRecordingStopInput = {
  audio_s3key?: string | null;
  /** Client-side authoritative total; null/0 keeps the server-side value. */
  duration_seconds?: number | null;
};

/** The db row with JSON columns parsed (jsonb comes back as objects, but tolerate strings). */
export type LiveJobRow = {
  id: string;
  status: string;
  source: string;
  chunk_count: number;
  raw_segments: RawSegment[] | null;
  [key: string]: unknown;
};

const parseJson = <T>(v: unknown): T | null => {
  if (v == null) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
};

const rowFromDb = (dbRow: any): LiveJobRow => ({
  ...dbRow,
  chunk_count: Number(dbRow.chunk_count ?? 0),
  raw_segments: parseJson<RawSegment[]>(dbRow.raw_segments),
});

export const liveRecordingService = {
  async start(input: LiveRecordingStartInput): Promise<LiveJobRow> {
    const { db } = await postgresClient();
    const now = new Date();
    const [inserted] = await db(TABLE)
      .insert({
        source: "live",
        status: "recording",
        chunk_count: 0,
        raw_segments: "[]",
        title: input.title?.trim() ? input.title.trim() : null,
        language: input.language && input.language !== "auto" ? input.language : null,
        project_id: input.project_id ?? null,
        target_rights_mode: input.target_rights_mode ?? "private",
        target_rbac_users: input.target_rbac_users ? JSON.stringify(input.target_rbac_users) : null,
        target_rbac_roles: input.target_rbac_roles ? JSON.stringify(input.target_rbac_roles) : null,
        // NULL when empty — mirrors recallService.createMeetingBot so
        // runPostProcessing's "no prompts" short-circuit works unchanged.
        post_processing_prompts: input.post_processing_prompts?.length
          ? JSON.stringify(input.post_processing_prompts)
          : null,
        rights_mode: "private",
        created_by: input.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning("*");
    log(`started live recording ${inserted.id} for user ${input.userId}`);
    return rowFromDb(inserted);
  },

  async appendChunk(input: AppendChunkInput): Promise<AppendChunkResult> {
    const { db } = await postgresClient();
    const segment: RawSegment = {
      start: input.offsetMs / 1000,
      end: (input.offsetMs + input.durationMs) / 1000,
      text: input.text,
      speaker: "unknown",
    };
    const affected: number = await db(TABLE)
      .where({ id: input.id, status: "recording", chunk_count: input.seq })
      .update({
        raw_segments: db.raw("COALESCE(raw_segments, '[]'::jsonb) || ?::jsonb", [
          JSON.stringify([segment]),
        ]),
        chunk_count: input.seq + 1,
        duration_seconds: db.raw("GREATEST(COALESCE(duration_seconds, 0), ?)", [segment.end]),
        last_chunk_at: new Date(),
        updatedAt: new Date(),
      });
    if (affected === 1) return { kind: "appended", chunkCount: input.seq + 1 };

    // CAS refused: find out why without ever appending.
    const row = await db(TABLE)
      .select(["status", "chunk_count", "raw_segments"])
      .where({ id: input.id })
      .first();
    if (!row) throw new Error(`transcription_job ${input.id} not found`);
    if (row.status !== "recording") return { kind: "not_recording", status: row.status };
    const chunkCount = Number(row.chunk_count ?? 0);
    if (chunkCount > input.seq) {
      const segments = parseJson<RawSegment[]>(row.raw_segments) ?? [];
      return { kind: "duplicate", text: segments[input.seq]?.text ?? "", chunkCount };
    }
    return { kind: "out_of_order", chunkCount };
  },

  async stop(id: string, input: LiveRecordingStopInput): Promise<LiveJobRow> {
    const { db } = await postgresClient();
    const patch: Record<string, unknown> = { status: "awaiting_review", updatedAt: new Date() };
    if (input.audio_s3key) patch.audio_s3key = input.audio_s3key;
    if (typeof input.duration_seconds === "number" && input.duration_seconds > 0) {
      patch.duration_seconds = input.duration_seconds;
    }
    const [updated] = await db(TABLE).where({ id, status: "recording" }).update(patch).returning("*");
    if (!updated) {
      const row = await db(TABLE).where({ id }).first();
      if (!row) throw new Error(`transcription_job ${id} not found`);
      throw new Error(
        `transcription_job ${id} is in status '${row.status}'; can only stop from 'recording'`,
      );
    }
    log(`live recording ${id} stopped → awaiting_review`);
    // Same fire-and-forget shape as recallService._onTranscriptDone: a crashed
    // run leaves never-ran prompts, which the review sheet shows as Run cards.
    void recallService.runPostProcessing(id).catch((err: unknown) => {
      log(`post-processing for job ${id} failed: ${(err as Error).message}`);
    });
    return rowFromDb(updated);
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/exulu/transcription/live-recording.test.ts && npx tsc --noEmit`
Expected: PASS (13 tests); no type errors. If `isLiteLLMEnabled` is not exported from `src/exulu/litellm/supervisor.ts` under that name, check `routes.ts:57` — it imports `isLiteLLMEnabled` from exactly that module, so the name is right.

- [ ] **Step 5: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend-live-recording && git rev-parse --show-toplevel && git branch --show-current && \
git add src/exulu/transcription/live-recording.ts src/exulu/transcription/live-recording.test.ts && \
git commit -m "feat(transcription): liveRecordingService — start / CAS chunk append / stop

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 5: GraphQL mutations, `/config.whisper`, boot log

**Files:**
- Modify: `src/graphql/schemas/index.ts:722-728` (mutationDefs block with `meetingBotStart`), `:737-790` (modelDefs inputs), `:2007-2098` (resolvers, add after `runTranscriptPostProcessing`)
- Modify: `src/exulu/routes.ts:557-584` (`GET /config` — the FIRST one; the duplicate near line 3171 is dead code, leave it)
- Modify: `src/exulu/app/index.ts:350-356` (after the TRANSCRIPTION_MODEL warning)

**Interfaces:**
- Consumes: Task 4 (`liveRecordingService`, `liveRecordingEnabled`, `LIVE_RECORDING_DISABLED_MESSAGE`), Task 2 (`assertOwnsTranscriptionJob` local wrapper).
- Produces: mutations `liveRecordingStart(input: LiveRecordingStartInput!): transcription_job` and `liveRecordingStop(id: ID!, input: LiveRecordingStopInput): transcription_job`; `/config` field `whisper: { enabled: boolean }`.

- [ ] **Step 1: Schema definitions** — in `src/graphql/schemas/index.ts`, extend the mutationDefs block that contains `meetingBotStart` to:

```ts
  mutationDefs += `
    transcriptionJobStart(input: TranscriptionJobStartInput!): transcription_job
    transcriptionJobFinalize(id: ID!, input: TranscriptionJobFinalizeInput!): TranscriptionJobFinalizeResult
    transcriptionJobCancel(id: ID!): transcription_job
    meetingBotStart(input: MeetingBotStartInput!): transcription_job
    runTranscriptPostProcessing(id: ID!, prompt_id: ID!, agent_id: ID!): transcription_job
    liveRecordingStart(input: LiveRecordingStartInput!): transcription_job
    liveRecordingStop(id: ID!, input: LiveRecordingStopInput): transcription_job
    `;
```

and add to the modelDefs block right after `input PostProcessingPromptInput { … }`:

```graphql
    input LiveRecordingStartInput {
      title: String
      language: String
      project_id: ID
      target_rights_mode: String
      target_rbac_users: [RBACUserInput!]
      target_rbac_roles: [RBACRoleInput!]
      post_processing_prompts: [PostProcessingPromptInput!]
    }

    input LiveRecordingStopInput {
      audio_s3key: String
      duration_seconds: Float
    }
```

- [ ] **Step 2: Resolvers** — add the import next to the other transcription imports:

```ts
import {
  liveRecordingService,
  liveRecordingEnabled,
  LIVE_RECORDING_DISABLED_MESSAGE,
} from "@SRC/exulu/transcription/live-recording";
```

and, directly after the `resolvers.Mutation["runTranscriptPostProcessing"]` block:

```ts
  // Live (browser microphone) recordings — spec 2026-09-23. Gate mirrors the
  // composer mic (/transcribe); the frontend hides the mode on the same flag.
  resolvers.Mutation["liveRecordingStart"] = async (_, args, context) => {
    const { user } = context;
    if (!user) throw new Error("Authentication required");
    if (!liveRecordingEnabled()) {
      throw new Error(`LIVE_RECORDING_DISABLED: ${LIVE_RECORDING_DISABLED_MESSAGE}`);
    }
    return liveRecordingService.start({
      userId: user.id,
      title: args.input.title ?? null,
      language: args.input.language ?? null,
      project_id: args.input.project_id ?? null,
      target_rights_mode: args.input.target_rights_mode ?? null,
      target_rbac_users: args.input.target_rbac_users ?? null,
      target_rbac_roles: args.input.target_rbac_roles ?? null,
      post_processing_prompts: args.input.post_processing_prompts ?? null,
    });
  };

  resolvers.Mutation["liveRecordingStop"] = async (_, args, context) => {
    await assertOwnsTranscriptionJob(args.id, context);
    return liveRecordingService.stop(args.id, {
      audio_s3key: args.input?.audio_s3key ?? null,
      duration_seconds: args.input?.duration_seconds ?? null,
    });
  };
```

- [ ] **Step 3: `/config` exposes the Whisper flag** — in `src/exulu/routes.ts` add the import (next to line 65's `transcribe.ts` import):

```ts
import { transcriptionClient } from "./transcription/client.ts";
```

and inside the `GET /config` JSON at line ~557, after the `recall: { … }` entry:

```ts
      // Whisper upload transcription (TRANSCRIPTION_SERVER). The Transcripts
      // page gates its "Upload a file" mode on this — previously it was gated
      // on the composer-mic flag and showed an upload mode that could not work.
      whisper: {
        enabled: transcriptionClient.isConfigured(),
      },
```

- [ ] **Step 4: Boot log** — in `src/exulu/app/index.ts`, after the `if (process.env.TRANSCRIPTION_MODEL && !isLiteLLMEnabled()) { … }` block, add:

```ts
    console.log(
      `[EXULU] Live recording (Transcripts page): ${liveRecordingEnabled() ? "enabled" : "disabled"} ` +
      `(EXULU_USE_LITELLM=${process.env.EXULU_USE_LITELLM ?? "unset"}, ` +
      `TRANSCRIPTION_MODEL=${process.env.TRANSCRIPTION_MODEL ? "set" : "unset"})`,
    );
```

with `import { liveRecordingEnabled } from "@SRC/exulu/transcription/live-recording";` alongside the file's other transcription imports (it already imports `transcriptionClient` and `startTranscriptionPollingLoop`; match that import style/path alias).

- [ ] **Step 5: Type-check, lint, run the touched suites**

Run: `npx tsc --noEmit && npm run lint:errors && npx jest src/exulu/transcription src/exulu/transcribe.test.ts`
Expected: clean; all PASS.

- [ ] **Step 6: Smoke the schema against the dev database** (needs Daniel's local Postgres + `.env`; skip if not available and note it in the commit body):

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend-live-recording && npm run build && PORT=9011 node dist/index.js > /tmp/live-rec-smoke.log 2>&1 &
sleep 8 && curl -s http://127.0.0.1:9011/config | python3 -c 'import json,sys; c=json.load(sys.stdin); print("whisper:", c["whisper"], "recall:", c["recall"])'
grep "Live recording" /tmp/live-rec-smoke.log
kill %1
```
Expected: `whisper: {'enabled': False|True}` printed; the boot line `[EXULU] Live recording (Transcripts page): …` present. (If the package's start entry differs from `dist/index.js`, use the `start` script from `package.json`; do not bind the user's running dev ports 3000/4000/9001.)

- [ ] **Step 7: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend-live-recording && git rev-parse --show-toplevel && git branch --show-current && \
git add src/graphql/schemas/index.ts src/exulu/routes.ts src/exulu/app/index.ts && \
git commit -m "feat(graphql): liveRecordingStart/Stop mutations, /config.whisper flag, boot log

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 6: Chunk route module (`chunk-route.ts`) with supertest coverage

**Files:**
- Create: `src/exulu/transcription/chunk-route.ts`
- Create: `src/exulu/transcription/chunk-route.test.ts`

**Interfaces:**
- Consumes: Task 2 (`assertOwnsTranscriptionJob`, `TranscriptionJobAccessError`), Task 3 (`transcribeAudio` shape, `TranscriptionError`), Task 4 (`liveRecordingService.appendChunk`, `LIVE_RECORDING_DISABLED_MESSAGE`).
- Produces: `registerLiveRecordingChunkRoute(app, deps: ChunkRouteDeps)`, `CHUNK_ROUTE_PATH = "/transcription-jobs/:id/chunks"`, `priorTextFrom(segments)`, `LIVE_PRIOR_TEXT_ENABLED`. Wired in Task 7.

- [ ] **Step 1: Write the failing tests** — `src/exulu/transcription/chunk-route.test.ts`:

```ts
/**
 * POST /transcription-jobs/:id/chunks — the handler is built from injected
 * deps so the whole HTTP contract (status codes, JSON shapes, skip marker,
 * prior-text hint, tags) is testable with supertest and no LiteLLM/Postgres.
 */
import express from "express";
import multer from "multer";
import request from "supertest";

import { TranscriptionError } from "../transcribe";
import { TranscriptionJobAccessError } from "./authorize";
import { CHUNK_ROUTE_PATH, priorTextFrom, registerLiveRecordingChunkRoute, type ChunkRouteDeps } from "./chunk-route";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }).single("file");

type Row = { status: string; raw_segments: unknown; project_id: string | null } | undefined;

function build(overrides: Partial<ChunkRouteDeps> = {}, row: Row = { status: "recording", raw_segments: [], project_id: "p1" }) {
  const deps: ChunkRouteDeps = {
    upload,
    enabled: () => true,
    authenticate: async () => ({ user: { id: 7, email: "d@x.io" } }),
    getDb: async () => ({
      from: () => ({ select: () => ({ where: () => ({ first: async () => row }) }) }),
    }),
    assertOwns: async () => undefined,
    waitForLiteLLMReady: async () => undefined,
    buildTags: (input) => Object.entries(input).filter(([, v]) => v != null).map(([k, v]) => `${k}_${v}`),
    transcribe: jest.fn(async () => ({ text: "hello" })),
    service: { appendChunk: jest.fn(async () => ({ kind: "appended" as const, chunkCount: 2 })) },
    ...overrides,
  };
  const app = express();
  registerLiveRecordingChunkRoute(app, deps);
  return { app, deps };
}

const post = (app: express.Express, fields: Record<string, string> = {}, withFile = true) => {
  let req = request(app).post("/transcription-jobs/job-1/chunks");
  for (const [k, v] of Object.entries({ seq: "1", offset_ms: "20000", duration_ms: "30000", ...fields })) {
    req = req.field(k, v);
  }
  if (withFile) req = req.attach("file", Buffer.from("fake-audio"), { filename: "chunk.webm", contentType: "audio/webm" });
  return req;
};

describe("priorTextFrom", () => {
  it("returns the last non-empty segment text, clipped to 300 chars", () => {
    expect(priorTextFrom(null)).toBeUndefined();
    expect(priorTextFrom([{ start: 0, end: 1, text: "", speaker: "unknown" }])).toBeUndefined();
    expect(
      priorTextFrom([
        { start: 0, end: 1, text: "first", speaker: "unknown" },
        { start: 1, end: 2, text: "x".repeat(400), speaker: "unknown" },
        { start: 2, end: 3, text: "   ", speaker: "unknown" },
      ]),
    ).toBe("x".repeat(300));
    expect(priorTextFrom(JSON.stringify([{ start: 0, end: 1, text: "from json", speaker: "unknown" }]))).toBe("from json");
  });
});

describe(CHUNK_ROUTE_PATH, () => {
  it("503s when the feature is disabled, before auth", async () => {
    const authenticate = jest.fn();
    const { app } = build({ enabled: () => false, authenticate });
    const res = await post(app);
    expect(res.status).toBe(503);
    expect(res.body.detail).toMatch(/TRANSCRIPTION_MODEL/);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("401s without a user", async () => {
    const { app } = build({ authenticate: async () => ({ code: 401, message: "nope" }) });
    const res = await post(app);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ detail: "nope" });
  });

  it("maps ownership errors to their code", async () => {
    const { app } = build({
      assertOwns: async () => {
        throw new TranscriptionJobAccessError(403, "Not authorized to act on this transcription job");
      },
    });
    const res = await post(app);
    expect(res.status).toBe(403);
    expect(res.body.detail).toMatch(/Not authorized/);
  });

  it("409s (not_recording) when the row already left 'recording' — and never transcribes", async () => {
    const { app, deps } = build({}, { status: "awaiting_review", raw_segments: [], project_id: null });
    const res = await post(app);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ detail: expect.stringMatching(/awaiting_review/), kind: "not_recording" });
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.service.appendChunk).not.toHaveBeenCalled();
  });

  it("404s when the row is gone", async () => {
    const { app } = build({}, undefined);
    expect((await post(app)).status).toBe(404);
  });

  it("400s on a missing/invalid seq, offset_ms or duration_ms", async () => {
    const { app } = build();
    expect((await post(app, { seq: "abc" })).status).toBe(400);
    expect((await post(app, { offset_ms: "-1" })).status).toBe(400);
    expect((await post(app, { duration_ms: "0" })).status).toBe(400);
  });

  it("400s without a file or with a non-audio mimetype", async () => {
    const { app } = build();
    expect((await post(app, {}, false)).status).toBe(400);
    const res = await request(app)
      .post("/transcription-jobs/job-1/chunks")
      .field("seq", "1").field("offset_ms", "0").field("duration_ms", "1000")
      .attach("file", Buffer.from("x"), { filename: "c.bin", contentType: "video/webm" });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/video\/webm/);
  });

  it("503s when LiteLLM is not ready", async () => {
    const { app } = build({ waitForLiteLLMReady: () => new Promise(() => undefined) }); // never resolves
    jest.useFakeTimers();
    const pending = post(app);
    await jest.advanceTimersByTimeAsync(5_100);
    const res = await pending;
    jest.useRealTimers();
    expect(res.status).toBe(503);
  });

  it("transcribes with the prior-text tail and user/project tags, then appends", async () => {
    const { app, deps } = build(
      {},
      {
        status: "recording",
        raw_segments: [
          { start: 0, end: 20, text: "we talked about", speaker: "unknown" },
          { start: 20, end: 40, text: "", speaker: "unknown" },
        ],
        project_id: "p1",
      },
    );
    const res = await post(app, { seq: "2", offset_ms: "40000", duration_ms: "30000" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seq: 2, text: "hello", chunk_count: 2 });
    const args = (deps.transcribe as jest.Mock).mock.calls[0][0];
    expect(args.file.mimetype).toBe("audio/webm");
    expect(args.priorText).toBe("we talked about");
    expect(args.tags).toEqual(expect.arrayContaining(["user_id_7", "user_name_d@x.io", "project_id_p1"]));
    expect(deps.service.appendChunk).toHaveBeenCalledWith({
      id: "job-1", seq: 2, text: "hello", offsetMs: 40000, durationMs: 30000,
    });
  });

  it("stores a silent chunk (empty transcript) under its seq", async () => {
    const { app, deps } = build({ transcribe: jest.fn(async () => ({ text: "" })) });
    const res = await post(app);
    expect(res.status).toBe(200);
    expect(res.body.text).toBe("");
    expect(deps.service.appendChunk).toHaveBeenCalledWith(expect.objectContaining({ text: "" }));
  });

  it("skipped=true appends an empty placeholder without a file and without transcribing", async () => {
    const { app, deps } = build();
    const res = await post(app, { skipped: "true" }, false);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seq: 1, text: "", chunk_count: 2 });
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.service.appendChunk).toHaveBeenCalledWith(expect.objectContaining({ seq: 1, text: "" }));
  });

  it("returns the stored text for a duplicate seq", async () => {
    const { app } = build({
      service: { appendChunk: jest.fn(async () => ({ kind: "duplicate" as const, text: "earlier", chunkCount: 5 })) },
    });
    const res = await post(app);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seq: 1, text: "earlier", chunk_count: 5, duplicate: true });
  });

  it("409s (out_of_order) when the seq is ahead", async () => {
    const { app } = build({
      service: { appendChunk: jest.fn(async () => ({ kind: "out_of_order" as const, chunkCount: 0 })) },
    });
    const res = await post(app, { seq: "4" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ detail: expect.any(String), kind: "out_of_order", chunk_count: 0 });
  });

  it("409s (not_recording) when the append itself reports the row left 'recording'", async () => {
    const { app } = build({
      service: { appendChunk: jest.fn(async () => ({ kind: "not_recording" as const, status: "cancelled" })) },
    });
    const res = await post(app);
    expect(res.status).toBe(409);
    expect(res.body.kind).toBe("not_recording");
  });

  it("surfaces upstream 4xx as-is and 5xx as 502 without appending", async () => {
    const { app: app429, deps } = build({
      transcribe: jest.fn(async () => { throw new TranscriptionError(429, "rate limited"); }),
    });
    const res = await post(app429);
    expect(res.status).toBe(429);
    expect(res.body.detail).toMatch(/rate limited/);
    expect(deps.service.appendChunk).not.toHaveBeenCalled();

    const { app: app500 } = build({
      transcribe: jest.fn(async () => { throw new TranscriptionError(500, "boom"); }),
    });
    expect((await post(app500)).status).toBe(502);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest src/exulu/transcription/chunk-route.test.ts`
Expected: FAIL — `Cannot find module './chunk-route'`.

- [ ] **Step 3: Create `src/exulu/transcription/chunk-route.ts`**

```ts
/**
 * POST /transcription-jobs/:id/chunks — one audio chunk of a live recording.
 *
 * Mirrors /transcribe's handler order (gate → auth → validation → LiteLLM
 * readiness → transcribe → error mapping) and adds ownership + the
 * compare-and-swap append. Built from injected deps so the HTTP contract is
 * unit-testable (chunk-route.test.ts); routes.ts wires the real ones.
 *
 * Design doc: docs/superpowers/specs/2026-09-23-live-recording-transcription-design.md §3.4
 */
import type { Express, Request, RequestHandler, Response } from "express";

import { TranscriptionError } from "../transcribe";
import { TranscriptionJobAccessError, type TranscriptionJobUser } from "./authorize";
import { LIVE_RECORDING_DISABLED_MESSAGE, type AppendChunkInput, type AppendChunkResult } from "./live-recording";
import type { RawSegment } from "./transcript-text";

export const CHUNK_ROUTE_PATH = "/transcription-jobs/:id/chunks";

/**
 * Whether the previous chunk's tail is sent to the model as a continuity
 * hint. Flip to false if the Task 0 verify-first spike showed Gemini
 * repeating or truncating around the hint.
 */
export const LIVE_PRIOR_TEXT_ENABLED = true;

const PRIOR_TEXT_MAX_CHARS = 300;
const LITELLM_READY_TIMEOUT_MS = 5_000;

type AuthUser = TranscriptionJobUser & {
  email?: string | null;
  firstname?: string | null;
  type?: string | null;
};

export type ChunkRouteDeps = {
  /** multer().single("file") wrapper — shared with /transcribe (maps LIMIT_FILE_SIZE → 413). */
  upload: RequestHandler;
  enabled: () => boolean;
  authenticate: (req: Request) => Promise<{ user?: AuthUser | null; code?: number; message?: string }>;
  getDb: () => Promise<any>;
  assertOwns: (db: any, user: AuthUser, id: string) => Promise<void>;
  waitForLiteLLMReady: () => Promise<unknown>;
  buildTags: (input: { user_id?: number | string; user_name?: string; project_id?: string }) => string[];
  transcribe: (args: {
    file: { buffer: Buffer; originalname: string; mimetype: string };
    priorText?: string;
    tags?: string[];
  }) => Promise<{ text: string }>;
  service: { appendChunk: (input: AppendChunkInput) => Promise<AppendChunkResult> };
};

const parseSegments = (raw: unknown): RawSegment[] => {
  if (!raw) return [];
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as RawSegment[];
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? (raw as RawSegment[]) : [];
};

/** Tail of the most recent non-empty segment, clipped for the prompt. */
export function priorTextFrom(raw: unknown): string | undefined {
  const segments = parseSegments(raw);
  for (let i = segments.length - 1; i >= 0; i--) {
    const text = (segments[i]?.text ?? "").trim();
    if (text) return text.length > PRIOR_TEXT_MAX_CHARS ? text.slice(-PRIOR_TEXT_MAX_CHARS) : text;
  }
  return undefined;
}

const intField = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return Number(value);
};

export function registerLiveRecordingChunkRoute(app: Express, deps: ChunkRouteDeps): void {
  app.post(CHUNK_ROUTE_PATH, deps.upload, async (req: Request, res: Response) => {
    if (!deps.enabled()) {
      res.status(503).json({ detail: LIVE_RECORDING_DISABLED_MESSAGE });
      return;
    }

    const auth = await deps.authenticate(req);
    if (!auth.user?.id) {
      res.status(auth.code || 401).json({ detail: auth.message ?? "Authentication required" });
      return;
    }
    const user = auth.user;
    const jobId = req.params.id;

    const db = await deps.getDb();
    try {
      await deps.assertOwns(db, user, jobId);
    } catch (err) {
      if (err instanceof TranscriptionJobAccessError) {
        res.status(err.code).json({ detail: err.message });
        return;
      }
      throw err;
    }

    const row = await db
      .from("transcription_jobs")
      .select(["status", "raw_segments", "project_id"])
      .where({ id: jobId })
      .first();
    if (!row) {
      res.status(404).json({ detail: `transcription_job ${jobId} not found` });
      return;
    }
    if (row.status !== "recording") {
      res.status(409).json({ detail: `Recording is not active (status '${row.status}').`, kind: "not_recording" });
      return;
    }

    const seq = intField(req.body?.seq);
    const offsetMs = intField(req.body?.offset_ms);
    const durationMs = intField(req.body?.duration_ms);
    if (seq == null || offsetMs == null || durationMs == null || durationMs <= 0) {
      res.status(400).json({ detail: "seq, offset_ms (≥ 0) and duration_ms (> 0) are required integers." });
      return;
    }
    const skipped = req.body?.skipped === "true";

    let text = "";
    if (!skipped) {
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        res.status(400).json({ detail: "No audio file provided in 'file' field." });
        return;
      }
      if (!file.mimetype.startsWith("audio/")) {
        res.status(400).json({ detail: `Unsupported mimetype: ${file.mimetype}. Expected audio/*.` });
        return;
      }

      try {
        await Promise.race([
          deps.waitForLiteLLMReady(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("LiteLLM not ready")), LITELLM_READY_TIMEOUT_MS),
          ),
        ]);
      } catch {
        res.status(503).json({ detail: "Transcription service is not ready. Try again shortly." });
        return;
      }

      const tags = deps.buildTags({
        user_id: user.id,
        user_name: user.type === "api" ? (user.firstname ?? user.email ?? undefined) : (user.email ?? undefined),
        project_id: row.project_id ?? undefined,
      });

      try {
        ({ text } = await deps.transcribe({
          file,
          priorText: LIVE_PRIOR_TEXT_ENABLED ? priorTextFrom(row.raw_segments) : undefined,
          tags,
        }));
      } catch (err) {
        if (err instanceof TranscriptionError) {
          const code = err.upstreamStatus >= 500 ? 502 : err.upstreamStatus;
          res.status(code).json({ detail: err.message });
          return;
        }
        console.error(`[EXULU] ${CHUNK_ROUTE_PATH} transcription failed`, err);
        res.status(500).json({ detail: err instanceof Error ? err.message : "Transcription failed." });
        return;
      }
    }

    const result = await deps.service.appendChunk({ id: jobId, seq, text, offsetMs, durationMs });
    switch (result.kind) {
      case "appended":
        res.status(200).json({ seq, text, chunk_count: result.chunkCount });
        return;
      case "duplicate":
        res.status(200).json({ seq, text: result.text, chunk_count: result.chunkCount, duplicate: true });
        return;
      case "out_of_order":
        res.status(409).json({
          detail: `Chunk ${seq} is ahead of the next expected chunk ${result.chunkCount}.`,
          kind: "out_of_order",
          chunk_count: result.chunkCount,
        });
        return;
      case "not_recording":
        res.status(409).json({ detail: `Recording is not active (status '${result.status}').`, kind: "not_recording" });
        return;
    }
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/exulu/transcription/chunk-route.test.ts && npx tsc --noEmit`
Expected: PASS (16 tests); no type errors. If jest cannot resolve `express`/`supertest` types, both are already dependencies (`supertest` in devDependencies) — no install needed.

- [ ] **Step 5: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend-live-recording && git rev-parse --show-toplevel && git branch --show-current && \
git add src/exulu/transcription/chunk-route.ts src/exulu/transcription/chunk-route.test.ts && \
git commit -m "feat(transcription): live-recording chunk route handler with supertest coverage

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 7: Wire the chunk route into `routes.ts` and smoke the backend end-to-end

**Files:**
- Modify: `src/exulu/routes.ts:1218-1239` (extract the inline multer wrapper), after `:1306` (register the route)

**Interfaces:**
- Consumes: Task 6 `registerLiveRecordingChunkRoute`, Task 4 service/gate, Task 2 `assertOwnsTranscriptionJob`, existing `transcribeAudio`, `waitForLiteLLMReady`, `buildTags`, `requestValidators`, `postgresClient`.

- [ ] **Step 1: Extract the multer wrapper** — in `src/exulu/routes.ts`, replace the inline first argument of `app.post("/transcribe", (req, res, next) => { transcribeUpload.single("file")(req, res, (err) => { … }) }, async …)` with a named middleware defined right after `const transcribeUpload = multer({...})`:

```ts
  // Shared by /transcribe and /transcription-jobs/:id/chunks: parses the
  // single "file" field and maps multer's size error to a 413.
  const transcribeUploadMiddleware = (req: Request, res: Response, next: NextFunction) => {
    transcribeUpload.single("file")(req, res, (err: unknown) => {
      if (!err) return next();
      const code = (err as { code?: string })?.code;
      if (code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ detail: "Recording too large. Please record a shorter clip." });
        return;
      }
      res.status(400).json({ detail: err instanceof Error ? err.message : "Upload failed." });
    });
  };

  app.post("/transcribe", transcribeUploadMiddleware, async (req: Request, res: Response) => {
    // … existing handler body, unchanged …
  });
```

(`NextFunction` comes from `express`; add it to the existing `import type { … } from "express"` line if it is not already imported.)

- [ ] **Step 2: Register the chunk route** — directly after the closing `);` of the `/transcribe` registration (before the `// Text-to-speech.` comment):

```ts
  // Live (browser microphone) recordings: one audio chunk per request,
  // appended to the job's raw_segments. Same gate/limits as /transcribe.
  // Design doc: docs/superpowers/specs/2026-09-23-live-recording-transcription-design.md §3.4
  registerLiveRecordingChunkRoute(app, {
    upload: transcribeUploadMiddleware,
    enabled: liveRecordingEnabled,
    authenticate: (req) => requestValidators.authenticate(req),
    getDb: async () => (await postgresClient()).db,
    assertOwns: assertOwnsTranscriptionJob,
    waitForLiteLLMReady,
    buildTags,
    transcribe: transcribeAudio,
    service: liveRecordingService,
  });
```

with these imports next to the `./transcribe.ts` import:

```ts
import { registerLiveRecordingChunkRoute } from "./transcription/chunk-route.ts";
import { liveRecordingEnabled, liveRecordingService } from "./transcription/live-recording.ts";
import { assertOwnsTranscriptionJob } from "./transcription/authorize.ts";
```

- [ ] **Step 3: Type-check, lint, full backend suite**

Run: `npx tsc --noEmit && npm run lint:errors && npx jest`
Expected: clean; only the pre-existing failing suites (if any) fail — compare against `git stash; npx jest; git stash pop` on the same worktree if unsure, and list them in the commit body.

- [ ] **Step 4: Manual smoke against the local dev stack (Daniel's LiteLLM on :4000 must be up; do not bind :3000/:4000/:9001)**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend-live-recording && npm run build && PORT=9011 node dist/index.js > /tmp/live-rec-smoke.log 2>&1 &
sleep 8
TOKEN="<a valid JWT from the browser session, or an exulu-api-key>"
# 1. start a live job
JOB=$(curl -s http://127.0.0.1:9011/graphql -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"mutation { liveRecordingStart(input: { title: \"smoke\" }) { id status chunk_count source } }"}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]["liveRecordingStart"]; print(d["id"])')
echo "job $JOB"
# 2. two chunks (any short audio file, e.g. the Task 0 part1.m4a)
curl -s -X POST http://127.0.0.1:9011/transcription-jobs/$JOB/chunks -H "Authorization: Bearer $TOKEN" \
  -F seq=0 -F offset_ms=0 -F duration_ms=30000 -F "file=@part1.m4a;type=audio/mp4"
curl -s -X POST http://127.0.0.1:9011/transcription-jobs/$JOB/chunks -H "Authorization: Bearer $TOKEN" \
  -F seq=1 -F offset_ms=30000 -F duration_ms=30000 -F "file=@part2.m4a;type=audio/mp4"
# 3. duplicate seq → 200 duplicate:true ; seq 5 → 409 out_of_order
curl -s -X POST http://127.0.0.1:9011/transcription-jobs/$JOB/chunks -H "Authorization: Bearer $TOKEN" \
  -F seq=1 -F offset_ms=30000 -F duration_ms=30000 -F "file=@part2.m4a;type=audio/mp4"
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:9011/transcription-jobs/$JOB/chunks -H "Authorization: Bearer $TOKEN" \
  -F seq=5 -F offset_ms=0 -F duration_ms=1000 -F "file=@part1.m4a;type=audio/mp4"
# 4. stop → awaiting_review ; a further chunk → 409 not_recording
curl -s http://127.0.0.1:9011/graphql -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { liveRecordingStop(id: \\\"$JOB\\\", input: { duration_seconds: 60 }) { id status duration_seconds } }\"}"
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:9011/transcription-jobs/$JOB/chunks -H "Authorization: Bearer $TOKEN" \
  -F seq=2 -F offset_ms=60000 -F duration_ms=1000 -F "file=@part1.m4a;type=audio/mp4"
kill %1
```
Expected: chunk 0/1 return `{ seq, text, chunk_count }` with real transcripts; the duplicate returns `duplicate: true` with the same text; `409`; stop returns `awaiting_review` with `duration_seconds: 60`; the last call is `409`. Then open `/transcriptions` in the running frontend (:3000 against this backend is not required — the row is visible under Needs review once the frontend part ships; for now check the row in Postgres: `select status, chunk_count, jsonb_array_length(raw_segments) from transcription_jobs where id='<JOB>';`). Finally check LiteLLM spend tags: `/spend/logs` for the last two requests carry `user_id_<id>`.

- [ ] **Step 5: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend-live-recording && git rev-parse --show-toplevel && git branch --show-current && \
git add src/exulu/routes.ts && \
git commit -m "feat(routes): mount POST /transcription-jobs/:id/chunks next to /transcribe

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Part B — Frontend (`../frontend-live-recording`, branch `feat/live-recording` off `main`)

The backend of Part A must be running (or its GraphQL schema deployed) for the manual checks in Tasks 15–16; Tasks 8–14 only need `tsc`, `eslint` and `vitest`.

### Task 8: Worktree, verify-first spike (two recorders on iOS Safari), config plumbing for the `whisper` flag

**Files:**
- Modify: `lib/api/config.ts:3-18` (`BackendConfigType`)
- Modify: `components/shell/nav-config.ts:55-66` (`NavConfig`), `:380-392` (`flagEnabled`)
- Modify: `lib/route-guard.tsx:56-93` (`serverNavConfig`)
- Modify: `lib/demo/config.ts:29-56` (`DEMO_BACKEND_CONFIG`)
- Test: `components/shell/nav-config.test.ts` (append)

**Interfaces:**
- Produces: `config.whisper?.enabled` available in `ConfigContext` (via the `...json` spread in `app/(application)/layout.tsx`) and in `NavConfig`.

- [ ] **Step 1: Create the frontend worktree with hard-linked node_modules**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend
git worktree add ../frontend-live-recording -b feat/live-recording main
cp -al /Users/daniel.claessen/Desktop/Projects/exulu/frontend/node_modules ../frontend-live-recording/node_modules
cd ../frontend-live-recording && git branch --show-current && npx vitest run components/shell/nav-config.test.ts 2>&1 | tail -3
```
Expected: branch `feat/live-recording`; existing nav-config tests PASS.

- [ ] **Step 2: Verify-first spike — two `MediaRecorder`s on one stream (Daniel, iOS Safari + Chrome Android)**

Save as `<scratchpad>/two-recorders.html`, serve it over HTTPS (e.g. `python3 -m http.server 8787` in the scratchpad + the existing ngrok tunnel: `ngrok http 8787`), open the ngrok URL on the phone, tap Start, talk for ~2 minutes, tap Stop:

```html
<!doctype html><meta name="viewport" content="width=device-width"><title>two recorders spike</title>
<button id="start" style="font-size:2rem">Start</button> <button id="stop" style="font-size:2rem">Stop</button>
<pre id="log"></pre>
<script>
const log = (m) => (document.getElementById("log").textContent += m + "\n");
let stream, master, seg, segCount = 0, masterBlobs = [], segBlobs = [];
const mime = ["audio/webm;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
function startSegment() {
  const r = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
  r.ondataavailable = (e) => { if (e.data.size) segBlobs.push(e.data); };
  r.onstop = () => log(`segment ${segCount++} stopped, ${segBlobs.at(-1)?.size ?? 0} bytes`);
  r.start();
  return r;
}
document.getElementById("start").onclick = async () => {
  stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  log("mime: " + (mime || "(default)"));
  master = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
  master.ondataavailable = (e) => { if (e.data.size) masterBlobs.push(e.data); };
  master.start(10000);
  seg = startSegment();
  window.cycle = setInterval(() => { const next = startSegment(); seg.stop(); seg = next; }, 10000);
  try { window.lock = await navigator.wakeLock.request("screen"); log("wake lock ok"); } catch (e) { log("wake lock: " + e.message); }
};
document.getElementById("stop").onclick = async () => {
  clearInterval(window.cycle); seg.stop(); master.stop();
  await new Promise((r) => setTimeout(r, 500));
  const full = new Blob(masterBlobs, { type: mime });
  log(`master: ${full.size} bytes in ${masterBlobs.length} slices; segments: ${segBlobs.length}`);
  const a = document.createElement("audio"); a.controls = true; a.src = URL.createObjectURL(full); document.body.appendChild(a);
  const s = document.createElement("audio"); s.controls = true; s.src = URL.createObjectURL(segBlobs[1]); document.body.appendChild(s);
  stream.getTracks().forEach((t) => t.stop());
};
</script>
```

Pass criteria: "wake lock ok"; ≥ 10 segment stops with non-zero sizes; both `<audio>` players play (the master plays the whole take, the second segment plays on its own). If a browser refuses the second recorder (an exception at `new MediaRecorder` or a 0-byte master), the fallback is already in Task 11: set `USE_STREAM_CLONE = true` there so the master records `stream.clone()`. Record the outcome as a note under this step.

- [ ] **Step 3: Write the failing nav-config test** — append to `components/shell/nav-config.test.ts`:

```ts
describe("flagEnabled('transcriptions') — three independent backends", () => {
  it("is on when only the whisper upload server is configured", () => {
    expect(flagEnabled({ whisper: { enabled: true } }, "transcriptions")).toBe(true);
  });
  it("is on for the composer-mic flag or recall alone (unchanged)", () => {
    expect(flagEnabled({ transcription: { enabled: true } }, "transcriptions")).toBe(true);
    expect(flagEnabled({ recall: { enabled: true } }, "transcriptions")).toBe(true);
  });
  it("is off when all three are off", () => {
    expect(
      flagEnabled(
        { transcription: { enabled: false }, recall: { enabled: false }, whisper: { enabled: false } },
        "transcriptions",
      ),
    ).toBe(false);
  });
});
```

and add `flagEnabled` to the existing `import { … } from "@/components/shell/nav-config"` list.

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run components/shell/nav-config.test.ts`
Expected: FAIL — the whisper-only case returns `false` (and a TS complaint that `whisper` is not in `NavConfig`).

- [ ] **Step 5: Implement the flag**

`lib/api/config.ts` — add to `BackendConfigType` after `recall`:

```ts
    /** Whisper upload transcription server (TRANSCRIPTION_SERVER) — gates the "Upload a file" mode. */
    whisper?: {
        enabled: boolean;
    }
```

`components/shell/nav-config.ts` — `NavConfig` gains `whisper?: { enabled?: boolean };` and `flagEnabled`'s `transcriptions` case becomes:

```ts
    case "transcriptions":
      // Shown when ANY of the three flows on /transcriptions is configured:
      // "Record on this device" (composer-mic STT flag), Recall meeting bots,
      // or the Whisper upload server.
      return (
        config.transcription?.enabled === true ||
        config.recall?.enabled === true ||
        config.whisper?.enabled === true
      );
```

`lib/route-guard.tsx` — in `serverNavConfig()` track `let whisperEnabled = false;` next to `recallEnabled`; in the demo branch `whisperEnabled = demoConfig().whisper?.enabled === true;`; in the backend branch `whisperEnabled = json.whisper?.enabled === true;`; and return `whisper: { enabled: whisperEnabled },` after `recall`.

`lib/demo/config.ts` — in `DEMO_BACKEND_CONFIG` after `recall: { enabled: true },`:

```ts
  // FALSE: the demo has no Whisper server; the Transcripts page keeps its
  // meeting-bot mode (recall) and hides the upload mode.
  whisper: { enabled: false },
```

- [ ] **Step 6: Run the test, type-check and lint**

Run: `npx vitest run components/shell/nav-config.test.ts && npx tsc --noEmit && npx eslint components/shell/nav-config.ts lib/route-guard.tsx lib/api/config.ts lib/demo/config.ts`
Expected: PASS; clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend-live-recording && git rev-parse --show-toplevel && git branch --show-current && \
git add lib/api/config.ts components/shell/nav-config.ts components/shell/nav-config.test.ts lib/route-guard.tsx lib/demo/config.ts && \
git commit -m "feat(config): whisper.enabled flag from /config gates the transcripts nav + upload mode

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 9: Feature types, GraphQL documents, polling

**Files:**
- Modify: `app/(application)/transcriptions/types.ts:8-15` (`JobStatus`), `:19` (`JobSource`), `:35-64` (`Job`), `:79-84` (`ACTIVE_STATUSES`), `:143-155` (`displayTitle`, `isMeetingJob`)
- Modify: `app/(application)/transcriptions/queries.ts:11-39` (`TRANSCRIPTION_JOB_FIELDS`), append after `RUN_TRANSCRIPT_POST_PROCESSING`
- Modify: `app/(application)/transcriptions/hooks.ts:74-76` (`hasRunning`)
- Test: `app/(application)/transcriptions/types.test.ts` (append)

**Interfaces:**
- Produces: `JobStatus` incl. `"recording"`, `JobSource` incl. `"live"`, `Job.chunk_count`, `Job.last_chunk_at`, `isLiveJob(job)`, `hasPostProcessing(job)`, `LIVE_RECORDING_START`, `LIVE_RECORDING_STOP`.

- [ ] **Step 1: Write the failing tests** — append to `types.test.ts` (reuse the file's `job()` fixture helper):

```ts
import { hasPostProcessing, isLiveJob, displayTitle } from "./types";

describe("live recording helpers", () => {
  it("isLiveJob is true only for source 'live'", () => {
    expect(isLiveJob(job({ source: "live" }))).toBe(true);
    expect(isLiveJob(job({ source: "recall" }))).toBe(false);
    expect(isLiveJob(job({ source: null }))).toBe(false);
  });

  it("hasPostProcessing is true when prompts or outputs exist (array or JSON string)", () => {
    expect(hasPostProcessing(job({}))).toBe(false);
    expect(hasPostProcessing(job({ post_processing_prompts: [] }))).toBe(false);
    expect(hasPostProcessing(job({ post_processing_prompts: [{ prompt_id: "p", agent_id: "a" }] }))).toBe(true);
    expect(hasPostProcessing(job({ post_processing_prompts: JSON.stringify([{ prompt_id: "p", agent_id: "a" }]) }))).toBe(true);
    expect(
      hasPostProcessing(
        job({ post_processing_outputs: [{ prompt_id: "p", agent_id: "a", prompt_name: null, status: "done", output: "x", error: null, ran_at: "t" }] }),
      ),
    ).toBe(true);
  });

  it("displayTitle falls back to 'Live recording' for untitled live jobs", () => {
    expect(displayTitle({ title: null, audio_s3key: "", source: "live" })).toBe("Live recording");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run "app/(application)/transcriptions/types.test.ts"`
Expected: FAIL — `isLiveJob`/`hasPostProcessing` are not exported.

- [ ] **Step 3: Implement in `types.ts`**

```ts
export type JobStatus =
  | "queued"
  | "transcribing"
  | "recording" // live browser recording in progress
  | "awaiting_review"
  | "saved"
  | "failed"
  | "cancelled";

/** Where a job came from: on-server Whisper upload, a Recall meeting bot, or a live browser recording. */
export type JobSource = "whisper" | "recall" | "live";
```

Add to `Job` after `video_s3key`:

```ts
  // Live recordings: next expected chunk seq + heartbeat of the last accepted chunk.
  chunk_count?: number | null;
  last_chunk_at?: string | null;
```

`ACTIVE_STATUSES` becomes `["queued", "transcribing", "recording", "awaiting_review", "failed"] as const`.

In `displayTitle`, before `if (job.meeting_url) return job.meeting_url;` add `if (job.source === "live") return "Live recording";`.

After `isMeetingJob` add:

```ts
/** True when the job is a live browser recording ("Record on this device"). */
export function isLiveJob(job: Pick<Job, "source">): boolean {
  return job.source === "live";
}

/** Post-processing cards are shown for any job that has prompts configured or outputs stored. */
export function hasPostProcessing(
  job: Pick<Job, "post_processing_prompts" | "post_processing_outputs">,
): boolean {
  return (
    parsePostProcessingPrompts(job.post_processing_prompts).length > 0 ||
    parsePostProcessingOutputs(job.post_processing_outputs).length > 0
  );
}
```

- [ ] **Step 4: GraphQL documents** — in `queries.ts` add `chunk_count` and `last_chunk_at` to `TRANSCRIPTION_JOB_FIELDS` (after `video_s3key`), and append after `RUN_TRANSCRIPT_POST_PROCESSING`:

```ts
/* ----------------------- Live (browser) recording operations ----------------------- */

/** Open a live recording row (source 'live', status 'recording'); chunks then go to POST /transcription-jobs/:id/chunks. */
export const LIVE_RECORDING_START = gql`
  mutation LiveRecordingStart($input: LiveRecordingStartInput!) {
    liveRecordingStart(input: $input) {
      ${TRANSCRIPTION_JOB_FIELDS}
    }
  }
`;

/** Close a live recording: 'recording' → 'awaiting_review' (+ optional audio key / total duration). */
export const LIVE_RECORDING_STOP = gql`
  mutation LiveRecordingStop($id: ID!, $input: LiveRecordingStopInput) {
    liveRecordingStop(id: $id, input: $input) {
      ${TRANSCRIPTION_JOB_FIELDS}
    }
  }
`;
```

- [ ] **Step 5: Polling** — in `hooks.ts` change `hasRunning` to include live rows and update the doc comment above `useTranscriptionJobs`:

```ts
  // Poll while anything is in motion: whisper/recall work (queued, transcribing)
  // or a live recording on another device/tab (recording).
  const hasRunning = activeJobs.some(
    (job) =>
      job.status === "queued" ||
      job.status === "transcribing" ||
      job.status === "recording",
  );
```

Also update the `TranscriptionJobs.activeJobs` doc comment to `/** queued | transcribing | recording | awaiting_review | failed */`.

- [ ] **Step 6: Run tests, type-check, lint**

Run: `npx vitest run "app/(application)/transcriptions" && npx tsc --noEmit && npx eslint "app/(application)/transcriptions"`
Expected: PASS; clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend-live-recording && git rev-parse --show-toplevel && git branch --show-current && \
git add "app/(application)/transcriptions/types.ts" "app/(application)/transcriptions/types.test.ts" "app/(application)/transcriptions/queries.ts" "app/(application)/transcriptions/hooks.ts" && \
git commit -m "feat(transcriptions): live job types, liveRecordingStart/Stop documents, poll while recording

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 10: Pure recorder modules — cut policy, failure classification, sequential chunk queue

**Files:**
- Create: `components/live-recording/cut-policy.ts`, `components/live-recording/cut-policy.test.ts`
- Create: `components/live-recording/classify-chunk-failure.ts`, `components/live-recording/classify-chunk-failure.test.ts`
- Create: `components/live-recording/chunk-queue.ts`, `components/live-recording/chunk-queue.test.ts`

These live under `components/live-recording/` (not the route folder) because the shell (Task 11) imports the provider from the same directory. All three are DOM-free so vitest's node environment can test them.

**Interfaces:**
- Produces:
  - `shouldCut({ chunkElapsedMs, silentForMs }): boolean`, constants `MIN_CHUNK_MS`, `MAX_CHUNK_MS`, `SILENCE_MIN_MS`, `SILENCE_DBFS`, `MAX_RECORDING_MS`, `rmsToDbfs(rms)`.
  - `classifyChunkFailure(status, body): ChunkFailure` (`{ kind: "retry" } | { kind: "skip" } | { kind: "abort"; reason: "not_recording" | "out_of_order" }`).
  - `backoffMs(attempt)`, `class ChunkQueue<TPayload>` with `enqueue`, `drain`, `abort`, `subscribe`, `snapshot`, and `SendResult`, `ChunkState`, `QueueAbortError`.

- [ ] **Step 1: Failing tests for the cut policy** — `components/live-recording/cut-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { MAX_CHUNK_MS, MIN_CHUNK_MS, rmsToDbfs, shouldCut, SILENCE_MIN_MS } from "./cut-policy";

describe("shouldCut", () => {
  it("never cuts before MIN_CHUNK_MS, even in silence", () => {
    expect(shouldCut({ chunkElapsedMs: MIN_CHUNK_MS - 1, silentForMs: 5_000 })).toBe(false);
  });
  it("cuts at the first sufficient silence after MIN_CHUNK_MS", () => {
    expect(shouldCut({ chunkElapsedMs: MIN_CHUNK_MS, silentForMs: SILENCE_MIN_MS })).toBe(true);
    expect(shouldCut({ chunkElapsedMs: MIN_CHUNK_MS, silentForMs: SILENCE_MIN_MS - 1 })).toBe(false);
  });
  it("cuts unconditionally at MAX_CHUNK_MS", () => {
    expect(shouldCut({ chunkElapsedMs: MAX_CHUNK_MS, silentForMs: 0 })).toBe(true);
  });
  it("honours overrides", () => {
    expect(shouldCut({ chunkElapsedMs: 5_000, silentForMs: 100, minChunkMs: 4_000, silenceMinMs: 100 })).toBe(true);
  });
});

describe("rmsToDbfs", () => {
  it("maps 1.0 to 0 dBFS, 0.00316 to about -50 dBFS, and 0 to -Infinity", () => {
    expect(rmsToDbfs(1)).toBeCloseTo(0);
    expect(rmsToDbfs(0.00316)).toBeCloseTo(-50, 0);
    expect(rmsToDbfs(0)).toBe(-Infinity);
  });
});
```

- [ ] **Step 2: Failing tests for failure classification** — `components/live-recording/classify-chunk-failure.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { classifyChunkFailure } from "./classify-chunk-failure";

describe("classifyChunkFailure", () => {
  it("retries network errors, 429 and every 5xx", () => {
    expect(classifyChunkFailure(null)).toEqual({ kind: "retry" });
    expect(classifyChunkFailure(429)).toEqual({ kind: "retry" });
    expect(classifyChunkFailure(502)).toEqual({ kind: "retry" });
    expect(classifyChunkFailure(503)).toEqual({ kind: "retry" });
  });
  it("retries 401/403 (token refresh) rather than skipping audio", () => {
    expect(classifyChunkFailure(401)).toEqual({ kind: "retry" });
  });
  it("skips deterministic rejections 400/413/415", () => {
    expect(classifyChunkFailure(400)).toEqual({ kind: "skip" });
    expect(classifyChunkFailure(413)).toEqual({ kind: "skip" });
    expect(classifyChunkFailure(415)).toEqual({ kind: "skip" });
  });
  it("aborts on 409 with the server's kind", () => {
    expect(classifyChunkFailure(409, { kind: "not_recording" })).toEqual({ kind: "abort", reason: "not_recording" });
    expect(classifyChunkFailure(409, { kind: "out_of_order" })).toEqual({ kind: "abort", reason: "out_of_order" });
  });
  it("treats an unknown 409 as retry (server may be mid-transition)", () => {
    expect(classifyChunkFailure(409, null)).toEqual({ kind: "retry" });
  });
});
```

- [ ] **Step 3: Failing tests for the queue** — `components/live-recording/chunk-queue.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { backoffMs, ChunkQueue, QueueAbortError, type SendResult } from "./chunk-queue";

type P = { seq: number; label: string };

/** Scripted transport: each seq gets a list of responses consumed in order. */
function transport(script: Record<number, SendResult[]>) {
  const sent: Array<{ seq: number; skipped: boolean }> = [];
  const send = vi.fn(async (chunk: P, opts: { skipped: boolean }): Promise<SendResult> => {
    sent.push({ seq: chunk.seq, skipped: opts.skipped });
    const next = script[chunk.seq]?.shift();
    return next ?? { ok: true, text: `t${chunk.seq}` };
  });
  return { send, sent };
}

const sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};

describe("backoffMs", () => {
  it("doubles from 1 s and caps at 30 s", () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});

describe("ChunkQueue", () => {
  it("sends strictly in order, one at a time, and records the text", async () => {
    const { send, sent } = transport({});
    const q = new ChunkQueue<P>({ send, sleep });
    q.enqueue({ seq: 0, label: "a" });
    q.enqueue({ seq: 1, label: "b" });
    q.enqueue({ seq: 2, label: "c" });
    await q.drain();
    expect(sent.map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(q.snapshot().map((c) => [c.seq, c.status, c.text])).toEqual([
      [0, "sent", "t0"],
      [1, "sent", "t1"],
      [2, "sent", "t2"],
    ]);
  });

  it("retries a transient failure with backoff and never advances past it", async () => {
    sleeps.length = 0;
    const { send, sent } = transport({
      0: [{ ok: false, status: 503 }, { ok: false, status: null }, { ok: true, text: "ok" }],
    });
    const q = new ChunkQueue<P>({ send, sleep });
    q.enqueue({ seq: 0, label: "a" });
    q.enqueue({ seq: 1, label: "b" });
    await q.drain();
    expect(sent.map((s) => s.seq)).toEqual([0, 0, 0, 1]);
    expect(sleeps).toEqual([1000, 2000]);
    expect(q.snapshot()[0]).toMatchObject({ status: "sent", text: "ok", attempts: 3 });
  });

  it("keeps retrying transients indefinitely (no give-up)", async () => {
    const failures: SendResult[] = Array.from({ length: 40 }, () => ({ ok: false, status: 500 }));
    const { send, sent } = transport({ 0: [...failures, { ok: true, text: "finally" }] });
    const q = new ChunkQueue<P>({ send, sleep });
    q.enqueue({ seq: 0, label: "a" });
    await q.drain();
    expect(sent.length).toBe(41);
    expect(q.snapshot()[0].text).toBe("finally");
  });

  it("sends a skip marker for the same seq on a deterministic rejection, then continues", async () => {
    const { send, sent } = transport({ 0: [{ ok: false, status: 413 }] });
    const q = new ChunkQueue<P>({ send, sleep });
    q.enqueue({ seq: 0, label: "a" });
    q.enqueue({ seq: 1, label: "b" });
    await q.drain();
    expect(sent).toEqual([
      { seq: 0, skipped: false },
      { seq: 0, skipped: true },
      { seq: 1, skipped: false },
    ]);
    expect(q.snapshot()[0]).toMatchObject({ status: "skipped", text: "" });
  });

  it("aborts on 409 not_recording: drain rejects, later chunks are never sent", async () => {
    const { send, sent } = transport({ 0: [{ ok: false, status: 409, body: { kind: "not_recording" } }] });
    const q = new ChunkQueue<P>({ send, sleep });
    q.enqueue({ seq: 0, label: "a" });
    q.enqueue({ seq: 1, label: "b" });
    await expect(q.drain()).rejects.toBeInstanceOf(QueueAbortError);
    expect(sent.map((s) => s.seq)).toEqual([0]);
    expect(q.snapshot().map((c) => c.status)).toEqual(["failed", "pending"]);
  });

  it("abort() stops a retry loop and rejects drain", async () => {
    const { send } = transport({ 0: [{ ok: false, status: 500 }, { ok: false, status: 500 }, { ok: false, status: 500 }] });
    const q = new ChunkQueue<P>({
      send,
      sleep: async () => {
        q.abort("user");
      },
    });
    q.enqueue({ seq: 0, label: "a" });
    await expect(q.drain()).rejects.toMatchObject({ reason: "user" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers on every state change and drain resolves when idle", async () => {
    const { send } = transport({});
    const q = new ChunkQueue<P>({ send, sleep });
    const states: string[] = [];
    q.subscribe(() => states.push(q.snapshot().map((c) => c.status).join(",")));
    await q.drain(); // nothing queued → resolves immediately
    q.enqueue({ seq: 0, label: "a" });
    await q.drain();
    expect(states).toEqual(["pending", "sending", "sent"]);
    expect(q.pendingCount()).toBe(0);
  });
});
```

- [ ] **Step 4: Run the three test files to verify they fail**

Run: `npx vitest run components/live-recording`
Expected: FAIL — modules not found.

- [ ] **Step 5: Create `components/live-recording/cut-policy.ts`**

```ts
/**
 * When to end the current audio segment and start the next one. Pure so the
 * recorder hook can be reasoned about without a microphone.
 *
 * Spec: docs/superpowers/specs/2026-09-23-live-recording-transcription-design.md §4.4
 */
export const MIN_CHUNK_MS = 20_000;
export const MAX_CHUNK_MS = 60_000;
/** A quiet window at least this long is a cut point (after MIN_CHUNK_MS). */
export const SILENCE_MIN_MS = 500;
/** RMS below this is "silence". Adaptive noise floors are a follow-up. */
export const SILENCE_DBFS = -50;
/** Auto-stop guard: a forgotten phone must not record all night. */
export const MAX_RECORDING_MS = 4 * 60 * 60 * 1000;

export function rmsToDbfs(rms: number): number {
  return rms <= 0 ? -Infinity : 20 * Math.log10(rms);
}

export function shouldCut(input: {
  chunkElapsedMs: number;
  silentForMs: number;
  minChunkMs?: number;
  maxChunkMs?: number;
  silenceMinMs?: number;
}): boolean {
  const min = input.minChunkMs ?? MIN_CHUNK_MS;
  const max = input.maxChunkMs ?? MAX_CHUNK_MS;
  const silence = input.silenceMinMs ?? SILENCE_MIN_MS;
  if (input.chunkElapsedMs >= max) return true;
  if (input.chunkElapsedMs < min) return false;
  return input.silentForMs >= silence;
}
```

- [ ] **Step 6: Create `components/live-recording/classify-chunk-failure.ts`**

```ts
/**
 * Maps a failed chunk POST onto the queue's policy (spec §4.4):
 * - transient (network, 429, 5xx, auth refresh) → retry forever with backoff
 * - deterministic (400/413/415) → send a skip marker for the same seq
 * - 409 not_recording / out_of_order → abort the recording
 */
export type ChunkFailure =
  | { kind: "retry" }
  | { kind: "skip" }
  | { kind: "abort"; reason: "not_recording" | "out_of_order" };

export function classifyChunkFailure(
  status: number | null,
  body?: { kind?: string } | null,
): ChunkFailure {
  if (status == null) return { kind: "retry" };
  if (status === 409) {
    if (body?.kind === "not_recording") return { kind: "abort", reason: "not_recording" };
    if (body?.kind === "out_of_order") return { kind: "abort", reason: "out_of_order" };
    return { kind: "retry" };
  }
  if (status === 400 || status === 413 || status === 415) return { kind: "skip" };
  return { kind: "retry" };
}
```

- [ ] **Step 7: Create `components/live-recording/chunk-queue.ts`**

```ts
/**
 * Strictly sequential upload queue for live-recording chunks. One in-flight
 * send; the queue never advances past a chunk the server has not acknowledged
 * (the backend appends with a compare-and-swap on the chunk seq, so a hole
 * would strand every later chunk as out_of_order).
 *
 * Transport-agnostic: `send` is injected (fetch in the hook, a script in tests).
 */
import { classifyChunkFailure } from "./classify-chunk-failure";

export type SendResult =
  | { ok: true; text: string }
  | { ok: false; status: number | null; body?: { kind?: string } | null };

export type ChunkStatus = "pending" | "sending" | "retrying" | "sent" | "skipped" | "failed";

export type ChunkState = {
  seq: number;
  status: ChunkStatus;
  text: string | null;
  attempts: number;
};

export class QueueAbortError extends Error {
  constructor(public readonly reason: string) {
    super(`chunk queue aborted: ${reason}`);
    this.name = "QueueAbortError";
  }
}

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CAP_MS = 30_000;

export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
}

type Deps<TPayload> = {
  send: (chunk: TPayload, opts: { skipped: boolean }) => Promise<SendResult>;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ChunkQueue<TPayload extends { seq: number }> {
  private items: Array<{ payload: TPayload; state: ChunkState }> = [];
  private cursor = 0;
  private running = false;
  private aborted: QueueAbortError | null = null;
  private listeners = new Set<() => void>();
  private idleWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private readonly send: Deps<TPayload>["send"];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: Deps<TPayload>) {
    this.send = deps.send;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  enqueue(payload: TPayload): void {
    if (this.aborted) return;
    this.items.push({ payload, state: { seq: payload.seq, status: "pending", text: null, attempts: 0 } });
    this.notify();
    void this.pump();
  }

  /** Resolves once every enqueued chunk is sent or skipped; rejects if aborted. */
  drain(): Promise<void> {
    if (this.aborted) return Promise.reject(this.aborted);
    if (!this.running && this.cursor >= this.items.length) return Promise.resolve();
    return new Promise((resolve, reject) => this.idleWaiters.push({ resolve, reject }));
  }

  abort(reason: string): void {
    if (this.aborted) return;
    this.aborted = new QueueAbortError(reason);
    this.notify();
    this.settleWaiters();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): ChunkState[] {
    return this.items.map((item) => ({ ...item.state }));
  }

  pendingCount(): number {
    return this.items.filter((item) => item.state.status !== "sent" && item.state.status !== "skipped").length;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private settleWaiters(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const waiter of waiters) {
      if (this.aborted) waiter.reject(this.aborted);
      else waiter.resolve();
    }
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.aborted && this.cursor < this.items.length) {
        const item = this.items[this.cursor];
        await this.sendUntilSettled(item);
        if (this.aborted) break;
        this.cursor += 1;
      }
    } finally {
      this.running = false;
      this.settleWaiters();
    }
  }

  private async sendUntilSettled(item: { payload: TPayload; state: ChunkState }): Promise<void> {
    let attempt = 0;
    while (!this.aborted) {
      item.state.status = attempt === 0 ? "sending" : "retrying";
      item.state.attempts += 1;
      this.notify();
      const result = await this.send(item.payload, { skipped: false });
      if (this.aborted) return;
      if (result.ok) {
        item.state.status = "sent";
        item.state.text = result.text;
        this.notify();
        return;
      }
      const failure = classifyChunkFailure(result.status, result.body);
      if (failure.kind === "abort") {
        item.state.status = "failed";
        this.abort(failure.reason);
        return;
      }
      if (failure.kind === "skip") {
        // Same seq, no audio: the server stores an empty placeholder so the
        // sequence stays contiguous. Transient failures of the skip itself retry.
        const skip = await this.send(item.payload, { skipped: true });
        if (this.aborted) return;
        if (skip.ok) {
          item.state.status = "skipped";
          item.state.text = "";
          this.notify();
          return;
        }
        const skipFailure = classifyChunkFailure(skip.status, skip.body);
        if (skipFailure.kind === "abort") {
          item.state.status = "failed";
          this.abort(skipFailure.reason);
          return;
        }
      }
      await this.sleep(backoffMs(attempt));
      attempt += 1;
    }
  }
}
```

- [ ] **Step 8: Run the tests, type-check, lint**

Run: `npx vitest run components/live-recording && npx tsc --noEmit && npx eslint components/live-recording`
Expected: PASS (all three files); clean.

- [ ] **Step 9: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend-live-recording && git rev-parse --show-toplevel && git branch --show-current && \
git add components/live-recording && \
git commit -m "feat(live-recording): pure cut policy, failure classification and sequential chunk queue

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 11: Recorder hook, fetch transport, provider, shell pill

**Files:**
- Create: `components/live-recording/mime.ts`, `components/live-recording/mime.test.ts`
- Create: `components/live-recording/format.ts`, `components/live-recording/format.test.ts`
- Create: `components/live-recording/chunk-transport.ts`
- Create: `components/live-recording/use-live-recorder.ts`
- Create: `components/live-recording/live-recording-provider.tsx`
- Create: `components/live-recording/live-recording-pill.tsx`
- Modify: `app/(application)/authenticated.tsx:108-135` (mount the provider), `components/shell/top-bar.tsx:94` (pill after `<Brand />`), `components/shell/mobile-topbar.tsx:203-206` (pill before the action slot)
- Modify: `messages/en.json` / `messages/de.json` (`transcriptions.pill.*`)

**Interfaces:**
- Consumes: Task 10 (`ChunkQueue`, `SendResult`, `QueueAbortError`, cut-policy constants), `getToken` (`lib/api/client.ts:40`), `ConfigContext`, `UserContext` (`app/(application)/authenticated.tsx:61`).
- Produces (used by Tasks 13–14):
  - `useLiveRecording(): LiveRecorder` and `useLiveRecordingOptional(): LiveRecorder | null`
  - `LiveRecorder = { state, jobId, startedAt, elapsedMs, level, chunks, abortReason, autoStopped, prepare(), start(jobId), stop(), discard() }`
  - `pickMimeType(isTypeSupported)`, `extensionFor(mimeType)`, `formatElapsed(ms)`

- [ ] **Step 1: Failing tests for the two pure helpers**

`components/live-recording/mime.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { extensionFor, pickMimeType } from "./mime";

describe("pickMimeType", () => {
  it("prefers webm/opus, then mp4, else the browser default (empty string)", () => {
    expect(pickMimeType((t) => t.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
    expect(pickMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickMimeType(() => false)).toBe("");
  });
});

describe("extensionFor", () => {
  it("maps container types to file extensions", () => {
    expect(extensionFor("audio/webm;codecs=opus")).toBe("webm");
    expect(extensionFor("audio/mp4")).toBe("m4a");
    expect(extensionFor("audio/ogg")).toBe("ogg");
    expect(extensionFor("")).toBe("webm");
  });
});
```

`components/live-recording/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { formatElapsed } from "./format";

describe("formatElapsed", () => {
  it("renders mm:ss under an hour and h:mm:ss above", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(65_000)).toBe("01:05");
    expect(formatElapsed(3_599_999)).toBe("59:59");
    expect(formatElapsed(3_600_000)).toBe("1:00:00");
    expect(formatElapsed(4 * 3_600_000 + 61_000)).toBe("4:01:01");
  });
});
```

Run: `npx vitest run components/live-recording/mime.test.ts components/live-recording/format.test.ts` — Expected: FAIL (modules missing).

- [ ] **Step 2: Create the helpers**

`components/live-recording/mime.ts`:

```ts
/** MediaRecorder container choice + matching file extension (pure; tested). */
export const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/mp4"] as const;

export function pickMimeType(isTypeSupported: (type: string) => boolean): string {
  return MIME_CANDIDATES.find((type) => isTypeSupported(type)) ?? "";
}

export function extensionFor(mimeType: string): string {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}
```

`components/live-recording/format.ts`:

```ts
/** "mm:ss" below one hour, "h:mm:ss" above — the recording timer and the shell pill. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
```

Run the two tests again — Expected: PASS.

- [ ] **Step 3: Create `components/live-recording/chunk-transport.ts`**

```ts
/**
 * The real transport behind the chunk queue: multipart POST to
 * POST {backend}/transcription-jobs/:id/chunks with the same auth headers the
 * chat composer uses for /transcribe. Never throws on HTTP errors — the queue
 * decides what to do from the status code.
 */
import { getToken } from "@/lib/api/client";

import type { SendResult } from "./chunk-queue";
import { extensionFor } from "./mime";

export type ChunkPayload = {
  seq: number;
  blob: Blob;
  offsetMs: number;
  durationMs: number;
  mimeType: string;
};

export type LiveRecorderTransport = {
  sendChunk: (jobId: string, chunk: ChunkPayload, opts: { skipped: boolean }) => Promise<SendResult>;
};

export function createFetchTransport(backend: string, userId: string | number): LiveRecorderTransport {
  return {
    async sendChunk(jobId, chunk, { skipped }) {
      const form = new FormData();
      form.append("seq", String(chunk.seq));
      form.append("offset_ms", String(Math.max(0, Math.round(chunk.offsetMs))));
      form.append("duration_ms", String(Math.max(1, Math.round(chunk.durationMs))));
      if (skipped) {
        form.append("skipped", "true");
      } else {
        // Re-wrap so the type is always audio/* (Chrome can report video/webm on raw blobs).
        const type = chunk.mimeType || "audio/webm";
        form.append("file", new Blob([chunk.blob], { type }), `chunk-${chunk.seq}.${extensionFor(type)}`);
      }
      let res: Response;
      try {
        const token = await getToken();
        if (!token) return { ok: false, status: 401 };
        res = await fetch(`${backend}/transcription-jobs/${jobId}/chunks`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, User: String(userId) },
          body: form,
        });
      } catch {
        return { ok: false, status: null };
      }
      if (res.ok) {
        const json = (await res.json().catch(() => ({}))) as { text?: unknown };
        return { ok: true, text: typeof json.text === "string" ? json.text : "" };
      }
      const body = (await res.json().catch(() => null)) as { kind?: string } | null;
      return { ok: false, status: res.status, body };
    },
  };
}
```

- [ ] **Step 4: Create `components/live-recording/use-live-recorder.ts`**

```ts
"use client";

/**
 * The microphone side of "Record on this device" (spec §4.4). Owns the
 * MediaStream, an AnalyserNode (level meter + silence detector), TWO
 * MediaRecorders — a segment recorder restarted at silence-aligned cut points
 * (each blob → chunk queue → backend) and a continuous master recorder whose
 * slices are joined into the full audio file at stop — plus the wake lock and
 * interruption handling. Instantiated once by LiveRecordingProvider so a
 * recording survives in-app navigation.
 *
 * Nothing here is unit-tested (DOM media APIs); the decisions are in the pure
 * modules cut-policy.ts / chunk-queue.ts, which are.
 */
import * as React from "react";

import { ChunkQueue, QueueAbortError, type ChunkState } from "./chunk-queue";
import type { ChunkPayload, LiveRecorderTransport } from "./chunk-transport";
import { MAX_RECORDING_MS, rmsToDbfs, shouldCut, SILENCE_DBFS } from "./cut-policy";
import { pickMimeType } from "./mime";

/** Task 8 spike fallback: record the master from stream.clone() if a browser refuses two recorders on one stream. */
export const USE_STREAM_CLONE = false;
const AUDIO_BITS_PER_SECOND = 64_000;
const MASTER_TIMESLICE_MS = 60_000;
const TICK_MS = 100;

export type LiveRecorderState = "idle" | "ready" | "recording" | "stopping" | "interrupted";

export type LiveRecorderStopResult = { blob: Blob | null; mimeType: string; durationMs: number };

export type LiveRecorder = {
  state: LiveRecorderState;
  jobId: string | null;
  startedAt: number | null;
  elapsedMs: number;
  /** 0..1 microphone level for the meter. */
  level: number;
  chunks: ChunkState[];
  /** Set when the queue aborted (409 from the server) — the composer ends the recording. */
  abortReason: string | null;
  autoStopped: boolean;
  /** Ask for the microphone. Throws the DOMException from getUserMedia on denial. */
  prepare(): Promise<void>;
  /** Begin recording into the given job. Requires prepare() first. */
  start(jobId: string): void;
  /** Stop, drain the queue, return the full audio. Rejects with QueueAbortError if the queue aborted. */
  stop(): Promise<LiveRecorderStopResult>;
  /** Stop everything, upload nothing, forget the blobs. */
  discard(): void;
};

type Segment = { recorder: MediaRecorder; seq: number; startedAt: number; parts: Blob[] };

export function useLiveRecorder(transport: LiveRecorderTransport): LiveRecorder {
  const [state, setState] = React.useState<LiveRecorderState>("idle");
  const [jobId, setJobId] = React.useState<string | null>(null);
  const [startedAt, setStartedAt] = React.useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = React.useState(0);
  const [level, setLevel] = React.useState(0);
  const [chunks, setChunks] = React.useState<ChunkState[]>([]);
  const [abortReason, setAbortReason] = React.useState<string | null>(null);
  const [autoStopped, setAutoStopped] = React.useState(false);

  const streamRef = React.useRef<MediaStream | null>(null);
  const audioCtxRef = React.useRef<AudioContext | null>(null);
  const analyserRef = React.useRef<AnalyserNode | null>(null);
  const masterRef = React.useRef<MediaRecorder | null>(null);
  const masterPartsRef = React.useRef<Blob[]>([]);
  const segmentRef = React.useRef<Segment | null>(null);
  const seqRef = React.useRef(0);
  const originRef = React.useRef(0);
  const silentForRef = React.useRef(0);
  const tickRef = React.useRef<number | null>(null);
  const queueRef = React.useRef<ChunkQueue<ChunkPayload> | null>(null);
  const mimeRef = React.useRef("");
  const wakeLockRef = React.useRef<WakeLockSentinel | null>(null);
  const stateRef = React.useRef<LiveRecorderState>("idle");
  const jobIdRef = React.useRef<string | null>(null);

  const setStateBoth = (next: LiveRecorderState) => {
    stateRef.current = next;
    setState(next);
  };

  const recorderOptions = (): MediaRecorderOptions | undefined =>
    mimeRef.current
      ? { mimeType: mimeRef.current, audioBitsPerSecond: AUDIO_BITS_PER_SECOND }
      : { audioBitsPerSecond: AUDIO_BITS_PER_SECOND };

  const requestWakeLock = React.useCallback(async () => {
    try {
      if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
      wakeLockRef.current = await navigator.wakeLock.request("screen");
    } catch {
      // Unsupported or refused (low battery): the UI notice covers it.
    }
  }, []);

  const releaseWakeLock = () => {
    void wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
  };

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const teardownAudioGraph = () => {
    if (tickRef.current != null) window.clearInterval(tickRef.current);
    tickRef.current = null;
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    analyserRef.current = null;
  };

  /** Start the next segment recorder. Seq is assigned at START so cut order == seq order. */
  const startSegment = React.useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const seq = seqRef.current++;
    const recorder = new MediaRecorder(stream, recorderOptions());
    const segment: Segment = { recorder, seq, startedAt: performance.now(), parts: [] };
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) segment.parts.push(event.data);
    };
    recorder.onstop = () => {
      const stoppedAt = performance.now();
      const blob = new Blob(segment.parts, { type: mimeRef.current || "audio/webm" });
      if (blob.size === 0) return; // nothing captured (e.g. immediate interruption)
      queueRef.current?.enqueue({
        seq: segment.seq,
        blob,
        offsetMs: segment.startedAt - originRef.current,
        durationMs: stoppedAt - segment.startedAt,
        mimeType: mimeRef.current || "audio/webm",
      });
    };
    recorder.onerror = () => handleInterruption();
    recorder.start();
    segmentRef.current = segment;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Start the next recorder BEFORE stopping the current one so boundaries overlap by a few ms. */
  const cutSegment = React.useCallback(() => {
    const previous = segmentRef.current;
    startSegment();
    previous?.recorder.stop();
    silentForRef.current = 0;
  }, [startSegment]);

  const startMaster = () => {
    const stream = streamRef.current;
    if (!stream) return;
    const source = USE_STREAM_CLONE ? stream.clone() : stream;
    const master = new MediaRecorder(source, recorderOptions());
    master.ondataavailable = (event) => {
      if (event.data.size > 0) masterPartsRef.current.push(event.data);
    };
    master.start(MASTER_TIMESLICE_MS);
    masterRef.current = master;
  };

  const buildAudioGraph = () => {
    const stream = streamRef.current;
    if (!stream) return;
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);
    audioCtxRef.current = ctx;
    analyserRef.current = analyser;
  };

  const tick = React.useCallback(() => {
    const analyser = analyserRef.current;
    const segment = segmentRef.current;
    if (!analyser || !segment || stateRef.current !== "recording") return;
    const buffer = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    const rms = Math.sqrt(sum / buffer.length);
    const dbfs = rmsToDbfs(rms);
    silentForRef.current = dbfs < SILENCE_DBFS ? silentForRef.current + TICK_MS : 0;
    setLevel(Math.min(1, rms * 6));

    const now = performance.now();
    const elapsed = now - originRef.current;
    setElapsedMs(elapsed);

    if (elapsed >= MAX_RECORDING_MS) {
      setAutoStopped(true);
      return; // the composer watches autoStopped and calls stop()
    }
    if (shouldCut({ chunkElapsedMs: now - segment.startedAt, silentForMs: silentForRef.current })) {
      cutSegment();
    }
  }, [cutSegment]);

  const handleInterruption = React.useCallback(async () => {
    if (stateRef.current !== "recording") return;
    // One re-acquire attempt (iOS call/Siri interruption, device switch). The
    // master keeps its earlier slices, so the final file has a gap but stays valid.
    try {
      segmentRef.current?.recorder.stop();
      masterRef.current?.stop();
      teardownAudioGraph();
      stopTracks();
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current.getAudioTracks()[0]?.addEventListener("ended", () => void handleInterruption());
      buildAudioGraph();
      startMaster();
      startSegment();
      tickRef.current = window.setInterval(tick, TICK_MS);
      void requestWakeLock();
    } catch {
      setStateBoth("interrupted"); // the composer ends the recording with what was captured
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startSegment, tick, requestWakeLock]);

  const prepare = React.useCallback(async () => {
    if (streamRef.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getAudioTracks()[0]?.addEventListener("ended", () => void handleInterruption());
    streamRef.current = stream;
    setStateBoth("ready");
  }, [handleInterruption]);

  const start = React.useCallback(
    (nextJobId: string) => {
      if (!streamRef.current) throw new Error("prepare() must resolve before start()");
      if (stateRef.current === "recording") throw new Error("already recording");
      mimeRef.current = pickMimeType((type) => MediaRecorder.isTypeSupported(type));
      seqRef.current = 0;
      masterPartsRef.current = [];
      silentForRef.current = 0;
      originRef.current = performance.now();
      setAbortReason(null);
      setAutoStopped(false);
      setChunks([]);
      jobIdRef.current = nextJobId;
      setJobId(nextJobId);
      setStartedAt(Date.now());

      const queue = new ChunkQueue<ChunkPayload>({
        send: (chunk, opts) => transport.sendChunk(nextJobId, chunk, opts),
      });
      queue.subscribe(() => setChunks(queue.snapshot()));
      queueRef.current = queue;

      buildAudioGraph();
      startMaster();
      startSegment();
      tickRef.current = window.setInterval(tick, TICK_MS);
      setStateBoth("recording");
      void requestWakeLock();
      // Surface queue aborts (409 from the server) to the composer.
      queue.drain().catch((err: unknown) => {
        if (err instanceof QueueAbortError) setAbortReason(err.reason);
      });
    },
    [transport, startSegment, tick, requestWakeLock],
  );

  const stopRecorder = (recorder: MediaRecorder | null | undefined) =>
    new Promise<void>((resolve) => {
      if (!recorder || recorder.state === "inactive") return resolve();
      const previous = recorder.onstop;
      recorder.onstop = (event) => {
        if (typeof previous === "function") previous.call(recorder, event);
        resolve();
      };
      recorder.stop();
    });

  const stop = React.useCallback(async (): Promise<LiveRecorderStopResult> => {
    if (stateRef.current !== "recording" && stateRef.current !== "interrupted") {
      return { blob: null, mimeType: mimeRef.current, durationMs: 0 };
    }
    setStateBoth("stopping");
    if (tickRef.current != null) window.clearInterval(tickRef.current);
    tickRef.current = null;
    await stopRecorder(segmentRef.current?.recorder); // enqueues the final chunk
    await stopRecorder(masterRef.current);
    const durationMs = performance.now() - originRef.current;
    releaseWakeLock();
    teardownAudioGraph();
    stopTracks();
    try {
      await queueRef.current?.drain();
    } finally {
      // Whether or not the queue aborted, the microphone is done.
    }
    const mimeType = mimeRef.current || "audio/webm";
    const blob = masterPartsRef.current.length > 0 ? new Blob(masterPartsRef.current, { type: mimeType }) : null;
    masterPartsRef.current = [];
    segmentRef.current = null;
    masterRef.current = null;
    queueRef.current = null;
    jobIdRef.current = null;
    setJobId(null);
    setStateBoth("idle");
    return { blob, mimeType, durationMs };
  }, []);

  const discard = React.useCallback(() => {
    queueRef.current?.abort("discard");
    if (tickRef.current != null) window.clearInterval(tickRef.current);
    tickRef.current = null;
    try {
      segmentRef.current?.recorder.stop();
      masterRef.current?.stop();
    } catch {
      // already inactive
    }
    releaseWakeLock();
    teardownAudioGraph();
    stopTracks();
    masterPartsRef.current = [];
    segmentRef.current = null;
    masterRef.current = null;
    queueRef.current = null;
    jobIdRef.current = null;
    setJobId(null);
    setChunks([]);
    setElapsedMs(0);
    setLevel(0);
    setStateBoth("idle");
  }, []);

  // Re-acquire the wake lock when the tab becomes visible again (browsers drop it on hide).
  React.useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible" && stateRef.current === "recording") void requestWakeLock();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [requestWakeLock]);

  // Tab close / reload guard while recording.
  React.useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (stateRef.current !== "recording") return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  return {
    state,
    jobId,
    startedAt,
    elapsedMs,
    level,
    chunks,
    abortReason,
    autoStopped,
    prepare,
    start,
    stop,
    discard,
  };
}
```

- [ ] **Step 5: Create the provider** — `components/live-recording/live-recording-provider.tsx`:

```tsx
"use client";

/**
 * Hosts ONE useLiveRecorder for the whole authenticated shell so leaving
 * /transcriptions never ends a recording (spec §4.3). userId/backend come in
 * as props to avoid importing UserContext from authenticated.tsx (which
 * imports this file).
 */
import * as React from "react";

import { createFetchTransport } from "./chunk-transport";
import { useLiveRecorder, type LiveRecorder } from "./use-live-recorder";

const LiveRecordingContext = React.createContext<LiveRecorder | null>(null);

export function LiveRecordingProvider({
  backend,
  userId,
  children,
}: {
  backend: string;
  userId: string | number;
  children: React.ReactNode;
}) {
  const transport = React.useMemo(() => createFetchTransport(backend, userId), [backend, userId]);
  const recorder = useLiveRecorder(transport);
  return <LiveRecordingContext.Provider value={recorder}>{children}</LiveRecordingContext.Provider>;
}

/** Null outside the authenticated shell (public chat, demo) — callers render nothing. */
export function useLiveRecordingOptional(): LiveRecorder | null {
  return React.useContext(LiveRecordingContext);
}

export function useLiveRecording(): LiveRecorder {
  const recorder = React.useContext(LiveRecordingContext);
  if (!recorder) throw new Error("useLiveRecording must be used inside LiveRecordingProvider");
  return recorder;
}
```

- [ ] **Step 6: Create the pill** — `components/live-recording/live-recording-pill.tsx`:

```tsx
"use client";

/** "● Recording 12:34" in the shell chrome while a recording is active; links back to /transcriptions. */
import { useTranslations } from "next-intl";
import Link from "next/link";

import { StatusDot } from "@/components/primitives/status-dot";
import { cn } from "@/lib/utils";

import { formatElapsed } from "./format";
import { useLiveRecordingOptional } from "./live-recording-provider";

export function LiveRecordingPill({ className }: { className?: string }) {
  const recorder = useLiveRecordingOptional();
  const t = useTranslations("transcriptions");
  if (!recorder || (recorder.state !== "recording" && recorder.state !== "stopping" && recorder.state !== "interrupted")) {
    return null;
  }
  return (
    <Link
      href="/transcriptions"
      aria-label={t("pill.back")}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 font-mono text-xs font-medium text-destructive",
        className,
      )}
    >
      <StatusDot status="error" pulse />
      {t("pill.recording", { time: formatElapsed(recorder.elapsedMs) })}
    </Link>
  );
}
```

- [ ] **Step 7: Mount the provider and the pill**

`app/(application)/authenticated.tsx` — add `import { LiveRecordingProvider } from "@/components/live-recording/live-recording-provider";` and wrap the `SidebarProvider` (inside `MobileTopbarProvider`):

```tsx
        <MobileTopbarProvider>
          <LiveRecordingProvider backend={config?.backend ?? ""} userId={user.id}>
            <SidebarProvider …>
              … unchanged …
            </SidebarProvider>
          </LiveRecordingProvider>
        </MobileTopbarProvider>
```

(`config` is the `ConfigContext` value the component already reads for `CommandPalette`.)

`components/shell/top-bar.tsx` — import `LiveRecordingPill` and render `<LiveRecordingPill className="ml-2" />` directly after `<Brand className="shrink-0" />`.

`components/shell/mobile-topbar.tsx` — import `LiveRecordingPill` and render `<LiveRecordingPill />` directly before `{action ? ( … ) : null}`.

- [ ] **Step 8: i18n for the pill** — in both `messages/en.json` and `messages/de.json`, inside the `"transcriptions"` object add a sibling block after `"usage": { … }`:

en:
```json
    "pill": {
      "recording": "Recording {time}",
      "back": "Back to the recording"
    }
```
de:
```json
    "pill": {
      "recording": "Aufnahme {time}",
      "back": "Zur Aufnahme"
    }
```

- [ ] **Step 9: Type-check, lint, tests**

Run: `npx tsc --noEmit && npx eslint components/live-recording components/shell "app/(application)/authenticated.tsx" && npx vitest run components/live-recording`
Expected: clean; PASS. (`WakeLockSentinel` is in lib.dom for TS ≥ 4.4; if the project's `lib` lacks it, declare `type WakeLockSentinel = { release(): Promise<void> }` at the top of the hook.)

- [ ] **Step 10: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend-live-recording && git rev-parse --show-toplevel && git branch --show-current && \
git add components/live-recording components/shell/top-bar.tsx components/shell/mobile-topbar.tsx "app/(application)/authenticated.tsx" messages/en.json messages/de.json && \
git commit -m "feat(live-recording): recorder hook (two MediaRecorders, silence cuts, wake lock), provider and shell pill

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 12: Extract the post-processing picker for reuse

**Files:**
- Create: `app/(application)/transcriptions/components/post-processing-picker.tsx`
- Modify: `app/(application)/transcriptions/hooks.ts` (append `usePostProcessingOptions`)
- Modify: `app/(application)/transcriptions/components/meeting-composer.tsx:39-56` (imports/types), `:82-112` (state helpers), `:317-386` (JSX)

**Interfaces:**
- Produces: `<PostProcessingPicker rows onChange prompts agents />`, `usePostProcessingOptions(): { prompts: PromptOption[]; agents: AgentOption[] }`, exported types `PromptOption`, `AgentOption`. Used by Task 13.

This is a pure refactor: the meeting composer must render and behave exactly as before.

- [ ] **Step 1: Add the options hook** — append to `hooks.ts` (add `GET_PICKER_AGENTS`, `GET_PROMPT_LIBRARY` to the `./queries` import):

```ts
export type PromptOption = { id: string; name: string; description?: string | null };
export type AgentOption = { id: string; name: string };

/** Prompt-library + agent options for the post-processing picker (meeting and record composers). */
export function usePostProcessingOptions(): { prompts: PromptOption[]; agents: AgentOption[] } {
  const { data: promptsData } = useQuery<{ prompt_libraryPagination: { items: PromptOption[] } }>(
    GET_PROMPT_LIBRARY,
  );
  const { data: agentsData } = useQuery<{ agentsPagination: { items: AgentOption[] } }>(GET_PICKER_AGENTS);
  return {
    prompts: promptsData?.prompt_libraryPagination?.items ?? [],
    agents: agentsData?.agentsPagination?.items ?? [],
  };
}
```

- [ ] **Step 2: Create `components/post-processing-picker.tsx`** — the JSX lifted verbatim from `meeting-composer.tsx:317-386` with the three row helpers inside:

```tsx
"use client";

/**
 * Repeatable {prompt from the library, explicitly chosen agent} rows that
 * auto-run when a transcript is ready. Shared by the meeting-bot composer and
 * the record-on-this-device composer. Starts empty; the user opts in per job.
 */
import { Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import type { AgentOption, PromptOption } from "../hooks";
import type { PostProcessingPrompt } from "../types";

export interface PostProcessingPickerProps {
  rows: PostProcessingPrompt[];
  onChange: (rows: PostProcessingPrompt[]) => void;
  prompts: PromptOption[];
  agents: AgentOption[];
}

export function PostProcessingPicker({ rows, onChange, prompts, agents }: PostProcessingPickerProps) {
  const t = useTranslations("transcriptions");
  const addRow = () => onChange([...rows, { prompt_id: "", agent_id: "" }]);
  const removeRow = (index: number) => onChange(rows.filter((_, i) => i !== index));
  const updateRow = (index: number, patch: Partial<PostProcessingPrompt>) =>
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{t("composer.postProcessing")}</Label>
        <Button type="button" variant="ghost" size="sm" onClick={addRow} className="max-md:h-11">
          <Plus aria-hidden="true" className="mr-1 size-4" />
          {t("composer.addPrompt")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("composer.postProcessingHint")}</p>
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            <Select value={row.prompt_id} onValueChange={(value) => updateRow(index, { prompt_id: value })}>
              <SelectTrigger className="flex-1">
                <SelectValue placeholder={t("composer.selectPrompt")} />
              </SelectTrigger>
              <SelectContent>
                {prompts.map((prompt) => (
                  <SelectItem key={prompt.id} value={prompt.id}>
                    {prompt.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={row.agent_id} onValueChange={(value) => updateRow(index, { agent_id: value })}>
              <SelectTrigger className="flex-1">
                <SelectValue placeholder={t("composer.selectAgent")} />
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-9 shrink-0"
              aria-label={t("composer.removePrompt")}
              onClick={() => removeRow(index)}
            >
              <X aria-hidden="true" className="size-4" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** True when every row is fully specified — the Start buttons gate on this. */
export function postProcessingRowsComplete(rows: PostProcessingPrompt[]): boolean {
  return rows.every((r) => r.prompt_id && r.agent_id);
}
```

- [ ] **Step 3: Use it in the meeting composer** — in `meeting-composer.tsx`:
  - remove the local `PromptOption`/`AgentOption` types, the two `useQuery` calls, `prompts`/`agents` consts, and `addPpRow`/`removePpRow`/`updatePpRow`;
  - replace them with `const { prompts, agents } = usePostProcessingOptions();` (import from `../hooks`);
  - replace the whole `{/* Post-processing prompts */} <div className="space-y-2"> … </div>` block with `<PostProcessingPicker rows={ppRows} onChange={setPpRows} prompts={prompts} agents={agents} />`;
  - `canStart`'s last clause becomes `postProcessingRowsComplete(ppRows)`;
  - drop now-unused imports (`Plus`, `X`, `Select*`, `useQuery`, `GET_PICKER_AGENTS`, `GET_PROMPT_LIBRARY`) — keep anything still used elsewhere in the file (the language `Select` is still used; `X`/`Plus` are not).

- [ ] **Step 4: Type-check, lint**

Run: `npx tsc --noEmit && npx eslint "app/(application)/transcriptions"`
Expected: clean (eslint's unused-import rule will flag anything you forgot to remove).

- [ ] **Step 5: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend-live-recording && git rev-parse --show-toplevel && git branch --show-current && \
git add "app/(application)/transcriptions/components/post-processing-picker.tsx" "app/(application)/transcriptions/components/meeting-composer.tsx" "app/(application)/transcriptions/hooks.ts" && \
git commit -m "refactor(transcriptions): extract PostProcessingPicker + usePostProcessingOptions from the meeting composer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 13: Record composer, three-way mode toggle, i18n

**Files:**
- Create: `app/(application)/transcriptions/components/record-composer.tsx`
- Modify: `app/(application)/transcriptions/page.tsx:82-96` (flags/modes), `:214-262` (toggle + composer host), `:117-124` (Processing group filter)
- Modify: `messages/en.json`, `messages/de.json` (`transcriptions.composer.*`, `confirmStop`, `confirmDiscardRecording`, `toasts.*`)

**Interfaces:**
- Consumes: Task 9 (`LIVE_RECORDING_START`, `LIVE_RECORDING_STOP`, types), Task 11 (`useLiveRecording`, `extensionFor`, `formatElapsed`), Task 12 (`PostProcessingPicker`, `usePostProcessingOptions`, `postProcessingRowsComplete`), `useUppy` (`hooks/use-uppy.tsx`), `RBACControl`, `useProjectOptions`, `ConfirmDialog`, `StatusDot`.
- Produces: `<RecordComposer onCancel onStarted />`.

- [ ] **Step 1: i18n keys (both locales)** — add to `transcriptions.composer` (replace the two existing mode labels; add the rest after `"meetingSummary"`):

en.json:
```json
      "modeAudio": "Upload a file",
      "modeMeeting": "Invite a meeting bot",
      "modeRecord": "Record on this device",
      "recordIntro": "Put the phone on the table, press Start, and keep the screen on.",
      "recordDefaultTitle": "Recording {date}",
      "startRecording": "Start recording",
      "stopRecording": "Stop",
      "recording": "Recording",
      "keepScreenOn": "Keep this screen on. Recording pauses if the phone locks.",
      "partsSent": "{count, plural, one {# part sent} other {# parts sent}}",
      "partsPending": "{count, plural, one {# pending} other {# pending}}",
      "partsRetrying": "Connection problem — retrying",
      "transcribingPart": "transcribing…",
      "liveTranscriptEmpty": "The transcript appears here about a minute after you start talking.",
      "sendingLastParts": "Sending last parts ({sent}/{total})…",
      "uploadingAudio": "Uploading audio…",
      "finishing": "Finishing…",
      "alreadyRecording": "A recording is already running in this tab.",
      "recordingInterrupted": "The microphone was interrupted. Stop to keep what was captured."
```
de.json:
```json
      "modeAudio": "Datei hochladen",
      "modeMeeting": "Meeting-Bot einladen",
      "modeRecord": "Auf diesem Gerät aufnehmen",
      "recordIntro": "Legen Sie das Telefon auf den Tisch, drücken Sie Start und lassen Sie den Bildschirm an.",
      "recordDefaultTitle": "Aufnahme {date}",
      "startRecording": "Aufnahme starten",
      "stopRecording": "Stopp",
      "recording": "Aufnahme läuft",
      "keepScreenOn": "Lassen Sie diesen Bildschirm an. Die Aufnahme pausiert, wenn das Telefon gesperrt wird.",
      "partsSent": "{count, plural, one {# Teil gesendet} other {# Teile gesendet}}",
      "partsPending": "{count, plural, one {# ausstehend} other {# ausstehend}}",
      "partsRetrying": "Verbindungsproblem – neuer Versuch",
      "transcribingPart": "wird transkribiert…",
      "liveTranscriptEmpty": "Das Transkript erscheint hier etwa eine Minute nach Gesprächsbeginn.",
      "sendingLastParts": "Letzte Teile werden gesendet ({sent}/{total})…",
      "uploadingAudio": "Audio wird hochgeladen…",
      "finishing": "Wird abgeschlossen…",
      "alreadyRecording": "In diesem Tab läuft bereits eine Aufnahme.",
      "recordingInterrupted": "Das Mikrofon wurde unterbrochen. Stoppen Sie, um das Erfasste zu behalten."
```

New sibling blocks in `transcriptions` (after `confirmDelete`):

en.json:
```json
    "confirmStop": {
      "title": "Stop recording?",
      "description": "The transcript so far will be kept for review; the audio will be uploaded.",
      "confirm": "Stop recording"
    },
    "confirmDiscardRecording": {
      "title": "Discard this recording?",
      "description": "The recording and its transcript will be deleted.",
      "confirm": "Discard"
    },
```
de.json:
```json
    "confirmStop": {
      "title": "Aufnahme beenden?",
      "description": "Das bisherige Transkript wird zur Überprüfung gespeichert; die Audiodatei wird hochgeladen.",
      "confirm": "Aufnahme beenden"
    },
    "confirmDiscardRecording": {
      "title": "Diese Aufnahme verwerfen?",
      "description": "Aufnahme und Transkript werden gelöscht.",
      "confirm": "Verwerfen"
    },
```

Add to `transcriptions.toasts` (after `"postProcessingFailed"`):

en.json:
```json
      "recordingStarted": "Recording started",
      "recordingStartFailed": "Couldn't start the recording",
      "recordingFinished": "Recording finished — review it below",
      "recordingStopFailed": "Couldn't finish the recording",
      "recordingDiscarded": "Recording discarded",
      "recordingInterrupted": "Recording was interrupted",
      "recordingAutoStopped": "Recording stopped automatically after 4 hours",
      "recordingEndedElsewhere": "This recording was finished from another device",
      "audioUploadFailedKeptTranscript": "The transcript was kept, but the audio could not be uploaded",
      "partSkipped": "Part {seq} could not be transcribed"
```
de.json:
```json
      "recordingStarted": "Aufnahme gestartet",
      "recordingStartFailed": "Aufnahme konnte nicht gestartet werden",
      "recordingFinished": "Aufnahme beendet – unten überprüfen",
      "recordingStopFailed": "Aufnahme konnte nicht abgeschlossen werden",
      "recordingDiscarded": "Aufnahme verworfen",
      "recordingInterrupted": "Aufnahme wurde unterbrochen",
      "recordingAutoStopped": "Aufnahme nach 4 Stunden automatisch beendet",
      "recordingEndedElsewhere": "Diese Aufnahme wurde auf einem anderen Gerät beendet",
      "audioUploadFailedKeptTranscript": "Das Transkript wurde gespeichert, die Audiodatei konnte aber nicht hochgeladen werden",
      "partSkipped": "Teil {seq} konnte nicht transkribiert werden"
```

Validate both files parse: `node -e 'JSON.parse(require("fs").readFileSync("messages/en.json","utf8")); JSON.parse(require("fs").readFileSync("messages/de.json","utf8")); console.log("json ok")'`.

- [ ] **Step 2: Create `components/record-composer.tsx`**

```tsx
"use client";

/**
 * "Record on this device" composer (spec §4.3): setup card (title, options,
 * post-processing) → big Start → recording surface (timer, level meter,
 * keep-screen-on notice, live transcript, queue status, Stop). Stop drains the
 * chunk queue, uploads the full audio via Uppy → S3, then calls
 * liveRecordingStop so the row lands in Needs review.
 *
 * The recorder itself lives in LiveRecordingProvider (shell-level) so leaving
 * the page keeps recording; this component only renders its state.
 */
import { useMutation } from "@apollo/client";
import { ChevronRight, Loader2, Mic, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import { useLiveRecording } from "@/components/live-recording/live-recording-provider";
import { extensionFor } from "@/components/live-recording/mime";
import { formatElapsed } from "@/components/live-recording/format";
import { QueueAbortError } from "@/components/live-recording/chunk-queue";
import { ConfirmDialog } from "@/components/primitives/confirm-dialog";
import { StatusDot } from "@/components/primitives/status-dot";
import { RBACControl } from "@/components/rbac";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import useUppy from "@/hooks/use-uppy";

import { usePostProcessingOptions, useProjectOptions } from "../hooks";
import { CANCEL_TRANSCRIPTION_JOB, LIVE_RECORDING_START, LIVE_RECORDING_STOP } from "../queries";
import { type Mode, type PostProcessingPrompt, type RbacRole, type RbacUser } from "../types";
import { PostProcessingPicker, postProcessingRowsComplete } from "./post-processing-picker";

const ALLOWED_MODES: Mode[] = ["private", "users", "roles", "public"];
const LANGUAGES = ["en", "de", "fr", "es", "it", "nl", "pt"] as const;

export interface RecordComposerProps {
  onCancel: () => void;
  onStarted: () => void;
}

type Phase = "setup" | "starting" | "recording" | "finishing";

export function RecordComposer({ onCancel, onStarted }: RecordComposerProps) {
  const t = useTranslations("transcriptions");
  const tChat = useTranslations("chat");
  const tCommon = useTranslations("common");
  const recorder = useLiveRecording();

  const [title, setTitle] = React.useState("");
  const [language, setLanguage] = React.useState("auto");
  const [projectId, setProjectId] = React.useState("");
  const [rightsMode, setRightsMode] = React.useState<Mode>("private");
  const [rbacUsers, setRbacUsers] = React.useState<RbacUser[]>([]);
  const [rbacRoles, setRbacRoles] = React.useState<RbacRole[]>([]);
  const [ppRows, setPpRows] = React.useState<PostProcessingPrompt[]>([]);
  const [optionsOpen, setOptionsOpen] = React.useState(false);
  const [phase, setPhase] = React.useState<Phase>(recorder.jobId ? "recording" : "setup");
  const [finishStep, setFinishStep] = React.useState<"draining" | "uploading" | "closing" | null>(null);
  const [confirmStopOpen, setConfirmStopOpen] = React.useState(false);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = React.useState(false);

  const projects = useProjectOptions();
  const { prompts, agents } = usePostProcessingOptions();
  const [startLive] = useMutation(LIVE_RECORDING_START);
  const [stopLive] = useMutation(LIVE_RECORDING_STOP);
  const [cancelJob] = useMutation(CANCEL_TRANSCRIPTION_JOB);

  // Dedicated Uppy instance for the master recording (webm/mp4 are not in
  // AUDIO_FILE_TYPES — that constant documents the whisper pipeline's inputs).
  const uploadResolver = React.useRef<{ resolve: (key: string) => void; reject: (err: Error) => void } | null>(null);
  const uppy = useUppy(
    {
      backend: "",
      uppyOptions: { id: "transcriptions-record", allowedFileTypes: [".webm", ".mp4", ".m4a", ".ogg"] },
      maxNumberOfFiles: 1,
      callbacks: {
        uploadSuccess: (data) => uploadResolver.current?.resolve(data.s3Key || data.key),
      },
    },
    [],
  );
  React.useEffect(() => {
    if (!uppy) return;
    const onError = () => uploadResolver.current?.reject(new Error("upload failed"));
    uppy.on("upload-error", onError);
    return () => {
      uppy.off("upload-error", onError);
    };
  }, [uppy]);

  const uploadMaster = (blob: Blob, mimeType: string): Promise<string> =>
    new Promise((resolve, reject) => {
      if (!uppy) return reject(new Error("uploader not ready"));
      uploadResolver.current = { resolve, reject };
      try {
        uppy.cancelAll();
        uppy.addFile({
          name: `recording-${new Date().toISOString().replace(/[:.]/g, "-")}.${extensionFor(mimeType)}`,
          type: mimeType,
          data: blob,
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error("upload failed"));
      }
    });

  const canStart = phase === "setup" && recorder.state !== "recording" && postProcessingRowsComplete(ppRows);

  const micErrorDescription = (err: unknown): string => {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") return tChat("composer.micPermissionDenied");
    if (name === "NotFoundError") return tChat("composer.micNotFound");
    if (name === "NotReadableError") return tChat("composer.micInUse");
    return err instanceof Error ? err.message : tChat("composer.micBlocked");
  };

  const onStart = async () => {
    if (recorder.state === "recording" || recorder.jobId) {
      toast.error(t("composer.alreadyRecording"));
      return;
    }
    if (typeof window !== "undefined" && !window.isSecureContext) {
      toast.error(tChat("composer.micUnavailableTitle"), {
        description: tChat("composer.micInsecureContext", { origin: window.location.origin }),
      });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error(tChat("composer.micUnavailableTitle"), { description: tChat("composer.micNoGetUserMedia") });
      return;
    }
    setPhase("starting");
    try {
      // Microphone first: a denied permission must never create a row.
      await recorder.prepare();
    } catch (err) {
      setPhase("setup");
      toast.error(tChat("composer.micUnavailableTitle"), { description: micErrorDescription(err) });
      return;
    }
    try {
      const result = await startLive({
        variables: {
          input: {
            title: title.trim() || t("composer.recordDefaultTitle", { date: new Date().toLocaleString() }),
            language: language === "auto" ? null : language,
            project_id: projectId || null,
            target_rights_mode: rightsMode,
            target_rbac_users: rbacUsers,
            target_rbac_roles: rbacRoles,
            post_processing_prompts: ppRows.filter((r) => r.prompt_id && r.agent_id),
          },
        },
      });
      const jobId = (result.data as { liveRecordingStart?: { id?: string } })?.liveRecordingStart?.id;
      if (!jobId) throw new Error("no job id returned");
      recorder.start(jobId);
      setPhase("recording");
      toast.success(t("toasts.recordingStarted"));
      onStarted(); // refetch the queue so the row shows under Processing (composer stays open)
    } catch (err: unknown) {
      recorder.discard();
      setPhase("setup");
      toast.error(t("toasts.recordingStartFailed"), { description: err instanceof Error ? err.message : undefined });
    }
  };

  const finish = React.useCallback(async () => {
    const jobId = recorder.jobId;
    if (!jobId) return;
    setPhase("finishing");
    setFinishStep("draining");
    let audioKey: string | null = null;
    let durationSeconds: number | null = null;
    try {
      const { blob, mimeType, durationMs } = await recorder.stop();
      durationSeconds = durationMs > 0 ? durationMs / 1000 : null;
      if (blob) {
        setFinishStep("uploading");
        try {
          audioKey = await uploadMaster(blob, mimeType);
        } catch {
          toast.warning(t("toasts.audioUploadFailedKeptTranscript"));
        }
      }
    } catch (err) {
      if (err instanceof QueueAbortError && err.reason === "not_recording") {
        // Finished/discarded from another device: nothing left to close here.
        toast.info(t("toasts.recordingEndedElsewhere"));
        setPhase("setup");
        setFinishStep(null);
        onCancel();
        return;
      }
      toast.error(t("toasts.recordingStopFailed"), { description: err instanceof Error ? err.message : undefined });
    }
    setFinishStep("closing");
    try {
      await stopLive({ variables: { id: jobId, input: { audio_s3key: audioKey, duration_seconds: durationSeconds } } });
      toast.success(t("toasts.recordingFinished"));
      setPhase("setup");
      setFinishStep(null);
      onStarted();
      onCancel();
    } catch (err: unknown) {
      setFinishStep(null);
      setPhase("recording"); // the row is still 'recording' server-side; the row's Finish action remains
      toast.error(t("toasts.recordingStopFailed"), { description: err instanceof Error ? err.message : undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder, stopLive, onStarted, onCancel, t]);

  const onDiscard = async () => {
    const jobId = recorder.jobId;
    recorder.discard();
    if (jobId) {
      try {
        await cancelJob({ variables: { id: jobId } });
      } catch (err: unknown) {
        toast.error(t("toasts.discardFailed"), { description: err instanceof Error ? err.message : undefined });
        throw err;
      }
    }
    toast.success(t("toasts.recordingDiscarded"));
    setPhase("setup");
    onStarted();
    onCancel();
  };

  // Server-side end (409 from a chunk), auto-stop, or an unrecoverable mic interruption → finish.
  React.useEffect(() => {
    if (phase !== "recording") return;
    if (recorder.abortReason === "not_recording") {
      toast.info(t("toasts.recordingEndedElsewhere"));
      recorder.discard();
      setPhase("setup");
      onStarted();
      onCancel();
      return;
    }
    if (recorder.autoStopped) {
      toast.info(t("toasts.recordingAutoStopped"));
      void finish();
      return;
    }
    if (recorder.state === "interrupted") {
      toast.warning(t("toasts.recordingInterrupted"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder.abortReason, recorder.autoStopped, recorder.state, phase]);

  // Skipped parts are surfaced once each.
  const announcedSkips = React.useRef(new Set<number>());
  React.useEffect(() => {
    for (const chunk of recorder.chunks) {
      if (chunk.status === "skipped" && !announcedSkips.current.has(chunk.seq)) {
        announcedSkips.current.add(chunk.seq);
        toast.warning(t("toasts.partSkipped", { seq: chunk.seq + 1 }));
      }
    }
  }, [recorder.chunks, t]);

  /* ------------------------------ recording surface ------------------------------ */
  if (phase === "recording" || phase === "finishing") {
    const sent = recorder.chunks.filter((c) => c.status === "sent" || c.status === "skipped").length;
    const pending = recorder.chunks.length - sent;
    const retrying = recorder.chunks.some((c) => c.status === "retrying");
    const bars = 12;
    return (
      <Card className="space-y-4 p-4 sm:p-6">
        <div className="flex items-center gap-3">
          <StatusDot status="error" pulse={phase === "recording"} />
          <span className="font-medium">{t("composer.recording")}</span>
          <span className="font-mono text-lg tabular-nums">{formatElapsed(recorder.elapsedMs)}</span>
          <div className="flex-1" />
          <Button
            type="button"
            variant="destructive"
            size="lg"
            disabled={phase === "finishing"}
            onClick={() => setConfirmStopOpen(true)}
            className="max-md:h-12"
          >
            {phase === "finishing" ? (
              <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" />
            ) : (
              <Square aria-hidden="true" className="mr-2 size-4" />
            )}
            {phase === "finishing" ? t("composer.finishing") : t("composer.stopRecording")}
          </Button>
        </div>

        <div className="flex h-8 items-end gap-1" aria-hidden="true">
          {Array.from({ length: bars }).map((_, i) => (
            <div
              key={i}
              className="w-2 rounded-sm bg-primary/70 transition-[height] duration-100"
              style={{ height: `${Math.max(8, Math.round(100 * Math.min(1, recorder.level * (bars / (i + 1)) )))}%` }}
            />
          ))}
        </div>

        <Alert>
          <AlertDescription>
            {recorder.state === "interrupted" ? t("composer.recordingInterrupted") : t("composer.keepScreenOn")}
          </AlertDescription>
        </Alert>

        <div className="max-h-[50vh] min-h-32 space-y-3 overflow-y-auto rounded-md border p-3 text-sm">
          {recorder.chunks.length === 0 ? (
            <p className="text-muted-foreground">{t("composer.liveTranscriptEmpty")}</p>
          ) : (
            recorder.chunks.map((chunk) => (
              <p key={chunk.seq} className={chunk.text ? undefined : "text-muted-foreground"}>
                {chunk.status === "sent" || chunk.status === "skipped"
                  ? chunk.text || "…"
                  : t("composer.transcribingPart")}
              </p>
            ))
          )}
        </div>

        <div className={retrying ? "text-xs text-amber-600 dark:text-amber-500" : "text-xs text-muted-foreground"}>
          {finishStep === "draining"
            ? t("composer.sendingLastParts", { sent, total: recorder.chunks.length })
            : finishStep === "uploading"
              ? t("composer.uploadingAudio")
              : finishStep === "closing"
                ? t("composer.finishing")
                : `${t("composer.partsSent", { count: sent })}${pending ? ` · ${t("composer.partsPending", { count: pending })}` : ""}${retrying ? ` · ${t("composer.partsRetrying")}` : ""}`}
        </div>

        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            disabled={phase === "finishing"}
            className="max-md:h-11"
            onClick={() => setConfirmDiscardOpen(true)}
          >
            {t("review.discard")}
          </Button>
        </div>

        <ConfirmDialog
          open={confirmStopOpen}
          onOpenChange={setConfirmStopOpen}
          title={t("confirmStop.title")}
          description={t("confirmStop.description")}
          confirmLabel={t("confirmStop.confirm")}
          onConfirm={finish}
        />
        <ConfirmDialog
          open={confirmDiscardOpen}
          onOpenChange={setConfirmDiscardOpen}
          title={t("confirmDiscardRecording.title")}
          description={t("confirmDiscardRecording.description")}
          confirmLabel={t("confirmDiscardRecording.confirm")}
          onConfirm={onDiscard}
        />
      </Card>
    );
  }

  /* ------------------------------------ setup ------------------------------------ */
  const projectName = projects.find((p) => p.id === projectId)?.name;
  const summary = [
    language === "auto" ? t("composer.autoLanguage") : t(`lang.${language}`),
    projectName ?? t("composer.noProjectSummary"),
    t(`mode.${rightsMode}`),
    ppRows.length ? `${t("composer.postProcessing")} (${ppRows.length})` : t("composer.postProcessing"),
  ].join(" · ");

  return (
    <Card className="space-y-4 p-4 sm:p-6">
      <p className="text-sm text-muted-foreground">{t("composer.recordIntro")}</p>

      <div className="space-y-2">
        <Label htmlFor="record-title">{t("composer.titleLabel")}</Label>
        <Input
          id="record-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("composer.recordDefaultTitle", { date: new Date().toLocaleDateString() })}
        />
      </div>

      <Collapsible open={optionsOpen} onOpenChange={setOptionsOpen}>
        <CollapsibleTrigger asChild>
          <button type="button" className="flex w-full items-center gap-2 text-sm text-muted-foreground">
            <ChevronRight aria-hidden="true" className={`size-4 transition-transform ${optionsOpen ? "rotate-90" : ""}`} />
            <span>{t("composer.options")}</span>
            <span className="truncate">· {summary}</span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid grid-cols-1 gap-4 pt-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>{t("composer.language")}</Label>
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t("composer.autoDetect")}</SelectItem>
                  {LANGUAGES.map((code) => (
                    <SelectItem key={code} value={code}>
                      {t(`lang.${code}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("composer.project")}</Label>
              <Select value={projectId || "none"} onValueChange={(v) => setProjectId(v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder={t("composer.noProject")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("composer.noProject")}</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>{t("composer.sharing")}</Label>
              <RBACControl
                allowedModes={ALLOWED_MODES}
                subjectLabel={t("sharing.subject")}
                initialRightsMode={rightsMode}
                initialUsers={rbacUsers}
                initialRoles={rbacRoles}
                modalMode
                onChange={(mode, users, roles) => {
                  setRightsMode(mode);
                  setRbacUsers(users);
                  setRbacRoles(roles);
                }}
              />
            </div>
            <div className="sm:col-span-2">
              <PostProcessingPicker rows={ppRows} onChange={setPpRows} prompts={prompts} agents={agents} />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={phase === "starting"} className="max-md:h-11">
          {tCommon("cancel")}
        </Button>
        <Button type="button" size="lg" onClick={onStart} disabled={!canStart} className="max-md:h-14 max-md:text-base">
          {phase === "starting" ? (
            <Loader2 aria-hidden="true" className="mr-2 size-5 animate-spin" />
          ) : (
            <Mic aria-hidden="true" className="mr-2 size-5" />
          )}
          {t("composer.startRecording")}
        </Button>
      </div>
    </Card>
  );
}
```

- [ ] **Step 3: Page wiring** — in `page.tsx`:

Replace the flags/mode block (lines ~82-96) with:

```tsx
  // Three independent flows, each gated by its own backend flag (spec §4.1):
  // upload (Whisper server), meeting bot (Recall), record here (composer STT).
  const config = React.useContext(ConfigContext);
  const isMobile = useIsMobile();
  const live = useLiveRecordingOptional();
  const recallEnabled = !!config?.recall?.enabled;
  const uploadEnabled = !!config?.whisper?.enabled;
  const recordEnabled = !!config?.transcription?.enabled;
  const enabledModes = React.useMemo(
    () =>
      [
        recordEnabled && isMobile ? "record" : null, // one tap on a phone
        uploadEnabled ? "audio" : null,
        recallEnabled ? "meeting" : null,
        recordEnabled && !isMobile ? "record" : null,
      ].filter((m): m is ComposerMode => m !== null),
    [recallEnabled, uploadEnabled, recordEnabled, isMobile],
  );
  const showModeToggle = enabledModes.length >= 2;
  const [composerMode, setComposerMode] = React.useState<ComposerMode | null>(null);
  // An active recording always wins: reopen its surface wherever the user navigated from.
  const recordingActive = !!live?.jobId;
  const effectiveMode: ComposerMode | null = recordingActive
    ? "record"
    : composerMode && enabledModes.includes(composerMode)
      ? composerMode
      : (enabledModes[0] ?? null);
  const composerVisible = composerOpen || recordingActive;
```

with `type ComposerMode = "audio" | "meeting" | "record";` above the component, and imports `import { useIsMobile } from "@/hooks/use-mobile";`, `import { useLiveRecordingOptional } from "@/components/live-recording/live-recording-provider";`, `import { RecordComposer } from "./components/record-composer";`.

Replace `{composerOpen && ( … )}` around the composer card with `{composerVisible && effectiveMode && ( … )}`, the `ToggleGroup` with:

```tsx
          {showModeToggle && !recordingActive && (
            <ToggleGroup
              type="single"
              value={effectiveMode}
              onValueChange={(value) => value && setComposerMode(value as ComposerMode)}
              className="justify-start"
            >
              {enabledModes.map((mode) => (
                <ToggleGroupItem key={mode} value={mode} className="max-md:h-11">
                  {t(mode === "audio" ? "composer.modeAudio" : mode === "meeting" ? "composer.modeMeeting" : "composer.modeRecord")}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
```

and the composer switch with:

```tsx
          {effectiveMode === "record" ? (
            <RecordComposer
              onCancel={closeComposer}
              onStarted={() => {
                refetchAll();
              }}
            />
          ) : effectiveMode === "meeting" ? (
            <MeetingComposer … unchanged … />
          ) : (
            <Composer … unchanged … />
          )}
```

(`RecordComposer` calls `onCancel` itself when a recording finishes, so `onStarted` only refetches.) `newButtonDisabled` becomes `composerVisible`. In the Processing group filter add `job.status === "recording" ||`.

- [ ] **Step 4: Type-check, lint**

Run: `npx tsc --noEmit && npx eslint "app/(application)/transcriptions"`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend-live-recording && git rev-parse --show-toplevel && git branch --show-current && \
git add "app/(application)/transcriptions/components/record-composer.tsx" "app/(application)/transcriptions/page.tsx" messages/en.json messages/de.json && \
git commit -m "feat(transcriptions): Record on this device composer + three-way mode toggle

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 14: Queue row for `recording` jobs, review sheet for live jobs

**Files:**
- Modify: `app/(application)/transcriptions/components/job-row.tsx:9-35` (imports), `:48-60` (mutations/flags), `:69-110` (`statusLine`), `:165-260` (icon, dot, actions), `:313-318` (hairline), `:320-345` (dialogs)
- Modify: `app/(application)/transcriptions/components/review-sheet.tsx:571-573` (post-processing gating), `:646-650` (no-audio string)
- Modify: `messages/en.json`, `messages/de.json` (`transcriptions.row.*`, `review.noAudio`, `confirmFinishRecording`, `toasts.recordingFinishedRow`)

**Interfaces:**
- Consumes: Task 9 (`isLiveJob`, `hasPostProcessing`, `LIVE_RECORDING_STOP`), Task 11 (`useLiveRecordingOptional`).

- [ ] **Step 1: i18n (both locales)**

`transcriptions.row` (append after `"inMeeting"`):

en:
```json
      "recording": "Recording · {length} · {parts, plural, one {# part} other {# parts}}",
      "recordingNoLength": "Recording…",
      "lastAudio": "last audio {time}",
      "recordingHere": "recording on this device",
      "finish": "Finish",
      "discard": "Discard",
      "liveSource": "Live recording"
```
de:
```json
      "recording": "Aufnahme · {length} · {parts, plural, one {# Teil} other {# Teile}}",
      "recordingNoLength": "Aufnahme läuft…",
      "lastAudio": "letztes Audio {time}",
      "recordingHere": "Aufnahme auf diesem Gerät",
      "finish": "Abschließen",
      "discard": "Verwerfen",
      "liveSource": "Live-Aufnahme"
```

`transcriptions.review` (append after `"videoUnavailable"`): en `"noAudio": "No audio file is attached to this transcript."`, de `"noAudio": "Diesem Transkript ist keine Audiodatei angehängt."`.

New sibling block after `confirmDiscardRecording`:

en:
```json
    "confirmFinishRecording": {
      "title": "Finish this recording?",
      "description": "The transcript captured so far becomes a draft for review. No audio file will be attached.",
      "confirm": "Finish"
    },
```
de:
```json
    "confirmFinishRecording": {
      "title": "Diese Aufnahme abschließen?",
      "description": "Das bisher erfasste Transkript wird zum Entwurf zur Überprüfung. Es wird keine Audiodatei angehängt.",
      "confirm": "Abschließen"
    },
```

`transcriptions.toasts`: en `"recordingFinishedRow": "Recording finished"`, de `"recordingFinishedRow": "Aufnahme abgeschlossen"`.

Validate: `node -e 'JSON.parse(require("fs").readFileSync("messages/en.json","utf8")); JSON.parse(require("fs").readFileSync("messages/de.json","utf8")); console.log("json ok")'`.

- [ ] **Step 2: Job row** — in `job-row.tsx`:

Imports: add `Mic` to the lucide import; add `LIVE_RECORDING_STOP` to the `../queries` import; add `isLiveJob` to the `../types` import; add `import { useLiveRecordingOptional } from "@/components/live-recording/live-recording-provider";`.

After `const [removeSavedItem] = …` add:

```tsx
  const [finishLive] = useMutation(LIVE_RECORDING_STOP);
  const [confirmFinishOpen, setConfirmFinishOpen] = React.useState(false);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = React.useState(false);
  const live = isLiveJob(job);
  const liveRecorder = useLiveRecordingOptional();
  // The row for the job THIS tab is recording hides Finish/Discard — the
  // recording surface owns those controls (spec §4.5).
  const recordingHere = live && job.status === "recording" && liveRecorder?.jobId === job.id;
```

Change `const now = useTicker(job.status === "transcribing");` to `useTicker(job.status === "transcribing" || job.status === "recording")`.

In `statusLine`, add a case before `case "queued":`:

```tsx
      case "recording":
        return audioLengthLabel
          ? t("row.recording", { length: audioLengthLabel, parts: job.chunk_count ?? 0 })
          : t("row.recordingNoLength");
```

Add the handlers after `onConfirmDismiss`:

```tsx
  const onConfirmFinish = async () => {
    try {
      await finishLive({ variables: { id: job.id, input: { audio_s3key: null, duration_seconds: null } } });
      toast.success(t("toasts.recordingFinishedRow"));
      onChanged();
    } catch (err: unknown) {
      toast.error(t("toasts.recordingStopFailed"), {
        description: err instanceof Error ? err.message : undefined,
      });
      throw err; // keep the ConfirmDialog open
    }
  };

  const onConfirmDiscardRecording = async () => {
    try {
      await cancelJob({ variables: { id: job.id } });
      toast.success(t("toasts.recordingDiscarded"));
      onChanged();
    } catch (err: unknown) {
      toast.error(t("toasts.discardFailed"), {
        description: err instanceof Error ? err.message : undefined,
      });
      throw err;
    }
  };
```

Icon: extend the ternary so live jobs get `<Mic aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />` (meeting → `Video`, live → `Mic`, else `FileAudio`).

Status dot: add next to the existing `isRunning` dot:

```tsx
            {job.status === "recording" && (
              <StatusDot status="error" pulse className="shrink-0" />
            )}
```

Status line: for recording rows append the heartbeat after `statusLine`:

```tsx
            {job.status === "recording" && job.last_chunk_at ? (
              <>
                {" · "}
                {t("row.lastAudio", { time: "" })}
                <RelativeTime date={job.last_chunk_at} live />
              </>
            ) : null}
```

(`t("row.lastAudio", { time: "" })` yields "last audio " — the `RelativeTime` element supplies the time. Keep the key's `{time}` placeholder so translators see the shape.)

Actions: add before the `awaiting_review` button:

```tsx
          {job.status === "recording" && recordingHere && (
            <span className="text-xs text-muted-foreground">{t("row.recordingHere")}</span>
          )}
          {job.status === "recording" && !recordingHere && (
            <>
              <Button type="button" variant="ghost" size="sm" className="max-md:h-11" onClick={() => setConfirmDiscardOpen(true)}>
                {t("row.discard")}
              </Button>
              <Button type="button" variant="outline" size="sm" className="max-md:h-11" onClick={() => setConfirmFinishOpen(true)}>
                {t("row.finish")}
              </Button>
            </>
          )}
```

Hairline: `{(job.status === "transcribing" || job.status === "recording") && ( … )}`.

Dialogs: add after the dismiss dialog:

```tsx
      <ConfirmDialog
        open={confirmFinishOpen}
        onOpenChange={setConfirmFinishOpen}
        title={t("confirmFinishRecording.title")}
        description={t("confirmFinishRecording.description")}
        confirmLabel={t("confirmFinishRecording.confirm")}
        onConfirm={onConfirmFinish}
      />
      <ConfirmDialog
        open={confirmDiscardOpen}
        onOpenChange={setConfirmDiscardOpen}
        title={t("confirmDiscardRecording.title")}
        description={t("confirmDiscardRecording.description")}
        confirmLabel={t("confirmDiscardRecording.confirm")}
        onConfirm={onConfirmDiscardRecording}
      />
```

- [ ] **Step 3: Review sheet** — in `review-sheet.tsx`:
  - add `hasPostProcessing` to the `../types` import and change `{meeting && (<PostProcessingResults … />)}` to `{hasPostProcessing(job) && (<PostProcessingResults job={job} onRefreshJob={onRefreshJob} />)}` (update the comment: "shown for any job with prompts configured or outputs stored — Recall meetings and live recordings");
  - in the sticky footer's last branch change `{t("review.meetingNoAudio")}` to `{t(isMeetingJob(job) ? "review.meetingNoAudio" : "review.noAudio")}` (that branch is reached by non-meeting jobs without `audio_s3key`, i.e. a live recording finished without its upload; `isMeetingJob` is already imported there — the `meeting` const is in the parent component, so use the function).

- [ ] **Step 4: Type-check, lint, tests**

Run: `npx tsc --noEmit && npx eslint "app/(application)/transcriptions" && npx vitest run`
Expected: clean; all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend-live-recording && git rev-parse --show-toplevel && git branch --show-current && \
git add "app/(application)/transcriptions/components/job-row.tsx" "app/(application)/transcriptions/components/review-sheet.tsx" messages/en.json messages/de.json && \
git commit -m "feat(transcriptions): recording rows with Finish/Discard, post-processing cards for live jobs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 15: Whole-branch verification (both repos)

**Files:** none new.

- [ ] **Step 1: Backend**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend-live-recording && git branch --show-current && \
npx tsc --noEmit && npm run lint:errors && npx jest 2>&1 | tail -15
```
Expected: type-check clean, no lint errors, jest summary with only the suites that already failed on `develop` before this branch (record their names in the PR/merge notes).

- [ ] **Step 2: Frontend**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend-live-recording && git branch --show-current && \
npx tsc --noEmit && npx eslint . && npx vitest run 2>&1 | tail -8 && npx next build 2>&1 | tail -20
```
Expected: clean; vitest all PASS; `next build` succeeds (this needs the hard-linked `node_modules` from Task 8 — a symlink fails under Turbopack).

- [ ] **Step 3: i18n parity** — every key added to `en.json` exists in `de.json`:

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend-live-recording && node -e '
const flat=(o,p="")=>Object.entries(o).flatMap(([k,v])=>typeof v==="object"&&v?flat(v,p+k+"."):[p+k]);
const en=new Set(flat(require("./messages/en.json").transcriptions,"transcriptions."));
const de=new Set(flat(require("./messages/de.json").transcriptions,"transcriptions."));
const missing=[...en].filter(k=>!de.has(k));const extra=[...de].filter(k=>!en.has(k));
console.log("missing in de:",missing);console.log("extra in de:",extra);process.exit(missing.length||extra.length?1:0)'
```
Expected: both lists empty.

### Task 16: Manual end-to-end (Daniel) — desktop, phone, and the review path

Run the backend worktree build on a spare port against the local Postgres + LiteLLM (:4000), and the frontend worktree dev server on a spare port pointed at it (`BACKEND=http://127.0.0.1:9011 npx next dev -p 3011`); phone access via the ngrok tunnel from Task 8.

- [ ] **Step 1: Desktop happy path (Chrome).** `/transcriptions` → New transcription → the toggle shows "Upload a file" only if `TRANSCRIPTION_SERVER` is set, "Invite a meeting bot" only if Recall is configured, "Record on this device" always (Gemini STT is configured). Choose Record, pick a project and one post-processing prompt, Start → mic prompt → the row appears under Processing with a pulsing red dot and "recording on this device". Talk for ~3 minutes with pauses: text paragraphs appear roughly every 20–60 s; the parts counter increments; the shell pill shows in the top bar.
- [ ] **Step 2: Navigation survives.** Click Chat in the sidebar, wait 30 s, click the pill → back on `/transcriptions` with the recording surface open and new parts added meanwhile.
- [ ] **Step 3: Stop.** Confirm Stop → "Sending last parts" → "Uploading audio" → toast "Recording finished". The row moves to Needs review; Review opens the sheet with the audio timeline playable, one speaker "unknown" (diarization notice shown), transcript blocks, and the post-processing card (auto-run result or a Run card). Save → toast with "View in library"; `/data/transcriptions/<id>` shows `transcript_text` and the `post_processing` field.
- [ ] **Step 4: Second device / abandoned row.** Start a recording on the phone (Safari, via ngrok). On the desktop the row shows "Recording · 0m 40s · 2 parts · last audio 10 s ago" with Finish and Discard. Click Finish → the phone gets the "finished from another device" toast within one chunk and closes its surface; the row is in Needs review without audio and the sheet says "No audio file is attached to this transcript."
- [ ] **Step 5: Phone specifics (iOS Safari + Chrome Android).** Screen stays on during a 5-minute recording (wake lock); lock the phone manually → unlock → the notice/toast says the recording was interrupted and Stop keeps what was captured; an incoming call → same. Discard on the phone → row disappears everywhere.
- [ ] **Step 6: Failure injection.** Stop LiteLLM for 60 s mid-recording → parts turn "retrying" with the amber status line, no toast spam; restart LiteLLM → the backlog drains in order and text fills in. With LiteLLM down, Stop → "Sending last parts" waits (no finalise) until LiteLLM returns, then completes.
- [ ] **Step 7: Spend and cost.** In LiteLLM `/spend/logs`, the chunk calls carry `user_id_<id>` and `project_id_<id>` tags; note the per-hour cost for the release notes.
- [ ] **Step 8: Record outcomes** in the plan (a short "UAT 2026-xx-xx" note under this task) and hand off with the superpowers:finishing-a-development-branch skill: both branches merge to their default branches (backend `develop`, frontend `main`) via temp worktrees, never by switching the primary checkouts.

---

## Self-review (done while writing)

- **Spec coverage:** §1 architecture → Tasks 4/6/11; §2 data model → Task 1 (columns, statuses) + Task 9 (frontend types); §3.1 gate + `/config.whisper` → Tasks 4/5; §3.2 mutations + shared `assertOwnsTranscriptionJob` → Tasks 2/5; §3.3 service incl. CAS append, duplicate/out-of-order/not-recording, stop + post-processing → Task 4; §3.4 route (field validation, 503/401/403/404/409/400/502, prior text, tags, skip marker) → Tasks 6/7; §3.5 `transcribe.ts` → Task 3; §3.6 boot log → Task 5; §4.1 three flags/nav/route-guard/demo → Task 8; §4.2 page modes, mobile default, labels, Processing group → Task 13; §4.3 composer, stop flow, upload fallback, `beforeunload`, provider-survives-navigation, pill → Tasks 11/13; §4.4 hook internals (mime, two recorders, cut policy, queue policy, wake lock, interruptions, auto-stop) → Tasks 10/11; §4.5 types/queries/row/sheet/hooks → Tasks 9/14; §4.6 i18n → Tasks 11/13/14 + parity check in Task 15; §5 error table → covered by the tests in Tasks 3/4/6/10 and the injections in Task 16; §6 testing → as listed; verify-first spikes → Tasks 0 and 8.
- **Type consistency:** `AppendChunkResult` kinds (`appended|duplicate|out_of_order|not_recording`) are identical in Task 4 (service), Task 6 (route switch), and Task 10 (`classifyChunkFailure` reads the route's `body.kind`). `LiveRecorder` fields used by Task 13 (`state, jobId, elapsedMs, level, chunks, abortReason, autoStopped, prepare, start, stop, discard`) match Task 11. `SendResult` shape produced by `createFetchTransport` (Task 11) matches `ChunkQueue`'s input (Task 10). `postProcessingRowsComplete`/`PostProcessingPicker` (Task 12) are what Task 13 imports. `whisper.enabled` is read in Task 13 from the `BackendConfigType` extended in Task 8.
- **Review Focus → tests:** #1 Task 4 "refuses to append once the row has left 'recording'" + Task 6 "409s (not_recording) … never transcribes"; #2 Task 4 "stores a silent chunk with empty text" + Task 6 "skipped=true appends an empty placeholder"; #3 Task 6 "stores a silent chunk (empty transcript)"; #4 Task 3 "keeps today's exact chat body"; #5 Task 10 "retries … never advances past it", "sends a skip marker …", "aborts on 409 not_recording".
