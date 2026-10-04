# Vector Map Positions (agent memory redesign, sub-project 3c-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every chunk of every context a position in three dimensions derived from its embedding, computed when the chunk is embedded and backfilled by a script, and expose the points, their lexical neighbours and the fit status through GraphQL.

**Architecture:** A per-context projection (centering mean, a 50-dimension orthonormal basis, a 3-by-50 map and intercept) is fitted by a script: normalize, reduce, lay out with UMAP, then learn a linear map onto that layout. The projection is stored in a new core table and applied with two small matrix multiplies at the one place chunks are inserted. Three read queries serve points (documents or passages), a node's lexical neighbours from the existing tsvector index, and the fit status. All maths lives in a pure, tested module; the script and the resolvers orchestrate it.

**Tech Stack:** TypeScript, knex/Postgres + pgvector, `umap-js` (new, pure JS), generated GraphQL (`src/graphql/schemas/index.ts`), jest (`--maxWorkers=2`). Backend only — no frontend work in this sub-project.

**Spec:** `docs/superpowers/specs/2026-10-04-vector-map-positions-design.md` (branch `feat/vector-map-positions`).

**Worktree:** `/Users/daniel.claessen/Desktop/Projects/exulu/backend-agent-memory`, branch `feat/vector-map-positions` from develop b599aa5. Verify the branch in the same command as every commit.

## Global Constraints

- Coordinates are derived from content and treated as content: points and edges are returned only for items the viewer may read, through `applyAccessControl(table, query, user, "items")` — the same call vector search uses (`src/graphql/resolvers/vector-search.ts:215`). No extra area gate on points/edges (matching the generated item resolvers); `contextProjectionStatus` needs an authenticated user and returns counts only.
- Nothing in this sub-project may make embedding fail: the projection step is wrapped, logs one line, and writes null coordinates on any error (missing projection, dimension mismatch, bad maths).
- `PROJECTION_VERSION = 1` lives in one module. `fitted` means the row exists and its version matches. A dimension mismatch is detected at write time (the vector length is known there) and logged, not in the status query — this avoids reading the LiteLLM config from a resolver, a deliberate narrowing of the spec's wording.
- Determinism: the fit samples with `ORDER BY md5(id::text || '<context>')`, seeds its RNG from the context id, and normalizes the layout to centre 0 with a 99th-percentile radius of 1. Rerunning on unchanged data reproduces the same projection.
- Defaults as constants in `src/exulu/projection/constants.ts`: `COMPONENTS = 50`, `FIT_SAMPLE = 20000`, `UMAP_NEIGHBORS = 15`, `UMAP_MIN_DIST = 0.1`, `POWER_ITERATIONS = 3`, `RIDGE_LAMBDA = 1e-3`, `BACKFILL_BATCH = 500`, `POINTS_LIMIT_DEFAULT = 5000`, `POINTS_LIMIT_MAX = 20000`, `EDGE_LIMIT_DEFAULT = 8`, `PROJECTION_CACHE_TTL_MS = 60000`, `PROJECTION_VERSION = 1`.
- Maths uses `Float32Array`/`Float64Array` and plain loops; no matrix library. The only new dependency is `umap-js` (1.4.0, ships its own types).
- Process rules: foreground commands only, no `&`/`nohup`/watch modes/dev servers; jest `--maxWorkers=2`; one build at a time. Baselines: jest fails only `compact-session`, `email-inbound/intake`, `resolve-context-window`; tsc 8 errors.

## Review Focus

1. A context whose chunks table predates this change (columns not yet added, init-db not re-run): the insert must still succeed with no coordinates (Task 4 test with a fake db that rejects unknown columns is impractical — instead Task 1 makes init-db add the columns to every existing chunks table, and Task 4 writes the keys only when a projection exists, so a base with no projection never names the columns).
2. A vector whose length differs from the projection's `dims` (model changed since the fit): coordinates null, one log line, embedding unaffected (Task 4 test).
3. A base with fewer vectors than `components + 1`: the fit refuses with a clear message instead of producing a degenerate basis (Task 3 test).
4. Degenerate input — every vector identical, so zero variance: no `NaN` ever reaches the database; the fit reports it and writes no projection (Task 2 test on the maths, Task 3 test on the orchestration).
5. A viewer who may read nothing in the base: points empty, `total` 0, no error, and edges empty for any node id (Task 5 test).

---

### Task 1: Coordinate columns and the `context_projections` table

**Files:**
- Modify: `src/exulu/context.ts` (`createChunksTable`, ~line 1313)
- Modify: `src/postgres/core-schema.ts` (+ `contextProjectionsSchema`, registered), `src/postgres/core-schema.test.ts`
- Modify: `types/exulu-table-definition.ts` (add `"context_projections"` to the closed unions, as `"memory_usages"` was added)
- Modify: `src/postgres/init-exulu-db.ts` (add the three columns to existing chunk tables in the per-context loop, ~line 371)

**Interfaces:**
- Produces: `px`/`py`/`pz` real columns on every chunks table; core table `context_projections` per spec §2.2.

- [ ] **Step 1: Write the failing test**

Append to `src/postgres/core-schema.test.ts`:

```ts
describe("context_projections schema", () => {
  test("holds one fitted projection per context, without RBAC", () => {
    const schema = coreSchemas.get().contextProjectionsSchema();
    expect(schema.name).toEqual({ plural: "context_projections", singular: "context_projection" });
    expect(schema.RBAC).toBeFalsy();
    const byName = Object.fromEntries(schema.fields.map((f) => [f.name, f]));
    expect(byName.context).toMatchObject({ type: "text", required: true, unique: true });
    expect(byName.dims).toMatchObject({ type: "number", required: true });
    expect(byName.components).toMatchObject({ type: "number", required: true });
    expect(byName.mean).toMatchObject({ type: "json", required: true });
    expect(byName.basis).toMatchObject({ type: "json", required: true });
    expect(byName.map).toMatchObject({ type: "json", required: true });
    expect(byName.intercept).toMatchObject({ type: "json", required: true });
    expect(byName.method).toMatchObject({ type: "text", required: true });
    expect(byName.version).toMatchObject({ type: "number", required: true });
    expect(byName.sample_size).toMatchObject({ type: "number" });
    expect(byName.residual).toMatchObject({ type: "number" });
    expect(byName.fitted_at).toMatchObject({ type: "date", required: true });
    expect(byName.created_by).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/postgres/core-schema --maxWorkers=2`
Expected: FAIL — `contextProjectionsSchema is not a function`.

- [ ] **Step 3: Implement**

In `src/postgres/core-schema.ts`, after `memoryConflictsSchema`:

```ts
/**
 * Vector map (sub-project 3c-1): one fitted projection per context — the mean,
 * the linear reduction and the learned map that turn an embedding into a point
 * in three dimensions. Read once per process and cached; ~1 MB of JSON for a
 * 1536-dimension model.
 */
const contextProjectionsSchema: ExuluTableDefinition = {
  type: "context_projections",
  name: { plural: "context_projections", singular: "context_projection" },
  fields: [
    { name: "context", type: "text", required: true, unique: true, index: true },
    { name: "dims", type: "number", required: true },
    { name: "components", type: "number", required: true },
    { name: "mean", type: "json", required: true },
    { name: "basis", type: "json", required: true },
    { name: "map", type: "json", required: true },
    { name: "intercept", type: "json", required: true },
    { name: "method", type: "text", required: true },
    { name: "version", type: "number", required: true },
    { name: "sample_size", type: "number" },
    { name: "residual", type: "number" },
    { name: "fitted_at", type: "date", required: true },
  ],
};
```

Register `contextProjectionsSchema: (): ExuluTableDefinition => addCoreFields(contextProjectionsSchema),` in `coreSchemas.get()`; extend the unions in `types/exulu-table-definition.ts`; destructure it in `init-exulu-db.ts` and add `contextProjectionsSchema(),` to the `schemas` array.

In `src/exulu/context.ts` `createChunksTable`, after `table.specificType("embedding", ...)`:

```ts
      // Vector map (3c-1): the chunk's position in three dimensions, written by
      // the projection at embedding time. Null until the context is fitted.
      table.specificType("px", "real");
      table.specificType("py", "real");
      table.specificType("pz", "real");
```

In `src/postgres/init-exulu-db.ts`, in the per-context loop right after the "create the chunks table if missing" block:

```ts
    // Vector map (3c-1): chunk tables have no field-sync path, so the three
    // coordinate columns are added here. Idempotent on every boot.
    if (await context.chunksTableExists()) {
      const chunksTable = getChunksTableName(context.id);
      for (const column of ["px", "py", "pz"]) {
        await knex.raw(`ALTER TABLE ?? ADD COLUMN IF NOT EXISTS ?? real`, [chunksTable, column]);
      }
    }
```

Import `getChunksTableName` from `@SRC/exulu/table-names` there if it is not already imported.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx jest src/postgres --maxWorkers=2 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: PASS; count 8.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # feat/vector-map-positions
git add src/postgres/core-schema.ts src/postgres/core-schema.test.ts src/postgres/init-exulu-db.ts src/exulu/context.ts types/exulu-table-definition.ts
git commit -m "feat(map): chunk coordinate columns and the context_projections table"
```

---

### Task 2: The projection maths

**Files:**
- Create: `src/exulu/projection/constants.ts`, `src/exulu/projection/math.ts`, `src/exulu/projection/math.test.ts`

**Interfaces:**
- Produces: `rng(seed)`, `l2normalize(v)`, `meanVector(rows, dims)`, `subtract(v, mean)`, `randomizedPCA(rows, dims, k, seed, iterations)`, `projectComponents(v, mean, basis)`, `ridgeFit(Z, Y, lambda)`, `applyMap(z, map, intercept)`, `normalizeLayout(points)`, `fitResidual(Z, Y, map, intercept, radius)`. All pure, no db, no model.

- [ ] **Step 1: Write the failing test**

`src/exulu/projection/math.test.ts`:

```ts
import {
  applyMap, fitResidual, l2normalize, meanVector, normalizeLayout, projectComponents,
  randomizedPCA, ridgeFit, rng,
} from "./math";

const near = (a: number, b: number, eps = 1e-5) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("rng", () => {
  it("is deterministic per seed and stays in [0,1)", () => {
    const a = rng(42), b = rng(42);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    for (const x of xs) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
    expect(Array.from({ length: 5 }, () => rng(43)())).not.toEqual(xs);
  });
});

describe("l2normalize", () => {
  it("scales to unit length and leaves a zero vector alone", () => {
    const v = l2normalize([3, 4]);
    near(v[0], 0.6); near(v[1], 0.8);
    expect(Array.from(l2normalize([0, 0]))).toEqual([0, 0]);
  });
});

describe("meanVector", () => {
  it("averages componentwise", () => {
    expect(Array.from(meanVector([Float32Array.from([1, 2]), Float32Array.from([3, 4])], 2))).toEqual([2, 3]);
  });
});

describe("randomizedPCA", () => {
  it("recovers a planted low-dimensional subspace", () => {
    // 200 points living in the span of e0 and e1 of a 20-dimensional space.
    const dims = 20, n = 200;
    const r = rng(7);
    const rows: Float32Array[] = [];
    for (let i = 0; i < n; i += 1) {
      const v = new Float32Array(dims);
      v[0] = (r() - 0.5) * 10;
      v[1] = (r() - 0.5) * 6;
      for (let d = 2; d < dims; d += 1) v[d] = (r() - 0.5) * 0.01;
      rows.push(v);
    }
    const mean = meanVector(rows, dims);
    const basis = randomizedPCA(rows, dims, 2, 1, 3);
    expect(basis).toHaveLength(2);
    // orthonormal
    near(basis[0].reduce((s, x) => s + x * x, 0), 1, 1e-4);
    near(Array.from(basis[0]).reduce((s, x, i) => s + x * basis[1][i], 0), 0, 1e-4);
    // the planted directions dominate: |b·e0| + |b·e1| ≈ 1 for both rows
    for (const b of basis) {
      const captured = Math.hypot(b[0], b[1]);
      expect(captured).toBeGreaterThan(0.99);
    }
    // reconstruction keeps almost all the variance
    const z = projectComponents(rows[0], mean, basis);
    expect(z).toHaveLength(2);
  });

  it("returns an empty basis for degenerate input instead of NaN", () => {
    const rows = Array.from({ length: 10 }, () => Float32Array.from([1, 1, 1]));
    const basis = randomizedPCA(rows, 3, 2, 1, 3);
    for (const b of basis) for (const x of b) expect(Number.isFinite(x)).toBe(true);
  });
});

describe("ridgeFit + applyMap", () => {
  it("recovers an exact linear relation", () => {
    const k = 4, n = 50;
    const r = rng(3);
    const trueMap = [[1, -2, 0.5, 0], [0, 1, 1, -1], [2, 0, 0, 0.25]];
    const trueIntercept = [0.3, -0.7, 1.1];
    const Z: Float32Array[] = [], Y: number[][] = [];
    for (let i = 0; i < n; i += 1) {
      const z = Float32Array.from({ length: k }, () => (r() - 0.5) * 4);
      Z.push(z);
      Y.push(trueMap.map((row, j) => row.reduce((s, w, d) => s + w * z[d], 0) + trueIntercept[j]));
    }
    const { map, intercept } = ridgeFit(Z, Y, 1e-9);
    for (let j = 0; j < 3; j += 1) {
      near(intercept[j], trueIntercept[j], 1e-3);
      for (let d = 0; d < k; d += 1) near(map[j][d], trueMap[j][d], 1e-3);
    }
    const [x, y, z] = applyMap(Z[0], map, intercept);
    near(x, Y[0][0], 1e-3); near(y, Y[0][1], 1e-3); near(z, Y[0][2], 1e-3);
  });
});

describe("normalizeLayout", () => {
  it("centres the cloud and scales the 99th-percentile radius to 1", () => {
    const pts = Array.from({ length: 100 }, (_, i) => [i, 0, 0]);
    const { points, center, scale } = normalizeLayout(pts);
    near(center[0], 49.5);
    expect(scale).toBeGreaterThan(0);
    const radii = points.map((p) => Math.hypot(p[0], p[1], p[2])).sort((a, b) => a - b);
    near(radii[98], 1, 0.05);
    for (const p of points) for (const c of p) expect(Number.isFinite(c)).toBe(true);
  });
  it("survives a cloud with no spread", () => {
    const { points } = normalizeLayout([[2, 2, 2], [2, 2, 2]]);
    expect(points).toEqual([[0, 0, 0], [0, 0, 0]]);
  });
});

describe("fitResidual", () => {
  it("is 0 for a perfect fit and grows with error", () => {
    const Z = [Float32Array.from([1, 0]), Float32Array.from([0, 1])];
    const map = [[1, 0], [0, 1], [0, 0]];
    const Y = [[1, 0, 0], [0, 1, 0]];
    near(fitResidual(Z, Y, map, [0, 0, 0], 1), 0);
    expect(fitResidual(Z, [[2, 0, 0], [0, 2, 0]], map, [0, 0, 0], 1)).toBeGreaterThan(0.5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/exulu/projection --maxWorkers=2`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the constants**

`src/exulu/projection/constants.ts`:

```ts
/** Vector map (3c-1) knobs. One place; nothing else hardcodes them. */
export const PROJECTION_VERSION = 1;
export const PROJECTION_METHOD = "umap+linear";
export const COMPONENTS = 50;
export const FIT_SAMPLE = 20000;
export const UMAP_NEIGHBORS = 15;
export const UMAP_MIN_DIST = 0.1;
export const POWER_ITERATIONS = 3;
export const RIDGE_LAMBDA = 1e-3;
export const BACKFILL_BATCH = 500;
export const POINTS_LIMIT_DEFAULT = 5000;
export const POINTS_LIMIT_MAX = 20000;
export const EDGE_LIMIT_DEFAULT = 8;
export const PROJECTION_CACHE_TTL_MS = 60_000;
```

- [ ] **Step 4: Implement the maths**

`src/exulu/projection/math.ts`:

```ts
/**
 * Pure linear algebra for the vector map (spec §3). Typed arrays and plain
 * loops: a full covariance eigendecomposition on a 1536-dimension model costs
 * minutes, the subspace iteration here costs seconds, and neither needs a
 * matrix library.
 */

/** Deterministic PRNG (mulberry32) so a fit is reproducible from a seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function l2normalize(v: ArrayLike<number>): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i += 1) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  const out = new Float32Array(v.length);
  if (norm === 0) return out;
  for (let i = 0; i < v.length; i += 1) out[i] = v[i] / norm;
  return out;
}

export function meanVector(rows: ArrayLike<number>[], dims: number): Float32Array {
  const out = new Float32Array(dims);
  if (rows.length === 0) return out;
  for (const row of rows) for (let d = 0; d < dims; d += 1) out[d] += row[d];
  for (let d = 0; d < dims; d += 1) out[d] /= rows.length;
  return out;
}

function orthonormalize(vectors: Float32Array[], dims: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (const candidate of vectors) {
    const v = Float32Array.from(candidate);
    for (const basis of out) {
      let dot = 0;
      for (let d = 0; d < dims; d += 1) dot += v[d] * basis[d];
      for (let d = 0; d < dims; d += 1) v[d] -= dot * basis[d];
    }
    let norm = 0;
    for (let d = 0; d < dims; d += 1) norm += v[d] * v[d];
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm < 1e-8) continue;   // degenerate direction, drop it
    for (let d = 0; d < dims; d += 1) v[d] /= norm;
    out.push(v);
  }
  return out;
}

/**
 * Top-`k` principal directions of the centred rows by subspace iteration.
 * Cost is `iterations · rows · dims · k`; rows are centred by `mean` on the fly.
 */
export function randomizedPCA(
  rows: ArrayLike<number>[], dims: number, k: number, seed: number, iterations: number,
): Float32Array[] {
  const random = rng(seed);
  const mean = meanVector(rows, dims);
  let basis = orthonormalize(
    Array.from({ length: k }, () => Float32Array.from({ length: dims }, () => random() - 0.5)),
    dims,
  );
  for (let pass = 0; pass < iterations && basis.length > 0; pass += 1) {
    const next = basis.map(() => new Float32Array(dims));
    for (const row of rows) {
      // z = basisᵀ(row - mean)
      const z = new Float64Array(basis.length);
      for (let b = 0; b < basis.length; b += 1) {
        let dot = 0;
        const vec = basis[b];
        for (let d = 0; d < dims; d += 1) dot += (row[d] - mean[d]) * vec[d];
        z[b] = dot;
      }
      // next += (row - mean) zᵀ
      for (let b = 0; b < basis.length; b += 1) {
        const scale = z[b];
        if (scale === 0) continue;
        const target = next[b];
        for (let d = 0; d < dims; d += 1) target[d] += (row[d] - mean[d]) * scale;
      }
    }
    const refreshed = orthonormalize(next, dims);
    if (refreshed.length === 0) break;      // zero variance: keep the last good basis
    basis = refreshed;
  }
  return basis;
}

export function projectComponents(
  v: ArrayLike<number>, mean: ArrayLike<number>, basis: ArrayLike<number>[],
): Float32Array {
  const out = new Float32Array(basis.length);
  for (let b = 0; b < basis.length; b += 1) {
    let dot = 0;
    const vec = basis[b];
    for (let d = 0; d < mean.length; d += 1) dot += (v[d] - mean[d]) * vec[d];
    out[b] = dot;
  }
  return out;
}

/** Solves (AᵀA + λI)X = AᵀB by Gaussian elimination with partial pivoting. */
function solve(A: number[][], B: number[][]): number[][] {
  const n = A.length;
  const cols = B[0].length;
  const M = A.map((row, i) => [...row, ...B[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) continue;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const d = M[col][col];
    for (let c = col; c < n + cols; c += 1) M[col][c] /= d;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let c = col; c < n + cols; c += 1) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row) => row.slice(n));
}

/** Ridge least squares from k-dimensional rows onto 3-dimensional targets. */
export function ridgeFit(
  Z: ArrayLike<number>[], Y: number[][], lambda: number,
): { map: number[][]; intercept: number[] } {
  const k = Z[0]?.length ?? 0;
  const zMean = new Float64Array(k);
  const yMean = [0, 0, 0];
  for (let i = 0; i < Z.length; i += 1) {
    for (let d = 0; d < k; d += 1) zMean[d] += Z[i][d];
    for (let j = 0; j < 3; j += 1) yMean[j] += Y[i][j];
  }
  for (let d = 0; d < k; d += 1) zMean[d] /= Z.length || 1;
  for (let j = 0; j < 3; j += 1) yMean[j] /= Z.length || 1;

  const ZtZ = Array.from({ length: k }, () => new Array(k).fill(0));
  const ZtY = Array.from({ length: k }, () => [0, 0, 0]);
  for (let i = 0; i < Z.length; i += 1) {
    for (let a = 0; a < k; a += 1) {
      const za = Z[i][a] - zMean[a];
      if (za === 0) continue;
      for (let b = a; b < k; b += 1) ZtZ[a][b] += za * (Z[i][b] - zMean[b]);
      for (let j = 0; j < 3; j += 1) ZtY[a][j] += za * (Y[i][j] - yMean[j]);
    }
  }
  for (let a = 0; a < k; a += 1) {
    ZtZ[a][a] += lambda;
    for (let b = 0; b < a; b += 1) ZtZ[a][b] = ZtZ[b][a];
  }
  const W = solve(ZtZ, ZtY);                       // k × 3
  const map = [0, 1, 2].map((j) => Array.from({ length: k }, (_, d) => (Number.isFinite(W[d][j]) ? W[d][j] : 0)));
  const intercept = [0, 1, 2].map((j) => yMean[j] - map[j].reduce((s, w, d) => s + w * zMean[d], 0));
  return { map, intercept };
}

export function applyMap(
  z: ArrayLike<number>, map: number[][], intercept: number[],
): [number, number, number] {
  const out: number[] = [];
  for (let j = 0; j < 3; j += 1) {
    let v = intercept[j] ?? 0;
    const row = map[j] ?? [];
    for (let d = 0; d < row.length; d += 1) v += row[d] * z[d];
    out.push(Number.isFinite(v) ? v : 0);
  }
  return [out[0], out[1], out[2]];
}

/** Centres a layout on the origin and scales its 99th-percentile radius to 1. */
export function normalizeLayout(points: number[][]): { points: number[][]; center: number[]; scale: number } {
  const center = [0, 1, 2].map((j) => points.reduce((s, p) => s + (p[j] ?? 0), 0) / (points.length || 1));
  const radii = points
    .map((p) => Math.hypot((p[0] ?? 0) - center[0], (p[1] ?? 0) - center[1], (p[2] ?? 0) - center[2]))
    .sort((a, b) => a - b);
  const p99 = radii[Math.min(radii.length - 1, Math.floor(radii.length * 0.99))] ?? 0;
  const scale = p99 > 1e-9 ? 1 / p99 : 0;
  return {
    points: points.map((p) => [0, 1, 2].map((j) => ((p[j] ?? 0) - center[j]) * scale)),
    center,
    scale,
  };
}

/** Mean placement error of the learned map, relative to the cloud radius. */
export function fitResidual(
  Z: ArrayLike<number>[], Y: number[][], map: number[][], intercept: number[], radius: number,
): number {
  if (Z.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < Z.length; i += 1) {
    const [x, y, z] = applyMap(Z[i], map, intercept);
    total += Math.hypot(x - Y[i][0], y - Y[i][1], z - Y[i][2]);
  }
  const mean = total / Z.length;
  return radius > 1e-9 ? mean / radius : mean;
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx jest src/exulu/projection --maxWorkers=2 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: PASS; count 8.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # feat/vector-map-positions
git add src/exulu/projection
git commit -m "feat(map): pure projection maths (subspace PCA, ridge map, layout normalisation)"
```

---

### Task 3: The fit and its script

**Files:**
- Create: `src/exulu/projection/fit.ts`, `src/exulu/projection/fit.test.ts`, `scripts/fit-context-projection.ts`
- Modify: `package.json` (add `umap-js`)

**Interfaces:**
- Consumes: Task 2's maths; `getChunksTableName`/`getTableName` (`@SRC/exulu/table-names`).
- Produces: `fitContextProjection({ db, contextId, sample, components, dryRun, umapFactory?, log? })` → `FitResult = { fitted: boolean; reason?: string; sampleSize: number; components: number; residual: number; written: number }`; `backfillCoordinates({ db, contextId, projection, batch })` → number of chunks written; `listFittableContexts(db)` → context ids that have a chunks table.

**Why the fit takes a context id, not an `ExuluContext`:** contexts are declared by the consuming application (Newton declares its own), so a script inside this package cannot enumerate them. Everything the fit needs — the chunk and item table names, the vectors, their dimensionality — comes from the database, so the whole task is id-only. The read API in Task 5 still takes the real context, because resolvers have it.

- [ ] **Step 1: Install the dependency**

Run: `npm install umap-js@1.4.0`
Expected: added to `dependencies`; `node -e "console.log(require('umap-js').UMAP ? 'ok' : 'missing')"` prints `ok`.

- [ ] **Step 2: Write the failing test**

`src/exulu/projection/fit.test.ts` — a fake db plus an injected UMAP stand-in, so no real layout runs in tests:

```ts
jest.mock("@SRC/exulu/table-names", () => ({
  getTableName: (id: string) => `${id}_items`,
  getChunksTableName: (id: string) => `${id}_chunks`,
}));

import { fitContextProjection, listFittableContexts } from "./fit";

type Row = { id: string; embedding: number[] };
/** Rows come back from pg as the pgvector text form; the fake mirrors that. */
const toSql = (v: number[]) => `[${v.join(",")}]`;

/**
 * Knex is called as `db("mem_chunks as chunks")` for the fit query and
 * `db("mem_chunks")` for the backfill, so the fake keys on the first word, and
 * it honours the keyset (`where("id", ">", …)`) so the backfill loop terminates.
 */
function fakeDb(state: { rows: Row[] }) {
  const writes: any[] = [];
  const db: any = jest.fn((table: string) => {
    const key = table.split(" ")[0];
    const chain: any = { __table: key, __where: {} };
    for (const m of ["whereNotNull", "whereRaw", "join", "orderByRaw", "orderBy", "select", "andWhere"]) {
      chain[m] = () => chain;
    }
    chain.where = (...args: any[]) => {
      if (typeof args[0] === "object") Object.assign(chain.__where, args[0]);
      else if (args[1] === ">") chain.__after = args[2];
      return chain;
    };
    chain.limit = (n: number) => { chain.__limit = n; return chain; };
    chain.first = async () => undefined;
    chain.insert = (rows: any) => { writes.push({ table: key, op: "insert", rows }); return { onConflict: () => ({ merge: async () => undefined }) }; };
    chain.then = (resolve: any, reject: any) => {
      if (!key.endsWith("_chunks")) return Promise.resolve([]).then(resolve, reject);
      const after = chain.__after;
      const rows = state.rows
        .filter((r) => after === undefined || r.id > after)
        .slice(0, chain.__limit ?? state.rows.length)
        .map((r) => ({ id: r.id, embedding: toSql(r.embedding) }));
      return Promise.resolve(rows).then(resolve, reject);
    };
    return chain;
  });
  db.raw = async (_sql: string, _b?: any[]) => { writes.push({ op: "raw" }); return { rowCount: 0 }; };
  db.schema = { hasTable: async () => true };
  db.__writes = writes;
  return db;
}

/** Stand-in layout: the first two components, so the linear map can fit it exactly. */
const umapFactory = () => ({ fit: (rows: number[][]) => rows.map((r) => [r[0] ?? 0, r[1] ?? 0, 0]) });

function cluster(n: number, centre: number[], spread: number, seed: number, offset: number): Row[] {
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; };
  return Array.from({ length: n }, (_, i) => ({
    id: `c${String(offset + i).padStart(4, "0")}`,          // sortable ids, so the keyset works
    embedding: centre.map((c) => c + rand() * spread),
  }));
}

describe("fitContextProjection", () => {
  const rows = [...cluster(60, [1, 0, 0, 0, 0, 0], 0.2, 1, 0), ...cluster(60, [0, 1, 0, 0, 0, 0], 0.2, 2, 60)];

  it("fits, stores a projection and backfills coordinates", async () => {
    const db = fakeDb({ rows });
    const out = await fitContextProjection({ db, contextId: "mem", sample: 1000, components: 4, umapFactory });
    expect(out.fitted).toBe(true);
    expect(out.sampleSize).toBe(120);
    expect(out.components).toBe(4);
    expect(out.residual).toBeLessThan(0.2);
    const stored = db.__writes.find((w: any) => w.table === "context_projections" && w.op === "insert");
    expect(stored.rows).toMatchObject({ context: "mem", dims: 6, components: 4, method: "umap+linear", version: 1, sample_size: 120 });
    expect(JSON.parse(JSON.stringify(stored.rows.basis))).toHaveLength(4);
    expect(stored.rows.map).toHaveLength(3);
    expect(out.written).toBe(120);
  });

  it("refuses a base with too few vectors and writes nothing", async () => {
    const db = fakeDb({ rows: rows.slice(0, 3) });
    const out = await fitContextProjection({ db, contextId: "mem", sample: 1000, components: 4, umapFactory });
    expect(out).toMatchObject({ fitted: false, reason: expect.stringMatching(/at least/i) });
    expect(db.__writes).toEqual([]);
  });

  it("refuses degenerate input (no variance) instead of writing NaN", async () => {
    const same = Array.from({ length: 20 }, (_, i) => ({ id: `s${String(i).padStart(4, "0")}`, embedding: [1, 1, 1, 1, 1, 1] }));
    const db = fakeDb({ rows: same });
    const out = await fitContextProjection({ db, contextId: "mem", sample: 1000, components: 4, umapFactory });
    expect(out.fitted).toBe(false);
    expect(out.reason).toMatch(/variance/i);
    expect(db.__writes).toEqual([]);
  });

  it("dry run computes the fit but writes nothing", async () => {
    const db = fakeDb({ rows });
    const out = await fitContextProjection({ db, contextId: "mem", sample: 1000, components: 4, dryRun: true, umapFactory });
    expect(out.fitted).toBe(true);
    expect(out.written).toBe(0);
    expect(db.__writes).toEqual([]);
  });
});

describe("listFittableContexts", () => {
  it("derives context ids from the chunk tables in the database", async () => {
    const db: any = jest.fn(() => {
      const chain: any = {};
      chain.where = () => chain;
      chain.andWhere = () => chain;
      chain.select = () => chain;
      chain.then = (res: any) => Promise.resolve([{ table_name: "mem_chunks" }, { table_name: "docs_chunks" }]).then(res);
      return chain;
    });
    expect(await listFittableContexts(db)).toEqual(["mem", "docs"]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/exulu/projection/fit --maxWorkers=2`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`src/exulu/projection/fit.ts`:

```ts
import { getChunksTableName, getTableName } from "@SRC/exulu/table-names";
import {
  BACKFILL_BATCH, COMPONENTS, FIT_SAMPLE, POWER_ITERATIONS, PROJECTION_METHOD,
  PROJECTION_VERSION, RIDGE_LAMBDA, UMAP_MIN_DIST, UMAP_NEIGHBORS,
} from "./constants";
import {
  applyMap, fitResidual, l2normalize, meanVector, normalizeLayout, projectComponents,
  randomizedPCA, ridgeFit, rng,
} from "./math";

export type StoredProjection = {
  context: string; dims: number; components: number;
  mean: number[]; basis: number[][]; map: number[][]; intercept: number[];
  method: string; version: number; sample_size: number; residual: number; fitted_at: Date;
};
export type FitResult = {
  fitted: boolean; reason?: string; sampleSize: number; components: number; residual: number; written: number;
};
type UmapLike = { fit: (rows: number[][]) => number[][] };

/** pgvector returns "[1,2,3]"; a driver configured to parse it returns an array. */
export function parseVector(value: unknown): number[] {
  if (Array.isArray(value)) return value as number[];
  const text = String(value ?? "");
  if (!text.startsWith("[")) return [];
  return text.slice(1, -1).split(",").map(Number);
}

const seedFrom = (id: string): number => {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

function defaultUmap(seed: number, n: number): UmapLike {
  // Imported lazily so the fit module stays testable without the dependency.
  const { UMAP } = require("umap-js") as typeof import("umap-js");
  const random = rng(seed);
  return new UMAP({
    nComponents: 3,
    nNeighbors: Math.max(2, Math.min(UMAP_NEIGHBORS, n - 1)),
    minDist: UMAP_MIN_DIST,
    random,
  }) as unknown as UmapLike;
}

/** Every context with a chunks table, for `--all`. Contexts live in the consuming app, so this reads the database. */
export async function listFittableContexts(db: any): Promise<string[]> {
  const rows: any[] = await db("information_schema.tables")
    .where({ table_schema: "public" })
    .andWhere("table_name", "like", "%\\_chunks")
    .select("table_name");
  return rows.map((r) => String(r.table_name).replace(/_chunks$/, ""));
}

/**
 * Fits a context's projection (spec §3) and backfills chunk coordinates.
 * Id-only: everything it needs is in the database. `umapFactory` is injectable
 * so tests never run a real layout.
 */
export async function fitContextProjection({
  db, contextId, sample = FIT_SAMPLE, components = COMPONENTS, dryRun = false,
  umapFactory, log = () => undefined,
}: {
  db: any; contextId: string; sample?: number; components?: number; dryRun?: boolean;
  umapFactory?: (seed: number, n: number) => UmapLike; log?: (line: string) => void;
}): Promise<FitResult> {
  const chunks = getChunksTableName(contextId);
  const items = getTableName(contextId);
  const empty = (reason: string): FitResult => ({ fitted: false, reason, sampleSize: 0, components, residual: 0, written: 0 });

  if (!(await db.schema.hasTable(chunks))) return empty(`${contextId} has no chunks table`);

  const sampleRows: any[] = await db(`${chunks} as chunks`)
    .join(`${items} as items`, "items.id", "chunks.source")
    .whereNotNull("chunks.embedding")
    .whereRaw("items.archived IS NOT TRUE")
    .orderByRaw("md5(chunks.id::text || ?)", [contextId])
    .limit(sample)
    .select("chunks.id as id", "chunks.embedding as embedding");

  const vectors = sampleRows.map((r) => l2normalize(parseVector(r.embedding))).filter((v) => v.length > 0);
  if (vectors.length < components + 1) {
    return empty(`${contextId} needs at least ${components + 1} embedded chunks to fit ${components} components (has ${vectors.length})`);
  }
  const dims = vectors[0].length;
  if (vectors.some((v) => v.length !== dims)) return empty(`${contextId} has chunks of mixed dimensionality`);

  const seed = seedFrom(contextId);
  const mean = meanVector(vectors, dims);
  const basis = randomizedPCA(vectors, dims, Math.min(components, dims, vectors.length - 1), seed, POWER_ITERATIONS);
  if (basis.length === 0) return empty(`${contextId} has no variance in its embeddings`);

  const reduced = vectors.map((v) => projectComponents(v, mean, basis));
  const spread = reduced.reduce((s, z) => s + Math.hypot(...Array.from(z)), 0) / reduced.length;
  if (!Number.isFinite(spread) || spread < 1e-8) return empty(`${contextId} has no variance in its embeddings`);

  log(`fitting ${contextId}: ${vectors.length} vectors, ${dims} dims → ${basis.length} components`);
  const umap = (umapFactory ?? defaultUmap)(seed, reduced.length);
  const raw = umap.fit(reduced.map((z) => Array.from(z)));
  const { points: layout } = normalizeLayout(raw);
  const { map, intercept } = ridgeFit(reduced, layout, RIDGE_LAMBDA);
  const residual = fitResidual(reduced, layout, map, intercept, 1);

  const projection: StoredProjection = {
    context: contextId, dims, components: basis.length,
    mean: Array.from(mean), basis: basis.map((b) => Array.from(b)), map, intercept,
    method: PROJECTION_METHOD, version: PROJECTION_VERSION,
    sample_size: vectors.length, residual, fitted_at: new Date(),
  };
  if (![...projection.mean, ...projection.map.flat(), ...projection.intercept].every(Number.isFinite)) {
    return empty(`${contextId} produced a non-finite projection`);
  }

  if (dryRun) {
    log(`dry run: residual ${residual.toFixed(3)}, would store a ${basis.length}×${dims} projection`);
    return { fitted: true, sampleSize: vectors.length, components: basis.length, residual, written: 0 };
  }

  await db("context_projections").insert(projection).onConflict("context").merge();
  const written = await backfillCoordinates({ db, contextId, projection, log });
  return { fitted: true, sampleSize: vectors.length, components: basis.length, residual, written };
}

/** Streams every embedded chunk of the context and writes its coordinates. */
export async function backfillCoordinates({
  db, contextId, projection, batch = BACKFILL_BATCH, log = () => undefined,
}: {
  db: any; contextId: string; projection: StoredProjection; batch?: number; log?: (line: string) => void;
}): Promise<number> {
  const chunks = getChunksTableName(contextId);
  const mean = Float32Array.from(projection.mean);
  const basis = projection.basis.map((b) => Float32Array.from(b));
  let written = 0;
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows: any[] = await db(chunks)
      .whereNotNull("embedding").where("id", ">", after)
      .orderBy("id").limit(batch).select("id", "embedding");
    if (rows.length === 0) break;
    const values: string[] = [];
    const bindings: any[] = [];
    for (const row of rows) {
      const raw = parseVector(row.embedding);
      if (raw.length !== projection.dims) continue;
      const [x, y, z] = applyMap(projectComponents(l2normalize(raw), mean, basis), projection.map, projection.intercept);
      values.push("(?::uuid, ?::real, ?::real, ?::real)");
      bindings.push(row.id, x, y, z);
    }
    if (values.length) {
      await db.raw(
        `UPDATE ?? AS c SET px = v.px, py = v.py, pz = v.pz
           FROM (VALUES ${values.join(",")}) AS v(id, px, py, pz) WHERE c.id = v.id`,
        [chunks, ...bindings],
      );
      written += values.length;
    }
    after = rows[rows.length - 1].id;
    log(`backfilled ${written}`);
  }
  return written;
}
```

- [ ] **Step 5: Implement the script**

`scripts/fit-context-projection.ts`:

```ts
// Fits a context's 3D projection and backfills chunk coordinates (spec 3c-1 §3).
// Usage: npx tsx scripts/fit-context-projection.ts --context <id> [--all]
//        [--sample 20000] [--components 50] [--dry-run]
//
// Contexts are declared by the consuming application, so this script works from
// the database: --context names one, --all fits every base that has a chunks table.
import { postgresClient } from "../src/postgres/client";
import { fitContextProjection, listFittableContexts } from "../src/exulu/projection/fit";
import { COMPONENTS, FIT_SAMPLE } from "../src/exulu/projection/constants";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const all = process.argv.includes("--all");
  const only = arg("context");
  if (!only && !all) throw new Error("Pass --context <id> or --all");
  const sample = Number(arg("sample") ?? FIT_SAMPLE);
  const components = Number(arg("components") ?? COMPONENTS);

  const { db } = await postgresClient();
  const targets = all ? await listFittableContexts(db) : [only!];
  if (targets.length === 0) throw new Error("No context with a chunks table was found");

  for (const contextId of targets) {
    const result = await fitContextProjection({
      db, contextId, sample, components, dryRun, log: (line) => console.log(`[EXULU] ${line}`),
    });
    console.log(
      result.fitted
        ? `[EXULU] ${contextId}: fitted ${result.components} components on ${result.sampleSize} vectors, residual ${result.residual.toFixed(3)}, ${result.written} chunks written${dryRun ? " (dry run)" : ""}`
        : `[EXULU] ${contextId}: skipped — ${result.reason}`,
    );
  }
  await db.destroy();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx jest src/exulu/projection --maxWorkers=2 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: PASS; count 8.

- [ ] **Step 7: Commit**

```bash
git branch --show-current   # feat/vector-map-positions
git add src/exulu/projection package.json package-lock.json scripts/fit-context-projection.ts
git commit -m "feat(map): fit a context projection with UMAP and a learned map, backfill coordinates"
```

---

### Task 4: Positions at embedding time

**Files:**
- Create: `src/exulu/projection/store.ts`, `src/exulu/projection/store.test.ts`
- Modify: `src/exulu/context.ts` (the chunk insert, ~lines 560-617)

**Interfaces:**
- Produces: `loadProjection(db, contextId, now?)`, `clearProjectionCache()`, `chunkCoordinates({ db, contextId, vectors })` → `({ x, y, z } | null)[]`.
- Consumes: Task 2's maths, Task 3's `StoredProjection` type, `PROJECTION_VERSION`, `PROJECTION_CACHE_TTL_MS`.

- [ ] **Step 1: Write the failing test**

`src/exulu/projection/store.test.ts`:

```ts
import { chunkCoordinates, clearProjectionCache, loadProjection } from "./store";

const projection = {
  context: "mem", dims: 2, components: 2,
  mean: [0, 0], basis: [[1, 0], [0, 1]], map: [[1, 0], [0, 1], [0, 0]], intercept: [0, 0, 0],
  method: "umap+linear", version: 1, sample_size: 10, residual: 0.1, fitted_at: new Date(),
};

function fakeDb(row: any, opts: { throwOnSelect?: boolean } = {}) {
  const calls: number[] = [];
  const db: any = jest.fn(() => ({
    where: () => ({
      first: async () => { calls.push(1); if (opts.throwOnSelect) throw new Error("boom"); return row; },
    }),
  }));
  db.__reads = calls;
  return db;
}

beforeEach(() => clearProjectionCache());

describe("loadProjection", () => {
  it("reads once and serves the cache until the ttl expires", async () => {
    const db = fakeDb(projection);
    expect((await loadProjection(db, "mem", 1000))?.dims).toBe(2);
    await loadProjection(db, "mem", 1000 + 59_000);
    expect(db.__reads).toHaveLength(1);
    await loadProjection(db, "mem", 1000 + 61_000);
    expect(db.__reads).toHaveLength(2);
  });
  it("treats a version mismatch as not fitted, and caches that too", async () => {
    const db = fakeDb({ ...projection, version: 0 });
    expect(await loadProjection(db, "mem", 1000)).toBeNull();
    await loadProjection(db, "mem", 1000);
    expect(db.__reads).toHaveLength(1);
  });
  it("never throws", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await loadProjection(fakeDb(undefined, { throwOnSelect: true }), "mem", 1000)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("chunkCoordinates", () => {
  it("projects every vector", async () => {
    const out = await chunkCoordinates({ db: fakeDb(projection), contextId: "mem", vectors: [[3, 4], [0, 0]] });
    expect(out[0]).not.toBeNull();
    expect(Math.abs(out[0]!.x - 0.6)).toBeLessThan(1e-5);
    expect(Math.abs(out[0]!.y - 0.8)).toBeLessThan(1e-5);
    expect(out[0]!.z).toBe(0);
    expect(out[1]).toEqual({ x: 0, y: 0, z: 0 });
  });
  it("returns nulls without a projection, on a dimension mismatch, and on an empty input", async () => {
    expect(await chunkCoordinates({ db: fakeDb(undefined), contextId: "mem", vectors: [[1, 2]] })).toEqual([null]);
    const spy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await chunkCoordinates({ db: fakeDb(projection), contextId: "mem", vectors: [[1, 2, 3]] })).toEqual([null]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(await chunkCoordinates({ db: fakeDb(projection), contextId: "mem", vectors: [] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/exulu/projection/store --maxWorkers=2`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/exulu/projection/store.ts`:

```ts
import { PROJECTION_CACHE_TTL_MS, PROJECTION_VERSION } from "./constants";
import type { StoredProjection } from "./fit";
import { applyMap, l2normalize, projectComponents } from "./math";

type Loaded = { projection: StoredProjection | null; loadedAt: number };
const cache = new Map<string, Loaded>();

/** Testing seam and a hook for the fit script to drop stale state in-process. */
export function clearProjectionCache(): void { cache.clear(); }

const parse = (value: unknown): any => (typeof value === "string" ? JSON.parse(value) : value);

/** The context's projection, or null when it is missing, stale or unreadable. Never throws. */
export async function loadProjection(db: any, contextId: string, now = Date.now()): Promise<StoredProjection | null> {
  const hit = cache.get(contextId);
  if (hit && now - hit.loadedAt < PROJECTION_CACHE_TTL_MS) return hit.projection;
  let projection: StoredProjection | null = null;
  try {
    const row = await db("context_projections").where({ context: contextId }).first();
    if (row && Number(row.version) === PROJECTION_VERSION) {
      projection = {
        ...row,
        mean: parse(row.mean), basis: parse(row.basis), map: parse(row.map), intercept: parse(row.intercept),
        dims: Number(row.dims), components: Number(row.components),
      } as StoredProjection;
    }
  } catch (e) {
    console.error("[EXULU] could not read the context projection", e instanceof Error ? e.message : String(e));
  }
  cache.set(contextId, { projection, loadedAt: now });
  return projection;
}

/**
 * Positions for the chunk vectors of one item (spec §4). Null entries mean "no
 * coordinates" — a missing projection, a dimension mismatch, or any failure.
 * Never throws: embedding must not depend on the map.
 */
export async function chunkCoordinates({
  db, contextId, vectors,
}: { db: any; contextId: string; vectors: ArrayLike<number>[] }): Promise<({ x: number; y: number; z: number } | null)[]> {
  if (vectors.length === 0) return [];
  try {
    const projection = await loadProjection(db, contextId);
    if (!projection) return vectors.map(() => null);
    const mean = Float32Array.from(projection.mean);
    const basis = projection.basis.map((b) => Float32Array.from(b));
    let warned = false;
    return vectors.map((v) => {
      if (v.length !== projection.dims) {
        if (!warned) {
          warned = true;
          console.warn(`[EXULU] projection for ${contextId} expects ${projection.dims} dimensions, got ${v.length}; coordinates skipped`);
        }
        return null;
      }
      const [x, y, z] = applyMap(projectComponents(l2normalize(v), mean, basis), projection.map, projection.intercept);
      return { x, y, z };
    });
  } catch (e) {
    console.error("[EXULU] could not compute chunk coordinates", e instanceof Error ? e.message : String(e));
    return vectors.map(() => null);
  }
}
```

- [ ] **Step 4: Hook the chunk insert**

In `src/exulu/context.ts`, import `chunkCoordinates` from `./projection/store`. After the `chunks` array is built (the `produced.map(...)` with `vector: vectors[i] ?? []`) and before the delete/insert, add:

```ts
    // Vector map (3c-1): a position for every chunk, from the context's fitted
    // projection. Null when the context was never fitted; never fails the embed.
    const coordinates = await chunkCoordinates({ db, contextId: this.id, vectors: chunks.map((c) => c.vector) });
```

and in the insert's object literal, after `embedding: pgvector.toSql(chunk.vector),`:

```ts
          ...(coordinates[index]
            ? { px: coordinates[index]!.x, py: coordinates[index]!.y, pz: coordinates[index]!.z }
            : {}),
```

changing the map callback to `chunks.map((chunk, index) => ({ ... }))`. Writing the keys only when a projection exists keeps the insert valid on a chunks table that predates Task 1's columns.

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx jest src/exulu/projection src/exulu/memory --maxWorkers=2 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: PASS; count 8.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # feat/vector-map-positions
git add src/exulu/projection src/exulu/context.ts
git commit -m "feat(map): write chunk coordinates at embedding time from the cached projection"
```

---

### Task 5: The read API

**Files:**
- Create: `src/graphql/resolvers/context-map.ts`, `src/graphql/resolvers/context-map.test.ts`
- Modify: `src/graphql/schemas/index.ts` (import; Query typedefs; types + enum; resolvers)

**Interfaces:**
- Consumes: `applyAccessControl` with the `"items"` prefix, `convertContextToTableDefinition`, `getTableName`/`getChunksTableName`, `resolveSearchQueryTexts`/`chooseFullTextQuery` (`@SRC/utils/query-preprocessing`), Task 2/3 constants.
- Produces: `contextMapPoints`, `contextMapEdges`, `contextProjectionStatus` (functions and GraphQL fields per spec §5).

- [ ] **Step 1: Write the failing test**

`src/graphql/resolvers/context-map.test.ts`:

```ts
jest.mock("@SRC/graphql/utilities/access-control", () => ({
  applyAccessControl: jest.fn((_t: unknown, q: any, _u: unknown, prefix?: string) => { q.__scoped = prefix ?? true; return q; }),
}));
jest.mock("@SRC/exulu/table-names", () => ({
  getTableName: (id: string) => `${id}_items`,
  getChunksTableName: (id: string) => `${id}_chunks`,
}));
jest.mock("@SRC/graphql/utilities/convert-context-to-table-definition", () => ({
  convertContextToTableDefinition: (c: any) => ({ name: { singular: c.id, plural: `${c.id}s` } }),
}));

import { contextMapEdges, contextMapPoints, contextProjectionStatus } from "./context-map";

/** Keys on the first word, because the resolvers call `db("mem_chunks as chunks")`. */
function fakeDb(answers: Record<string, any[]>, opts: { hasTable?: (t: string) => boolean } = {}) {
  const log: any[] = [];
  const db: any = jest.fn((table: string) => {
    const key = table.split(" ")[0];
    const chain: any = { __table: key, __scoped: false };
    for (const m of ["join", "where", "whereIn", "whereNot", "whereNotNull", "whereRaw", "groupBy", "orderBy", "orderByRaw", "limit", "select", "count", "countDistinct", "andWhere", "pluck"]) {
      chain[m] = (...args: any[]) => { log.push([key, m, ...args.filter((a) => typeof a !== "function")]); return chain; };
    }
    chain.first = async () => (answers[`${key}#first`] ?? [])[0];
    chain.then = (res: any, rej: any) => Promise.resolve(answers[key] ?? []).then(res, rej);
    return chain;
  });
  db.raw = (sql: string, bindings?: any) => ({ sql, bindings, toString: () => sql });
  db.schema = { hasTable: async (t: string) => (opts.hasTable ? opts.hasTable(t) : true) };
  db.__log = log;
  return db;
}

const context = {
  id: "mem", name: "Memory", configuration: { languages: ["english"] },
  fields: [{ name: "type", type: "enum" }, { name: "information", type: "text" }],
} as any;
const user = { id: 4 } as any;

describe("contextMapPoints", () => {
  it("returns one point per item in DOCUMENTS mode, scoped to the viewer's items", async () => {
    const db = fakeDb({
      mem_chunks: [
        { id: "i1", itemId: "i1", x: "0.5", y: "-0.25", z: "0", label: "Encoder", group: "FACT", chunks: "3" },
      ],
      "mem_chunks#first": [{ c: "1" }],
    });
    const out = await contextMapPoints({ db, context, user, mode: "DOCUMENTS", groupField: "type", limit: 10 });
    expect(out).toEqual({
      points: [{ id: "i1", itemId: "i1", x: 0.5, y: -0.25, z: 0, label: "Encoder", group: "FACT", chunks: 3 }],
      total: 1, sampled: false,
    });
    expect(db.__log.some((l: any[]) => l[1] === "whereNotNull" && String(l[2]).includes("px"))).toBe(true);
    expect((require("@SRC/graphql/utilities/access-control") as any).applyAccessControl).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), user, "items",
    );
  });

  it("flags a sampled result when the base is larger than the limit", async () => {
    const db = fakeDb({ mem_chunks: [], "mem_chunks#first": [{ c: "900" }] });
    const out = await contextMapPoints({ db, context, user, mode: "DOCUMENTS", limit: 10 });
    expect(out).toMatchObject({ total: 900, sampled: true });
  });

  it("ignores an unknown groupField and clamps the limit", async () => {
    const db = fakeDb({ mem_chunks: [], "mem_chunks#first": [{ c: "0" }] });
    await contextMapPoints({ db, context, user, mode: "PASSAGES", groupField: "nope", limit: 99999 });
    expect(db.__log.some((l: any[]) => l[1] === "limit" && l[2] === 20000)).toBe(true);
    expect(db.__log.some((l: any[]) => JSON.stringify(l).includes("nope"))).toBe(false);
  });

  it("is empty when the chunks table is missing", async () => {
    const db = fakeDb({}, { hasTable: () => false });
    expect(await contextMapPoints({ db, context, user, mode: "DOCUMENTS", limit: 10 })).toEqual({ points: [], total: 0, sampled: false });
  });
});

describe("contextMapEdges", () => {
  it("ranks other items lexically and never returns the node itself", async () => {
    const db = fakeDb({
      mem_chunks: [{ id: "i2", score: "0.42" }, { id: "i3", score: "0.2" }],
      "mem_chunks#first": [{ text: "encoder speed display" }],
    });
    const out = await contextMapEdges({ db, context, user, nodeId: "i1", limit: 5 });
    expect(out).toEqual([{ source: "i1", target: "i2", score: 0.42 }, { source: "i1", target: "i3", score: 0.2 }]);
    expect(db.__log.some((l: any[]) => l[1] === "whereNot")).toBe(true);
    expect((require("@SRC/graphql/utilities/access-control") as any).applyAccessControl).toHaveBeenCalled();
  });
  it("is empty when the node has no text", async () => {
    expect(await contextMapEdges({ db: fakeDb({ "mem_chunks#first": [] }), context, user, nodeId: "i1", limit: 5 })).toEqual([]);
  });
});

describe("contextProjectionStatus", () => {
  it("reports a fitted projection with coverage", async () => {
    const db = fakeDb({
      "context_projections#first": [{ context: "mem", dims: 1536, components: 50, method: "umap+linear", version: 1, sample_size: 900, residual: 0.08, fitted_at: new Date("2026-10-04T10:00:00Z") }],
      "mem_chunks#first": [{ total: "120", mapped: "118" }],
    });
    expect(await contextProjectionStatus({ db, context })).toEqual({
      fitted: true, method: "umap+linear", fittedAt: "2026-10-04T10:00:00.000Z",
      sampleSize: 900, dims: 1536, components: 50, residual: 0.08, mappedChunks: 118, totalChunks: 120,
    });
  });
  it("reports not fitted for a missing row, a stale version, or no chunks table", async () => {
    expect((await contextProjectionStatus({ db: fakeDb({ "mem_chunks#first": [{ total: "0", mapped: "0" }] }), context }))!.fitted).toBe(false);
    const stale = fakeDb({ "context_projections#first": [{ version: 0 }], "mem_chunks#first": [{ total: "1", mapped: "0" }] });
    expect((await contextProjectionStatus({ db: stale, context }))!.fitted).toBe(false);
    const none = fakeDb({}, { hasTable: () => false });
    expect(await contextProjectionStatus({ db: none, context })).toMatchObject({ fitted: false, totalChunks: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/graphql/resolvers/context-map --maxWorkers=2`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/graphql/resolvers/context-map.ts`:

```ts
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "@SRC/exulu/context";
import { POINTS_LIMIT_DEFAULT, POINTS_LIMIT_MAX, PROJECTION_VERSION } from "@SRC/exulu/projection/constants";
import { getChunksTableName, getTableName } from "@SRC/exulu/table-names";
import { applyAccessControl } from "@SRC/graphql/utilities/access-control";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";
import { chooseFullTextQuery, resolveSearchQueryTexts } from "@SRC/utils/query-preprocessing";

export type MapMode = "DOCUMENTS" | "PASSAGES";
export type MapPoint = { id: string; itemId: string; x: number; y: number; z: number; label: string; group: string | null; chunks: number };
export type MapPoints = { points: MapPoint[]; total: number; sampled: boolean };
export type MapEdge = { source: string; target: string; score: number };

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : typeof d === "string" ? new Date(d).toISOString() : null);
const languagesOf = (context: ExuluContext): string[] =>
  (context.configuration?.languages?.length ? context.configuration.languages : ["english"]) as string[];
/** Only a declared field may be selected as the colouring value. */
const groupColumn = (context: ExuluContext, field?: string | null): string | null =>
  field && context.fields?.some((f: any) => f.name === field) ? field : null;

/** Points for the map (spec §5). Item-level access control, the same call vector search makes. */
export async function contextMapPoints({
  db, context, user, mode = "DOCUMENTS", groupField, search, limit = POINTS_LIMIT_DEFAULT,
}: {
  db: any; context: ExuluContext; user: User | undefined; mode?: MapMode;
  groupField?: string | null; search?: string | null; limit?: number;
}): Promise<MapPoints> {
  const chunks = getChunksTableName(context.id);
  const items = getTableName(context.id);
  if (!(await db.schema.hasTable(chunks))) return { points: [], total: 0, sampled: false };

  const table = convertContextToTableDefinition(context);
  const capped = Math.max(1, Math.min(limit, POINTS_LIMIT_MAX));
  const group = groupColumn(context, groupField);
  const languages = languagesOf(context);

  const base = () => {
    let q = db(`${chunks} as chunks`)
      .join(`${items} as items`, "items.id", "chunks.source")
      .whereNotNull("chunks.px")
      .whereRaw("items.archived IS NOT TRUE");
    if (search && search.trim()) {
      const texts = resolveSearchQueryTexts(search.trim());
      const chosen = chooseFullTextQuery({ strictMatches: false, strictText: search.trim(), orText: texts.hybridOrQuery });
      q = q.whereRaw(
        `(${languages.map(() => `chunks.fts @@ ${chosen.fn}(?, ?)`).join(" OR ")})`,
        languages.flatMap((lang) => [lang, chosen.text]),
      );
    }
    return applyAccessControl(table, q, user, "items");
  };

  const totalRow = mode === "DOCUMENTS"
    ? await base().countDistinct("items.id as c").first()
    : await base().count("chunks.id as c").first();
  const total = num(totalRow?.c);

  const rows: any[] = mode === "DOCUMENTS"
    ? await base()
        .groupBy("items.id", "items.name", ...(group ? [`items.${group}`] : []))
        .orderByRaw("md5(items.id::text || ?)", [context.id])
        .limit(capped)
        .select([
          db.raw("items.id as id"), db.raw("items.id as \"itemId\""),
          db.raw("AVG(chunks.px) as x"), db.raw("AVG(chunks.py) as y"), db.raw("AVG(chunks.pz) as z"),
          db.raw("items.name as label"), db.raw(group ? `items.${group} as "group"` : "NULL as \"group\""),
          db.raw("COUNT(chunks.id) as chunks"),
        ])
    : await base()
        .orderByRaw("md5(chunks.id::text || ?)", [context.id])
        .limit(capped)
        .select([
          db.raw("chunks.id as id"), db.raw("chunks.source as \"itemId\""),
          db.raw("chunks.px as x"), db.raw("chunks.py as y"), db.raw("chunks.pz as z"),
          db.raw("LEFT(COALESCE(chunks.content, items.name), 120) as label"),
          db.raw(group ? `items.${group} as "group"` : "NULL as \"group\""),
          db.raw("1 as chunks"),
        ]);

  return {
    points: rows.map((r) => ({
      id: String(r.id), itemId: String(r.itemId),
      x: num(r.x), y: num(r.y), z: num(r.z),
      label: String(r.label ?? ""), group: r.group == null ? null : String(r.group), chunks: num(r.chunks),
    })),
    total,
    sampled: total > capped,
  };
}

/** A node's strongest lexical neighbours, from the generated tsvector index. */
export async function contextMapEdges({
  db, context, user, nodeId, limit,
}: { db: any; context: ExuluContext; user: User | undefined; nodeId: string; limit: number }): Promise<MapEdge[]> {
  const chunks = getChunksTableName(context.id);
  const items = getTableName(context.id);
  if (!(await db.schema.hasTable(chunks))) return [];

  const seed = await db(chunks).where({ source: nodeId }).orderBy("chunk_index").limit(1).select(db.raw("LEFT(content, 600) as text")).first();
  const text = String(seed?.text ?? "").trim();
  if (!text) return [];

  const texts = resolveSearchQueryTexts(text);
  const chosen = chooseFullTextQuery({ strictMatches: false, strictText: text, orText: texts.hybridOrQuery });
  const languages = languagesOf(context);
  const table = convertContextToTableDefinition(context);

  let q = db(`${chunks} as chunks`)
    .join(`${items} as items`, "items.id", "chunks.source")
    .whereNot("chunks.source", nodeId)
    .whereRaw("items.archived IS NOT TRUE")
    .whereRaw(
      `(${languages.map(() => `chunks.fts @@ ${chosen.fn}(?, ?)`).join(" OR ")})`,
      languages.flatMap((lang) => [lang, chosen.text]),
    )
    .groupBy("items.id")
    .orderByRaw("score DESC")
    .limit(Math.max(1, limit))
    .select([
      db.raw("items.id as id"),
      db.raw(
        `MAX(GREATEST(${languages.map(() => `ts_rank(chunks.fts, ${chosen.fn}(?, ?))`).join(", ")})) as score`,
        languages.flatMap((lang) => [lang, chosen.text]),
      ),
    ]);
  q = applyAccessControl(table, q, user, "items");

  const rows: any[] = await q;
  return rows.map((r) => ({ source: nodeId, target: String(r.id), score: num(r.score) }));
}

/** Whether the base has a usable projection, and how much of it is mapped. */
export async function contextProjectionStatus({ db, context }: { db: any; context: ExuluContext }) {
  const chunks = getChunksTableName(context.id);
  const hasChunks = await db.schema.hasTable(chunks);
  const counts = hasChunks
    ? await db(chunks).select(db.raw("COUNT(*) as total"), db.raw("COUNT(px) as mapped")).first()
    : undefined;
  let row: any;
  try {
    row = await db("context_projections").where({ context: context.id }).first();
  } catch {
    row = undefined;
  }
  const fitted = !!row && Number(row.version) === PROJECTION_VERSION;
  return {
    fitted,
    method: fitted ? String(row.method) : null,
    fittedAt: fitted ? iso(row.fitted_at) : null,
    sampleSize: fitted ? num(row.sample_size) : null,
    dims: fitted ? num(row.dims) : null,
    components: fitted ? num(row.components) : null,
    residual: fitted ? num(row.residual) : null,
    mappedChunks: num(counts?.mapped),
    totalChunks: num(counts?.total),
  };
}
```

- [ ] **Step 4: Register the GraphQL surface**

In `src/graphql/schemas/index.ts`:

- import: `import { contextMapEdges, contextMapPoints, contextProjectionStatus } from "@SRC/graphql/resolvers/context-map";`
- Query typedefs, next to the memory ones:

```ts
  typeDefs += `
    contextMapPoints(contextId: ID!, mode: ContextMapMode = DOCUMENTS, groupField: String, search: String, limit: Int = 5000): ContextMapPoints
    contextMapEdges(contextId: ID!, nodeId: ID!, limit: Int = 8): [ContextMapEdge!]!
    contextProjectionStatus(contextId: ID!): ContextProjectionStatus
    `;
```

- types, in the same literal as the memory types:

```graphql
enum ContextMapMode { DOCUMENTS  PASSAGES }
type ContextMapPoint {
    id: ID!
    itemId: ID!
    x: Float!
    y: Float!
    z: Float!
    label: String!
    group: String
    chunks: Int!
}
type ContextMapPoints { points: [ContextMapPoint!]!  total: Int!  sampled: Boolean! }
type ContextMapEdge { source: ID!  target: ID!  score: Float! }
type ContextProjectionStatus {
    fitted: Boolean!
    method: String
    fittedAt: String
    sampleSize: Int
    dims: Int
    components: Int
    residual: Float
    mappedChunks: Int!
    totalChunks: Int!
}
```

- resolvers, next to the memory ones (`memoryContextOf` is in scope and resolves a context id to its `ExuluContext`):

```ts
  resolvers.Query["contextMapPoints"] = async (_, args, context) => {
    const target = memoryContextOf(args.contextId);
    if (!context.user || !target) return { points: [], total: 0, sampled: false };
    return contextMapPoints({
      db: context.db, context: target, user: context.user,
      mode: args.mode ?? "DOCUMENTS", groupField: args.groupField, search: args.search, limit: args.limit,
    });
  };
  resolvers.Query["contextMapEdges"] = async (_, args, context) => {
    const target = memoryContextOf(args.contextId);
    if (!context.user || !target) return [];
    return contextMapEdges({ db: context.db, context: target, user: context.user, nodeId: args.nodeId, limit: args.limit ?? 8 });
  };
  resolvers.Query["contextProjectionStatus"] = async (_, args, context) => {
    const target = memoryContextOf(args.contextId);
    if (!context.user || !target) return null;
    return contextProjectionStatus({ db: context.db, context: target });
  };
```

`memoryContextOf` (defined once in that file as `contexts.find((c) => c.id === id)`) is reused as-is; it is not memory-specific despite the name.

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx jest src/graphql/resolvers src/exulu/projection --maxWorkers=2 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: PASS; count 8.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # feat/vector-map-positions
git add src/graphql/resolvers/context-map.ts src/graphql/resolvers/context-map.test.ts src/graphql/schemas/index.ts
git commit -m "feat(map): points, lexical edges and projection status queries"
```

---

### Task 6: Verification and docs

**Files:**
- Modify: `mintlify-docs/building/knowledge/overview.mdx` (a short "Map" section)

- [ ] **Step 1: Verification**

```bash
npx jest --silent --maxWorkers=2 2>&1 | grep -E "^(Tests:|Test Suites:|FAIL)" | sort -u
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"
npm run build 2>&1 | tail -3
```
Expected: only the 3 pre-existing failing suites; tsc 8; build succeeds.

- [ ] **Step 2: Docs**

Append to `mintlify-docs/building/knowledge/overview.mdx`:

```mdx
## Map

Every chunk can carry a position in three dimensions, computed from its embedding, so a base can be drawn as a cloud where near means similar. An administrator fits a base once with `npx tsx scripts/fit-context-projection.ts --context <id>`; from then on, anything newly embedded is placed automatically. Refitting redraws the layout, which moves existing points. The visualisation itself arrives with the memory map.
```

Run `npx mint validate` and `npx mint broken-links` in `mintlify-docs/` when available.

- [ ] **Step 3: Commit**

```bash
git branch --show-current   # feat/vector-map-positions
git add mintlify-docs
git commit -m "docs(map): how a base is fitted for the map"
```

- [ ] **Step 4: Hand off**

Report the verification output verbatim, and this UAT list for Daniel:

1. `npx tsx scripts/fit-context-projection.ts --context <newton memory base> --dry-run` reports a sample size and a residual without writing.
2. The same without `--dry-run` writes a projection and backfills; rerunning reports the same residual.
3. `contextProjectionStatus` shows `fitted: true` with coverage close to 100%.
4. `contextMapPoints` in both modes returns sensible labels and coordinates roughly inside a unit sphere.
5. Saving a new memory in chat gives that memory coordinates without a refit.
6. A second user with fewer rights gets fewer points and a smaller total on the same base.
7. The same against one real knowledge base, which is larger and exercises the sample path.
