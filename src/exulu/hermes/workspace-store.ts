import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, sep } from "node:path";
import { profileWorkspaceDir } from "./config";

/**
 * Filesystem access to a Hermes (advanced-mode) profile's workspace — the host
 * side of the Docker bind-mount where the agent's files live. Local-direct: no
 * S3. Produces the same listing shape the non-advanced session-files feature
 * uses, so the existing file UI can be reused for both.
 *
 * Pure fs + path safety, no app/auth deps, so it stays unit-testable.
 *
 * Design doc: docs/superpowers/specs/2026-06-04-advanced-mode-workspace-files-design.md
 */

/** Matches the SessionFile shape the frontend file components consume. */
export type WorkspaceFile = {
  /** Workspace-relative path; the id used by raw/download/delete. */
  path: string;
  name: string;
  size: number;
  lastModified: string;
  contentType: string;
};

const CONTENT_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".py": "text/x-python",
  ".sh": "text/x-sh",
  ".toml": "text/x-toml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const contentTypeFor = (name: string): string =>
  CONTENT_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";

/** Default safety bounds when listing (avoid runaway dirs). */
const MAX_DEPTH = 6;
const MAX_FILES = 1000;

/**
 * Resolve a workspace-relative path to an absolute path, refusing anything that
 * escapes the workspace (`..`, absolute paths). Returns undefined if unsafe.
 */
export const resolveInWorkspace = (
  profileId: string,
  relPath: string,
): string | undefined => {
  const root = profileWorkspaceDir(profileId);
  // Normalize via join, then verify the result is still inside root.
  const abs = join(root, relPath);
  const rel = relative(root, abs);
  const segments = rel.split(sep);
  if (rel.startsWith("..") || segments.includes("..")) return undefined;
  // Refuse hidden paths: when the workspace is mounted at the container /root,
  // Hermes' own home + cache live in `.hermes` / `.cache` here — never expose
  // or let anyone delete those through the API. (Listing already skips dotfiles.)
  if (segments.some((s) => s.startsWith("."))) return undefined;
  return abs;
};

/** Recursively list files in the workspace (bounded), newest first. */
export const listWorkspaceFiles = async (
  profileId: string,
): Promise<WorkspaceFile[]> => {
  const root = profileWorkspaceDir(profileId);
  const out: WorkspaceFile[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // skip dotfiles/hidden state
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, depth + 1);
      } else if (entry.isFile()) {
        if (out.length >= MAX_FILES) return;
        const st = await stat(abs).catch(() => undefined);
        if (!st) continue;
        out.push({
          path: relative(root, abs).split(sep).join("/"),
          name: entry.name,
          size: st.size,
          lastModified: st.mtime.toISOString(),
          contentType: contentTypeFor(entry.name),
        });
      }
    }
  };

  await walk(root, 0);
  return out.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
};

/** Open a read stream + metadata for a workspace file, or undefined if missing. */
export const readWorkspaceFile = async (
  profileId: string,
  relPath: string,
): Promise<{ stream: NodeJS.ReadableStream; size: number; contentType: string } | undefined> => {
  const abs = resolveInWorkspace(profileId, relPath);
  if (!abs) return undefined;
  const st = await stat(abs).catch(() => undefined);
  if (!st || !st.isFile()) return undefined;
  return {
    stream: createReadStream(abs),
    size: st.size,
    contentType: contentTypeFor(relPath),
  };
};

/** Read a workspace file as UTF-8 text (for the MCP read tool), or undefined. */
export const readWorkspaceText = async (
  profileId: string,
  relPath: string,
): Promise<string | undefined> => {
  const abs = resolveInWorkspace(profileId, relPath);
  if (!abs) return undefined;
  return readFile(abs, "utf8").catch(() => undefined);
};

/** Write (create/overwrite) a file in the workspace; rejects unsafe paths. */
export const writeWorkspaceFile = async (
  profileId: string,
  relPath: string,
  bytes: Buffer,
): Promise<void> => {
  const abs = resolveInWorkspace(profileId, relPath);
  if (!abs) throw new Error("Invalid path");
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
};

/** Delete a file in the workspace; rejects unsafe paths. */
export const deleteWorkspaceFile = async (
  profileId: string,
  relPath: string,
): Promise<void> => {
  const abs = resolveInWorkspace(profileId, relPath);
  if (!abs) throw new Error("Invalid path");
  await rm(abs, { force: true });
};
