/**
 * User-scoped usage view behind `GET /me/usage` — the signed-in user's own
 * LiteLLM daily activity (totals, per-day, per-model), gated on the same
 * `show_user_budget_in_chat` setting as `/me/budget` (null = surface hidden).
 *
 * resolveUsageWindow and projectMyUsage are pure (unit-tested without mocks);
 * getMyUsageView is the thin orchestrator the route calls. Spec:
 * frontend/docs/superpowers/specs/2026-07-16-personal-usage-details-design.md
 */

import { budgetTagFor } from "../tags.ts";
import { getTagDailyActivity } from "./activity-client.ts";
import { getBudgetSettings, type UserBudgetDisplay } from "./budget-service.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Longest selectable window; longer requests are clamped, not rejected. */
export const MAX_WINDOW_DAYS = 92;
const DEFAULT_WINDOW_DAYS = 30;

export type UsageWindow = { start_date: string; end_date: string };

export type UsageMetrics = {
  spend: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  successful_requests: number;
  failed_requests: number;
  api_requests: number;
};

export type MyUsageDailyRow = UsageMetrics & { date: string };

export type MyUsageModelRow = {
  model: string;
  spend: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  successful_requests: number;
  failed_requests: number;
};

export type MyUsageView = {
  window: UsageWindow;
  display: UserBudgetDisplay;
  totals: UsageMetrics;
  daily: MyUsageDailyRow[];
  byModel: MyUsageModelRow[];
};

/** undefined = not provided (use default); null = malformed (400). */
const parseDateParam = (raw: unknown): string | null | undefined => {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") return null;
  if (DATE_ONLY_RE.test(raw)) return raw;
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
};

const ymdShift = (ymd: string, days: number): string =>
  new Date(Date.parse(ymd) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * Resolve raw query params into a concrete YYYY-MM-DD window: defaults to the
 * last DEFAULT_WINDOW_DAYS ending today (UTC), clamps to MAX_WINDOW_DAYS.
 * Returns null on malformed input or start > end (route answers 400).
 */
export function resolveUsageWindow(
  startRaw: unknown,
  endRaw: unknown,
  now: Date = new Date(),
): UsageWindow | null {
  const start = parseDateParam(startRaw);
  const end = parseDateParam(endRaw);
  if (start === null || end === null) return null;

  const end_date = end ?? now.toISOString().slice(0, 10);
  let start_date = start ?? ymdShift(end_date, -(DEFAULT_WINDOW_DAYS - 1));
  if (start_date > end_date) return null;

  const days =
    Math.round((Date.parse(end_date) - Date.parse(start_date)) / DAY_MS) + 1;
  if (days > MAX_WINDOW_DAYS) {
    start_date = ymdShift(end_date, -(MAX_WINDOW_DAYS - 1));
  }
  return { start_date, end_date };
}

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

const zeroMetrics = (): UsageMetrics => ({
  spend: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  successful_requests: 0,
  failed_requests: 0,
  api_requests: 0,
});

/** LiteLLM rows carry metrics nested (`row.metrics.spend`) or flat depending
 *  on proxy version — read nested first, fall back to flat, zero-fill. */
const readMetrics = (source: any): UsageMetrics => {
  const m = source?.metrics ?? {};
  return {
    spend: num(m.spend ?? source?.spend),
    prompt_tokens: num(m.prompt_tokens ?? source?.prompt_tokens),
    completion_tokens: num(m.completion_tokens ?? source?.completion_tokens),
    total_tokens: num(m.total_tokens ?? source?.total_tokens),
    successful_requests: num(
      m.successful_requests ?? source?.successful_requests,
    ),
    failed_requests: num(m.failed_requests ?? source?.failed_requests),
    api_requests: num(m.api_requests ?? source?.api_requests),
  };
};

const addMetrics = (into: UsageMetrics, add: UsageMetrics): void => {
  into.spend += add.spend;
  into.prompt_tokens += add.prompt_tokens;
  into.completion_tokens += add.completion_tokens;
  into.total_tokens += add.total_tokens;
  into.successful_requests += add.successful_requests;
  into.failed_requests += add.failed_requests;
  into.api_requests += add.api_requests;
};

/**
 * Project raw /tag/daily/activity JSON (single-tag call) into totals + daily
 * + byModel. Tolerant like projectTagActivity in routes.ts: unknown shapes
 * zero-fill rather than throw.
 */
export function projectMyUsage(raw: any): {
  totals: UsageMetrics;
  daily: MyUsageDailyRow[];
  byModel: MyUsageModelRow[];
} {
  const results: any[] = Array.isArray(raw?.results)
    ? raw.results
    : Array.isArray(raw)
      ? raw
      : [];

  const totals = zeroMetrics();
  const byDate = new Map<string, UsageMetrics>();
  const byModelMap = new Map<string, UsageMetrics>();

  for (const result of results) {
    const date = typeof result?.date === "string" ? result.date : null;
    if (!date) continue;

    const metrics = readMetrics(result);
    addMetrics(totals, metrics);

    const day = byDate.get(date) ?? zeroMetrics();
    addMetrics(day, metrics);
    byDate.set(date, day);

    const models =
      result?.breakdown && typeof result.breakdown.models === "object"
        ? result.breakdown.models
        : {};
    for (const [model, entry] of Object.entries(models ?? {})) {
      const acc = byModelMap.get(model) ?? zeroMetrics();
      addMetrics(acc, readMetrics(entry));
      byModelMap.set(model, acc);
    }
  }

  const daily: MyUsageDailyRow[] = [...byDate.entries()]
    .map(([date, m]) => ({ date, ...m }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const byModel: MyUsageModelRow[] = [...byModelMap.entries()]
    .map(([model, m]) => ({
      model,
      spend: m.spend,
      prompt_tokens: m.prompt_tokens,
      completion_tokens: m.completion_tokens,
      total_tokens: m.total_tokens,
      successful_requests: m.successful_requests,
      failed_requests: m.failed_requests,
    }))
    .sort((a, b) => b.spend - a.spend);

  return { totals, daily, byModel };
}

/**
 * The caller's own usage view, or null when the admin keeps spend data
 * hidden from users (same gate as getUserBudgetView). Per the existing
 * product decision, "percent" display mode is UI-only — the payload always
 * carries spend; callers decide what to render.
 */
export async function getMyUsageView(
  userId: number | string,
  window: UsageWindow,
): Promise<MyUsageView | null> {
  const settings = await getBudgetSettings();
  if (!settings.show_user_budget_in_chat) return null;

  const tag = budgetTagFor("user", userId);
  if (!tag) return null;

  // One tag → one row per day; +100 headroom mirrors the tag-activity route.
  const daysInRange =
    Math.round(
      (Date.parse(window.end_date) - Date.parse(window.start_date)) / DAY_MS,
    ) + 1;

  const raw = await getTagDailyActivity({
    startDate: window.start_date,
    endDate: window.end_date,
    tags: [tag],
    page: 1,
    pageSize: Math.min(daysInRange + 100, 10_000),
  });

  const { totals, daily, byModel } = projectMyUsage(raw);
  return {
    window,
    display: settings.user_budget_display,
    totals,
    daily,
    byModel,
  };
}
