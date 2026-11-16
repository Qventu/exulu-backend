import { z } from "zod";
import { ExuluTool } from "@SRC/exulu/tool";
import type { ExuluConfig } from "@SRC/exulu/app";
import type { User } from "@EXULU_TYPES/models/user";
import { treatAsGuest } from "@SRC/exulu/public-surface";
import { sessionFilePrefix } from "@SRC/exulu/session-files";
import { MAX_PROJECT_FILES, PROJECT_DIR, projectFilePrefix } from "@SRC/exulu/project-files";
import {
  promoteSessionFiles,
  type PromoteResult,
  type PromoteS3,
} from "@SRC/exulu/project-files-promote";
import { promptSafeProjectName } from "@SRC/exulu/session-file-listing";
import { createPromoteS3 } from "@SRC/exulu/project-files-s3";
import { listS3ObjectsByPrefix } from "@SRC/uppy";
import type { ResolvedSessionProject } from "@SRC/exulu/resolve-session-project";

export const SAVE_TO_PROJECT_TOOL_NAME = "save_to_project";
const SAVE_TO_PROJECT_TOOL_ID = "save_to_project";

/**
 * The one answer to "is save_to_project offered this turn?", shared by the tool factory and
 * the system prompt so the prompt never names a tool the model does not have.
 */
export function canRegisterSaveToProject(args: {
  sessionID?: string;
  exuluConfig?: ExuluConfig;
  project?: { speakerCanWrite?: boolean } | null;
  req?: { headers?: Record<string, unknown> };
  user?: { id?: unknown } | null;
  disabled?: Set<string> | string[];
}): boolean {
  if (!args.sessionID || !args.exuluConfig?.fileUploads?.s3Bucket) return false;
  if (!args.project?.speakerCanWrite) return false;
  // Guests and the public surface never write, whatever the project's rights say.
  if (treatAsGuest(args.req, args.user)) return false;
  const disabled = args.disabled instanceof Set ? args.disabled : new Set(args.disabled ?? []);
  return !disabled.has(SAVE_TO_PROJECT_TOOL_ID);
}

type Deps = {
  promote: typeof promoteSessionFiles;
  s3: PromoteS3;
  /** When the project's file of that name last changed (for the clash message). */
  projectModified: (name: string) => Promise<Date | undefined>;
};

/**
 * The agent's only way to put a session file into the project's shared folder (the sandbox
 * `project/` directory is read-only for it). One file per call, through the same
 * promoteSessionFiles the sidebar's "Add to project" uses, so name, size and 200-file
 * rules cannot drift between the two. Registered only when the SPEAKER of this turn may
 * write to the project (`project.speakerCanWrite`); it needs approval like the other write
 * tools, so the generic approval wiring in convertExuluToolsToAiSdkTools applies as is.
 */
export const createSaveToProjectTool = ({
  sessionID,
  user,
  req,
  exuluConfig,
  ownerId,
  project,
  disabled,
  deps,
}: {
  sessionID?: string;
  user?: User;
  req?: { headers?: Record<string, unknown> };
  exuluConfig?: ExuluConfig;
  /** Session owner — session files are namespaced by owner, not by the current speaker. */
  ownerId?: number | string;
  project?: ResolvedSessionProject | null;
  disabled?: Set<string> | string[];
  deps?: Deps;
}): ExuluTool | undefined => {
  if (!canRegisterSaveToProject({ sessionID, exuluConfig, project, req, user, disabled })) return undefined;
  if (!sessionID || !exuluConfig || !project) return undefined;

  const uploads = exuluConfig.fileUploads;
  if (!uploads) return undefined;
  const projectLabel = promptSafeProjectName(project.name);
  const resolvedDeps: Deps = deps ?? {
    promote: promoteSessionFiles,
    s3: createPromoteS3(exuluConfig),
    projectModified: async (name) => {
      const { projectPrefix } = projectFilePrefix(project.id, uploads.s3prefix);
      const objects = await listS3ObjectsByPrefix(projectPrefix, exuluConfig);
      const hit = objects.find((o) => o.key.split("/").pop() === name);
      return hit ? new Date(hit.lastModified) : undefined;
    },
  };

  const execute = async ({ filename, overwrite }: { filename: string; overwrite?: boolean }) => {
    const name = String(filename ?? "").trim();
    if (name.startsWith(`${PROJECT_DIR}/`)) {
      return {
        result: `"${name}" is already in the project. Pass the name of a session file, without the "${PROJECT_DIR}/" prefix.`,
      };
    }
    if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
      return {
        result:
          "Invalid filename. Pass the bare name of a session file, exactly as listed (session files are flat: no paths, no '..').",
      };
    }

    const ownerPrefix = sessionFilePrefix(ownerId ?? user?.id ?? "api", sessionID, uploads.s3prefix);
    let outcome: PromoteResult;
    try {
      outcome = await resolvedDeps.promote({
        projectId: project.id,
        s3prefix: uploads.s3prefix,
        keys: [`${ownerPrefix}${name}`],
        fullSessionPrefix: ownerPrefix,
        overwrite: overwrite === true,
        s3: resolvedDeps.s3,
      });
    } catch (err) {
      console.error("[PROJECT-FILES] save_to_project failed", err);
      // The raw error (bucket names, keys) stays in the log, not in the model's context.
      return { result: "Saving to the project failed. Try again; if it keeps failing, tell the user." };
    }

    if (outcome.promoted.length > 0) {
      return {
        result:
          `Saved "${name}" to project ${projectLabel}. ` +
          `It will be visible to you as ${PROJECT_DIR}/${name} from the next turn.`,
      };
    }
    if (outcome.clashes.length > 0) {
      let changed = "";
      try {
        const at = await resolvedDeps.projectModified(name);
        if (at) changed = ` (changed ${at.toISOString().slice(0, 10)})`;
      } catch {
        // The date is a nicety; the clash itself is what matters.
      }
      return {
        result: `"${name}" already exists in the project${changed}. Call again with overwrite: true only if the user confirms.`,
      };
    }
    const reason = outcome.rejected[0]?.reason ?? "Unknown reason.";
    if (reason.includes(`at most ${MAX_PROJECT_FILES} files`)) {
      return { result: `The project already holds ${MAX_PROJECT_FILES} files.` };
    }
    if (reason.includes("not found")) {
      return { result: `No session file named "${name}".` };
    }
    return { result: `Could not save "${name}" to the project: ${reason}` };
  };

  return ExuluTool.internal({
    id: "save_to_project",
    name: SAVE_TO_PROJECT_TOOL_NAME,
    needsApproval: true,
    // Replacing a shared file always needs a fresh yes, "allow for this chat" or not.
    alwaysAskWhen: (input) => (input as { overwrite?: unknown } | undefined)?.overwrite === true,
    description:
      `Copy one file from this session's files into the project's shared folder (${projectLabel}), where ` +
      "everyone on the project can read it. The `project/` directory is read-only for you, so this is the only " +
      "way to add a file to the project. Pass the bare name of the session file. If the name already exists " +
      "in the project the call changes nothing and tells you; call again with overwrite: true only after the " +
      "user has confirmed replacing it.",
    inputSchema: z.object({
      filename: z
        .string()
        .describe("Bare name of the session file to save, exactly as listed in the session files (no path)."),
      overwrite: z
        .boolean()
        .optional()
        .describe("Replace a project file of the same name. Only set after the user confirmed."),
    }),
    type: "function",
    category: "session",
    config: [],
    execute: execute as never,
  });
};
