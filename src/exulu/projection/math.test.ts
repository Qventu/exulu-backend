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

  // A base of near-duplicate boilerplate chunks is numerically low-rank: far
  // fewer independent directions than the components asked for. The iteration's
  // accumulators then cancel almost completely, and whatever survives that is
  // normalised back up to unit length - so this is where a basis stops being a
  // basis. It was measured doing exactly that: a 9.7e-2 dot product between two
  // of its own vectors at the production shape (1536 dimensions, 50 components),
  // and 4.9e-1 at shapes this size. Nothing downstream breaks loudly - the ridge
  // absorbs near-collinear columns - which is why it needs asserting here.
  //
  // How many it returns is the other half: fewer than asked for is the
  // documented answer to a short-rank cloud, and the right number is the rank
  // itself. One sweep returned 23, 38 and 15 on clouds of true rank 12, 20 and
  // 8 - the surplus being amplified rounding noise, which fit.ts then persists
  // as the base's component count and counts as fitted parameters. So this
  // asserts the exact count, not `at least the rank`, which anything passes.
  it("returns an orthonormal basis of exactly the rank for a cloud with less rank than the components asked", () => {
    const dims = 120, rank = 6, k = 20;
    const r = rng(5);
    const planted = Array.from({ length: rank }, () => Float32Array.from({ length: dims }, () => r() - 0.5));
    const rows = Array.from({ length: 80 }, () => {
      const w = Array.from({ length: rank }, () => r() - 0.5);
      return Float32Array.from({ length: dims }, (_, d) =>
        w.reduce((s, weight, c) => s + weight * (planted[c]?.[d] ?? 0), 0));
    });
    const basis = randomizedPCA(rows, dims, k, 7, 3);
    expect(basis).toHaveLength(rank);
    for (const b of basis) near(Math.hypot(...Array.from(b)), 1, 1e-5);
    for (let a = 0; a < basis.length; a += 1) {
      for (let c = a + 1; c < basis.length; c += 1) {
        const dot = Array.from(basis[a] ?? []).reduce((s, x, d) => s + x * (basis[c]?.[d] ?? 0), 0);
        near(dot, 0, 1e-5);
      }
    }
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

/** Normally distributed numbers, from the module's own deterministic PRNG. */
const gaussian = (seed: number) => {
  const r = rng(seed);
  return () => Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
};

/**
 * `n` points spread by `sd` along three SKEW directions. Skew on purpose: a
 * cloud built along x, y and z is already aligned with the camera, so it cannot
 * tell a working rotation from no rotation at all - which is exactly how the
 * first version of these tests passed while covering nothing.
 */
const ellipsoid = (sd: [number, number, number], n: number, seed: number): number[][] => {
  const g = gaussian(seed);
  const u = [[0.6, 0.8, 0], [-0.48, 0.36, 0.8], [0.64, -0.48, 0.6]];        // orthonormal
  return Array.from({ length: n }, () => {
    const c = sd.map((s) => g() * s);
    return [0, 1, 2].map((d) => u.reduce((acc, axis, k) => acc + (axis[d] ?? 0) * (c[k] ?? 0), 0));
  });
};

/** Three perpendicular unit rows - the property that makes the transform rigid,
 *  and so the only reason a stored distance still means what it meant. */
const expectOrthonormal = (rotation: number[][]) => {
  expect(rotation).toHaveLength(3);
  for (const row of rotation) {
    expect(row).toHaveLength(3);
    near(Math.hypot(...row), 1, 1e-12);
  }
  for (const [i, j] of [[0, 1], [0, 2], [1, 2]] as const) {
    near(rotation[i]!.reduce((s, x, d) => s + x * (rotation[j]![d] ?? 0), 0), 0, 1e-12);
  }
};

/** The component the sign convention pins positive on the first two axes: the
 *  largest in magnitude, first one winning a tie, matching the implementation. */
const leadComponent = (axis: number[]): number =>
  axis.reduce((lead, v) => (Math.abs(v) > Math.abs(lead) ? v : lead), axis[0] ?? 0);

/**
 * The signed volume of the three rows, computed here rather than imported, so
 * the assertion does not agree with the implementation by construction.
 *
 * +1 is a rotation and -1 is a reflection. Both are isometries - three
 * perpendicular unit rows cannot change a distance either way, which is why
 * `expectOrthonormal` passing says nothing about this - but only +1 preserves
 * handedness, and only +1 makes "rotation" the right word for what the spec,
 * the plan and the comments over `principalRotation` all call this.
 */
const determinant = (m: number[][]): number => {
  const [a, b, c] = [m[0] ?? [], m[1] ?? [], m[2] ?? []];
  return (a[0] ?? 0) * ((b[1] ?? 0) * (c[2] ?? 0) - (b[2] ?? 0) * (c[1] ?? 0))
    - (a[1] ?? 0) * ((b[0] ?? 0) * (c[2] ?? 0) - (b[2] ?? 0) * (c[0] ?? 0))
    + (a[2] ?? 0) * ((b[0] ?? 0) * (c[1] ?? 0) - (b[1] ?? 0) * (c[0] ?? 0));
};

/** The real base's measured shape - 0.42 / 0.25 / 0.10 - lying skew. */
const tilted = ellipsoid([0.42, 0.25, 0.1], 300, 11);

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

  // The same thing asked of the real base's shape, where all three pairs can be
  // correlated at once and no axis of the cloud lines up with an axis of the map.
  it("decorrelates all three pairs of a skew ellipsoid", () => {
    expect(Math.abs(correlation(tilted, 0, 1))).toBeGreaterThan(0.3);        // worth fixing
    const rotated = rotateLayout(tilted, principalRotation(tilted, 7));
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]] as const) {
      expect(Math.abs(correlation(rotated, i, j))).toBeLessThan(1e-3);
    }
  });

  it("puts the widest spread on the first axis", () => {
    const rotated = rotateLayout(diagonal, principalRotation(diagonal, 7));
    expect(spread(rotated, 0)).toBeGreaterThan(spread(rotated, 1));
    expect(spread(rotated, 1)).toBeGreaterThanOrEqual(spread(rotated, 2));
  });

  // The sort is one of the things this function adds to randomizedPCA, and the
  // test above cannot see it: on a cloud whose spreads differ by three orders of
  // magnitude the iteration returns them ordered anyway. The iteration converges
  // on the SPAN fast and on the ORDER within it only as fast as the spreads
  // differ, so two axes of nearly equal spread come back in whichever order the
  // random start happened to favour. Without the sort, three of the twelve seeds
  // below return this cloud's first two axes inverted.
  it("orders the axes by spread even when the iteration does not", () => {
    const close = ellipsoid([1, 0.99, 0.1], 240, 99);
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const rotated = rotateLayout(close, principalRotation(close, seed));
      expect(spread(rotated, 0)).toBeGreaterThan(spread(rotated, 1));
      expect(spread(rotated, 1)).toBeGreaterThan(spread(rotated, 2));
    }
  });

  // An axis and its negation describe the same line, so the iteration is free
  // to return either - and a refit that picks the other one mirrors the cloud
  // and rewrites every stored coordinate for nothing. Convention for the FIRST
  // TWO axes: the largest-magnitude component is positive. It bites on both
  // clouds here; the iteration returns the diagonal's long axis as (-0.707,
  // +0.707, ...).
  //
  // The third axis is deliberately NOT asserted here, because the
  // largest-magnitude rule no longer governs it: once two axes are pinned the
  // third's sign is the only freedom left, and it is what decides whether the
  // transform is a rotation or a reflection, so the determinant takes it. That
  // leaves it just as pinned - see the proper-rotation test above - so the
  // property this test exists for still holds for all three.
  it("pins the first two axes' signs, so a refit cannot mirror the cloud", () => {
    for (const cloud of [diagonal, tilted]) {
      for (const axis of principalRotation(cloud, 7).slice(0, 2)) {
        expect(leadComponent(axis)).toBeGreaterThan(0);
      }
    }
  });

  // Determinism worth the name. Calling a pure function twice in one process
  // proves nothing - every implementation passes that, including one that reads
  // the seed and returns garbage. The property that matters is that the axes are
  // a property of the DATA: a converged iteration finds the same ones from any
  // starting basis, and one that stops early does not. At three passes the seeds
  // below disagree by 2e-1 on this cloud.
  it("reaches the same axes from any random start", () => {
    const reference = principalRotation(tilted, 7);
    expect(principalRotation(tilted, 7)).toEqual(reference);          // same seed, bit for bit
    for (const seed of [99, 4242, 123456]) {
      const rotation = principalRotation(tilted, seed);
      for (const [i, row] of rotation.entries()) {
        for (const [j, v] of row.entries()) near(v, reference[i]![j] ?? 0, 1e-6);
      }
    }
  });

  it("preserves every pairwise distance, because it is a rotation", () => {
    const rotated = rotateLayout(diagonal, principalRotation(diagonal, 7));
    for (const [i, j] of [[0, 1], [0, 150], [37, 180]] as const) {
      expect(distance(rotated[i]!, rotated[j]!)).toBeCloseTo(distance(diagonal[i]!, diagonal[j]!), 6);
    }
  });

  /** One of each kind the rotation has to handle: the diagonal streak, the real
   *  base's skew pancake, a ball with no dominant direction, and a line. */
  const shapes = [diagonal, tilted, ellipsoid([1, 1, 1], 50, 3), ellipsoid([1, 0, 0], 50, 4)];

  // Rigidity stated as the property rather than sampled as three pairs: three
  // perpendicular unit rows cannot change a distance, whatever the cloud.
  it("is orthonormal for every shape of cloud", () => {
    for (const cloud of shapes) expectOrthonormal(principalRotation(cloud, 7));
  });

  // Orthonormality makes the transform an isometry; it does NOT make it a
  // rotation. At determinant -1 it is a reflection: every distance survives and
  // handedness does not, so the cloud is mirrored. Nothing is visually wrong
  // with a mirrored point cloud, but the spec, the plan and five comments all
  // call this a rotation, so the code had better be one. Measured before the
  // sign rule that fixes it: determinant -1 in 204 of 400 random frames here
  // (192 of 400 on the reviewer's own generator), and in two of the four shapes
  // above.
  it("is a proper rotation and not a reflection, for every shape of cloud", () => {
    for (const cloud of shapes) near(determinant(principalRotation(cloud, 7)), 1, 1e-12);
  });

  // No dominant direction to find, and the answer still has to BE a rotation.
  // The version of this test that only counted the rows and checked for NaN
  // passed against a transform that was not orthogonal at all.
  it("returns an orthonormal triple when no direction dominates", () => {
    const ball = Array.from({ length: 60 }, (_, i) => [Math.sin(i), Math.cos(i), Math.sin(i * 2)]);
    const rotation = principalRotation(ball, 3);
    expectOrthonormal(rotation);
    const rotated = rotateLayout(ball, rotation);
    expect(rotated).toHaveLength(60);
    expect(rotated.every((p) => p.every(Number.isFinite))).toBe(true);
    expect(spread(rotated, 0)).toBeGreaterThanOrEqual(spread(rotated, 1));
    expect(spread(rotated, 1)).toBeGreaterThanOrEqual(spread(rotated, 2));
    for (const [i, j] of [[0, 17], [5, 59]] as const) {
      expect(distance(rotated[i]!, rotated[j]!)).toBeCloseTo(distance(ball[i]!, ball[j]!), 9);
    }
  });

  // Degenerate layouts reach this from the real fit - a base of near-duplicate
  // boilerplate is collinear, and `finite` upstream means a corrupt coordinate
  // arrives as a 0 rather than being rejected. None of them may yield anything
  // but a rotation: a non-finite coordinate in the database poisons a whole map
  // silently, and a non-orthogonal one is a map that lies about distance.
  const degenerate: [string, number[][]][] = [
    ["empty", []],
    ["single-point", [[1, 2, 3]]],
    ["repeated-point", Array.from({ length: 5 }, () => [1, 1, 1])],
    ["collinear", Array.from({ length: 5 }, (_, i) => [i, 2 * i, 3 * i])],
    ["flat", Array.from({ length: 8 }, (_, i) => [Math.sin(i), Math.cos(i), 0])],
    ["ragged", [[1, 2], [3], [4, 5, 6], []]],
    ["non-finite", [[NaN, 1, 2], [Infinity, 0, 0], [1, 2, 3], [-1, -2, -3]]],
  ];
  it.each(degenerate)("still returns a rotation for a %s layout", (_name, cloud) => {
    const rotation = principalRotation(cloud, 5);
    expectOrthonormal(rotation);
    // "A rotation", as the name says, and not merely an isometry: these are the
    // clouds where the triple is completed from the canonical axes, which is
    // where a reflection is easiest to produce by accident.
    near(determinant(rotation), 1, 1e-12);
    const rotated = rotateLayout(cloud, rotation);
    expect(rotated).toHaveLength(cloud.length);
    expect(rotated.every((p) => p.every(Number.isFinite))).toBe(true);
  });
});
