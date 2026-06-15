/**
 * LiteLLM tag-activity admin client.
 *
 * Thin typed wrapper over LiteLLM's `GET /tag/daily/activity`. Single source of
 * truth for the analytics page + Today's Vitals (Home dashboard) — the
 * frontend NEVER hits LiteLLM directly; it goes through
 * `/admin/litellm/tag-activity` which is implemented in routes.ts using this
 * client.
 *
 * Mirrors `admin-client.ts` in shape (uses the shared `litellmBase()` from
 * `env.ts`, reuses `LiteLLMAdminError`) so error handling is uniform across
 * `/admin/budgets/*` and `/admin/litellm/tag-activity`.
 *
 * Also exposes `listTagsByPrefix()` — Exulu-specific sugar that translates a
 * dimension prefix (e.g. `agent_id_`) into a concrete tags CSV by listing all
 * LiteLLM tags once and filtering server-side. Cached in-memory for 30s to
 * keep analytics latency reasonable on tag-heavy installs.
 */

import { LiteLLMAdminError, litellmBase } from "./env.ts";
import { listTags } from "./admin-client.ts";

// ─────────────────────────── Sanitisation ───────────────────────────
// Mirrors tags.ts buildTags() exactly — NFKC → lowercase → [^a-z0-9_-] → "-"
// → slice(0,63). Critical for prefix matching: if the frontend asks for
// "project_id_" the sanitised result is the same; but a user-supplied raw
// prefix containing capitals or unsupported chars must be transformed the
// same way buildTags() does, otherwise it would never match a real tag.

const SANITIZE_MAX_LEN = 63;

export function sanitizeTagPrefix(raw: string): string {
  return String(raw)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, SANITIZE_MAX_LEN);
}

// ─────────────────────────── Tag-list cache ───────────────────────────
// listTags() can be expensive on large installs (LiteLLM walks every tag).
// Analytics requests with a tag_prefix trigger this scan, so we cache for 30s.
// Stale-while-revalidate is acceptable: new tags appear in /analytics ≤30s
// after first use, well within UX tolerance for a dashboard.

const TAG_LIST_TTL_MS = 30_000;
let tagListCache: { fetchedAt: number; tags: any[] } | null = null;

async function getCachedTagList(): Promise<any[]> {
  const now = Date.now();
  if (tagListCache && now - tagListCache.fetchedAt < TAG_LIST_TTL_MS) {
    return tagListCache.tags;
  }
  const tags = await listTags();
  tagListCache = { fetchedAt: now, tags };
  return tags;
}

/** Test-only: drop the in-memory tag-list cache between assertions. */
export function __resetActivityClientCacheForTesting(): void {
  tagListCache = null;
}

// ─────────────────────────── Public API ───────────────────────────

export type TagDailyActivityParams = {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  tags?: string[]; // forwarded as ?tags=a,b,c
  model?: string;
  page?: number;
  pageSize?: number;
  excludeTeamTags?: boolean;
};

/**
 * Calls LiteLLM `GET /tag/daily/activity`. Returns the raw JSON; projection
 * into Exulu's documented response shape happens in the route handler so the
 * client stays a pure data-layer module (no Express coupling).
 *
 * Throws LiteLLMAdminError on non-2xx so the route can translate to 502.
 */
export async function getTagDailyActivity(
  params: TagDailyActivityParams,
): Promise<any> {
  const { url, masterKey } = litellmBase();
  const qs = new URLSearchParams();
  qs.set("start_date", params.startDate);
  qs.set("end_date", params.endDate);
  if (params.tags && params.tags.length > 0) {
    qs.set("tags", params.tags.join(","));
  }
  if (params.model) qs.set("model", params.model);
  if (params.page != null) qs.set("page", String(params.page));
  if (params.pageSize != null) qs.set("page_size", String(params.pageSize));
  if (params.excludeTeamTags != null) {
    qs.set("exclude_team_tags", params.excludeTeamTags ? "true" : "false");
  }

  const res = await fetch(`${url}/tag/daily/activity?${qs.toString()}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${masterKey}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LiteLLMAdminError(
      `LiteLLM /tag/daily/activity returned ${res.status}: ${text}`,
      res.status,
    );
  }
  return await res.json().catch(() => ({}));
}

/**
 * Find all LiteLLM tags whose name starts with the sanitised version of
 * `prefix`. Used by the /admin/litellm/tag-activity route to translate
 * dimension=agents|users|projects|teams|roles into a concrete tags CSV — the
 * frontend never has to enumerate tags.
 *
 * Returns the sanitised prefix used (for caller debugging / response echo).
 */
export async function listTagsByPrefix(
  prefix: string,
): Promise<{ sanitisedPrefix: string; names: string[] }> {
  const sanitised = sanitizeTagPrefix(prefix);
  if (!sanitised) return { sanitisedPrefix: "", names: [] };
  const all = await getCachedTagList();
  const names: string[] = [];
  for (const e of all) {
    const name = e?.name ?? e?.tag_name;
    if (typeof name !== "string") continue;
    if (name.startsWith(sanitised)) names.push(name);
  }
  return { sanitisedPrefix: sanitised, names };
}
