import { postgresClient } from "@SRC/postgres/client";
import { uploadFile } from "@SRC/uppy";
import { exuluApp } from "./app/singleton";
import { createProjectForUser, SKIP_PROJECT_FULL, SKIP_TOO_LARGE } from "./project-create";
import { MAX_PROJECT_FILES, projectFilePrefix } from "./project-files";
import { createPromoteS3 } from "./project-files-s3";
import { MAX_ADOPT_UPLOAD_BYTES } from "./session-file-adopt";
import { contentTypeFor, SAVE_EMPTY, SAVE_FAILED, SAVE_INVALID_NAME } from "./session-file-write";
import { sanitizeFilename } from "./session-files";

export const FILE_EXISTS = "A file with this name is already in the project.";
export const PROJECT_NOT_FOUND = "Project not found.";
export const OWNER_NOT_FOUND = "No user with this id.";
export const UPLOADS_NOT_CONFIGURED = "File uploads are not configured.";

export type AddFileResult = { name: string; skipped?: true } | { error: string };

/** Create a private project owned by `ownerId`. Throws on invalid input. */
export async function createProjectCore(
  db: any,
  input: { name: string; description?: string; ownerId: number | string },
): Promise<{ id: string }> {
  const owner = await db.from("users").where({ id: input.ownerId }).first();
  if (!owner) throw new Error(OWNER_NOT_FOUND);
  const { id } = await createProjectForUser(db, { id: input.ownerId }, { name: input.name, description: input.description });
  return { id };
}

/** Add one file to a project. Per-file problems are returned as `{ error }`, never thrown. */
export async function addProjectFileCore(args: {
  db: any;
  projectId: string;
  name: string;
  data: Uint8Array | Buffer;
  ifExists?: "error" | "skip";
  s3prefix?: string | null;
  listProjectNames: (projectPrefix: string) => Promise<string[]>;
  put: (key: string, data: Uint8Array | Buffer, contentType: string) => Promise<void>;
}): Promise<AddFileResult> {
  const project = await args.db.from("projects").where({ id: args.projectId }).first();
  if (!project) return { error: PROJECT_NOT_FOUND };
  const name = sanitizeFilename(args.name);
  if (!name) return { error: SAVE_INVALID_NAME };
  if (args.data.length === 0) return { error: SAVE_EMPTY };
  if (args.data.length > MAX_ADOPT_UPLOAD_BYTES) return { error: SKIP_TOO_LARGE };

  const { projectPrefix } = projectFilePrefix(args.projectId, args.s3prefix);
  const existing = await args.listProjectNames(projectPrefix);
  if (existing.includes(name)) {
    return args.ifExists === "skip" ? { name, skipped: true } : { error: FILE_EXISTS };
  }
  if (existing.length >= MAX_PROJECT_FILES) return { error: SKIP_PROJECT_FULL };

  try {
    await args.put(projectPrefix + name, args.data, contentTypeFor(name));
  } catch (err) {
    console.error("[EXULU] ExuluProjects.addFile failed", err);
    return { error: SAVE_FAILED };
  }
  return { name };
}

/**
 * For trusted server-side code (scripts, migrations). There is no user context: never call
 * this from a tool on behalf of a user.
 */
export const ExuluProjects = {
  async create(input: { name: string; description?: string; ownerId: number | string }): Promise<{ id: string }> {
    const { db } = await postgresClient();
    return createProjectCore(db, input);
  },

  async addFile(input: {
    projectId: string;
    name: string;
    data: Uint8Array | Buffer;
    ifExists?: "error" | "skip";
  }): Promise<AddFileResult> {
    const config = exuluApp.get().config;
    const uploads = config?.fileUploads;
    if (!uploads?.s3endpoint || !uploads.s3key || !uploads.s3secret || !uploads.s3Bucket) {
      return { error: UPLOADS_NOT_CONFIGURED };
    }
    const { db } = await postgresClient();
    return addProjectFileCore({
      db,
      ...input,
      s3prefix: uploads.s3prefix,
      listProjectNames: createPromoteS3(config).listProjectNames,
      put: async (key, data, contentType) => {
        await uploadFile(data, key, config, { contentType }, undefined, undefined, true);
      },
    });
  },
};
