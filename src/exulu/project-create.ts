import { randomUUID } from "node:crypto";
import { RBACResolver } from "@EE/rbac-resolver.ts";
import { isIgnoredArtifactPath } from "@EE/invoke-skills/artifact-filter.ts";
import { coreSchemas } from "@SRC/postgres/core-schema";
import { prepareItemWrite } from "./item-write";
import { hasProjectAccess, sameEntityId } from "./project-access";
import { MAX_PROJECT_FILES, MAX_PROMOTE_KEYS } from "./project-files";
import { MAX_ADOPT_UPLOAD_BYTES } from "./session-file-adopt";
import { sanitizeFilename } from "./session-files";
import type { ExuluContextFieldDefinition } from "./context";

export const MAX_PROJECT_NAME_LENGTH = 120;
export const MAX_PROJECT_DESCRIPTION_LENGTH = 2000;
/** Prefix of oversized-output session files: the model's own scratch, never worth moving. */
export const TOOL_OUTPUT_PREFIX = "tool-output-";

type Db = any;
type Actor = { id: number | string; role?: unknown; team?: unknown; super_admin?: boolean; type?: string; scope_mode?: string | null };

let cachedProjectFields: ExuluContextFieldDefinition[] | undefined;
/** The projects table definition (addCoreFields mutates, so build it once). */
const projectFields = (): ExuluContextFieldDefinition[] => {
  if (!cachedProjectFields) {
    cachedProjectFields = coreSchemas.get().projectsSchema().fields as ExuluContextFieldDefinition[];
  }
  return cachedProjectFields;
};

/**
 * Insert the row a private `projectsCreateOne` would insert (src/graphql/mutations/index.ts):
 * `created_by` is the caller, `rights_mode` "private", a fresh uuid, and the same
 * prepareItemWrite validation. No RBAC rows are written: nobody but the creator has access.
 */
export async function createProjectForUser(
  db: Db,
  user: Actor,
  input: { name: string; description?: string },
): Promise<{ id: string; name: string }> {
  const name = String(input?.name ?? "").trim();
  if (!name || name.length > MAX_PROJECT_NAME_LENGTH) {
    throw new Error(`Project name must be 1 to ${MAX_PROJECT_NAME_LENGTH} characters.`);
  }
  const description = input.description == null ? undefined : String(input.description).trim();
  if (description && description.length > MAX_PROJECT_DESCRIPTION_LENGTH) {
    throw new Error(`Project description must be at most ${MAX_PROJECT_DESCRIPTION_LENGTH} characters.`);
  }
  if (user?.id == null || user.id === "") throw new Error("A project needs a signed-in creator.");

  const values: Record<string, unknown> = { name, ...(description ? { description } : {}) };
  const validation = prepareItemWrite({ fields: projectFields(), existing: null, input: values });
  if (!validation.ok) throw new Error(validation.message);

  const row = { ...values, id: randomUUID(), created_by: user.id, rights_mode: "private" };
  const [created] = await db("projects").insert(row).returning(["id", "name"]);
  if (!created?.id) throw new Error("The project could not be created.");
  return { id: String(created.id), name: String(created.name ?? name) };
}

type SessionUser = Actor & { role?: unknown; team?: unknown };
const bareId = (v: unknown): unknown => (typeof v === "object" && v ? (v as { id?: unknown }).id : v);

/**
 * May `user` change this session (attach it to a project)? Sessions have their own rule, not
 * the project one: no super-admin bypass and no allow-all when the RBAC licence is absent
 * (RBACResolver then returns type "public" with no grants, so only the owner passes), the way
 * applyAccessControl treats agent_sessions. The OWNER is `session.user`, the same column
 * resolveSessionProject / the file prefix use; `created_by` plays no part. Otherwise a WRITE
 * grant matching the session's rights mode (users/roles/teams), or an admin-mode API key.
 */
export function canWriteSession(
  session: { user?: number | string | null },
  rbac: { type: string; users?: { id: unknown; rights: string }[]; roles?: { id: unknown; rights: string }[]; teams?: { id: unknown; rights: string }[] },
  user: SessionUser,
): boolean {
  if (sameEntityId(session.user, user.id)) return true;
  if (user.type === "api" && (!user.scope_mode || user.scope_mode === "admin")) return true;
  const grant = (list: { id: unknown; rights: string }[] | undefined, subject: unknown) =>
    subject != null && (list ?? []).some((g) => sameEntityId(g.id, subject) && g.rights === "write");
  switch (rbac.type) {
    case "users":
      return grant(rbac.users, user.id);
    case "roles":
      return grant(rbac.roles, bareId(user.role));
    case "teams":
      return grant(rbac.teams, bareId(user.team));
    default:
      return false;
  }
}

/**
 * Set `agent_sessions.project`. Refuses unless the user may write the session (canWriteSession)
 * and read the project, and unless the session has no project yet (the update is guarded in SQL,
 * so two racing calls cannot both win). RBAC rows are keyed by the SINGULAR entity name:
 * "agent_session" for sessions, "project" for projects.
 */
export async function attachSessionToProject(
  db: Db,
  args: { sessionId: string; projectId: string; user: Actor },
): Promise<void> {
  const { sessionId, projectId, user } = args;
  const session = await db.from("agent_sessions").where({ id: sessionId }).first();
  if (!session) throw new Error("Session not found.");
  if (session.project) throw new Error("This session already belongs to a project.");
  const sessionRbac = await RBACResolver(db, "agent_session", session.id, session.rights_mode || "private");
  if (!canWriteSession(session, sessionRbac, user)) {
    throw new Error("No write access to this session.");
  }
  const project = await db.from("projects").where({ id: projectId }).first();
  if (!project) throw new Error("Project not found.");
  const projectRbac = await RBACResolver(db, "project", project.id, project.rights_mode || "private");
  if (!hasProjectAccess({ project, rbac: projectRbac, user: user as never, want: "read" })) {
    throw new Error("No read access to this project.");
  }
  const updated = await db("agent_sessions").where({ id: sessionId }).whereNull("project").update({ project: projectId });
  if (!updated) throw new Error("This session already belongs to a project.");
}

/**
 * Create the project and attach the session in ONE transaction: an attach that fails or loses
 * the race rolls the insert back, so no orphan project remains and nothing needs compensating.
 */
export async function createProjectAndAttach(
  db: Db,
  user: Actor,
  input: { sessionId: string; name: string; description?: string },
): Promise<{ id: string; name: string }> {
  return db.transaction(async (trx: Db) => {
    const created = await createProjectForUser(trx, user, { name: input.name, description: input.description });
    await attachSessionToProject(trx, { sessionId: input.sessionId, projectId: created.id, user });
    return created;
  });
}

export type MoveCandidate = { key: string; name: string; size: number };
export type MoveSkip = { name: string; reason: string };

export const SKIP_CLASH = "Its name clashes with another file once sanitised.";
export const SKIP_UNKNOWN = "No session file with this name.";
export const SKIP_NESTED = "Only top-level session files can be moved.";
export const SKIP_TOO_LARGE = "It is larger than 50 MB.";
export const SKIP_PROJECT_FULL = `A project holds at most ${MAX_PROJECT_FILES} files.`;

/** The files that move when the model names none: no dependency dirs, no subfolders, no tool-output-*. */
export const isDefaultMoveCandidate = (name: string): boolean =>
  !name.includes("/") && !name.includes("\\") && !name.startsWith(TOOL_OUTPUT_PREFIX) && !isIgnoredArtifactPath(name);

/**
 * Decide what to move and in which batches. Batches hold at most MAX_PROMOTE_KEYS keys and
 * 50 MB in total (each batch is one promote call, which enforces the same limits), and the
 * project takes at most MAX_PROJECT_FILES files. Everything left out is reported in `skipped`,
 * nothing is dropped silently, except the default set's deliberate exclusions (see
 * isDefaultMoveCandidate), which stay in the session and are not "failures".
 */
export function planMove(args: {
  files: MoveCandidate[];
  requested?: string[];
}): { batches: { key: string; name: string }[][]; skipped: MoveSkip[] } {
  const skipped: MoveSkip[] = [];
  let pool: MoveCandidate[];
  if (args.requested) {
    const byName = new Map(args.files.map((f) => [f.name, f]));
    pool = [];
    const seen = new Set<string>();
    for (const raw of args.requested) {
      const name = String(raw ?? "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      if (name.includes("/") || name.includes("\\")) {
        skipped.push({ name, reason: SKIP_NESTED });
        continue;
      }
      const hit = byName.get(name);
      if (!hit) skipped.push({ name, reason: SKIP_UNKNOWN });
      else pool.push(hit);
    }
  } else {
    pool = args.files.filter((f) => isDefaultMoveCandidate(f.name));
  }

  // Names that sanitise to the same project name would overwrite each other: move neither.
  const groups = new Map<string, MoveCandidate[]>();
  for (const f of pool) {
    const safe = sanitizeFilename(f.name);
    groups.set(safe, [...(groups.get(safe) ?? []), f]);
  }
  const usable: MoveCandidate[] = [];
  for (const f of pool) {
    const safe = sanitizeFilename(f.name);
    if (!safe) skipped.push({ name: f.name, reason: "Could not derive a safe filename." });
    else if ((groups.get(safe) ?? []).length > 1) skipped.push({ name: f.name, reason: SKIP_CLASH });
    else if (f.size > MAX_ADOPT_UPLOAD_BYTES) skipped.push({ name: f.name, reason: SKIP_TOO_LARGE });
    else usable.push(f);
  }

  const kept = usable.slice(0, MAX_PROJECT_FILES);
  for (const f of usable.slice(MAX_PROJECT_FILES)) skipped.push({ name: f.name, reason: SKIP_PROJECT_FULL });

  const batches: { key: string; name: string }[][] = [];
  let batch: { key: string; name: string }[] = [];
  let bytes = 0;
  for (const f of kept) {
    if (batch.length >= MAX_PROMOTE_KEYS || (batch.length > 0 && bytes + f.size > MAX_ADOPT_UPLOAD_BYTES)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push({ key: f.key, name: f.name });
    bytes += f.size;
  }
  if (batch.length > 0) batches.push(batch);
  return { batches, skipped };
}
