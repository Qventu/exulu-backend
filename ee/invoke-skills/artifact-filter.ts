/**
 * The sandbox mirrors every file a shell command creates under the session directory to
 * S3 and lists each one (with a presigned URL) in the tool result. A single
 * `python -m venv venv && pip install python-docx` creates thousands of files, which
 * turned one tool result into ~1.8M characters and killed the session's context window.
 */

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
]);

/** True when any path segment is a dependency, cache or VCS directory. */
export function isIgnoredArtifactPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/).some((segment) => IGNORED_SEGMENTS.has(segment));
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
