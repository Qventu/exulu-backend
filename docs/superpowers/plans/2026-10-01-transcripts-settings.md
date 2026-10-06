# Transcripts Stage 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins a Transcripts settings page for values that are environment variables today, and give uploaded files the automatic summaries that meeting bots and live recordings already get.

**Architecture:** One `platform_configurations` row holds the whole settings object; each field resolves **stored → env → code default** through one generic helper, with the source reported so the UI can show it. The upload pipeline reuses `recallService.runPostProcessing` verbatim rather than growing a second implementation.

**Tech Stack:** Backend — TypeScript, knex, hand-rolled GraphQL schema builder, jest + ts-jest. Frontend — Next.js 16 App Router, Apollo Client, shadcn/ui, vitest (node environment only).

**Spec:** `docs/superpowers/specs/2026-09-30-transcripts-settings-design.md`

**Repos:** backend worktree `../backend-transcripts-settings` (branch `feat/transcripts-settings`, off `develop` @ a15abca). The frontend worktree is created in Task 6. **Never edit one repo from the other's directory.**

## Global Constraints

- **Config key:** one row, `config_key = "transcripts_settings"`, `config_value` a JSON object. Not one key per value.
- **`null` means exactly one thing: "not set here".** Two fields therefore carry string sentinels for real admin choices: `videoRetentionHours: "forever"` and `monthlyRecordingLimitMinutes: "none"`. Never collapse either onto `null` — an admin's explicit "keep forever" would silently revert to the env default.
- **Precedence is stored → env → code**, always, with a `source` of `"database" | "env" | "code"`.
- **Clearing a field writes `null`**, restoring the env/code value. Never write the resolved value back — that freezes today's env into the database invisibly.
- **`config_value` is a `json` column.** Postgres may return it already parsed or as raw text; every read must tolerate both (see `src/exulu/embedder-settings.ts` and `src/exulu/entities/config.ts:127-140`).
- **Settings reads never throw.** They run on the composer-open and bot-dispatch paths; a failure logs and falls through to env/code.
- **Admin gate:** `super_admin`, matching `src/graphql/mutations/index.ts:909` and `:951`.
- **The default bot name becomes `"IMP Notetaker"`** (currently `"Company Notetaker"` at `src/exulu/recall/service.ts:39`). Never show a product brand in UI copy — say "the IMP" or "the agent".
- **No new tables and no schema change.** `transcription_jobs.post_processing_prompts` already exists (`src/postgres/core-schema.ts:735`).
- Commit messages: conventional prefix, ending with the trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **Measured baselines on this branch — already failing, NOT regressions.** Backend: `npx tsc --noEmit` = 8 errors; `npx jest` = 3 failed suites / 2 failed tests (`resolve-context-window`, `compact-session`, `email-inbound/intake`). One eslint parse error per NEW `.test.ts` file is structural. Measure before and after.
- Never `git add -A` or `git add .`.

## Review Focus

Failure modes the spec implies that no feature step naturally exercises. Each has its test assigned.

1. **A stored `false` or `0` must beat an env value.** `storeVideoLocally: false` with `RECALL_STORE_VIDEO_LOCALLY=true` must resolve to `false`. A `||`-based resolver silently ignores every falsy admin choice — the single most likely bug in this plan. [Task 1]
2. **A summary preset referencing a deleted prompt or agent.** Prompts and agents are deleted independently of this page; the composer must still open and the settings page must mark the preset unavailable rather than 500. [Task 2]
3. **A settings read failing while a bot is being dispatched.** Must fall through to env/code, never block the bot joining or the composer opening. [Task 2]
4. **The upload post-processing hook firing more than once, or on a non-completed job.** `_applyJobUpdate` is called on every poll tick; firing on `running`, `failed` or `cancelled`, or twice on completion, would double-spend LLM calls. [Task 4]
5. **A non-super-admin reaching the settings mutation.** The page is linked from a menu every user sees; the gate must be on the server, not only the UI. [Task 5]

---

### Task 1: The precedence resolver

**Files:**
- Create: `src/exulu/platform-setting.ts`
- Create: `src/exulu/platform-setting.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces — Tasks 2 and 3 consume these:

```ts
export type SettingSource = "database" | "env" | "code";
export interface ResolvedSetting<T> { value: T; source: SettingSource; }
export function resolveSetting<T>(
  stored: T | null | undefined,
  envValue: T | null | undefined,
  codeDefault: T,
): ResolvedSetting<T>;
```

- [ ] **Step 1: Write the failing tests**

Create `src/exulu/platform-setting.test.ts`:

```ts
import { resolveSetting } from "./platform-setting";

describe("resolveSetting", () => {
  it("prefers the stored value", () => {
    expect(resolveSetting("db", "env", "code")).toEqual({ value: "db", source: "database" });
  });

  it("falls back to env when nothing is stored", () => {
    expect(resolveSetting(null, "env", "code")).toEqual({ value: "env", source: "env" });
  });

  it("falls back to the code default when neither is set", () => {
    expect(resolveSetting(null, null, "code")).toEqual({ value: "code", source: "code" });
  });

  it("treats undefined the same as null at both layers", () => {
    expect(resolveSetting(undefined, undefined, "code")).toEqual({ value: "code", source: "code" });
    expect(resolveSetting(undefined, "env", "code")).toEqual({ value: "env", source: "env" });
  });

  it("a stored FALSE beats a truthy env value", () => {
    // The bug this helper exists to get right once: a `||`-based resolver
    // silently discards every falsy admin choice. An admin turning local
    // video storage OFF must win over RECALL_STORE_VIDEO_LOCALLY=true.
    expect(resolveSetting(false, true, true)).toEqual({ value: false, source: "database" });
  });

  it("a stored ZERO beats a non-zero env value", () => {
    expect(resolveSetting(0, 90, 2160)).toEqual({ value: 0, source: "database" });
  });

  it("a stored EMPTY STRING beats an env value", () => {
    expect(resolveSetting("", "env", "code")).toEqual({ value: "", source: "database" });
  });

  it("an env FALSE beats the code default", () => {
    expect(resolveSetting(null, false, true)).toEqual({ value: false, source: "env" });
  });

  it("carries a string sentinel through unchanged", () => {
    // "forever" / "none" are real admin choices, not absences.
    expect(resolveSetting<number | "forever">("forever", 720, 2160)).toEqual({
      value: "forever",
      source: "database",
    });
  });

  it("carries an array value through", () => {
    const presets = [{ prompt_id: "p", agent_id: "a" }];
    expect(resolveSetting(presets, null, [])).toEqual({ value: presets, source: "database" });
  });

  it("an empty stored array is a deliberate choice, not an absence", () => {
    // An admin removing every preset must not fall back to the code default.
    expect(resolveSetting<unknown[]>([], null, [{ prompt_id: "p", agent_id: "a" }])).toEqual({
      value: [],
      source: "database",
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/platform-setting.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/exulu/platform-setting.ts`:

```ts
/**
 * Resolve a platform setting across its three layers: a value stored in
 * platform_configurations, an environment variable, and the default declared
 * in code.
 *
 * This is the third place in the codebase that needs this shape
 * (src/exulu/entities/config.ts for entity models, src/exulu/embedder-settings.ts
 * for embedders, and now Transcripts settings). It exists so the next one is
 * not a fourth hand-rolled copy.
 *
 * Nullish checks, never truthiness: a stored `false`, `0` or `""` is a
 * deliberate admin choice and must beat the env value. A `||` chain here
 * would silently discard every falsy setting.
 *
 * Design doc: docs/superpowers/specs/2026-09-30-transcripts-settings-design.md §2
 */
export type SettingSource = "database" | "env" | "code";

export interface ResolvedSetting<T> {
  value: T;
  source: SettingSource;
}

export function resolveSetting<T>(
  stored: T | null | undefined,
  envValue: T | null | undefined,
  codeDefault: T,
): ResolvedSetting<T> {
  if (stored !== null && stored !== undefined) {
    return { value: stored, source: "database" };
  }
  if (envValue !== null && envValue !== undefined) {
    return { value: envValue, source: "env" };
  }
  return { value: codeDefault, source: "code" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/exulu/platform-setting.test.ts`
Expected: PASS, all eleven.

- [ ] **Step 5: Commit**

```bash
git add src/exulu/platform-setting.ts src/exulu/platform-setting.test.ts
git commit -m "feat(settings): one resolver for stored/env/code precedence

Third place in the codebase needing this shape, so it stops being
hand-rolled. Nullish checks rather than truthiness: a stored false, 0 or \"\"
is a deliberate admin choice and must beat the env value.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The Transcripts settings store

**Files:**
- Create: `src/exulu/transcripts-settings.ts`
- Create: `src/exulu/transcripts-settings.test.ts`

**Interfaces:**
- Consumes: `resolveSetting`, `ResolvedSetting`, `SettingSource` (Task 1); `postgresClient`; the env readers in `src/exulu/recall/env.ts`.
- Produces — Tasks 3, 4, 5 consume these:

```ts
export type TranscriptsSettings = {
  botName: string | null;
  notifyChat: boolean | null;
  recordersMayOverrideBot: boolean | null;
  defaultRightsMode: string | null;
  summaryPresets: { prompt_id: string; agent_id: string }[] | null;
  videoRetentionHours: number | "forever" | null;
  storeVideoLocally: boolean | null;
  monthlyRecordingLimitMinutes: number | "none" | null;
  videoStorageCostPerHour: number | null;
};

export type ResolvedTranscriptsSettings = {
  [K in keyof TranscriptsSettings]: ResolvedSetting<NonNullable<TranscriptsSettings[K]>>;
};

export const TRANSCRIPTS_SETTINGS_KEY = "transcripts_settings";
export const DEFAULT_BOT_NAME = "IMP Notetaker";

export const getTranscriptsSettings: () => Promise<TranscriptsSettings>;
export const saveTranscriptsSettings: (patch: Partial<TranscriptsSettings>) => Promise<void>;
export const resolveTranscriptsSettings: () => Promise<ResolvedTranscriptsSettings>;
```

`saveTranscriptsSettings` merges a patch into the stored object, so the page can save one section without clobbering another. An explicit `null` in the patch clears that field.

- [ ] **Step 1: Write the failing tests**

Create `src/exulu/transcripts-settings.test.ts`:

```ts
import {
  DEFAULT_BOT_NAME,
  getTranscriptsSettings,
  resolveTranscriptsSettings,
  saveTranscriptsSettings,
} from "./transcripts-settings";

const first = jest.fn();
const merge = jest.fn();

jest.mock("@SRC/postgres/client", () => ({
  postgresClient: async () => ({
    db: {
      from: () => ({
        where: () => ({ first }),
        insert: () => ({ onConflict: () => ({ merge }) }),
      }),
    },
  }),
}));

beforeEach(() => {
  first.mockReset();
  merge.mockReset();
  delete process.env.RECALL_RECORDING_RETENTION_HOURS;
  delete process.env.RECALL_STORE_VIDEO_LOCALLY;
  delete process.env.TOTAL_MAX_RECORDINGS_DURATION_PER_MONTH;
});

describe("getTranscriptsSettings", () => {
  it("returns all-null when there is no row", async () => {
    first.mockResolvedValue(undefined);
    const settings = await getTranscriptsSettings();
    expect(settings.botName).toBeNull();
    expect(settings.summaryPresets).toBeNull();
  });

  it("parses config_value when pg returns raw JSON text", async () => {
    first.mockResolvedValue({ config_value: '{"botName":"Acme Notetaker"}' });
    expect((await getTranscriptsSettings()).botName).toBe("Acme Notetaker");
  });

  it("accepts config_value already parsed into an object", async () => {
    first.mockResolvedValue({ config_value: { botName: "Acme Notetaker" } });
    expect((await getTranscriptsSettings()).botName).toBe("Acme Notetaker");
  });

  it("returns all-null rather than throwing when the read fails", async () => {
    // Runs on the composer-open and bot-dispatch paths: a database hiccup must
    // degrade to env/code, never block a bot from joining a meeting.
    first.mockRejectedValue(new Error("connection terminated"));
    const settings = await getTranscriptsSettings();
    expect(settings.botName).toBeNull();
  });

  it("returns all-null rather than throwing on unparseable JSON", async () => {
    first.mockResolvedValue({ config_value: "{not json" });
    expect((await getTranscriptsSettings()).botName).toBeNull();
  });
});

describe("resolveTranscriptsSettings", () => {
  it("falls back to the code default bot name", async () => {
    first.mockResolvedValue(undefined);
    const resolved = await resolveTranscriptsSettings();
    expect(resolved.botName).toEqual({ value: DEFAULT_BOT_NAME, source: "code" });
  });

  it("uses the stored bot name over the default", async () => {
    first.mockResolvedValue({ config_value: '{"botName":"Acme Notetaker"}' });
    expect((await resolveTranscriptsSettings()).botName).toEqual({
      value: "Acme Notetaker",
      source: "database",
    });
  });

  it("reads retention from env when nothing is stored", async () => {
    process.env.RECALL_RECORDING_RETENTION_HOURS = "720";
    first.mockResolvedValue(undefined);
    expect((await resolveTranscriptsSettings()).videoRetentionHours).toEqual({
      value: 720,
      source: "env",
    });
  });

  it("a stored retention beats the env var", async () => {
    process.env.RECALL_RECORDING_RETENTION_HOURS = "720";
    first.mockResolvedValue({ config_value: '{"videoRetentionHours":168}' });
    expect((await resolveTranscriptsSettings()).videoRetentionHours).toEqual({
      value: 168,
      source: "database",
    });
  });

  it('carries the "forever" sentinel rather than treating it as unset', async () => {
    process.env.RECALL_RECORDING_RETENTION_HOURS = "720";
    first.mockResolvedValue({ config_value: '{"videoRetentionHours":"forever"}' });
    expect((await resolveTranscriptsSettings()).videoRetentionHours).toEqual({
      value: "forever",
      source: "database",
    });
  });

  it("a stored storeVideoLocally:false beats RECALL_STORE_VIDEO_LOCALLY=true", async () => {
    process.env.RECALL_STORE_VIDEO_LOCALLY = "true";
    first.mockResolvedValue({ config_value: '{"storeVideoLocally":false}' });
    expect((await resolveTranscriptsSettings()).storeVideoLocally).toEqual({
      value: false,
      source: "database",
    });
  });

  it('carries the "none" cap sentinel over an env cap', async () => {
    process.env.TOTAL_MAX_RECORDINGS_DURATION_PER_MONTH = "1500";
    first.mockResolvedValue({ config_value: '{"monthlyRecordingLimitMinutes":"none"}' });
    expect((await resolveTranscriptsSettings()).monthlyRecordingLimitMinutes).toEqual({
      value: "none",
      source: "database",
    });
  });
});

describe("saveTranscriptsSettings", () => {
  it("merges a patch into the existing object rather than replacing it", async () => {
    // Saving one section must not clobber another section's values.
    first.mockResolvedValue({ config_value: '{"botName":"Acme","notifyChat":true}' });
    await saveTranscriptsSettings({ notifyChat: false });
    const written = JSON.parse(merge.mock.calls[0][0].config_value);
    expect(written).toEqual({ botName: "Acme", notifyChat: false });
  });

  it("an explicit null clears one field and leaves the rest", async () => {
    first.mockResolvedValue({ config_value: '{"botName":"Acme","notifyChat":true}' });
    await saveTranscriptsSettings({ botName: null });
    const written = JSON.parse(merge.mock.calls[0][0].config_value);
    expect(written).toEqual({ botName: null, notifyChat: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/transcripts-settings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/exulu/transcripts-settings.ts`. Read `src/exulu/embedder-settings.ts` first — this is the same shape with a bigger payload, and the json-column tolerance and failure-tolerant reads are copied from it deliberately.

```ts
/**
 * Workspace-level Transcripts settings: one platform_configurations row
 * holding the whole object, each field resolving stored -> env -> code.
 *
 * One row rather than nine keys because these values are edited together on
 * one page and read together on every composer open: one atomic save, one
 * query, no half-applied state.
 *
 * Reads are failure-tolerant on purpose — they sit on the composer-open and
 * bot-dispatch paths, where a database hiccup must degrade to the env/code
 * value rather than stop a bot joining a meeting.
 *
 * Design doc: docs/superpowers/specs/2026-09-30-transcripts-settings-design.md §1, §3
 */
import { postgresClient } from "@SRC/postgres/client";
import {
  recallRecordingRetentionHours,
  recallStoreVideoLocally,
  recordingMonthlyLimitSeconds,
  RECALL_RECORDING_RETENTION_DEFAULT_HOURS,
} from "./recall/env";
import { resolveSetting, type ResolvedSetting } from "./platform-setting";

export const TRANSCRIPTS_SETTINGS_KEY = "transcripts_settings";

/** Replaces the old "Company Notetaker"; the product is never named in UI copy. */
export const DEFAULT_BOT_NAME = "IMP Notetaker";

export type SummaryPreset = { prompt_id: string; agent_id: string };

export type TranscriptsSettings = {
  botName: string | null;
  notifyChat: boolean | null;
  recordersMayOverrideBot: boolean | null;
  defaultRightsMode: string | null;
  summaryPresets: SummaryPreset[] | null;
  /** "forever" is a deliberate choice; null means "not set here". */
  videoRetentionHours: number | "forever" | null;
  storeVideoLocally: boolean | null;
  /** "none" is a deliberate choice; null means "not set here". */
  monthlyRecordingLimitMinutes: number | "none" | null;
  videoStorageCostPerHour: number | null;
};

export type ResolvedTranscriptsSettings = {
  [K in keyof TranscriptsSettings]: ResolvedSetting<NonNullable<TranscriptsSettings[K]>>;
};

const EMPTY: TranscriptsSettings = {
  botName: null,
  notifyChat: null,
  recordersMayOverrideBot: null,
  defaultRightsMode: null,
  summaryPresets: null,
  videoRetentionHours: null,
  storeVideoLocally: null,
  monthlyRecordingLimitMinutes: null,
  videoStorageCostPerHour: null,
};

export const getTranscriptsSettings = async (): Promise<TranscriptsSettings> => {
  try {
    const { db } = await postgresClient();
    const row = await db
      .from("platform_configurations")
      .where({ config_key: TRANSCRIPTS_SETTINGS_KEY })
      .first();
    if (!row?.config_value) return { ...EMPTY };
    // config_value is a `json` column: pg may return it parsed or as raw text.
    const raw = row.config_value;
    let value: unknown = raw;
    if (typeof raw === "string") {
      try {
        value = JSON.parse(raw);
      } catch {
        return { ...EMPTY };
      }
    }
    if (!value || typeof value !== "object") return { ...EMPTY };
    return { ...EMPTY, ...(value as Partial<TranscriptsSettings>) };
  } catch (err) {
    console.warn(
      "[EXULU] Could not read the Transcripts settings:",
      (err as Error).message,
    );
    return { ...EMPTY };
  }
};

export const saveTranscriptsSettings = async (
  patch: Partial<TranscriptsSettings>,
): Promise<void> => {
  const { db } = await postgresClient();
  const current = await getTranscriptsSettings();
  // Spread the patch over the current object so one section's save cannot
  // clobber another's. An explicit null in the patch clears that field.
  const next = { ...current, ...patch };
  const value = JSON.stringify(next);
  await db
    .from("platform_configurations")
    .insert({
      config_key: TRANSCRIPTS_SETTINGS_KEY,
      config_value: value,
      description: "Workspace defaults for the Transcripts feature",
    })
    .onConflict("config_key")
    .merge({ config_value: value });
};

export const resolveTranscriptsSettings =
  async (): Promise<ResolvedTranscriptsSettings> => {
    const stored = await getTranscriptsSettings();
    const capSeconds = recordingMonthlyLimitSeconds();

    return {
      botName: resolveSetting(stored.botName, null, DEFAULT_BOT_NAME),
      notifyChat: resolveSetting(stored.notifyChat, null, true),
      recordersMayOverrideBot: resolveSetting(stored.recordersMayOverrideBot, null, true),
      defaultRightsMode: resolveSetting(stored.defaultRightsMode, null, "private"),
      summaryPresets: resolveSetting<SummaryPreset[]>(stored.summaryPresets, null, []),
      videoRetentionHours: resolveSetting<number | "forever">(
        stored.videoRetentionHours,
        process.env.RECALL_RECORDING_RETENTION_HOURS
          ? recallRecordingRetentionHours()
          : null,
        RECALL_RECORDING_RETENTION_DEFAULT_HOURS,
      ),
      storeVideoLocally: resolveSetting(
        stored.storeVideoLocally,
        process.env.RECALL_STORE_VIDEO_LOCALLY !== undefined
          ? recallStoreVideoLocally()
          : null,
        false,
      ),
      monthlyRecordingLimitMinutes: resolveSetting<number | "none">(
        stored.monthlyRecordingLimitMinutes,
        capSeconds !== null ? capSeconds / 60 : null,
        "none",
      ),
      videoStorageCostPerHour: resolveSetting(stored.videoStorageCostPerHour, null, 0),
    };
  };
```

Note the env layer passes `null` when the variable is **unset**, rather than calling the reader unconditionally — the readers already apply their own code defaults, and passing those through would make every value report `source: "env"` even when no variable exists.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/exulu/transcripts-settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the deleted-preset guard**

A preset can reference a prompt or agent deleted after it was saved. Add to `transcripts-settings.ts`:

```ts
/**
 * Drop presets whose prompt or agent no longer exists. Prompts and agents are
 * deleted independently of this page, so a stale preset is expected, not
 * exceptional — the composer must still open and the settings page must show
 * what survived rather than failing.
 */
export const filterLivePresets = (
  presets: SummaryPreset[],
  livePromptIds: Set<string>,
  liveAgentIds: Set<string>,
): { live: SummaryPreset[]; stale: SummaryPreset[] } => {
  const live: SummaryPreset[] = [];
  const stale: SummaryPreset[] = [];
  for (const preset of presets) {
    if (livePromptIds.has(preset.prompt_id) && liveAgentIds.has(preset.agent_id)) {
      live.push(preset);
    } else {
      stale.push(preset);
    }
  }
  return { live, stale };
};
```

and its tests:

```ts
import { filterLivePresets } from "./transcripts-settings";

describe("filterLivePresets", () => {
  const prompts = new Set(["p1"]);
  const agents = new Set(["a1"]);

  it("keeps a preset whose prompt and agent both exist", () => {
    const { live, stale } = filterLivePresets([{ prompt_id: "p1", agent_id: "a1" }], prompts, agents);
    expect(live).toHaveLength(1);
    expect(stale).toHaveLength(0);
  });

  it("drops a preset whose prompt was deleted", () => {
    const { live, stale } = filterLivePresets([{ prompt_id: "gone", agent_id: "a1" }], prompts, agents);
    expect(live).toHaveLength(0);
    expect(stale).toEqual([{ prompt_id: "gone", agent_id: "a1" }]);
  });

  it("drops a preset whose agent was deleted", () => {
    const { live, stale } = filterLivePresets([{ prompt_id: "p1", agent_id: "gone" }], prompts, agents);
    expect(live).toHaveLength(0);
    expect(stale).toHaveLength(1);
  });

  it("returns both lists for a mixed set", () => {
    const { live, stale } = filterLivePresets(
      [{ prompt_id: "p1", agent_id: "a1" }, { prompt_id: "gone", agent_id: "a1" }],
      prompts,
      agents,
    );
    expect(live).toHaveLength(1);
    expect(stale).toHaveLength(1);
  });

  it("handles an empty preset list", () => {
    expect(filterLivePresets([], prompts, agents)).toEqual({ live: [], stale: [] });
  });
});
```

- [ ] **Step 6: Run and commit**

Run: `npx jest src/exulu/transcripts-settings.test.ts` then `npx tsc --noEmit 2>&1 | grep -c "error TS"` — expect 8.

```bash
git add src/exulu/transcripts-settings.ts src/exulu/transcripts-settings.test.ts
git commit -m "feat(transcripts): workspace settings store with stored/env/code resolution

One platform_configurations row for the whole settings object: atomic saves,
one read per composer open. Reads degrade to env/code on failure because they
sit on the bot-dispatch path. Stale presets are filtered rather than fatal,
since prompts and agents are deleted independently of this page.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Apply the settings to the meeting-bot path

**Files:**
- Create: `src/exulu/recall/bot-identity.ts`
- Create: `src/exulu/recall/bot-identity.test.ts`
- Modify: `src/exulu/recall/service.ts` (the `DEFAULT_BOT_NAME` constant at `:39`, and `bot_name` / `notifyChat` at `:228-229`)
- Modify: `src/exulu/recall/video-storage.ts` and wherever `recallStoreVideoLocally()` / `recallRecordingRetentionHours()` are called — find with `grep -rn "recallStoreVideoLocally\|recallRecordingRetentionHours" src --include=*.ts | grep -v env.ts`
- Test: `src/exulu/recall/service.test.ts`

**Interfaces:**
- Consumes: `resolveTranscriptsSettings`, `DEFAULT_BOT_NAME` (Task 2).
- Produces:

```ts
// src/exulu/recall/bot-identity.ts
export function resolveBotIdentity(
  request: { bot_name?: string | null; notify_chat?: boolean | null },
  workspace: { botName: string; notifyChat: boolean; recordersMayOverrideBot: boolean },
): { botName: string; notifyChat: boolean };
```

- [ ] **Step 1: Write the failing tests**

The precedence itself is pure, so extract it rather than fighting the Recall suite's mocks. Create `src/exulu/recall/bot-identity.test.ts`:

```ts
import { resolveBotIdentity } from "./bot-identity";

const settings = (over: Partial<Parameters<typeof resolveBotIdentity>[1]> = {}) => ({
  botName: "IMP Notetaker",
  notifyChat: true,
  recordersMayOverrideBot: true,
  ...over,
});

describe("resolveBotIdentity", () => {
  it("uses the workspace values when the request supplies none", () => {
    expect(resolveBotIdentity({}, settings())).toEqual({
      botName: "IMP Notetaker",
      notifyChat: true,
    });
  });

  it("a per-request name wins when recorders may override", () => {
    expect(resolveBotIdentity({ bot_name: "Standup bot" }, settings()).botName).toBe("Standup bot");
  });

  it("a per-request name is IGNORED when recorders may not override", () => {
    // Otherwise the setting would be advisory only, which is not a setting.
    expect(
      resolveBotIdentity({ bot_name: "Standup bot" }, settings({ recordersMayOverrideBot: false }))
        .botName,
    ).toBe("IMP Notetaker");
  });

  it("a per-request notify:false wins when recorders may override", () => {
    expect(resolveBotIdentity({ notify_chat: false }, settings()).notifyChat).toBe(false);
  });

  it("a per-request notify:false is IGNORED when they may not", () => {
    expect(
      resolveBotIdentity({ notify_chat: false }, settings({ recordersMayOverrideBot: false }))
        .notifyChat,
    ).toBe(true);
  });

  it("treats a blank or whitespace request name as absent", () => {
    expect(resolveBotIdentity({ bot_name: "   " }, settings()).botName).toBe("IMP Notetaker");
  });

  it("never emits the retired default", () => {
    expect(resolveBotIdentity({}, settings()).botName).not.toBe("Company Notetaker");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/exulu/recall/bot-identity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/exulu/recall/bot-identity.ts`:

```ts
/**
 * Which bot name and recording-notice a dispatch actually uses.
 *
 * Pure so the precedence is testable without the Recall suite's mocks. When
 * recordersMayOverrideBot is false the workspace value wins even if the caller
 * supplied one — otherwise the setting would be advisory only, which is not a
 * setting.
 */
export function resolveBotIdentity(
  request: { bot_name?: string | null; notify_chat?: boolean | null },
  workspace: { botName: string; notifyChat: boolean; recordersMayOverrideBot: boolean },
): { botName: string; notifyChat: boolean } {
  if (!workspace.recordersMayOverrideBot) {
    return { botName: workspace.botName, notifyChat: workspace.notifyChat };
  }
  return {
    botName: request.bot_name?.trim() || workspace.botName,
    notifyChat: request.notify_chat ?? workspace.notifyChat,
  };
}
```

Then in `src/exulu/recall/service.ts`:
- Delete the local `const DEFAULT_BOT_NAME = "Company Notetaker";` at `:39`; the default now lives in `../transcripts-settings`.
- In the bot-start path, resolve settings once and call the helper:

```ts
  const settings = await resolveTranscriptsSettings();
  const { botName, notifyChat } = resolveBotIdentity(input, {
    botName: settings.botName.value,
    notifyChat: settings.notifyChat.value,
    recordersMayOverrideBot: settings.recordersMayOverrideBot.value,
  });
```

Replace the existing `bot_name:` and `notifyChat:` expressions at `:228-229` with `botName` and `notifyChat`.

- For retention and local storage, replace direct `recallRecordingRetentionHours()` / `recallStoreVideoLocally()` calls **outside `env.ts`** with the resolved values. Leave `env.ts` itself untouched — it is now the env layer, and its signatures must keep working for any caller this plan does not reach.

- [ ] **Step 4: Run and commit**

Run: `npx jest src/exulu/recall/` and `npx tsc --noEmit 2>&1 | grep -c "error TS"` — expect 8.

```bash
git add src/exulu/recall/bot-identity.ts src/exulu/recall/bot-identity.test.ts src/exulu/recall/service.ts
git commit -m "feat(transcripts): meeting bot reads workspace settings

Bot name, recording notice, retention and local video storage now resolve
through the workspace settings, with the env var as the middle layer. The
default name becomes IMP Notetaker. When recorders may not override, the
workspace value wins over a per-request one — otherwise the setting would be
advisory only.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Summaries for uploads

**Files:**
- Modify: `src/graphql/schemas/index.ts` (the `input TranscriptionJobStartInput` block — find with `grep -n "input TranscriptionJobStartInput" src/graphql/schemas/index.ts`; and the `transcriptionJobStart` resolver below it)
- Modify: `src/exulu/transcription/service.ts` (`StartJobInput` at `:45-57`, the insert at `:148`, and `_applyJobUpdate`'s completed branch at `:259-266`)
- Test: `src/exulu/transcription/service.test.ts` — **create it if absent**; check with `ls src/exulu/transcription/service.test.ts`

**Interfaces:**
- Consumes: `recallService.runPostProcessing(jobId)` from `src/exulu/recall/service.ts`.
- Produces: `StartJobInput.post_processing_prompts?: { prompt_id: string; agent_id: string }[]`, and the GraphQL input field of the same name.

- [ ] **Step 1: Write the failing tests**

The hook point is `_applyJobUpdate`, which the polling loop calls on **every tick** for every transcribing row. Firing on the wrong status, or twice, double-spends LLM calls. Test that directly — extract the decision as a pure predicate if the surrounding code is hard to mock, and say so in your report:

```ts
import { shouldRunUploadPostProcessing } from "./service";

describe("shouldRunUploadPostProcessing", () => {
  const prompts = [{ prompt_id: "p", agent_id: "a" }];

  it("runs when a job with prompts completes", () => {
    expect(shouldRunUploadPostProcessing("completed", prompts, null)).toBe(true);
  });

  it("does NOT run while the job is still running", () => {
    expect(shouldRunUploadPostProcessing("running", prompts, null)).toBe(false);
  });

  it("does NOT run on a queued job", () => {
    expect(shouldRunUploadPostProcessing("queued", prompts, null)).toBe(false);
  });

  it("does NOT run on failure", () => {
    expect(shouldRunUploadPostProcessing("failed", prompts, null)).toBe(false);
  });

  it("does NOT run on cancellation", () => {
    expect(shouldRunUploadPostProcessing("cancelled", prompts, null)).toBe(false);
  });

  it("does NOT run when the job has no prompts", () => {
    expect(shouldRunUploadPostProcessing("completed", [], null)).toBe(false);
    expect(shouldRunUploadPostProcessing("completed", null, null)).toBe(false);
  });

  it("does NOT run again when outputs already exist", () => {
    // The poll loop re-reads rows; a completed job whose run already happened
    // must not pay for a second one.
    expect(
      shouldRunUploadPostProcessing("completed", prompts, [
        { prompt_id: "p", agent_id: "a", prompt_name: null, status: "done", output: "x", error: null, ran_at: "t" },
      ]),
    ).toBe(false);
  });
});
```

Also add a `buildTranscriptItemInput`-style test asserting `startJob` persists the prompts — or, if `startJob` needs a live db, assert the insert payload through the same mocking style the file already uses.

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/exulu/transcription/service.test.ts`
Expected: FAIL — `shouldRunUploadPostProcessing is not a function`.

- [ ] **Step 3: Implement the predicate and the hook**

In `src/exulu/transcription/service.ts`, export the predicate:

```ts
/**
 * Whether a whisper job that just reported `status` should have its
 * post-processing run.
 *
 * pollOnce calls _applyJobUpdate on every tick for every transcribing row, so
 * this must be false for every status but `completed`, and false once outputs
 * exist — otherwise each tick pays for another set of LLM calls.
 */
export const shouldRunUploadPostProcessing = (
  whisperStatus: string,
  prompts: { prompt_id: string; agent_id: string }[] | null | undefined,
  existingOutputs: unknown[] | null | undefined,
): boolean =>
  whisperStatus === "completed" &&
  Array.isArray(prompts) &&
  prompts.length > 0 &&
  (existingOutputs === null || existingOutputs === undefined || existingOutputs.length === 0);
```

Then in `_applyJobUpdate`'s completed branch, **after** the row is updated to `awaiting_review`:

```ts
      if (
        shouldRunUploadPostProcessing(
          job.status,
          row.post_processing_prompts as { prompt_id: string; agent_id: string }[] | null,
          row.post_processing_outputs,
        )
      ) {
        // Same fire-and-forget shape as live-recording.ts:181 — a failing
        // summary must never stop the transcript becoming reviewable.
        void recallService.runPostProcessing(row.id).catch((err: unknown) => {
          log(`post-processing for upload ${row.id} failed: ${(err as Error).message}`);
        });
      }
```

Add `post_processing_prompts` to `JobRow` and to `_rowFromDb`'s `parseJsonField` list, mirroring `post_processing_outputs`.

- [ ] **Step 4: Accept the prompts on the way in**

Add to `StartJobInput`:

```ts
  post_processing_prompts?: { prompt_id: string; agent_id: string }[];
```

persist it in `startJob`'s insert (alongside `target_rbac_users`, same `JSON.stringify(...) : null` shape), add the field to the SDL:

```graphql
      post_processing_prompts: [PostProcessingPromptInput!]
```

and forward it in the resolver:

```ts
      post_processing_prompts: args.input.post_processing_prompts ?? undefined,
```

`PostProcessingPromptInput` already exists — it is the type the meeting and live-recording mutations use. Do not declare a second one.

- [ ] **Step 5: Run and commit**

Run: `npx jest src/exulu/transcription/` then the full `npx jest` — expect the 3 pre-existing failed suites, nothing new.

```bash
git add src/exulu/transcription/service.ts src/exulu/transcription/service.test.ts src/graphql/schemas/index.ts
git commit -m "feat(transcripts): run post-processing for uploaded files

Uploads could never produce a summary: transcriptionJobStart took no prompts
and the polling loop never called the runner, while meetings and live
recordings both did. Reuses runPostProcessing verbatim, gated by a predicate
that fires only on completion, only with prompts, and only once — the poll
loop re-reads every row on every tick.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: GraphQL surface and the source Test actions

**Files:**
- Modify: `src/graphql/schemas/index.ts` (type + query + mutation defs, beside the other global ones such as `litellmCatalog` — **register once, not per context table**)
- Modify: `src/graphql/mutations/index.ts`
- Create: `src/exulu/transcription/source-test.ts`
- Create: `src/exulu/transcription/source-test.test.ts`
- Modify: `src/exulu/routes.ts`

**Interfaces:**
- Consumes: `resolveTranscriptsSettings`, `saveTranscriptsSettings`, `filterLivePresets` (Task 2).
- Produces — Task 6 consumes:
  - query `transcriptsSettings: TranscriptsSettingsInfo!`
  - mutation `setTranscriptsSettings(input: TranscriptsSettingsInput!): TranscriptsSettingsInfo!`
  - `GET /transcription-sources/:source/test` where `:source` is `upload | meeting | record`

Each resolved field is exposed as `{ value, source }` so the UI can show where it came from. `TranscriptsSettingsInfo` additionally carries `stalePresets: [SummaryPreset!]!`.

- [ ] **Step 1: Write the failing tests for the source test helper**

Create `src/exulu/transcription/source-test.test.ts`:

```ts
import { testSource, type SourceTestDeps } from "./source-test";

const deps = (over: Partial<SourceTestDeps> = {}): SourceTestDeps => ({
  whisperConfigured: () => true,
  pingWhisper: async () => {},
  recallConfigured: () => true,
  pingRecall: async () => {},
  recordModelConfigured: () => true,
  pingRecordModel: async () => {},
  ...over,
});

describe("testSource", () => {
  it("reports not-configured without pinging", async () => {
    const pingWhisper = jest.fn(async () => {});
    const result = await testSource("upload", deps({ whisperConfigured: () => false, pingWhisper }));
    expect(result).toEqual({ ok: false, reason: "not_configured" });
    expect(pingWhisper).not.toHaveBeenCalled();
  });

  it("reports ok when the service answers", async () => {
    expect(await testSource("upload", deps())).toEqual({ ok: true });
  });

  it("surfaces the service's own message on failure", async () => {
    // The whole value of the button is the real error, not a generic one.
    const result = await testSource(
      "meeting",
      deps({
        pingRecall: async () => {
          throw new Error("401 Unauthorized: bad RECALL_API_KEY");
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "unreachable", message: "401 Unauthorized: bad RECALL_API_KEY" });
  });

  it("rejects an unknown source rather than guessing", async () => {
    await expect(testSource("nonsense" as never, deps())).rejects.toThrow(/unknown source/i);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/exulu/transcription/source-test.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `src/exulu/transcription/source-test.ts`:

```ts
/**
 * Liveness check for one transcription source, for the Sources section of the
 * Transcripts settings page.
 *
 * Deliberately a reachability check, not a round-trip: it answers "is this
 * configured and responding", which is what an admin looking at a red dot
 * needs. Built from injected deps so the branching is testable without the
 * three real services.
 *
 * Design doc: docs/superpowers/specs/2026-09-30-transcripts-settings-design.md §5
 */
export type TranscriptionSource = "upload" | "meeting" | "record";

export type SourceTestResult =
  | { ok: true }
  | { ok: false; reason: "not_configured" }
  | { ok: false; reason: "unreachable"; message: string };

export type SourceTestDeps = {
  whisperConfigured: () => boolean;
  pingWhisper: () => Promise<void>;
  recallConfigured: () => boolean;
  pingRecall: () => Promise<void>;
  recordModelConfigured: () => boolean;
  pingRecordModel: () => Promise<void>;
};

export async function testSource(
  source: TranscriptionSource,
  deps: SourceTestDeps,
): Promise<SourceTestResult> {
  const table: Record<TranscriptionSource, { configured: () => boolean; ping: () => Promise<void> }> = {
    upload: { configured: deps.whisperConfigured, ping: deps.pingWhisper },
    meeting: { configured: deps.recallConfigured, ping: deps.pingRecall },
    record: { configured: deps.recordModelConfigured, ping: deps.pingRecordModel },
  };
  const entry = table[source];
  if (!entry) throw new Error(`Unknown source "${source}".`);
  if (!entry.configured()) return { ok: false, reason: "not_configured" };
  try {
    await entry.ping();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "unreachable", message: (err as Error).message };
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx jest src/exulu/transcription/source-test.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the SDL**

In `src/graphql/schemas/index.ts`, beside the other **global** definitions (where `litellmCatalog` and `availableEmbeddingModels` live — *not* inside the per-table loop):

```graphql
    type ResolvedStringSetting { value: String, source: String! }
    type ResolvedBoolSetting { value: Boolean, source: String! }
    type ResolvedFloatSetting { value: Float, source: String! }
    type SummaryPreset { prompt_id: ID!, agent_id: ID! }
    type ResolvedPresetSetting { value: [SummaryPreset!]!, source: String! }

    type TranscriptsSettingsInfo {
      botName: ResolvedStringSetting!
      notifyChat: ResolvedBoolSetting!
      recordersMayOverrideBot: ResolvedBoolSetting!
      defaultRightsMode: ResolvedStringSetting!
      summaryPresets: ResolvedPresetSetting!
      videoRetentionHours: ResolvedStringSetting!
      storeVideoLocally: ResolvedBoolSetting!
      monthlyRecordingLimitMinutes: ResolvedStringSetting!
      videoStorageCostPerHour: ResolvedFloatSetting!
      stalePresets: [SummaryPreset!]!
    }

    input SummaryPresetInput { prompt_id: ID!, agent_id: ID! }
    input TranscriptsSettingsInput {
      botName: String
      notifyChat: Boolean
      recordersMayOverrideBot: Boolean
      defaultRightsMode: String
      summaryPresets: [SummaryPresetInput!]
      videoRetentionHours: String
      storeVideoLocally: Boolean
      monthlyRecordingLimitMinutes: String
      videoStorageCostPerHour: Float
    }
```

`videoRetentionHours` and `monthlyRecordingLimitMinutes` cross the wire as **strings** because each is a number *or* a sentinel (`"forever"`, `"none"`). The resolver parses a numeric string back to a number before storing; anything else is kept verbatim and validated against the allowed sentinel. A union scalar would be cleaner and is not worth it for two fields.

Plus the query and mutation:

```graphql
   transcriptsSettings: TranscriptsSettingsInfo!
```
```
    setTranscriptsSettings(input: TranscriptsSettingsInput!): TranscriptsSettingsInfo!
```

- [ ] **Step 6: Implement the resolvers**

The query resolves settings, loads live prompt and agent ids, and runs `filterLivePresets` so `summaryPresets` carries only live ones and `stalePresets` carries the rest.

The mutation, in `src/graphql/mutations/index.ts`, gated exactly like the destructive mutations at `:909`/`:951`:

```ts
    mutations["setTranscriptsSettings"] = async (_, args, context) => {
      if (!context.user) {
        throw new Error("Authentication required to change the Transcripts settings.");
      }
      if (!context.user.super_admin) {
        throw new Error("Only a super admin can change the Transcripts settings.");
      }
      await saveTranscriptsSettings(parseSettingsInput(args.input));
      return buildTranscriptsSettingsInfo();
    };
```

Write `parseSettingsInput` to turn the two string fields back into `number | "forever" | null` and `number | "none" | null`, rejecting anything that is neither numeric nor the allowed sentinel with a message naming the field and the accepted values. Export it so it is testable.

Create `src/graphql/mutations/transcripts-settings-input.test.ts` covering the parsing **and the gate**, since the page is reachable from a menu every user sees and the UI check is not the protection:

```ts
import { parseSettingsInput } from "./transcripts-settings-input";

describe("parseSettingsInput", () => {
  it("parses a numeric retention string to a number", () => {
    expect(parseSettingsInput({ videoRetentionHours: "720" }).videoRetentionHours).toBe(720);
  });

  it('keeps the "forever" sentinel verbatim', () => {
    expect(parseSettingsInput({ videoRetentionHours: "forever" }).videoRetentionHours).toBe("forever");
  });

  it('keeps the "none" cap sentinel verbatim', () => {
    expect(parseSettingsInput({ monthlyRecordingLimitMinutes: "none" }).monthlyRecordingLimitMinutes).toBe("none");
  });

  it("passes null through as a clear", () => {
    expect(parseSettingsInput({ videoRetentionHours: null }).videoRetentionHours).toBeNull();
  });

  it("refuses a value that is neither numeric nor the sentinel", () => {
    // Storing garbage here would resolve to a nonsense retention silently.
    expect(() => parseSettingsInput({ videoRetentionHours: "soon" })).toThrow(/videoRetentionHours/);
  });

  it("refuses a negative retention", () => {
    expect(() => parseSettingsInput({ videoRetentionHours: "-5" })).toThrow(/videoRetentionHours/);
  });

  it("leaves untouched fields absent rather than nulling them", () => {
    // A section saving only its own fields must not clear the others.
    expect("botName" in parseSettingsInput({ notifyChat: false })).toBe(false);
  });
});
```

Then add a gate test beside the mutation, in whatever style that file's existing mutation tests use (`grep -rn "super_admin" src/graphql/mutations/*.test.ts` to find one to copy):

```ts
describe("setTranscriptsSettings authorisation", () => {
  it("rejects an unauthenticated caller", async () => {
    await expect(callSetTranscriptsSettings({ user: null }, {})).rejects.toThrow(/Authentication/i);
  });

  it("rejects an authenticated NON-super-admin", async () => {
    // Review Focus #5: the settings link sits in a menu every user sees, so
    // the UI check is not the protection — this one is.
    await expect(
      callSetTranscriptsSettings({ user: { id: 7, super_admin: false } }, {}),
    ).rejects.toThrow(/super admin/i);
  });

  it("allows a super admin", async () => {
    await expect(
      callSetTranscriptsSettings({ user: { id: 1, super_admin: true } }, { notifyChat: false }),
    ).resolves.toBeTruthy();
  });
});
```

If the mutations file has no test harness that can call a resolver directly, extract the gate into a tiny exported `assertMaySetTranscriptsSettings(user)` and test that instead — say which you did in your report. Do not skip the gate test.

- [ ] **Step 7: Mount the test route**

In `src/exulu/routes.ts`, add `GET /transcription-sources/:source/test`, authenticated and `super_admin`-gated like the mutation, wiring `testSource`'s deps to the real clients: `transcriptionClient.isConfigured()` and a lightweight call for whisper, `recallEnabled()` and a cheap authenticated GET for Recall, and the LiteLLM catalogue lookup for the record model.

- [ ] **Step 8: Run and commit**

Run: `npx jest`, `npx tsc --noEmit 2>&1 | grep -c "error TS"` — expect 8.

```bash
git add src/exulu/transcription/source-test.ts src/exulu/transcription/source-test.test.ts \
        src/graphql/schemas/index.ts src/graphql/mutations/index.ts src/exulu/routes.ts
git commit -m "feat(transcripts): settings query, mutation and source liveness checks

Each field crosses the wire as {value, source} so the page can say where a
value came from. The mutation is super_admin-gated server-side, since the
page is reachable from a menu every user sees. Retention and the cap travel
as strings because each is a number or a sentinel.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Frontend data layer

**Files (frontend worktree — create it in Step 1):**
- Modify: `app/(application)/transcriptions/queries.ts`
- Modify: `app/(application)/transcriptions/hooks.ts`

**Interfaces:**
- Consumes: the operations from Task 5.
- Produces: `GET_TRANSCRIPTS_SETTINGS`, `SET_TRANSCRIPTS_SETTINGS`, and `useTranscriptsSettings()` returning `{ settings, stalePresets, loading, error, save, testSource }`.

- [ ] **Step 1: Create the frontend worktree**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend
git worktree add -b feat/transcripts-settings ../frontend-transcripts-settings main
cp -al node_modules ../frontend-transcripts-settings/node_modules
```

`cp -al` hard-links; a symlinked `node_modules` breaks Turbopack's build. Verify with `ls ../frontend-transcripts-settings/node_modules | wc -l` (expect >1000).

**Measure the frontend baseline before changing anything**: `npx vitest run`, `npx eslint .`. Record both numbers — later tasks and the final review compare against them.

- [ ] **Step 2: Add the operations and hook**

These are **global** operations, not per-context factories, so write them as plain `gql` constants rather than functions taking a context id. Follow the fetch-policy and error-surfacing style of `useTranscripts` in the same file.

`save(patch)` sends only the fields the edited section owns and refetches on success. `testSource(source)` calls `GET {backend}/transcription-sources/{source}/test` with an `Authorization: Bearer ${await getToken()}` header — **not** a bare navigation; that route is header-authenticated, exactly like the transcript export route.

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run`, `npx eslint .`, `npx tsc --noEmit` — all at the baseline you recorded.

```bash
git add "app/(application)/transcriptions/queries.ts" "app/(application)/transcriptions/hooks.ts"
git commit -m "feat(transcripts): data layer for the workspace settings page

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The settings page and preset seeding

**Files (frontend worktree):**
- Create: `app/(application)/transcriptions/settings/page.tsx`
- Create: `app/(application)/transcriptions/settings/section-summary.ts`
- Create: `app/(application)/transcriptions/settings/section-summary.test.ts`
- Modify: `app/(application)/transcriptions/components/new-transcript-dialog.tsx` (seed presets)
- Modify: `app/(application)/transcriptions/components/transcript-document.tsx` (the "…" menu gains the settings link for super admins)
- Modify: `messages/en.json`, `messages/de.json`

**Interfaces:**
- Consumes: `useTranscriptsSettings` (Task 6).
- Produces: `summariseSection(...)` — a pure function per section returning its one-line summary and whether it needs attention.

- [ ] **Step 1: Write the failing tests for the section summaries**

The summary line is what an admin reads before deciding whether to open a section, so it is a pure function with its own test. Create `section-summary.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { summariseSources, summariseMeetingBot, summariseDefaults } from "./section-summary";

describe("summariseSources", () => {
  it("counts configured sources and names what is missing", () => {
    const s = summariseSources({ upload: true, meeting: true, record: false, embedderConfigured: true });
    expect(s.text).toContain("2 of 3");
    expect(s.needsAttention).toBe(true);
  });

  it("flags a missing embedder even when all three sources are up", () => {
    // Without an embedder nothing is searchable, so this must not read as fine.
    const s = summariseSources({ upload: true, meeting: true, record: true, embedderConfigured: false });
    expect(s.needsAttention).toBe(true);
  });

  it("is calm when everything is configured", () => {
    const s = summariseSources({ upload: true, meeting: true, record: true, embedderConfigured: true });
    expect(s.needsAttention).toBe(false);
  });
});

describe("summariseMeetingBot", () => {
  it("names the bot and whether recorders may override", () => {
    const s = summariseMeetingBot({ botName: "IMP Notetaker", notifyChat: true, mayOverride: false });
    expect(s.text).toContain("IMP Notetaker");
    expect(s.text.toLowerCase()).toContain("announce");
  });
});

describe("summariseDefaults", () => {
  it("reports no presets plainly rather than as an error", () => {
    const s = summariseDefaults({ defaultRightsMode: "private", presetCount: 0, stalePresetCount: 0 });
    expect(s.needsAttention).toBe(false);
  });

  it("flags stale presets for attention", () => {
    const s = summariseDefaults({ defaultRightsMode: "private", presetCount: 1, stalePresetCount: 1 });
    expect(s.needsAttention).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail, then implement the summaries**

Run: `npx vitest run "app/(application)/transcriptions/settings/section-summary.test.ts"` — expect module-not-found, then write the three pure functions to satisfy them.

- [ ] **Step 3: Build the page**

`/transcriptions/settings`, `PageShell variant="content"`, `PageHeader` with an "Admins only" badge and a breadcrumb back to Transcripts. Five `Collapsible` sections, one open at a time, each showing its `summariseX` line; the first section whose `needsAttention` is true starts open.

Non-super-admins see a plain "Ask an admin" state, not a 404 — the link is in a menu every user sees. Each field shows its `source` quietly when it is `"env"` or `"code"`, so an admin can tell what they are overriding. Clearing a field sends `null`.

The Sources section renders the promoted `StageEmbedder` widget against the `transcriptions` context, plus a **Test** button per source calling `testSource`, showing the service's own message on failure.

- [ ] **Step 4: Seed the composer's presets**

In `new-transcript-dialog.tsx`, pre-check the workspace `summaryPresets` in each composer's post-processing picker, leaving them removable for one recording. Read presets when the dialog opens, not at save time, so changing the workspace default never retroactively alters a transcript in flight.

- [ ] **Step 5: Add the menu entry**

The Transcripts header's "…" menu gains "Transcript settings", shown only to super admins.

- [ ] **Step 6: i18n**

Add every new key to BOTH locales. Run `node scripts/check-messages.js`, then — because parity does not prove a key the code calls exists — grep each new key and confirm its **fully-resolved** path (scope + key) is present in both files. A key under the wrong namespace passes parity every time.

- [ ] **Step 7: Verify and commit**

Run: `npx vitest run`, `npx eslint .`, `node scripts/check-messages.js`, `npx tsc --noEmit`, `npx next build` — all at baseline; the build must succeed. Then by hand: set a bot name and confirm a new bot uses it; clear it and confirm the source badge returns to env or code.

```bash
git add "app/(application)/transcriptions/settings" \
        "app/(application)/transcriptions/components/new-transcript-dialog.tsx" \
        "app/(application)/transcriptions/components/transcript-document.tsx" \
        messages/en.json messages/de.json
git commit -m "feat(transcripts): admin settings page and workspace preset seeding

Five sections over the workspace settings, each showing whether a value comes
from the database, an environment variable or the code default. Presets seed
every composer pre-checked and stay removable per recording.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Whole-branch verification

**Files:** none — this task runs things and reports.

- [ ] **Step 1: Backend**

In `../backend-transcripts-settings`: `npx tsc --noEmit`, `npm run lint`, `npx jest`. Compare against 8 tsc errors and 3 failed suites / 2 failed tests, allowing one structural lint error per new `.test.ts` file. Any other increase is a regression to fix before this task passes.

- [ ] **Step 2: Frontend**

In `../frontend-transcripts-settings`: `npx vitest run`, `npx eslint .`, `node scripts/check-messages.js`, `npx tsc --noEmit`, `npx next build`. Compare against the baseline recorded in Task 6 Step 1. If `tsc` reports errors inside `.next/`, delete `.next` and rebuild — those are stale generated types, not source.

- [ ] **Step 3: End-to-end by hand**

Deploy backend before frontend. Then:
1. Open `/transcriptions/settings` as a super admin; confirm each value shows its source. As a non-admin, confirm the "Ask an admin" state.
2. Set a bot name, dispatch a meeting bot, confirm the name is used. Clear it; confirm the badge returns to `env` or `code` and the next bot uses that value.
3. Turn **off** "recorders may override" and confirm a per-request bot name is ignored.
4. Set `storeVideoLocally` false with `RECALL_STORE_VIDEO_LOCALLY=true` in the environment, and confirm the stored `false` wins.
5. Choose "keep videos forever", reload, and confirm it did **not** revert to the env default.
6. Add a summary preset, upload an audio file, and confirm a summary appears in review — the gap this stage closes.
7. Delete the prompt behind a preset, reopen the composer, and confirm it still opens and the settings page marks the preset unavailable.
8. Press Test on each source, including one deliberately misconfigured, and confirm the real error text appears.

- [ ] **Step 4: Report**

Write the outcome — what passed, what failed, what was deferred — before requesting review.

## Notes for the executor

- **Two repos, one branch name.** Check `pwd` and `git branch --show-current` in the same command as any commit. Never commit from `../backend` or `../frontend`.
- **The backend is a library** (`@exulu/backend`) with no standalone server; backend changes are smoke-testable only through a consuming project — rebuild `dist` and restart it.
- **Do not add entries to `eslint.tier-exemptions.mjs`.** That list may only shrink. If something trips a tier rule, report it.
