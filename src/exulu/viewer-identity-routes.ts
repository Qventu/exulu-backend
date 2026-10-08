/**
 * PATCH /shared-artifacts/:name/viewer-identity and
 * GET /shared-artifacts/:name/access — the viewer-identity capability's two
 * HTTP endpoints, moved out of routes.ts so the full HTTP contract (status
 * codes, JSON shapes, the authorization/row-lookup ordering) is
 * unit-testable with supertest and no Postgres.
 *
 * Built from injected deps so a test can control the authenticated user, the
 * row, and the RBAC decision without a real database — mirrors the
 * registrar pattern in transcription/chunk-route.ts and
 * transcription/export-route.ts. routes.ts wires the real dependencies.
 *
 * Design doc: docs/superpowers/specs/2026-10-08-artifact-viewer-identity-design.md §3, §5
 */
import type { Express, Request, Response } from "express";
import type { Knex } from "knex";

import type { User } from "@EXULU_TYPES/models/user";

import {
  authorizeIdentityGrant,
  getSharedArtifactByName,
  isExpired,
  parseIdentityGrantBody,
} from "./shared-artifacts";

export const VIEWER_IDENTITY_PATCH_PATH = "/shared-artifacts/:name/viewer-identity";
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
  // Grant or revoke the viewer-identity capability. Super-admin only (and
  // never an API user — see authorizeIdentityGrant); the create route rejects
  // the field outright. Authorization is checked before the row lookup so a
  // non-admin cannot probe which share names exist.
  app.patch(VIEWER_IDENTITY_PATCH_PATH, async (req: Request, res: Response) => {
    const auth = await deps.authenticate(req);
    const authz = authorizeIdentityGrant(auth.user);
    if (!authz.ok) {
      res.status(authz.code).json({ detail: authz.message });
      return;
    }
    const parsed = parseIdentityGrantBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ detail: parsed.message });
      return;
    }
    const db = await deps.getDb();
    const row = await getSharedArtifactByName(db, req.params.name ?? "");
    if (!row) {
      res.status(404).json({ detail: "Not found." });
      return;
    }
    // The capability only ever makes sense on a regular-mode share: a public
    // or password row is gated upstream and never reaches RBAC, so granting
    // on one would hand the credential to every visitor who can view it. The
    // backend owns the row and must not persist a combination whose only
    // safety lives in a Next.js route in another repo.
    if (row.auth_mode !== "regular") {
      res.status(409).json({
        detail: "Viewer identity can only be granted on a regular-mode share.",
      });
      return;
    }
    const grantedBy = parsed.value ? (auth.user?.id ?? null) : null;
    const grantedAt = parsed.value ? new Date() : null;
    const [updated] = await db("shared_artifacts")
      .where({ id: row.id })
      .update({
        grant_viewer_identity: parsed.value,
        identity_granted_by: grantedBy,
        identity_granted_at: grantedAt,
      })
      .returning("*");
    // A row deleted between the lookup above and this update — this response
    // is the administrator's only feedback, so a stale echo of the request
    // body would silently misreport success.
    if (!updated) {
      res.status(404).json({ detail: "Not found." });
      return;
    }
    res.status(200).json({
      name: updated.name,
      grant_viewer_identity: updated.grant_viewer_identity,
      // A regular share with rights_mode "public" passes checkRecordAccess for
      // every authenticated user, so granting on such a row means every
      // logged-in user who opens the artifact receives a credential. Echoing
      // both modes here is the administrator's only visibility into that.
      auth_mode: updated.auth_mode,
      rights_mode: updated.rights_mode,
    });
  });

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
