/**
 * Parse the GraphQL TranscriptsSettingsInput into the merge patch
 * saveTranscriptsSettings expects (Partial<TranscriptsSettings>).
 *
 * Only the two sentinel fields (videoRetentionHours, monthlyRecordingLimitMinutes)
 * need real parsing: they cross the wire as String because each is a number
 * or a sentinel ("forever" / "none"). Every other field passes through
 * unchanged.
 *
 * A field the client never mentions must stay OUT of the returned patch (a
 * section saving only its own fields must not clear the others), while a
 * field the client explicitly sets to null must come through as null (an
 * explicit clear back to the env/code fallback) — so this checks key
 * presence with `in`, never `?.` / default values, which would conflate
 * "omitted" with "null".
 *
 * Design doc: docs/superpowers/specs/2026-09-30-transcripts-settings-design.md §5
 */
import type { TranscriptsSettings } from "@SRC/exulu/transcripts-settings";

type RawInput = Record<string, unknown>;

/**
 * Parse a numeric-or-sentinel string field back into `number | sentinel | null`.
 * Throws naming the field and the accepted values for anything else, so a
 * typo'd value fails loudly instead of resolving to a nonsense retention.
 */
const parseNumericOrSentinel = (
  field: "videoRetentionHours" | "monthlyRecordingLimitMinutes",
  raw: string | null,
  sentinel: string,
): number | string | null => {
  if (raw === null) return null;
  if (raw === sentinel) return sentinel;
  const n = Number(raw);
  if (typeof raw !== "string" || !Number.isFinite(n) || n <= 0) {
    throw new Error(
      `Invalid ${field} "${raw}": expected a positive number of hours/minutes or "${sentinel}".`,
    );
  }
  return n;
};

export const parseSettingsInput = (input: RawInput): Partial<TranscriptsSettings> => {
  const patch: Partial<TranscriptsSettings> = {};

  if ("botName" in input) {
    patch.botName = input.botName as TranscriptsSettings["botName"];
  }
  if ("notifyChat" in input) {
    patch.notifyChat = input.notifyChat as TranscriptsSettings["notifyChat"];
  }
  if ("recordersMayOverrideBot" in input) {
    patch.recordersMayOverrideBot =
      input.recordersMayOverrideBot as TranscriptsSettings["recordersMayOverrideBot"];
  }
  if ("defaultRightsMode" in input) {
    patch.defaultRightsMode = input.defaultRightsMode as TranscriptsSettings["defaultRightsMode"];
  }
  if ("summaryPresets" in input) {
    patch.summaryPresets = input.summaryPresets as TranscriptsSettings["summaryPresets"];
  }
  if ("videoRetentionHours" in input) {
    patch.videoRetentionHours = parseNumericOrSentinel(
      "videoRetentionHours",
      input.videoRetentionHours as string | null,
      "forever",
    ) as TranscriptsSettings["videoRetentionHours"];
  }
  if ("storeVideoLocally" in input) {
    patch.storeVideoLocally = input.storeVideoLocally as TranscriptsSettings["storeVideoLocally"];
  }
  if ("monthlyRecordingLimitMinutes" in input) {
    patch.monthlyRecordingLimitMinutes = parseNumericOrSentinel(
      "monthlyRecordingLimitMinutes",
      input.monthlyRecordingLimitMinutes as string | null,
      "none",
    ) as TranscriptsSettings["monthlyRecordingLimitMinutes"];
  }
  if ("videoStorageCostPerHour" in input) {
    patch.videoStorageCostPerHour =
      input.videoStorageCostPerHour as TranscriptsSettings["videoStorageCostPerHour"];
  }

  return patch;
};
