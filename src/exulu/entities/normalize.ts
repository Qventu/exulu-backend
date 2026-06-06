import { createHash } from "crypto";
import type { EntityTypeDefinition } from "./types";

/**
 * Canonicalize an entity name into the resolution key. Deterministic: lowercase,
 * trim, collapse internal whitespace, and strip surrounding punctuation. Two
 * surface forms that normalize to the same key resolve to the same entity.
 */
export const normalizeCanonicalKey = (name: string): string => {
  return name
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "")
    .trim();
};

/**
 * Stable signature of the effective type set. Used to detect which items were
 * extracted with an out-of-date set of types (and therefore need backfill).
 * Order-independent: sorts the type names before hashing.
 */
export const computeTypesSignature = (types: EntityTypeDefinition[]): string => {
  const names = Array.from(new Set(types.map((t) => t.name.toLowerCase().trim())))
    .sort()
    .join("|");
  return createHash("sha1").update(names).digest("hex").slice(0, 16);
};
