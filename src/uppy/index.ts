import { type Express } from "express";
import { authentication } from "../auth/auth";
import { getToken } from "../auth/get-token";
import { postgresClient } from "../postgres/client";
import type { ExuluConfig } from "../exulu/app/index";
import {
  S3Client,
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
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

export const createUppyRoutes = async (app: Express, config: ExuluConfig) => {
  if (!config.fileUploads) {
    throw new Error("File uploads are not configured");
  }

  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:PutObject"],
        Resource: [
          `arn:aws:s3:::${config.fileUploads.s3Bucket}/*`,
          `arn:aws:s3:::${config.fileUploads.s3Bucket}`,
        ],
      },
    ],
  };

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
    let bucket = key.split("/")[0];

    // Only the user themselves, a super admin
    // or an api user can delete files.
    if (user.type !== "api" && !key.includes(`/user_${user.id}/`) && !user.super_admin) {
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

    // Only the user themselves, a super admin
    // or an api user can download files.
    let allowed = false;
    if (
      user.type === "api" ||
      user.super_admin ||
      !key.includes(`user_`) ||
      key.includes(`user_${user.id}/`)
    ) {
      allowed = true;
    }

    if (!allowed) {
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

    let { key } = req.body;

    let bucket = key.split("/")[0];

    if (!bucket || typeof bucket !== "string" || bucket.trim() === "") {
      res.status(400).json({
        error:
          "Missing or invalid `bucket` (should be the first part of the key before the first slash).",
      });
      return;
    }

    key = key.split("/").slice(1).join("/");

    if (!key || typeof key !== "string" || key.trim() === "") {
      res.status(400).json({ error: "Missing or invalid `key` query parameter." });
      return;
    }

    const client = getS3Client(config);
    const command = new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    const response = await client.send(command);

    res.json(response);
    res.end();
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

    if (!req.headers.global) {
      prefix += `user_${authenticationResult.user.id}`;
    } else {
      prefix += "global";
    }

    console.log("[EXULU] prefix", prefix);

    const command = new ListObjectsV2Command({
      Bucket: config.fileUploads.s3Bucket,
      Prefix: prefix,
      MaxKeys: 9,
      ...(req.query.continuationToken && {
        ContinuationToken: req.query.continuationToken as string,
      }),
    });

    const response: ListObjectsV2CommandOutput = await client.send(command);

    if (req.query.search) {
      const search = req.query.search as string;
      console.log("[EXULU] Filtering files by search query", req.query.search);
      response.Contents = response.Contents?.filter((content) =>
        content?.Key?.toLowerCase().includes(search.toLowerCase()),
      );
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

  app.get("/s3/sts", (req, res, next) => {
    if (!config.fileUploads) {
      throw new Error("File uploads are not configured");
    }
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
        // Test creating multipart upload from the server — it works
        // createMultipartUploadYo(response)
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", `public,max-age=${expiresIn}`);
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
    }, next);
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
      Metadata: metadata,
    };

    const command = new CreateMultipartUploadCommand(params);

    return client.send(command, (err, data) => {
      if (err) {
        next(err);
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.json({
        key,
        uploadId: data?.UploadId,
      });
    });
  });

  function validatePartNumber(partNumber) {
    // eslint-disable-next-line no-param-reassign
    partNumber = Number(partNumber);
    return Number.isInteger(partNumber) && partNumber >= 1 && partNumber <= 10_000;
  }

  app.get("/s3/multipart/:uploadId/:partNumber", (req, res, next) => {
    if (!config.fileUploads) {
      throw new Error("File uploads are not configured");
    }
    const { uploadId, partNumber } = req.params;
    const { key } = req.query;

    if (!validatePartNumber(partNumber)) {
      return res
        .status(400)
        .json({ error: "s3: the part number must be an integer between 1 and 10000." });
    }

    if (typeof key !== "string") {
      return res.status(400).json({
        error:
          's3: the object key must be passed as a query parameter. For example: "?key=abc.jpg"',
      });
    }

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

  app.get("/s3/multipart/:uploadId", (req, res, next) => {
    const client = getS3Client(config);
    const { uploadId } = req.params;
    const { key } = req.query;

    if (typeof key !== "string") {
      res.status(400).json({
        error:
          's3: the object key must be passed as a query parameter. For example: "?key=abc.jpg"',
      });
      return;
    }

    const parts = [];

    function listPartsPage(startAt) {
      if (!config.fileUploads) {
        throw new Error("File uploads are not configured");
      }
      client.send(
        new ListPartsCommand({
          Bucket: config.fileUploads.s3Bucket,
          Key: key as string,
          UploadId: uploadId,
          PartNumberMarker: startAt,
        }),
        (err, data) => {
          if (err) {
            next(err);
            return;
          }

          // @ts-ignore
          parts.push(...data.Parts);

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

  app.post("/s3/multipart/:uploadId/complete", (req, res, next) => {
    if (!config.fileUploads) {
      throw new Error("File uploads are not configured");
    }
    const client = getS3Client(config);
    const { uploadId } = req.params;
    const { key } = req.query;
    const { parts } = req.body;

    if (typeof key !== "string") {
      return res.status(400).json({
        error:
          's3: the object key must be passed as a query parameter. For example: "?key=abc.jpg"',
      });
    }

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

  app.delete("/s3/multipart/:uploadId", (req, res, next) => {
    if (!config.fileUploads) {
      throw new Error("File uploads are not configured");
    }

    const client = getS3Client(config);
    const { uploadId } = req.params;
    const { key } = req.query;

    if (typeof key !== "string") {
      return res.status(400).json({
        error:
          's3: the object key must be passed as a query parameter. For example: "?key=abc.jpg"',
      });
    }

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
