import { type Express } from "express";
import { authentication } from "../auth/auth";
import { getToken } from "../auth/get-token"
import { postgresClient } from "../postgres/client";
import type { ExuluConfig } from "./index";
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
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
    STSClient,
    GetFederationTokenCommand,
} from '@aws-sdk/client-sts';
import { randomUUID } from 'node:crypto';

const expiresIn = 60 * 60 * 24 * 1 // S3 signature expires within 1 day.

let s3Client: S3Client | undefined;
function getS3Client(config: ExuluConfig) {
    s3Client ??= new S3Client({
        region: config.fileUploads.s3region,
        ...(config.fileUploads.s3endpoint && {
            forcePathStyle: true,
            endpoint: config.fileUploads.s3endpoint
        }),
        credentials: {
            accessKeyId: config.fileUploads.s3key,
            secretAccessKey: config.fileUploads.s3secret,
        },
    })
    return s3Client
}

export const getPresignedUrl = async (key: string, config: ExuluConfig) => {
    const url = await getSignedUrl(
        getS3Client(config),
        new GetObjectCommand({
            Bucket: config.fileUploads.s3Bucket,
            Key: key,
        }),
        { expiresIn }
    );
    return url;
}

export interface UploadOptions {
    contentType?: string;
    metadata?: Record<string, string>;
}

// Helper function to add s3prefix to a key path
const addPrefixToKey = (keyPath: string, config: ExuluConfig): string => {
    if (!config.fileUploads.s3prefix) {
        return keyPath;
    }
    const prefix = config.fileUploads.s3prefix.replace(/\/$/, '');
    // check if prefix is already present in keyPath
    if (keyPath.startsWith(prefix)) {
        return keyPath;
    }
    return `${prefix}/${keyPath}`;
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
    user: number,
    file: Buffer | Uint8Array,
    key: string,
    config: ExuluConfig,
    options: UploadOptions = {}
): Promise<string> => {
    console.log("[EXULU] Uploading file to S3", key)
    const client = getS3Client(config);

    let folder = `${user}/`
    const fullKey = addPrefixToKey(!key.includes(folder) ? folder + key : key, config);

    const command = new PutObjectCommand({
        Bucket: config.fileUploads.s3Bucket,
        Key: fullKey,
        Body: file,
        ContentType: options.contentType,
        Metadata: options.metadata,
        ContentLength: file.byteLength,
    });

    await client.send(command);
    return key;
}

export const createUppyRoutes = async (
    app: Express,
    config: ExuluConfig
) => {

    // Helper function to extract user prefix from S3 key, accounting for optional s3prefix
    const extractUserPrefix = (key: string): string | undefined => {
        if (!config.fileUploads.s3prefix) {
            return key.split("/")[0];
        }

        // Remove the s3prefix from the start if it exists
        const prefix = config.fileUploads.s3prefix.replace(/\/$/, '');
        if (key.startsWith(prefix + "/")) {
            const keyWithoutPrefix = key.slice(prefix.length + 1);
            return keyWithoutPrefix.split("/")[0];
        }

        // If key doesn't start with expected prefix, return first segment
        return key.split("/")[0];
    };

    const policy = {
        Version: '2012-10-17',
        Statement: [
            {
                Effect: 'Allow',
                Action: [
                    's3:PutObject',
                ],
                Resource: [
                    `arn:aws:s3:::${config.fileUploads.s3Bucket}/*`,
                    `arn:aws:s3:::${config.fileUploads.s3Bucket}`,
                ],
            },
        ],
    }

    /**
     * @type {STSClient}
     */
    let stsClient

    function getSTSClient() {
        stsClient ??= new STSClient({
            region: config.fileUploads.s3region,
            ...(config.fileUploads.s3endpoint && { endpoint: config.fileUploads.s3endpoint }),
            credentials: {
                accessKeyId: config.fileUploads.s3key,
                secretAccessKey: config.fileUploads.s3secret,
            },
        })
        return stsClient
    }

    app.delete('/s3/delete', async (req, res, next) => {
        const apikey: any = req.headers['exulu-api-key'] || null;
        const internalkey: any = req.headers['internal-key'] || null;
        const { db } = await postgresClient()

        let authtoken: any = null;
        if (typeof apikey !== "string" && typeof internalkey !== "string") { // default to next auth tokens to authenticate
            authtoken = await getToken(req.headers.authorization ?? "")
        }
        const authenticationResult = await authentication({
            authtoken,
            apikey,
            internalkey,
            db: db,
        })

        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        const { key } = req.query;

        if (typeof key !== 'string' || key.trim() === '') {
            res.status(400).json({ error: 'Missing or invalid `key` query parameter.' });
            return;
        }

        const userPrefix = extractUserPrefix(key);

        console.log("userPrefix", userPrefix)
        console.log("authenticationResult.user.id", authenticationResult.user.id)

        if (!userPrefix) {
            res.status(405).json({ error: 'Invalid key, does not contain a user prefix like "<user_id>/<key>.' });
            return;
        }

        if (userPrefix !== authenticationResult.user.id.toString()) {
            res.status(405).json({ error: 'Not allowed to access the files in the folder based on authenticated user.' });
            return;
        }

        // If access key is an api user we allow access to all folders. If not, we limit
        // to the user's own upload folders.
        if (authenticationResult.user.type !== "api" && !key.includes(authenticationResult.user.id.toString())) {
            res.status(405).json({ error: 'Not allowed to access the files in the folder based on authenticated user.' });
            return;
        }

        const client = getS3Client(config);
        const command = new DeleteObjectCommand({
            Bucket: config.fileUploads.s3Bucket,
            Key: key,
        })
        await client.send(command)
        res.json({ key })
    })

    app.get('/s3/download', async (req, res, next) => {

        const apikey: any = req.headers['exulu-api-key'] || null;
        const internalkey: any = req.headers['internal-key'] || null;
        const { db } = await postgresClient()

        let authtoken: any = null;
        if (typeof apikey !== "string" && typeof internalkey !== "string") { // default to next auth tokens to authenticate
            authtoken = await getToken(req.headers.authorization ?? "")
        }
        const authenticationResult = await authentication({
            authtoken,
            apikey,
            internalkey,
            db: db,
        })

        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        const { key } = req.query;

        if (typeof key !== 'string' || key.trim() === '') {
            res.status(400).json({ error: 'Missing or invalid `key` query parameter.' });
            return;
        }

        const userPrefix = extractUserPrefix(key);

        if (!userPrefix) {
            res.status(405).json({ error: 'Invalid key, does not contain a user prefix like "<user_id>/<key>.' });
            return;
        }

        if (userPrefix !== authenticationResult.user.id.toString()) {
            res.status(405).json({ error: 'Not allowed to access the files in the folder based on authenticated user.' });
            return;
        }

        // If access key is an api user we allow access to all folders. If not, we limit
        // to the user's own upload folders.
        if (authenticationResult.user.type !== "api" && !key.includes(authenticationResult.user.id.toString())) {
            res.status(405).json({ error: 'Not allowed to access the files in the folder based on authenticated user.' });
            return;
        }

        try {
            const url = await getPresignedUrl(key, config);
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.json({ url, method: 'GET', expiresIn });
        } catch (err) {
            next(err);
        }
    });

    type S3FileListOutput = {
        "$metadata": {
            "httpStatusCode"?: number | undefined,
            "attempts"?: number | undefined,
            "totalRetryDelay"?: number | undefined
        },
        "Contents": {
            "Key": string,
            "LastModified": string,
            "ETag": string,
            "Size": number
        }[]
        "IsTruncated": boolean,
        "NextContinuationToken": string,
        "KeyCount": number,
        "MaxKeys": number,
        "Name": string,
        "Prefix": string
    }

    // todo add api to list a user's files, with option to filter by type
    // so we can show them in a galery popup for file inputs.

    app.post('/s3/object', async (req, res, next) => {
        const apikey: any = req.headers['exulu-api-key'] || null;
        const internalkey: any = req.headers['internal-key'] || null;
        const { db } = await postgresClient()

        let authtoken: any = null;
        if (typeof apikey !== "string" && typeof internalkey !== "string") { // default to next auth tokens to authenticate
            authtoken = await getToken(req.headers.authorization ?? "")
        }
        const authenticationResult = await authentication({
            authtoken,
            apikey,
            internalkey,
            db: db,
        })

        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        const { key } = req.body;
        console.log("[EXULU] Getting object metadata from s3", key)
        const client = getS3Client(config);
        const command = new HeadObjectCommand({
            Bucket: config.fileUploads.s3Bucket,
            Key: key,
        })
        const response = await client.send(command);
        console.log("[EXULU] Object metadata from s3", response)
        res.json(response);
        res.end();
    })

    app.get('/s3/list', async (req, res, next) => {
        const apikey: any = req.headers['exulu-api-key'] || null;
        const internalkey: any = req.headers['internal-key'] || null;
        const { db } = await postgresClient()

        let authtoken: any = null;
        if (typeof apikey !== "string" && typeof internalkey !== "string") { // default to next auth tokens to authenticate
            authtoken = await getToken(req.headers.authorization ?? "")
        }
        const authenticationResult = await authentication({
            authtoken,
            apikey,
            internalkey,
            db: db,
        })

        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }
        const client = getS3Client(config);

        const command = new ListObjectsV2Command({
            Bucket: config.fileUploads.s3Bucket,
            Prefix: `test/${authenticationResult.user.id}`,
            MaxKeys: 9,
            ...(req.query.continuationToken && { ContinuationToken: req.query.continuationToken as string }),
        })

        const response: ListObjectsV2CommandOutput = await client.send(command)

        if (req.query.search) {
            const search = req.query.search as string
            console.log("[EXULU] Filtering files by search query", req.query.search)
            response.Contents = response.Contents?.filter((content) => content?.Key?.toLowerCase().includes(
                search.toLowerCase()
            ))
        }

        res.json(response)
        res.end()

    })


    app.get('/s3/sts', (req, res, next) => {
        getSTSClient().send(new GetFederationTokenCommand({
            Name: 'Exulu',
            // The duration, in seconds, of the role session. The value specified
            // can range from 900 seconds (15 minutes) up to the maximum session
            // duration set for the role.
            DurationSeconds: expiresIn,
            Policy: JSON.stringify(policy),
        })).then(response => {
            // Test creating multipart upload from the server — it works
            // createMultipartUploadYo(response)
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.setHeader('Cache-Control', `public,max-age=${expiresIn}`)
            res.json({
                credentials: response.Credentials,
                bucket: config.fileUploads.s3Bucket,
                region: config.fileUploads.s3region,
            })
        }, next)
    })

    const validateFileParameters = (filename, contentType) => {
        if (!filename || !contentType) {
            throw new Error('Missing required parameters: filename and content type are required')
        }
    }

    const extractFileParameters = (req) => {
        const isPostRequest = req.method === 'POST'
        const params = isPostRequest ? req.body : req.query

        return {
            filename: params.filename,
            contentType: params.type
        }
    }

    const generateS3Key = (filename) => `${randomUUID()}-_EXULU_${filename}`

    const signOnServer = async (req, res, next) => {
        // Before giving the signature to the user, you should first check is they
        // are authorized to perform that operation, and if the request is legit.
        // For the sake of simplification, we skip that check in this example.

        const apikey: any = req.headers['exulu-api-key'] || null;
        const { db } = await postgresClient();

        let authtoken: any = null;
        if (typeof apikey !== "string") { // default to next auth tokens to authenticate
            authtoken = await getToken(req.headers.authorization ?? "")
        }
        const authenticationResult = await authentication({
            authtoken,
            apikey,
            db: db
        })

        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        const { filename, contentType } = extractFileParameters(req)
        validateFileParameters(filename, contentType)

        // Generate S3 key and prepare command
        const key = generateS3Key(filename)

        let folder = `${authenticationResult.user.id}/`
        const fullKey = addPrefixToKey(folder + key, config);

        getSignedUrl(
            getS3Client(config),
            new PutObjectCommand({
                Bucket: config.fileUploads.s3Bucket,
                Key: fullKey,
                ContentType: contentType,
            }),
            { expiresIn },
        ).then((url) => {
            res.setHeader('Access-Control-Allow-Origin', "*")
            res.json({
                key,
                url,
                method: 'PUT',
            })
            res.end()
        }, next)
    }

    app.get('/s3/params', async (req, res, next) => {
        return await signOnServer(req, res, next)
    })
    app.post('/s3/sign', async (req, res, next) => {
        return await signOnServer(req, res, next)
    })

    //  === <S3 Multipart> ===
    // You can remove those endpoints if you only want to support the non-multipart uploads.

    app.post('/s3/multipart', async (req, res, next) => {

        const apikey: any = req.headers['exulu-api-key'] || null;
        const { db } = await postgresClient();

        let authtoken: any = null;
        if (typeof apikey !== "string") { // default to next auth tokens to authenticate
            authtoken = await getToken(req.headers.authorization ?? "")
        }
        const authenticationResult = await authentication({
            authtoken,
            apikey,
            db: db
        })

        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        const client = getS3Client(config);
        const { type, metadata, filename } = req.body
        if (typeof filename !== 'string') {
            return res
                .status(400)
                .json({ error: 's3: content filename must be a string' })
        }
        if (typeof type !== 'string') {
            return res.status(400).json({ error: 's3: content type must be a string' })
        }
        const key = `${randomUUID()}-_EXULU_${filename}`

        let folder = "";
        if (authenticationResult.user.type === "api") {
            folder = `api/`
        } else {
            folder = `${authenticationResult.user.id}/`
        }

        const fullKey = addPrefixToKey(folder + key, config);

        const params = {
            Bucket: config.fileUploads.s3Bucket,
            Key: fullKey,
            ContentType: type,
            Metadata: metadata,
        }

        const command = new CreateMultipartUploadCommand(params)

        return client.send(command, (err, data) => {
            if (err) {
                next(err)
                return
            }
            res.setHeader('Access-Control-Allow-Origin', "*")
            res.json({
                key,
                uploadId: data?.UploadId,
            })
        })
    })

    function validatePartNumber(partNumber) {
        // eslint-disable-next-line no-param-reassign
        partNumber = Number(partNumber)
        return Number.isInteger(partNumber) && partNumber >= 1 && partNumber <= 10_000
    }

    app.get('/s3/multipart/:uploadId/:partNumber', (req, res, next) => {
        const { uploadId, partNumber } = req.params
        const { key } = req.query

        if (!validatePartNumber(partNumber)) {
            return res.status(400).json({ error: 's3: the part number must be an integer between 1 and 10000.' })
        }
        if (typeof key !== 'string') {
            return res.status(400).json({ error: 's3: the object key must be passed as a query parameter. For example: "?key=abc.jpg"' })
        }

        return getSignedUrl(getS3Client(config), new UploadPartCommand({
            Bucket: config.fileUploads.s3Bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: Number(partNumber),
            Body: '',
        }), { expiresIn }).then((url) => {
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.json({ url, expires: expiresIn })
        }, next)
    })

    app.get('/s3/multipart/:uploadId', (req, res, next) => {
        const client = getS3Client(config);
        const { uploadId } = req.params
        const { key } = req.query

        if (typeof key !== 'string') {
            res.status(400).json({ error: 's3: the object key must be passed as a query parameter. For example: "?key=abc.jpg"' })
            return
        }

        const parts = []

        function listPartsPage(startAt) {
            client.send(new ListPartsCommand({
                Bucket: config.fileUploads.s3Bucket,
                Key: key as string,
                UploadId: uploadId,
                PartNumberMarker: startAt,
            }), (err, data) => {
                if (err) {
                    next(err)
                    return
                }

                // @ts-ignore
                parts.push(...data.Parts)

                if (data?.IsTruncated) {
                    // Get the next page.
                    listPartsPage(data.NextPartNumberMarker)
                } else {
                    res.json(parts)
                }
            })
        }
        listPartsPage(0)
    })

    function isValidPart(part) {
        return part && typeof part === 'object' && Number(part.PartNumber) && typeof part.ETag === 'string'
    }
    app.post('/s3/multipart/:uploadId/complete', (req, res, next) => {
        const client = getS3Client(config);
        const { uploadId } = req.params
        const { key } = req.query
        const { parts } = req.body

        if (typeof key !== 'string') {
            return res.status(400).json({ error: 's3: the object key must be passed as a query parameter. For example: "?key=abc.jpg"' })
        }

        if (!Array.isArray(parts) || !parts.every(isValidPart)) {
            return res.status(400).json({ error: 's3: `parts` must be an array of {ETag, PartNumber} objects.' })
        }

        return client.send(new CompleteMultipartUploadCommand({
            Bucket: config.fileUploads.s3Bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
                Parts: parts,
            },
        }), (err, data) => {
            if (err) {
                next(err)
                return
            }
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.json({
                key,
                location: data?.Location,
            })
        })
    })

    app.delete('/s3/multipart/:uploadId', (req, res, next) => {
        const client = getS3Client(config);
        const { uploadId } = req.params
        const { key } = req.query

        if (typeof key !== 'string') {
            return res.status(400).json({ error: 's3: the object key must be passed as a query parameter. For example: "?key=abc.jpg"' })
        }

        return client.send(new AbortMultipartUploadCommand({
            Bucket: config.fileUploads.s3Bucket,
            Key: key,
            UploadId: uploadId,
        }), (err) => {
            if (err) {
                next(err)
                return
            }
            res.json({
                key,
            })
        })
    })

    return app;
}
