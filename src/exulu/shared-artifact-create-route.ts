/**
 * POST /shared-artifacts — create a share link. Kept out of routes.ts so its
 * contract (above all: a share may only point at an object the caller uploaded)
 * is testable with supertest and no Postgres; same registrar pattern as
 * viewer-identity-routes.ts. routes.ts wires the real dependencies.
 */
import type { Express, Request, Response } from "express";
import type { Knex } from "knex";

import type { User } from "@EXULU_TYPES/models/user";

import {
  getSharedArtifactByName,
  hashSharePassword,
  normalizeS3Key,
  ownsObjectKey,
  slugifyShareName,
  validateCreateInput,
} from "./shared-artifacts";

export type CreateShareRouteDeps = {
  authenticate: (
    req: Request,
  ) => Promise<{ user?: User; error?: boolean; code?: number; message?: string }>;
  getDb: () => Promise<Knex>;
  bucket: string;
  s3prefix?: string | null;
  handleRBACUpdate: (
    db: any,
    entity: string,
    resourceId: string,
    rbac: any,
    existing: any[],
  ) => Promise<void>;
};

export function registerCreateShareRoute(app: Express, deps: CreateShareRouteDeps): void {
  // Create a share link. Authed as the real user; RBAC scoping for regular mode.
  app.post("/shared-artifacts", async (req: Request, res: Response) => {
    const db = await deps.getDb();
    const auth = await deps.authenticate(req);
    if (!auth.user?.id) {
      res.status(401).json({ detail: "Authentication required." });
      return;
    }
    const now = new Date();
    const valid = validateCreateInput(req.body, now);
    if (!valid.ok) {
      res.status(400).json({ detail: valid.message });
      return;
    }
    const s3key = normalizeS3Key(req.body.s3key, deps.bucket);
    // The content route serves whatever the row points at, so the share is the
    // read capability: only the caller's own uploads may be shared (as the PATCH
    // route already enforces when a share is re-pointed). Without this, any user
    // could share — and so read — a project file or another user's file.
    if (!ownsObjectKey(s3key, auth.user, deps.s3prefix)) {
      res.status(403).json({ detail: "You can only share a file you uploaded yourself." });
      return;
    }
    const name = slugifyShareName(req.body.name);
    if (!name) {
      res.status(400).json({ detail: "name must contain url-safe characters." });
      return;
    }
    const existing = await getSharedArtifactByName(db, name);
    if (existing) {
      res.status(409).json({ detail: "That share name is already taken." });
      return;
    }
    const auth_mode = req.body.auth_mode as "public" | "password" | "regular";
    const password_hash =
      auth_mode === "password" ? await hashSharePassword(req.body.password) : null;
    // "public" is safe as a sentinel for non-regular rows because public/password
    // content requests are gated upstream by internal-key and never reach
    // checkRecordAccess; only regular rows go through RBAC evaluation.
    const rights_mode =
      auth_mode === "regular" ? (req.body.rights_mode ?? "private") : "public";

    const [row] = await db("shared_artifacts")
      .insert({
        name,
        s3key,
        auth_mode,
        password_hash,
        expires_at: req.body.expires_at ?? null,
        content_type: req.body.content_type ?? null,
        rights_mode,
        created_by: auth.user.id,
      })
      .returning("*");

    if (auth_mode === "regular" && req.body.rbac) {
      await deps.handleRBACUpdate(db, "shared_artifact", row.id, req.body.rbac, []);
    }
    res.status(201).json({ name: row.name });
  });
}
