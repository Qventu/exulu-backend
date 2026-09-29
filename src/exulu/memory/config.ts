/**
 * agents.memory_config (spec §2.2). Stored as json; null means defaults.
 */
export type MemoryConfig = {
  retrieval: { enabled: boolean; limit: number };
  visibility: "ask" | "preselect_private";
  guests: { showRecalled: boolean };
};

export const MEMORY_LIMIT_MIN = 1;
export const MEMORY_LIMIT_MAX = 50;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  retrieval: { enabled: true, limit: 10 },
  visibility: "ask",
  guests: { showRecalled: false },
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function resolveMemoryConfig(raw: unknown): MemoryConfig {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { value = undefined; }
  }
  if (!isRecord(value)) return structuredClone(DEFAULT_MEMORY_CONFIG);

  const retrieval = isRecord(value.retrieval) ? value.retrieval : {};
  const guests = isRecord(value.guests) ? value.guests : {};
  const limitNum = Number(retrieval.limit);
  const limit = Number.isFinite(limitNum)
    ? Math.min(MEMORY_LIMIT_MAX, Math.max(MEMORY_LIMIT_MIN, Math.round(limitNum)))
    : DEFAULT_MEMORY_CONFIG.retrieval.limit;

  return {
    retrieval: {
      enabled: typeof retrieval.enabled === "boolean" ? retrieval.enabled : DEFAULT_MEMORY_CONFIG.retrieval.enabled,
      limit,
    },
    visibility: value.visibility === "preselect_private" ? "preselect_private" : "ask",
    guests: {
      showRecalled: typeof guests.showRecalled === "boolean" ? guests.showRecalled : DEFAULT_MEMORY_CONFIG.guests.showRecalled,
    },
  };
}
