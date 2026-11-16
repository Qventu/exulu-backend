import { z } from "zod";
import { ExuluTool } from "@SRC/exulu/tool";
import type { ExuluConfig } from "@SRC/exulu/app";
import type { User } from "@EXULU_TYPES/models/user";
import { treatAsGuest } from "@SRC/exulu/public-surface";
import { postgresClient } from "@SRC/postgres/client";
import { sessionFilePrefix } from "@SRC/exulu/session-files";
import { PROJECT_DIR } from "@SRC/exulu/project-files";
import {
  MAX_PROJECT_DESCRIPTION_LENGTH,
  MAX_PROJECT_NAME_LENGTH,
  attachSessionToProject,
  createProjectForUser,
  planMove,
  isDefaultMoveCandidate,
  type MoveCandidate,
} from "@SRC/exulu/project-create";
import { moveSessionFiles, type MoveResult, type MoveS3 } from "@SRC/exulu/project-files-promote";
import { createMoveS3 } from "@SRC/exulu/project-files-s3";
import { promptSafeProjectName } from "@SRC/exulu/session-file-listing";
import { listS3ObjectsByPrefix } from "@SRC/uppy";
import type { TurnProject } from "@SRC/exulu/turn-project";

export const CREATE_PROJECT_TOOL_NAME = "create_project";
/** Also the id of the (config-only) entry in `agent.tools` that switches the tool on for an agent. */
export const CREATE_PROJECT_TOOL_ID = "create_project";

export const PRIVATE_PROJECT_SENTENCE = "Only you can see this project. Invite colleagues on the project page.";

/**
 * Opt-in per agent: the tool is on only when `agent.tools` (the agent's json tool list, an
 * array or its JSON string) holds an entry with id "create_project". Agents without such an
 * entry, i.e. every agent that exists today, never get it. Same pattern as skill_author.
 */
export function isCreateProjectEnabledOnAgent(tools: unknown): boolean {
  let entries = tools;
  if (typeof entries === "string") {
    try {
      entries = JSON.parse(entries);
    } catch {
      return false;
    }
  }
  return Array.isArray(entries) && entries.some((t) => (t as { id?: unknown } | null)?.id === CREATE_PROJECT_TOOL_ID);
}

const sameId = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b);

/**
 * The one answer to "is create_project offered this turn?", shared by the tool factory, the
 * tool's own execute (so a direct call that skipped registration is refused too) and the system
 * prompt. Offered only when the agent enabled it, the session exists and has no project, the
 * speaker is the session's owner and not a guest, and file uploads are configured.
 */
export function canRegisterCreateProject(args: {
  sessionID?: string;
  exuluConfig?: ExuluConfig;
  /** The agent's tool list (agent.tools). */
  agentTools?: unknown;
  /** The access-checked project of the turn (or the holder's current value); null = none. */
  project?: unknown;
  /** The raw session.project id, when the caller has it: a project we cannot see still blocks. */
  sessionProjectId?: string | null;
  /** Session owner id; undefined when the session row does not exist or has no owner. */
  ownerId?: number | string | null;
  req?: { headers?: Record<string, unknown> };
  user?: { id?: unknown } | null;
  disabled?: Set<string> | string[];
}): boolean {
  if (!args.sessionID || !args.exuluConfig?.fileUploads?.s3Bucket) return false;
  if (treatAsGuest(args.req, args.user)) return false;
  if (!isCreateProjectEnabledOnAgent(args.agentTools)) return false;
  if (args.project || args.sessionProjectId) return false;
  if (!sameId(args.ownerId, args.user?.id)) return false;
  const disabled = args.disabled instanceof Set ? args.disabled : new Set(args.disabled ?? []);
  return !disabled.has(CREATE_PROJECT_TOOL_ID);
}

/** Added to the system prompt only when canRegisterCreateProject holds (same predicate as the registration). */
export const CREATE_PROJECT_PROMPT =
  "Projects: this conversation does not belong to a project yet. When the user wants to keep working on this " +
  "topic over time, or to share the work with colleagues later, you can offer to turn the conversation into a " +
  "project with the create_project tool: agree a short project name with the user first, then call it. " +
  "The user approves the call; the project is private to them, and their session files move into it.";

type Deps = {
  /** The session row (project, user) or undefined. */
  loadSession: (id: string) => Promise<{ project?: string | null; user?: number | string | null } | undefined>;
  create: typeof createProjectForUser;
  attach: typeof attachSessionToProject;
  /** Remove a project created a moment ago whose session could not be attached. */
  discardProject: (id: string) => Promise<void>;
  listSessionFiles: (prefix: string) => Promise<MoveCandidate[]>;
  move: typeof moveSessionFiles;
  s3: MoveS3;
  db: () => Promise<unknown>;
};

const MAX_LISTED_NAMES = 20;
const listNames = (names: string[]) =>
  names.slice(0, MAX_LISTED_NAMES).join(", ") + (names.length > MAX_LISTED_NAMES ? ` (+${names.length - MAX_LISTED_NAMES} more)` : "");

export function formatCreateProjectResult(args: {
  name: string;
  id: string;
  moved: MoveResult;
  skipped: { name: string; reason: string }[];
  leftInSession: number;
}): string {
  const { name, id, moved, skipped, leftInSession } = args;
  const notMoved = [...skipped, ...moved.notMoved];
  const lines = [
    `Created project "${promptSafeProjectName(name)}" (id ${id}) and attached this conversation to it.`,
    moved.moved.length > 0
      ? `Moved ${moved.moved.length} file${moved.moved.length === 1 ? "" : "s"} into the project: ${listNames(moved.moved)}.`
      : "Moved 0 files into the project.",
  ];
  if (notMoved.length > 0) {
    lines.push(
      `Not moved (they stay in this session): ${notMoved
        .slice(0, MAX_LISTED_NAMES)
        .map((s) => `${s.name} (${s.reason})`)
        .join("; ")}${notMoved.length > MAX_LISTED_NAMES ? ` (+${notMoved.length - MAX_LISTED_NAMES} more)` : ""}.`,
    );
  }
  if (moved.originalsKept.length > 0) {
    lines.push(
      `These files were copied into the project but their session originals could not be removed, so they exist in both places: ${listNames(moved.originalsKept)}.`,
    );
  }
  if (leftInSession > 0) {
    lines.push(
      `${leftInSession} other session file${leftInSession === 1 ? "" : "s"} (tool outputs, generated artifacts, subfolders) stayed in the session on purpose.`,
    );
  }
  lines.push(
    PRIVATE_PROJECT_SENTENCE,
    `Project page: /projects/${id}`,
    `The moved files can be read in this turn as ${PROJECT_DIR}/<name>; the sandbox ${PROJECT_DIR}/ folder appears from the next message.`,
  );
  return lines.join("\n");
}

/**
 * Turn the current conversation into a project: create it (private, owned by the speaker),
 * attach the session, move the session's files into the project folder. Always needs the
 * user's approval (never "allow for this chat"). Registered only when canRegisterCreateProject
 * holds, and re-checked inside execute against the live session row.
 */
export const createCreateProjectTool = ({
  sessionID,
  user,
  req,
  exuluConfig,
  ownerId,
  agentTools,
  project,
  sessionProjectId,
  disabled,
  turnProject,
  deps,
}: {
  sessionID?: string;
  user?: User;
  req?: { headers?: Record<string, unknown> };
  exuluConfig?: ExuluConfig;
  /** Session owner id (null/undefined when there is no session row or no owner). */
  ownerId?: number | string | null;
  agentTools?: unknown;
  project?: unknown;
  sessionProjectId?: string | null;
  disabled?: Set<string> | string[];
  /** The turn's project holder, set once the project exists so project/<name> resolves in this turn. */
  turnProject?: TurnProject;
  deps?: Partial<Deps>;
}): ExuluTool | undefined => {
  const gate = (liveOwner: number | string | null | undefined, liveProject: unknown, liveSessionProject: string | null | undefined) =>
    canRegisterCreateProject({
      sessionID,
      exuluConfig,
      agentTools,
      project: liveProject,
      sessionProjectId: liveSessionProject,
      ownerId: liveOwner,
      req,
      user,
      disabled,
    });
  if (!gate(ownerId, project, sessionProjectId)) return undefined;
  if (!sessionID || !exuluConfig || !user) return undefined;
  const uploads = exuluConfig.fileUploads;
  if (!uploads?.s3Bucket) return undefined;

  const resolvedDeps: Deps = {
    loadSession: async (id) => {
      const { db } = await postgresClient();
      return db.from("agent_sessions").where({ id }).first();
    },
    create: createProjectForUser,
    attach: attachSessionToProject,
    discardProject: async (id) => {
      const { db } = await postgresClient();
      await db("projects").where({ id }).del();
    },
    listSessionFiles: async (prefix) => {
      const objects = await listS3ObjectsByPrefix(prefix, exuluConfig);
      return objects
        .filter((o) => !o.key.endsWith("/"))
        .map((o) => ({ key: o.key, name: o.key.slice(o.key.indexOf(prefix) + prefix.length), size: o.size }));
    },
    move: moveSessionFiles,
    s3: createMoveS3(exuluConfig),
    db: async () => (await postgresClient()).db,
    ...deps,
  };

  const execute = async ({ name, description, files }: { name: string; description?: string; files?: string[] }) => {
    // The live session decides, not what was true at registration.
    let session: Awaited<ReturnType<Deps["loadSession"]>>;
    try {
      session = await resolvedDeps.loadSession(sessionID);
    } catch (err) {
      console.error("[PROJECT-CREATE] could not load the session", err);
      return { result: "Creating the project failed. Try again; if it keeps failing, tell the user." };
    }
    if (!session) return { result: "This conversation has no saved session yet, so it cannot become a project." };
    if (session.project) return { result: "This conversation already belongs to a project." };
    if (!gate(session.user, turnProject?.current ?? null, null)) {
      return { result: "Only the owner of this conversation can turn it into a project, and only where this agent has the tool enabled." };
    }

    const ownerPrefix = sessionFilePrefix(session.user as number | string, sessionID, uploads.s3prefix);
    let candidates: MoveCandidate[];
    try {
      candidates = await resolvedDeps.listSessionFiles(ownerPrefix);
    } catch (err) {
      console.error("[PROJECT-CREATE] could not list the session files", err);
      return { result: "Creating the project failed. Try again; if it keeps failing, tell the user." };
    }
    const plan = planMove({ files: candidates, requested: files });

    let created: { id: string; name: string };
    try {
      created = await resolvedDeps.create(await resolvedDeps.db(), user, { name, description });
    } catch (err) {
      console.error("[PROJECT-CREATE] create failed", err);
      const message = err instanceof Error ? err.message : "";
      // Validation messages are ours (fixed text); anything else stays in the log.
      const ours = /^Project (name|description) must be/.test(message);
      return { result: ours ? message : "Creating the project failed. Try again; if it keeps failing, tell the user." };
    }

    try {
      await resolvedDeps.attach(await resolvedDeps.db(), { sessionId: sessionID, projectId: created.id, user });
    } catch (err) {
      console.error("[PROJECT-CREATE] attach failed", err);
      try {
        await resolvedDeps.discardProject(created.id);
      } catch (cleanup) {
        console.error("[PROJECT-CREATE] could not discard the unattached project", created.id, cleanup);
      }
      return { result: "The project could not be attached to this conversation, so nothing was created or moved." };
    }

    // From here the project exists and is attached: the document tools of this turn
    // resolve project/<name> against it. The prompt of this turn is not rebuilt.
    if (turnProject) turnProject.current = { id: created.id, name: created.name, speakerCanWrite: true };

    let moved: MoveResult = { moved: [], notMoved: [], originalsKept: [] };
    try {
      moved = await resolvedDeps.move({
        projectId: created.id,
        s3prefix: uploads.s3prefix,
        fullSessionPrefix: ownerPrefix,
        batches: plan.batches,
        s3: resolvedDeps.s3,
      });
    } catch (err) {
      console.error("[PROJECT-CREATE] moving files failed", err);
      moved = {
        moved: [],
        notMoved: plan.batches.flat().map((f) => ({ name: f.name, reason: "Copying the file into the project failed." })),
        originalsKept: [],
      };
    }

    const leftInSession =
      files && files.length > 0 ? 0 : candidates.filter((c) => !isDefaultMoveCandidate(c.name)).length;
    return {
      result: formatCreateProjectResult({
        name: created.name,
        id: created.id,
        moved,
        skipped: plan.skipped,
        leftInSession,
      }),
    };
  };

  return ExuluTool.internal({
    id: CREATE_PROJECT_TOOL_ID,
    name: CREATE_PROJECT_TOOL_NAME,
    needsApproval: true,
    // The project and the file move are not undone by a later "no": every call asks, even in a chat
    // where the user allowed other tools.
    alwaysAskWhen: () => true,
    description:
      "Turn this conversation into a project: creates a new private project owned by the user, attaches this " +
      "conversation to it and moves the session's files into the project's shared folder. Only offer this when " +
      "the user wants to keep working on this topic over time or share it later; ask for a short project name first. " +
      "By default every top-level session file moves (not tool outputs or generated artifacts); pass `files` " +
      "with bare file names to move only those. The user approves the call; nobody else gets access.",
    inputSchema: z.object({
      name: z.string().min(1).max(MAX_PROJECT_NAME_LENGTH).describe("The project's name."),
      description: z.string().max(MAX_PROJECT_DESCRIPTION_LENGTH).optional().describe("One or two sentences about what the project is for."),
      files: z
        .array(z.string())
        .optional()
        .describe("Bare names of the session files to move. Omit to move all of them."),
    }),
    type: "function",
    category: "session",
    config: [],
    execute: execute as never,
  });
};
