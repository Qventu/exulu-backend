import { getAuditLogger, __resetAuditForTests } from "./logger";

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
