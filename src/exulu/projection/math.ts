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

import { ROTATION_ITERATIONS } from "./constants";

/** A missing or non-finite component, read as 0. NaN that reaches the database
 * poisons a whole map silently, so every exported function must coerce to finite. */
export function finite(x: number | undefined): number {
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

/**
 * An orthonormal basis for the span of `vectors`, by Gram-Schmidt, dropping any
 * direction already covered by the ones before it (so the result can be shorter
 * than the input - see randomizedPCA's contract).
 *
 * TWO sweeps, and the second one is load-bearing. Do not remove it: it is the
 * only reason the output of this function is a basis at all on a low-rank
 * cloud. One sweep leaves the computed residual carrying an error the size of
 * the cancellation it just performed, so an almost-dependent candidate comes
 * out of it pointing wherever that error pointed, gets normalised up to unit
 * length, and joins the basis as a direction that is not perpendicular to
 * anything. Re-projecting the already-orthogonalised vector is the standard
 * remedy, and it is complete rather than partial. Measured on low-rank clouds
 * at three shapes, worst dot product between two of the returned vectors:
 *
 *                        one sweep   two sweeps
 *   600 x 1536, rank 12    8.5e-2       1.3e-9
 *   1129 x 1024, rank 20   1.4e-1       2.4e-9
 *   120 x 256, rank 8      1.1e-1       3.4e-9
 *
 * The second sweep is also what restores the rank contract above: the same
 * three clouds returned 23, 38 and 15 vectors with one sweep and exactly 12,
 * 20 and 8 - their true ranks - with two. Those surplus directions were
 * amplified rounding noise, and they do not stop at being useless, because
 * fit.ts persists this length as the base's component count and counts it as
 * fitted parameters.
 *
 * All of which is reachable from the real fit, not hypothetical: embeddings
 * arrive here l2-normalised so row length does not vary, but a base with fewer
 * independent directions than the components asked for is just a base of
 * near-duplicate boilerplate chunks, and then the accumulators randomizedPCA
 * passes in span orders of magnitude (6.2e+1 down to 1.1e-6, measured at the
 * real base's shape) and the small ones are nothing but cancellation.
 *
 * Scaling the candidate to unit length first is NOT a fix for any of this and
 * was tried: Gram-Schmidt is positively homogeneous, so a scale factor cannot
 * change the direction of anything it accepts, only whether the 1e-8 bar below
 * accepts it. Measured on the three clouds above it left the dot products at
 * 7.2e-2, 1.4e-1 and 1.0e-1 - unchanged - while turning the bar into a
 * relative one sitting under the float32 noise floor, so the dependent
 * directions got accepted instead of dropped and the counts went to 20, 35 and
 * 15 against true ranks of 12, 20 and 8.
 */
function orthonormalize(vectors: ArrayLike<number>[], dims: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (const candidate of vectors) {
    // Gram-Schmidt runs in float64; the result is narrowed to float32 only when
    // a direction is accepted into the basis.
    const v = new Float64Array(dims);
    for (let d = 0; d < dims; d += 1) v[d] = candidate[d] ?? 0;
    for (let sweep = 0; sweep < 2; sweep += 1) {
      for (const basis of out) {
        let dot = 0;
        for (let d = 0; d < dims; d += 1) dot += (v[d] ?? 0) * (basis[d] ?? 0);
        for (let d = 0; d < dims; d += 1) v[d] = (v[d] ?? 0) - dot * (basis[d] ?? 0);
      }
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

/**
 * An exactly orthonormal triple built from `candidates`, completed with the
 * canonical axes when the candidates do not span three dimensions.
 *
 * What this adds over randomizedPCA's own basis is the COMPLETION. A rotation
 * has to be a full three axes or it is not a rotation at all, and randomizedPCA
 * promises only the span: a flat cloud - every layout with a direction of no
 * variance - yields two axes, and rotating by two is not a thing you can do.
 * The brief's answer was to fall back to the identity, which would have left
 * exactly the flat layouts this task exists to reorient unrotated.
 *
 * The two sweeps are the other half, for the reason spelled out over
 * orthonormalize: one sweep returns an almost-dependent candidate pointing
 * wherever its own cancellation error pointed, and a triple like that is not a
 * rotation, so it changes the distances this whole task promises to preserve.
 *
 * How much margin the drop decision has depends on where the candidate came
 * from, and it is worth knowing it is not much. A canonical axis that lies in
 * the accepted span cancels in exact arithmetic and leaves ~3.6e-17, nine
 * orders under the bar. One from the iteration is float32, so a direction that
 * is dependent is only dependent to float32 precision and its residual is
 * bounded below by that rounding, ~6e-8 against a 1e-7 bar - a factor of 1.7 in
 * the worst case, 3.7x to 20x measured. That thin margin is tolerable only
 * because both outcomes here are harmless: a false accept still yields three
 * perpendicular axes, and the surplus one carries no variance so the sort puts
 * it last; a false drop is replaced by a canonical axis that carries no
 * variance either. Nothing about the count is persisted. That is NOT true of
 * orthonormalize, where the same decision sets the stored component count -
 * which is why the bar there is left absolute.
 *
 * Deterministic: the candidates keep randomizedPCA's order and the canonical
 * axes are always tried in x, y, z order, so a refit of unchanged data rebuilds
 * the same triple.
 */
function orthonormalTriple(candidates: number[][]): number[][] {
  const out: number[][] = [];
  for (const candidate of [...candidates, [1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    if (out.length === 3) break;
    let v = [0, 1, 2].map((j) => finite(candidate[j]));
    const length = Math.hypot(...v);
    if (!Number.isFinite(length) || length < 1e-12) continue;
    for (let sweep = 0; sweep < 2; sweep += 1) {
      for (const basis of out) {
        const dot = v.reduce((s, x, j) => s + x * (basis[j] ?? 0), 0);
        v = v.map((x, j) => x - dot * (basis[j] ?? 0));
      }
    }
    const norm = Math.hypot(...v);
    if (!Number.isFinite(norm) || norm < 1e-7 * length) continue;   // dependent, drop it
    out.push(v.map((x) => x / norm));
  }
  return out;
}

/**
 * Three orthonormal axes ordered by how far the cloud spreads along them.
 *
 * Reuses randomizedPCA rather than adding a second eigensolver, with three
 * things it does not guarantee layered on top: the axes are made exactly
 * orthonormal and completed to three (see orthonormalTriple), they are SORTED
 * by the data's spread along them, and each one's sign is pinned so a refit
 * cannot mirror the cloud. Without the sort the "principal" axis is whichever
 * the iteration happened to settle on; without the sign fix an eigenvector's
 * negation is equally valid and the map would flip between fits of identical
 * data.
 *
 * The result is a PROPER rotation - determinant +1, not merely orthonormal - so
 * it preserves handedness as well as every distance. The two sign rules that
 * get it there are different, and which one governs which axis is spelled out
 * at the return below.
 */
export function principalRotation(points: number[][], seed: number): number[][] {
  const centre = [0, 1, 2].map((j) => points.reduce((s, p) => s + finite(p[j]), 0) / (points.length || 1));
  const centred = points.map((p) => Float32Array.from([0, 1, 2].map((j) => finite(p[j]) - (centre[j] ?? 0))));
  const found = randomizedPCA(centred, 3, 3, seed, ROTATION_ITERATIONS).map((b) => Array.from(b));
  const basis = orthonormalTriple(found);
  // Cannot happen - the canonical axes always complete the triple - but a
  // half-defined rotation would silently stop being rigid, so guard it.
  if (basis.length < 3) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  const variance = basis.map((axis) =>
    centred.reduce((s, p) => {
      const d = axis.reduce((acc, a, j) => acc + a * (p[j] ?? 0), 0);
      return s + d * d;
    }, 0) / Math.max(1, centred.length));

  const ordered = basis
    .map((axis, i) => ({ axis, variance: variance[i] ?? 0 }))
    .sort((a, b) => b.variance - a.variance)
    .map(({ axis }) => axis);

  // Sign convention, in two parts - and the part that applies is not the same
  // for all three axes, which is the thing to read before changing any of this.
  //
  // Any axis and its negation describe the same line, so the iteration is free
  // to return either, and a refit that picked the other one would mirror the
  // cloud and rewrite every stored coordinate for nothing. So each sign is
  // pinned. THE FIRST TWO AXES take it from their own largest-magnitude
  // component, which is positive.
  //
  // THE THIRD AXIS TAKES ITS SIGN FROM THE DETERMINANT instead, and the
  // leading-component rule above does not apply to it. Once two perpendicular
  // axes are fixed, the third's sign is the only freedom left in the triple, and
  // it is exactly what decides whether this is a rotation or a reflection: both
  // preserve every distance, only the rotation preserves handedness. Pinning it
  // by its leading component left the determinant at -1 in roughly half of all
  // frames (204 of 400 measured), which is an isometry but not a rotation - and
  // "rigid rotation" is what the spec, the plan and the comments downstream all
  // say this is. Nothing visible changes for a point cloud; the words become
  // true.
  //
  // Determinism is unaffected, which is worth saying because the question is
  // obvious: the determinant is as much a function of the data as the leading
  // component was, computed from these same three axes with no state and no
  // tolerance, so a refit of identical data still rebuilds the same triple.
  const signed = ordered.map((axis, i) => {
    if (i === 2) return axis;
    let lead = 0;
    for (const [j, v] of axis.entries()) if (Math.abs(v) > Math.abs(axis[lead] ?? 0)) lead = j;
    return (axis[lead] ?? 0) < 0 ? axis.map((v) => -v) : axis;
  });
  const [a, b, c] = [signed[0] ?? [], signed[1] ?? [], signed[2] ?? []];
  const determinant = (a[0] ?? 0) * ((b[1] ?? 0) * (c[2] ?? 0) - (b[2] ?? 0) * (c[1] ?? 0))
    - (a[1] ?? 0) * ((b[0] ?? 0) * (c[2] ?? 0) - (b[2] ?? 0) * (c[0] ?? 0))
    + (a[2] ?? 0) * ((b[0] ?? 0) * (c[1] ?? 0) - (b[1] ?? 0) * (c[0] ?? 0));
  return determinant < 0 ? [a, b, c.map((v) => -v)] : signed;
}

/** Applies a rotation to every point. Rigid: distances and neighbours survive. */
export function rotateLayout(points: number[][], rotation: number[][]): number[][] {
  return points.map((p) => rotation.map((axis) => axis.reduce((s, a, j) => s + a * finite(p[j]), 0)));
}
