import type { ExuluConfig } from "@SRC/exulu/app";
import type { allFileTypes } from "@EXULU_TYPES/models/agent";
import { uploadFile } from "@SRC/uppy";
import { sanitizeFilename, sessionFilePrefix } from "./session-files";
import { MAX_ADOPT_UPLOAD_BYTES } from "./session-file-adopt";
import { treatAsGuest } from "./public-surface";

export const getMimeType = (type: allFileTypes) => {
  switch (type) {
    case ".png":
      return "image/png";
    case ".jpg":
      return "image/jpg";
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".csv":
      return "text/csv";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".ppt":
      return "application/vnd.ms-powerpoint";
    case ".m4a":
      return "audio/mp4";
    case ".mp4":
      return "audio/mp4";
    case ".mpeg":
      return "audio/mpeg";
    case ".mp3":
      return "audio/mp3";
    case ".wav":
      return "audio/wav";
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".json":
      return "application/json";
    default:
      return "";
  }
};

/** Extension → mime type; `application/octet-stream` when unknown. */
export function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = name.slice(dot).toLowerCase() as allFileTypes;
  return getMimeType(ext) || "application/octet-stream";
}

export type SessionFileInput = { name: string; data: Uint8Array | Buffer };
export type SessionFileResult = { name: string } | { error: string };
export type SaveSessionFile = (file: SessionFileInput) => Promise<SessionFileResult>;

export const SAVE_INVALID_NAME = "Invalid filename (no path separators, no '..').";
export const SAVE_EMPTY = "The file is empty.";
export const SAVE_TOO_LARGE = "It is larger than 50 MB.";
export const SAVE_FAILED = "Saving the file failed.";

/** `put` receives the key WITHOUT the general s3 prefix. */
export async function writeSessionFile(args: {
  ownerId: number | string;
  sessionId: string;
  file: SessionFileInput;
  put: (key: string, data: Uint8Array | Buffer, contentType: string) => Promise<void>;
}): Promise<SessionFileResult> {
  const name = sanitizeFilename(args.file.name);
  if (!name) return { error: SAVE_INVALID_NAME };
  if (args.file.data.length === 0) return { error: SAVE_EMPTY };
  if (args.file.data.length > MAX_ADOPT_UPLOAD_BYTES) return { error: SAVE_TOO_LARGE };
  const key = sessionFilePrefix(args.ownerId, args.sessionId, undefined) + name;
  try {
    await args.put(key, args.file.data, contentTypeFor(name));
  } catch (err) {
    console.error("[EXULU] saveSessionFile failed", err);
    return { error: SAVE_FAILED };
  }
  return { name };
}

/**
 * The `saveSessionFile` helper handed to app tools, or undefined when there is no session,
 * uploads are not configured, nobody is signed in (or the request is public-surface), or
 * the turn is part of a routine run.
 */
export function buildSaveSessionFile(args: {
  sessionID?: string;
  ownerId?: number | string;
  user?: { id?: unknown };
  req?: { headers?: Record<string, unknown> };
  exuluConfig?: ExuluConfig;
  inRoutineRun: boolean;
}): SaveSessionFile | undefined {
  const { sessionID, exuluConfig } = args;
  const uploads = exuluConfig?.fileUploads;
  if (!sessionID || !exuluConfig) return undefined;
  if (!uploads?.s3endpoint || !uploads.s3key || !uploads.s3secret || !uploads.s3Bucket) {
    return undefined;
  }
  if (args.inRoutineRun || treatAsGuest(args.req, args.user)) return undefined;
  const ownerId = args.ownerId ?? (args.user?.id as number | string);
  return (file) =>
    writeSessionFile({
      ownerId,
      sessionId: sessionID,
      file,
      put: async (key, data, contentType) => {
        await uploadFile(data, key, exuluConfig, { contentType }, undefined, undefined, true);
      },
    });
}
