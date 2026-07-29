import {
  S3Client,
  PutObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
} from "@aws-sdk/client-s3";
import type { ResolvedAuditConfig } from "./config";

export type AuditS3Client = { send: (command: unknown) => Promise<unknown> };
type Target = ResolvedAuditConfig["target"];

const RETRYABLE = new Set(["SignatureDoesNotMatch", "InvalidAccessKeyId", "AccessDenied"]);

export const buildAuditS3Client = (t: Target): S3Client =>
  new S3Client({
    region: t.s3region,
    ...(t.s3endpoint ? { forcePathStyle: true, endpoint: t.s3endpoint } : {}),
    credentials: { accessKeyId: t.s3key, secretAccessKey: t.s3secret },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

export type AuditWriter = {
  putNdjson: (key: string, body: string) => Promise<void>;
  getLifecycle: () => Promise<any>;
  putLifecycle: (config: any) => Promise<void>;
};

export const createAuditS3Writer = (
  target: Target,
  client?: AuditS3Client,
  opts?: { maxRetries?: number; backoffMs?: (attempt: number) => number },
): AuditWriter => {
  const c: AuditS3Client = client ?? (buildAuditS3Client(target) as unknown as AuditS3Client);
  const maxRetries = opts?.maxRetries ?? 3;
  const backoffMs = opts?.backoffMs ?? ((attempt: number) => Math.pow(2, attempt) * 1000);

  const putNdjson = async (key: string, body: string): Promise<void> => {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const command = new PutObjectCommand({
        Bucket: target.s3Bucket,
        Key: key,
        Body: Buffer.from(body, "utf8"),
        ContentType: "application/x-ndjson",
      });
      try {
        await c.send(command);
        return;
      } catch (error: any) {
        lastError = error;
        if (RETRYABLE.has(error?.name) && attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, backoffMs(attempt)));
          continue;
        }
        throw error;
      }
    }
    if (lastError) throw lastError;
  };

  const getLifecycle = async (): Promise<any> =>
    c.send(new GetBucketLifecycleConfigurationCommand({ Bucket: target.s3Bucket }));

  const putLifecycle = async (config: any): Promise<void> => {
    await c.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: target.s3Bucket,
        LifecycleConfiguration: config,
      }),
    );
  };

  return { putNdjson, getLifecycle, putLifecycle };
};
