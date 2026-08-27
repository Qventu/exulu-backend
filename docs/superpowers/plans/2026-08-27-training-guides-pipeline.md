# Alfredo Teacher Pipeline Implementation Plan (Sub-project B2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a screen-recorded meeting into a reviewable training guide in a new "Training" knowledge base.

**Architecture:** A Training context whose `processor` runs the pipeline on the queue: probe for screen content, window the recording, extract scene-gated frames, analyse them in batches with a vision model, merge the results, and synthesise a guide. Three tools give the Alfredo Teacher agent a way to list recordings, start a guide, and publish one. All judgment that can be made without I/O lives in pure, tested functions; the vision calls and ffmpeg are a thin shell around them.

**Tech Stack:** TypeScript (ESM), vitest, AI SDK `ai` 6.0.216 (`generateObject`), `@exulu/backend` (`ExuluModels`, `ExuluContext`, `ExuluTool`), ffmpeg.

**Spec:** `docs/superpowers/specs/2026-08-27-recall-video-training-guides-design.md` (sub-project B)

**Repository:** executed in **`/Users/daniel.claessen/Desktop/Projects/algikiag/project`**. The plan and spec live in the `exulu/backend` repo; paths below are relative to the algikiag project root unless stated.

## Hard prerequisite

**Task 1 cannot start until `@exulu/backend` is released with sub-projects A, A2 and C.** B2 needs `ExuluModels.resolve` (A2) and `recall_recording_id` on the transcriptions context (A). Both are merged to `develop` but unpublished. If the release is not out, stop and say so rather than working around it — a local `npm link` is acceptable for development but must not be committed.

## What B1 already built (consume, do not modify)

| Module | Exports |
|---|---|
| `src/training/windows.ts` | `splitIntoWindows(durationSec, windowSec): Window[]`, `Window = { index, start, end }` |
| `src/training/transcript.ts` | `Segment = { start, end, text, speaker }`, `sliceTranscript(segments, startSec, endSec)`, `narratedSeconds(segments)` |
| `src/training/frame-budget.ts` | `allocateFrameBudget({ windows, segments, totalBudget, minPerWindow }): number[]` |
| `src/training/frame-selection.ts` | `selectFrameTimestamps({ candidates, minIntervalSec, budget }): number[]` |
| `src/training/ffmpeg.ts` | `probeDurationSec(input)`, `detectSceneTimestamps(input, threshold)`, `extractFrameAt(input, timestampSec, widthPx)` |

40 tests currently pass. Your work must not break them.

## Global Constraints

- Node.js **v22.18.0** exactly. ESM (`"type": "module"`); extensionless relative imports, matching the repo.
- `strict: true`, `noUncheckedIndexedAccess: true` — indexing yields `T | undefined`; guard before use.
- Run tests with `npm test` (vitest) from the project root.
- **Calibrated constants, measured 2026-08-27 — use these exact values:** scene threshold `0.10`, minimum frame interval `2` seconds, frame width `1024` px, window `600` seconds, global frame budget `600`, minimum per window `10`, vision batch size `12`, vision concurrency `8`.
- **Model is `vertex-gemini-2.5-flash`.** Not Gemini 3.x: thinking tokens count against `maxOutputTokens`, and a constrained structured-output call is exactly the shape that returns an empty 200. Always pass `providerOptions: ExuluModels.providerOptions(model)`, which disables reasoning for Gemini.
- Timestamps are **seconds as floats** throughout.
- `husky` + `commitlint` (`config-conventional`) are active; a non-conventional commit message is rejected by a git hook. Every message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Before any commit run `git rev-parse --show-toplevel` and confirm it ends in `/algikiag` — sibling checkouts are open in this workspace.

---

### Task 1: Dependency bump and the Training context

**Files:**
- Modify: `package.json` (bump `@exulu/backend`)
- Create: `src/contexts/training.ts`
- Modify: `src/contexts/index.ts` (register it)

**Interfaces:**
- Produces: `trainingContext` (an `ExuluContext` with id `training`).

- [ ] **Step 1: Bump the dependency**

```bash
cd /Users/daniel.claessen/Desktop/Projects/algikiag/project
npm install @exulu/backend@latest
node -p "require('@exulu/backend/package.json').version"
```

Then confirm the two symbols B2 depends on actually shipped:

```bash
node -p "Object.keys(require('@exulu/backend')).includes('ExuluModels')"
grep -c "recall_recording_id" node_modules/@exulu/backend/dist/index.d.ts
```

Both must be truthy. **If either fails, stop** — the release does not contain A/A2 and nothing downstream will work.

- [ ] **Step 2: Write the context**

Create `src/contexts/training.ts`:

```ts
import { ExuluContext } from "@exulu/backend";
import { embeddingQueue, processingQueue } from "../queues";

/**
 * Training guides generated from screen recordings.
 *
 * calculateVectors is "manual" on purpose: a draft is written to the items
 * table but never chunked, so it is physically absent from the chunks table and
 * no retrieval path can reach it. That gives the review gate for free — there
 * is no `status = 'approved'` filter to remember at every call site, and no way
 * for a future search tool to leak drafts. Publishing embeds explicitly.
 */
export const trainingContext = new ExuluContext({
  id: "training",
  name: "Training",
  description:
    "Step-by-step guides for internal processes, generated from screen recordings.",
  embedder: {
    model: "gemini-embedding-001",
    queue: embeddingQueue,
  },
  active: true,
  configuration: {
    calculateVectors: "manual",
    defaultRightsMode: "private",
    languages: ["german"],
    maxRetrievalResults: 10,
  },
  sources: [],
  fields: [
    { name: "guide", type: "markdown" },
    { name: "action_log", type: "json", editable: false },
    {
      name: "status",
      type: "enum",
      enumValues: ["draft", "approved", "failed"],
      default: "draft",
      index: true,
    },
    { name: "source_recording_item_id", type: "text", index: true },
    { name: "source_description", type: "text" },
    { name: "processing_notes", type: "longText", editable: false },
  ],
});
```

The processor is added in Task 6, once the stages it calls exist.

- [ ] **Step 3: Register it**

In `src/contexts/index.ts`, import `trainingContext` and add it to the exported contexts collection, following exactly how the existing contexts are listed there.

- [ ] **Step 4: Verify the table is created**

```bash
npm run utils:initdb
```

Then confirm in Postgres:

```sql
\d training_items
```

`guide`, `action_log`, `status`, `source_recording_item_id`, `source_description`, `processing_notes` must all be present. A `training_chunks` table should also exist (the embedder is configured) but must stay empty until something is published.

- [ ] **Step 5: Commit**

```bash
git rev-parse --show-toplevel   # must end in /algikiag
git add package.json package-lock.json src/contexts/training.ts src/contexts/index.ts
git commit -m "feat(training): add the Training knowledge base

calculateVectors is manual so drafts are never chunked — they are physically
absent from the chunks table, which gives the review gate for free rather
than relying on every future call site remembering a status filter.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Prompts and the action-log merge

**Files:**
- Create: `src/training/prompts.ts`, `src/training/prompts.test.ts`
- Create: `src/training/action-log.ts`, `src/training/action-log.test.ts`

**Interfaces:**
- Produces:
  - `probeTimestamps(durationSec: number): number[]`
  - `renderTranscriptSlice(segments: Segment[]): string`
  - `buildMapPrompt({ description, transcriptText, timestamps }): string`
  - `buildReducePrompt({ description, actionLog, transcriptText }): string`
  - `ActionEvent = { t_start: number; t_end: number; action: string; narration: string; confidence: number }`
  - `mergeActionLog(events: ActionEvent[], opts?: { similarity?: number; gapSec?: number }): ActionEvent[]`

- [ ] **Step 1: Write the failing tests for prompts**

Create `src/training/prompts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  probeTimestamps,
  renderTranscriptSlice,
  buildMapPrompt,
  buildReducePrompt,
} from "./prompts";
import type { Segment } from "./transcript";

const seg = (start: number, end: number, text: string, speaker = "SPEAKER_00"): Segment => ({
  start,
  end,
  text,
  speaker,
});

describe("probeTimestamps", () => {
  it("samples at 10/35/60/85 percent of the duration", () => {
    expect(probeTimestamps(1000)).toEqual([100, 350, 600, 850]);
  });

  it("never samples at zero or at the very end, where frames are often blank", () => {
    const ts = probeTimestamps(100);
    expect(Math.min(...ts)).toBeGreaterThan(0);
    expect(Math.max(...ts)).toBeLessThan(100);
  });

  it("returns ascending timestamps for a very short recording", () => {
    const ts = probeTimestamps(4);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it("returns nothing for a zero-length recording", () => {
    expect(probeTimestamps(0)).toEqual([]);
  });
});

describe("renderTranscriptSlice", () => {
  it("renders one line per segment with a mm:ss timestamp and speaker", () => {
    expect(renderTranscriptSlice([seg(65, 70, "Hallo")])).toBe("[01:05] SPEAKER_00: Hallo");
  });

  it("joins multiple segments with newlines in order", () => {
    const out = renderTranscriptSlice([seg(0, 1, "eins"), seg(2, 3, "zwei")]);
    expect(out.split("\n")).toHaveLength(2);
    expect(out).toContain("eins");
    expect(out).toContain("zwei");
  });

  it("pads seconds so timestamps stay column-aligned", () => {
    expect(renderTranscriptSlice([seg(5, 6, "x")])).toContain("[00:05]");
  });

  it("handles durations beyond an hour without wrapping the minutes", () => {
    expect(renderTranscriptSlice([seg(3700, 3701, "x")])).toContain("[61:40]");
  });

  it("says so explicitly when there is no narration", () => {
    expect(renderTranscriptSlice([])).toBe("(no narration in this window)");
  });
});

describe("buildMapPrompt", () => {
  const args = {
    description: "Exporting the monthly parts list",
    transcriptText: "[00:10] SPEAKER_00: Zuerst öffne ich SAP",
    timestamps: [10, 25, 40],
  };

  it("includes the employee's description so the model knows the goal", () => {
    expect(buildMapPrompt(args)).toContain("Exporting the monthly parts list");
  });

  it("includes the transcript slice", () => {
    expect(buildMapPrompt(args)).toContain("Zuerst öffne ich SAP");
  });

  it("lists the frame timestamps so the model can attribute actions to times", () => {
    const p = buildMapPrompt(args);
    expect(p).toContain("10");
    expect(p).toContain("25");
    expect(p).toContain("40");
  });

  it("tells the model not to invent steps between frames", () => {
    expect(buildMapPrompt(args).toLowerCase()).toContain("do not invent");
  });

  it("still builds a usable prompt when the window is silent", () => {
    const p = buildMapPrompt({ ...args, transcriptText: "(no narration in this window)" });
    expect(p).toContain("(no narration in this window)");
    expect(p.length).toBeGreaterThan(100);
  });
});

describe("buildReducePrompt", () => {
  const args = {
    description: "Exporting the monthly parts list",
    actionLog: "[00:10] Open SAP",
    transcriptText: "[00:10] SPEAKER_00: Zuerst öffne ich SAP",
  };

  it("includes the description, the action log and the transcript", () => {
    const p = buildReducePrompt(args);
    expect(p).toContain("Exporting the monthly parts list");
    expect(p).toContain("Open SAP");
    expect(p).toContain("Zuerst öffne ich SAP");
  });

  it("asks for German, since ALGI's content and recordings are German", () => {
    expect(buildReducePrompt(args)).toContain("German");
  });

  it("tells the model to mark uncertain steps rather than guessing", () => {
    expect(buildReducePrompt(args).toLowerCase()).toContain("uncertain");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/training/prompts.test.ts`
Expected: FAIL — cannot resolve `./prompts`

- [ ] **Step 3: Implement the prompts**

Create `src/training/prompts.ts`:

```ts
import type { Segment } from "./transcript";

/** Fractions of the recording sampled by the content probe. */
const PROBE_FRACTIONS = [0.1, 0.35, 0.6, 0.85];

/**
 * Timestamps for the content probe.
 *
 * Deliberately avoids 0 and the final second: the first frames of a meeting
 * recording are often a join screen and the last are often a black frame, so
 * sampling there would bias the probe toward "no screen content".
 */
export const probeTimestamps = (durationSec: number): number[] => {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  return PROBE_FRACTIONS.map((f) => durationSec * f);
};

const mmss = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

/**
 * Transcript segments as timestamped lines.
 *
 * The empty case returns an explicit sentence rather than an empty string: a
 * blank section in a prompt reads as a mistake and invites the model to fill
 * the gap, whereas "no narration" is information.
 */
export const renderTranscriptSlice = (segments: Segment[]): string =>
  segments.length === 0
    ? "(no narration in this window)"
    : segments.map((s) => `[${mmss(s.start)}] ${s.speaker}: ${s.text}`).join("\n");

/** Map-stage prompt: frames plus context, asking for concrete actions. */
export const buildMapPrompt = ({
  description,
  transcriptText,
  timestamps,
}: {
  description: string;
  transcriptText: string;
  timestamps: number[];
}): string =>
  `A colleague recorded themselves performing this process:

"${description}"

The attached frames were captured from their screen recording, in order, at these times (seconds from the start of the recording):

${timestamps.map((t) => `- ${t.toFixed(1)}s (${mmss(t)})`).join("\n")}

What they said during this part of the recording:

${transcriptText}

Report the concrete actions they took, in order. For each action:

- "action": one step, imperative, naming the application and the UI element where you can see them — "Open the export dialog in SAP", not "the user does an export".
- "narration": what they said about that step, closely following the transcript above. Empty string if they said nothing.
- "t_start"/"t_end": seconds, taken from the frame times listed above.
- "confidence": 0 to 1. Use a low value when you are inferring a step rather than seeing it.

Report only what is visible in the frames. Do not invent steps that must have happened between two frames, and do not describe the meeting itself — only the work being done on screen. If a frame shows no meaningful change from the previous one, omit it rather than inventing an action for it.`;

/** Reduce-stage prompt: the merged log plus everything said, into a guide. */
export const buildReducePrompt = ({
  description,
  actionLog,
  transcriptText,
}: {
  description: string;
  actionLog: string;
  transcriptText: string;
}): string =>
  `A colleague recorded themselves performing this process:

"${description}"

These are the actions observed on their screen, in order:

${actionLog}

This is everything they said, with timestamps:

${transcriptText}

Write a training guide another employee can follow to perform this process themselves.

- Write in **German** — this is for ALGI colleagues, and the recording is German.
- Structure it with a short introduction, then numbered steps grouped under headings for each phase of the process.
- Each step says what to do and, where the recording explains it, why.
- Prefer the colleague's own words and terminology over generic phrasing.
- Where the observed actions are ambiguous or a step seems to be missing, say so in the text and mark it as uncertain rather than inventing a plausible step. A guide that admits a gap is useful; one that invents a step is dangerous.
- Do not mention the recording, the meeting, or the fact that this was generated.`;
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/training/prompts.test.ts`
Expected: PASS, 18 tests

- [ ] **Step 5: Write the failing tests for the merge**

Create `src/training/action-log.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mergeActionLog, renderActionLog, type ActionEvent } from "./action-log";

const ev = (
  t_start: number,
  t_end: number,
  action: string,
  confidence = 0.9,
  narration = "",
): ActionEvent => ({ t_start, t_end, action, narration, confidence });

describe("mergeActionLog", () => {
  it("sorts events by start time", () => {
    const out = mergeActionLog([ev(50, 55, "Zweiter Schritt"), ev(10, 15, "Erster Schritt")]);
    expect(out.map((e) => e.t_start)).toEqual([10, 50]);
  });

  it("collapses the same action reported twice at a window boundary", () => {
    // Two windows overlap on one action; the model describes it in both.
    const out = mergeActionLog([
      ev(598, 600, "Open the export dialog"),
      ev(601, 604, "Open the export dialog"),
    ]);
    expect(out).toHaveLength(1);
  });

  it("spans the merged event across both originals", () => {
    const out = mergeActionLog([
      ev(598, 600, "Open the export dialog"),
      ev(601, 604, "Open the export dialog"),
    ]);
    expect(out[0]!.t_start).toBe(598);
    expect(out[0]!.t_end).toBe(604);
  });

  it("keeps the higher confidence when merging", () => {
    const out = mergeActionLog([
      ev(598, 600, "Open the export dialog", 0.4),
      ev(601, 604, "Open the export dialog", 0.9),
    ]);
    expect(out[0]!.confidence).toBe(0.9);
  });

  it("keeps the longer narration when merging, since one window may have caught more", () => {
    const out = mergeActionLog([
      ev(598, 600, "Open the export dialog", 0.9, "kurz"),
      ev(601, 604, "Open the export dialog", 0.9, "eine viel längere Erklärung"),
    ]);
    expect(out[0]!.narration).toBe("eine viel längere Erklärung");
  });

  it("treats paraphrases of the same action as duplicates", () => {
    const out = mergeActionLog([
      ev(598, 600, "Open the export dialog in SAP"),
      ev(601, 604, "Open the export dialog in SAP now"),
    ]);
    expect(out).toHaveLength(1);
  });

  it("keeps genuinely different actions even when adjacent", () => {
    const out = mergeActionLog([
      ev(598, 600, "Open the export dialog"),
      ev(601, 604, "Select the date range"),
    ]);
    expect(out).toHaveLength(2);
  });

  it("keeps a repeated action when it recurs much later — the step was genuinely done twice", () => {
    const out = mergeActionLog([ev(10, 12, "Click Save"), ev(900, 902, "Click Save")]);
    expect(out).toHaveLength(2);
  });

  it("is case- and punctuation-insensitive when comparing", () => {
    const out = mergeActionLog([
      ev(598, 600, "Open the Export Dialog."),
      ev(601, 604, "open the export dialog"),
    ]);
    expect(out).toHaveLength(1);
  });

  it("does not mutate its input", () => {
    const input = [ev(50, 55, "B"), ev(10, 15, "A")];
    const copy = JSON.parse(JSON.stringify(input));
    mergeActionLog(input);
    expect(input).toEqual(copy);
  });

  it("returns nothing for no events", () => {
    expect(mergeActionLog([])).toEqual([]);
  });
});

describe("renderActionLog", () => {
  it("renders one timestamped line per event", () => {
    expect(renderActionLog([ev(65, 70, "Open SAP")])).toBe("[01:05] Open SAP");
  });

  it("flags low-confidence events so the guide writer can hedge them", () => {
    expect(renderActionLog([ev(65, 70, "Open SAP", 0.3)])).toContain("uncertain");
  });

  it("does not flag confident events", () => {
    expect(renderActionLog([ev(65, 70, "Open SAP", 0.95)])).not.toContain("uncertain");
  });

  it("returns an explicit sentence for an empty log", () => {
    expect(renderActionLog([])).toBe("(no actions were observed)");
  });
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `npx vitest run src/training/action-log.test.ts`
Expected: FAIL — cannot resolve `./action-log`

- [ ] **Step 7: Implement the merge**

Create `src/training/action-log.ts`:

```ts
export type ActionEvent = {
  t_start: number;
  t_end: number;
  action: string;
  narration: string;
  confidence: number;
};

/** Below this, an action is rendered with a hedge for the guide writer. */
const LOW_CONFIDENCE = 0.5;

const normalize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);

/** Jaccard similarity over word sets. 1 = identical wording, 0 = nothing shared. */
const similarity = (a: string, b: string): number => {
  const setA = new Set(normalize(a));
  const setB = new Set(normalize(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const word of setA) if (setB.has(word)) shared++;
  return shared / (setA.size + setB.size - shared);
};

/**
 * Sort and collapse duplicate actions.
 *
 * Duplicates arise at window boundaries: the same on-screen action falls into
 * two windows and gets described twice, in slightly different words. Adjacent
 * events are merged when they are both textually similar AND close in time.
 *
 * Both conditions are required. Time alone would merge two genuinely different
 * actions performed in quick succession; wording alone would collapse a step
 * legitimately repeated later in the process, which is exactly the kind of
 * detail a training guide must keep.
 */
export const mergeActionLog = (
  events: ActionEvent[],
  opts: { similarity?: number; gapSec?: number } = {},
): ActionEvent[] => {
  const minSimilarity = opts.similarity ?? 0.7;
  const maxGapSec = opts.gapSec ?? 15;

  const sorted = [...events].sort((a, b) => a.t_start - b.t_start);
  const merged: ActionEvent[] = [];

  for (const event of sorted) {
    const previous = merged[merged.length - 1];
    const isDuplicate =
      previous !== undefined &&
      event.t_start - previous.t_end <= maxGapSec &&
      similarity(previous.action, event.action) >= minSimilarity;

    if (!isDuplicate) {
      merged.push({ ...event });
      continue;
    }

    previous.t_end = Math.max(previous.t_end, event.t_end);
    previous.confidence = Math.max(previous.confidence, event.confidence);
    // The window that saw more of the action usually described it more fully.
    if (event.action.length > previous.action.length) previous.action = event.action;
    if (event.narration.length > previous.narration.length) {
      previous.narration = event.narration;
    }
  }

  return merged;
};

const mmss = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

/** The merged log as text for the reduce prompt. */
export const renderActionLog = (events: ActionEvent[]): string =>
  events.length === 0
    ? "(no actions were observed)"
    : events
        .map(
          (e) =>
            `[${mmss(e.t_start)}] ${e.action}` +
            (e.confidence < LOW_CONFIDENCE ? " (uncertain)" : "") +
            (e.narration ? ` — said: "${e.narration}"` : ""),
        )
        .join("\n");
```

- [ ] **Step 8: Run to verify they pass**

Run: `npx vitest run src/training/action-log.test.ts`
Expected: PASS, 15 tests

- [ ] **Step 9: Run the whole suite and commit**

Run: `npm test`
Expected: PASS, 73 tests (40 existing + 18 + 15)

```bash
git rev-parse --show-toplevel   # must end in /algikiag
git add src/training/prompts.ts src/training/prompts.test.ts \
        src/training/action-log.ts src/training/action-log.test.ts
git commit -m "feat(training): prompts and action-log merging

Duplicates arise at window boundaries, where one on-screen action falls into
two windows and gets described twice in different words. Merging requires
BOTH textual similarity and temporal proximity: time alone would collapse two
different actions done in quick succession, and wording alone would collapse
a step legitimately repeated later — which a training guide must keep.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: The vision calls

**Files:**
- Create: `src/training/vision.ts`

**Interfaces:**
- Consumes: `ExuluModels` from `@exulu/backend`; `generateObject` from `ai`; prompts from Task 2.
- Produces:
  - `probeScreenContent({ frames, userId }): Promise<{ has_screen_content: boolean; screen_fraction: number; note: string }>`
  - `analyseFrames({ frames, timestamps, description, transcriptText, userId }): Promise<ActionEvent[]>`

**No unit tests for this task.** These are model calls; a mocked test would assert that we call `generateObject` the way we call `generateObject`. Correctness is established by Task 7's end-to-end run. Do not write mock-based tests to manufacture coverage.

- [ ] **Step 1: Implement**

Create `src/training/vision.ts`:

```ts
import { generateObject } from "ai";
import { ExuluModels } from "@exulu/backend";
import { z } from "zod";
import { buildMapPrompt } from "./prompts";
import type { ActionEvent } from "./action-log";

const MODEL_ID = "vertex-gemini-2.5-flash";

const PROBE_SCHEMA = z.object({
  has_screen_content: z
    .boolean()
    .describe("True if these frames show a computer screen being used."),
  screen_fraction: z
    .number()
    .min(0)
    .max(1)
    .describe("Fraction of the supplied frames that show a screen."),
  note: z.string().describe("One sentence on what the frames actually show."),
});

const EVENTS_SCHEMA = z.object({
  events: z.array(
    z.object({
      t_start: z.number(),
      t_end: z.number(),
      action: z.string(),
      narration: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

const imageParts = (frames: Buffer[]) =>
  frames.map((data) => ({ type: "image" as const, image: data, mediaType: "image/jpeg" }));

/**
 * Does this recording show a screen at all?
 *
 * Runs before the pipeline commits, so a recording of somebody's face fails for
 * a few thousand tokens instead of the full budget. Deliberately not based on
 * Recall's screenshare_on events: those are not guaranteed across meeting
 * platforms, and this measures the thing itself rather than a proxy for it.
 */
export const probeScreenContent = async ({
  frames,
  userId,
}: {
  frames: Buffer[];
  userId?: number;
}) => {
  const model = await ExuluModels.resolve({ modelId: MODEL_ID, userId });
  const { object } = await generateObject({
    model,
    schema: PROBE_SCHEMA,
    providerOptions: ExuluModels.providerOptions(model),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `These ${frames.length} frames were sampled evenly across a recording. Does this recording show someone's computer screen — applications, documents, software being used — as opposed to webcam footage of people, an empty room, or a video-call placeholder card? Judge only from what you can see.`,
          },
          ...imageParts(frames),
        ],
      },
    ],
  });
  return object;
};

/** One batch of frames to structured action events. */
export const analyseFrames = async ({
  frames,
  timestamps,
  description,
  transcriptText,
  userId,
}: {
  frames: Buffer[];
  timestamps: number[];
  description: string;
  transcriptText: string;
  userId?: number;
}): Promise<ActionEvent[]> => {
  const model = await ExuluModels.resolve({ modelId: MODEL_ID, userId });
  const { object } = await generateObject({
    model,
    schema: EVENTS_SCHEMA,
    providerOptions: ExuluModels.providerOptions(model),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: buildMapPrompt({ description, transcriptText, timestamps }) },
          ...imageParts(frames),
        ],
      },
    ],
  });
  return object.events;
};
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors in `src/training/`. If `ExuluModels` is unresolved, Task 1's dependency bump did not take.

- [ ] **Step 3: Commit**

```bash
git rev-parse --show-toplevel   # must end in /algikiag
git add src/training/vision.ts
git commit -m "feat(training): vision calls for the content probe and map stage

The probe measures whether a recording shows a screen at all, so footage of
somebody's face fails for a few thousand tokens rather than the full pipeline
budget. Not based on Recall's screenshare_on events — those carry no
per-platform guarantee, and this tests the thing itself.

Model is pinned to gemini-2.5-flash with reasoning disabled: on Gemini 3+
thinking tokens count against maxOutputTokens, and a constrained
structured-output call is exactly the shape that returns an empty 200.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Batching and concurrency

**Files:**
- Create: `src/training/batching.ts`, `src/training/batching.test.ts`

**Interfaces:**
- Produces: `chunk<T>(items: T[], size: number): T[][]`, `mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>`

- [ ] **Step 1: Write the failing tests**

Create `src/training/batching.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { chunk, mapWithConcurrency } from "./batching";

describe("chunk", () => {
  it("splits evenly when the size divides the length", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it("puts the remainder in a shorter final chunk", () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });

  it("returns one chunk when the size exceeds the length", () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });

  it("returns nothing for an empty array", () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it("throws on a non-positive size rather than looping forever", () => {
    expect(() => chunk([1], 0)).toThrow(/size/);
  });
});

describe("mapWithConcurrency", () => {
  it("returns results in input order, not completion order", async () => {
    const out = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it("never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("passes the index alongside the item", async () => {
    const out = await mapWithConcurrency(["a", "b"], 2, async (item, i) => `${i}:${item}`);
    expect(out).toEqual(["0:a", "1:b"]);
  });

  it("rejects if any task rejects", async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("handles an empty list without hanging", async () => {
    await expect(mapWithConcurrency([], 3, async () => 1)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/training/batching.test.ts`
Expected: FAIL — cannot resolve `./batching`

- [ ] **Step 3: Implement**

Create `src/training/batching.ts`:

```ts
/** Split into fixed-size batches; the last may be shorter. */
export const chunk = <T>(items: T[], size: number): T[][] => {
  if (size <= 0) throw new Error(`chunk: size must be positive, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * Map with a concurrency cap, preserving input order.
 *
 * The cap matters: the document processor runs its VLM at 40, but that is a
 * single-tenant burst. Sustained parallel calls here risk 429 cooldowns, which
 * in this stack surface as a misleading "not allowed to access model due to
 * tags configuration" error rather than a rate-limit message.
 */
export const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return results;
};
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/training/batching.test.ts`
Expected: PASS, 11 tests

- [ ] **Step 5: Run the whole suite and commit**

Run: `npm test`
Expected: PASS, 84 tests

```bash
git rev-parse --show-toplevel   # must end in /algikiag
git add src/training/batching.ts src/training/batching.test.ts
git commit -m "feat(training): batching and a concurrency cap for the vision calls

Cap is 8, not the document processor's 40: that is a single-tenant burst,
whereas sustained parallelism here risks 429 cooldowns, which in this stack
surface as a misleading tags-configuration error rather than a rate limit.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: The pipeline

**Files:**
- Create: `src/training/pipeline.ts`

**Interfaces:**
- Consumes: everything from B1 and Tasks 2–4.
- Produces: `runTrainingPipeline({ videoUrl, segments, description, userId, onNote }): Promise<{ guide: string; actionLog: ActionEvent[]; notes: string[] }>`

**No unit tests.** This is orchestration over ffmpeg and model calls. Verified end-to-end in Task 7.

- [ ] **Step 1: Implement**

Create `src/training/pipeline.ts`:

```ts
import { generateText } from "ai";
import { ExuluModels } from "@exulu/backend";
import { mergeActionLog, renderActionLog, type ActionEvent } from "./action-log";
import { allocateFrameBudget } from "./frame-budget";
import { chunk, mapWithConcurrency } from "./batching";
import { detectSceneTimestamps, extractFrameAt, probeDurationSec } from "./ffmpeg";
import { selectFrameTimestamps } from "./frame-selection";
import {
  buildReducePrompt,
  probeTimestamps,
  renderTranscriptSlice,
} from "./prompts";
import { sliceTranscript, type Segment } from "./transcript";
import { analyseFrames, probeScreenContent } from "./vision";
import { splitIntoWindows } from "./windows";

// Calibrated 2026-08-27 against a real ALGI recording. See the spec's
// "Calibration results" section before changing any of these.
const SCENE_THRESHOLD = 0.1;
const MIN_INTERVAL_SEC = 2;
const FRAME_WIDTH_PX = 1024;
const WINDOW_SEC = 600;
const TOTAL_FRAME_BUDGET = 600;
const MIN_FRAMES_PER_WINDOW = 10;
const BATCH_SIZE = 12;
const VISION_CONCURRENCY = 8;
const MAX_DURATION_SEC = 2 * 60 * 60;
const MODEL_ID = "vertex-gemini-2.5-flash";

export class TrainingPipelineError extends Error {}

export const runTrainingPipeline = async ({
  videoUrl,
  segments,
  description,
  userId,
  onNote = () => {},
}: {
  videoUrl: string;
  segments: Segment[];
  description: string;
  userId?: number;
  onNote?: (note: string) => void;
}): Promise<{ guide: string; actionLog: ActionEvent[]; notes: string[] }> => {
  const notes: string[] = [];
  const note = (message: string) => {
    notes.push(message);
    onNote(message);
  };

  // 1. Probe duration without downloading.
  const duration = await probeDurationSec(videoUrl);
  note(`duration ${(duration / 60).toFixed(1)} min`);
  if (duration > MAX_DURATION_SEC) {
    throw new TrainingPipelineError(
      `Recording is ${(duration / 60).toFixed(0)} minutes. The limit is 120. ` +
        `Please record one process at a time in a shorter session.`,
    );
  }

  // 2. Does it show a screen at all? Cheap, and fails before the budget is spent.
  const probeTimes = probeTimestamps(duration);
  const probeFrames = await mapWithConcurrency(probeTimes, 4, (t) =>
    extractFrameAt(videoUrl, t, FRAME_WIDTH_PX),
  );
  const probe = await probeScreenContent({ frames: probeFrames, userId });
  note(`content probe: ${probe.note} (screen_fraction ${probe.screen_fraction.toFixed(2)})`);
  if (!probe.has_screen_content) {
    throw new TrainingPipelineError(
      `This recording does not appear to show a screen — ${probe.note} ` +
        `A training guide needs a recording of the process on your screen.`,
    );
  }

  // 3. Scene detection: one full decode, the expensive step.
  const candidates = await detectSceneTimestamps(videoUrl, SCENE_THRESHOLD);
  note(`${candidates.length} scene changes detected at threshold ${SCENE_THRESHOLD}`);
  if (candidates.length === 0) {
    throw new TrainingPipelineError(
      "No visual changes were detected in this recording, so there are no steps to describe.",
    );
  }

  // 4. Window, budget by narration density, select timestamps per window.
  const windows = splitIntoWindows(duration, WINDOW_SEC);
  const budgets = allocateFrameBudget({
    windows,
    segments,
    totalBudget: TOTAL_FRAME_BUDGET,
    minPerWindow: MIN_FRAMES_PER_WINDOW,
  });

  const perWindow = windows.map((w, i) => {
    const inWindow = candidates.filter((t) => t >= w.start && t < w.end);
    const chosen = selectFrameTimestamps({
      candidates: inWindow,
      minIntervalSec: MIN_INTERVAL_SEC,
      budget: budgets[i] ?? MIN_FRAMES_PER_WINDOW,
    });
    return { window: w, timestamps: chosen };
  });

  const totalFrames = perWindow.reduce((a, w) => a + w.timestamps.length, 0);
  note(`${totalFrames} frames selected across ${windows.length} window(s)`);

  // 5. Map: extract and analyse in batches.
  const allEvents: ActionEvent[] = [];
  for (const { window, timestamps } of perWindow) {
    if (timestamps.length === 0) {
      note(`window ${window.index}: no frames selected, skipped`);
      continue;
    }
    const transcriptText = renderTranscriptSlice(
      sliceTranscript(segments, window.start, window.end),
    );

    try {
      const batches = chunk(timestamps, BATCH_SIZE);
      const batchResults = await mapWithConcurrency(
        batches,
        VISION_CONCURRENCY,
        async (batchTimestamps) => {
          const frames = await mapWithConcurrency(batchTimestamps, 4, (t) =>
            extractFrameAt(videoUrl, t, FRAME_WIDTH_PX),
          );
          return analyseFrames({
            frames,
            timestamps: batchTimestamps,
            description,
            transcriptText,
            userId,
          });
        },
      );
      allEvents.push(...batchResults.flat());
    } catch (error) {
      // One bad window must not cost the whole guide, but the gap must be
      // visible — a guide that silently omits ten minutes looks complete.
      note(
        `window ${window.index} (${Math.round(window.start)}s–${Math.round(window.end)}s) FAILED: ` +
          `${(error as Error).message}. Those minutes are missing from this guide.`,
      );
    }
  }

  if (allEvents.length === 0) {
    throw new TrainingPipelineError(
      "No actions could be extracted from this recording.",
    );
  }

  // 6. Reduce: merge, then write the guide.
  const actionLog = mergeActionLog(allEvents);
  note(`${allEvents.length} raw events merged to ${actionLog.length}`);

  const model = await ExuluModels.resolve({ modelId: MODEL_ID, userId });
  const { text: guide } = await generateText({
    model,
    providerOptions: ExuluModels.providerOptions(model),
    prompt: buildReducePrompt({
      description,
      actionLog: renderActionLog(actionLog),
      transcriptText: renderTranscriptSlice(segments),
    }),
  });

  return { guide, actionLog, notes };
};
```

- [ ] **Step 2: Type-check and run the suite**

Run: `npx tsc --noEmit && npm test`
Expected: no new type errors; 84 tests still pass.

- [ ] **Step 3: Commit**

```bash
git rev-parse --show-toplevel   # must end in /algikiag
git add src/training/pipeline.ts
git commit -m "feat(training): the guide pipeline

Probe, window, scene-gate, map in batches, merge, synthesise. Calibrated
constants are pinned at the top with a pointer to the spec section that
measured them.

A failed window is recorded and the job continues, but the note names the
missing minutes explicitly: a guide that silently omits ten minutes still
looks complete, which is the failure mode worth avoiding.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire the processor onto the context

**Files:**
- Modify: `src/contexts/training.ts`

- [ ] **Step 1: Add the processor**

In `src/contexts/training.ts`, add to the `ExuluContext` options, before `fields`:

```ts
  processor: {
    name: "Training Guide Processor",
    description:
      "Turns the source recording's video and transcript into a draft training guide.",
    config: {
      // onInsert, NOT always: publishing calls updateItem, and an "always"
      // trigger would re-run the entire pipeline every time somebody edited a
      // guide.
      trigger: "onInsert",
      queue: processingQueue,
      timeoutInSeconds: 5400,
      // Drafts must not embed. Publishing embeds explicitly.
      generateEmbeddings: false,
    },
    execute: async ({ item, user, utils }: any) => {
      const { postgresClient, ExuluRecall } = await import("@exulu/backend");
      const notes: string[] = [];

      try {
        if (!item.source_recording_item_id) {
          throw new Error("no source_recording_item_id on the item");
        }

        const { db } = await postgresClient();
        const source = await db("transcriptions_items")
          .where({ id: item.source_recording_item_id })
          .first();
        if (!source) throw new Error("source recording item not found");
        if (!source.recall_recording_id) {
          throw new Error(
            "the source recording has no recall_recording_id — it may be a Whisper upload rather than a meeting recording",
          );
        }

        const videoUrl = await ExuluRecall.getRecordingVideoUrl(source.recall_recording_id);
        if (!videoUrl) {
          throw new Error(
            "the video for this recording is no longer available (retention is 90 days)",
          );
        }

        const segments =
          typeof source.raw_segments === "string"
            ? JSON.parse(source.raw_segments)
            : (source.raw_segments ?? []);

        const { runTrainingPipeline } = await import("../training/pipeline");
        const result = await runTrainingPipeline({
          videoUrl,
          segments,
          description: item.source_description ?? "",
          userId: user,
          onNote: (n) => notes.push(n),
        });

        return {
          ...item,
          guide: result.guide,
          action_log: JSON.stringify(result.actionLog),
          status: "draft",
          processing_notes: result.notes.join("\n"),
        };
      } catch (error) {
        return {
          ...item,
          status: "failed",
          processing_notes: [...notes, `FAILED: ${(error as Error).message}`].join("\n"),
        };
      }
    },
  },
```

The `catch` returns a `failed` item rather than throwing, so the reason reaches the user in `processing_notes` instead of only the worker log.

- [ ] **Step 2: Type-check and run the suite**

Run: `npx tsc --noEmit && npm test`
Expected: no new type errors; 84 tests pass.

- [ ] **Step 3: Commit**

```bash
git rev-parse --show-toplevel   # must end in /algikiag
git add src/contexts/training.ts
git commit -m "feat(training): run the pipeline from the Training context processor

trigger is onInsert, not always: publishing calls updateItem, and an always
trigger would re-run the whole pipeline on every edit. generateEmbeddings is
false so drafts stay out of the chunks table.

Failures return a failed item rather than throwing, so the reason reaches the
user in processing_notes instead of only the worker log.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: The three tools, and ffmpeg in the worker image

**Files:**
- Create: `src/tools/training-tools.ts`
- Modify: `src/tools/index.ts`
- Modify: `Dockerfile.worker`

**Interfaces:**
- Produces: `listMeetingRecordingsTool`, `createTrainingGuideTool`, `publishTrainingGuideTool`.

- [ ] **Step 1: Add ffmpeg to the worker image**

In `Dockerfile.worker`, add `ffmpeg \` to the `apt-get install -y` list, after `poppler-utils \`. The pipeline runs in the worker, so only that image needs it.

- [ ] **Step 2: Write the tools**

Create `src/tools/training-tools.ts`:

```ts
import { ExuluTool } from "@exulu/backend";
import { z } from "zod";

const listMeetingRecordingsTool = new ExuluTool({
  id: "list_meeting_recordings",
  name: "List meeting recordings",
  description:
    "List the user's saved meeting recordings that have video available, so one can be turned into a training guide.",
  category: "training",
  type: "function",
  needsApproval: false,
  inputSchema: z.object({
    search: z.string().optional().describe("Optional text to match against the title."),
  }),
  config: [],
  execute: async ({ search, user, contexts }: any) => {
    const transcriptions = contexts?.["transcriptions"];
    if (!transcriptions) return { result: "The transcriptions knowledge base is not available." };

    // `contains` maps to a case-insensitive ILIKE, so the search runs in
    // Postgres rather than over every row this user can read. getItems takes
    // no limit, so an unfiltered call on a large transcriptions context
    // returns everything — acceptable today, worth revisiting if that context
    // grows into the thousands.
    const items = await transcriptions.getItems({
      filters: search ? [{ name: { contains: search } }] : [],
      fields: ["id", "name", "recall_recording_id", "duration_seconds", "createdAt"],
      user,
      role: user?.role?.id,
    });

    const withVideo = items.filter((i: any) => !!i.recall_recording_id);

    if (withVideo.length === 0) {
      return {
        result:
          "No meeting recordings with video were found. Whisper audio uploads cannot be used — a training guide needs the screen recording from a meeting bot.",
      };
    }
    return { result: JSON.stringify(withVideo) };
  },
});

const createTrainingGuideTool = new ExuluTool({
  id: "create_training_guide",
  name: "Create training guide",
  description:
    "Start generating a training guide from a meeting recording. Requires a short description of what the recording shows — ask the user for it before calling this; do not guess.",
  category: "training",
  type: "function",
  needsApproval: true,
  inputSchema: z.object({
    source_recording_item_id: z
      .string()
      .describe("Id of the transcriptions item to build the guide from."),
    title: z.string().describe("A short title for the guide."),
    description: z
      .string()
      .min(10)
      .describe(
        "The user's own description of what process the recording shows. Ask them; do not infer it from the title.",
      ),
  }),
  config: [],
  execute: async ({
    source_recording_item_id,
    title,
    description,
    user,
    contexts,
    exuluConfig,
  }: any) => {
    if (!user?.id) return { result: "Creating a training guide requires a signed-in user." };

    const transcriptions = contexts?.["transcriptions"];
    const training = contexts?.["training"];
    if (!transcriptions || !training) {
      return { result: "The required knowledge bases are not available." };
    }

    // RBAC: getItems applies access control, so a recording the caller cannot
    // read simply is not returned.
    const [source] = await transcriptions.getItems({
      filters: [{ id: { eq: source_recording_item_id } }],
      fields: ["id", "name", "recall_recording_id"],
      user,
      role: user?.role?.id,
    });
    if (!source) {
      return { result: "That recording was not found, or you do not have access to it." };
    }
    if (!source.recall_recording_id) {
      return {
        result:
          "That item has no meeting video — it is probably an uploaded audio file. A training guide needs a screen recording.",
      };
    }

    const existing = await training.getItems({
      filters: [{ source_recording_item_id: { eq: source_recording_item_id } }],
      fields: ["id", "status"],
      user,
      role: user?.role?.id,
    });
    if (existing.length > 0) {
      return {
        result: `A guide already exists for this recording (item ${existing[0].id}, status ${existing[0].status}).`,
      };
    }

    const { item, job } = await training.createItem(
      {
        name: title,
        source_recording_item_id,
        source_description: description,
        status: "draft",
        rights_mode: "private",
        created_by: String(user.id),
      },
      exuluConfig,
      user.id,
      user?.role?.id,
      false,
    );

    return {
      result:
        `Started generating a training guide (item ${item.id}${job ? `, job ${job}` : ""}). ` +
        `This takes a few minutes for a long recording. The guide will be a private draft until it is published.`,
    };
  },
});

const publishTrainingGuideTool = new ExuluTool({
  id: "publish_training_guide",
  name: "Publish training guide",
  description:
    "Approve a draft training guide and make it searchable. Only do this after the user has reviewed the guide.",
  category: "training",
  type: "function",
  needsApproval: true,
  inputSchema: z.object({
    item_id: z.string().describe("Id of the training guide item to publish."),
    rights_mode: z
      .enum(["public", "private"])
      .describe(
        "public makes the guide findable by all colleagues; private keeps it visible only to its author.",
      ),
  }),
  config: [],
  execute: async ({ item_id, rights_mode, user, contexts, exuluConfig }: any) => {
    if (!user?.id) return { result: "Publishing requires a signed-in user." };

    const training = contexts?.["training"];
    if (!training) return { result: "The Training knowledge base is not available." };

    const [existing] = await training.getItems({
      filters: [{ id: { eq: item_id } }],
      fields: ["id", "status"],
      user,
      role: user?.role?.id,
    });
    if (!existing) {
      return { result: "That guide was not found, or you do not have access to it." };
    }
    if (existing.status === "failed") {
      return { result: "That guide failed to generate and cannot be published." };
    }

    // Status, audience and searchability move together. generateEmbeddings
    // must be true: the context is calculateVectors "manual", so this call is
    // the only thing that ever chunks a guide.
    await training.updateItem(
      { id: item_id, status: "approved", rights_mode },
      exuluConfig,
      user.id,
      user?.role?.id,
      true,
    );

    return {
      result: `Published guide ${item_id} as ${rights_mode}. It is now being indexed for search.`,
    };
  },
});

export const trainingTools = [
  listMeetingRecordingsTool,
  createTrainingGuideTool,
  publishTrainingGuideTool,
];
```

- [ ] **Step 3: Register them**

In `src/tools/index.ts`, import `trainingTools` and spread them into the exported array alongside the existing tools.

- [ ] **Step 4: Type-check and run the suite**

Run: `npx tsc --noEmit && npm test`
Expected: no new type errors; 84 tests pass.

- [ ] **Step 5: Commit**

```bash
git rev-parse --show-toplevel   # must end in /algikiag
git add src/tools/training-tools.ts src/tools/index.ts Dockerfile.worker
git commit -m "feat(training): Alfredo Teacher tools, and ffmpeg in the worker image

Three tools: list recordings, create a guide, publish one. All RBAC-scoped
through getItems, which applies access control, so a recording the caller
cannot read is simply not returned.

description is required with a minimum length and the schema tells the model
to ask rather than infer — a tool cannot prompt the user, so the requirement
plus needsApproval showing the extracted description on the approval card is
what actually enforces it.

Publishing sets status, audience and searchability in one call.
generateEmbeddings is true because the context is calculateVectors manual, so
this is the only thing that ever chunks a guide.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: End-to-end verification

Not automatable. The pipeline needs a real recording, a live database, a worker, and a human reading the result.

- [ ] **Step 1: Create the Alfredo Teacher agent**

In the Exulu UI, create an agent named "Alfredo Teacher" with the three `training` tools enabled and a system prompt covering: it helps colleagues turn screen recordings into training guides; before calling `create_training_guide` it must ask the user to describe what the recording shows in their own words; and after generation it should ask them to review the draft before publishing.

- [ ] **Step 2: Run a real recording through it**

Ask the agent to list recordings, pick one with real screen content, supply a description, and let it create a guide. Watch the worker log.

Verify: the item is created with `status: "draft"`, the processor runs on `processingQueue`, and `processing_notes` accumulates lines for duration, probe result, scene count and frame count.

- [ ] **Step 3: Check the negative path**

Run it against a recording with no screen content — `a2b47a5f` is one (webcam and a placeholder card, 7.9% screenshare). Expected: `status: "failed"`, and `processing_notes` explains that no screen was found. This is the guard that stops the pipeline spending its full budget on footage of somebody's face; confirm it actually fires.

- [ ] **Step 4: Read the guide**

Open the item in `/data/training`. Is the guide something a colleague could follow? Are the steps in the right order? Are uncertain steps marked rather than invented? Record the verdict — this is the only assessment of output quality anywhere in this plan.

- [ ] **Step 5: Confirm the draft is invisible to search**

Before publishing, confirm `training_chunks` has no rows for the item and that an agent with a Training context search finds nothing. This is the review gate; if a draft is already searchable, `calculateVectors` is not set to `"manual"`.

- [ ] **Step 6: Publish and confirm the transition**

Use `publish_training_guide` with `rights_mode: "public"`. Confirm `status` becomes `approved`, `rights_mode` becomes `public`, and `training_chunks` gains rows for the item. Then confirm search finds it.

- [ ] **Step 7: Record the outcome**

Add a short section to the spec noting: guide quality verdict, wall-clock for a real recording, whether the threshold held on genuine process content, and any prompt changes made. Commit in the backend repo as `docs(training): record the first end-to-end guide generation`.

---

## Definition of done

- `npm test` passes (84 tests)
- `npx tsc --noEmit` reports no errors in `src/training/` or `src/tools/`
- A real recording produces a readable draft guide
- A recording without screen content fails at the probe, cheaply and with a clear message
- A draft is absent from `training_chunks`; publishing adds it
- ffmpeg is in `Dockerfile.worker`

## Out of scope

- Conversational refinement of a draft with the agent (the spec defers this)
- Regenerating a guide for a recording that already has one
- Role-scoped audiences — `handleRBACUpdate` is not exported, so publish offers public or private only, and narrower audiences are set afterwards with the `/data` "Set access" dialog
- The frontend embedding modal (sub-project C's frontend half, its own plan)
