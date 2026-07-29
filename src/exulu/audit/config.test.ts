import { resolveAuditConfig } from "./config";

const s3 = { s3region: "r", s3key: "k", s3secret: "s", s3Bucket: "b" };

describe("resolveAuditConfig", () => {
  it("returns null when disabled or absent", () => {
    expect(resolveAuditConfig({})).toBeNull();
    expect(resolveAuditConfig({ audit: { enabled: false, retentionDays: 30 } })).toBeNull();
  });

  it("falls back to fileUploads and defaults manageLifecycle off for the shared bucket", () => {
    const r = resolveAuditConfig({ audit: { enabled: true, retentionDays: 30 }, fileUploads: s3 })!;
    expect(r.target.s3Bucket).toBe("b");
    expect(r.target.s3prefix).toBe("audit/");
    expect(r.usingSharedFileUploadsBucket).toBe(true);
    expect(r.manageLifecycle).toBe(false);
    expect(r.failureMode).toBe("open");
    expect(r.flush).toEqual({ maxRecords: 100, maxIntervalMs: 5000 });
    expect(r.toolCalls.enabled).toBe(true);
  });

  it("defaults manageLifecycle on for a dedicated audit bucket", () => {
    const r = resolveAuditConfig({ audit: { enabled: true, retentionDays: 30, s3: { ...s3, s3prefix: "x" } } })!;
    expect(r.usingSharedFileUploadsBucket).toBe(false);
    expect(r.manageLifecycle).toBe(true);
    expect(r.target.s3prefix).toBe("x/");
  });

  it("throws when no S3 target and when retentionDays is invalid", () => {
    expect(() => resolveAuditConfig({ audit: { enabled: true, retentionDays: 30 } })).toThrow(/S3/);
    expect(() => resolveAuditConfig({ audit: { enabled: true, retentionDays: 0 }, fileUploads: s3 })).toThrow(/retentionDays/);
  });
});
