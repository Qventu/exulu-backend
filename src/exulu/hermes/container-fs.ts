import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { contentTypeFor, type WorkspaceFile } from "./workspace-store";

/**
 * Direct access to an advanced-mode agent's Docker sandbox filesystem, via
 * `docker exec` / `docker cp`. This makes the container's `/root` the single
 * source of truth: the agent's NATIVE tools (read_file, python, etc.) and the
 * Files panel operate on the same files — no host/container split-brain, no
 * bind mount.
 *
 * Hermes labels its container `hermes-agent=1`; the provisioner additionally
 * stamps `exulu-profile=<profileId>` (via terminal.docker_extra_args) so we can
 * find the right container per profile. The container is persistent
 * (container_persistent), so it's available between runs once the agent has
 * used a tool at least once.
 *
 * Design doc: docs/superpowers/specs/2026-06-04-advanced-mode-workspace-files-design.md
 */

const execFileAsync = promisify(execFile);
const MAX_LIST_BUFFER = 16 * 1024 * 1024;

const profileLabel = (profileId: string): string => `exulu-profile=${profileId}`;

/**
 * Validate a sandbox-relative path: no absolute, no traversal, no hidden
 * segments (keeps `.hermes` / `.cache` / dotfiles out of reach). Returns the
 * normalized relative path, or undefined if unsafe.
 */
export const safeRelPath = (p: string): string | undefined => {
  if (!p || p.startsWith("/")) return undefined;
  const segs = p.split("/").filter((s) => s.length > 0);
  if (segs.length === 0) return undefined;
  if (segs.some((s) => s === "." || s === ".." || s.startsWith("."))) return undefined;
  return segs.join("/");
};

/** Parse `find … -printf '%s\t%T@\t%p\n'` output into WorkspaceFile[]. */
export const parseFindOutput = (
  stdout: string,
  rootDir = "/root",
): WorkspaceFile[] => {
  const prefix = rootDir.endsWith("/") ? rootDir : `${rootDir}/`;
  const files: WorkspaceFile[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const [sizeStr, mtimeStr, fullPath] = line.split("\t");
    if (!fullPath) continue;
    const rel = fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
    if (!rel || rel.split("/").some((s) => s.startsWith("."))) continue;
    files.push({
      path: rel,
      name: rel.split("/").pop()!,
      size: Number(sizeStr) || 0,
      lastModified: new Date((Number(mtimeStr) || 0) * 1000).toISOString(),
      contentType: contentTypeFor(rel),
    });
  }
  return files.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
};

const dockerPsIds = async (filters: string[]): Promise<string[]> => {
  try {
    const args = ["ps", "-q"];
    for (const f of filters) args.push("--filter", f);
    const { stdout } = await execFileAsync("docker", args);
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return []; // docker unavailable / errored
  }
};

/**
 * The running Hermes container id for a profile, or undefined if none is up.
 * Primary: our deterministic `exulu-profile=<profileId>` label. Fallback (in
 * case Hermes didn't honor docker_extra_args): if there is exactly ONE
 * hermes-managed container running, use it — correct for single-agent setups.
 */
export const resolveContainerId = async (
  profileId: string,
): Promise<string | undefined> => {
  const tagged = await dockerPsIds([
    "label=hermes-agent=1",
    `label=${profileLabel(profileId)}`,
  ]);
  if (tagged[0]) return tagged[0];

  const hermesContainers = await dockerPsIds(["label=hermes-agent=1"]);
  return hermesContainers.length === 1 ? hermesContainers[0] : undefined;
};

/**
 * The agent's actual working directory inside the container — where its native
 * tools read & write. Hermes decides this and a plain `docker exec` won't reveal
 * it (the agent runs as the host user via docker_run_as_host_user, so its cwd is
 * that user's HOME replicated in the container, e.g. /Users/<you>; a manual exec
 * is root at `/`).
 *
 * Since the gateway runs as the same OS user as this backend, the agent's home
 * IS `os.homedir()`. We probe candidate homes inside the container and use the
 * first that exists: the host-user home (host-user mode) else /root (root mode).
 * Overridable with HERMES_CONTAINER_WORKDIR.
 */
const getContainerCwd = async (id: string): Promise<string> => {
  const override = process.env.HERMES_CONTAINER_WORKDIR?.trim();
  const candidates = [
    ...(override ? [override] : []),
    homedir().replace(/\/+$/, ""),
    "/root",
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      await execFileAsync("docker", ["exec", id, "test", "-d", dir]);
      return dir;
    } catch {
      /* not present in this container */
    }
  }
  return "/root";
};

type Sandbox = { id: string; cwd: string };

const resolveSandbox = async (profileId: string): Promise<Sandbox | undefined> => {
  const id = await resolveContainerId(profileId);
  if (!id) return undefined;
  return { id, cwd: await getContainerCwd(id) };
};

/** List files in the sandbox working dir (excludes hidden dirs/files). */
export const listContainerFiles = async (
  profileId: string,
): Promise<WorkspaceFile[]> => {
  const sb = await resolveSandbox(profileId);
  if (!sb) return [];
  try {
    const { stdout } = await execFileAsync(
      "docker",
      [
        "exec",
        sb.id,
        "find",
        sb.cwd,
        "-mindepth",
        "1",
        "-name",
        ".*",
        "-prune",
        "-o",
        "-type",
        "f",
        // find converts the \t / \n escapes; we parse the real tabs/newlines.
        "-printf",
        "%s\\t%T@\\t%p\\n",
      ],
      { maxBuffer: MAX_LIST_BUFFER },
    );
    return parseFindOutput(stdout, sb.cwd);
  } catch {
    return []; // container not running / find failed
  }
};

/** Stream a file out of the sandbox; undefined if path unsafe or no container. */
export const readContainerFile = async (
  profileId: string,
  relPath: string,
): Promise<{ stream: NodeJS.ReadableStream; contentType: string } | undefined> => {
  const safe = safeRelPath(relPath);
  if (!safe) return undefined;
  const sb = await resolveSandbox(profileId);
  if (!sb) return undefined;
  const child = spawn("docker", ["exec", sb.id, "cat", "--", `${sb.cwd}/${safe}`]);
  return { stream: child.stdout, contentType: contentTypeFor(safe) };
};

/** Copy bytes into the sandbox at `<cwd>/<relPath>` (creates parent dirs). */
export const writeContainerFile = async (
  profileId: string,
  relPath: string,
  bytes: Buffer,
): Promise<void> => {
  const safe = safeRelPath(relPath);
  if (!safe) throw new Error("Invalid path");
  const sb = await resolveSandbox(profileId);
  if (!sb) {
    throw new Error(
      "The agent's sandbox isn't running yet — send the agent a message first, then upload.",
    );
  }
  const dir = safe.includes("/") ? safe.slice(0, safe.lastIndexOf("/")) : "";
  if (dir) {
    await execFileAsync("docker", ["exec", sb.id, "mkdir", "-p", `${sb.cwd}/${dir}`]);
  }
  const tmpDir = await mkdtemp(join(tmpdir(), "exulu-upload-"));
  const tmp = join(tmpDir, "file");
  await writeFile(tmp, bytes);
  try {
    await execFileAsync("docker", ["cp", tmp, `${sb.id}:${sb.cwd}/${safe}`]);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
};

/** Delete a file in the sandbox. No-op if the container isn't running. */
export const deleteContainerFile = async (
  profileId: string,
  relPath: string,
): Promise<void> => {
  const safe = safeRelPath(relPath);
  if (!safe) throw new Error("Invalid path");
  const sb = await resolveSandbox(profileId);
  if (!sb) return;
  await execFileAsync("docker", ["exec", sb.id, "rm", "-f", "--", `${sb.cwd}/${safe}`]);
};
