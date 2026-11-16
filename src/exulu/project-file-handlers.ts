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

/** At most this many files are presigned and HEADed at once while listing. */
const LIST_CONCURRENCY = 10;

/** `fn` over `items`, at most `limit` at a time, results in input order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * One listing for session and project files, so both carry `origin` the same way.
 * Each file costs a HEAD (origin) and a presign; a folder can hold hundreds, so
 * they run LIST_CONCURRENCY at a time instead of all at once.
 * A failing origin lookup must never fail the listing: the resolver already maps
 * errors to "user", the catch here is a second belt for a resolver that throws.
 */
export async function listFilesWithOrigin(args: {
  objects: S3Listed[];
  presign: (key: string) => Promise<string>;
  resolveOrigin: (file: { key: string; lastModified: Date }) => Promise<FileOrigin>;
  inferContentType: (name: string) => string;
}): Promise<ListedFile[]> {
  const files = await mapWithConcurrency(
    // Skip the directory marker (key ending with /).
    args.objects.filter((obj) => !obj.key.endsWith("/")),
    LIST_CONCURRENCY,
    async (obj) => {
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
    },
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * Callers build S3 prefixes from the returned row's id, never from `projectId`:
 * Postgres matches a uuid case-insensitively, so the URL spelling can differ.
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
    // The id goes into a uuid cast; anything else would throw there (a 500), so it
    // is simply not a project.
    if (!UUID_RE.test(projectId)) {
      res.status(404).json({ detail: `Project ${projectId} not found.` });
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
