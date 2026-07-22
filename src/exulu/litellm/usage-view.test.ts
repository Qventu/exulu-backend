/**
 * usage-view — pure helpers behind GET /me/usage.
 * resolveUsageWindow / projectMyUsage need no mocks; getMyUsageView (Task 2)
 * mocks budget-service + activity-client at module level (workers.flow
 * pattern).
 */

import {
  MAX_WINDOW_DAYS,
  projectMyUsage,
  resolveUsageWindow,
} from "./usage-view.ts";

const NOW = new Date("2026-07-20T10:00:00.000Z");

describe("resolveUsageWindow", () => {
  it("defaults to the last 30 days ending today (UTC)", () => {
    expect(resolveUsageWindow(undefined, undefined, NOW)).toEqual({
      start_date: "2026-06-21",
      end_date: "2026-07-20",
    });
  });

  it("passes through an explicit YYYY-MM-DD range", () => {
    expect(resolveUsageWindow("2026-07-01", "2026-07-10", NOW)).toEqual({
      start_date: "2026-07-01",
      end_date: "2026-07-10",
    });
  });

  it("accepts ISO datetimes and slices to the date", () => {
    expect(
      resolveUsageWindow(
        "2026-07-01T00:00:00.000Z",
        "2026-07-10T23:59:59.000Z",
        NOW,
      ),
    ).toEqual({ start_date: "2026-07-01", end_date: "2026-07-10" });
  });

  it("defaults only the missing bound", () => {
    expect(resolveUsageWindow("2026-07-01", undefined, NOW)).toEqual({
      start_date: "2026-07-01",
      end_date: "2026-07-20",
    });
  });

  it("returns null for malformed dates", () => {
    expect(resolveUsageWindow("yesterday", undefined, NOW)).toBeNull();
    expect(resolveUsageWindow(undefined, "20-07-2026", NOW)).toBeNull();
    expect(resolveUsageWindow(["2026-07-01"], undefined, NOW)).toBeNull();
  });

  it("returns null when start is after end", () => {
    expect(resolveUsageWindow("2026-07-10", "2026-07-01", NOW)).toBeNull();
  });

  it(`clamps windows longer than ${MAX_WINDOW_DAYS} days to the most recent ${MAX_WINDOW_DAYS}`, () => {
    expect(resolveUsageWindow("2025-01-01", "2026-07-20", NOW)).toEqual({
      start_date: "2026-04-20", // 2026-07-20 minus 91 days
      end_date: "2026-07-20",
    });
  });
});

/** One LiteLLM /tag/daily/activity result row (nested-metrics variant). */
const row = (
  date: string,
  spend: number,
  models: Record<string, number> = {},
) => ({
  date,
  metrics: {
    spend,
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
    successful_requests: 2,
    failed_requests: 1,
    api_requests: 3,
  },
  breakdown: {
    models: Object.fromEntries(
      Object.entries(models).map(([name, modelSpend]) => [
        name,
        {
          metrics: {
            spend: modelSpend,
            total_tokens: 10,
            successful_requests: 1,
          },
        },
      ]),
    ),
  },
});

describe("projectMyUsage", () => {
  it("sums totals across rows and sorts daily ascending by date", () => {
    const raw = { results: [row("2026-07-02", 2), row("2026-07-01", 1)] };
    const { totals, daily } = projectMyUsage(raw);
    expect(totals).toEqual({
      spend: 3,
      prompt_tokens: 200,
      completion_tokens: 100,
      total_tokens: 300,
      successful_requests: 4,
      failed_requests: 2,
      api_requests: 6,
    });
    expect(daily.map((d) => d.date)).toEqual(["2026-07-01", "2026-07-02"]);
    expect(daily[0].spend).toBe(1);
  });

  it("aggregates the model breakdown across days, sorted by spend desc", () => {
    const raw = {
      results: [
        row("2026-07-01", 1, { "gpt-5": 0.25, "claude-fable-5": 0.75 }),
        row("2026-07-02", 2, { "gpt-5": 1.5 }),
      ],
    };
    const { byModel } = projectMyUsage(raw);
    expect(byModel.map((m) => m.model)).toEqual(["gpt-5", "claude-fable-5"]);
    expect(byModel[0]).toEqual({
      model: "gpt-5",
      spend: 1.75,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 20,
      successful_requests: 2,
      failed_requests: 0,
    });
  });

  it("reads flat metrics when the nested `metrics` object is absent", () => {
    const raw = {
      results: [{ date: "2026-07-01", spend: 5, total_tokens: 7 }],
    };
    const { totals } = projectMyUsage(raw);
    expect(totals.spend).toBe(5);
    expect(totals.total_tokens).toBe(7);
  });

  it("merges duplicate rows for the same date (per-tag rows)", () => {
    const raw = { results: [row("2026-07-01", 1), row("2026-07-01", 2)] };
    const { daily } = projectMyUsage(raw);
    expect(daily).toHaveLength(1);
    expect(daily[0].spend).toBe(3);
  });

  it("returns zeroed output for empty or malformed raw payloads", () => {
    for (const raw of [{}, null, { results: "nope" }, { results: [{}] }]) {
      const { totals, daily, byModel } = projectMyUsage(raw);
      expect(totals.spend).toBe(0);
      expect(totals.api_requests).toBe(0);
      expect(daily).toEqual([]);
      expect(byModel).toEqual([]);
    }
  });
});
