import { sessionFilePrefix } from "@SRC/exulu/session-files";
import { parseProjectFilename, projectFilePrefix } from "@SRC/exulu/project-files";

export const NO_PROJECT_FILES_ERROR = "This session has no project files.";
export const INVALID_SESSION_FILENAME_ERROR =
  "Invalid filename — pass the bare file name exactly as listed in the session files (no paths).";

/**
 * One place that turns the filename the model passes into an S3 key, shared by
 * read_session_file, parse_document and view_document_page. `project/<name>` reads from
 * the project folder, but only when the caller hands in the access-checked `projectId`
 * the sandbox uses; a plain name stays exactly what it always was (a session file).
 * The returned key is complete (general prefix included) — downstream helpers must use
 * it as is and never re-derive a session key from the bare filename.
 */
export function resolveFileKey(args: {
  filename: string;
  ownerId: string | number;
  sessionId: string;
  projectId: string | null;
  s3prefix?: string | null;
}): { key: string; scope: "session" | "project" } | { error: string } {
  const filename = String(args.filename ?? "").trim();
  const parsed = parseProjectFilename(filename);
  if ("error" in parsed) return parsed;

  if (parsed.scope === "project") {
    if (!args.projectId) return { error: NO_PROJECT_FILES_ERROR };
    const { fullProjectPrefix } = projectFilePrefix(args.projectId, args.s3prefix);
    return { key: `${fullProjectPrefix}${parsed.name}`, scope: "project" };
  }

  if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return { error: INVALID_SESSION_FILENAME_ERROR };
  }
  return {
    key: `${sessionFilePrefix(args.ownerId, args.sessionId, args.s3prefix ?? undefined)}${filename}`,
    scope: "session",
  };
}
