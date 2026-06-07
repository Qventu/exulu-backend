/**
 * LiteLLM tag-budget admin client.
 *
 * Thin typed wrappers over LiteLLM's tag admin API (`/tag/new`, `/tag/update`,
 * `/tag/info`, `/tag/delete`). This is the single place in the backend that
 * knows how to talk to LiteLLM's tag endpoints, used by the budget service
 * (provisioning + read views) and the `/admin/budgets/*` REST handlers.
 *
 * All calls require LITELLM_MASTER_KEY and target the locally-spawned proxy
 * (LITELLM_HOST/PORT), mirroring catalog.ts. Tag budgets are enforced by
 * LiteLLM on the stable `*_id_*` tags Exulu already attaches to every request
 * (see tags.ts / buildTags).
 */

export type BudgetDuration = "1d" | "7d" | "30d";

export type TagInfo = {
  name: string;
  spend: number;
  max_budget: number | null;
  budget_duration: string | null;
  budget_reset_at: string | null;
};

export type TagBudgetInput = {
  name: string;
  max_budget: number;
  budget_duration: BudgetDuration | string;
};

/** Thrown when a LiteLLM admin call fails so callers can log-and-continue. */
export class LiteLLMAdminError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "LiteLLMAdminError";
  }
}

function litellmBase(): { url: string; masterKey: string } {
  const host = process.env.LITELLM_HOST ?? "127.0.0.1";
  const port = process.env.LITELLM_PORT ?? "4000";
  const masterKey = process.env.LITELLM_MASTER_KEY;
  if (!masterKey) {
    throw new LiteLLMAdminError("LITELLM_MASTER_KEY is not configured.");
  }
  return { url: `http://${host}:${port}`, masterKey };
}

async function call<T>(path: string, body: unknown): Promise<T> {
  const { url, masterKey } = litellmBase();
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${masterKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LiteLLMAdminError(
      `LiteLLM ${path} returned ${res.status}: ${text}`,
      res.status,
    );
  }
  return (await res.json().catch(() => ({}))) as T;
}

/** Create a tag with a budget. Fails if the tag already exists. */
export async function tagNew(input: TagBudgetInput): Promise<void> {
  await call("/tag/new", {
    name: input.name,
    max_budget: input.max_budget,
    budget_duration: input.budget_duration,
  });
}

/** Update an existing tag's budget. */
export async function tagUpdate(input: TagBudgetInput): Promise<void> {
  await call("/tag/update", {
    name: input.name,
    max_budget: input.max_budget,
    budget_duration: input.budget_duration,
  });
}

/** Delete a tag (and its budget). */
export async function tagDelete(name: string): Promise<void> {
  await call("/tag/delete", { name });
}

/**
 * Pull budget fields out of a LiteLLM tag object. LiteLLM nests the budget
 * under `litellm_budget_table` (in /tag/list and /tag/info), with a top-level
 * fallback for older shapes. `spend` is only present on /tag/info responses.
 */
function extractBudget(raw: any): {
  max_budget: number | null;
  budget_duration: string | null;
  budget_reset_at: string | null;
  spend: number;
} {
  const bt = raw?.litellm_budget_table ?? {};
  const max_budget = bt.max_budget ?? raw?.max_budget ?? null;
  const budget_duration = bt.budget_duration ?? raw?.budget_duration ?? null;
  const budget_reset_at = bt.budget_reset_at ?? raw?.budget_reset_at ?? null;
  const spend =
    typeof raw?.spend === "number"
      ? raw.spend
      : typeof bt.spend === "number"
        ? bt.spend
        : 0;
  return { max_budget, budget_duration, budget_reset_at, spend };
}

/** All tags LiteLLM knows about (normalises the array / dict response shapes). */
export async function listTags(): Promise<any[]> {
  const { url, masterKey } = litellmBase();
  const res = await fetch(`${url}/tag/list`, {
    method: "GET",
    headers: { Authorization: `Bearer ${masterKey}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LiteLLMAdminError(
      `LiteLLM /tag/list returned ${res.status}: ${text}`,
      res.status,
    );
  }
  const json: any = await res.json().catch(() => []);
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") return Object.values(json);
  return [];
}

/**
 * Map of every tag that has a budget → its TagInfo. Built from /tag/list (which
 * carries the budget config but no spend), then spend is enriched from
 * /tag/info. Avoids /tag/info's all-or-nothing 404 by only asking about tags
 * that actually have a budget.
 */
export async function listTagBudgets(): Promise<Record<string, TagInfo>> {
  const entries = await listTags();
  const map: Record<string, TagInfo> = {};
  for (const e of entries) {
    const name = e?.name ?? e?.tag_name;
    if (typeof name !== "string") continue;
    const b = extractBudget(e);
    if (b.max_budget == null) continue;
    map[name] = {
      name,
      spend: b.spend,
      max_budget: b.max_budget,
      budget_duration: b.budget_duration,
      budget_reset_at: b.budget_reset_at,
    };
  }

  const names = Object.keys(map);
  if (names.length > 0) {
    try {
      const info = await tagInfo(names);
      for (const name of names) {
        const ti = info[name];
        const entry = map[name];
        if (ti && entry) entry.spend = ti.spend;
      }
    } catch {
      // Spend is best-effort; budgets still show without it.
    }
  }
  return map;
}

/**
 * Look up one or more tags via /tag/info. Returns a map keyed by the requested
 * name; a name with no tag or no budget maps to null.
 */
export async function tagInfo(
  names: string[],
): Promise<Record<string, TagInfo | null>> {
  const out: Record<string, TagInfo | null> = {};
  for (const n of names) out[n] = null;
  if (names.length === 0) return out;

  // /tag/info fails the whole call (404 wrapped in a 500) if ANY requested tag
  // doesn't exist. For our callers a "not found" simply means no budget yet, so
  // treat it as all-null rather than an error.
  let json: Record<string, any>;
  try {
    json = await call<Record<string, any>>("/tag/info", { names });
  } catch (err) {
    if (err instanceof LiteLLMAdminError && /not found/i.test(err.message)) {
      return out;
    }
    throw err;
  }
  for (const name of names) {
    const raw = json?.[name];
    if (!raw) {
      out[name] = null;
      continue;
    }
    const b = extractBudget(raw);
    if (b.max_budget == null) {
      out[name] = null;
      continue;
    }
    out[name] = {
      name,
      spend: b.spend,
      max_budget: b.max_budget,
      budget_duration: b.budget_duration,
      budget_reset_at: b.budget_reset_at,
    };
  }
  return out;
}
