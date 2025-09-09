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
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
    STSClient,
    GetFederationTokenCommand,
} from '@aws-sdk/client-sts';
import { randomUUID } from 'node:crypto';

export const createUppyRoutes = async (
    app: Express,
    config: ExuluConfig
) => {


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
     * @type {S3Client}
     */
    let s3Client

    /**
     * @type {STSClient}
     */
    let stsClient

    const expiresIn = 60 * 60 * 24 * 1 // S3 signature expires within 1 day.

    function getS3Client() {
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

    app.get('/s3/list', async (req, res, next) => {
        req.accepts
        const apikey: any = req.headers['exulu-api-key'] || null;
        
        let authtoken: any = null;
        if (typeof apikey !== "string") { // default to next auth tokens to authenticate
            authtoken = await getToken(req.headers.authorization ?? "")
        }

        const { db } = await postgresClient()
        const authenticationResult = await authentication({
            authtoken,
            apikey,
            db: db
        })

        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        const { prefix = '' } = req.query;

        if (typeof prefix !== 'string') {
            res.status(400).json({ error: 'Invalid prefix parameter. Must be a string.' });
            return;
        }

        // If not an API user, ensure they can only list their own files
        if (authenticationResult.user.type !== "api" && !prefix.includes(authenticationResult.user.id)) {
            res.status(405).json({ error: 'Not allowed to list files in this folder based on authenticated user.' });
            return;
        }

        try {
            const command = new ListObjectsV2Command({
                Bucket: config.fileUploads.s3Bucket,
                Prefix: prefix,
                MaxKeys: 1000, // Adjust this value based on your needs
            });

            const data = await getS3Client().send(command);

            const files = data.Contents?.map(item => ({
                key: item.Key,
                size: item.Size,
                lastModified: item.LastModified,
            })) || [];

            res.setHeader('Access-Control-Allow-Origin', '*');
            res.status(200).json({
                files,
                isTruncated: data.IsTruncated,
                nextContinuationToken: data.NextContinuationToken
            });
        } catch (err) {
            next(err);
        }
    });

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

        // If access key is an api user we allow access to all folders. If not, we limit
        // to the user's own upload folders.
        if (authenticationResult.user.type !== "api" && !key.includes(authenticationResult.user.id)) {
            res.status(405).json({ error: 'Not allowed to access the files in the folder based on authenticated user.' });
            return;
        }

        try {
            const url = await getSignedUrl(
                getS3Client(),
                new GetObjectCommand({
                    Bucket: config.fileUploads.s3Bucket,
                    Key: key,
                }),
                { expiresIn }
            );

            res.setHeader('Access-Control-Allow-Origin', '*');
            res.json({ url, method: 'GET', expiresIn });
        } catch (err) {
            next(err);
        }
    });

    // todo add api to list a user's files, with option to filter by type
    // so we can show them in a galery popup for file inputs.


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

    const generateS3Key = (filename) => `${randomUUID()}-${filename}`

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

        let folder = "";
        if (authenticationResult.user.type === "api") {
            folder = `api/`
        } else {
            folder = `${authenticationResult.user.id}/`
        }

        getSignedUrl(
            getS3Client(),
            new PutObjectCommand({
                Bucket: config.fileUploads.s3Bucket,
                Key: folder + key,
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

        const client = getS3Client()
        const { type, metadata, filename } = req.body
        if (typeof filename !== 'string') {
            return res
                .status(400)
                .json({ error: 's3: content filename must be a string' })
        }
        if (typeof type !== 'string') {
            return res.status(400).json({ error: 's3: content type must be a string' })
        }
        const key = `${randomUUID()}-${filename}`

        let folder = "";
        if (authenticationResult.user.type === "api") {
            folder = `api/`
        } else {
            folder = `${authenticationResult.user.id}/`
        }

        const params = {
            Bucket: config.fileUploads.s3Bucket,
            Key: folder + key,
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
                uploadId: data.UploadId,
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

        return getSignedUrl(getS3Client(), new UploadPartCommand({
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
        const client = getS3Client()
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

                if (data.IsTruncated) {
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
        const client = getS3Client()
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
                location: data.Location,
            })
        })
    })

    app.delete('/s3/multipart/:uploadId', (req, res, next) => {
        const client = getS3Client()
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
