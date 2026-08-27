# Training Guide Foundations Implementation Plan (Sub-project B1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tested, calibrated toolkit that turns a meeting recording into a small set of well-chosen frames with timestamps — the input the guide pipeline will consume.

**Architecture:** Frame selection splits into a pure core and a thin impure shell. `ffmpeg` reports candidate scene-change timestamps and extracts a frame at a given second; everything that decides *which* candidates survive — windowing, budget allocation by narration density, minimum spacing, thinning — is pure TypeScript and unit-tested. That split is deliberate: the decisions carry all the subtlety and none of the I/O.

**Tech Stack:** TypeScript (ESM), vitest, ffmpeg/ffprobe, Node `child_process`.

**Spec:** `/Users/daniel.claessen/Desktop/Projects/exulu/backend/docs/superpowers/specs/2026-08-27-recall-video-training-guides-design.md` (sub-project B)

**Repository:** This plan is executed in **`/Users/daniel.claessen/Desktop/Projects/algikiag/project`** — a different repo from the one holding this document. All paths below are relative to that project root unless stated otherwise.

## Why this is B1 and not all of B

The spec's pipeline needs numbers nobody has yet: how many scene changes a real ALGI process recording produces, whether `ffmpeg`'s scene detector fires usefully on screen content at all, and therefore what frame budget and batch size the vision stage should use. Those are measurements, not decisions. B1 produces them. B2 — the Training context, the map/reduce stages, the processor and the three tools — gets written against B1's actual output rather than against guesses.

## Global Constraints

- Node.js **v22.18.0** exactly (`engines` in `package.json`).
- The project is **ESM** (`"type": "module"`, `module: "ESNext"`, `moduleResolution: "node"`). No `require`, no `__dirname` — use `import` and `import.meta.url`.
- `strict: true`, but `noImplicitAny: false` and `noUncheckedIndexedAccess: true`. That last one matters: indexing an array yields `T | undefined`, so guard before use.
- Existing path alias: `@EXULU_CONTEXTS` → `src/contexts/index`. Do not add aliases.
- **No test framework exists yet.** Task 1 adds vitest. There is no CI running tests (`.gitlab-ci.yml` has its build/lint steps commented out), so a green suite is a local gate only.
- All timestamps are **seconds as floating-point numbers**, never frame indices and never milliseconds. Mixing units is the most likely silent bug in this plan.
- Commit convention is conventional-commits (`commitlint` with `config-conventional` is installed and husky is active, so a malformed message is rejected). Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Verify the repo before any commit: `git rev-parse --show-toplevel` must end in `algikiag`, since several sibling checkouts are open in this workspace.

---

### Task 1: Test infrastructure, windowing, and transcript slicing

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (add the `test` script and the `vitest` devDependency)
- Create: `src/training/windows.ts`, `src/training/windows.test.ts`
- Create: `src/training/transcript.ts`, `src/training/transcript.test.ts`

**Interfaces:**
- Produces:
  - `splitIntoWindows(durationSec: number, windowSec: number): Window[]` where `Window = { index: number; start: number; end: number }`
  - `sliceTranscript(segments: Segment[], startSec: number, endSec: number): Segment[]` where `Segment = { start: number; end: number; text: string; speaker: string }`
  - `narratedSeconds(segments: Segment[]): number`
- `Segment` matches the shape stored in the transcriptions context's `raw_segments` field, so do not rename its keys.

- [ ] **Step 1: Add vitest**

```bash
cd /Users/daniel.claessen/Desktop/Projects/algikiag/project
npm install --save-dev vitest
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

Add to `package.json` scripts, after `"utils:initdb"`:

```json
    "test": "vitest run",
    "test:watch": "vitest",
```

- [ ] **Step 2: Write the failing tests for windowing**

Create `src/training/windows.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { splitIntoWindows } from "./windows";

describe("splitIntoWindows", () => {
  it("splits a 2h recording into twelve 10-minute windows", () => {
    const windows = splitIntoWindows(7200, 600);
    expect(windows).toHaveLength(12);
    expect(windows[0]).toEqual({ index: 0, start: 0, end: 600 });
    expect(windows[11]).toEqual({ index: 11, start: 6600, end: 7200 });
  });

  it("gives the remainder its own shorter final window", () => {
    const windows = splitIntoWindows(1500, 600);
    expect(windows).toHaveLength(3);
    expect(windows[2]).toEqual({ index: 2, start: 1200, end: 1500 });
  });

  it("returns a single window when the recording is shorter than one window", () => {
    expect(splitIntoWindows(120, 600)).toEqual([{ index: 0, start: 0, end: 120 }]);
  });

  it("returns nothing for a zero-length recording", () => {
    expect(splitIntoWindows(0, 600)).toEqual([]);
  });

  it("returns nothing for a negative duration rather than looping forever", () => {
    expect(splitIntoWindows(-5, 600)).toEqual([]);
  });

  it("throws on a non-positive window size instead of hanging", () => {
    expect(() => splitIntoWindows(600, 0)).toThrow(/windowSec/);
  });

  it("covers the whole recording with no gaps and no overlaps", () => {
    const windows = splitIntoWindows(3661, 600);
    expect(windows[0]!.start).toBe(0);
    expect(windows[windows.length - 1]!.end).toBe(3661);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]!.start).toBe(windows[i - 1]!.end);
    }
  });
});
```

- [ ] **Step 3: Run the windowing tests to verify they fail**

Run: `npx vitest run src/training/windows.test.ts`
Expected: FAIL — cannot resolve `./windows`

- [ ] **Step 4: Implement windowing**

Create `src/training/windows.ts`:

```ts
export type Window = {
  index: number;
  start: number;
  end: number;
};

/**
 * Contiguous fixed-length windows covering a recording.
 *
 * The final window is short rather than over-running the recording, so
 * `end` is always a real timestamp you can seek to. Windows exist to cap
 * memory, let the map stage run concurrently, and give a long guide natural
 * chapter boundaries.
 */
export const splitIntoWindows = (
  durationSec: number,
  windowSec: number,
): Window[] => {
  if (windowSec <= 0) {
    throw new Error(`splitIntoWindows: windowSec must be positive, got ${windowSec}`);
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];

  const windows: Window[] = [];
  for (let start = 0, index = 0; start < durationSec; start += windowSec, index++) {
    windows.push({
      index,
      start,
      end: Math.min(start + windowSec, durationSec),
    });
  }
  return windows;
};
```

- [ ] **Step 5: Run the windowing tests to verify they pass**

Run: `npx vitest run src/training/windows.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 6: Write the failing tests for transcript slicing**

Create `src/training/transcript.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sliceTranscript, narratedSeconds, type Segment } from "./transcript";

const seg = (start: number, end: number, text = "x"): Segment => ({
  start,
  end,
  text,
  speaker: "SPEAKER_00",
});

describe("sliceTranscript", () => {
  it("keeps segments fully inside the window", () => {
    const out = sliceTranscript([seg(10, 20)], 0, 600);
    expect(out).toHaveLength(1);
  });

  it("keeps a segment that straddles the window start", () => {
    // Someone mid-sentence at the boundary is still narrating this window.
    const out = sliceTranscript([seg(595, 605)], 600, 1200);
    expect(out).toHaveLength(1);
  });

  it("keeps a segment that straddles the window end", () => {
    const out = sliceTranscript([seg(1195, 1205)], 600, 1200);
    expect(out).toHaveLength(1);
  });

  it("drops segments entirely before the window", () => {
    expect(sliceTranscript([seg(0, 10)], 600, 1200)).toEqual([]);
  });

  it("drops segments entirely after the window", () => {
    expect(sliceTranscript([seg(1300, 1310)], 600, 1200)).toEqual([]);
  });

  it("treats a segment ending exactly at the window start as outside", () => {
    expect(sliceTranscript([seg(500, 600)], 600, 1200)).toEqual([]);
  });

  it("preserves original order and does not mutate the input", () => {
    const input = [seg(10, 20, "a"), seg(30, 40, "b")];
    const copy = JSON.parse(JSON.stringify(input));
    const out = sliceTranscript(input, 0, 600);
    expect(out.map((s) => s.text)).toEqual(["a", "b"]);
    expect(input).toEqual(copy);
  });

  it("handles an empty transcript", () => {
    expect(sliceTranscript([], 0, 600)).toEqual([]);
  });
});

describe("narratedSeconds", () => {
  it("sums segment durations", () => {
    expect(narratedSeconds([seg(0, 10), seg(20, 35)])).toBe(25);
  });

  it("is zero for silence", () => {
    expect(narratedSeconds([])).toBe(0);
  });

  it("ignores segments with a non-positive duration rather than subtracting", () => {
    expect(narratedSeconds([seg(10, 10), seg(30, 20), seg(0, 5)])).toBe(5);
  });
});
```

- [ ] **Step 7: Run the transcript tests to verify they fail**

Run: `npx vitest run src/training/transcript.test.ts`
Expected: FAIL — cannot resolve `./transcript`

- [ ] **Step 8: Implement transcript slicing**

Create `src/training/transcript.ts`:

```ts
/** One diarized utterance, matching the transcriptions context's raw_segments. */
export type Segment = {
  start: number;
  end: number;
  text: string;
  speaker: string;
};

/**
 * Segments overlapping [startSec, endSec).
 *
 * Overlap, not containment: an utterance straddling a window boundary is
 * narration for both windows, and dropping it would silently lose the
 * sentence that explains the action at the boundary. A segment ending exactly
 * at startSec belongs to the previous window only.
 */
export const sliceTranscript = (
  segments: Segment[],
  startSec: number,
  endSec: number,
): Segment[] => segments.filter((s) => s.end > startSec && s.start < endSec);

/**
 * Total spoken seconds. Used to weight frame budget toward windows where the
 * employee is actually explaining something.
 */
export const narratedSeconds = (segments: Segment[]): number =>
  segments.reduce((total, s) => total + Math.max(0, s.end - s.start), 0);
```

- [ ] **Step 9: Run the transcript tests to verify they pass**

Run: `npx vitest run src/training/transcript.test.ts`
Expected: PASS, 11 tests

- [ ] **Step 10: Run the whole suite and commit**

Run: `npm test`
Expected: PASS, 18 tests across 2 files

```bash
git rev-parse --show-toplevel   # must end in /algikiag
git branch --show-current
git add vitest.config.ts package.json package-lock.json src/training/
git commit -m "feat(training): add vitest, windowing and transcript slicing

First pieces of the training-guide pipeline, and the project's first tests.

sliceTranscript keeps segments that overlap a window rather than those
contained by it: an utterance straddling a boundary is narration for both
sides, and dropping it loses the sentence explaining the action there.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Frame budget allocation and timestamp selection

**Files:**
- Create: `src/training/frame-budget.ts`, `src/training/frame-budget.test.ts`
- Create: `src/training/frame-selection.ts`, `src/training/frame-selection.test.ts`

**Interfaces:**
- Consumes: `Window` from `./windows`, `Segment` / `sliceTranscript` / `narratedSeconds` from `./transcript`.
- Produces:
  - `allocateFrameBudget({ windows, segments, totalBudget, minPerWindow }): number[]` — one budget per window, index-aligned with `windows`
  - `selectFrameTimestamps({ candidates, minIntervalSec, budget }): number[]`

**This is where the plan's real logic lives.** Both functions are pure and both encode a decision that is easy to get plausibly wrong.

- [ ] **Step 1: Write the failing tests for budget allocation**

Create `src/training/frame-budget.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { allocateFrameBudget } from "./frame-budget";
import { splitIntoWindows } from "./windows";
import type { Segment } from "./transcript";

const seg = (start: number, end: number): Segment => ({
  start,
  end,
  text: "x",
  speaker: "SPEAKER_00",
});

describe("allocateFrameBudget", () => {
  it("splits evenly when narration is uniform", () => {
    const windows = splitIntoWindows(1800, 600); // 3 windows
    const segments = [seg(0, 300), seg(600, 900), seg(1200, 1500)];
    const budgets = allocateFrameBudget({
      windows,
      segments,
      totalBudget: 300,
      minPerWindow: 10,
    });
    expect(budgets).toEqual([100, 100, 100]);
  });

  it("gives more frames to the window with denser narration", () => {
    const windows = splitIntoWindows(1200, 600); // 2 windows
    const segments = [seg(0, 450), seg(600, 750)]; // 450s vs 150s
    const budgets = allocateFrameBudget({
      windows,
      segments,
      totalBudget: 400,
      minPerWindow: 10,
    });
    expect(budgets[0]!).toBeGreaterThan(budgets[1]!);
    expect(budgets[0]! + budgets[1]!).toBeLessThanOrEqual(400);
  });

  it("never starves a silent window below minPerWindow", () => {
    const windows = splitIntoWindows(1200, 600);
    const segments = [seg(0, 500)]; // window 1 is entirely silent
    const budgets = allocateFrameBudget({
      windows,
      segments,
      totalBudget: 200,
      minPerWindow: 15,
    });
    // Silence is not absence of action — the employee may be working quietly.
    expect(budgets[1]!).toBeGreaterThanOrEqual(15);
  });

  it("splits evenly when the whole recording is silent", () => {
    const windows = splitIntoWindows(1800, 600);
    const budgets = allocateFrameBudget({
      windows,
      segments: [],
      totalBudget: 300,
      minPerWindow: 10,
    });
    expect(budgets).toEqual([100, 100, 100]);
  });

  it("never exceeds the total budget", () => {
    const windows = splitIntoWindows(7200, 600); // 12 windows
    const segments = [seg(0, 590)];
    const budgets = allocateFrameBudget({
      windows,
      segments,
      totalBudget: 600,
      minPerWindow: 20,
    });
    expect(budgets.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(600);
  });

  it("falls back to an even split when minPerWindow alone would exceed the budget", () => {
    const windows = splitIntoWindows(7200, 600); // 12 windows
    const budgets = allocateFrameBudget({
      windows,
      segments: [],
      totalBudget: 12, // 1 per window; minPerWindow of 20 is unsatisfiable
      minPerWindow: 20,
    });
    expect(budgets.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(12);
    expect(budgets.every((b) => b >= 1)).toBe(true);
  });

  it("returns one entry per window, index-aligned", () => {
    const windows = splitIntoWindows(3000, 600);
    const budgets = allocateFrameBudget({
      windows,
      segments: [],
      totalBudget: 100,
      minPerWindow: 5,
    });
    expect(budgets).toHaveLength(windows.length);
  });

  it("returns nothing when there are no windows", () => {
    expect(
      allocateFrameBudget({ windows: [], segments: [], totalBudget: 100, minPerWindow: 5 }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/training/frame-budget.test.ts`
Expected: FAIL — cannot resolve `./frame-budget`

- [ ] **Step 3: Implement budget allocation**

Create `src/training/frame-budget.ts`:

```ts
import type { Window } from "./windows";
import { narratedSeconds, sliceTranscript, type Segment } from "./transcript";

/**
 * Frames per window, weighted by how much the employee talks in each.
 *
 * Narration density is a proxy for "something is being explained here", so
 * talkative windows earn more frames. Two guards keep that from becoming
 * destructive:
 *
 *   - every window keeps at least `minPerWindow`, because silence is not the
 *     absence of action — someone working quietly is still working, and a
 *     starved window would produce a guide with a hole in it;
 *   - the total never exceeds `totalBudget`, which is what bounds cost and
 *     wall-clock on a 2h recording.
 *
 * When `minPerWindow` across all windows would itself exceed the budget, the
 * floor is abandoned in favour of an even split — a smaller honest share
 * everywhere beats honouring a floor for some windows and zero for the rest.
 */
export const allocateFrameBudget = ({
  windows,
  segments,
  totalBudget,
  minPerWindow,
}: {
  windows: Window[];
  segments: Segment[];
  totalBudget: number;
  minPerWindow: number;
}): number[] => {
  if (windows.length === 0) return [];

  const evenShare = Math.floor(totalBudget / windows.length);

  // The floor is unaffordable: spread what we have as evenly as possible.
  if (minPerWindow * windows.length > totalBudget) {
    return windows.map(() => Math.max(1, evenShare));
  }

  const densities = windows.map((w) =>
    narratedSeconds(sliceTranscript(segments, w.start, w.end)),
  );
  const totalDensity = densities.reduce((a, b) => a + b, 0);

  // No narration anywhere — density carries no signal, so split evenly.
  if (totalDensity <= 0) return windows.map(() => evenShare);

  const floorTotal = minPerWindow * windows.length;
  const discretionary = totalBudget - floorTotal;

  return densities.map((density) =>
    minPerWindow + Math.floor((discretionary * density) / totalDensity),
  );
};
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/training/frame-budget.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Write the failing tests for timestamp selection**

Create `src/training/frame-selection.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { selectFrameTimestamps } from "./frame-selection";

describe("selectFrameTimestamps", () => {
  it("keeps everything when candidates are already well spaced and under budget", () => {
    const out = selectFrameTimestamps({
      candidates: [0, 5, 10, 15],
      minIntervalSec: 2,
      budget: 10,
    });
    expect(out).toEqual([0, 5, 10, 15]);
  });

  it("drops candidates closer than minIntervalSec to the last kept one", () => {
    // Typing and scrolling fire the scene detector many times per second.
    const out = selectFrameTimestamps({
      candidates: [0, 0.3, 0.6, 5],
      minIntervalSec: 2,
      budget: 10,
    });
    expect(out).toEqual([0, 5]);
  });

  it("measures spacing from the last KEPT frame, not the previous candidate", () => {
    // 0 and 1.5 and 3.0: if spacing were measured candidate-to-candidate,
    // 3.0 would be dropped after 1.5 was dropped. It must be kept.
    const out = selectFrameTimestamps({
      candidates: [0, 1.5, 3.0],
      minIntervalSec: 2,
      budget: 10,
    });
    expect(out).toEqual([0, 3.0]);
  });

  it("thins evenly across the recording when over budget, not by truncation", () => {
    const candidates = Array.from({ length: 100 }, (_, i) => i * 10);
    const out = selectFrameTimestamps({
      candidates,
      minIntervalSec: 2,
      budget: 10,
    });
    expect(out).toHaveLength(10);
    // Truncation would end at 90s and lose the last 15 minutes entirely.
    expect(out[out.length - 1]!).toBeGreaterThan(800);
  });

  it("always keeps the first candidate", () => {
    const candidates = Array.from({ length: 50 }, (_, i) => i * 10);
    const out = selectFrameTimestamps({ candidates, minIntervalSec: 2, budget: 5 });
    expect(out[0]).toBe(0);
  });

  it("returns candidates in ascending order even if given unsorted input", () => {
    const out = selectFrameTimestamps({
      candidates: [10, 0, 5],
      minIntervalSec: 1,
      budget: 10,
    });
    expect(out).toEqual([0, 5, 10]);
  });

  it("returns nothing for no candidates", () => {
    expect(selectFrameTimestamps({ candidates: [], minIntervalSec: 2, budget: 10 })).toEqual([]);
  });

  it("returns nothing for a zero budget", () => {
    expect(
      selectFrameTimestamps({ candidates: [0, 5, 10], minIntervalSec: 2, budget: 0 }),
    ).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const candidates = [10, 0, 5];
    selectFrameTimestamps({ candidates, minIntervalSec: 1, budget: 10 });
    expect(candidates).toEqual([10, 0, 5]);
  });
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `npx vitest run src/training/frame-selection.test.ts`
Expected: FAIL — cannot resolve `./frame-selection`

- [ ] **Step 7: Implement timestamp selection**

Create `src/training/frame-selection.ts`:

```ts
/**
 * Thin a list of scene-change timestamps down to a budget.
 *
 * Two passes:
 *
 *   1. Spacing. Screen recordings fire the scene detector continuously while
 *      someone types or scrolls, so a minimum interval collapses those bursts
 *      to one frame. Spacing is measured from the last KEPT frame, not the
 *      previous candidate — otherwise a dense burst would suppress a genuinely
 *      new screen arriving just after it.
 *
 *   2. Thinning. If spacing still leaves more than the budget, keep an evenly
 *      spread subset rather than the first N. Truncating the tail would drop
 *      the end of the recording wholesale, which on a process walkthrough is
 *      where the process finishes.
 */
export const selectFrameTimestamps = ({
  candidates,
  minIntervalSec,
  budget,
}: {
  candidates: number[];
  minIntervalSec: number;
  budget: number;
}): number[] => {
  if (budget <= 0 || candidates.length === 0) return [];

  const sorted = [...candidates].sort((a, b) => a - b);

  const spaced: number[] = [];
  for (const t of sorted) {
    const last = spaced[spaced.length - 1];
    if (last === undefined || t - last >= minIntervalSec) spaced.push(t);
  }

  if (spaced.length <= budget) return spaced;

  const step = spaced.length / budget;
  const thinned: number[] = [];
  for (let i = 0; i < budget; i++) {
    const picked = spaced[Math.floor(i * step)];
    if (picked !== undefined) thinned.push(picked);
  }
  return thinned;
};
```

- [ ] **Step 8: Run to verify they pass**

Run: `npx vitest run src/training/frame-selection.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 9: Run the whole suite and commit**

Run: `npm test`
Expected: PASS, 35 tests across 4 files

```bash
git rev-parse --show-toplevel   # must end in /algikiag
git add src/training/
git commit -m "feat(training): allocate frame budget and select timestamps

Both pure, both encoding a decision that is easy to get plausibly wrong.

Budget allocation weights by narration density but floors every window,
because silence is not absence of action — someone working quietly still
needs frames, and a starved window leaves a hole in the guide.

Selection measures spacing from the last kept frame rather than the previous
candidate, so a burst of typing does not suppress a genuinely new screen
arriving just after it. Over budget it thins evenly rather than truncating,
because truncation would drop the end of the recording — which on a process
walkthrough is where the process finishes.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: ffmpeg wrappers and a calibration script

**Files:**
- Create: `src/training/ffmpeg.ts`
- Create: `scripts/calibrate-frames.ts`
- Modify: `package.json` (add the calibration script entry)

**Interfaces:**
- Consumes: everything from Tasks 1 and 2.
- Produces:
  - `probeDurationSec(input: string): Promise<number>`
  - `detectSceneTimestamps(input: string, threshold: number): Promise<number[]>`
  - `extractFrameAt(input: string, timestampSec: number, widthPx: number): Promise<Buffer>`

`input` is a local file path **or an https URL** — ffmpeg reads both, which matters because the recording arrives as a signed URL.

**No unit tests for this task.** These three functions are ffmpeg invocations; a test would assert that we call ffmpeg the way we call ffmpeg. Their correctness is established by Task 4 running them against a real recording. Do not write mock-based tests here to manufacture coverage.

- [ ] **Step 1: Confirm ffmpeg is available locally**

Run: `ffmpeg -version && ffprobe -version`

If missing, install it (`brew install ffmpeg` on macOS). Note the version in your report — the scene filter's behaviour has changed across major versions, so the calibration in Task 4 is only valid for a known version.

- [ ] **Step 2: Implement the wrappers**

Create `src/training/ffmpeg.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Recording length in seconds. Reads the container header only — no full download. */
export const probeDurationSec = async (input: string): Promise<number> => {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      input,
    ],
    { timeout: 120_000 },
  );
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration)) {
    throw new Error(`probeDurationSec: could not parse duration from "${stdout.trim()}"`);
  }
  return duration;
};

/**
 * Timestamps (seconds) where the picture changed by more than `threshold`.
 *
 * Runs a full decode with the scene filter and parses showinfo's pts_time from
 * stderr. This is the expensive step — the whole file must be decoded — so it
 * runs once per recording, not once per window.
 *
 * `threshold` is 0..1. Lower means more candidates. The right value for ALGI's
 * screen recordings is established by calibration, not by guessing.
 */
export const detectSceneTimestamps = async (
  input: string,
  threshold: number,
): Promise<number[]> => {
  // ffmpeg writes showinfo to stderr and exits 0; a large recording produces
  // a lot of it, hence the raised buffer.
  const { stderr } = await execFileAsync(
    "ffmpeg",
    [
      "-i", input,
      "-filter:v", `select='gt(scene,${threshold})',showinfo`,
      "-f", "null",
      "-",
    ],
    { timeout: 1_800_000, maxBuffer: 256 * 1024 * 1024 },
  );

  const timestamps: number[] = [];
  for (const match of stderr.matchAll(/pts_time:([0-9.]+)/g)) {
    const t = Number.parseFloat(match[1]!);
    if (Number.isFinite(t)) timestamps.push(t);
  }
  return timestamps;
};

/**
 * A single frame as a JPEG buffer.
 *
 * `-ss` before `-i` seeks the input rather than decoding up to the timestamp,
 * which is the difference between a seek and re-decoding two hours of video
 * for every frame.
 */
export const extractFrameAt = async (
  input: string,
  timestampSec: number,
  widthPx: number,
): Promise<Buffer> => {
  const dir = await mkdtemp(join(tmpdir(), "algi-frame-"));
  try {
    const out = join(dir, "frame.jpg");
    await execFileAsync(
      "ffmpeg",
      [
        "-ss", String(timestampSec),
        "-i", input,
        "-frames:v", "1",
        "-vf", `scale=${widthPx}:-1`,
        "-q:v", "4",
        "-y", out,
      ],
      { timeout: 120_000 },
    );
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
```

- [ ] **Step 3: Write the calibration script**

Create `scripts/calibrate-frames.ts`:

```ts
/**
 * Measure how the frame extractor behaves on a real recording.
 *
 * Usage:
 *   npx tsx scripts/calibrate-frames.ts <video-path-or-url> [thresholds]
 *
 * Prints, for each threshold, how many scene changes were detected and what
 * survives spacing and budget. The point is to choose a threshold and minimum
 * interval from evidence rather than from intuition, and to find out whether
 * ffmpeg's scene detector fires usefully on screen content at all.
 */
// Extensionless imports, matching the repo convention (see exulu.ts) — tsx
// resolves these; adding .js here would diverge from every other import.
import { probeDurationSec, detectSceneTimestamps } from "../src/training/ffmpeg";
import { splitIntoWindows } from "../src/training/windows";
import { selectFrameTimestamps } from "../src/training/frame-selection";

const input = process.argv[2];
if (!input) {
  console.error("usage: npx tsx scripts/calibrate-frames.ts <video-path-or-url> [thresholds]");
  process.exit(1);
}

const thresholds = (process.argv[3] ?? "0.05,0.10,0.15,0.25,0.40")
  .split(",")
  .map((t) => Number.parseFloat(t));

const duration = await probeDurationSec(input);
console.log(`duration: ${(duration / 60).toFixed(1)} min`);
console.log(`windows (10 min): ${splitIntoWindows(duration, 600).length}`);
console.log("");
console.log("threshold  candidates  per_min  after_spacing(2s)  after_budget(600)");

for (const threshold of thresholds) {
  const started = Date.now();
  const candidates = await detectSceneTimestamps(input, threshold);
  const spaced = selectFrameTimestamps({ candidates, minIntervalSec: 2, budget: 1e9 });
  const budgeted = selectFrameTimestamps({ candidates, minIntervalSec: 2, budget: 600 });
  const perMin = candidates.length / (duration / 60);
  console.log(
    `${threshold.toFixed(2)}       ${String(candidates.length).padEnd(10)}  ` +
      `${perMin.toFixed(1).padEnd(7)}  ${String(spaced.length).padEnd(17)}  ` +
      `${String(budgeted.length).padEnd(9)}  (${((Date.now() - started) / 1000).toFixed(0)}s)`,
  );
}
```

Add to `package.json` scripts:

```json
    "calibrate:frames": "tsx scripts/calibrate-frames.ts",
```

- [ ] **Step 4: Smoke-test against any short video**

Any mp4 will do — this only proves the plumbing works, not that the thresholds are right.

Run: `npx tsx scripts/calibrate-frames.ts <some-short.mp4> 0.15`

Expected: a duration, a window count, and one row of numbers. If `detectSceneTimestamps` returns zero candidates for every threshold on a video that visibly changes, the filter string is wrong — fix it before Task 4, because Task 4's whole output would otherwise be zeros.

- [ ] **Step 5: Commit**

```bash
git rev-parse --show-toplevel   # must end in /algikiag
git add src/training/ffmpeg.ts scripts/calibrate-frames.ts package.json
git commit -m "feat(training): ffmpeg wrappers and a calibration script

probeDurationSec reads the container header, so recording length costs no
download. detectSceneTimestamps runs one full decode per recording — the
expensive step — and parses showinfo. extractFrameAt seeks before -i rather
than after, which is the difference between a seek and re-decoding the whole
file for every frame.

No unit tests: these are ffmpeg invocations, and a mock-based test would only
assert that we call ffmpeg the way we call ffmpeg. Correctness comes from the
calibration run against a real recording.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Calibrate against a real ALGI recording

Not automatable, and not skippable. Everything downstream — the frame budget, the vision batch size, the cost and wall-clock estimates in the spec — is currently a guess. This task replaces the guesses with measurements.

**This task needs a human with access to a real ALGI process recording.**

- [ ] **Step 1: Obtain a recording**

Ideally a genuine desktop process walkthrough. Failing that, any ALGI meeting recording with substantial screenshare — the 2026-08-24 Teams meeting `6a2f9b4a-3708-42a0-8304-6ba5bc91aa2f` had ~30 minutes of it.

Get a fresh URL (it expires after six hours):

```bash
curl -s -H "Authorization: $RECALL_API_KEY" \
  "https://$RECALL_REGION.recall.ai/api/v1/recording/$RECORDING_ID/" \
  | jq -r '.media_shortcuts.video_mixed.data.download_url'
```

- [ ] **Step 2: Run the calibration**

```bash
npm run calibrate:frames -- "<the signed url>"
```

- [ ] **Step 3: Choose the threshold and minimum interval**

Read the table against these questions:

- **Does scene detection fire usefully at all?** If candidate counts are near-zero at every threshold, screen content changes too gradually for this filter and approach A needs revisiting — say so rather than lowering the threshold until numbers appear.
- **Which threshold gives roughly 1–5 candidates per minute after spacing?** That is the range where frames plausibly correspond to distinct actions. Much more and it is catching scroll and cursor movement; much less and it is missing steps.
- **How long did the decode take?** This is the pipeline's wall-clock floor. If a 30-minute recording takes 10 minutes to scan, a 2h recording will not fit the spec's 5400s processor timeout and the timeout or the approach must change.

- [ ] **Step 4: Extract a handful of frames and look at them**

Create `scripts/dump-frames.ts`:

```ts
/** Dump a few frames at a given width so a human can check legibility. */
import { writeFile } from "node:fs/promises";
import { extractFrameAt } from "../src/training/ffmpeg";

const input = process.argv[2];
const width = Number.parseInt(process.argv[3] ?? "1024", 10);
if (!input) {
  console.error("usage: npx tsx scripts/dump-frames.ts <video-path-or-url> [width]");
  process.exit(1);
}

for (const t of [60, 300, 600, 900]) {
  const path = `/tmp/frame-${t}-w${width}.jpg`;
  await writeFile(path, await extractFrameAt(input, t, width));
  console.log(path);
}
```

Then:

```bash
npx tsx scripts/dump-frames.ts "<the signed url>" 1024
```

Repeat at 1536 or 1920 if 1024 turns out to be illegible.

Open them. **Is the screen content legible at 1024px wide?** If UI text is unreadable, the vision model will not read it either and the width must go up — which raises token cost per frame and lowers the affordable frame budget. This single observation constrains B2's whole cost model.

- [ ] **Step 5: Write the findings back into the spec**

Update the Open items section of
`/Users/daniel.claessen/Desktop/Projects/exulu/backend/docs/superpowers/specs/2026-08-27-recall-video-training-guides-design.md`
with the measured values: chosen threshold, minimum interval, candidates per minute, decode time per hour of video, and the legible frame width. Record the ffmpeg version they were measured with.

Commit in the backend repo with `docs(training): record frame-extraction calibration results`.

---

## Definition of done

- `npm test` passes in algikiag (35 tests across 4 files)
- `npm run calibrate:frames` runs end to end against a real recording
- A threshold, minimum interval and frame width are chosen from measurements and written into the spec
- Decode time per hour is known, and checked against the spec's 5400s processor timeout
- Frames at the chosen width are confirmed legible by eye

## Out of scope — these are B2

- The Training context, its processor, and the draft/publish lifecycle
- The vision map stage and the guide synthesis stage
- The three Alfredo Teacher tools
- Adding ffmpeg to `Dockerfile.worker` — needed only once the processor runs in a container

## Note carried from planning

`publish_training_guide` in B2 will take `rights_mode` of `"public"` or `"private"` only. `handleRBACUpdate` is not exported from `@exulu/backend` and `context.createItem`/`updateItem` ignore RBAC entirely, so a consuming project cannot write per-role rows. Narrower audiences are set afterwards with the existing bulk "Set access" dialog on `/data`. Decided 2026-08-27.
