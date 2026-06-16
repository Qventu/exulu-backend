/**
 * Budget service — the backend's budget brain on top of admin-client.ts.
 *
 * Responsibilities:
 *  - read/write platform-level budget settings (platform_configurations key
 *    "budget_settings"): the global per-user default + the show-in-chat toggle.
 *  - upsertBudget: the new-vs-update decision used by the REST handlers.
 *  - ensureUserBudget: lazy provisioning of the global per-user default, with a
 *    ~1h in-memory cache. Never overwrites an existing budget.
 *  - getUserBudgetView: the end-user self-view, with a ~30s in-memory read
 *    cache so repeated context loads don't hammer LiteLLM.
 *
 * LiteLLM stays the source of truth for per-entity budgets; only the settings
 * row lives in Exulu Postgres.
 */

import { postgresClient } from "@SRC/postgres/client";
import { budgetTagFor } from "../tags";
import {
  listTagBudgets,
  tagInfo,
  tagNew,
  tagUpdate,
  type BudgetDuration,
  type TagInfo,
} from "./admin-client";
import { getTagSpendByWindow } from "./activity-client";

const SETTINGS_KEY = "budget_settings";

const DAY_MS = 24 * 60 * 60 * 1000;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * LiteLLM budget durations are strings like "30d" / "7d" / "24h" / "1mo".
 * Translate to a number of days for window math. Defaults to 30 days on an
 * unparseable / missing value.
 */
function durationToDays(duration?: string | null): number {
  if (!duration) return 30;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mo|[a-z]+)?\s*$/i.exec(String(duration));
  if (!m) return 30;
  const n = parseFloat(m[1]!);
  if (!Number.isFinite(n) || n <= 0) return 30;
  switch ((m[2] ?? "d").toLowerCase()) {
    case "h":
      return n / 24;
    case "w":
      return n * 7;
    case "mo":
      return n * 30;
    case "y":
      return n * 365;
    default: // "d" and anything else → days
      return n;
  }
}

/**
 * Start date (YYYY-MM-DD) of the budget's current period. `budget_reset_at` is
 * the *next* reset, so the current period began one duration before it. When
 * reset is missing or already in the past (stale), fall back to a trailing
 * window of one duration ending now, so we never count spend from a prior
 * period.
 */
function windowStartYmd(reset_at: string | null, duration: string | null): string {
  const days = durationToDays(duration);
  const reset = reset_at ? new Date(reset_at) : null;
  const periodStart =
    reset && !Number.isNaN(reset.getTime())
      ? new Date(reset.getTime() - days * DAY_MS)
      : null;
  const trailingStart = new Date(Date.now() - days * DAY_MS);
  // Use the reset-derived start, but never reach back further than one full
  // duration from now (guards a stale/past reset_at from pulling old spend).
  const chosen =
    periodStart && periodStart > trailingStart ? periodStart : trailingStart;
  return ymd(chosen);
}

/**
 * Overwrite each TagInfo's `spend` with the running spend read from
 * /tag/daily/activity over that tag's current budget window. LiteLLM's tag
 * config endpoints (/tag/info, /tag/list) carry the budget limit but NOT the
 * spend tallied against it — only the daily-activity endpoint does — so
 * without this every budget renders "$0 of $X". Best-effort: on any activity
 * error the existing (config-derived, typically 0) spend is left untouched.
 */
async function enrichSpendFromActivity(
  map: Record<string, TagInfo>,
): Promise<void> {
  const names = Object.keys(map);
  if (names.length === 0) return;
  const windows: Record<string, string> = {};
  for (const name of names) {
    const ti = map[name]!;
    windows[name] = windowStartYmd(ti.budget_reset_at, ti.budget_duration);
  }
  try {
    const spendByTag = await getTagSpendByWindow(windows, ymd(new Date()));
    for (const name of names) {
      const spend = spendByTag[name];
      if (typeof spend === "number" && Number.isFinite(spend)) {
        map[name]!.spend = spend;
      }
    }
  } catch (err) {
    console.warn("[EXULU] enrichSpendFromActivity failed", err);
  }
}

export type GlobalUserBudget = {
  enabled: boolean;
  max_budget: number;
  budget_duration: BudgetDuration | string;
};

/** How the end-user-facing budget indicator renders its value. "amount" shows
 *  exact USD ($12 / $50); "percent" shows only a percentage (so customers who
 *  don't want their users seeing raw cost figures pick this). UI-level choice —
 *  the raw figures are still sent on the wire (see /me/budget). */
export type UserBudgetDisplay = "amount" | "percent";

export type BudgetSettings = {
  global_user_budget: GlobalUserBudget;
  show_user_budget_in_chat: boolean;
  user_budget_display: UserBudgetDisplay;
};

export type UserBudgetView = {
  spend: number;
  max_budget: number;
  budget_duration: string | null;
  budget_reset_at: string | null;
  /** Echoes the platform `user_budget_display` setting so the client knows
   *  whether to render the amount or only a percentage. */
  display: UserBudgetDisplay;
};

const DEFAULT_SETTINGS: BudgetSettings = {
  global_user_budget: { enabled: false, max_budget: 0, budget_duration: "30d" },
  show_user_budget_in_chat: false,
  user_budget_display: "amount",
};

function isEnabled(): boolean {
  return (
    process.env.EXULU_USE_LITELLM === "true" && !!process.env.LITELLM_MASTER_KEY
  );
}

// ───────────────────────── settings ─────────────────────────

export async function getBudgetSettings(): Promise<BudgetSettings> {
  const { db } = await postgresClient();
  const row = await db
    .from("platform_configurations")
    .where({ config_key: SETTINGS_KEY })
    .first();
  if (!row?.config_value) return { ...DEFAULT_SETTINGS };

  const parsed =
    typeof row.config_value === "string"
      ? (() => {
          try {
            return JSON.parse(row.config_value);
          } catch {
            return {};
          }
        })()
      : row.config_value;

  return {
    global_user_budget: {
      ...DEFAULT_SETTINGS.global_user_budget,
      ...(parsed?.global_user_budget ?? {}),
    },
    show_user_budget_in_chat:
      parsed?.show_user_budget_in_chat ??
      DEFAULT_SETTINGS.show_user_budget_in_chat,
    user_budget_display:
      parsed?.user_budget_display === "percent" ? "percent" : "amount",
  };
}

export async function setBudgetSettings(
  settings: BudgetSettings,
): Promise<BudgetSettings> {
  const { db } = await postgresClient();
  await db
    .from("platform_configurations")
    .insert({
      config_key: SETTINGS_KEY,
      config_value: JSON.stringify(settings),
      description: "Tag-based budget settings (global per-user default + show-in-chat)",
    })
    .onConflict("config_key")
    .merge({ config_value: JSON.stringify(settings) });
  return settings;
}

// ───────────────────────── upsert ─────────────────────────

/**
 * Create-or-update a tag budget. Uses tagInfo to decide, with a fallback so a
 * race (tag created between the read and the write) still resolves. Invalidates
 * the in-memory caches for this tag.
 */
export async function upsertBudget(
  tag: string,
  max_budget: number,
  budget_duration: BudgetDuration | string,
): Promise<void> {
  const info = await tagInfo([tag]);
  try {
    if (info[tag]) {
      await tagUpdate({ name: tag, max_budget, budget_duration });
    } else {
      await tagNew({ name: tag, max_budget, budget_duration });
    }
  } catch {
    // Fallback: flip the operation in case the existence check raced.
    if (info[tag]) {
      await tagNew({ name: tag, max_budget, budget_duration });
    } else {
      await tagUpdate({ name: tag, max_budget, budget_duration });
    }
  }
  invalidateBudgetCaches(tag);
}

export function invalidateBudgetCaches(tag: string): void {
  provisionCache.delete(tag);
  readCache.delete(tag);
  tagMapCache = undefined;
  tagMapInflight = undefined;
}

// ─────────────────── batch tag map (for GraphQL budget field) ───────────────────

const TAG_MAP_TTL_MS = 30 * 1000; // 30s
let tagMapCache: { expiry: number; map: Record<string, TagInfo> } | undefined;
// Single-flight guard: a page of N entity rows resolves the `budget` field
// concurrently (finalizeRequestedFields maps over items without awaiting
// between them), so on a cold/expired cache all N would otherwise stampede the
// full /tag/list + /tag/info + /tag/daily/activity pipeline at once. Sharing
// one in-flight promise collapses that to a single fetch per 30s window.
let tagMapInflight: Promise<Record<string, TagInfo>> | undefined;

/**
 * All tags that currently have a budget, keyed by tag name. Powers the GraphQL
 * `budget` field resolver: it's fetched once per request window (cached ~30s,
 * deduped while in flight) and every entity row then resolves its budget with a
 * cheap map lookup — no N+1 calls to LiteLLM. Returns {} when LiteLLM is off.
 */
export async function getTagBudgetMap(): Promise<Record<string, TagInfo>> {
  // Gate on the master key only (not EXULU_USE_LITELLM) so the read path
  // matches the admin write path — budgets can be created and read whenever the
  // proxy is reachable, regardless of whether Exulu routes models through it.
  if (!process.env.LITELLM_MASTER_KEY) return {};
  if (tagMapCache && tagMapCache.expiry > Date.now()) return tagMapCache.map;
  if (tagMapInflight) return tagMapInflight;

  tagMapInflight = (async () => {
    try {
      const map = await listTagBudgets();
      // listTagBudgets returns the budget config with spend=0 (the tag-config
      // endpoints don't carry running spend); fill it from daily activity.
      await enrichSpendFromActivity(map);
      tagMapCache = { expiry: Date.now() + TAG_MAP_TTL_MS, map };
      return map;
    } catch (err) {
      // Degrade gracefully: a LiteLLM hiccup shouldn't fail the whole entity
      // query — just show no budgets. Don't cache the failure.
      console.warn("[EXULU] getTagBudgetMap failed", err);
      return {};
    } finally {
      tagMapInflight = undefined;
    }
  })();
  return tagMapInflight;
}

// ─────────────────── lazy global-default provisioning ───────────────────

const PROVISION_TTL_MS = 60 * 60 * 1000; // 1h
const provisionCache = new Map<string, number>(); // tag -> expiry epoch ms

export const __resetBudgetCachesForTesting = (): void => {
  provisionCache.clear();
  readCache.clear();
  tagMapCache = undefined;
  tagMapInflight = undefined;
};

/**
 * Create the user's LiteLLM budget tag from the configured global per-user
 * default when it doesn't exist yet. Lazy + cached; a no-op when the tag
 * already exists, so it never overwrites an explicit or prior-auto budget.
 * Always swallows errors — provisioning must never block a completion.
 */
export async function provisionDefaultUserBudget(
  userId: number | string,
): Promise<void> {
  try {
    if (!isEnabled()) return;
    const tag = budgetTagFor("user", userId);
    if (!tag) return;

    const cached = provisionCache.get(tag);
    if (cached && cached > Date.now()) return;

    const { global_user_budget: g } = await getBudgetSettings();
    if (!g.enabled || !(g.max_budget > 0)) {
      provisionCache.set(tag, Date.now() + PROVISION_TTL_MS);
      return;
    }

    const info = await tagInfo([tag]);
    if (info[tag]?.max_budget != null) {
      // Budget already exists (explicit admin budget or prior auto-provision).
      provisionCache.set(tag, Date.now() + PROVISION_TTL_MS);
      return;
    }

    await tagNew({
      name: tag,
      max_budget: g.max_budget,
      budget_duration: g.budget_duration,
    });
    provisionCache.set(tag, Date.now() + PROVISION_TTL_MS);
  } catch (err) {
    // Do NOT cache on failure so the next request retries.
    console.warn("[EXULU] ensureUserBudget failed", err);
  }
}

// ─────────────────── end-user read view ───────────────────

const READ_TTL_MS = 30 * 1000; // 30s
const readCache = new Map<string, { expiry: number; view: UserBudgetView | null }>();

/**
 * The caller's own budget snapshot, or null when show-in-chat is off or the
 * user has no budget. Cached ~30s so repeated UserContext loads are cheap.
 */
export async function getUserBudgetView(
  userId: number | string,
): Promise<UserBudgetView | null> {
  try {
    if (!isEnabled()) return null;
    const tag = budgetTagFor("user", userId);
    if (!tag) return null;

    const cached = readCache.get(tag);
    if (cached && cached.expiry > Date.now()) return cached.view;

    const settings = await getBudgetSettings();
    if (!settings.show_user_budget_in_chat) {
      readCache.set(tag, { expiry: Date.now() + READ_TTL_MS, view: null });
      return null;
    }

    const info = await tagInfo([tag]);
    const ti = info[tag];
    // tagInfo carries the budget limit but not the running spend — enrich it
    // from daily activity (same gap the /budgets page hit).
    if (ti?.max_budget != null) {
      await enrichSpendFromActivity({ [tag]: ti });
    }
    const view: UserBudgetView | null =
      ti?.max_budget != null
        ? {
            spend: ti.spend,
            max_budget: ti.max_budget,
            budget_duration: ti.budget_duration,
            budget_reset_at: ti.budget_reset_at,
            display: settings.user_budget_display,
          }
        : null;

    readCache.set(tag, { expiry: Date.now() + READ_TTL_MS, view });
    return view;
  } catch (err) {
    console.warn("[EXULU] getUserBudgetView failed", err);
    return null;
  }
}
