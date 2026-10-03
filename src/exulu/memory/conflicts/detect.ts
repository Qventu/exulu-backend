import { CANDIDATE_MIN_SIMILARITY, DUPLICATE_MIN_SIMILARITY } from "./thresholds";

export type Pair = { a: string; b: string; similarity: number };
export type DuplicateGroup = { members: string[]; similarity: number };

export const sortIds = (ids: string[]): string[] => [...ids].sort();
export const pairKey = (context: string, a: string, b: string): string => `${context}:${sortIds([a, b]).join(",")}`;
export const groupKey = (context: string, kind: "duplicate" | "contradiction", ids: string[]): string =>
  `${context}:${kind}:${sortIds(ids).join(",")}`;

export function splitBands(pairs: Pair[]): { duplicatePairs: Pair[]; candidatePairs: Pair[] } {
  const duplicatePairs: Pair[] = [];
  const candidatePairs: Pair[] = [];
  for (const pair of pairs) {
    if (pair.similarity >= DUPLICATE_MIN_SIMILARITY) duplicatePairs.push(pair);
    else if (pair.similarity >= CANDIDATE_MIN_SIMILARITY) candidatePairs.push(pair);
  }
  return { duplicatePairs, candidatePairs };
}

/**
 * Connected components over duplicate pairs (union-find). A component larger
 * than `cap` keeps the `cap` members reached first when its pairs are walked in
 * descending similarity; pairs touching a dropped member become leftovers for
 * the next scan. Output is sorted (members and groups) so keys are stable.
 */
export function groupDuplicates(pairs: Pair[], cap: number): { groups: DuplicateGroup[]; leftover: Pair[] } {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
  for (const pair of pairs) union(pair.a, pair.b);

  const byRoot = new Map<string, Pair[]>();
  for (const pair of pairs) {
    const r = find(pair.a);
    byRoot.set(r, [...(byRoot.get(r) ?? []), pair]);
  }

  const groups: DuplicateGroup[] = [];
  const leftover: Pair[] = [];
  for (const componentPairs of byRoot.values()) {
    const sorted = [...componentPairs].sort((x, y) => y.similarity - x.similarity || `${x.a}${x.b}`.localeCompare(`${y.a}${y.b}`));
    const members = new Set<string>();
    for (const pair of sorted) {
      const fresh = [pair.a, pair.b].filter((id) => !members.has(id)).length;
      if (members.size + fresh <= cap) { members.add(pair.a); members.add(pair.b); }
    }
    for (const pair of sorted) if (!members.has(pair.a) || !members.has(pair.b)) leftover.push(pair);
    groups.push({ members: sortIds([...members]), similarity: sorted[0]!.similarity });
  }
  groups.sort((x, y) => x.members[0]!.localeCompare(y.members[0]!));
  leftover.sort((x, y) => `${x.a}${x.b}`.localeCompare(`${y.a}${y.b}`));
  return { groups, leftover };
}
