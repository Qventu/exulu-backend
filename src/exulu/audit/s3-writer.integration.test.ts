const enabled = process.env.EXULU_S3_INTEGRATION_TESTS === "true";
const describeIf = enabled ? describe : describe.skip;

import { createAuditS3Writer } from "./s3-writer";

describeIf("audit S3 writer against a real bucket", () => {
  const target = {
    s3region: process.env.AUDIT_S3_REGION!,
    s3key: process.env.AUDIT_S3_KEY!,
    s3secret: process.env.AUDIT_S3_SECRET!,
    s3Bucket: process.env.AUDIT_S3_BUCKET!,
    s3prefix: "audit-itest/",
    ...(process.env.AUDIT_S3_ENDPOINT ? { s3endpoint: process.env.AUDIT_S3_ENDPOINT } : {}),
  };

  it("PUTs an NDJSON object and applies a lifecycle rule", async () => {
    const writer = createAuditS3Writer(target as any);
    await writer.putNdjson(`${target.s3prefix}itest-${Date.now()}.ndjson`, "{\"ok\":true}\n");
    await writer.putLifecycle({ Rules: [{ ID: "exulu-audit-retention", Filter: { Prefix: target.s3prefix }, Status: "Enabled", Expiration: { Days: 1 } }] });
    const lc = await writer.getLifecycle();
    expect(lc.Rules.some((r: any) => r.ID === "exulu-audit-retention")).toBe(true);
  }, 30_000);
});
