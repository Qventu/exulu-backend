import { listS3ObjectsByPrefix } from "@SRC/uppy";
import type { ExuluConfig } from "./app";
import { isIgnoredArtifactPath } from "@EE/invoke-skills/artifact-filter";
import { sessionFilePrefix } from "./session-files";
import { projectFilePrefix, PROJECT_DIR } from "./project-files";

/**
 * The system prompt told the model that uploaded files "appear in the working directory",
 * but nothing told it WHICH files exist. A user who uploads a tender PDF and asks "Wie hoch
 * ist die Tragkraft laut Leistungsverzeichnis?" got an answer from the norms knowledge base
 * instead. Listing the session files on every turn, with the ones added since the last
 * answer flagged, lets the model reach for the document first.
 */

export type SessionFileEntry = { name: string; size: number; lastModified: Date };
export type ListedFile = SessionFileEntry;

const DEFAULT_MAX = 25;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAge(then: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - then.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function describeSessionFiles(
  files: SessionFileEntry[],
  opts: { now?: Date; lastTurnAt?: Date; max?: number } = {},
): string {
  const now = opts.now ?? new Date();
  const max = opts.max ?? DEFAULT_MAX;
  const usable = files
    .filter((f) => f.name && !f.name.endsWith("/") && !isIgnoredArtifactPath(f.name))
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  if (usable.length === 0) return "";

  const shown = usable.slice(0, max);
  const lines = shown.map((f) => {
    const isNew = opts.lastTurnAt ? f.lastModified.getTime() > opts.lastTurnAt.getTime() : false;
    return `- ${f.name} (${formatSize(f.size)}, ${formatAge(f.lastModified, now)})${isNew ? " [NEW since your last answer]" : ""}`;
  });
  const omitted = usable.length - shown.length;
  if (omitted > 0) lines.push(`… and ${omitted} more file${omitted === 1 ? "" : "s"} (list them with \`ls\`).`);

  return (
    "Files currently in this session (newest first):\n" +
    lines.join("\n") +
    "\nThese files are available to you. When the user refers to one of these files, to \"the document\" " +
    "or \"the attachment\", or asks something only such a file can answer, read it with parse_document, " +
    "view_document_page or read_session_file. Otherwise proceed as usual, e.g. with the knowledge bases."
  );
}

/** Same filter, order, cap and NEW marker as the session listing. */
function listingLines(files: ListedFile[], opts: { now?: Date; lastTurnAt?: Date; max?: number }) {
  const now = opts.now ?? new Date();
  const max = opts.max ?? DEFAULT_MAX;
  const usable = files
    .filter((f) => f.name && !f.name.endsWith("/") && !isIgnoredArtifactPath(f.name))
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  const shown = usable.slice(0, max);
  const lines = shown.map((f) => {
    const isNew = opts.lastTurnAt ? f.lastModified.getTime() > opts.lastTurnAt.getTime() : false;
    return `- ${f.name} (${formatSize(f.size)}, ${formatAge(f.lastModified, now)})${isNew ? " [NEW since your last answer]" : ""}`;
  });
  return { lines, omitted: usable.length - shown.length, total: usable.length };
}

const MAX_PROMPT_NAME = 80;

/**
 * The project name is user-authored and lands in the system prompt: one line, bounded,
 * so a long or multi-line name cannot bloat or restructure the prompt.
 */
export function promptSafeProjectName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_NAME);
}

/** The project block of the prompt: 25 newest project files, read as `project/<name>`. */
export function describeProjectFiles(
  files: ListedFile[],
  projectName: string,
  opts: { now?: Date; lastTurnAt?: Date; max?: number } = {},
): string {
  const { lines, omitted, total } = listingLines(files, opts);
  if (total === 0) return "";
  if (omitted > 0) lines.push(`+${omitted} more (list them with \`ls project/\`).`);
  const name = promptSafeProjectName(projectName);
  return (
    `Project files (shared with everyone on project ${name}):\n` +
    lines.join("\n") +
    `\nRead them by passing \`${PROJECT_DIR}/<name>\` as the filename to parse_document, view_document_page ` +
    "or read_session_file. They are read-only."
  );
}

/**
 * The sentence of the "Session files" prompt paragraph that explains scope. Without a
 * project it is byte-identical to the text that used to be inline (the embedded newline
 * and indentation come from the template literal it was cut out of) — pinned by a test.
 */
export function sessionFilesScopeSentence(
  projectName: string | null | undefined,
  /** True when save_to_project is registered this turn (the speaker may write to the project). */
  canSaveToProject = false,
): string {
  if (!projectName) {
    return "These files are scoped to\n        this single session; they are NOT visible in other sessions, projects, or knowledge bases.";
  }
  const name = promptSafeProjectName(projectName);
  const route = canSaveToProject
    ? "A session file gets into the project with the save_to_project tool (the user approves each save) or " +
      "by the user in the sidebar."
    : "You cannot add files to the project: only someone with write access can, by adding a session " +
      "file to it in the sidebar.";
  return (
    "Files you see by their plain name are private to this session. " +
    `Project files are shared with everyone on project ${name} and appear under \`${PROJECT_DIR}/\`; ` +
    `they are read-only for you — do not write into \`${PROJECT_DIR}/\`, changes there are discarded. ` +
    route
  );
}

/**
 * Best-effort loader for the prompt: lists the session's files under the OWNER prefix.
 * Any failure yields an empty string so the chat never breaks because of a listing.
 */
export async function loadSessionFileListing(opts: {
  sessionID: string;
  ownerId: number | string;
  exuluConfig: ExuluConfig | undefined;
  lastTurnAt?: Date;
  /** The access-checked project (same one the sandbox and tools use); omit for none. */
  project?: { id: string; name: string } | null;
}): Promise<string> {
  const uploads = opts.exuluConfig?.fileUploads;
  if (!uploads?.s3Bucket) return "";
  const prefix = sessionFilePrefix(opts.ownerId, opts.sessionID, uploads.s3prefix);
  let sessionBlock = "";
  try {
    const objects = await listS3ObjectsByPrefix(prefix, opts.exuluConfig!);
    const files: SessionFileEntry[] = objects.map((o) => ({
      name: o.key.slice(o.key.indexOf(prefix) + prefix.length),
      size: o.size,
      lastModified: new Date(o.lastModified),
    }));
    sessionBlock = describeSessionFiles(files, { lastTurnAt: opts.lastTurnAt });
  } catch (err) {
    console.warn(`[EXULU] could not list session files for prompt (session ${opts.sessionID}):`, err);
  }
  if (!opts.project) return sessionBlock;

  let projectBlock = "";
  try {
    const { projectPrefix } = projectFilePrefix(opts.project.id);
    const objects = await listS3ObjectsByPrefix(projectPrefix, opts.exuluConfig!);
    const files: ListedFile[] = objects.map((o) => ({
      name: o.key.slice(o.key.indexOf(projectPrefix) + projectPrefix.length),
      size: o.size,
      lastModified: new Date(o.lastModified),
    }));
    // Flat names only, like the sandbox sync: anything nested is not addressable.
    projectBlock = describeProjectFiles(
      files.filter((f) => !f.name.includes("/")),
      opts.project.name,
      { lastTurnAt: opts.lastTurnAt },
    );
  } catch (err) {
    console.warn(`[EXULU] could not list project files for prompt (session ${opts.sessionID}):`, err);
  }
  return [sessionBlock, projectBlock].filter(Boolean).join("\n\n");
}
