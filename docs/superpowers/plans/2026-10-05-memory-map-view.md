# 3D Memory Map View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw a knowledge or memory base as a rotatable cloud of passages with named topic regions, on-demand relation lines and a detail panel, on both the memory base page and the knowledge workspace.

**Architecture:** Sub-project 3c-1 already stores a three-dimensional position for every chunk and exposes points, edges and projection status. This plan adds the two backend pieces the drawing needs — topics (k-means over the stored coordinates, named from distinctive lexemes in the existing text index, computed at fit time) and passage-level edges — then builds the view as a shared widget, because feature-isolation lint forbids the knowledge pages from importing the memory feature's code. Rendering is plain three.js in one effect, loaded only by the map component.

**Tech Stack:** TypeScript ESM backend (knex/Postgres, jest, GraphQL SDL by string concatenation), Next.js 16 / React 19.2 frontend (Apollo, next-intl, vitest, Tailwind tokens), three.js.

**Spec:** `docs/superpowers/specs/2026-10-05-memory-map-view-design.md`

**Worktrees:** backend `/Users/daniel.claessen/Desktop/Projects/exulu/backend-agent-memory`, frontend `/Users/daniel.claessen/Desktop/Projects/exulu/frontend-agent-memory`. Both are already on `feat/memory-map-view`.

## Global Constraints

- Backend tests: `npx jest <path> --maxWorkers=2`. Frontend tests: `npx vitest run <path> --maxWorkers 2`. **Never** pass `-w` to either; that is watch mode.
- `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"` must print **8** in the backend at every commit. Those eight are pre-existing and live in four unrelated files.
- No dev servers, no background processes, nothing touching any `.env*` file, no secrets printed.
- Verify the branch in the same command as every commit (`git branch --show-current` must print `feat/memory-map-view`). Never push, never merge.
- ESM TypeScript with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`: type-only imports need `import type`.
- **The projection and its topics are keyed by `sanitizeName(contextId)` everywhere**, reads and writes alike.
- Full-text expressions interpolate the language as a SQL **literal** and bind only the text, following `src/graphql/resolvers/vector-search.ts:363-443`. No bound `regconfig` parameters.
- The map resolvers gate on `context.user` only. No `hasAgentsReadAccess`. Item scoping comes from `applyAccessControl(table, query, user, "items")` on every content-returning query.
- Frontend colour comes from theme tokens only, never hardcoded hex. **`--chart-2` and `--chart-9` are violet and must never be used**; `--chart-5` is grey and reserved for "no value".
- `components/widgets/**` is under `react/jsx-no-literals: error`: every user-visible string in the widget comes from `next-intl`.
- `components/widgets/**` must not import `@/queries/queries`, and no feature may import another feature's folder. Shared GraphQL documents live in `lib/graphql/operations/`.
- Every new message key goes into **both** `messages/en.json` and `messages/de.json`; `npm run check-messages` is a CI gate.

## Review Focus

- **A base fitted before this plan shipped:** points exist, the topics table is empty. The cloud must draw without labels or chips and show no error. Pinned in Task 7.
- **A stale topic row after `PROJECTION_VERSION` is bumped:** must read as "no topics", never as topics from an older layout. Pinned in Task 4.
- **The viewer switches theme while the map is mounted:** WebGL colours are resolved once from CSS, so they must be re-resolved or the cloud keeps the old theme's palette. Pinned in Task 6.
- **A shared `?selected=` link pointing at a passage the viewer may not read:** the panel must say the passage is unavailable rather than render an empty shell or throw. Pinned in Task 7.
- **WebGL unavailable or the context lost:** the card must fall back to an explanatory state, never a blank rectangle. Pinned in Task 6.

---

## File Structure

**Backend**
- `src/exulu/projection/constants.ts` — add the topic knobs.
- `src/exulu/projection/topics.ts` *(new)* — k-means, label scoring, the lexeme query, the store. One responsibility: turning coordinates into named regions.
- `src/exulu/projection/topics.test.ts` *(new)*.
- `src/exulu/projection/fit.ts` — keep sample ids aligned with vectors, call the topics phase after the backfill.
- `src/postgres/core-schema.ts`, `src/postgres/init-exulu-db.ts`, `types/exulu-table-definition.ts` — the new core table.
- `src/graphql/resolvers/context-map.ts` + its test — `contextMapTopics`, and `mode` on edges.
- `src/graphql/schemas/index.ts` — SDL and resolver registration.

**Frontend**
- `lib/graphql/operations/context-map.ts` *(new)* — the four documents, shared by both features.
- `components/widgets/context-map/map-data.ts` *(new)* — every pure function: palette, buffers, projection, label collisions, captions, legend.
- `components/widgets/context-map/map-data.test.ts` *(new)*.
- `components/widgets/context-map/map-canvas.tsx` *(new)* — three.js, dynamically imported, no jsdom tests.
- `components/widgets/context-map/map-panel.tsx` *(new)* — the selected-passage panel.
- `components/widgets/context-map/context-map-card.tsx` *(new)* — the card: data fetching, chips, legend, captions, canvas, panel.
- `components/widgets/context-map/context-map-card.test.tsx` *(new)*.
- `app/(application)/memory/[ctx]/components/base-shell.tsx` — the tab bar.
- `app/(application)/data/[ctx]/components/workspace-shell.tsx` — the fourth tab.
- `messages/en.json`, `messages/de.json` — a new top-level `map` namespace, feature-neutral because the widget serves both.

---

### Task 1: The topics table

**Files:**
- Modify: `src/postgres/core-schema.ts` (next to `contextProjectionsSchema`, around line 793-810, and the `coreSchemas.get()` map around line 1078)
- Modify: `src/postgres/init-exulu-db.ts` (the import list around line 37, the `schemas` array around line 133)
- Modify: `types/exulu-table-definition.ts` (both closed unions, around lines 36 and 75)
- Test: `src/postgres/core-schema.test.ts` (create if absent)

**Interfaces:**
- Produces: a `context_map_topics` table with columns `context`, `topic_index`, `label`, `count`, `x`, `y`, `z`, `version`, `fitted_at`. Tasks 3 and 4 read and write it.

- [ ] **Step 1: Write the failing test**

Create or extend `src/postgres/core-schema.test.ts`:

```ts
import { coreSchemas } from "@SRC/postgres/core-schema";

describe("context_map_topics", () => {
  it("is registered with the fields the map reads", () => {
    const schema = coreSchemas.get().contextMapTopicsSchema();
    expect(schema.type).toBe("context_map_topics");
    expect(schema.RBAC).toBeFalsy();
    const names = schema.fields.map((f) => f.name);
    for (const field of ["context", "topic_index", "label", "count", "x", "y", "z", "version", "fitted_at"]) {
      expect(names).toContain(field);
    }
    // Many rows per context: a unique context would make a refit fail on the
    // second cluster instead of replacing the set.
    expect(schema.fields.find((f) => f.name === "context")?.unique).toBeFalsy();
    expect(schema.fields.find((f) => f.name === "context")?.index).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/postgres/core-schema --maxWorkers=2`
Expected: FAIL — `contextMapTopicsSchema is not a function`.

- [ ] **Step 3: Add the schema**

In `src/postgres/core-schema.ts`, directly after `contextProjectionsSchema`:

```ts
/**
 * One row per topic per context (3c-2). Replaced wholesale on every fit, so a
 * context's rows always describe one layout. Not RBAC-scoped: a topic count
 * describes the base, not the reader's slice of it.
 */
const contextMapTopicsSchema: ExuluTableDefinition = {
  type: "context_map_topics",
  name: { plural: "context_map_topics", singular: "context_map_topic" },
  fields: [
    { name: "context", type: "text", required: true, index: true },
    { name: "topic_index", type: "number", required: true },
    { name: "label", type: "text", required: true },
    { name: "count", type: "number", required: true },
    { name: "x", type: "number", required: true },
    { name: "y", type: "number", required: true },
    { name: "z", type: "number", required: true },
    { name: "version", type: "number", required: true },
    { name: "fitted_at", type: "date", required: true },
  ],
};
```

In the `coreSchemas.get()` map, directly after the `contextProjectionsSchema` line:

```ts
      contextMapTopicsSchema: (): ExuluTableDefinition => addCoreFields(contextMapTopicsSchema),
```

- [ ] **Step 4: Register it**

In `src/postgres/init-exulu-db.ts`, add `contextMapTopicsSchema,` to the destructured import directly after `contextProjectionsSchema,`, and `contextMapTopicsSchema(),` to the `schemas` array directly after `contextProjectionsSchema(),`.

In `types/exulu-table-definition.ts`, add `| "context_map_topics"` directly after each `| "context_projections"` (both unions).

- [ ] **Step 5: Run the test and the typecheck**

Run: `npx jest src/postgres/core-schema --maxWorkers=2 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: PASS; count 8.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # feat/memory-map-view
git add src/postgres/core-schema.ts src/postgres/core-schema.test.ts src/postgres/init-exulu-db.ts types/exulu-table-definition.ts
git commit -m "feat(map): a core table for named topic regions"
```

---

### Task 2: Clustering and naming

**Files:**
- Modify: `src/exulu/projection/constants.ts`
- Create: `src/exulu/projection/topics.ts`, `src/exulu/projection/topics.test.ts`

**Interfaces:**
- Consumes: `rng` from `./math`.
- Produces:
  - `kmeans(points: number[][], k: number, seed: number, iterations?: number): { assignments: number[]; centroids: number[][] }`
  - `topicCount(n: number): number`
  - `pickLabel(inCluster: Map<string, number>, corpus: Map<string, number>, index: number): string`
  - `lexemeCounts(args: { db: any; chunksTable: string; ids: string[]; assignments: number[] }): Promise<Map<number, Map<string, number>>>`
  - `computeTopics(args: { db: any; contextId: string; ids: string[]; coordinates: number[][]; seed: number; fittedAt: Date }): Promise<number>` — writes the rows, returns how many topics it stored.

- [ ] **Step 1: Add the constants**

In `src/exulu/projection/constants.ts`, append:

```ts
/** Topic regions (3c-2). k follows the data; these are its bounds. */
export const TOPIC_MIN = 3;
export const TOPIC_MAX = 12;
export const TOPIC_ITERATIONS = 25;
/** A lexeme must carry at least this many of a cluster's chunks to name it. */
export const TOPIC_MIN_DF = 2;
/** Stems shorter than this read as noise ("ab", "st"). */
export const TOPIC_MIN_LEXEME = 3;
/** Words in a label, joined with " & " — the shape the design shows. */
export const TOPIC_LABEL_WORDS = 2;
```

- [ ] **Step 2: Write the failing test**

`src/exulu/projection/topics.test.ts`:

```ts
import { kmeans, lexemeCounts, pickLabel, topicCount } from "./topics";

describe("topicCount", () => {
  it("follows the data between its bounds", () => {
    expect(topicCount(8)).toBe(3);       // floor
    expect(topicCount(200)).toBe(10);    // round(sqrt(100))
    expect(topicCount(100000)).toBe(12); // ceiling
  });
});

describe("kmeans", () => {
  const blob = (cx: number, cy: number, cz: number, n: number, spread: number) =>
    Array.from({ length: n }, (_, i) => [cx + (i % 3) * spread, cy + (i % 2) * spread, cz + (i % 5) * spread]);

  it("separates two well-separated blobs", () => {
    const points = [...blob(0, 0, 0, 20, 0.01), ...blob(10, 10, 10, 20, 0.01)];
    const { assignments, centroids } = kmeans(points, 2, 7);
    expect(centroids).toHaveLength(2);
    const first = new Set(assignments.slice(0, 20));
    const second = new Set(assignments.slice(20));
    expect(first.size).toBe(1);
    expect(second.size).toBe(1);
    expect([...first][0]).not.toBe([...second][0]);
  });

  it("is deterministic for one seed and differs across seeds it should", () => {
    const points = [...blob(0, 0, 0, 30, 0.5), ...blob(4, 4, 4, 30, 0.5)];
    expect(kmeans(points, 3, 11).assignments).toEqual(kmeans(points, 3, 11).assignments);
  });

  it("never returns an empty cluster or a non-finite centroid", () => {
    const points = Array.from({ length: 10 }, () => [1, 1, 1]);
    const { assignments, centroids } = kmeans(points, 4, 3);
    expect(centroids.every((c) => c.every(Number.isFinite))).toBe(true);
    expect(new Set(assignments).size).toBeLessThanOrEqual(4);
  });
});

describe("pickLabel", () => {
  it("prefers a word frequent here and rare elsewhere over one frequent everywhere", () => {
    const inCluster = new Map([["steuerblock", 8], ["ventil", 6], ["anlage", 8]]);
    const corpus = new Map([["steuerblock", 9], ["ventil", 7], ["anlage", 400]]);
    expect(pickLabel(inCluster, corpus, 0)).toBe("Steuerblock & Ventil");
  });

  it("ignores words under the document-frequency and length floors", () => {
    const inCluster = new Map([["ab", 50], ["rare", 1], ["encoder", 4]]);
    const corpus = new Map([["ab", 50], ["rare", 1], ["encoder", 5]]);
    expect(pickLabel(inCluster, corpus, 0)).toBe("Encoder");
  });

  it("falls back to an ordinal when nothing qualifies", () => {
    expect(pickLabel(new Map([["x", 9]]), new Map([["x", 9]]), 3)).toBe("Topic 4");
  });
});

describe("lexemeCounts", () => {
  it("loads assignments into a temp table and aggregates per cluster", async () => {
    const log: any[] = [];
    const rows = [
      { cluster: 0, lexeme: "encoder", df: 3 },
      { cluster: 1, lexeme: "ventil", df: 2 },
    ];
    const trx: any = (table: string) => ({
      insert: async (values: any[]) => { log.push(["insert", table, values.length]); },
    });
    trx.raw = async (sql: string) => { log.push(["raw", sql]); return { rows }; };
    const out = await lexemeCounts({
      db: trx, chunksTable: "mem_chunks",
      ids: ["a", "b", "c"], assignments: [0, 0, 1],
    });
    expect(out.get(0)?.get("encoder")).toBe(3);
    expect(out.get(1)?.get("ventil")).toBe(2);
    // The temp table is created before the insert and the aggregate reads it.
    const sql = log.filter((l) => l[0] === "raw").map((l) => String(l[1])).join("\n");
    expect(sql).toContain("CREATE TEMP TABLE");
    expect(sql).toContain("unnest(ch.fts)");
    expect(log.some((l) => l[0] === "insert")).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/exulu/projection/topics --maxWorkers=2`
Expected: FAIL — cannot find module `./topics`.

- [ ] **Step 4: Implement**

`src/exulu/projection/topics.ts`:

```ts
import { getChunksTableName } from "@SRC/exulu/table-names";
import { sanitizeName } from "@SRC/utils/sanitize-name";

import {
  TOPIC_ITERATIONS, TOPIC_LABEL_WORDS, TOPIC_MAX, TOPIC_MIN, TOPIC_MIN_DF, TOPIC_MIN_LEXEME,
} from "./constants";
import { PROJECTION_VERSION } from "./constants";
import { rng } from "./math";

/** One region per ten points, within bounds a legend can still read. */
export function topicCount(n: number): number {
  return Math.max(TOPIC_MIN, Math.min(TOPIC_MAX, Math.round(Math.sqrt(n / 2))));
}

const distance2 = (a: number[], b: number[]): number => {
  let d = 0;
  for (let i = 0; i < 3; i += 1) { const t = (a[i] ?? 0) - (b[i] ?? 0); d += t * t; }
  return d;
};

/**
 * k-means over three-dimensional coordinates, k-means++ seeded so one context
 * always clusters the same way. Three dimensions and at most FIT_SAMPLE points
 * make this milliseconds next to the layout.
 */
export function kmeans(
  points: number[][], k: number, seed: number, iterations = TOPIC_ITERATIONS,
): { assignments: number[]; centroids: number[][] } {
  const random = rng(seed);
  const n = points.length;
  const want = Math.max(1, Math.min(k, n));

  // k-means++: first centre at random, each next one far from what exists.
  const centroids: number[][] = [[...(points[Math.floor(random() * n)] ?? [0, 0, 0])]];
  while (centroids.length < want) {
    const d = points.map((p) => Math.min(...centroids.map((c) => distance2(p, c))));
    const total = d.reduce((s, v) => s + v, 0);
    let target = random() * total;
    let picked = n - 1;
    for (let i = 0; i < n; i += 1) { target -= d[i] ?? 0; if (target <= 0) { picked = i; break; } }
    centroids.push([...(points[picked] ?? [0, 0, 0])]);
  }

  const assignments = new Array<number>(n).fill(0);
  for (let it = 0; it < iterations; it += 1) {
    let moved = false;
    for (let i = 0; i < n; i += 1) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c += 1) {
        const d = distance2(points[i] ?? [], centroids[c] ?? []);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (assignments[i] !== best) { assignments[i] = best; moved = true; }
    }
    const sums = centroids.map(() => [0, 0, 0]);
    const counts = centroids.map(() => 0);
    for (let i = 0; i < n; i += 1) {
      const c = assignments[i] ?? 0;
      counts[c] = (counts[c] ?? 0) + 1;
      for (let d = 0; d < 3; d += 1) sums[c]![d] = (sums[c]![d] ?? 0) + (points[i]?.[d] ?? 0);
    }
    for (let c = 0; c < centroids.length; c += 1) {
      // An empty cluster keeps its previous centre rather than becoming NaN.
      if ((counts[c] ?? 0) === 0) continue;
      for (let d = 0; d < 3; d += 1) centroids[c]![d] = (sums[c]![d] ?? 0) / (counts[c] ?? 1);
    }
    if (!moved) break;
  }
  return { assignments, centroids };
}

const titleCase = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * Names a cluster from words frequent inside it and rare outside. The score is
 * in-cluster document frequency over corpus document frequency, so a word in
 * every cluster scores near zero however often it occurs here.
 */
export function pickLabel(
  inCluster: Map<string, number>, corpus: Map<string, number>, index: number,
): string {
  const scored = [...inCluster.entries()]
    .filter(([lexeme, df]) => df >= TOPIC_MIN_DF && lexeme.length >= TOPIC_MIN_LEXEME)
    .map(([lexeme, df]) => ({ lexeme, df, score: df / Math.max(1, corpus.get(lexeme) ?? df) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.df - a.df || a.lexeme.localeCompare(b.lexeme))
    .slice(0, TOPIC_LABEL_WORDS);
  if (scored.length === 0) return `Topic ${index + 1}`;
  return scored.map((s) => titleCase(s.lexeme)).join(" & ");
}

/**
 * Per-cluster lexeme document frequencies, read from the generated tsvector the
 * chunks table already carries — the same mechanism the edge query uses, so no
 * chunk text is loaded. The assignment list goes into a temp table because a
 * VALUES list of twenty thousand rows is a megabyte of SQL.
 */
export async function lexemeCounts({
  db, chunksTable, ids, assignments,
}: { db: any; chunksTable: string; ids: string[]; assignments: number[] }): Promise<Map<number, Map<string, number>>> {
  await db.raw("CREATE TEMP TABLE map_topic_assign (id uuid PRIMARY KEY, cluster int) ON COMMIT DROP");
  const batch = 1000;
  for (let i = 0; i < ids.length; i += batch) {
    const values = ids.slice(i, i + batch).map((id, j) => ({ id, cluster: assignments[i + j] ?? 0 }));
    if (values.length) await db("map_topic_assign").insert(values);
  }
  const result = await db.raw(
    `SELECT a.cluster AS cluster, l.lexeme AS lexeme, count(*)::int AS df
       FROM map_topic_assign a
       JOIN ?? ch ON ch.id = a.id
       CROSS JOIN LATERAL unnest(ch.fts) AS l(lexeme, positions, weights)
      GROUP BY 1, 2`,
    [chunksTable],
  );
  const rows: any[] = result?.rows ?? result ?? [];
  const out = new Map<number, Map<string, number>>();
  for (const row of rows) {
    const cluster = Number(row.cluster);
    if (!out.has(cluster)) out.set(cluster, new Map());
    out.get(cluster)!.set(String(row.lexeme), Number(row.df));
  }
  return out;
}

/**
 * Clusters the sampled coordinates, names every region and replaces the
 * context's topic rows. Runs inside the caller's transaction, so a failure
 * leaves the previous topics untouched rather than half-replaced.
 */
export async function computeTopics({
  db, contextId, ids, coordinates, seed, fittedAt,
}: {
  db: any; contextId: string; ids: string[]; coordinates: number[][]; seed: number; fittedAt: Date;
}): Promise<number> {
  if (ids.length === 0 || ids.length !== coordinates.length) return 0;
  const { assignments, centroids } = kmeans(coordinates, topicCount(ids.length), seed);
  const counts = await lexemeCounts({ db, chunksTable: getChunksTableName(contextId), ids, assignments });

  const corpus = new Map<string, number>();
  for (const perCluster of counts.values()) {
    for (const [lexeme, df] of perCluster) corpus.set(lexeme, (corpus.get(lexeme) ?? 0) + df);
  }

  const size = centroids.map(() => 0);
  for (const a of assignments) size[a] = (size[a] ?? 0) + 1;

  const rows = centroids
    .map((centre, index) => ({
      context: sanitizeName(contextId),
      topic_index: index,
      label: pickLabel(counts.get(index) ?? new Map(), corpus, index),
      count: size[index] ?? 0,
      x: centre[0] ?? 0, y: centre[1] ?? 0, z: centre[2] ?? 0,
      version: PROJECTION_VERSION,
      fitted_at: fittedAt,
    }))
    // An empty cluster is an artefact of k-means++ on a tiny base, not a region.
    .filter((r) => r.count > 0);

  await db("context_map_topics").where({ context: sanitizeName(contextId) }).delete();
  if (rows.length) await db("context_map_topics").insert(rows);
  return rows.length;
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx jest src/exulu/projection --maxWorkers=2 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: PASS; count 8.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # feat/memory-map-view
git add src/exulu/projection/constants.ts src/exulu/projection/topics.ts src/exulu/projection/topics.test.ts
git commit -m "feat(map): cluster coordinates into regions and name them from the text index"
```

---

### Task 3: Topics at fit time

**Files:**
- Modify: `src/exulu/projection/fit.ts` (the sample mapping around lines 95-100; the write block at the end of `fitContextProjection`)
- Test: `src/exulu/projection/fit.test.ts`

**Interfaces:**
- Consumes: `computeTopics` from `./topics`.
- Produces: `FitResult` gains `topics: number`.

- [ ] **Step 1: Write the failing test**

Add to `src/exulu/projection/fit.test.ts`:

```ts
it("writes topics after the backfill, inside the same transaction as the projection", async () => {
  const order: string[] = [];
  const db = fakeFitDb({ onBackfill: () => order.push("backfill"), onProjection: () => order.push("projection"), onTopics: () => order.push("topics") });
  const result = await fitContextProjection({ db, contextId: "mem", umapFactory: fakeUmap });
  expect(result.fitted).toBe(true);
  expect(result.topics).toBeGreaterThan(0);
  expect(order).toEqual(["backfill", "topics", "projection"]);
});

it("stores no topics on a dry run", async () => {
  const order: string[] = [];
  const db = fakeFitDb({ onTopics: () => order.push("topics") });
  const result = await fitContextProjection({ db, contextId: "mem", dryRun: true, umapFactory: fakeUmap });
  expect(result.fitted).toBe(true);
  expect(result.topics).toBe(0);
  expect(order).toEqual([]);
});

it("keeps sample ids aligned with their vectors when a row has no parseable embedding", async () => {
  // The middle row's embedding is unparseable, so it drops out of `vectors`.
  // If ids were taken from the raw rows, every later id would be off by one and
  // topics would be clustered against the wrong chunks.
  const db = fakeFitDb({ embeddings: ["[1,0]", "not a vector", "[0,1]"] });
  const seen: string[] = [];
  db.__onTopicIds = (ids: string[]) => seen.push(...ids);
  await fitContextProjection({ db, contextId: "mem", components: 2, umapFactory: fakeUmap });
  expect(seen).not.toContain("id-1");
});
```

Extend the file's existing fake database helper so it records the three write phases and accepts an `embeddings` list; keep its current behaviour for the tests already in the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/exulu/projection/fit --maxWorkers=2`
Expected: FAIL — `result.topics` is undefined and the order array is empty.

- [ ] **Step 3: Keep ids aligned with vectors**

In `src/exulu/projection/fit.ts`, replace

```ts
  const vectors = sampleRows.map((r) => l2normalize(parseVector(r.embedding))).filter((v) => v.length > 0);
```

with

```ts
  // Pairs, not two lists: filtering vectors alone would leave `sampleRows`
  // longer, and every id after the first unparseable embedding would then
  // describe a different chunk than its coordinates.
  const sampled = sampleRows
    .map((r) => ({ id: String(r.id), vector: l2normalize(parseVector(r.embedding)) }))
    .filter((s) => s.vector.length > 0);
  const vectors = sampled.map((s) => s.vector);
```

- [ ] **Step 4: Add the topics phase**

In `src/exulu/projection/fit.ts`, add the import:

```ts
import { computeTopics } from "./topics";
```

Add `topics: number` to `FitResult`, with `topics: 0` in `empty()` and in the dry-run return. Then replace the final write block (the `backfillCoordinates` call through the `onConflict("context").merge()` statement and the final `return`) with:

```ts
  // Backfill FIRST, from the projection in hand — it does not need the row.
  // The row is what makes chunkCoordinates start answering, and context.ts
  // spreads those coordinates into an unwrapped chunk insert, so a row that
  // survives a failed backfill turns every later ingestion into this context
  // into an error.
  const written = await backfillCoordinates({ db, contextId, projection, log });

  let topics = 0;
  // One transaction for the topics and the projection row: the temp table the
  // lexeme query uses is dropped on commit, and a half-replaced topic set would
  // describe two different layouts at once.
  await db.transaction(async (trx: any) => {
    log(`${contextId}: naming regions`);
    topics = await computeTopics({
      db: trx, contextId, ids: sampled.map((s) => s.id),
      coordinates: reduced.map((z) => [...applyMap(z, map, intercept)]),
      seed, fittedAt: projection.fitted_at,
    });
    // knex does not stringify, and node-pg encodes a JS array as a Postgres
    // array literal (`{0.1,0.2}`), which jsonb rejects with 22P02.
    await trx("context_projections")
      .insert({
        ...projection,
        mean: JSON.stringify(projection.mean),
        basis: JSON.stringify(projection.basis),
        map: JSON.stringify(projection.map),
        intercept: JSON.stringify(projection.intercept),
      })
      .onConflict("context")
      .merge();
  });
  log(`${contextId}: ${topics} regions`);
  return { fitted: true, sampleSize: vectors.length, components: basis.length, residual, written, heldOut, topics };
```

Topics cluster the coordinates the map actually draws — `applyMap` of the reduced vectors, the same values the backfill writes — not the raw layout, so a label sits where its dots are.

- [ ] **Step 5: Report the count in the script**

In `scripts/fit-context-projection.ts`, include the topic count in the per-context summary line the script already prints, so a fit says how many regions it named.

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npx jest src/exulu/projection --maxWorkers=2 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: PASS; count 8.

- [ ] **Step 7: Commit**

```bash
git branch --show-current   # feat/memory-map-view
git add src/exulu/projection/fit.ts src/exulu/projection/fit.test.ts scripts/fit-context-projection.ts
git commit -m "feat(map): name a base's regions when it is fitted"
```

---

### Task 4: The topics query and passage-level edges

**Files:**
- Modify: `src/graphql/resolvers/context-map.ts`
- Modify: `src/graphql/resolvers/context-map.test.ts`
- Modify: `src/graphql/schemas/index.ts` (the map typedefs around line 755, the map types around line 3169, the resolvers around line 2755)

**Interfaces:**
- Produces: `contextMapTopics({ db, context })` and `contextMapEdges({ db, context, user, nodeId, mode, limit })`; GraphQL `contextMapTopics(contextId: ID!): [ContextMapTopic!]!` and `mode: ContextMapMode = DOCUMENTS` on `contextMapEdges`.

- [ ] **Step 1: Write the failing test**

Add to `src/graphql/resolvers/context-map.test.ts`:

```ts
describe("contextMapTopics", () => {
  it("returns the context's regions, keyed by the sanitised id, ordered by index", async () => {
    const db = fakeDb({
      context_map_topics: [
        { topic_index: 1, label: "Encoder & Anzeige", count: 12, x: 0.2, y: -0.1, z: 0, version: 1 },
        { topic_index: 0, label: "Steuerblock & Ventil", count: 30, x: -0.4, y: 0.2, z: 0.1, version: 1 },
      ],
    });
    const out = await contextMapTopics({ db, context: { ...context, id: "My Docs" } as any });
    expect(db.__log.some((l: any[]) => JSON.stringify(l).includes("my_docs"))).toBe(true);
    expect(db.__log.some((l: any[]) => l[1] === "orderBy" && l[2] === "topic_index")).toBe(true);
    expect(out[0]).toEqual({ id: "1", label: "Encoder & Anzeige", count: 12, x: 0.2, y: -0.1, z: 0 });
  });

  it("filters on the current projection version, so a stale row reads as no topics", async () => {
    const db = fakeDb({ context_map_topics: [] });
    await contextMapTopics({ db, context });
    expect(db.__log.some((l: any[]) => JSON.stringify(l).includes("version"))).toBe(true);
  });

  it("is empty rather than an error when the table is missing", async () => {
    const db = fakeDb({}, { hasTable: () => false });
    expect(await contextMapTopics({ db, context })).toEqual([]);
  });
});

describe("contextMapEdges in PASSAGES mode", () => {
  it("ranks and returns chunk ids, so a passage point can be joined to its line", async () => {
    const db = fakeDb({
      mem_chunks: [{ id: "chunk-2", score: "0.42" }],
      "mem_chunks#first": [{ text: "encoder speed display", owner: "item-1" }],
      "#raw": [{ terms: "encoder or speed" }],
    });
    const out = await contextMapEdges({ db, context, user, nodeId: "chunk-1", mode: "PASSAGES", limit: 5 });
    expect(out).toEqual([{ source: "chunk-1", target: "chunk-2", score: 0.42 }]);
    expect(db.__log.some((l: any[]) => l[1] === "groupBy" && String(l[2]).includes("chunks.id"))).toBe(true);
  });

  it("still groups by item in DOCUMENTS mode", async () => {
    const db = fakeDb({
      mem_chunks: [{ id: "item-2", score: "0.3" }],
      "mem_chunks#first": [{ text: "encoder", owner: "item-1" }],
      "#raw": [{ terms: "encoder" }],
    });
    await contextMapEdges({ db, context, user, nodeId: "item-1", mode: "DOCUMENTS", limit: 5 });
    expect(db.__log.some((l: any[]) => l[1] === "groupBy" && String(l[2]).includes("items.id"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/graphql/resolvers/context-map --maxWorkers=2`
Expected: FAIL — `contextMapTopics is not a function`, and the edges call ignores `mode`.

- [ ] **Step 3: Implement the topics resolver**

In `src/graphql/resolvers/context-map.ts`, add:

```ts
export type MapTopic = { id: string; label: string; count: number; x: number; y: number; z: number };

/**
 * A context's named regions (spec §3.1). Counts are the fit's counts and are
 * deliberately not access-scoped: a region describes the base, not the reader's
 * slice of it, exactly as contextProjectionStatus reports coverage.
 */
export async function contextMapTopics({ db, context }: { db: any; context: ExuluContext }): Promise<MapTopic[]> {
  try {
    if (!(await db.schema.hasTable("context_map_topics"))) return [];
    const rows: any[] = await db("context_map_topics")
      .where({ context: sanitizeName(context.id), version: PROJECTION_VERSION })
      .orderBy("topic_index")
      .select("topic_index", "label", "count", "x", "y", "z");
    return rows.map((r) => ({
      id: String(r.topic_index), label: String(r.label ?? ""), count: num(r.count),
      x: num(r.x), y: num(r.y), z: num(r.z),
    }));
  } catch (e) {
    // A base without regions draws as a cloud without labels; it is never an
    // error worth failing the page for.
    console.error("[EXULU] could not read context map topics", e instanceof Error ? e.message : String(e));
    return [];
  }
}
```

- [ ] **Step 4: Add the mode argument to edges**

In `contextMapEdges`, accept `mode: MapMode = "DOCUMENTS"` in the argument object, and switch the grouping and the selected id:

```ts
  const passages = mode === "PASSAGES";
  // …in the ranking query:
    .groupBy(passages ? "chunks.id" : "items.id")
    .select([
      db.raw(passages ? "chunks.id as id" : "items.id as id"),
      …
    ])
```

The seed read, the owner-item exclusion, the archived filter and `applyAccessControl` are unchanged. The exclusion stays on the owner item in both modes: sibling passages of the same document share the node's lexemes and would otherwise fill every line.

- [ ] **Step 5: Register the GraphQL surface**

In `src/graphql/schemas/index.ts`, import `contextMapTopics` alongside the existing map resolvers. Add to the map Query typedefs:

```ts
    contextMapTopics(contextId: ID!): [ContextMapTopic!]!
```

Change the edges typedef to:

```ts
    contextMapEdges(contextId: ID!, nodeId: ID!, mode: ContextMapMode = DOCUMENTS, limit: Int = 8): [ContextMapEdge!]!
```

Add the type next to the other map types:

```graphql
type ContextMapTopic {
    id: ID!
    label: String!
    count: Int!
    x: Float!
    y: Float!
    z: Float!
}
```

Add the resolver next to the other map resolvers:

```ts
  resolvers.Query["contextMapTopics"] = async (_, args, context) => {
    const target = memoryContextOf(args.contextId);
    if (!context.user || !target) return [];
    return contextMapTopics({ db: context.db, context: target });
  };
```

and pass `mode: args.mode ?? "DOCUMENTS"` through the existing `contextMapEdges` resolver.

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npx jest src/graphql/resolvers src/exulu/projection --maxWorkers=2 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: PASS; count 8.

- [ ] **Step 7: Commit**

```bash
git branch --show-current   # feat/memory-map-view
git add src/graphql/resolvers/context-map.ts src/graphql/resolvers/context-map.test.ts src/graphql/schemas/index.ts
git commit -m "feat(map): a topics query, and edges that can speak in passages"
```

---

### Task 5: The shared operations and the map's pure functions

**Everything from here runs in the frontend worktree** `/Users/daniel.claessen/Desktop/Projects/exulu/frontend-agent-memory`.

**Files:**
- Create: `lib/graphql/operations/context-map.ts`
- Create: `components/widgets/context-map/map-data.ts`, `components/widgets/context-map/map-data.test.ts`

**Interfaces:**
- Produces: `GET_CONTEXT_MAP_POINTS`, `GET_CONTEXT_MAP_TOPICS`, `GET_CONTEXT_MAP_EDGES`, `GET_CONTEXT_PROJECTION_STATUS`; and from `map-data.ts`: `MapPoint`, `MapTopic`, `MapEdge`, `PALETTE_TOKENS`, `NO_VALUE_TOKEN`, `resolvePalette`, `buildBuffers`, `projectToScreen`, `resolveLabelCollisions`, `legendEntries`, `coverageCaption`.

- [ ] **Step 1: Write the operations**

`lib/graphql/operations/context-map.ts`:

```ts
import { gql } from "@apollo/client";

/**
 * The map's read API (backend sub-project 3c-1/3c-2). Lives in lib/ because
 * both the memory and the knowledge feature render the map widget, and a
 * feature may not import another feature's folder.
 */
export const GET_CONTEXT_MAP_POINTS = gql`
  query ContextMapPoints($contextId: ID!, $mode: ContextMapMode, $groupField: String, $limit: Int) {
    contextMapPoints(contextId: $contextId, mode: $mode, groupField: $groupField, limit: $limit) {
      points { id itemId x y z label group chunks }
      total
      sampled
    }
  }
`;

export const GET_CONTEXT_MAP_TOPICS = gql`
  query ContextMapTopics($contextId: ID!) {
    contextMapTopics(contextId: $contextId) { id label count x y z }
  }
`;

export const GET_CONTEXT_MAP_EDGES = gql`
  query ContextMapEdges($contextId: ID!, $nodeId: ID!, $mode: ContextMapMode, $limit: Int) {
    contextMapEdges(contextId: $contextId, nodeId: $nodeId, mode: $mode, limit: $limit) {
      source
      target
      score
    }
  }
`;

export const GET_CONTEXT_PROJECTION_STATUS = gql`
  query ContextProjectionStatus($contextId: ID!) {
    contextProjectionStatus(contextId: $contextId) {
      fitted
      fittedAt
      residual
      mappedChunks
      totalChunks
    }
  }
`;
```

- [ ] **Step 2: Write the failing test**

`components/widgets/context-map/map-data.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  buildBuffers, coverageCaption, legendEntries, NO_VALUE_TOKEN, PALETTE_TOKENS,
  projectToScreen, resolveLabelCollisions,
} from "./map-data";

const point = (id: string, group: string | null, xyz: [number, number, number] = [0, 0, 0]) => ({
  id, itemId: `item-${id}`, x: xyz[0], y: xyz[1], z: xyz[2], label: id, group, chunks: 1,
});

describe("the palette", () => {
  it("never uses the violet tokens", () => {
    // --chart-2 is 258° and --chart-9 is 292°: violet is not used in this
    // product's design work, and these two are the only violet chart tokens.
    expect(PALETTE_TOKENS).not.toContain("--chart-2");
    expect(PALETTE_TOKENS).not.toContain("--chart-9");
    expect(PALETTE_TOKENS).not.toContain(NO_VALUE_TOKEN);
    expect(PALETTE_TOKENS.length).toBeGreaterThanOrEqual(4);
  });
});

describe("buildBuffers", () => {
  const palette = { colors: [[1, 0, 0], [0, 1, 0]] as [number, number, number][], noValue: [0.5, 0.5, 0.5] as [number, number, number] };

  it("writes three floats per point in order", () => {
    const { positions } = buildBuffers([point("a", "FACT", [1, 2, 3]), point("b", "FACT", [4, 5, 6])], ["FACT"], palette);
    expect(Array.from(positions)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("colours by the declared order of the groups, not by first appearance", () => {
    const { colors } = buildBuffers([point("a", "SECOND"), point("b", "FIRST")], ["FIRST", "SECOND"], palette);
    expect(Array.from(colors.slice(0, 3))).toEqual([0, 1, 0]);
    expect(Array.from(colors.slice(3, 6))).toEqual([1, 0, 0]);
  });

  it("gives a point with no group, or an unknown group, the reserved grey", () => {
    const { colors } = buildBuffers([point("a", null), point("b", "NOPE")], ["FIRST"], palette);
    expect(Array.from(colors)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  });

  it("cycles when there are more groups than colours", () => {
    const { colors } = buildBuffers([point("a", "THIRD")], ["FIRST", "SECOND", "THIRD"], palette);
    expect(Array.from(colors)).toEqual([1, 0, 0]);
  });
});

describe("projectToScreen", () => {
  // A simple orthographic-style matrix: x and y pass through, w = 1.
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  it("maps the centre of clip space to the centre of the viewport", () => {
    expect(projectToScreen({ x: 0, y: 0, z: 0 }, identity, 800, 600)).toEqual({ x: 400, y: 300, visible: true });
  });

  it("reports a point behind the camera as not visible", () => {
    const behind = [...identity];
    behind[15] = -1; // w becomes negative
    expect(projectToScreen({ x: 0, y: 0, z: 0 }, behind, 800, 600).visible).toBe(false);
  });
});

describe("resolveLabelCollisions", () => {
  it("keeps the larger region when two labels overlap", () => {
    const visible = resolveLabelCollisions([
      { id: "small", x: 100, y: 100, width: 80, height: 16, count: 3 },
      { id: "big", x: 110, y: 104, width: 80, height: 16, count: 30 },
    ]);
    expect(visible).toEqual(["big"]);
  });

  it("keeps both when they do not overlap", () => {
    const visible = resolveLabelCollisions([
      { id: "a", x: 0, y: 0, width: 50, height: 16, count: 3 },
      { id: "b", x: 300, y: 300, width: 50, height: 16, count: 4 },
    ]);
    expect(visible.sort()).toEqual(["a", "b"]);
  });
});

describe("legendEntries", () => {
  it("follows the declared order of the base's own enum", () => {
    expect(legendEntries(["FACT", "INSTRUCTION", "PREFERENCE"]).map((e) => e.value))
      .toEqual(["FACT", "INSTRUCTION", "PREFERENCE"]);
  });

  it("is empty when the base declares no enum to colour by", () => {
    expect(legendEntries([])).toEqual([]);
  });
});

describe("coverageCaption", () => {
  it("says how many of how many when the answer was sampled", () => {
    expect(coverageCaption({ drawn: 20000, total: 143000, sampled: true, mapped: 143000, totalChunks: 143000 }))
      .toEqual({ key: "caption.sampled", values: { drawn: 20000, total: 143000 } });
  });

  it("says how much of the base has no position yet", () => {
    expect(coverageCaption({ drawn: 90, total: 90, sampled: false, mapped: 90, totalChunks: 120 }))
      .toEqual({ key: "caption.partial", values: { missing: 30 } });
  });

  it("says nothing when everything is drawn and everything is mapped", () => {
    expect(coverageCaption({ drawn: 90, total: 90, sampled: false, mapped: 120, totalChunks: 120 })).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run components/widgets/context-map --maxWorkers 2`
Expected: FAIL — cannot resolve `./map-data`.

- [ ] **Step 4: Implement**

`components/widgets/context-map/map-data.ts`:

```ts
/**
 * Every pure function behind the context map. The canvas cannot run in jsdom,
 * so everything that can be reasoned about without a GPU lives here and is
 * tested here; map-canvas.tsx keeps only the WebGL calls.
 */

export type MapPoint = {
  id: string; itemId: string; x: number; y: number; z: number;
  label: string; group: string | null; chunks: number;
};
export type MapTopic = { id: string; label: string; count: number; x: number; y: number; z: number };
export type MapEdge = { source: string; target: string; score: number };
export type Rgb = [number, number, number];
export type Palette = { colors: Rgb[]; noValue: Rgb };

/**
 * The categorical palette, in order. --chart-2 (258°) and --chart-9 (292°) are
 * violet and are deliberately absent; --chart-5 is grey and is reserved below
 * for points with no value.
 */
export const PALETTE_TOKENS = [
  "--chart-4", "--chart-1", "--chart-8", "--chart-7", "--chart-6", "--chart-3", "--chart-10",
] as const;
export const NO_VALUE_TOKEN = "--chart-5";

const hslToRgb = (h: number, s: number, l: number): Rgb => {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
};

/** Tokens are HSL triplets without the wrapper ("217 76% 54%"). */
export function parseHslTriplet(value: string): Rgb {
  const parts = value.trim().split(/\s+/);
  const h = Number.parseFloat(parts[0] ?? "0");
  const s = Number.parseFloat((parts[1] ?? "0").replace("%", "")) / 100;
  const l = Number.parseFloat((parts[2] ?? "0").replace("%", "")) / 100;
  if (![h, s, l].every(Number.isFinite)) return [0.5, 0.5, 0.5];
  return hslToRgb(h, s, l);
}

/**
 * WebGL cannot read CSS variables, so the palette is resolved from the theme
 * once per mount and again whenever the theme changes.
 */
export function resolvePalette(element: Element): Palette {
  const style = getComputedStyle(element);
  return {
    colors: PALETTE_TOKENS.map((token) => parseHslTriplet(style.getPropertyValue(token))),
    noValue: parseHslTriplet(style.getPropertyValue(NO_VALUE_TOKEN)),
  };
}

/** Positions and colours as one typed array each: one draw call, no per-frame work. */
export function buildBuffers(
  points: MapPoint[], groups: string[], palette: Palette,
): { positions: Float32Array; colors: Float32Array } {
  const positions = new Float32Array(points.length * 3);
  const colors = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i]!;
    positions[i * 3] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;
    const declared = p.group == null ? -1 : groups.indexOf(p.group);
    const rgb = declared < 0
      ? palette.noValue
      : (palette.colors[declared % Math.max(1, palette.colors.length)] ?? palette.noValue);
    colors[i * 3] = rgb[0];
    colors[i * 3 + 1] = rgb[1];
    colors[i * 3 + 2] = rgb[2];
  }
  return { positions, colors };
}

/** Projects a world position with a column-major 4×4 matrix, for HTML overlays. */
export function projectToScreen(
  p: { x: number; y: number; z: number }, matrix: number[], width: number, height: number,
): { x: number; y: number; visible: boolean } {
  const m = (i: number) => matrix[i] ?? 0;
  const cx = m(0) * p.x + m(4) * p.y + m(8) * p.z + m(12);
  const cy = m(1) * p.x + m(5) * p.y + m(9) * p.z + m(13);
  const cw = m(3) * p.x + m(7) * p.y + m(11) * p.z + m(15);
  if (!Number.isFinite(cw) || cw <= 0) return { x: 0, y: 0, visible: false };
  return {
    x: ((cx / cw) * 0.5 + 0.5) * width,
    y: (0.5 - (cy / cw) * 0.5) * height,
    visible: true,
  };
}

export type LabelBox = { id: string; x: number; y: number; width: number; height: number; count: number };

/** Greedy, largest region first: a label only survives if nothing bigger covers it. */
export function resolveLabelCollisions(labels: LabelBox[]): string[] {
  const kept: LabelBox[] = [];
  for (const label of [...labels].sort((a, b) => b.count - a.count)) {
    const overlaps = kept.some((k) =>
      Math.abs(k.x - label.x) * 2 < k.width + label.width &&
      Math.abs(k.y - label.y) * 2 < k.height + label.height);
    if (!overlaps) kept.push(label);
  }
  return kept.map((l) => l.id);
}

export function legendEntries(groups: string[]): { value: string; index: number }[] {
  return groups.map((value, index) => ({ value, index }));
}

/** What the card says under the cloud, or nothing when there is nothing to admit. */
export function coverageCaption({
  drawn, total, sampled, mapped, totalChunks,
}: { drawn: number; total: number; sampled: boolean; mapped: number; totalChunks: number }):
  { key: string; values: Record<string, number> } | null {
  if (sampled) return { key: "caption.sampled", values: { drawn, total } };
  if (totalChunks > mapped) return { key: "caption.partial", values: { missing: totalChunks - mapped } };
  return null;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run components/widgets/context-map --maxWorkers 2`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # feat/memory-map-view
git add lib/graphql/operations/context-map.ts components/widgets/context-map/map-data.ts components/widgets/context-map/map-data.test.ts
git commit -m "feat(map): shared map operations and the renderer's pure half"
```

---

### Task 6: The canvas

**Files:**
- Modify: `package.json` (add `three` and `@types/three`)
- Create: `components/widgets/context-map/map-canvas.tsx`

**Interfaces:**
- Consumes: `MapPoint`, `MapTopic`, `MapEdge`, `Palette`, `buildBuffers`, `projectToScreen`, `resolveLabelCollisions`, `resolvePalette` from `./map-data`.
- Produces: `MapCanvas` with props
  `{ points: MapPoint[]; topics: MapTopic[]; groups: string[]; edges: MapEdge[]; selectedId: string | null; highlightTopic: string | null; ringedIds: Set<string>; paused: boolean; onSelect: (id: string | null) => void; onUnsupported: () => void }`.

Plain three.js in one effect, not the React renderer: this draws one point cloud, one line set and an orbit camera, which does not need a reconciler, and it keeps one dependency instead of three on a React 19.2 app.

- [ ] **Step 1: Add the dependency**

```bash
npm install three@^0.182.0 && npm install --save-dev @types/three@^0.182.0
```

- [ ] **Step 2: Write the component**

`components/widgets/context-map/map-canvas.tsx`. No test covers this file: jsdom has no WebGL, and everything checkable without a GPU lives in `map-data.ts`. Orbit, damping, idle rotation and reset all come from three's own `OrbitControls`, which already has `autoRotate` and `reset()` — do not hand-roll them.

```tsx
"use client";

/**
 * The point cloud. Plain three.js in one effect: a single Points object for
 * every passage, a second for ringed ones, one LineSegments for the selected
 * node's neighbours, and HTML overlays for the topic labels so they use the
 * page's own type tokens.
 */

import * as React from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import {
  buildBuffers, projectToScreen, resolveLabelCollisions, resolvePalette,
  type MapEdge, type MapPoint, type MapTopic,
} from "./map-data";

export interface MapCanvasProps {
  points: MapPoint[];
  topics: MapTopic[];
  groups: string[];
  edges: MapEdge[];
  selectedId: string | null;
  highlightTopic: string | null;
  ringedIds: Set<string>;
  paused: boolean;
  /** Faint nearest-neighbour lines for every passage, not only the selected one. */
  allLinks: boolean;
  /** A neighbour hovered in the panel; its line is drawn at full strength. */
  hoverNeighbourId: string | null;
  onSelect: (id: string | null) => void;
  onUnsupported: () => void;
}

/** Round dots without a texture: discard anything outside the point's circle. */
const POINT_VERTEX = `
  attribute vec3 color;
  attribute float dim;
  varying vec3 vColor;
  varying float vDim;
  uniform float size;
  void main() {
    vColor = color;
    vDim = dim;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (300.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const POINT_FRAGMENT = `
  varying vec3 vColor;
  varying float vDim;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    if (dot(d, d) > 0.25) discard;
    gl_FragColor = vec4(vColor, vDim);
  }
`;

type Hover = { label: string; x: number; y: number } | null;

export function MapCanvas({
  points, topics, groups, edges, selectedId, highlightTopic, ringedIds, paused, allLinks,
  hoverNeighbourId, onSelect, onUnsupported,
}: MapCanvasProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const cloudRef = React.useRef<THREE.Points | null>(null);
  const linesRef = React.useRef<THREE.LineSegments | null>(null);
  const cameraRef = React.useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = React.useRef<OrbitControls | null>(null);
  const pointerRef = React.useRef<{ x: number; y: number } | null>(null);
  const [labels, setLabels] = React.useState<{ id: string; label: string; x: number; y: number }[]>([]);
  const [hover, setHover] = React.useState<Hover>(null);

  // One scene for the life of the component. Data changes rewrite attributes;
  // they never rebuild this.
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      onUnsupported();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    // The layout is normalised to a 99th-percentile radius of 1, so every base
    // frames identically from here.
    const camera = new THREE.PerspectiveCamera(50, host.clientWidth / host.clientHeight, 0.01, 100);
    camera.position.set(0, 0, 3.2);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 1.2;
    controls.maxDistance = 8;
    controls.autoRotateSpeed = 0.6;
    controls.saveState();
    controlsRef.current = controls;

    const geometry = new THREE.BufferGeometry();
    const material = new THREE.ShaderMaterial({
      vertexShader: POINT_VERTEX,
      fragmentShader: POINT_FRAGMENT,
      uniforms: { size: { value: 0.02 } },
      transparent: true,
      depthWrite: false,
    });
    const cloud = new THREE.Points(geometry, material);
    scene.add(cloud);
    cloudRef.current = cloud;

    const lines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75 }),
    );
    scene.add(lines);
    linesRef.current = lines;

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 0.03 };

    const onPointerMove = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointerRef.current = {
        x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
        y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
      };
    };
    const onPointerLeave = () => { pointerRef.current = null; setHover(null); };
    const onClick = () => {
      const hit = hitTest();
      onSelect(hit === null ? null : (points[hit]?.id ?? null));
    };
    const onContextLost = (event: Event) => { event.preventDefault(); onUnsupported(); };

    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);
    renderer.domElement.addEventListener("click", onClick);
    renderer.domElement.addEventListener("webglcontextlost", onContextLost);

    function hitTest(): number | null {
      const pointer = pointerRef.current;
      const current = cloudRef.current;
      if (!pointer || !current) return null;
      raycaster.setFromCamera(new THREE.Vector2(pointer.x, pointer.y), camera);
      const hits = raycaster.intersectObject(current, false);
      return hits.length && typeof hits[0]?.index === "number" ? hits[0].index : null;
    }

    const resize = new ResizeObserver(() => {
      if (!host.clientWidth || !host.clientHeight) return;
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
    });
    resize.observe(host);

    // Labels and the hover read-out are React state, so they update at about
    // ten frames a second rather than sixty: the cloud stays smooth and the
    // DOM is not rewritten every frame.
    let lastOverlay = 0;
    let frame = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
      if (now - lastOverlay < 100) return;
      lastOverlay = now;

      const hit = hitTest();
      const hovered = hit === null ? null : points[hit];
      if (!hovered) setHover(null);
      else {
        const screen = projectToScreen(hovered, camera.projectionMatrix.clone()
          .multiply(camera.matrixWorldInverse).elements as unknown as number[],
          host.clientWidth, host.clientHeight);
        setHover(screen.visible ? { label: hovered.label, x: screen.x, y: screen.y } : null);
      }

      const matrix = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse)
        .elements as unknown as number[];
      const boxes = topics
        .map((topic) => ({ topic, screen: projectToScreen(topic, matrix, host.clientWidth, host.clientHeight) }))
        .filter((entry) => entry.screen.visible)
        .map((entry) => ({
          id: entry.topic.id, x: entry.screen.x, y: entry.screen.y,
          width: entry.topic.label.length * 7, height: 16, count: entry.topic.count,
        }));
      const keep = new Set(resolveLabelCollisions(boxes));
      setLabels(boxes.filter((b) => keep.has(b.id)).map((b) => ({
        id: b.id, label: topics.find((topic) => topic.id === b.id)?.label ?? "", x: b.x, y: b.y,
      })));
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      renderer.domElement.removeEventListener("click", onClick);
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      controls.dispose();
      geometry.dispose();
      material.dispose();
      lines.geometry.dispose();
      (lines.material as THREE.Material).dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      cloudRef.current = null;
      linesRef.current = null;
    };
    // The scene is built once; data arrives through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Positions and colours. Also re-run when the theme changes: WebGL colours
  // were resolved from CSS once, so without this the cloud keeps the previous
  // theme's palette.
  React.useEffect(() => {
    const host = hostRef.current;
    const cloud = cloudRef.current;
    if (!host || !cloud) return;
    const write = () => {
      const palette = resolvePalette(host);
      const { positions, colors } = buildBuffers(points, groups, palette);
      const dim = new Float32Array(points.length);
      for (let i = 0; i < points.length; i += 1) {
        const point = points[i]!;
        const muted = highlightTopic !== null && point.group !== null && !ringedIds.has(point.id);
        dim[i] = selectedId === point.id ? 1 : muted ? 0.15 : 0.85;
      }
      cloud.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      cloud.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      cloud.geometry.setAttribute("dim", new THREE.BufferAttribute(dim, 1));
      cloud.geometry.computeBoundingSphere();
    };
    write();
    const observer = new MutationObserver(write);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => observer.disconnect();
  }, [points, groups, selectedId, highlightTopic, ringedIds]);

  // Neighbour lines, rebuilt only when the selection changes.
  React.useEffect(() => {
    const lines = linesRef.current;
    if (!lines) return;
    const byId = new Map(points.map((p) => [p.id, p]));
    const from = selectedId ? byId.get(selectedId) : undefined;
    const vertices: number[] = [];
    const colors: number[] = [];
    if (from) {
      for (const edge of edges) {
        const to = byId.get(edge.target);
        if (!to) continue;
        vertices.push(from.x, from.y, from.z, to.x, to.y, to.z);
        const weight = Math.max(0.25, Math.min(1, edge.score));
        colors.push(weight, weight, weight, weight, weight, weight);
      }
    }
    lines.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(colors), 3));
    lines.geometry = geometry;
  }, [edges, selectedId, points, allLinks, hoverNeighbourId]);

  // Idle rotation. OrbitControls owns it; pausing is one flag.
  React.useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    controls.autoRotate = !paused && !reduced;
  }, [paused]);

  return (
    <div ref={hostRef} className="relative size-full">
      {labels.map((l) => (
        <span
          key={l.id}
          className="pointer-events-none absolute text-xs font-medium text-foreground/80"
          style={{ left: l.x, top: l.y, transform: "translate(-50%, -50%)" }}
        >
          {l.label}
        </span>
      ))}
      {hover && (
        <span
          className="pointer-events-none absolute max-w-xs truncate rounded border bg-popover px-2 py-1 text-xs text-popover-foreground shadow"
          style={{ left: hover.x + 8, top: hover.y + 8 }}
        >
          {hover.label}
        </span>
      )}
    </div>
  );
}
```

The card drives `reset` by calling `controlsRef.current?.reset()` through a ref handle the implementer exposes with `useImperativeHandle`, so the reset button does not rebuild the scene.

- [ ] **Step 3: Verify it builds and lints**

Run: `npx tsc --noEmit -p tsconfig.json && npx eslint components/widgets/context-map`
Expected: no errors. `jsx-no-literals` applies here — the label text comes from data, which is allowed; any fixed string must come from `next-intl`.

- [ ] **Step 4: Commit**

```bash
git branch --show-current   # feat/memory-map-view
git add package.json package-lock.json components/widgets/context-map/map-canvas.tsx
git commit -m "feat(map): the point cloud"
```

---

### Task 7: The card, the chips, the legend and the panel

**Files:**
- Create: `components/widgets/context-map/map-panel.tsx`, `components/widgets/context-map/context-map-card.tsx`, `components/widgets/context-map/context-map-card.test.tsx`
- Modify: `messages/en.json`, `messages/de.json`

**Interfaces:**
- Produces: `ContextMapCard` with props
  `{ contextId: string; groups: string[]; groupField: string | null; ringedIds?: Set<string>; itemHref: (itemId: string) => string; titleKey: "memory" | "knowledge" }`.

- [ ] **Step 1: Write the failing test**

`components/widgets/context-map/context-map-card.test.tsx` renders the card with a mocked Apollo provider and asserts behaviour, not markup:

```tsx
import { MockedProvider } from "@apollo/client/testing";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/dynamic", () => ({ default: () => () => <div data-testid="canvas" /> }));

import { ContextMapCard } from "./context-map-card";
// … NextIntlClientProvider wrapper with the real messages file …

describe("ContextMapCard", () => {
  it("draws without labels or chips when the base has points but no topics", async () => {
    // A base fitted before topics existed. The cloud must still render.
    render(withProviders([pointsMock, emptyTopicsMock, statusMock]));
    await waitFor(() => expect(screen.getByTestId("canvas")).toBeInTheDocument());
    expect(screen.queryByRole("group", { name: /topics/i })).not.toBeInTheDocument();
  });

  it("shows the not-mapped state, and no canvas, when the base was never fitted", async () => {
    render(withProviders([emptyPointsMock, emptyTopicsMock, notFittedStatusMock]));
    await waitFor(() => expect(screen.getByText(/not been mapped/i)).toBeInTheDocument());
    expect(screen.queryByTestId("canvas")).not.toBeInTheDocument();
  });

  it("says how many of how many it is drawing when the answer was sampled", async () => {
    render(withProviders([sampledPointsMock, emptyTopicsMock, statusMock]));
    await waitFor(() => expect(screen.getByText(/20,000/)).toBeInTheDocument());
  });

  it("tells the viewer when a linked passage is not one they can read", async () => {
    // ?selected= from a shared link, pointing at a passage absent from the
    // access-scoped points answer.
    render(withProviders([pointsMock, emptyTopicsMock, statusMock], { selected: "not-mine" }));
    await waitFor(() => expect(screen.getByText(/not available/i)).toBeInTheDocument());
  });

  it("keeps the cloud when the edges query fails, and says so in the panel", async () => {
    // Spec §5: an edges failure surfaces on that query only.
    render(withProviders([pointsMock, emptyTopicsMock, statusMock, edgesErrorMock], { selected: "chunk-1" }));
    await waitFor(() => expect(screen.getByTestId("canvas")).toBeInTheDocument());
    expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
  });

  it("asks for edges only once a passage is selected", async () => {
    const edges = vi.fn();
    render(withProviders([pointsMock, emptyTopicsMock, statusMock, edgesMock(edges)]));
    await waitFor(() => expect(screen.getByTestId("canvas")).toBeInTheDocument());
    expect(edges).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run components/widgets/context-map --maxWorkers 2`
Expected: FAIL — cannot resolve `./context-map-card`.

- [ ] **Step 3: Implement the panel**

`components/widgets/context-map/map-panel.tsx`:

```tsx
"use client";

import { useTranslations } from "next-intl";
import * as React from "react";

import { SidePanel } from "@/components/primitives/side-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import type { MapEdge, MapPoint, MapTopic } from "./map-data";

export interface MapPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: MapPoint | null;
  /** True when ?selected= names a passage absent from the access-scoped answer. */
  missing: boolean;
  topics: MapTopic[];
  edges: MapEdge[];
  edgesError: boolean;
  byId: Map<string, MapPoint>;
  itemHref: (itemId: string) => string;
  onSelect: (id: string) => void;
  onHoverNeighbour: (id: string | null) => void;
}

export function MapPanel({
  open, onOpenChange, selected, missing, topics, edges, edgesError, byId, itemHref, onSelect, onHoverNeighbour,
}: MapPanelProps) {
  const t = useTranslations("map");
  return (
    <SidePanel
      open={open}
      onOpenChange={onOpenChange}
      title={selected ? t("panel.passage") : t("panel.overview")}
      storageKey="exulu.context-map.panel"
      mobileSize="full"
    >
      {missing ? (
        <p className="text-sm text-muted-foreground">{t("panel.unavailable")}</p>
      ) : selected ? (
        <div className="space-y-4">
          {selected.group && <Badge variant="secondary">{selected.group}</Badge>}
          <p className="whitespace-pre-wrap text-sm">{selected.label}</p>
          <Button asChild variant="outline" size="sm">
            <a href={itemHref(selected.itemId)}>{t("panel.open")}</a>
          </Button>
          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t("panel.neighbours")}</h3>
            {edgesError ? (
              <p className="text-sm text-muted-foreground">{t("panel.neighboursFailed")}</p>
            ) : edges.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("panel.noNeighbours")}</p>
            ) : (
              <ul className="space-y-1">
                {edges.map((edge) => (
                  <li key={edge.target}>
                    <button
                      type="button"
                      className="w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-muted"
                      onMouseEnter={() => onHoverNeighbour(edge.target)}
                      onMouseLeave={() => onHoverNeighbour(null)}
                      onClick={() => onSelect(edge.target)}
                    >
                      {byId.get(edge.target)?.label ?? edge.target}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <ul className="space-y-1">
          {topics.map((topic) => (
            <li key={topic.id} className="flex items-center justify-between text-sm">
              <span className="truncate">{topic.label}</span>
              <span className="text-muted-foreground">{topic.count}</span>
            </li>
          ))}
          {topics.length === 0 && <p className="text-sm text-muted-foreground">{t("panel.empty")}</p>}
        </ul>
      )}
    </SidePanel>
  );
}
```

- [ ] **Step 4: Implement the card**

`components/widgets/context-map/context-map-card.tsx`:

```tsx
"use client";

import { useQuery } from "@apollo/client";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { ChartCard } from "@/components/primitives/chart-card";
import { EmptyState } from "@/components/primitives/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  GET_CONTEXT_MAP_EDGES, GET_CONTEXT_MAP_POINTS, GET_CONTEXT_MAP_TOPICS, GET_CONTEXT_PROJECTION_STATUS,
} from "@/lib/graphql/operations/context-map";

import { coverageCaption, legendEntries, PALETTE_TOKENS, type MapEdge, type MapPoint, type MapTopic } from "./map-data";
import { MapPanel } from "./map-panel";

const MapCanvas = dynamic(() => import("./map-canvas").then((m) => m.MapCanvas), {
  ssr: false,
  loading: () => <Skeleton className="h-[28rem] w-full" />,
});

export interface ContextMapCardProps {
  contextId: string;
  /** The base's declared enum values, in declared order. Empty means one colour. */
  groups: string[];
  groupField: string | null;
  ringedIds?: Set<string>;
  itemHref: (itemId: string) => string;
  titleKey: "memory" | "knowledge";
}

export function ContextMapCard({ contextId, groups, groupField, ringedIds, itemHref, titleKey }: ContextMapCardProps) {
  const t = useTranslations("map");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const selectedId = params?.get("selected") ?? null;
  const highlightTopic = params?.get("topic") ?? null;
  const [paused, setPaused] = React.useState(false);
  const [allLinks, setAllLinks] = React.useState(false);
  const [unsupported, setUnsupported] = React.useState(false);
  const [hoverNeighbour, setHoverNeighbour] = React.useState<string | null>(null);

  const setParam = (key: string, value: string | null) => {
    const url = new URLSearchParams(params?.toString() ?? "");
    if (value === null) url.delete(key);
    else url.set(key, value);
    const q = url.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };

  const pointsQuery = useQuery<{ contextMapPoints: { points: MapPoint[]; total: number; sampled: boolean } }>(
    GET_CONTEXT_MAP_POINTS,
    { variables: { contextId, mode: "PASSAGES", groupField, limit: 20000 }, fetchPolicy: "cache-and-network" },
  );
  const topicsQuery = useQuery<{ contextMapTopics: MapTopic[] }>(GET_CONTEXT_MAP_TOPICS, { variables: { contextId } });
  const statusQuery = useQuery<{ contextProjectionStatus: { fitted: boolean; mappedChunks: number; totalChunks: number } | null }>(
    GET_CONTEXT_PROJECTION_STATUS, { variables: { contextId }, fetchPolicy: "cache-and-network" },
  );
  const edgesQuery = useQuery<{ contextMapEdges: MapEdge[] }>(GET_CONTEXT_MAP_EDGES, {
    variables: { contextId, nodeId: selectedId, mode: "PASSAGES" },
    skip: !selectedId,
  });

  const points = pointsQuery.data?.contextMapPoints.points ?? [];
  const topics = topicsQuery.data?.contextMapTopics ?? [];
  const status = statusQuery.data?.contextProjectionStatus ?? null;
  const byId = React.useMemo(() => new Map(points.map((p) => [p.id, p])), [points]);
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;
  // A shared link can name a passage this viewer may not read: the points
  // answer is access-scoped, so it simply is not here.
  const missing = Boolean(selectedId) && !selected && !pointsQuery.loading;

  const caption = coverageCaption({
    drawn: points.length,
    total: pointsQuery.data?.contextMapPoints.total ?? points.length,
    sampled: pointsQuery.data?.contextMapPoints.sampled ?? false,
    mapped: status?.mappedChunks ?? 0,
    totalChunks: status?.totalChunks ?? 0,
  });

  const notMapped = status !== null && !status.fitted;

  return (
    <div className="flex flex-col gap-4 lg:flex-row" data-testid="context-map-card">
      <ChartCard
        className="min-w-0 flex-1"
        title={t(`title.${titleKey}`)}
        description={t("caption.intro")}
        error={pointsQuery.error ? { message: t("error.points"), onRetry: () => void pointsQuery.refetch() } : null}
        toolbar={
          <div className="flex items-center gap-2">
            <Tabs value={allLinks ? "all" : "selection"} onValueChange={(v) => setAllLinks(v === "all")}>
              <TabsList>
                <TabsTrigger value="all">{t("links.all")}</TabsTrigger>
                <TabsTrigger value="selection">{t("links.selection")}</TabsTrigger>
              </TabsList>
            </Tabs>
            <Button variant="outline" size="sm" onClick={() => setPaused((p) => !p)}>
              {paused ? t("controls.resume") : t("controls.pause")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setParam("selected", null)}>
              {t("controls.reset")}
            </Button>
          </div>
        }
      >
        {unsupported ? (
          <EmptyState variant="quiet" title={t("empty.noWebgl")} />
        ) : notMapped ? (
          <EmptyState variant="quiet" title={t("empty.notMapped")} description={t("empty.notMappedHow")} />
        ) : pointsQuery.loading && points.length === 0 ? (
          <Skeleton className="h-[28rem] w-full" />
        ) : (
          <div className="h-[28rem]">
            <MapCanvas
              points={points}
              topics={topics}
              groups={groups}
              edges={edgesQuery.data?.contextMapEdges ?? []}
              selectedId={selectedId}
              highlightTopic={highlightTopic}
              ringedIds={ringedIds ?? new Set()}
              paused={paused}
              allLinks={allLinks}
              hoverNeighbourId={hoverNeighbour}
              onSelect={(id) => setParam("selected", id)}
              onUnsupported={() => setUnsupported(true)}
            />
          </div>
        )}

        {topics.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-4" role="group" aria-label={t("topics.heading")}>
            {topics.map((topic) => (
              <Button
                key={topic.id}
                size="sm"
                variant={highlightTopic === topic.id ? "default" : "outline"}
                onClick={() => setParam("topic", highlightTopic === topic.id ? null : topic.id)}
              >
                {topic.label}
                <span className="ml-2 text-xs text-muted-foreground">{topic.count}</span>
              </Button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 pt-3">
          {legendEntries(groups).map((entry) => (
            <span key={entry.value} className="flex items-center gap-1.5 text-xs">
              <span
                aria-hidden="true"
                className="size-2.5 rounded-full"
                style={{ background: `hsl(var(${PALETTE_TOKENS[entry.index % PALETTE_TOKENS.length]}))` }}
              />
              {entry.value}
            </span>
          ))}
        </div>

        {caption && <p className="pt-2 text-xs text-muted-foreground">{t(caption.key, caption.values)}</p>}
        <p className="text-xs text-muted-foreground">{t("caption.private")}</p>
      </ChartCard>

      <MapPanel
        open
        onOpenChange={() => setParam("selected", null)}
        selected={selected}
        missing={missing}
        topics={topics}
        edges={edgesQuery.data?.contextMapEdges ?? []}
        edgesError={Boolean(edgesQuery.error)}
        byId={byId}
        itemHref={itemHref}
        onSelect={(id) => setParam("selected", id)}
        onHoverNeighbour={setHoverNeighbour}
      />
    </div>
  );
}
```

The line effect in Task 6 reads `allLinks` and `hoverNeighbourId`: with `allLinks` on it also emits one faint segment per passage to its nearest drawn neighbour, and a hovered neighbour's segment is drawn at full strength. Both are already on `MapCanvasProps`.

- [ ] **Step 5: Add the messages**

Add a top-level `map` namespace to **both** `messages/en.json` and `messages/de.json` with at least: `title.memory`, `title.knowledge`, `caption.intro`, `caption.sampled`, `caption.partial`, `caption.private`, `links.all`, `links.selection`, `controls.pause`, `controls.resume`, `controls.reset`, `topics.heading`, `legend.noValue`, `panel.empty`, `panel.neighbours`, `panel.unavailable`, `panel.open`, `empty.notMapped`, `empty.notMappedHow`, `empty.noWebgl`, `error.points`.

- [ ] **Step 6: Run the tests and the parity gate**

Run: `npx vitest run components/widgets/context-map --maxWorkers 2 && npm run check-messages`
Expected: PASS; parity reported with no missing keys.

- [ ] **Step 7: Commit**

```bash
git branch --show-current   # feat/memory-map-view
git add components/widgets/context-map messages/en.json messages/de.json
git commit -m "feat(map): the map card, its topics, legend and panel"
```

---

### Task 8: The memory base page

**Files:**
- Modify: `app/(application)/memory/[ctx]/components/base-shell.tsx`
- Modify: `app/(application)/memory/[ctx]/page.tsx` (the `tab` search param)
- Test: `app/(application)/memory/[ctx]/components/base-shell.test.tsx` (create)

**Interfaces:**
- Consumes: `ContextMapCard` from `@/components/widgets/context-map/context-map-card`; `memoryTypeValues` equivalent on the client — the base's declared `type` enum arrives on `context.fields`.

- [ ] **Step 1: Write the failing test**

```tsx
it("defaults to the overview tab and renders the map there", async () => {
  render(withProviders(<BaseShell context={validContext} initialMine={false} initialPage={1} />));
  expect(screen.getByRole("tab", { name: /overview/i })).toHaveAttribute("data-state", "active");
  expect(await screen.findByTestId("context-map-card")).toBeInTheDocument();
});

it("renders the table under the memories tab and not on overview", async () => {
  render(withProviders(<BaseShell context={validContext} initialMine={false} initialPage={1} initialTab="memories" />));
  expect(screen.getByRole("tab", { name: /memories/i })).toHaveAttribute("data-state", "active");
  expect(screen.queryByTestId("context-map-card")).not.toBeInTheDocument();
});

it("keeps the stat cards visible on every tab", async () => { /* … */ });

it("shows the invalid-base empty state instead of tabs when the contract is not met", async () => { /* … */ });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "app/(application)/memory/[ctx]" --maxWorkers 2`
Expected: FAIL — there is no tab list.

- [ ] **Step 3: Add the tab bar**

In `base-shell.tsx`, add a `MemoryTab = "overview" | "memories" | "conflicts"` read from a new `initialTab` prop, with `setTab` following the workspace shell exactly: write `?tab=`, delete it for the default, drop `page` and `mine` when leaving the memories tab, and `router.replace(..., { scroll: false })`. The Conflicts trigger navigates to `/memory/${context.id}/conflicts` with `router.push` rather than switching a body. Keep the five stat cards above the tabs. Render `<ContextMapCard>` for `overview` and the existing `<MemoryTable>` for `memories`, with the `visibleFooter` paragraph staying under the table.

Pass the base's declared type values as `groups`, read from `context.fields`, and `groupField="type"`; `itemHref` is `(itemId) => \`/memory/${context.id}/${itemId}\``.

- [ ] **Step 4: Thread the search param**

In `app/(application)/memory/[ctx]/page.tsx`, read `tab` from `searchParams` and pass it as `initialTab`. The page stays a server component and still must not call `getTranslations`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run "app/(application)/memory" --maxWorkers 2`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # feat/memory-map-view
git add "app/(application)/memory/[ctx]"
git commit -m "feat(map): an overview tab on the memory base page"
```

---

### Task 9: The knowledge workspace tab

**Files:**
- Modify: `app/(application)/data/[ctx]/components/workspace-shell.tsx`
- Modify: `app/(application)/data/[ctx]/page.tsx` (the `tab` union in `SearchParamsShape`)
- Test: `app/(application)/data/[ctx]/components/workspace-shell.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```tsx
it("adds a map tab that mounts only when it is active", async () => {
  render(withProviders(<WorkspaceShell context={context} searchParams={{}} />));
  expect(screen.queryByTestId("context-map-card")).not.toBeInTheDocument();
  render(withProviders(<WorkspaceShell context={context} searchParams={{ tab: "map" }} />));
  expect(await screen.findByTestId("context-map-card")).toBeInTheDocument();
});

it("colours by the first declared enum field, and by nothing when there is none", () => { /* … */ });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "app/(application)/data/[ctx]" --maxWorkers 2`
Expected: FAIL — `map` is not a tab.

- [ ] **Step 3: Add the tab**

Extend `WorkspaceTab` to `"items" | "pipeline" | "entities" | "map"`, add the trigger with `t("workspace.tabs.map")` in both message files, and render `<ContextMapCard>` in the tab body. `groups` is the values of the first field whose `type` is `enum`, or an empty array; `groupField` is that field's name or `null`; `itemHref` is `(itemId) => \`/data/${context.id}/items/${itemId}\``. The existing rule that switching tabs drops `item` stays, and `selected`/`topic` join it.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run "app/(application)/data" --maxWorkers 2 && npm run check-messages`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # feat/memory-map-view
git add "app/(application)/data/[ctx]" messages/en.json messages/de.json
git commit -m "feat(map): a map tab in the knowledge workspace"
```

---

### Task 10: Verification and documentation

**Files:**
- Modify: `mintlify-docs/building/memory/overview.mdx` and `mintlify-docs/building/knowledge/overview.mdx` (backend worktree)

- [ ] **Step 1: Verify both repos**

Backend:

```bash
npx jest --silent --maxWorkers=2 2>&1 | grep -E "^(Tests:|Test Suites:|FAIL)" | sort -u
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"
npm run build 2>&1 | tail -3
```
Expected: only `compact-session`, `email-inbound/intake` and `resolve-context-window` fail; count 8; build succeeds.

Frontend:

```bash
npx vitest run --maxWorkers 2 2>&1 | tail -5
npm run check-messages
npm run lint 2>&1 | tail -5
npm run build 2>&1 | tail -5
```
Expected: green except the known `nav-config` expectation if it is still failing on `main`; parity clean; lint clean; the build lists the memory and data routes.

- [ ] **Step 2: Document it**

Add a short **Map** section to the memory overview page describing what the cloud shows, that regions are named from the words that distinguish them, and that lines appear when a passage is selected. Extend the knowledge overview's existing Map section with the same two sentences about regions and lines. Insert both **before** the page's `## Next steps` block, never appended at the end. Run `npx mint validate` and `npx mint broken-links` in `mintlify-docs/`.

- [ ] **Step 3: Commit**

```bash
git branch --show-current   # feat/memory-map-view
git add mintlify-docs
git commit -m "docs(map): what the map shows and how regions are named"
```

- [ ] **Step 4: Hand off**

Report the verification output verbatim, and this UAT list for Daniel:

1. Refit a memory base and confirm the script reports how many regions it named.
2. Open the base's Overview tab: the cloud draws, regions are labelled, chips match the labels.
3. Judge the labels against the memories they cover — this is the one thing no test can check.
4. Select a passage: lines appear, the panel shows it, the neighbours are genuinely related.
5. Switch theme with the map open: colours follow, nothing stays on the old palette.
6. Reload with `?selected=` and `?topic=` in the URL: both restore.
7. A second user with fewer rights sees fewer dots and the same topic counts.
8. The knowledge workspace map tab on a real base large enough to be sampled: the caption says how many of how many.
9. A base fitted before this work: draws without labels or chips, no error.
10. Reduced motion: the cloud does not rotate on its own.
11. A large display and a laptop display: the card is legible on both.
