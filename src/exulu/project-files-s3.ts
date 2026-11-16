import { createOriginResolver, type FileOrigin } from "./file-origin.ts";
import {
  copyS3Object,
  getS3ObjectMetadata,
  getS3ObjectSize,
  listS3ObjectsByPrefix,
} from "../uppy/index.ts";
import type { PromoteS3 } from "./project-files-promote.ts";
import type { ExuluConfig } from "./app/index.ts";

const resolvers = new WeakMap<object, ReturnType<typeof createOriginResolver>>();

/**
 * One memoised origin resolver per config, so the sidebar's 5-second poll costs a HEAD
 * per file only once (the cache key includes lastModified).
 */
export function getOriginResolver(config: ExuluConfig): (f: {
  key: string;
  lastModified: Date | string;
}) => Promise<FileOrigin> {
  let r = resolvers.get(config);
  if (!r) {
    r = createOriginResolver((key) => getS3ObjectMetadata(key, config));
    resolvers.set(config, r);
  }
  return r;
}

/** Real S3 operations for promoteSessionFiles. */
export function createPromoteS3(config: ExuluConfig): PromoteS3 {
  return {
    listProjectNames: async (projectPrefix) =>
      (await listS3ObjectsByPrefix(projectPrefix, config))
        .filter((o) => !o.key.endsWith("/"))
        .map((o) => o.key.split("/").pop() ?? o.key),
    sizeOf: (key) => getS3ObjectSize(key, config),
    copy: (src, dest) => copyS3Object(src, dest, config),
  };
}
