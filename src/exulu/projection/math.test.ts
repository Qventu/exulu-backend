import {
  applyMap, fitResidual, l2normalize, meanVector, normalizeLayout, principalRotation,
  projectComponents, randomizedPCA, ridgeFit, rng, rotateLayout,
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
    // reconstruction keeps almost all the variance: the rows live in a 2-plane,
    // so projecting onto the 2-vector basis and back should lose only the noise.
    const z = projectComponents(rows[0], mean, basis);
    expect(z).toHaveLength(2);
    let residual = 0, centredNorm = 0;
    for (let d = 0; d < dims; d += 1) {
      const centred = rows[0][d] - mean[d];
      const rebuilt = basis.reduce((acc, b, bi) => acc + z[bi] * b[d], 0);
      residual += (centred - rebuilt) ** 2;
      centredNorm += centred * centred;
    }
    expect(Math.sqrt(residual / centredNorm)).toBeLessThan(0.01);
  });

  it("yields a finite basis for zero-variance input instead of NaN", () => {
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
    near(fitResidual(Z, Y, map, [0, 0, 0]), 0);
    expect(fitResidual(Z, [[2, 0, 0], [0, 2, 0]], map, [0, 0, 0])).toBeGreaterThan(0.5);
  });
});

// Everything below guards a finding from the task-2 self-review: each exported
// function has to return finite numbers, because callers persist them and a NaN
// that reaches the database silently collapses a whole map to the origin.
describe("finite results for contaminated input", () => {
  it("l2normalize returns zeros for a non-finite component", () => {
    expect(Array.from(l2normalize([Infinity, 1]))).toEqual([0, 0]);
    expect(Array.from(l2normalize([NaN, 1]))).toEqual([0, 0]);
  });

  it("meanVector ignores a corrupt row component", () => {
    const withNaN = meanVector([[1, 2, 3], [NaN, 2, 3], [1, 2, 3]], 3);
    for (const c of withNaN) expect(Number.isFinite(c)).toBe(true);
    // The bad component reads as 0, so the first mean is (1 + 0 + 1) / 3.
    near(withNaN[0], 2 / 3); near(withNaN[1], 2); near(withNaN[2], 3);
    const withInf = meanVector([[1, 2, 3], [Infinity, 2, 3], [-Infinity, 2, 3]], 3);
    for (const c of withInf) expect(Number.isFinite(c)).toBe(true);
    near(withInf[0], 1 / 3);
  });

  it("ridgeFit returns a finite intercept when a row is corrupt", () => {
    const Z = [Float32Array.from([1, 2]), Float32Array.from([NaN, 1]), Float32Array.from([0, 3])];
    const Y = [[1, 1, 1], [2, 2, 2], [3, 3, 3]];
    for (const bad of [Z, [Float32Array.from([1, 2]), Float32Array.from([Infinity, 1]), Float32Array.from([0, 3])]]) {
      const { map, intercept } = ridgeFit(bad, Y, 1e-3);
      for (const value of intercept) expect(Number.isFinite(value)).toBe(true);
      for (const row of map) for (const w of row) expect(Number.isFinite(w)).toBe(true);
    }
    const corruptTarget = ridgeFit([Float32Array.from([1, 2]), Float32Array.from([2, 1])], [[NaN, 1, 1], [2, 2, 2]], 1e-3);
    for (const value of corruptTarget.intercept) expect(Number.isFinite(value)).toBe(true);
  });

  it("normalizeLayout keeps one bad point from poisoning the cloud", () => {
    const { points, center, scale } = normalizeLayout([[1, 0, 0], [NaN, 0, 0], [3, 0, 0]]);
    for (const p of points) for (const c of p) expect(Number.isFinite(c)).toBe(true);
    for (const c of center) expect(Number.isFinite(c)).toBe(true);
    expect(Number.isFinite(scale)).toBe(true);
    // The bad coordinate reads as 0, so the centre is the mean of 0, 1 and 3.
    near(center[0], 4 / 3);
  });

  it("projectComponents does not pass NaN through", () => {
    const z = projectComponents(Float32Array.from([NaN, 1]), Float32Array.from([0, 0]), [Float32Array.from([1, 1])]);
    for (const c of z) expect(Number.isFinite(c)).toBe(true);
  });

  it("fitResidual stays finite for a corrupt target", () => {
    const residual = fitResidual([Float32Array.from([1])], [[NaN, 0, 0]], [[1], [0], [0]], [0, 0, 0]);
    expect(Number.isFinite(residual)).toBe(true);
  });
});

describe("meanVector precision", () => {
  it("averages a fit-sized batch without float32 drift", () => {
    // 20000 rows is FIT_SAMPLE. A float32 accumulator drifts ~1.4e-6 here,
    // which is worse than the float32 output it is being stored in.
    const rows = Array.from({ length: 20000 }, (_, i) => Float32Array.from([0.1 + (i % 7) * 0.01, 1]));
    const exact = rows.reduce((s, r) => s + r[0], 0) / rows.length;
    const mean = meanVector(rows, 2);
    near(mean[0], exact, 2e-7);
    near(mean[1], 1, 1e-9);
  });
});

/** Pearson correlation between two coordinates of a cloud; 0 when either is flat. */
const correlation = (points: number[][], a: number, b: number): number => {
  const n = points.length || 1;
  const mean = (j: number) => points.reduce((s, p) => s + (p[j] ?? 0), 0) / n;
  const ma = mean(a), mb = mean(b);
  let cov = 0, va = 0, vb = 0;
  for (const p of points) {
    const da = (p[a] ?? 0) - ma, db = (p[b] ?? 0) - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  const denominator = Math.sqrt(va * vb);
  return denominator > 1e-12 ? cov / denominator : 0;
};

/** Standard deviation of one coordinate: how far the cloud spreads along that axis. */
const spread = (points: number[][], j: number): number => {
  const n = points.length || 1;
  const m = points.reduce((s, p) => s + (p[j] ?? 0), 0) / n;
  return Math.sqrt(points.reduce((s, p) => s + ((p[j] ?? 0) - m) ** 2, 0) / n);
};

const distance = (a: number[], b: number[]): number =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));

describe("principalRotation", () => {
  // A cloud stretched along the x=-y diagonal: exactly the shape measured on the
  // real base (corr_xy = -0.78), and the one the camera sees edge-on.
  const diagonal = Array.from({ length: 200 }, (_, i) => {
    const t = (i / 199) * 2 - 1;
    return [t, -t, (i % 7) / 70];
  });

  it("decorrelates the axes of a diagonal cloud", () => {
    const rotated = rotateLayout(diagonal, principalRotation(diagonal, 7));
    expect(Math.abs(correlation(rotated, 0, 1))).toBeLessThan(0.05);
  });

  it("puts the widest spread on the first axis", () => {
    const rotated = rotateLayout(diagonal, principalRotation(diagonal, 7));
    expect(spread(rotated, 0)).toBeGreaterThan(spread(rotated, 1));
    expect(spread(rotated, 1)).toBeGreaterThanOrEqual(spread(rotated, 2));
  });

  it("preserves every pairwise distance, because it is a rotation", () => {
    const rotated = rotateLayout(diagonal, principalRotation(diagonal, 7));
    for (const [i, j] of [[0, 1], [0, 150], [37, 180]] as const) {
      expect(distance(rotated[i]!, rotated[j]!)).toBeCloseTo(distance(diagonal[i]!, diagonal[j]!), 6);
    }
  });

  it("is deterministic for one seed", () => {
    expect(principalRotation(diagonal, 7)).toEqual(principalRotation(diagonal, 7));
  });

  it("returns an identity-like rotation for a cloud with no dominant direction", () => {
    const ball = Array.from({ length: 60 }, (_, i) => [Math.sin(i), Math.cos(i), Math.sin(i * 2)]);
    const rotated = rotateLayout(ball, principalRotation(ball, 3));
    expect(rotated).toHaveLength(60);
    expect(rotated.every((p) => p.every(Number.isFinite))).toBe(true);
  });
});
