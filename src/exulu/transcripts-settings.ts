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
import type { ExuluRightsMode } from "@EXULU_TYPES/rbac-rights-modes";

export const TRANSCRIPTS_SETTINGS_KEY = "transcripts_settings";

/** Replaces the old "Company Notetaker"; the product is never named in UI copy. */
export const DEFAULT_BOT_NAME = "IMP Notetaker";

export type SummaryPreset = { prompt_id: string; agent_id: string };

export type TranscriptsSettings = {
  botName: string | null;
  notifyChat: boolean | null;
  recordersMayOverrideBot: boolean | null;
  defaultRightsMode: ExuluRightsMode | null;
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

/**
 * Parse a platform_configurations row's config_value into the subset of
 * fields it actually holds — no EMPTY padding. Returns null when there is no
 * row, or its value is missing/unparseable/not an object.
 *
 * Kept separate from getTranscriptsSettings's full (EMPTY-padded) view
 * because saveTranscriptsSettings must merge a patch onto exactly what was
 * persisted, not onto a copy where every never-set field has already been
 * materialized as an explicit null — otherwise saving one field would write
 * every other field out as null too, rather than leaving them untouched.
 */
const parseStoredSettings = (
  row: { config_value?: unknown } | undefined,
): Partial<TranscriptsSettings> | null => {
  if (!row?.config_value) return null;
  // config_value is a `json` column: pg may return it parsed or as raw text.
  const raw = row.config_value;
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  return value as Partial<TranscriptsSettings>;
};

export const getTranscriptsSettings = async (): Promise<TranscriptsSettings> => {
  try {
    const { db } = await postgresClient();
    const row = await db
      .from("platform_configurations")
      .where({ config_key: TRANSCRIPTS_SETTINGS_KEY })
      .first();
    return { ...EMPTY, ...(parseStoredSettings(row) ?? {}) };
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
  const row = await db
    .from("platform_configurations")
    .where({ config_key: TRANSCRIPTS_SETTINGS_KEY })
    .first();
  const current = parseStoredSettings(row) ?? {};
  // Spread the patch over exactly what was persisted so one section's save
  // cannot clobber another's, and untouched fields stay absent from the
  // stored JSON rather than being materialized as null. An explicit null in
  // the patch clears that field.
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
      // Mirrors what meetingBotStart's per-request default used to hardcode
      // (`notify_chat: args.input.notify_chat ?? false`, src/graphql/schemas/index.ts:2138,
      // now `?? null` so resolveBotIdentity can apply this value) so a deployment that never
      // opens this settings page keeps its existing (notifications-off) behavior untouched.
      notifyChat: resolveSetting(stored.notifyChat, null, false),
      recordersMayOverrideBot: resolveSetting(stored.recordersMayOverrideBot, null, true),
      defaultRightsMode: resolveSetting<ExuluRightsMode>(stored.defaultRightsMode, null, "private"),
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
