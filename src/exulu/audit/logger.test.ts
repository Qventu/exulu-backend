import { getAuditLogger, initAudit, __resetAuditForTests } from "./logger";

jest.mock("./lifecycle", () => ({
  applyRetentionLifecycle: jest.fn(async () => {}),
  AUDIT_LIFECYCLE_RULE_ID: "exulu-audit-retention",
}));

const s3 = { s3region: "r", s3key: "k", s3secret: "s", s3Bucket: "b" };
beforeEach(() => __resetAuditForTests());

describe("getAuditLogger", () => {
  it("returns a no-op logger when audit is disabled", async () => {
    const logger = getAuditLogger({});
    expect(logger.enabled).toBe(false);
    logger.record({ v: 1, ts: "t", type: "x", actor: {}, status: "ok" });
    await expect(logger.recordToolCall({} as any)).resolves.toBeUndefined();
    expect(logger.shouldAuditTool("anything")).toBe(false);
  });

  it("returns the same singleton instance across calls", () => {
    const cfg = { audit: { enabled: true, retentionDays: 30 }, fileUploads: s3 };
    expect(getAuditLogger(cfg)).toBe(getAuditLogger(cfg));
  });

  it("respects the tool include/exclude filter when enabled", () => {
    const logger = getAuditLogger({
      audit: { enabled: true, retentionDays: 30, sources: { toolCalls: { exclude: ["noisy"] } } },
      fileUploads: s3,
    });
    expect(logger.enabled).toBe(true);
    expect(logger.shouldAuditTool("normal")).toBe(true);
    expect(logger.shouldAuditTool("noisy")).toBe(false);
  });

  it("disables tool auditing when sources.toolCalls.enabled is false", () => {
    const logger = getAuditLogger({
      audit: { enabled: true, retentionDays: 30, sources: { toolCalls: { enabled: false } } },
      fileUploads: s3,
    });
    expect(logger.shouldAuditTool("normal")).toBe(false);
  });
});

describe("initAudit signal-handler idempotency", () => {
  const enabledConfig = { audit: { enabled: true, retentionDays: 30 }, fileUploads: s3 };

  afterEach(() => __resetAuditForTests());

  it("registers exactly one SIGTERM listener even when initAudit is called twice", async () => {
    const baseline = process.listenerCount("SIGTERM");
    await initAudit(enabledConfig, { builtinToolIds: new Set() });
    await initAudit(enabledConfig, { builtinToolIds: new Set() });
    expect(process.listenerCount("SIGTERM")).toBe(baseline + 1);
  });

  it("removes the SIGTERM listener after __resetAuditForTests", async () => {
    const baseline = process.listenerCount("SIGTERM");
    await initAudit(enabledConfig, { builtinToolIds: new Set() });
    __resetAuditForTests();
    expect(process.listenerCount("SIGTERM")).toBe(baseline);
  });
});
