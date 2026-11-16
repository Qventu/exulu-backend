import { type Express } from "express";
import { authentication } from "../auth/auth";
import { getToken } from "../auth/get-token";
import { postgresClient } from "../postgres/client";
import type { ExuluConfig } from "../exulu/app/index";
import {
  S3Client,
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  DeleteObjectCommand,
  type ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { STSClient, GetFederationTokenCommand } from "@aws-sdk/client-sts";
import { randomUUID } from "node:crypto";
import { isProjectKey } from "../exulu/project-files";
import { isDerivedKey } from "../exulu/document-cache/keys";

const expiresIn = 60 * 60 * 24 * 1; // S3 signature expires within 1 day.

let s3Client: S3Client | undefined;
function getS3Client(config: ExuluConfig) {
  if (!config.fileUploads) {
    throw new Error("File uploads are not configured");
  }
  s3Client ??= new S3Client({
    region: config.fileUploads.s3region,
    ...(config.fileUploads.s3endpoint && {
      forcePathStyle: true,
      endpoint: config.fileUploads.s3endpoint,
    }),
    credentials: {
      accessKeyId: config.fileUploads.s3key,
      secretAccessKey: config.fileUploads.s3secret,
    },
    // AWS SDK >= 3.729 injects x-amz-checksum-crc32 (of an empty body) into
    // presigned PUT URLs, which S3-compatible stores like MinIO reject on
    // upload with a checksum mismatch. WHEN_REQUIRED disables that default.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return s3Client;
}

export const getPresignedUrl = async (bucket: string, key: string, config: ExuluConfig) => {
  if (!config.fileUploads) {
    throw new Error("File uploads are not configured");
  }
  console.log("[EXULU] getting presigned url for bucket", bucket);
  console.log("[EXULU] getting presigned url for key", key);
  const url = await getSignedUrl(
    getS3Client(config),
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
    { expiresIn },
  );
  return url;
};

interface UploadOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

/**
 * S3 metadata values must be US-ASCII characters. This function sanitizes
 * metadata by URL-encoding non-ASCII characters to prevent signature mismatches.
 * See: https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingMetadata.html
 */
function sanitizeMetadata(metadata?: Record<string, string>): Record<string, string> | undefined {
  if (!metadata) return undefined;

  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      // URL-encode to handle special characters like ä, ö, ü, etc.
      sanitized[key] = encodeURIComponent(value);
    } else {
      sanitized[key] = String(value);
    }
  }
  return sanitized;
}

// Helper function to add s3prefix to a key path
const addGeneralPrefixToKey = (keyPath: string, config: ExuluConfig): string => {
  if (!config.fileUploads) {
    throw new Error("File uploads are not configured");
  }
  if (!config.fileUploads.s3prefix) {
    return keyPath;
  }
  const prefix = config.fileUploads.s3prefix.replace(/\/$/, "");
  // check if prefix is already present in keyPath
  if (keyPath.startsWith(prefix)) {
    return keyPath;
  }
  return `${prefix}/${keyPath}`;
};

const addUserPrefixToKey = (key: string, user?: number | string): string => {
  if (!user) {
    return key;
  }
  if (key.includes(`/user_${user}/`)) {
    return key;
  }
  return `user_${user}/${key}`;
};

const addBucketPrefixToKey = (key: string, bucket: string): string => {
  if (key.includes(`/${bucket}/`)) {
    return key;
  }
  return `${bucket}/${key}`;
};

/**
 * Upload a file directly to S3 from the server
 * @param file - File buffer or readable stream
 * @param key - The S3 key (path) where the file should be stored
 * @param config - Exulu configuration
 * @param options - Optional upload parameters (contentType, metadata)
 * @returns The full S3 key of the uploaded file
 */
export const uploadFile = async (
  file: Buffer | Uint8Array,
  fileName: string,
  config: ExuluConfig,
  options: UploadOptions = {},
  user?: number,
  customBucket?: string,
  // if set to true, this uploads the file to a global directory
  // instead of the user's private directory.
  global?: boolean,
): Promise<string> => {
  if (!config.fileUploads) {
    throw new Error("File uploads are not configured (in the exported uploadFile function)");
  }
  const client = getS3Client(config);

  let defaultBucket = config.fileUploads.s3Bucket;

  let key = fileName;
  if (!global) {
    key = addUserPrefixToKey(key, user || "api");
  }
  key = addGeneralPrefixToKey(key, config);

  // Sanitize metadata to ensure only ASCII characters (prevents SignatureDoesNotMatch errors)
  const sanitizedMetadata = sanitizeMetadata(options.metadata);

  const command = new PutObjectCommand({
    Bucket: customBucket || defaultBucket,
    Key: key,
    Body: file,
    ContentType: options.contentType,
    Metadata: sanitizedMetadata,
    ContentLength: file.byteLength,
  });

  // Retry logic for handling intermittent signature errors
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await client.send(command);
      break; // Success, exit retry loop
    } catch (error: any) {
      lastError = error;

      // Only retry on signature/auth errors
      if (
        error.name === "SignatureDoesNotMatch" ||
        error.name === "InvalidAccessKeyId" ||
        error.name === "AccessDenied"
      ) {
        if (attempt < maxRetries) {
          const backoffMs = Math.pow(2, attempt) * 1000; // Exponential backoff: 2s, 4s, 8s
          await new Promise((resolve) => setTimeout(resolve, backoffMs));

          // Force recreation of S3 client on signature errors
          s3Client = undefined;
          getS3Client(config);
          continue;
        }
      } else {
        // For non-auth errors, throw immediately
        throw error;
      }
    }
  }

  if (lastError) {
    throw lastError;
  }

  return addBucketPrefixToKey(key, customBucket || defaultBucket);
};

export interface S3FileObject {
  key: string;
  size: number;
  lastModified: Date;
}

/**
 * List all objects under a given S3 prefix (handles pagination automatically).
 */
export const listS3ObjectsByPrefix = async (
  prefix: string,
  config: ExuluConfig,
): Promise<S3FileObject[]> => {
  if (!config.fileUploads) {
    throw new Error("File uploads are not configured");
  }
  const client = getS3Client(config);
  const bucket = config.fileUploads.s3Bucket;
  const fullPrefix = addGeneralPrefixToKey(prefix, config);

  const results: S3FileObject[] = [];
  let continuationToken: string | undefined;

  do {
    const command = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: fullPrefix,
      ...(continuationToken && { ContinuationToken: continuationToken }),
    });
    const response = await client.send(command);
    for (const obj of response.Contents ?? []) {
      if (obj.Key && obj.Size !== undefined && obj.LastModified) {
        results.push({
          key: obj.Key,
          size: obj.Size,
          lastModified: obj.LastModified,
        });
      }
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return results;
};

/**
 * `CopySource` is a header value, not a path parameter — the SDK does not
 * encode it, and S3 URL-decodes whatever it receives. Encode each "/"
 * -delimited segment on its own (never the whole string, which would
 * escape the "/" separators themselves and point at a nonexistent key).
 * Keys made of internal, ASCII-safe segments (uuids, "v1", fixed names)
 * round-trip through this unchanged; a user-named filename with spaces,
 * unicode, or other header-unsafe characters is exactly what this exists
 * to fix.
 */
export const encodeS3KeyForCopySource = (key: string): string =>
  key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

/**
 * Copy an S3 object from one key to another within the same bucket.
 * Keys should NOT include the bucket prefix.
 */
export const copyS3Object = async (
  sourceKey: string,
  destKey: string,
  config: ExuluConfig,
): Promise<void> => {
  if (!config.fileUploads) {
    throw new Error("File uploads are not configured");
  }
  const client = getS3Client(config);
  const bucket = config.fileUploads.s3Bucket;
  const command = new CopyObjectCommand({
    Bucket: bucket,
    CopySource: `${bucket}/${encodeS3KeyForCopySource(sourceKey)}`,
    Key: destKey,
    // Explicit so the origin marker (exulu-origin) survives a copy; promoting a
    // file into a project must not turn an agent file into a "user" file.
    MetadataDirective: "COPY",
  });
  await client.send(command);
};

/**
 * Read the full text content of an S3 object.
 * Intended for small text files (markdown, scripts) used in diffs and previews.
 */
export const getS3ObjectContent = async (
  key: string,
  config: ExuluConfig,
): Promise<string> => {
  if (!config.fileUploads) {
    throw new Error("File uploads are not configured");
  }
  const client = getS3Client(config);
  const bucket = config.fileUploads.s3Bucket;
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await client.send(command);
  if (!response.Body) {
    throw new Error(`Empty body for S3 key: ${key}`);
  }
  return response.Body.transformToString("utf-8");
};

/**
 * Open a Node readable stream onto an S3 object, for large files that must
 * not be buffered fully into memory (the server-side CSV bulk import --
 * src/exulu/import/run-import.ts streams rows off this instead of loading
 * the whole upload via getS3ObjectContent/getS3ObjectBytes). The caller owns
 * the returned stream's lifecycle (destroy it on cancel/error) -- the return
 * type keeps `destroy` alongside the plain NodeJS.ReadableStream surface so
 * callers can tear it down without a cast.
 */
export const getS3ObjectStream = async (
  key: string,
  config: ExuluConfig,
): Promise<NodeJS.ReadableStream & { destroy: (error?: Error) => void }> => {
  if (!config.fileUploads) {
    throw new Error("File uploads are not configured");
  }
  const client = getS3Client(config);
  const bucket = config.fileUploads.s3Bucket;
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await client.send(command);
  if (!response.Body) {
    throw new Error(`Empty body for S3 key: ${key}`);
  }
  // In the Node.js runtime (as opposed to a browser/edge runtime), the AWS
  // SDK v3 always resolves GetObjectCommand's Body to a Node Readable.
  return response.Body as unknown as NodeJS.ReadableStream & { destroy: (error?: Error) => void };
};

/**
 * Fetch the ETag for an S3 object via HeadObject. Used as a cache key for
 * derived artefacts like the LibreOffice-rendered PDF preview — the ETag
 * changes whenever the object content changes, so cached derivations
 * invalidate automatically. Returns null if HeadObject fails (object
 * missing or auth error).
 */
export const getS3ObjectEtag = async (
  key: string,
  config: ExuluConfig,
): Promise<string | null> => {
  if (!config.fileUploads) {
    throw new Error("File uploads are not configured");
  }
  const client = getS3Client(config);
  const bucket = config.fileUploads.s3Bucket;
  try {
    const response = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return response.ETag ?? null;
  } catch {
    return null;
  }
};

/**
 * Read the user metadata (e.g. exulu-origin) of an S3 object via HeadObject.
 * Returns undefined if HeadObject fails, so callers can treat it as "unknown".
 */
export const getS3ObjectMetadata = async (
  key: string,
  config: ExuluConfig,
): Promise<Record<string, string> | undefined> => {
  if (!config.fileUploads) {
    throw new Error("File uploads are not configured");
  }
  const client = getS3Client(config);
  try {
    const response = await client.send(
      new HeadObjectCommand({ Bucket: config.fileUploads.s3Bucket, Key: key }),
    );
    return response.Metadata;
  } catch {
    return undefined;
  }
};

/** True for the error shapes the SDK throws when an object does not exist. */
export function isS3NotFound(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } } | null;
  return (
    e?.$metadata?.httpStatusCode === 404 ||
    e?.name === "NotFound" ||
    e?.name === "NoSuchKey" ||
    e?.Code === "NotFound" ||
    e?.Code === "NoSuchKey"
  );
}

/**
 * Like getS3ObjectMetadata, but only a missing object yields undefined; any other failure
 * (network, throttling, credentials) throws so a caller that memoises the answer does not
 * cache a transient error as if it were the object's real metadata.
 */
export const getS3ObjectMetadataStrict = async (
  key: string,
  config: ExuluConfig,
): Promise<Record<string, string> | undefined> => {
  if (!config.fileUploads) {
    throw new Error("File uploads are not configured");
  }
  const client = getS3Client(config);
  try {
    const response = await client.send(
      new HeadObjectCommand({ Bucket: config.fileUploads.s3Bucket, Key: key }),
    );
    return response.Metadata;
  } catch (err) {
    if (isS3NotFound(err)) return undefined;
    throw err;
  }
};

/**
 * The generic /s3/* routes only check the `user_<id>` segment, so a key without
 * one (project files) would be served to any authenticated user. Project files
 * go through the project routes, which check project membership; only API keys
 * and super admins may touch them here. `key` is the object key WITHOUT bucket.
 */
export function mayUseGenericS3Route(
  key: string,
  user: { type?: string; super_admin?: boolean },
  s3prefix?: string | null,
): boolean {
  // The derived/ store is backend-internal: nobody reads or writes it here.
  if (isDerivedKey(key, s3prefix)) return false;
  if (user.type === "api" || user.super_admin) return true;
  return !isProjectKey(key, s3prefix);
}

/**
 * Directory segments of a generic S3 key (WITHOUT bucket), or null when the key
 * has an empty, `.` or `..` segment: such keys could dodge the ownership check
 * below and never come from an upload path. The general prefix's own segments
 * are dropped when the key starts with it.
 */
function genericKeyDirectories(key: string, s3prefix?: string | null): string[] | null {
  // No leading-slash stripping: "/user_2/x" is a different object than "user_2/x"
  // and no upload path produces one.
  const segments = key.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  const general = (s3prefix ?? "").replace(/^\/+|\/+$/g, "");
  const prefixSegments = general ? general.split("/") : [];
  const hasPrefix = prefixSegments.length > 0 && prefixSegments.every((p, i) => segments[i] === p);
  return segments.slice(hasPrefix ? prefixSegments.length : 0, -1);
}

/**
 * Ownership rule of the generic read routes (`GET /s3/download`, `POST /s3/object`):
 * API users and super admins read anything; everyone else a key in which every
 * DIRECTORY segment starting with `user_` is their own `user_<id>` (keys without
 * one, e.g. `global/`, `items/`, are readable). The file name is exempt, so
 * `items/report_user_1.pdf` is readable while `user_2/x/user_1/y` is not.
 * Empty, `.` and `..` segments are refused. `key` is WITHOUT the bucket.
 */
export function mayReadGenericS3Key(
  key: string,
  user: { id?: number | string; type?: string; super_admin?: boolean },
  s3prefix?: string | null,
): boolean {
  if (user.type === "api" || user.super_admin) return true;
  const directories = genericKeyDirectories(key, s3prefix);
  if (directories === null) return false;
  return directories.every((d) => !d.startsWith("user_") || d === `user_${user.id}`);
}

/**
 * `/s3/delete`: the read rule above AND the key must lie under the caller's own
 * `user_<id>/` segment (a global or item key is not the caller's to delete).
 */
export function mayDeleteGenericS3Key(
  key: string,
  user: { id?: number | string; type?: string; super_admin?: boolean },
  s3prefix?: string | null,
): boolean {
  if (user.type === "api" || user.super_admin) return true;
  if (!mayReadGenericS3Key(key, user, s3prefix)) return false;
  return (genericKeyDirectories(key, s3prefix) ?? []).includes(`user_${user.id}`);
}

/**
 * Whether a multipart key (as `POST /s3/multipart` returned it: general prefix +
 * `user_<id>/` or `global/` + name) belongs to the caller. The follow-up multipart
 * routes take the key from the query string, so without this any caller could sign
 * parts for, complete or abort uploads at arbitrary keys. `user_api/` is the shared
 * prefix of API users (see addUserPrefixToKey's call sites).
 */
export function multipartKeyBelongsTo(
  key: string,
  user: { id?: number | string; type?: string },
  s3prefix?: string | null,
): boolean {
  if (!key || key.split("/").includes("..")) return false;
  let rest = key;
  const general = (s3prefix ?? "").replace(/\/+$/, "");
  if (general) {
    if (!rest.startsWith(`${general}/`)) return false;
    rest = rest.slice(general.length + 1);
  }
  const own = user.type === "api" ? "user_api/" : `user_${user.id}/`;
  return rest.startsWith(own) || rest.startsWith("global/");
}

/**
 * STS policy for browser uploads: the caller may only write under their own
 * prefix (matches addUserPrefixToKey), never another user's, global/ or projects/.
 */
export function buildStsPolicy(
  bucket: string,
  userId: number | string,
  s3prefix?: string | null,
) {
  const general = s3prefix ? `${s3prefix.replace(/\/+$/, "")}/` : "";
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:PutObject"],
        Resource: [`arn:aws:s3:::${bucket}/${general}user_${userId}/*`],
      },
    ],
  };
}

/**
 * Fetch the byte size of an S3 object via HeadObject, without downloading
 * it. Used to enforce a size cap on a copy-only path (session file adopt)
 * that never passes through the presigned-PUT upload flow, so the client's
 * own size check never runs. Returns null if HeadObject fails (object
 * missing or auth error) so the caller can treat "unknown" the same as
 * "over the limit".
 */
export const getS3ObjectSize = async (
  key: string,
  config: ExuluConfig,
): Promise<number | null> => {
  if (!config.fileUploads) {
    throw new Error("File uploads are not configured");
  }
  const client = getS3Client(config);
  const bucket = config.fileUploads.s3Bucket;
  try {
    const response = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return response.ContentLength ?? null;
  } catch {
    return null;
  }
};

/**
 * Read the full binary content of an S3 object as a Buffer.
 * Use for archives, images, and any non-text payload (e.g. skill bundle zips).
 */
export const getS3ObjectBytes = async (
  key: string,
  config: ExuluConfig,
): Promise<Buffer> => {
  if (!config.fileUploads) {
    throw new Error("File uploads are not configured");
  }
  const client = getS3Client(config);
  const bucket = config.fileUploads.s3Bucket;
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await client.send(command);
  if (!response.Body) {
    throw new Error(`Empty body for S3 key: ${key}`);
  }
  const byteArray = await response.Body.transformToByteArray();
  return Buffer.from(byteArray);
};

/**
 * Delete a single object from S3 by its full key (no bucket prefix).
 */
export const deleteS3Object = async (
  key: string,
  config: ExuluConfig,
): Promise<void> => {
  if (!config.fileUploads) {
    throw new Error("File uploads are not configured");
  }
  const client = getS3Client(config);
  const bucket = config.fileUploads.s3Bucket;
  const command = new DeleteObjectCommand({ Bucket: bucket, Key: key });
  await client.send(command);
};

/**
 * Generate a presigned PUT URL for uploading a file to an exact S3 key.
 * Unlike /s3/sign (which generates UUID-based keys), this preserves the
 * caller-specified path — used for skill file uploads.
 */
export const getS3SignedUploadUrl = async (
  key: string,
  contentType: string,
  config: ExuluConfig,
  // Defaults to a day; project uploads pass minutes (PROJECT_UPLOAD_URL_TTL_SECONDS).
  opts: { expiresIn?: number } = {},
): Promise<string> => {
  if (!config.fileUploads) {
    throw new Error("File uploads are not configured");
  }
  const client = getS3Client(config);
  const bucket = config.fileUploads.s3Bucket;
  const url = await getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: opts.expiresIn ?? expiresIn },
  );
  return url;
};

export const createUppyRoutes = async (app: Express, config: ExuluConfig) => {
  if (!config.fileUploads) {
    throw new Error("File uploads are not configured");
  }

  /**
   * @type {STSClient}
   */
  let stsClient;

  function getSTSClient() {
    if (!config.fileUploads) {
      throw new Error("File uploads are not configured");
    }
    stsClient ??= new STSClient({
      region: config.fileUploads.s3region,
      ...(config.fileUploads.s3endpoint && { endpoint: config.fileUploads.s3endpoint }),
      credentials: {
        accessKeyId: config.fileUploads.s3key,
        secretAccessKey: config.fileUploads.s3secret,
      },
    });
    return stsClient;
  }

  app.delete("/s3/delete", async (req, res) => {
    if (!config.fileUploads) {
      throw new Error("File uploads are not configured");
    }
    const apikey: any = req.headers["exulu-api-key"] || null;
    const internalkey: any = req.headers["internal-key"] || null;
    const { db } = await postgresClient();

    let authtoken: any = null;
    if (typeof apikey !== "string" && typeof internalkey !== "string") {
      // default to next auth tokens to authenticate
      authtoken = await getToken(req.headers.authorization ?? "");
    }
    const authenticationResult = await authentication({
      authtoken,
      apikey,
      internalkey,
      db: db,
    });

    if (!authenticationResult.user?.id) {
      res
        .status(authenticationResult.code || 500)
        .json({ detail: `${authenticationResult.message}` });
      return;
    }

    const user = authenticationResult.user;

    let { key } = req.query;

    if (typeof key !== "string" || key.trim() === "") {
      res.status(400).json({ error: "Missing or invalid `key` query parameter." });
      return;
    }

    // Bucket should always be the
    // first part of the key.
    // The bucket is caller-supplied on purpose and not pinned to fileUploads.s3Bucket:
    // deployments keep knowledge-base source documents in a second bucket, which the
    // generic routes accept (delete included, for keys under the caller's own prefix).
    // Follow-up: an allowlist of buckets in config.
    let bucket = key.split("/")[0];

    if (!mayUseGenericS3Route(key.replace(`${bucket}/`, ""), user, config.fileUploads.s3prefix)) {
      res.status(403).json({ error: "Project files cannot be deleted through this route." });
      return;
    }

    // Only the user themselves, a super admin
    // or an api user can delete files.
    if (!mayDeleteGenericS3Key(key.slice((bucket ?? "").length + 1), user, config.fileUploads.s3prefix)) {
      res.status(405).json({
        error: "Not allowed to access the files in the folder based on authenticated user.",
      });
      return;
    }

    key = key.replace(`${bucket}/`, "");
    console.log("[EXULU] deleting file from s3 into bucket", bucket, "with key", key);

    const client = getS3Client(config);
    const command = new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    await client.send(command);
    res.json({ key });
  });

  app.get("/s3/download", async (req, res, next) => {
    const apikey: any = req.headers["exulu-api-key"] || null;
    const internalkey: any = req.headers["internal-key"] || null;
    const { db } = await postgresClient();

    let authtoken: any = null;
    if (typeof apikey !== "string" && typeof internalkey !== "string") {
      // default to next auth tokens to authenticate
      authtoken = await getToken(req.headers.authorization ?? "");
    }
    const authenticationResult = await authentication({
      authtoken,
      apikey,
      internalkey,
      db: db,
    });

    if (!authenticationResult.user?.id) {
      res
        .status(authenticationResult.code || 500)
        .json({ detail: `${authenticationResult.message}` });
      return;
    }

    const user = authenticationResult.user;

    let { key } = req.query;

    if (!key || typeof key !== "string" || key.trim() === "") {
      res.status(400).json({ error: "Missing or invalid `key` query parameter." });
      return;
    }

    // The bucket is caller-supplied on purpose and not pinned to fileUploads.s3Bucket:
    // deployments keep knowledge-base source documents in a second bucket and read
    // them through this route. Follow-up: an allowlist of readable buckets in config.
    let bucket = key.split("/")[0];

    console.log("[EXULU] bucket", bucket);

    if (!bucket || typeof bucket !== "string" || bucket.trim() === "") {
      res.status(400).json({
        error:
          "Missing or invalid `bucket` (should be the first part of the key before the first slash).",
      });
      return;
    }

    console.log("[EXULU] key for download before split", key);

    key = key.split("/").slice(1).join("/");

    console.log("[EXULU] key for download after split", key);

    if (typeof key !== "string" || key.trim() === "") {
      res.status(400).json({ error: "Missing or invalid `key` query parameter." });
      return;
    }

    if (!mayUseGenericS3Route(key, user, config.fileUploads?.s3prefix)) {
      res.status(403).json({ error: "Project files cannot be downloaded through this route." });
      return;
    }

    // Only the user themselves, a super admin
    // or an api user can download files.
    if (!mayReadGenericS3Key(key, user, config.fileUploads?.s3prefix)) {
      res
        .status(405)
        .json({ error: "Not allowed to access the file based on authenticated user." });
      return;
    }

    try {
      const url = await getPresignedUrl(bucket, key, config);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.json({ url, method: "GET", expiresIn });
    } catch (err) {
      next(err);
    }
  });

  app.post("/s3/object", async (req, res) => {
    if (!config.fileUploads) {
      throw new Error("File uploads are not configured");
    }

    const apikey: any = req.headers["exulu-api-key"] || null;
    const internalkey: any = req.headers["internal-key"] || null;
    const { db } = await postgresClient();

    let authtoken: any = null;
    if (typeof apikey !== "string" && typeof internalkey !== "string") {
      // default to next auth tokens to authenticate
      authtoken = await getToken(req.headers.authorization ?? "");
    }
    const authenticationResult = await authentication({
      authtoken,
      apikey,
      internalkey,
      db: db,
    });

    if (!authenticationResult.user?.id) {
      res
        .status(authenticationResult.code || 500)
        .json({ detail: `${authenticationResult.message}` });
      return;
    }

    let { key } = req.body ?? {};

    // Type-check before any string operation: a non-string key used to throw in
    // .split and surface as a 500.
    if (typeof key !== "string" || key.trim() === "") {
      res.status(400).json({ error: "Missing or invalid `key` in the request body." });
      return;
    }

    // The bucket is caller-supplied on purpose and not pinned to fileUploads.s3Bucket:
    // deployments keep knowledge-base source documents in a second bucket and read
    // them through this route. Follow-up: an allowlist of readable buckets in config.
    let bucket = key.split("/")[0];

    if (!bucket || bucket.trim() === "") {
      res.status(400).json({
        error:
          "Missing or invalid `bucket` (should be the first part of the key before the first slash).",
      });
      return;
    }

    key = key.split("/").slice(1).join("/");

    if (!key || key.trim() === "") {
      res.status(400).json({ error: "Missing or invalid `key` in the request body." });
      return;
    }

    const user = authenticationResult.user;

    // HeadObject exposes size and metadata of any key, so project keys are closed here too.
    if (!mayUseGenericS3Route(key, user, config.fileUploads.s3prefix)) {
      res.status(403).json({ error: "Project files cannot be read through this route." });
      return;
    }

    // Same ownership rule as GET /s3/download: another user's metadata (original
    // file names, sizes) is not the caller's to read.
    if (!mayReadGenericS3Key(key, user, config.fileUploads?.s3prefix)) {
      res.status(403).json({ error: "Not allowed to access the file based on authenticated user." });
      return;
    }

    const client = getS3Client(config);
    const command = new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    let response;
    try {
      response = await client.send(command);
    } catch (err: any) {
      if (err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
        res.status(404).json({ error: "Object not found." });
        return;
      }
      throw err;
    }

    // Only what the file card needs; the raw HeadObject output also carries
    // request ids, encryption and version details.
    res.json({
      ContentLength: response.ContentLength,
      ContentType: response.ContentType,
      LastModified: response.LastModified,
      ETag: response.ETag,
      Metadata: response.Metadata,
    });
  });

  app.get("/s3/list", async (req, res) => {
    if (!config.fileUploads) {
      throw new Error("File uploads are not configured");
    }

    const apikey: any = req.headers["exulu-api-key"] || null;
    const internalkey: any = req.headers["internal-key"] || null;
    const { db } = await postgresClient();

    let authtoken: any = null;
    if (typeof apikey !== "string" && typeof internalkey !== "string") {
      // default to next auth tokens to authenticate
      authtoken = await getToken(req.headers.authorization ?? "");
    }
    const authenticationResult = await authentication({
      authtoken,
      apikey,
      internalkey,
      db: db,
    });

    if (!authenticationResult.user?.id) {
      res
        .status(authenticationResult.code || 500)
        .json({ detail: `${authenticationResult.message}` });
      return;
    }
    const client = getS3Client(config);

    let prefix = `${config.fileUploads.s3prefix ? config.fileUploads.s3prefix.replace(/\/$/, "") + "/" : ""}`;

    // Trailing slash: without it user 1's prefix also matches user_10/, user_100/ …
    if (!req.headers.global) {
      prefix += `user_${authenticationResult.user.id}/`;
    } else {
      prefix += "global/";
    }

    console.log("[EXULU] bucket", config.fileUploads.s3Bucket);
    console.log("[EXULU] prefix", prefix);

    let response: ListObjectsV2CommandOutput;

    if (req.query.search) {
      const search = (req.query.search as string).toLowerCase();
      console.log("[EXULU] Filtering files by search query", req.query.search);

      // Paginate through the full prefix so matches outside the first
      // page (S3 returns keys lexicographically — UUID-prefixed files
      // can land anywhere) aren't missed.
      const matched: NonNullable<ListObjectsV2CommandOutput["Contents"]> = [];
      let token: string | undefined;
      do {
        const page: ListObjectsV2CommandOutput = await client.send(
          new ListObjectsV2Command({
            Bucket: config.fileUploads.s3Bucket,
            Prefix: prefix,
            ...(token && { ContinuationToken: token }),
          }),
        );
        for (const obj of page.Contents ?? []) {
          if (obj.Key?.toLowerCase().includes(search)) {
            matched.push(obj);
          }
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);

      response = {
        $metadata: {} as any,
        Contents: matched,
        KeyCount: matched.length,
        IsTruncated: false,
      };
    } else {
      const command = new ListObjectsV2Command({
        Bucket: config.fileUploads.s3Bucket,
        Prefix: prefix,
        MaxKeys: 9,
        ...(req.query.continuationToken && {
          ContinuationToken: req.query.continuationToken as string,
        }),
      });
      response = await client.send(command);
    }

    res.json({
      ...response,
      Contents: response.Contents?.map((content) => {
        return {
          ...content,
          // For consistency and to support multi-bucket environments
          // we prepend the bucket name to the key here.
          Key: `${config.fileUploads?.s3Bucket}/${content.Key}`,
        };
      }),
    });
    res.end();
  });

  app.get("/s3/sts", async (req, res, next) => {
    if (!config.fileUploads) {
      throw new Error("File uploads are not configured");
    }
    // The policy is scoped to the caller's own prefix, so the route must know the caller.
    const apikey: any = req.headers["exulu-api-key"] || null;
    const internalkey: any = req.headers["internal-key"] || null;
    const { db } = await postgresClient();
    let authtoken: any = null;
    if (typeof apikey !== "string" && typeof internalkey !== "string") {
      authtoken = await getToken(req.headers.authorization ?? "");
    }
    const authenticationResult = await authentication({ authtoken, apikey, internalkey, db });
    if (!authenticationResult.user?.id) {
      res
        .status(authenticationResult.code || 500)
        .json({ detail: `${authenticationResult.message}` });
      return;
    }
    const user = authenticationResult.user;
    const policy = buildStsPolicy(
      config.fileUploads.s3Bucket,
      user.type === "api" ? "api" : user.id,
      config.fileUploads.s3prefix,
    );
    getSTSClient()
      .send(
        new GetFederationTokenCommand({
          Name: "Exulu",
          // The duration, in seconds, of the role session. The value specified
          // can range from 900 seconds (15 minutes) up to the maximum session
          // duration set for the role.
          DurationSeconds: expiresIn,
          Policy: JSON.stringify(policy),
        }),
      )
      .then((response) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        // Per-user credentials must never sit in a shared cache.
        res.setHeader("Cache-Control", `private,max-age=${expiresIn}`);
        res.json({
          credentials: response.Credentials,
          bucket: config.fileUploads?.s3Bucket,
          region: config.fileUploads?.s3region,
        });
      }, next);
  });

  const validateFileParameters = (filename, contentType) => {
    if (!filename || !contentType) {
      throw new Error("Missing required parameters: filename and content type are required");
    }
  };

  const extractFileParameters = (req) => {
    const isPostRequest = req.method === "POST";
    const params = isPostRequest ? req.body : req.query;

    return {
      filename: params.filename,
      contentType: params.type,
    };
  };

  const generateS3Key = (filename) => `${randomUUID()}-_EXULU_${filename}`;

  const signOnServer = async (req, res, next) => {
    if (!config.fileUploads) {
      throw new Error("File uploads are not configured");
    }
    // Before giving the signature to the user, you should first check is they
    // are authorized to perform that operation, and if the request is legit.
    // For the sake of simplification, we skip that check in this example.

    const apikey: any = req.headers["exulu-api-key"] || null;
    const { db } = await postgresClient();

    let authtoken: any = null;
    if (typeof apikey !== "string") {
      // default to next auth tokens to authenticate
      authtoken = await getToken(req.headers.authorization ?? "");
    }
    const authenticationResult = await authentication({
      authtoken,
      apikey,
      db: db,
    });

    if (!authenticationResult.user?.id) {
      res
        .status(authenticationResult.code || 500)
        .json({ detail: `${authenticationResult.message}` });
      return;
    }

    const user = authenticationResult.user;

    const { filename, contentType } = extractFileParameters(req);
    validateFileParameters(filename, contentType);

    // Generate S3 key and prepare command
    const key = generateS3Key(filename);

    let fullKey = key;
    console.log("[EXULU] global", req.headers.global);

    if (!req.headers.global) {
      fullKey = addUserPrefixToKey(key, user.type === "api" ? "api" : user.id);
    } else {
      fullKey = "global/" + key;
    }
    fullKey = addGeneralPrefixToKey(fullKey, config);

    console.log("[EXULU] signing on server for user", user.id, "with key", fullKey);

    getSignedUrl(
      getS3Client(config),
      new PutObjectCommand({
        Bucket: config.fileUploads.s3Bucket,
        Key: fullKey,
        ContentType: contentType,
      }),
      { expiresIn },
    ).then((url) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.json({
        key,
        url,
        method: "PUT",
      });
      res.end();
    }, next)
  };

  app.get("/s3/params", async (req, res, next) => {
    return await signOnServer(req, res, next);
  });
  app.post("/s3/sign", async (req, res, next) => {
    return await signOnServer(req, res, next);
  });

  //  === <S3 Multipart> ===
  // You can remove those endpoints if you only want to support the non-multipart uploads.

  app.post("/s3/multipart", async (req, res, next) => {
    if (!config.fileUploads) {
      throw new Error("File uploads are not configured");
    }

    const apikey: any = req.headers["exulu-api-key"] || null;
    const { db } = await postgresClient();

    let authtoken: any = null;
    if (typeof apikey !== "string") {
      // default to next auth tokens to authenticate
      authtoken = await getToken(req.headers.authorization ?? "");
    }
    const authenticationResult = await authentication({
      authtoken,
      apikey,
      db: db,
    });

    if (!authenticationResult.user?.id) {
      res
        .status(authenticationResult.code || 500)
        .json({ detail: `${authenticationResult.message}` });
      return;
    }

    const user = authenticationResult.user;
    const client = getS3Client(config);
    const { type, metadata, filename } = req.body;
    if (typeof filename !== "string") {
      return res.status(400).json({ error: "s3: content filename must be a string" });
    }
    if (typeof type !== "string") {
      return res.status(400).json({ error: "s3: content type must be a string" });
    }
    const key = `${randomUUID()}-_EXULU_${filename}`;

    let fullKey = key;
    console.log("[EXULU] global", req.headers.global);
    if (!req.headers.global) {
      fullKey = addUserPrefixToKey(key, user.type === "api" ? "api" : user.id);
    } else {
      fullKey = "global/" + key;
    }
    fullKey = addGeneralPrefixToKey(fullKey, config);

    console.log("[EXULU] signing on server for user", user.id, "with key", fullKey);

    const params = {
      Bucket: config.fileUploads.s3Bucket,
      Key: fullKey,
      ContentType: type,
      // S3 metadata values must be US-ASCII. Sanitize here (same as uploadFile)
      // so non-ASCII characters in the filename — e.g. the en-dash "–" in
      // "… CEST – Recording.mp4" — don't trigger a SignatureDoesNotMatch.
      Metadata: sanitizeMetadata(metadata),
    };

    const command = new CreateMultipartUploadCommand(params);

    return client.send(command, (err, data) => {
      if (err) {
        next(err);
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.json({
        // Return the FULL key (incl. user/global + s3 prefix) the upload was
        // actually created at. Unlike the simple-PUT path — where the signed
        // URL already embeds the full key — the multipart protocol re-signs
        // each part from this key, so handing back the bare key would sign
        // parts for a key that doesn't exist → S3 "NoSuchUpload".
        key: fullKey,
        uploadId: data?.UploadId,
      });
    });
  });

  /**
   * Authentication (same as `POST /s3/multipart`) plus "the query key is one the
   * create route could have minted for this caller". Answers the request itself and
   * returns null on failure; otherwise the validated key.
   */
  const authorizeMultipartKey = async (req: any, res: any): Promise<string | null> => {
    const apikey: any = req.headers["exulu-api-key"] || null;
    const { db } = await postgresClient();
    let authtoken: any = null;
    if (typeof apikey !== "string") {
      authtoken = await getToken(req.headers.authorization ?? "");
    }
    const authenticationResult = await authentication({ authtoken, apikey, db });
    if (!authenticationResult.user?.id) {
      res
        .status(authenticationResult.code || 500)
        .json({ detail: `${authenticationResult.message}` });
      return null;
    }
    const { key } = req.query;
    if (typeof key !== "string") {
      res.status(400).json({
        error:
          's3: the object key must be passed as a query parameter. For example: "?key=abc.jpg"',
      });
      return null;
    }
    if (!multipartKeyBelongsTo(key, authenticationResult.user, config.fileUploads?.s3prefix)) {
      res.status(403).json({ error: "s3: this upload does not belong to the authenticated user." });
      return null;
    }
    return key;
  };

  function validatePartNumber(partNumber) {
    // eslint-disable-next-line no-param-reassign
    partNumber = Number(partNumber);
    return Number.isInteger(partNumber) && partNumber >= 1 && partNumber <= 10_000;
  }

  app.get("/s3/multipart/:uploadId/:partNumber", async (req, res, next) => {
    if (!config.fileUploads) {
      throw new Error("File uploads are not configured");
    }
    const { uploadId, partNumber } = req.params;

    if (!validatePartNumber(partNumber)) {
      return res
        .status(400)
        .json({ error: "s3: the part number must be an integer between 1 and 10000." });
    }

    const key = await authorizeMultipartKey(req, res);
    if (key === null) return;

    return getSignedUrl(
      getS3Client(config),
      new UploadPartCommand({
        Bucket: config.fileUploads.s3Bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: Number(partNumber),
        Body: "",
      }),
      { expiresIn },
    ).then((url) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.json({ url, expires: expiresIn });
    }, next);
  });

  app.get("/s3/multipart/:uploadId", async (req, res, next) => {
    const authorizedKey = await authorizeMultipartKey(req, res);
    if (authorizedKey === null) return;
    // Narrowed copy: the closure below does not see the null check.
    const key: string = authorizedKey;
    const client = getS3Client(config);
    const { uploadId } = req.params;

    const parts: any[] = [];

    function listPartsPage(startAt) {
      if (!config.fileUploads) {
        throw new Error("File uploads are not configured");
      }
      client.send(
        new ListPartsCommand({
          Bucket: config.fileUploads.s3Bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: startAt,
        }),
        (err, data) => {
          if (err) {
            next(err);
            return;
          }

          parts.push(...(data?.Parts ?? []));

          if (data?.IsTruncated) {
            // Get the next page.
            listPartsPage(data.NextPartNumberMarker);
          } else {
            res.json(parts);
          }
        },
      );
    }
    listPartsPage(0);
  });

  function isValidPart(part) {
    return (
      part && typeof part === "object" && Number(part.PartNumber) && typeof part.ETag === "string"
    );
  }

  app.post("/s3/multipart/:uploadId/complete", async (req, res, next) => {
    if (!config.fileUploads) {
      throw new Error("File uploads are not configured");
    }
    const key = await authorizeMultipartKey(req, res);
    if (key === null) return;
    const client = getS3Client(config);
    const { uploadId } = req.params;
    const { parts } = req.body;

    if (!Array.isArray(parts) || !parts.every(isValidPart)) {
      return res
        .status(400)
        .json({ error: "s3: `parts` must be an array of {ETag, PartNumber} objects." });
    }

    return client.send(
      new CompleteMultipartUploadCommand({
        Bucket: config.fileUploads.s3Bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts,
        },
      }),
      (err, data) => {
        if (err) {
          next(err);
          return;
        }
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.json({
          key,
          location: data?.Location,
        });
      },
    );
  });

  app.delete("/s3/multipart/:uploadId", async (req, res, next) => {
    if (!config.fileUploads) {
      throw new Error("File uploads are not configured");
    }
    const key = await authorizeMultipartKey(req, res);
    if (key === null) return;

    const client = getS3Client(config);
    const { uploadId } = req.params;

    return client.send(
      new AbortMultipartUploadCommand({
        Bucket: config.fileUploads.s3Bucket,
        Key: key,
        UploadId: uploadId,
      }),
      (err) => {
        if (err) {
          next(err);
          return;
        }
        res.json({
          key,
        });
      },
    );
  });

  return app;
};
