import express, { type Express, type Request, type Response } from "express";
import { exuluApp } from "../app/singleton.ts";
import { requestValidators } from "../../validators/requests.ts";
import { checkRecordAccess } from "../../utils/check-record-access.ts";
import { isHermesEnabled } from "./config";
import { profileIdFor } from "./provisioner";
import {
  deleteWorkspaceFile,
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "./workspace-store";

/**
 * HTTP API for an advanced-mode agent's workspace files, local-direct (served
 * straight from the host bind-mount dir). Deliberately mirrors the non-advanced
 * `/sessions/:id/files*` contract so the same frontend file UI works for both —
 * the only difference is the store behind it and that downloads stream from us
 * rather than from an S3 presigned URL.
 *
 *   GET    /agents/:agentId/workspace-files            list
 *   GET    /agents/:agentId/workspace-files/raw?path=  download/preview (stream)
 *   PUT    /agents/:agentId/workspace-files/raw?path=  upload (raw body)
 *   DELETE /agents/:agentId/workspace-files?path=      delete
 *
 * RBAC: the agent's existing access control (read to list/download, write to
 * upload/delete). The workspace is per-profile (shared/private per scope), so
 * access is by agent — not the per-user prefix the session-files API uses.
 *
 * Design doc: docs/superpowers/specs/2026-06-04-advanced-mode-workspace-files-design.md
 */

const log = (line: string) => console.log(`[EXULU-HERMES-FILES] ${line}`);

/**
 * Resolve agent + caller, enforce RBAC, return the profileId — or send an error
 * and return null. `allowQueryToken` lets `<img>/<iframe>`/PUT requests carry the
 * bearer token as `?auth=` (no Authorization header available there).
 */
const authorize = async (
  req: Request,
  res: Response,
  access: "read" | "write",
  allowQueryToken = false,
): Promise<string | null> => {
  if (allowQueryToken && !req.headers.authorization && req.query.auth) {
    req.headers.authorization = `Bearer ${req.query.auth as string}`;
  }
  const agentId = req.params.agentId;
  if (!agentId) {
    res.status(400).json({ message: "Missing agent id" });
    return null;
  }
  const agent = await exuluApp.get().agent(agentId);
  if (!agent) {
    res.status(404).json({ message: "Agent not found" });
    return null;
  }
  const authn = await requestValidators.authenticate(req);
  const user = authn.user;
  if (!user?.id && agent.rights_mode !== "public") {
    res.status(authn.code || 401).json({ message: authn.message });
    return null;
  }
  if (!(await checkRecordAccess(agent, access, user))) {
    res.status(403).json({ message: "You don't have access to this agent." });
    return null;
  }
  const scope =
    (agent as any).advanced_agent_profile_scope === "private"
      ? "private"
      : "shared";
  try {
    return profileIdFor(agent.id, scope, user?.id);
  } catch (err) {
    res.status(400).json({ message: (err as Error).message });
    return null;
  }
};

const getPath = (req: Request): string | null => {
  const p = req.query.path;
  return typeof p === "string" && p.length > 0 ? p : null;
};

/** Mount the workspace-files routes. No-op unless ENABLE_HERMES_AGENT is set. */
export const registerWorkspaceFilesRoutes = (app: Express): void => {
  if (!isHermesEnabled()) return;

  app.get("/agents/:agentId/workspace-files", async (req, res) => {
    const profileId = await authorize(req, res, "read");
    if (!profileId) return;
    res.status(200).json({ files: await listWorkspaceFiles(profileId) });
  });

  app.get("/agents/:agentId/workspace-files/raw", async (req, res) => {
    const profileId = await authorize(req, res, "read", true);
    if (!profileId) return;
    const path = getPath(req);
    if (!path) {
      res.status(400).json({ message: "Missing ?path" });
      return;
    }
    const file = await readWorkspaceFile(profileId, path);
    if (!file) {
      res.status(404).json({ message: "File not found" });
      return;
    }
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Length", String(file.size));
    file.stream.on("error", () => {
      if (!res.headersSent) res.status(500).end();
    });
    file.stream.pipe(res);
  });

  app.put(
    "/agents/:agentId/workspace-files/raw",
    express.raw({ type: () => true, limit: "100mb" }),
    async (req, res) => {
      const profileId = await authorize(req, res, "write", true);
      if (!profileId) return;
      const path = getPath(req);
      if (!path) {
        res.status(400).json({ message: "Missing ?path" });
        return;
      }
      const body = req.body;
      if (!Buffer.isBuffer(body)) {
        res.status(400).json({ message: "Expected a binary request body" });
        return;
      }
      try {
        await writeWorkspaceFile(profileId, path, body);
        res.status(200).json({ written: true, path });
      } catch (err) {
        res.status(400).json({ message: (err as Error).message });
      }
    },
  );

  app.delete("/agents/:agentId/workspace-files", async (req, res) => {
    const profileId = await authorize(req, res, "write");
    if (!profileId) return;
    const path = getPath(req);
    if (!path) {
      res.status(400).json({ message: "Missing ?path" });
      return;
    }
    try {
      await deleteWorkspaceFile(profileId, path);
      res.status(200).json({ deleted: true });
    } catch (err) {
      res.status(400).json({ message: (err as Error).message });
    }
  });

  log("Workspace files routes mounted at /agents/:agentId/workspace-files");
};
