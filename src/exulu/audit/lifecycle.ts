import type { AuditWriter } from "./s3-writer";

export const AUDIT_LIFECYCLE_RULE_ID = "exulu-audit-retention";

const buildRule = (prefix: string, retentionDays: number) => ({
  ID: AUDIT_LIFECYCLE_RULE_ID,
  Filter: { Prefix: prefix },
  Status: "Enabled",
  Expiration: { Days: retentionDays },
});

export const applyRetentionLifecycle = async (
  writer: Pick<AuditWriter, "getLifecycle" | "putLifecycle">,
  opts: { prefix: string; retentionDays: number; manage: boolean },
): Promise<void> => {
  const rule = buildRule(opts.prefix, opts.retentionDays);
  const config = { Rules: [rule] };

  if (!opts.manage) {
    console.warn(
      `[EXULU] audit retention: not managing the S3 lifecycle for this bucket. Apply this rule manually:\n${JSON.stringify(config, null, 2)}`,
    );
    return;
  }

  try {
    let existing: any[] = [];
    try {
      const current = await writer.getLifecycle();
      existing = (current?.Rules ?? []).filter((r: any) => r.ID !== AUDIT_LIFECYCLE_RULE_ID);
    } catch (error: any) {
      if (error?.name !== "NoSuchLifecycleConfiguration") throw error;
    }
    await writer.putLifecycle({ Rules: [...existing, rule] });
    console.log(`[EXULU] audit retention: S3 lifecycle set to expire "${opts.prefix}" after ${opts.retentionDays} days.`);
  } catch (error: any) {
    console.warn(
      `[EXULU] audit retention: could not set the S3 lifecycle (${error?.name ?? "error"}). Apply this rule manually:\n${JSON.stringify(config, null, 2)}`,
    );
  }
};
