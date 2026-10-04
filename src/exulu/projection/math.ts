/**
 * Pure linear algebra for the vector map (spec §3). Typed arrays and plain
 * loops: a full covariance eigendecomposition on a 1536-dimension model costs
 * minutes, the subspace iteration here costs seconds, and neither needs a
 * matrix library.
 *
 * `noUncheckedIndexedAccess` is on for this repo, so every indexed read below
 * carries a `?? 0` (or `?? []`) fallback. Several of those are load-bearing
 * rather than cosmetic: loops are bounded by one array's `.length` while
 * reading a second (`projectComponents` walks `mean.length` into `v`,
 * `ridgeFit` walks `Z[0].length` into every other row), so a short or ragged
 * input reads as 0 instead of throwing.
 *
 * Every exported function returns finite numbers or nothing: callers persist
 * these values, and a NaN that reaches the database poisons a whole map
 * silently. Degenerate input (empty, single-row, all-zero, zero-variance)
 * collapses to zeros rather than NaN.
 */

/** A missing or non-finite component, read as 0. */
function finite(x: number | undefined): number {
  return x !== undefined && Number.isFinite(x) ? x : 0;
}

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
  for (let i = 0; i < v.length; i += 1) {
    const vi = v[i] ?? 0;
    norm += vi * vi;
  }
  norm = Math.sqrt(norm);
  const out = new Float32Array(v.length);
  // A non-finite norm (an infinite or NaN component) would divide to NaN.
  if (norm === 0 || !Number.isFinite(norm)) return out;
  for (let i = 0; i < v.length; i += 1) out[i] = (v[i] ?? 0) / norm;
  return out;
}

export function meanVector(rows: ArrayLike<number>[], dims: number): Float32Array {
  const out = new Float32Array(dims);
  if (rows.length === 0) return out;
  // Summing in float64: at FIT_SAMPLE rows a float32 accumulator loses several
  // significant digits, and this mean is the origin of the whole map.
  const sum = new Float64Array(dims);
  for (const row of rows) {
    // `finite`, not `?? 0`: one NaN or Infinity component in one row would
    // otherwise poison that component of the mean, and the mean is persisted.
    for (let d = 0; d < dims; d += 1) sum[d] = (sum[d] ?? 0) + finite(row[d]);
  }
  for (let d = 0; d < dims; d += 1) out[d] = (sum[d] ?? 0) / rows.length;
  return out;
}

function orthonormalize(vectors: ArrayLike<number>[], dims: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (const candidate of vectors) {
    // Gram-Schmidt runs in float64; the result is narrowed to float32 only when
    // a direction is accepted into the basis.
    const v = new Float64Array(dims);
    for (let d = 0; d < dims; d += 1) v[d] = candidate[d] ?? 0;
    for (const basis of out) {
      let dot = 0;
      for (let d = 0; d < dims; d += 1) dot += (v[d] ?? 0) * (basis[d] ?? 0);
      for (let d = 0; d < dims; d += 1) v[d] = (v[d] ?? 0) - dot * (basis[d] ?? 0);
    }
    let norm = 0;
    for (let d = 0; d < dims; d += 1) {
      const vd = v[d] ?? 0;
      norm += vd * vd;
    }
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm < 1e-8) continue;   // degenerate direction, drop it
    const unit = new Float32Array(dims);
    for (let d = 0; d < dims; d += 1) unit[d] = (v[d] ?? 0) / norm;
    out.push(unit);
  }
  return out;
}

/**
 * An orthonormal basis of the top-`k` principal subspace of `rows`, by subspace
 * iteration (the mean is computed here and subtracted on the fly). Cost is
 * `iterations · rows · dims · k`.
 *
 * The basis spans the dominant subspace but its vectors are NOT the individual
 * principal axes and are NOT ordered by variance, so do not read component 0 as
 * "the largest". Downstream only needs the span. Returns fewer than `k` vectors
 * when the data has less rank than that, and for zero-variance input keeps the
 * random starting basis rather than returning NaN.
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
    // float64 accumulator: this sums `rows` outer-product contributions at
    // larger magnitudes than meanVector does, so float32 would drift further.
    const next = basis.map(() => new Float64Array(dims));
    for (const row of rows) {
      const centered = new Float64Array(dims);
      for (let d = 0; d < dims; d += 1) centered[d] = (row[d] ?? 0) - (mean[d] ?? 0);
      // z = basisᵀ(row - mean)
      const z = new Float64Array(basis.length);
      for (const [b, vec] of basis.entries()) {
        let dot = 0;
        for (let d = 0; d < dims; d += 1) dot += (centered[d] ?? 0) * (vec[d] ?? 0);
        z[b] = dot;
      }
      // next += (row - mean) zᵀ
      for (const [b, target] of next.entries()) {
        const scale = z[b] ?? 0;
        if (scale === 0) continue;
        for (let d = 0; d < dims; d += 1) target[d] = (target[d] ?? 0) + (centered[d] ?? 0) * scale;
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
  for (const [b, vec] of basis.entries()) {
    let dot = 0;
    for (let d = 0; d < mean.length; d += 1) dot += ((v[d] ?? 0) - (mean[d] ?? 0)) * (vec[d] ?? 0);
    // Guarding the k outputs, not the `dims` reads: one check per component
    // instead of per dimension, and a contaminated vector lands on the origin.
    out[b] = finite(dot);
  }
  return out;
}

/**
 * Solves `A X = B` by Gauss-Jordan elimination with partial pivoting; `ridgeFit`
 * passes the normal equations (A = ZᵀZ + λI, B = ZᵀY). A singular column is
 * skipped, which leaves that unknown at its right-hand side: with λ > 0 the
 * matrix is positive definite so it cannot happen, and the λ = 0 degenerate case
 * has a zero right-hand side there, so the unknown comes out 0.
 */
function solve(A: number[][], B: number[][]): number[][] {
  const n = A.length;
  const cols = B[0]?.length ?? 0;
  const M = A.map((row, i) => [...row, ...(B[i] ?? [])]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      const rRow = M[r] ?? [];
      const pivotRow = M[pivot] ?? [];
      if (Math.abs(rRow[col] ?? 0) > Math.abs(pivotRow[col] ?? 0)) pivot = r;
    }
    const pivotRowForCheck = M[pivot] ?? [];
    if (Math.abs(pivotRowForCheck[col] ?? 0) < 1e-12) continue;
    const colRowBefore = M[col] ?? [];
    M[col] = pivotRowForCheck;
    M[pivot] = colRowBefore;
    const colRow = M[col] ?? [];
    const d = colRow[col] ?? 1;
    for (let c = col; c < n + cols; c += 1) colRow[c] = (colRow[c] ?? 0) / d;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const rRow = M[r] ?? [];
      const factor = rRow[col] ?? 0;
      if (factor === 0) continue;
      for (let c = col; c < n + cols; c += 1) rRow[c] = (rRow[c] ?? 0) - factor * (colRow[c] ?? 0);
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
    const zi = Z[i] ?? [];
    const yi = Y[i] ?? [];
    for (let d = 0; d < k; d += 1) zMean[d] = (zMean[d] ?? 0) + (zi[d] ?? 0);
    for (let j = 0; j < 3; j += 1) yMean[j] = (yMean[j] ?? 0) + (yi[j] ?? 0);
  }
  const n = Z.length || 1;
  for (let d = 0; d < k; d += 1) zMean[d] = (zMean[d] ?? 0) / n;
  for (let j = 0; j < 3; j += 1) yMean[j] = (yMean[j] ?? 0) / n;

  const ZtZ: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const ZtY: number[][] = Array.from({ length: k }, () => [0, 0, 0]);
  for (let i = 0; i < Z.length; i += 1) {
    const zi = Z[i] ?? [];
    const yi = Y[i] ?? [];
    for (let a = 0; a < k; a += 1) {
      const za = (zi[a] ?? 0) - (zMean[a] ?? 0);
      if (za === 0) continue;
      const ztzRow = ZtZ[a] ?? [];
      const ztyRow = ZtY[a] ?? [];
      for (let b = a; b < k; b += 1) ztzRow[b] = (ztzRow[b] ?? 0) + za * ((zi[b] ?? 0) - (zMean[b] ?? 0));
      for (let j = 0; j < 3; j += 1) ztyRow[j] = (ztyRow[j] ?? 0) + za * ((yi[j] ?? 0) - (yMean[j] ?? 0));
    }
  }
  for (let a = 0; a < k; a += 1) {
    const ztzRowA = ZtZ[a] ?? [];
    ztzRowA[a] = (ztzRowA[a] ?? 0) + lambda;
    for (let b = 0; b < a; b += 1) {
      const ztzRowB = ZtZ[b] ?? [];
      ztzRowA[b] = ztzRowB[a] ?? 0;
    }
  }
  const W = solve(ZtZ, ZtY);                       // k × 3
  const map = [0, 1, 2].map((j) => Array.from({ length: k }, (_, d) => {
    const row = W[d] ?? [];
    const w = row[j];
    return w !== undefined && Number.isFinite(w) ? w : 0;
  }));
  const intercept = [0, 1, 2].map((j) => {
    const mapRow = map[j] ?? [];
    const correction = mapRow.reduce((s, w, d) => s + w * (zMean[d] ?? 0), 0);
    const value = (yMean[j] ?? 0) - correction;
    // Same guard as `map` above: a non-finite value anywhere in Z or Y poisons
    // both means, and this intercept is persisted next to the map.
    return Number.isFinite(value) ? value : 0;
  });
  return { map, intercept };
}

export function applyMap(
  z: ArrayLike<number>, map: number[][], intercept: number[],
): [number, number, number] {
  const out: number[] = [];
  for (let j = 0; j < 3; j += 1) {
    let v = intercept[j] ?? 0;
    const row = map[j] ?? [];
    for (let d = 0; d < row.length; d += 1) v += (row[d] ?? 0) * (z[d] ?? 0);
    out.push(Number.isFinite(v) ? v : 0);
  }
  return [out[0] ?? 0, out[1] ?? 0, out[2] ?? 0];
}

/** Centres a layout on the origin and scales its 99th-percentile radius to 1. */
export function normalizeLayout(points: number[][]): { points: number[][]; center: number[]; scale: number } {
  // Coordinates go through `finite`, not `?? 0`: one NaN would otherwise poison
  // the centre and with it every point in the cloud, not just the bad one.
  const center = [0, 1, 2].map((j) => points.reduce((s, p) => s + finite(p[j]), 0) / (points.length || 1));
  const cx = center[0] ?? 0, cy = center[1] ?? 0, cz = center[2] ?? 0;
  const radii = points
    .map((p) => Math.hypot(finite(p[0]) - cx, finite(p[1]) - cy, finite(p[2]) - cz))
    .sort((a, b) => a - b);
  // Nearest-rank 99th percentile: 1-based rank ceil(0.99n), so index that minus
  // one. The previous `floor(0.99n)` sat one rank high, which made every cloud
  // of 100 points or fewer scale by its single largest radius - exactly the
  // small, fresh memory base the percentile is meant to protect from outliers.
  // Zero spread leaves scale 0, collapsing the cloud to a point.
  const p99 = radii[Math.max(0, Math.ceil(radii.length * 0.99) - 1)] ?? 0;
  const scale = p99 > 1e-9 ? 1 / p99 : 0;
  return {
    points: points.map((p) => [0, 1, 2].map((j) => (finite(p[j]) - (center[j] ?? 0)) * scale)),
    center,
    scale,
  };
}

/**
 * Mean placement error of the learned map, in the layout's own units — which
 * `normalizeLayout` has already scaled so that the cloud's 99th-percentile
 * radius is 1, so the number is relative to the cloud without being divided by
 * anything here.
 */
export function fitResidual(
  Z: ArrayLike<number>[], Y: number[][], map: number[][], intercept: number[],
): number {
  if (Z.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < Z.length; i += 1) {
    const zi = Z[i] ?? [];
    const yi = Y[i] ?? [];
    const [x, y, z] = applyMap(zi, map, intercept);
    total += Math.hypot(x - finite(yi[0]), y - finite(yi[1]), z - finite(yi[2]));
  }
  return finite(total / Z.length);
}
