import { applyRetentionLifecycle, AUDIT_LIFECYCLE_RULE_ID } from "./lifecycle";

const opts = { prefix: "audit/", retentionDays: 30, manage: true };

describe("applyRetentionLifecycle", () => {
  it("upserts our rule while preserving unrelated existing rules", async () => {
    const existing = { Rules: [{ ID: "other", Status: "Enabled", Expiration: { Days: 5 }, Filter: { Prefix: "x/" } }] };
    let put: any;
    const writer = {
      getLifecycle: async () => existing,
      putLifecycle: async (cfg: any) => { put = cfg; },
    };
    await applyRetentionLifecycle(writer, opts);
    const ids = put.Rules.map((r: any) => r.ID);
    expect(ids).toContain("other");
    const ours = put.Rules.find((r: any) => r.ID === AUDIT_LIFECYCLE_RULE_ID);
    expect(ours.Expiration.Days).toBe(30);
    expect(ours.Filter.Prefix).toBe("audit/");
  });

  it("treats a missing lifecycle config as an empty rule set", async () => {
    let put: any;
    const err: any = new Error("nope"); err.name = "NoSuchLifecycleConfiguration";
    const writer = {
      getLifecycle: async () => { throw err; },
      putLifecycle: async (cfg: any) => { put = cfg; },
    };
    await applyRetentionLifecycle(writer, opts);
    expect(put.Rules).toHaveLength(1);
  });

  it("does not throw and does not PUT when manage is false", async () => {
    let putCalled = false;
    const writer = { getLifecycle: async () => ({}), putLifecycle: async () => { putCalled = true; } };
    await expect(applyRetentionLifecycle(writer, { ...opts, manage: false })).resolves.toBeUndefined();
    expect(putCalled).toBe(false);
  });

  it("swallows AccessDenied on PUT and does not throw", async () => {
    const err: any = new Error("denied"); err.name = "AccessDenied";
    const writer = { getLifecycle: async () => ({ Rules: [] }), putLifecycle: async () => { throw err; } };
    await expect(applyRetentionLifecycle(writer, opts)).resolves.toBeUndefined();
  });
});
