/**
 * The sandbox mirrors every file a shell command creates under the session directory to
 * S3 and lists each one (with a presigned URL) in the tool result. A single
 * `python -m venv venv && pip install python-docx` creates thousands of files, which
 * turned one tool result into ~1.8M characters and killed the session's context window.
 */

/** Directory (under the session dir) where the platform writes skill action inputs. */
export const ACTION_INPUTS_DIR = ".exulu-inputs";

const IGNORED_SEGMENTS = new Set([
  "venv",
  ".venv",
  "env",
  "node_modules",
  "__pycache__",
  "site-packages",
  "dist-packages",
  ".cache",
  ".git",
  ".pytest_cache",
  ".mypy_cache",
  ".ipynb_checkpoints",
  // Input files the platform writes for a skill action run; never session artifacts.
  ACTION_INPUTS_DIR,
]);

/** True when any path segment is a dependency, cache or VCS directory. */
export function isIgnoredArtifactPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/).some((segment) => IGNORED_SEGMENTS.has(segment));
}

/** True when any path segment is the action inputs directory (never mirrored, restored or listed). */
export function isActionInputsPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/).some((segment) => segment === ACTION_INPUTS_DIR);
}

export const DEFAULT_ARTIFACT_CAP = 50;

export function capArtifacts<T>(artifacts: T[], max: number = DEFAULT_ARTIFACT_CAP): { kept: T[]; omitted: number } {
  if (artifacts.length <= max) return { kept: artifacts, omitted: 0 };
  return { kept: artifacts.slice(0, max), omitted: artifacts.length - max };
}

/** Whether an S3 session file must be (re)downloaded into the live sandbox directory. */
export function needsDownload(localSize: number | undefined, remoteSize: number): boolean {
  return localSize === undefined || localSize !== remoteSize;
}

/** Header line of the download-link block the sandbox appends to a command's stdout. */
export const ARTIFACTS_BLOCK_HEADER = "[exulu-artifacts]";

/**
 * What the runner puts between the command's own stdout and the block: the block is
 * `stdout + "\n" + ["", ARTIFACTS_BLOCK_HEADER, ...entries].join("\n")`.
 */
const ARTIFACTS_BLOCK_SEPARATOR = `\n\n${ARTIFACTS_BLOCK_HEADER}\n`;

/** Appends the download-link block (the given entry lines) to stdout; unchanged when there are none. */
export function appendArtifactsBlock(stdout: string, entryLines: string[]): string {
  if (entryLines.length === 0) return stdout;
  return `${stdout}${ARTIFACTS_BLOCK_SEPARATOR}${entryLines.join("\n")}`;
}

/**
 * Splits a runner stdout into the command's own output and the trailing block appendArtifactsBlock
 * added. `hasBlock` must say whether the runner appended one (it does iff an artifact has a URL),
 * so a command that prints the header itself is never mistaken for the block.
 */
export function splitArtifactsBlock(stdout: string, hasBlock: boolean): { output: string; block: string } {
  if (!hasBlock) return { output: stdout, block: "" };
  const at = stdout.lastIndexOf(ARTIFACTS_BLOCK_SEPARATOR);
  if (at < 0) return { output: stdout, block: "" };
  return { output: stdout.slice(0, at), block: stdout.slice(at) };
}
