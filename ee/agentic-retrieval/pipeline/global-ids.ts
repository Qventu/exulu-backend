/**
 * Parse a list of global preselected IDs into a per-context map.
 *
 * Two supported formats:
 *   "<context_id>/<item_id>" → specific item; value is a non-empty string[]
 *   "<context_id>"           → full context (no item filter); value is null
 *
 * If both a full-context entry and specific-item entries exist for the same
 * context, full-context (null) wins.
 */
export function parsePreselectedItems(globalIds: string[]): Map<string, string[] | null> {
  const map = new Map<string, string[] | null>();
  for (const gid of globalIds) {
    const slashIdx = gid.indexOf("/");
    if (slashIdx === -1) {
      // No slash → entire context selected
      if (gid) map.set(gid, null);
      continue;
    }
    const contextId = gid.slice(0, slashIdx);
    const itemId = gid.slice(slashIdx + 1);
    if (!contextId || !itemId) continue;
    // Full-context entry already wins — don't downgrade to specific items
    if (map.get(contextId) === null) continue;
    const existing = map.get(contextId) ?? [];
    existing.push(itemId);
    map.set(contextId, existing);
  }
  return map;
}
