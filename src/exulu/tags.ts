import type { FetchFunction } from "@ai-sdk/provider-utils";

const MAX_LEN = 63;

function sanitizeTagValue(
  raw: string | number | undefined | null,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).normalize("NFKC").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return s.slice(0, MAX_LEN);
}

/**
 * GAP — workflow / routine attribution (see design/pages/analytics.md §4):
 * buildTags emits NO `workflow_id_`, `workflow_name_`, `routine_id_`, or
 * `routine_name_` prefix today. LLM calls inside workflow/job runners are
 * attributed to user/role/project/agent/team only, which means /analytics
 * cannot break down spend by workflow. The /analytics page lens type union
 * deliberately omits `workflows` for this reason; ?type=WORKFLOW_RUN deep
 * links fall back to ?type=all instead of mis-attributing to agents.
 *
 * To close the gap: add the optional workflow_id/workflow_name (and
 * routine_id/routine_name if distinct) fields here, then thread them through
 * every LLM-invoking callsite (job runner, supervisor, evals). This is
 * tracked as a follow-up — do NOT silently route through agent_id_ to make
 * the workflows tab "work"; that would conflate direct chat with workflow
 * runs and break trust in analytics numbers.
 */
export function buildTags(input: {
  user_id?: number | string;
  role_id?: string;
  team_id?: string;
  project_id?: string;
  agent_id?: string;
  user_name?: string;
  role_name?: string;
  project_name?: string;
  agent_name?: string;
  team_name?: string;
}): string[] {
  const candidates: (string | number | undefined)[] = [];

  if (input.user_id) {
    candidates.push("user_id_" + input.user_id);
  }
  if (input.user_name) {
    candidates.push("user_name_" + input.user_name);
  }
  if (input.role_id) {
    candidates.push("role_id_" + input.role_id);
  }
  if (input.role_name) {
    candidates.push("role_name_" + input.role_name);
  }
  if (input.project_id) {
    candidates.push("project_id_" + input.project_id);
  }
  if (input.project_name) {
    candidates.push("project_name_" + input.project_name);
  }
  if (input.agent_id) {
    candidates.push("agent_id_" + input.agent_id);
  }
  if (input.agent_name) {
    candidates.push("agent_name_" + input.agent_name);
  }
  if (input.team_id) {
    candidates.push("team_id_" + input.team_id);
  }
  if (input.team_name) {
    candidates.push("team_name_" + input.team_name);
  }

  console.log("[EXULU] Candidates", candidates);
  
  const out: string[] = [];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const value = sanitizeTagValue(candidate);
    console.log("[EXULU] Sanitized tag value", value);
    if (value === undefined || value === "") continue;
    out.push(value);
  }
  return out;
}

export type BudgetEntityType = "user" | "role" | "team" | "project" | "agent";

/**
 * Canonical LiteLLM tag a budget attaches to for a given entity. Budgets use
 * the stable `*_id_*` dimension only (ids survive renames; names do not). This
 * is the single source of truth for budget tag naming — the frontend sends
 * `{ entityType, entityId }` and the backend derives the tag here, so tag
 * sanitization is never duplicated.
 */
export function budgetTagFor(
  entityType: BudgetEntityType,
  id: string | number,
): string {
  const value = sanitizeTagValue(`${entityType}_id_${id}`);
  return value ?? "";
}

type FetchInit = Parameters<typeof globalThis.fetch>[1];

function decodeBody(body: unknown): string | undefined {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return undefined;
}

function stripContentLengthHeader(headers: unknown): unknown {
  if (!headers) return headers;
  if (typeof (headers as { delete?: unknown }).delete === "function") {
    // Headers instance
    const clone = new (globalThis as any).Headers(headers as any);
    clone.delete("content-length");
    return clone;
  }
  if (Array.isArray(headers)) {
    return (headers as Array<[string, string]>).filter(
      ([k]) => k.toLowerCase() !== "content-length",
    );
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === "content-length") continue;
    out[k] = v;
  }
  return out;
}

export function createTaggedFetch(tags: string[]): FetchFunction {
  const labeled = async (input: Parameters<typeof globalThis.fetch>[0], init?: FetchInit) => {
    try {
      if (!init || !init.body) return globalThis.fetch(input, init);

      const method = (init.method ?? "POST").toUpperCase();
      if (method !== "POST" && method !== "PUT" && method !== "PATCH") {
        return globalThis.fetch(input, init);
      }

      const decoded = decodeBody(init.body);
      if (decoded === undefined) {
        console.warn("[vertex-labels] unsupported body type, forwarding unchanged");
        return globalThis.fetch(input, init);
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(decoded);
      } catch {
        console.warn("[vertex-labels] body is not JSON, forwarding unchanged");
        return globalThis.fetch(input, init);
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return globalThis.fetch(input, init);
      }

      const existing = (parsed.metadata as Record<string, string> | undefined) ?? {};
      parsed.metadata = { ...existing, tags: tags };

      console.log("[EXULU] tags", parsed.metadata);

      const nextInit = {
        ...init,
        body: JSON.stringify(parsed),
        headers: stripContentLengthHeader(init.headers) as FetchInit extends infer T
          ? T extends { headers?: infer H }
          ? H
          : never
          : never,
      } as FetchInit;
      return globalThis.fetch(input, nextInit);
    } catch (err) {
      console.warn("[vertex-labels] label injection failed, forwarding unchanged", err);
      return globalThis.fetch(input, init);
    }
  };
  return labeled as unknown as FetchFunction;
}
