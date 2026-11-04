import { planAdoptKeys } from "./session-file-adopt";

const user = { id: 42, super_admin: false, type: "user" };

describe("planAdoptKeys", () => {
  test("accepts a key under the caller's own prefix", () => {
    const r = planAdoptKeys(["user_42/abc-_EXULU_brief.pdf"], user, null, "bucket");
    expect(r.accepted).toEqual([{ source: "user_42/abc-_EXULU_brief.pdf", filename: "brief.pdf" }]);
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
});
