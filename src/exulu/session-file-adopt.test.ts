import {
  planAdoptKeys,
  planAdoptSizeCheck,
  MAX_ADOPT_KEYS,
  type AdoptAccepted,
} from "./session-file-adopt";

const user = { id: 42, super_admin: false, type: "user" };

describe("planAdoptKeys", () => {
  test("accepts a key under the caller's own prefix", () => {
    const r = planAdoptKeys(["user_42/abc-_EXULU_brief.pdf"], user, null, "bucket");
    expect(r.accepted).toEqual([
      { source: "user_42/abc-_EXULU_brief.pdf", filename: "brief.pdf", key: "user_42/abc-_EXULU_brief.pdf" },
    ]);
    expect(r.rejected).toEqual([]);
  });
  test("strips a leading bucket segment before judging ownership", () => {
    const r = planAdoptKeys(["bucket/user_42/abc-_EXULU_brief.pdf"], user, null, "bucket");
    expect(r.accepted).toHaveLength(1);
  });
  test("honours the instance general prefix", () => {
    const r = planAdoptKeys(["pre/user_42/abc-_EXULU_b.pdf"], user, "pre", "bucket");
    expect(r.accepted).toHaveLength(1);
  });
  test("rejects another user's prefix", () => {
    expect(planAdoptKeys(["user_43/x.pdf"], user, null, "bucket").accepted).toEqual([]);
  });
  test("rejects a global/ key — allowlist, not denylist", () => {
    expect(planAdoptKeys(["global/x.pdf"], user, null, "bucket").accepted).toEqual([]);
  });
  test("rejects an unprefixed key", () => {
    expect(planAdoptKeys(["x.pdf"], user, null, "bucket").accepted).toEqual([]);
  });
  test("rejects a traversal", () => {
    expect(planAdoptKeys(["user_42/../user_43/x.pdf"], user, null, "bucket").accepted).toEqual([]);
  });
  test("an api-type caller is NOT a wildcard", () => {
    const api = { id: 9, super_admin: false, type: "api" };
    expect(planAdoptKeys(["user_42/x.pdf"], api, null, "bucket").accepted).toEqual([]);
  });
  test("rejects a non-array body and a non-string entry", () => {
    expect(planAdoptKeys("user_42/x.pdf", user, null, "bucket").accepted).toEqual([]);
    expect(planAdoptKeys([7], user, null, "bucket").rejected).toHaveLength(1);
  });
  test("every rejection carries a reason", () => {
    const r = planAdoptKeys(["global/x.pdf", "user_43/y.pdf"], user, null, "bucket");
    expect(r.rejected.every((x) => typeof x.reason === "string" && x.reason.length > 0)).toBe(true);
  });
  // All-or-nothing (explicit project decision, not in the brief): a plan
  // with zero rejections is the only shape the route is allowed to copy
  // from, and that shape always carries an empty `rejected`.
  test("a fully-accepted plan carries an empty rejected array", () => {
    const r = planAdoptKeys(["user_42/abc-_EXULU_brief.pdf"], user, null, "bucket");
    expect(r.rejected).toEqual([]);
  });

  // --- Review round fixes below ---

  // Finding 1 (Critical): ownsObjectKey's super_admin bypass is right for
  // its one other caller (a human admin re-pointing a share) but wrong
  // here, where the actor is code inside a sandboxed artifact iframe
  // carrying the viewer's own JWT. A super-admin viewer must not turn that
  // iframe into a wildcard reader of the whole bucket.
  test("a super_admin caller does not bypass ownership", () => {
    const admin = { id: 1, super_admin: true, type: "user" };
    expect(planAdoptKeys(["user_43/x.pdf"], admin, null, "bucket").accepted).toEqual([]);
    expect(planAdoptKeys(["global/x.pdf"], admin, null, "bucket").accepted).toEqual([]);
  });

  // Finding 2: normalizeS3Key decodeURIComponent-decodes each path
  // segment, which throws URIError on a bare/malformed "%". Real keys hit
  // this ("50% off.pdf" uploaded verbatim) — the planner must reject, not
  // throw and 500 the request.
  test("rejects a key with an invalid percent-escape instead of throwing", () => {
    expect(() => planAdoptKeys(["user_42/abc-_EXULU_50% off.pdf"], user, null, "bucket")).not.toThrow();
    const r = planAdoptKeys(["user_42/abc-_EXULU_50% off.pdf"], user, null, "bucket");
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.reason.length).toBeGreaterThan(0);
  });
  test("a bare invalid percent sign does not crash the planner", () => {
    expect(() => planAdoptKeys(["%"], user, null, "bucket")).not.toThrow();
    expect(planAdoptKeys(["%"], user, null, "bucket").accepted).toEqual([]);
  });

  // Finding 3: two keys that derive the same stored filename would
  // silently overwrite one another at copy time — exactly the harm
  // all-or-nothing exists to prevent, reached by collision instead of an
  // explicit rejection. Both must be rejected and neither copied.
  test("rejects both keys when two derive the same filename, and accepts neither", () => {
    const r = planAdoptKeys(
      ["user_42/a-_EXULU_x.pdf", "user_42/b-_EXULU_x.pdf"],
      user,
      null,
      "bucket",
    );
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(2);
    expect(r.rejected.map((x) => x.key).sort()).toEqual(
      ["user_42/a-_EXULU_x.pdf", "user_42/b-_EXULU_x.pdf"].sort(),
    );
    expect(r.rejected.every((x) => x.reason.length > 0)).toBe(true);
  });
  test("a third key colliding with an already-demoted filename is also rejected, not accepted", () => {
    const r = planAdoptKeys(
      ["user_42/a-_EXULU_x.pdf", "user_42/b-_EXULU_x.pdf", "user_42/c-_EXULU_x.pdf"],
      user,
      null,
      "bucket",
    );
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(3);
  });

  // Finding 5: nothing previously capped batch size, and each accepted key
  // is later downloaded whole into process memory to mirror into the
  // sandbox — an unbounded batch is unbounded concurrent-request memory.
  test("rejects the whole batch when it exceeds the adopt key limit", () => {
    const keys = Array.from(
      { length: MAX_ADOPT_KEYS + 1 },
      (_, i) => `user_42/k${i}-_EXULU_f${i}.pdf`,
    );
    const r = planAdoptKeys(keys, user, null, "bucket");
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(keys.length);
  });
  test("a batch at exactly the limit is still judged key-by-key", () => {
    const keys = Array.from(
      { length: MAX_ADOPT_KEYS },
      (_, i) => `user_42/k${i}-_EXULU_f${i}.pdf`,
    );
    const r = planAdoptKeys(keys, user, null, "bucket");
    expect(r.accepted).toHaveLength(MAX_ADOPT_KEYS);
    expect(r.rejected).toEqual([]);
  });

  // Minor (promoted): the judged string and the copied string must be
  // identical, or a double-leading-slash key is judged on one string
  // ("user_42/...", owned) and copied as another ("/user_42/...").
  test("strips a leading slash once, and that single value is both judged and kept as source", () => {
    const r = planAdoptKeys(["//user_42/abc-_EXULU_x.pdf"], user, null, "bucket");
    expect(r.accepted).toEqual([
      { source: "user_42/abc-_EXULU_x.pdf", filename: "x.pdf", key: "//user_42/abc-_EXULU_x.pdf" },
    ]);
  });
});

describe("planAdoptSizeCheck", () => {
  const entry = (key: string): AdoptAccepted => ({ source: key, filename: "f.pdf", key });

  test("proceeds when every accepted entry is within the limit", () => {
    const decision = planAdoptSizeCheck([{ entry: entry("user_42/a.pdf"), size: 100 }], 1000);
    expect(decision).toEqual({ proceed: true });
  });

  // Finding 7: the route's "any rejection -> refuse everything" assembly
  // was asserted by no test and would survive its own deletion. This is
  // that invariant, under direct test.
  test("refuses the whole batch when one entry (of several) is oversized", () => {
    const ok = entry("user_42/a.pdf");
    const big = entry("user_42/b.pdf");
    const decision = planAdoptSizeCheck(
      [
        { entry: ok, size: 100 },
        { entry: big, size: 2000 },
      ],
      1000,
    );
    expect(decision.proceed).toBe(false);
  });

  // Finding 9: the rejection must report the raw client string (`entry.key`),
  // not `entry.source` — a later consumer maps rejections back to what the
  // user tried to attach, and `source` can differ from that (e.g. a
  // bucket-prefixed key the client sent).
  test("reports entry.key, not entry.source, for an oversized entry", () => {
    const big: AdoptAccepted = { source: "user_42/normalized.pdf", filename: "f.pdf", key: "bucket/user_42/raw.pdf" };
    const decision = planAdoptSizeCheck([{ entry: big, size: 2000 }], 1000);
    expect(decision).toEqual({
      proceed: false,
      rejected: [{ key: "bucket/user_42/raw.pdf", reason: expect.any(String) }],
    });
  });

  test("refuses when a source object is missing (null size), reporting entry.key", () => {
    const missing: AdoptAccepted = { source: "user_42/normalized.pdf", filename: "f.pdf", key: "bucket/user_42/raw.pdf" };
    const decision = planAdoptSizeCheck([{ entry: missing, size: null }], 1000);
    expect(decision).toEqual({
      proceed: false,
      rejected: [{ key: "bucket/user_42/raw.pdf", reason: "Source object not found." }],
    });
  });

  test("an empty check list proceeds (nothing to verify)", () => {
    expect(planAdoptSizeCheck([], 1000)).toEqual({ proceed: true });
  });
});
