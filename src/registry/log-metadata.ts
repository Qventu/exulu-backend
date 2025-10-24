/**
 * Create metadata for console logging that will be used by S3 transport
 * to group logs by ID and store them in S3 with the ID as prefix
 *
 * @param id - The ID to group logs by (e.g., job ID, request ID, etc.)
 * @param additionalMetadata - Any additional metadata to include with the log
 * @returns Metadata object to pass as the last argument to console methods
 *
 * @example
 * ```typescript
 * import { logMetadata } from './registry/log-metadata';
 *
 * const jobId = 'job-123';
 * console.log('Starting job', logMetadata(jobId));
 * console.log('Processing...', logMetadata(jobId, { step: 'validation' }));
 * console.error('Job failed', logMetadata(jobId, { error: 'timeout' }));
 * ```
 */
export function logMetadata(id: string, additionalMetadata?: Record<string, any>) {
    return {
        __logMetadata: true,
        id,
        ...additionalMetadata,
    };
}
