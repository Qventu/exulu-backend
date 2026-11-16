import type { Request, Response } from "express";

import { hasProjectAccess, type ProjectRight } from "./project-access.ts";
import { MAX_PROJECT_FILES } from "./project-files.ts";
import type { FileOrigin } from "./file-origin.ts";

type S3Listed = { key: string; size: number; lastModified: Date };

export type ListedFile = {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  contentType: string;
  presignedUrl: string;
  origin: FileOrigin;
};

/**
 * One listing for session and project files, so both carry `origin` the same way.
 * A failing origin lookup must never fail the listing: the resolver already maps
 * errors to "user", the catch here is a second belt for a resolver that throws.
 */
export async function listFilesWithOrigin(args: {
  objects: S3Listed[];
  presign: (key: string) => Promise<string>;
  resolveOrigin: (file: { key: string; lastModified: Date }) => Promise<FileOrigin>;
  inferContentType: (name: string) => string;
}): Promise<ListedFile[]> {
  const files = await Promise.all(
    args.objects
      // Skip the directory marker (key ending with /).
      .filter((obj) => !obj.key.endsWith("/"))
      .map(async (obj) => {
        const name = obj.key.split("/").pop() ?? obj.key;
        const [presignedUrl, origin] = await Promise.all([
          args.presign(obj.key),
          args.resolveOrigin(obj).catch((): FileOrigin => "user"),
        ]);
        return {
          key: obj.key,
          name,
          size: obj.size,
          lastModified: obj.lastModified.toISOString(),
          contentType: args.inferContentType(name),
          presignedUrl,
          origin,
        };
      }),
  );
  // Most-recent first.
  files.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  return files;
}

export type UploadSignDecision =
  | { ok: true }
  | { ok: false; status: 409; body: { error: "exists"; lastModified: string } }
  | { ok: false; status: 400; body: { error: "project_full"; max: number } };

/** Decide whether `name` may be signed for upload into a folder holding `existing`. */
export function decideUploadSign(args: {
  name: string;
  overwrite: boolean;
  existing: { name: string; lastModified: Date }[];
}): UploadSignDecision {
  const hit = args.existing.find((f) => f.name === args.name);
  if (hit && !args.overwrite) {
    return { ok: false, status: 409, body: { error: "exists", lastModified: hit.lastModified.toISOString() } };
  }
  if (!hit && args.existing.length >= MAX_PROJECT_FILES) {
    return { ok: false, status: 400, body: { error: "project_full", max: MAX_PROJECT_FILES } };
  }
  return { ok: true };
}

export type ProjectAuthDeps = {
  authenticate: (
    req: Request,
  ) => Promise<{ user?: any; code?: number; message?: string }>;
  getProject: (id: string) => Promise<any | undefined>;
  getRbac: (project: any) => Promise<{ type: string; users?: any[]; roles?: any[]; teams?: any[] }>;
};

/**
 * Auth for the project-file routes, mirroring loadAuthedSession: 401 / 404 / 403
 * are written to `res` and null is returned. Write implies read (hasProjectAccess).
 */
export function makeLoadAuthedProject(deps: ProjectAuthDeps) {
  return async (
    req: Request,
    res: Response,
    projectId: string,
    want: ProjectRight,
  ): Promise<{ user: any; project: any } | null> => {
    const authResult = await deps.authenticate(req);
    if (!authResult.user?.id) {
      res.status(authResult.code || 401).json({ detail: authResult.message });
      return null;
    }
    const project = await deps.getProject(projectId);
    if (!project) {
      res.status(404).json({ detail: `Project ${projectId} not found.` });
      return null;
    }
    const rbac = await deps.getRbac(project);
    if (!hasProjectAccess({ project, rbac, user: authResult.user, want })) {
      res.status(403).json({ detail: `You don't have ${want} access to this project.` });
      return null;
    }
    return { user: authResult.user, project };
  };
}
