import { getPresignedUrl as getPresignedUrlUppy, uploadFile as uploadFileUppy } from "../uppy";
import type { ExuluConfig } from "./app";

export class ExuluStorage {
  private config: ExuluConfig;
  constructor({ config }: { config: ExuluConfig }) {
    this.config = config;
  }

  public getPresignedUrl = async (key: string) => {
    // original key
    const originalKey = key;
    const bucket = key.split("/")[0];
    if (!bucket || typeof bucket !== "string" || bucket.trim() === "") {
      console.error("Invalid S3 key, must be in the format of <bucket>/<key> but got: " + originalKey, new Error().stack);
      throw new Error("Invalid S3 key, must be in the format of <bucket>/<key> but got: " + originalKey);
    }
    key = key.split("/").slice(1).join("/");
    if (!key || typeof key !== "string" || key.trim() === "") {
      console.error("Invalid S3 key, must be in the format of <bucket>/<key> but got: " + originalKey, new Error().stack);
      throw new Error("Invalid S3 key, must be in the format of <bucket>/<key> but got: " + originalKey);
    }
    return await getPresignedUrlUppy(bucket, key, this.config);
  };

  public uploadFile = async (
    file: Buffer | Uint8Array,
    fileName: string,
    type: string,
    user?: number,
    metadata?: Record<string, string>,
    customBucket?: string,
  ) => {
    return await uploadFileUppy(
      file,
      fileName,
      this.config,
      {
        contentType: type,
        metadata: {
          ...metadata,
          type: type,
        },
      },
      user,
      customBucket,
    );
  };
  // todo add upload and delete methods
}
