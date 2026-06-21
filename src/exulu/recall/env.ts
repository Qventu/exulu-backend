/**
 * Recall.ai configuration + feature gating.
 *
 * The meeting-bot feature is gated on four values being present in the
 * environment (see RECALL-AI.AGENT.md §"Human-required setup"):
 *
 *   - RECALL_REGION                        (one of the four valid regions)
 *   - RECALL_API_KEY                       (region-specific)
 *   - RECALL_WORKSPACE_VERIFICATION_SECRET (webhook/callback verification)
 *   - PUBLIC_API_BASE_URL                  (we reuse process.env.BACKEND)
 *
 * When any are missing the meeting-bot mutations/routes respond 503 with
 * RECALL_NOT_CONFIGURED_MESSAGE, mirroring how /transcribe, /speech and
 * /images/* gate themselves.
 *
 * Design doc: docs/superpowers/specs/2026-06-19-recall-meeting-recording-design.md
 */

export const RECALL_REGIONS = [
  "us-west-2",
  "us-east-1",
  "eu-central-1",
  "ap-northeast-1",
] as const;

export type RecallRegion = (typeof RECALL_REGIONS)[number];

export class RecallNotConfiguredError extends Error {
  constructor(message: string = RECALL_NOT_CONFIGURED_MESSAGE) {
    super(message);
    this.name = "RecallNotConfiguredError";
  }
}

export const RECALL_NOT_CONFIGURED_MESSAGE =
  "Recall meeting bots are not enabled on this deployment. Set RECALL_REGION " +
  "(one of " +
  RECALL_REGIONS.join(", ") +
  "), RECALL_API_KEY, RECALL_WORKSPACE_VERIFICATION_SECRET, and BACKEND " +
  "(public base URL) in the environment.";

const isValidRegion = (value: string | undefined): value is RecallRegion =>
  !!value && (RECALL_REGIONS as readonly string[]).includes(value);

/** The configured region, or null when unset/invalid. */
export const recallRegion = (): RecallRegion | null => {
  const region = process.env.RECALL_REGION;
  return isValidRegion(region) ? region : null;
};

export const recallApiKey = (): string | undefined => process.env.RECALL_API_KEY;

export const recallVerificationSecret = (): string | undefined =>
  process.env.RECALL_WORKSPACE_VERIFICATION_SECRET;

/**
 * Public base URL Recall uses to reach our webhook endpoint. Prefers the
 * existing BACKEND env var (the app's public base URL); falls back to
 * PUBLIC_API_BASE_URL for parity with the Recall setup guide's naming.
 */
export const recallPublicBaseUrl = (): string | undefined =>
  (process.env.BACKEND || process.env.PUBLIC_API_BASE_URL)?.replace(/\/$/, "");

/** True only when every required value is present and the region is valid. */
export const recallEnabled = (): boolean =>
  recallRegion() !== null &&
  !!recallApiKey() &&
  !!recallVerificationSecret() &&
  !!recallPublicBaseUrl();

/** Throw a typed error when the feature is not fully configured. */
export const assertRecallConfigured = (): void => {
  if (!recallEnabled()) throw new RecallNotConfiguredError();
};

/** Region-scoped Recall API base, e.g. https://us-west-2.recall.ai/api/v1 */
export const recallApiBaseUrl = (): string => {
  const region = recallRegion();
  if (!region) throw new RecallNotConfiguredError();
  return `https://${region}.recall.ai/api/v1`;
};

/**
 * Optional monthly cap on total recorded meeting duration, returned in seconds.
 * The env var TOTAL_MAX_RECORDINGS_DURATION_PER_MONTH is interpreted as
 * MINUTES (the natural unit for a monthly recording budget). Returns null when
 * unset/invalid, meaning "no cap".
 */
export const recordingMonthlyLimitSeconds = (): number | null => {
  const raw = process.env.TOTAL_MAX_RECORDINGS_DURATION_PER_MONTH;
  if (!raw) return null;
  const minutes = Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : null;
};

/** The webhook URL Recall should be pointed at in the dashboard. */
export const recallWebhookUrl = (): string | null => {
  const base = recallPublicBaseUrl();
  return base ? `${base}/recall/webhooks` : null;
};

/**
 * Always print the Recall region on startup (per RECALL-AI.AGENT.md) plus a
 * one-line enabled/disabled summary.
 */
export const logRecallStartup = (): void => {
  const region = process.env.RECALL_REGION;
  console.log(`[EXULU-RECALL] RECALL_REGION=${region ?? "(unset)"}`);
  if (recallEnabled()) {
    console.log(
      `[EXULU-RECALL] Recall meeting bots: enabled (webhook: ${recallWebhookUrl()})`,
    );
  } else {
    console.log(
      "[EXULU-RECALL] Recall meeting bots: disabled (missing configuration).",
    );
  }
};
