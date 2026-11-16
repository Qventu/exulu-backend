/**
 * HTTP routes for a project's shared file folder. Built from injected deps so the
 * contract (auth, prefix checks, caps) is unit-testable (project-file-routes.test.ts);
 * routes.ts wires the real ones. Project files are served ONLY through these routes.
 */
import type { Express, Request, Response } from "express";

import type { ProjectRight } from "./project-access.ts";
import { decideUploadSign, listFilesWithOrigin } from "./project-file-handlers.ts";
import { projectFilePrefix } from "./project-files.ts";
import { promoteSessionFiles, type PromoteS3 } from "./project-files-promote.ts";
import { sanitizeFilename } from "./session-files.ts";
import type { FileOrigin } from "./file-origin.ts";

type Obj = { key: string; size: number; lastModified: Date };

export type ProjectFileRouteDeps = {
  s3prefix?: string | null;
  loadAuthedProject: (
    req: Request,
    res: Response,
    projectId: string,
    want: ProjectRight,
  ) => Promise<{ user: any; project: any } | null>;
  /** The caller's write right, so the listing can tell the UI whether to show controls. */
  canWrite: (user: any, project: any) => Promise<boolean>;
  loadAuthedSession: (
    req: Request,
    res: Response,
    sessionId: string,
    rights: "read" | "write",
  ) => Promise<{ user: any; session: any } | null>;
  buildSessionPrefixes: (userId: number | string, sessionId: string) => { fullSessionPrefix: string };
  s3: PromoteS3 & {
    list: (prefix: string) => Promise<Obj[]>;
    presign: (key: string) => Promise<string>;
    signUpload: (key: string, contentType: string) => Promise<string>;
    remove: (key: string) => Promise<void>;
    etag: (key: string) => Promise<string | undefined | null>;
  };
  resolveOrigin: (f: { key: string; lastModified: Date }) => Promise<FileOrigin>;
  inferContentType: (name: string) => string;
  previewPdf: (key: string, etag: string) => Promise<Buffer | Uint8Array>;
  /** True when the error is the renderer's own (its message is safe to show). */
  isPreviewError: (err: unknown) => boolean;
};

/** Key must sit under the prefix, with no traversal segment. */
function isInside(key: string, fullPrefix: string): boolean {
  return key.startsWith(fullPrefix) && !key.includes("..");
}

export function registerProjectFileRoutes(app: Express, deps: ProjectFileRouteDeps) {
  const idOf = (req: Request) => String(req.params.projectId ?? "");
  const listObjects = async (projectId: string) =>
    (await deps.s3.list(projectFilePrefix(projectId, deps.s3prefix).projectPrefix)).filter(
      (o) => !o.key.endsWith("/"),
    );

  app.get("/projects/:projectId/files", async (req: Request, res: Response) => {
    const projectId = idOf(req);
    const authed = await deps.loadAuthedProject(req, res, projectId, "read");
    if (!authed) return;
    const canWrite = await deps.canWrite(authed.user, authed.project);
    let objects: Obj[];
    try {
      objects = await listObjects(projectId);
    } catch (err) {
      console.error("[PROJECT-FILES] list failed", err);
      res.status(500).json({ detail: "Failed to list project files." });
      return;
    }
    const files = await listFilesWithOrigin({
      objects,
      presign: deps.s3.presign,
      resolveOrigin: deps.resolveOrigin,
      inferContentType: deps.inferContentType,
    });
    res.json({ canWrite, files });
  });

  app.post("/projects/:projectId/files/upload-sign", async (req: Request, res: Response) => {
    const projectId = idOf(req);
    const authed = await deps.loadAuthedProject(req, res, projectId, "write");
    if (!authed) return;
    const { filename, contentType, overwrite } = req.body ?? {};
    if (!filename || typeof filename !== "string") {
      res.status(400).json({ detail: "Missing filename in request body." });
      return;
    }
    const safeName = sanitizeFilename(filename);
    if (!safeName) {
      res.status(400).json({ detail: "Invalid filename (no path separators, no '..')." });
      return;
    }
    if (!contentType || typeof contentType !== "string") {
      res.status(400).json({ detail: "Missing contentType in request body." });
      return;
    }
    try {
      const objects = await listObjects(projectId);
      const decision = decideUploadSign({
        name: safeName,
        overwrite: overwrite === true,
        existing: objects.map((o) => ({
          name: o.key.split("/").pop() ?? o.key,
          lastModified: o.lastModified,
        })),
      });
      if (!decision.ok) {
        res.status(decision.status).json(decision.body);
        return;
      }
      const { fullProjectPrefix } = projectFilePrefix(projectId, deps.s3prefix);
      const key = `${fullProjectPrefix}${safeName}`;
      res.json({ uploadUrl: await deps.s3.signUpload(key, contentType), key });
    } catch (err) {
      console.error("[PROJECT-FILES] upload-sign failed", err);
      res.status(500).json({ detail: "Failed to sign the upload." });
    }
  });

  app.delete("/projects/:projectId/files", async (req: Request, res: Response) => {
    const projectId = idOf(req);
    const key = req.query.key;
    if (!key || typeof key !== "string") {
      res.status(400).json({ detail: "Missing or invalid 'key' query parameter." });
      return;
    }
    const authed = await deps.loadAuthedProject(req, res, projectId, "write");
    if (!authed) return;
    const { fullProjectPrefix } = projectFilePrefix(projectId, deps.s3prefix);
    if (!isInside(key, fullProjectPrefix)) {
      res.status(403).json({ detail: "Key does not belong to this project." });
      return;
    }
    try {
      await deps.s3.remove(key);
      res.json({ deleted: true });
    } catch (err) {
      console.error("[PROJECT-FILES] delete failed", err);
      res.status(500).json({ detail: "Failed to delete project file." });
    }
  });

  app.get("/projects/:projectId/file/preview-pdf", async (req: Request, res: Response) => {
    // <iframe src=...> cannot set Authorization; same ?auth= fallback as the session route.
    if (!req.headers.authorization && typeof req.query.auth === "string") {
      req.headers.authorization = `Bearer ${req.query.auth}`;
    }
    const projectId = idOf(req);
    const key = req.query.key;
    if (!key || typeof key !== "string") {
      res.status(400).json({ detail: "Missing or invalid 'key' query parameter." });
      return;
    }
    const authed = await deps.loadAuthedProject(req, res, projectId, "read");
    if (!authed) return;
    const { fullProjectPrefix } = projectFilePrefix(projectId, deps.s3prefix);
    if (!isInside(key, fullProjectPrefix)) {
      res.status(403).json({ detail: "Key does not belong to this project." });
      return;
    }
    const etag = await deps.s3.etag(key);
    if (!etag) {
      res.status(404).json({ detail: "Source file not found in S3." });
      return;
    }
    try {
      const bytes = await deps.previewPdf(key, etag);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Cache-Control", "private, max-age=300");
      res.send(bytes);
    } catch (err: any) {
      console.error("[PROJECT-FILES] preview failed", err);
      res
        .status(500)
        .json({ detail: deps.isPreviewError(err) ? err.message : "Failed to render preview." });
    }
  });

  app.post("/projects/:projectId/files/promote", async (req: Request, res: Response) => {
    const projectId = idOf(req);
    const { sessionId, keys, overwrite } = req.body ?? {};
    if (typeof sessionId !== "string" || !sessionId || !Array.isArray(keys)) {
      res.status(400).json({ detail: "sessionId (string) and keys (array) are required." });
      return;
    }
    const authed = await deps.loadAuthedProject(req, res, projectId, "write");
    if (!authed) return;
    const sessionAuthed = await deps.loadAuthedSession(req, res, sessionId, "write");
    if (!sessionAuthed) return;
    // Files sit under the session OWNER's prefix, like the session-file routes.
    const ownerId = sessionAuthed.session.user ?? sessionAuthed.user.id;
    const { fullSessionPrefix } = deps.buildSessionPrefixes(ownerId, sessionId);

    try {
      const result = await promoteSessionFiles({
        projectId,
        s3prefix: deps.s3prefix,
        keys,
        fullSessionPrefix,
        overwrite: overwrite === true,
        s3: deps.s3,
      });
      // Nothing was copied on a clash; the client confirms with the user and retries
      // with overwrite.
      res.status(result.clashes.length > 0 ? 409 : 200).json(result);
    } catch (err) {
      console.error("[PROJECT-FILES] promote failed", err);
      res.status(500).json({ detail: "Failed to copy files into the project." });
    }
  });
}

/**
 * File uploads are not configured: answer like the session-file routes do in that case
 * (500 + detail) instead of Express's anonymous 404, so the UI and operators see why.
 */
export function registerProjectFileRoutesUnconfigured(app: Express) {
  const handler = (_req: Request, res: Response) => {
    res.status(500).json({ detail: "File uploads are not configured." });
  };
  app.get("/projects/:projectId/files", handler);
  app.post("/projects/:projectId/files/upload-sign", handler);
  app.delete("/projects/:projectId/files", handler);
  app.get("/projects/:projectId/file/preview-pdf", handler);
  app.post("/projects/:projectId/files/promote", handler);
}
