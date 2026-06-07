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

const SETTINGS_KEY = "budget_settings";

export type GlobalUserBudget = {
  enabled: boolean;
  max_budget: number;
  budget_duration: BudgetDuration | string;
};

export type BudgetSettings = {
  global_user_budget: GlobalUserBudget;
  show_user_budget_in_chat: boolean;
};

export type UserBudgetView = {
  spend: number;
  max_budget: number;
  budget_duration: string | null;
  budget_reset_at: string | null;
};

const DEFAULT_SETTINGS: BudgetSettings = {
  global_user_budget: { enabled: false, max_budget: 0, budget_duration: "30d" },
  show_user_budget_in_chat: false,
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
}

// ─────────────────── batch tag map (for GraphQL budget field) ───────────────────

const TAG_MAP_TTL_MS = 30 * 1000; // 30s
let tagMapCache: { expiry: number; map: Record<string, TagInfo> } | undefined;

/**
 * All tags that currently have a budget, keyed by tag name. Powers the GraphQL
 * `budget` field resolver: it's fetched once per request window (cached ~30s)
 * and every entity row then resolves its budget with a cheap map lookup — no
 * N+1 calls to LiteLLM. Returns {} when LiteLLM is off.
 */
export async function getTagBudgetMap(): Promise<Record<string, TagInfo>> {
  // Gate on the master key only (not EXULU_USE_LITELLM) so the read path
  // matches the admin write path — budgets can be created and read whenever the
  // proxy is reachable, regardless of whether Exulu routes models through it.
  if (!process.env.LITELLM_MASTER_KEY) return {};
  if (tagMapCache && tagMapCache.expiry > Date.now()) return tagMapCache.map;

  try {
    const map = await listTagBudgets();
    tagMapCache = { expiry: Date.now() + TAG_MAP_TTL_MS, map };
    return map;
  } catch (err) {
    // Degrade gracefully: a LiteLLM hiccup shouldn't fail the whole entity
    // query — just show no budgets. Don't cache the failure.
    console.warn("[EXULU] getTagBudgetMap failed", err);
    return {};
  }
}

// ─────────────────── lazy global-default provisioning ───────────────────

const PROVISION_TTL_MS = 60 * 60 * 1000; // 1h
const provisionCache = new Map<string, number>(); // tag -> expiry epoch ms

export const __resetBudgetCachesForTesting = (): void => {
  provisionCache.clear();
  readCache.clear();
  tagMapCache = undefined;
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
    const view: UserBudgetView | null =
      ti?.max_budget != null
        ? {
            spend: ti.spend,
            max_budget: ti.max_budget,
            budget_duration: ti.budget_duration,
            budget_reset_at: ti.budget_reset_at,
          }
        : null;

    readCache.set(tag, { expiry: Date.now() + READ_TTL_MS, view });
    return view;
  } catch (err) {
    console.warn("[EXULU] getUserBudgetView failed", err);
    return null;
  }
}
