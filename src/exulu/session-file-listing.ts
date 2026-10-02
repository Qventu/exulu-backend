import { listS3ObjectsByPrefix } from "@SRC/uppy";
import type { ExuluConfig } from "./app";
import { isIgnoredArtifactPath } from "@EE/invoke-skills/artifact-filter";
import { sessionFilePrefix } from "./session-files";

/**
 * The system prompt told the model that uploaded files "appear in the working directory",
 * but nothing told it WHICH files exist. A user who uploads a tender PDF and asks "Wie hoch
 * ist die Tragkraft laut Leistungsverzeichnis?" got an answer from the norms knowledge base
 * instead. Listing the session files on every turn, with the ones added since the last
 * answer flagged, lets the model reach for the document first.
 */

export type SessionFileEntry = { name: string; size: number; lastModified: Date };

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

/**
 * Best-effort loader for the prompt: lists the session's files under the OWNER prefix.
 * Any failure yields an empty string so the chat never breaks because of a listing.
 */
export async function loadSessionFileListing(opts: {
  sessionID: string;
  ownerId: number | string;
  exuluConfig: ExuluConfig | undefined;
  lastTurnAt?: Date;
}): Promise<string> {
  const uploads = opts.exuluConfig?.fileUploads;
  if (!uploads?.s3Bucket) return "";
  const prefix = sessionFilePrefix(opts.ownerId, opts.sessionID, uploads.s3prefix);
  try {
    const objects = await listS3ObjectsByPrefix(prefix, opts.exuluConfig!);
    const files: SessionFileEntry[] = objects.map((o) => ({
      name: o.key.slice(o.key.indexOf(prefix) + prefix.length),
      size: o.size,
      lastModified: new Date(o.lastModified),
    }));
    return describeSessionFiles(files, { lastTurnAt: opts.lastTurnAt });
  } catch (err) {
    console.warn(`[EXULU] could not list session files for prompt (session ${opts.sessionID}):`, err);
    return "";
  }
}
