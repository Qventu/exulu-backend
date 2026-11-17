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
  createProjectAndAttach,
  planMove,
  type MoveCandidate,
} from "@SRC/exulu/project-create";
import { moveSessionFiles, type MoveResult, type MoveS3 } from "@SRC/exulu/project-files-promote";
import { createMoveS3 } from "@SRC/exulu/project-files-s3";
import { parseStoredFileUrl } from "@SRC/exulu/stored-file-url";
import { promptSafeProjectName } from "@SRC/exulu/session-file-listing";
import { listS3ObjectsByPrefix } from "@SRC/uppy";
import { isRunSessionMetadata } from "@SRC/exulu/routines/run-session";
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
  /** True when this turn is part of a routine run: a run is not a conversation to turn into a project. */
  routineRun?: boolean;
  req?: { headers?: Record<string, unknown> };
  user?: { id?: unknown } | null;
  disabled?: Set<string> | string[];
}): boolean {
  if (args.routineRun) return false;
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
  "project with the create_project tool: agree a short project name with the user first, then call it with " +
  "`files` listing exactly the session files (from the listing above) that should move into the project. " +
  "The user approves the call and sees that list; the project is private to them; unlisted files stay in the session.";

/** Postgres regex: a serialized message that may contain a file part. */
export const FILE_PART_PATTERN = '"type"[[:space:]]*:[[:space:]]*"file"';

/**
 * Full S3 keys that stored messages refer to through file parts. A row that cannot be parsed
 * might hold a reference we cannot see, so it fails the whole lookup (the caller then keeps
 * every original).
 */
export function referencedFileKeys(
  rows: { content: string }[],
  store: { endpoint?: string; bucket?: string },
): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    let message: { parts?: { type?: string; url?: string }[] };
    try {
      message = JSON.parse(row.content);
    } catch {
      throw new Error("A stored message could not be parsed.");
    }
    for (const part of message?.parts ?? []) {
      if (part?.type !== "file") continue;
      const at = parseStoredFileUrl(part.url, store);
      if (at) keys.add(at.key);
    }
  }
  return keys;
}

type Deps = {
  /** The session row (project, user) or undefined. */
  loadSession: (id: string) => Promise<{ project?: string | null; user?: number | string | null; metadata?: unknown } | undefined>;
  /** Creates the project and attaches the session in one transaction. */
  createAndAttach: typeof createProjectAndAttach;
  /** Full S3 keys that stored messages of this session refer to (file parts): never deleted. */
  referencedKeys: (sessionId: string) => Promise<Set<string>>;
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
  if (moved.keptForHistory.length > 0) {
    lines.push(
      `Copied into the project and also kept in the session, because an earlier message in this conversation refers to them: ${listNames(moved.keptForHistory)}.`,
    );
  }
  if (moved.originalsKept.length > 0) {
    lines.push(
      `These files were copied into the project but their session originals could not be removed, so they exist in both places: ${listNames(moved.originalsKept)}.`,
    );
  }
  if (leftInSession > 0) {
    lines.push(
      `${leftInSession} other session file${leftInSession === 1 ? "" : "s"} not on the approved list stayed in the session.`,
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
  routineRun,
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
  /** The turn is part of a routine run. */
  routineRun?: boolean;
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
      routineRun,
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
    createAndAttach: createProjectAndAttach,
    referencedKeys: async (id) => {
      const { db } = await postgresClient();
      // Only rows that can hold a file part. content is a text column written by
      // JSON.stringify (no spaces), but other writers may format it, so the pattern
      // tolerates whitespace; a superset is fine, a missed row is not.
      const rows: { content: string }[] = await db
        .from("agent_messages")
        .where({ session: id })
        .whereRaw("content ~ ?", [FILE_PART_PATTERN])
        .select("content");
      return referencedFileKeys(rows, { endpoint: uploads.s3endpoint, bucket: uploads.s3Bucket });
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

  const execute = async ({ name, description, files }: { name: string; description?: string; files: string[] }) => {
    // A direct call without `files` moves nothing: what moves is what the user approved.
    const requested = Array.isArray(files) ? files : [];
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
    if (isRunSessionMetadata((session as { metadata?: unknown }).metadata)) {
      return { result: "A routine run cannot be turned into a project." };
    }
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
    const plan = planMove({ files: candidates, requested });

    let created: { id: string; name: string };
    try {
      created = await resolvedDeps.createAndAttach(await resolvedDeps.db(), user, { sessionId: sessionID, name, description });
    } catch (err) {
      console.error("[PROJECT-CREATE] create/attach failed", err);
      const message = err instanceof Error ? err.message : "";
      // Validation messages are ours (fixed text); anything else stays in the log.
      const ours = /^Project (name|description) must be/.test(message);
      return {
        result: ours
          ? message
          : "The project could not be created and attached to this conversation, so nothing was created or moved.",
      };
    }

    // From here the project exists and is attached: the document tools of this turn
    // resolve project/<name> against it. The prompt of this turn is not rebuilt.
    if (turnProject) turnProject.current = { id: created.id, name: created.name, speakerCanWrite: true };

    // A stored message that refers to a session file by key must keep working when the history is
    // replayed (the document would become an error text, an image a 404): copy such files only.
    // When the lookup fails, assume every file is referenced.
    let keepOriginalKeys: Set<string>;
    try {
      keepOriginalKeys = await resolvedDeps.referencedKeys(sessionID);
    } catch (err) {
      console.error("[PROJECT-CREATE] could not read the session's messages", err);
      keepOriginalKeys = new Set(plan.batches.flat().map((f) => f.key));
    }

    let moved: MoveResult = { moved: [], notMoved: [], originalsKept: [], keptForHistory: [] };
    try {
      moved = await resolvedDeps.move({
        projectId: created.id,
        s3prefix: uploads.s3prefix,
        fullSessionPrefix: ownerPrefix,
        batches: plan.batches,
        s3: resolvedDeps.s3,
        keepOriginalKeys,
      });
    } catch (err) {
      console.error("[PROJECT-CREATE] moving files failed", err);
      moved = {
        moved: [],
        notMoved: plan.batches.flat().map((f) => ({ name: f.name, reason: "Copying the file into the project failed." })),
        originalsKept: [],
        keptForHistory: [],
      };
    }

    const asked = new Set(requested.map((n) => String(n ?? "").trim()));
    const leftInSession = candidates.filter((c) => !asked.has(c.name)).length;
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
      "conversation to it and moves the listed session files into the project's shared folder. Only offer this when " +
      "the user wants to keep working on this topic over time or share it later; agree a short project name first. " +
      "`files` is REQUIRED and must list exactly the files to move, as bare names taken from the session file " +
      "listing in the system prompt (an empty list creates the project without moving files). The user sees this " +
      "list on the approval card; every session file not on it stays in the session. Do not list tool-output-* " +
      "files, generated artifacts or files in subfolders unless the user asked for them. Nobody else gets access.",
    inputSchema: z.object({
      name: z.string().min(1).max(MAX_PROJECT_NAME_LENGTH).describe("The project's name."),
      description: z.string().max(MAX_PROJECT_DESCRIPTION_LENGTH).optional().describe("One or two sentences about what the project is for."),
      files: z
        .array(z.string())
        .describe("Bare names of the session files to move, exactly as listed. [] to move none."),
    }),
    type: "function",
    category: "session",
    config: [],
    execute: execute as never,
  });
};

/** The display-only entry for the agent editor's catalogue; its presence in agent.tools is the opt-in. */
export const createCreateProjectPickerTool = (): ExuluTool =>
  new ExuluTool({
    id: CREATE_PROJECT_TOOL_ID,
    name: "Create project from chat",
    category: "default",
    description:
      "Let this agent offer to turn a conversation into a project: after the user approves, it creates a private project, " +
      "attaches the conversation and moves the listed session files into the project's shared folder. " +
      "Off unless added here; always asks for approval; not offered in routine runs or to guests.",
    type: "function",
    inputSchema: z.object({}),
    config: [],
    execute: async () => ({ result: "This entry is configuration-only; Exulu builds the create_project tool per conversation at runtime." }),
  });
