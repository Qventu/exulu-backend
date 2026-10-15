/**
 * GET /shared-artifacts/:name/access — the one HTTP endpoint the artifact
 * viewer-identity flow needs, kept out of routes.ts so its full contract
 * (status codes, the row-lookup/RBAC ordering) is unit-testable with supertest
 * and no Postgres.
 *
 * Built from injected deps so a test can control the authenticated user, the
 * row, and the RBAC decision without a real database — mirrors the
 * registrar pattern in transcription/chunk-route.ts and
 * transcription/export-route.ts. routes.ts wires the real dependencies.
 *
 * This module used to also serve PATCH /shared-artifacts/:name/viewer-identity,
 * by which a super-admin granted the capability per share row. That gate was
 * removed: `auth_mode: "regular"` is now the capability on its own, since the
 * artifact only renders for a logged-in user who passes RBAC on the row, so
 * handing that user their own identity grants nothing they did not already
 * have. The frontend's identity route carries the full reasoning.
 *
 * Design doc: docs/superpowers/specs/2026-10-08-artifact-viewer-identity-design.md §3, §5
 */
import type { Express, Request, Response } from "express";
import type { Knex } from "knex";

import type { User } from "@EXULU_TYPES/models/user";

import { getSharedArtifactByName, isExpired } from "./shared-artifacts";

export const SHARED_ARTIFACT_ACCESS_PATH = "/shared-artifacts/:name/access";

export type ViewerIdentityRouteDeps = {
  authenticate: (
    req: Request,
  ) => Promise<{ user?: User; error?: boolean; code?: number; message?: string }>;
  getDb: () => Promise<Knex>;
  RBACResolver: (
    db: any,
    entity: string,
    resourceId: string,
    rightsMode: string,
  ) => Promise<{ type: string; users: any[]; roles: any[]; teams: any[] }>;
  checkRecordAccess: (record: any, request: "read" | "write", user?: User) => Promise<boolean>;
};

export function registerViewerIdentityRoutes(app: Express, deps: ViewerIdentityRouteDeps): void {

  // Same RBAC decision as routes.ts's GET /shared-artifacts/:name/content,
  // without reading the object from S3. Exists so the frontend's identity
  // route can confirm access cheaply.
  //
  // This duplicates /content's regular-mode RBAC block deliberately:
  // extracting a shared helper would mean touching /content, which was out
  // of scope for this capability. If this block changes, check /content in
  // routes.ts too — the two must change together.
  app.get(SHARED_ARTIFACT_ACCESS_PATH, async (req: Request, res: Response) => {
    const db = await deps.getDb();
    const row = await getSharedArtifactByName(db, req.params.name ?? "");
    if (!row) {
      res.status(404).json({ detail: "Not found." });
      return;
    }
    if (isExpired(row.expires_at, new Date())) {
      res.status(410).json({ detail: "This link has expired." });
      return;
    }
    // public/password shares are gated upstream and never reach RBAC, so an
    // access check on them is a caller error rather than a yes-or-no answer.
    if (row.auth_mode !== "regular") {
      res.status(400).json({
        detail: "Access checks apply to regular-mode shares only.",
      });
      return;
    }
    const viewer = await deps.authenticate(req);
    if (!viewer.user?.id) {
      res.status(401).json({ detail: "Authentication required." });
      return;
    }
    const rbac = await deps.RBACResolver(
      db,
      "shared_artifact",
      row.id,
      row.rights_mode || "private",
    );
    const ok = await deps.checkRecordAccess({ ...row, RBAC: rbac }, "read", viewer.user);
    if (!ok) {
      res.status(403).json({ detail: "You don't have access to this artifact." });
      return;
    }
    res.status(204).end();
  });
}
