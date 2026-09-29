/**
 * Memory base contract (spec §2.1). A context can serve as an agent's memory
 * store when it has an `information` text field (the memory wording) and a
 * `type` enum (memory type). Used by tool registration, the GraphQL Context
 * type (`memoryBase`) and the workbench picker.
 */
export const MEMORY_REQUIRED_FIELDS = ["information", "type"] as const;

export type MemoryBaseCheck = { ok: boolean; missing: string[] };

type FieldLike = { name: string; type: string; enumValues?: string[] | null };
type ContextLike = { fields?: FieldLike[] } | null | undefined;

const TEXT_TYPES = new Set(["text", "longText"]);

export function checkMemoryBase(context: ContextLike): MemoryBaseCheck {
  const fields = context?.fields ?? [];
  const missing: string[] = [];
  const information = fields.find((f) => f.name === "information");
  if (!information || !TEXT_TYPES.has(information.type)) missing.push("information");
  const type = fields.find((f) => f.name === "type");
  if (!type || type.type !== "enum" || !type.enumValues?.length) missing.push("type");
  return { ok: missing.length === 0, missing };
}

/** Enum values of the `type` field, or [] when the contract is not met. */
export function memoryTypeValues(context: ContextLike): string[] {
  const type = context?.fields?.find((f) => f.name === "type");
  if (!type || type.type !== "enum") return [];
  return [...(type.enumValues ?? [])];
}
