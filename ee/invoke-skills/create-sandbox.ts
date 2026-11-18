import {
    SandboxManager,
    type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime'
import { mkdir, rm, readdir, stat, lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, resolve, relative, posix } from 'node:path'
import { exec, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { listS3ObjectsByPrefix, getS3ObjectBytes, uploadFile, getPresignedUrl, type S3FileObject } from '@SRC/uppy/index.ts'
import { isIgnoredArtifactPath, isActionInputsPath, capArtifacts, needsDownload, appendArtifactsBlock } from './artifact-filter'
import { getNpmGlobalRoot } from '@SRC/exulu/system-dependencies.ts'
import { buildSkillEnv } from './skill-env'
import { declarationFromBytes, type PinnedSkillActions } from './skill-actions/load'
import { ACTIONS_FILE } from './skill-actions/schema'
import { isBinaryDocumentPath, looksBinary, binaryReadHint } from './binary-file-guard'
import { selectGrantedVariables, selectRowsToDecrypt, deriveWithheldNames } from './variable-grants'
import { readLiteLLMOsEnvironNames } from '@SRC/exulu/litellm/os-environ-names'
import { getAuditLogger } from '@SRC/exulu/audit/logger'
import { buildSkillSandboxEvent } from '@SRC/exulu/audit/emitters/skill-sandbox'
import type { ExuluConfig } from '@SRC/exulu/app/index.ts'
import { createBashTool, type Sandbox } from "bash-tool";
import { tool, type Tool } from "ai";
import { z } from "zod";
import { type Variable } from "@EXULU_TYPES/models/variable";
import CryptoJS from "crypto-js";
import { postgresClient } from "@SRC/postgres/client";
import { PROJECT_DIR } from "@SRC/exulu/project-files.ts";
import { ORIGIN_METADATA_KEY } from "@SRC/exulu/file-origin.ts";
import { syncProjectDir, clearProjectSyncMarker } from "./project-sync";
import { readRegularFileInside, writeFileInside, ensureRealDirectory, removeEntryInside, landsInside, UnsafeSessionPathError } from "./safe-fs";

/**
 * Load the variables an administrator has explicitly granted to the skill
 * sandbox, decrypt only those, and report the withheld NAMES — never values —
 * of every other row, so a broken skill is diagnosable from one log line.
 *
 * Filter before decrypting (per §1 of the design): rows are partitioned on
 * `allow_skill_access === true` first, so a row nobody granted never has its
 * ciphertext touched. `withheldNames` is derived from the UNFILTERED row-name
 * list, which means a row whose decryption fails surfaces as withheld rather
 * than vanishing from both sides of the report.
 *
 * Used by the skill sandbox to expose configured secrets to bash commands
 * (API keys, etc.) so skills can call external services without hard-coding
 * credentials. Decryption runs server-side; nothing encrypted leaves the
 * Node process. The grant filter (selectGrantedVariables) requires
 * `allow_skill_access === true` — a row with no grant (including legacy rows
 * with a null value from before this column existed) is never exposed.
 *
 * Variables whose name starts with `_` or contains `=` are skipped — those
 * shapes corrupt POSIX env parsing or shadow shell internals.
 */
const getAllExuluVariables = async (): Promise<{
    granted: Record<string, string>;
    withheldNames: string[];
}> => {
    const { db } = await postgresClient();
    const rows: Variable[] = await db.from("variables").select("*");

    // Partition before decrypting: only granted rows have their ciphertext
    // touched. `rows` stays the basis for withheldNames below.
    const decrypted: Variable[] = [];
    for (const row of selectRowsToDecrypt(rows)) {
        let value = row.value;
        if (row.encrypted) {
            try {
                const bytes = CryptoJS.AES.decrypt(value, process.env.NEXTAUTH_SECRET);
                value = bytes.toString(CryptoJS.enc.Utf8);
            } catch (err) {
                // Non-fatal, as before: this row simply is not available to
                // skills. deriveWithheldNames works off the unfiltered `rows`,
                // so it is reported as withheld rather than disappearing.
                console.error(
                    `[VARIABLES] Failed to decrypt variable "${row.name}"; skipping.`,
                    err,
                );
                continue;
            }
        }
        decrypted.push({ ...row, value });
    }
    const granted = selectGrantedVariables(decrypted);
    return { granted, withheldNames: deriveWithheldNames(rows, granted) };
}

const execAsync = promisify(exec);

/** Dotenv files of the running backend that a sandboxed command must not read. */
export const backendSecretFiles = (): string[] => {
    const cwd = process.cwd();
    const names = ['.env', '.env.local', '.env.production', '.env.production.local'];
    const paths = new Set<string>();
    for (const name of names) {
        paths.add(join(cwd, name));
        paths.add(join('/app', name));
    }
    return [...paths];
};
// Sandbox commands can be very long (long deny lists) — bump default buffer.
const EXEC_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Provider credentials the deployment's config.litellm.yaml names via
 * `os.environ/NAME`. Stripped from the skill environment alongside the static
 * inventory, which closes the open-ended provider-credential class without
 * turning the filter into an allowlist.
 *
 * Memoized: the config path is process-level state, and re-reading it on every
 * sandbox creation would buy nothing. Best-effort by construction — the helper
 * returns [] and logs if the config is missing or unreadable, so a sandbox
 * never fails to build because of it.
 */
let litellmSecretNamesCache: string[] | undefined;
const litellmConfigSecretNames = (): string[] => {
    if (litellmSecretNamesCache === undefined) {
        litellmSecretNamesCache = readLiteLLMOsEnvironNames();
        if (litellmSecretNamesCache.length) {
            // Names only, logged once, so a skill broken by this strip is
            // diagnosable from one line (design §5).
            console.log(
                `[SKILLS] ${litellmSecretNamesCache.length} provider credential name(s) from config.litellm.yaml are withheld from skills: ${litellmSecretNamesCache.join(", ")}.`,
            )
        }
    }
    return litellmSecretNamesCache;
};

/**
 * Probe whether bwrap can actually create a user namespace on this host.
 * SRT's own dependency check only verifies bwrap is installed, not that the
 * kernel will let it run — and the latter is what Ubuntu 24.04 (kernel 6.8+
 * with `kernel.apparmor_restrict_unprivileged_userns=1`) and Debian hosts with
 * `kernel.unprivileged_userns_clone=0` deny.
 *
 * Memoized for the process lifetime: the answer is host-level state that
 * doesn't change without a sysctl flip + restart.
 */
type SandboxProbeResult = { canSandbox: boolean; reason?: string };
let sandboxProbePromise: Promise<SandboxProbeResult> | undefined;

function probeSandboxSupport(): Promise<SandboxProbeResult> {
    if (sandboxProbePromise) return sandboxProbePromise;
    sandboxProbePromise = (async () => {
        if (process.platform === 'darwin') return { canSandbox: true };
        if (process.platform !== 'linux') {
            return { canSandbox: false, reason: `Unsupported platform: ${process.platform}` };
        }
        return await new Promise<SandboxProbeResult>((resolve) => {
            // Minimal bwrap invocation: bind / read-only and exit. If the host
            // refuses unprivileged user namespaces, this returns
            // "Operation not permitted" — same path SRT would hit on every command.
            const child = spawn('bwrap', ['--dev-bind', '/', '/', '--', '/bin/true'], { env: {} });
            let stderr = '';
            child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
            child.on('error', (err) => {
                resolve({ canSandbox: false, reason: `bwrap not executable: ${err.message}` });
            });
            child.on('exit', (code) => {
                if (code === 0) resolve({ canSandbox: true });
                else resolve({ canSandbox: false, reason: stderr.trim() || `bwrap exited ${code}` });
            });
        });
    })();
    return sandboxProbePromise;
}

const SANDBOX_FALLBACK_INSTRUCTIONS =
    'Skill sandboxing is running in DEGRADED mode: bwrap cannot create user namespaces on this host, so commands\n' +
    'execute directly. The container remains the isolation boundary and resolveSessionPath still scopes\n' +
    'readFile/writeFile to the session directory at the JS layer, but bash commands are NOT kernel-sandboxed.\n' +
    '\n' +
    'To restore full sandboxing on Ubuntu 23.10+ / 24.04+ hosts (kernel 6.5+):\n' +
    '  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\n' +
    '  echo "kernel.apparmor_restrict_unprivileged_userns=0" | sudo tee /etc/sysctl.d/60-userns.conf\n' +
    '  sudo sysctl --system\n' +
    '\n' +
    'On Debian hosts where the same symptom appears:\n' +
    '  sudo sysctl -w kernel.unprivileged_userns_clone=1\n' +
    '\n' +
    'Set EXULU_REQUIRE_SANDBOX=1 to fail startup instead of degrading.';

let degradedModeLogged = false;
function logDegradedModeOnce(reason: string | undefined): void {
    if (degradedModeLogged) return;
    degradedModeLogged = true;
    console.warn(
        `[SKILLS] ${SANDBOX_FALLBACK_INSTRUCTIONS}\n\nProbe error: ${reason ?? '(no detail)'}`,
    );
}

// This is called on every session where a skill is enabled
// each sandbox setup includes the skill files from the enabled
// skills, and uses the Anthropic Sandbox Runtime (SRT) to
// limit read and write scopes.

export interface SkillRef {
    id: string
    name: string
    s3folder: string
    current_version: number
}

export interface SessionSandboxHandle {
    /** Absolute path to the session's temporary directory, containing all downloaded skill files. */
    sessionDir: string
    /**
     * AI SDK tools exposed to the skill agent. bash-tool's defaults plus a
     * wrapped writeFile that surfaces { url, key } when the path qualifies as
     * a session artifact. Typed as a generic tool record because the wrapped
     * writeFile's output shape diverges from bash-tool's hardcoded
     * { success: boolean }.
     */
    tools: Record<string, Tool<any, any>>
    /** Wraps a shell command string so it runs inside the sandbox. */
    wrapCommand: (command: string) => Promise<string>
    /**
     * Runs a shell command in the session sandbox (same wrapping, cwd = sessionDir) with
     * `extraEnv` merged over the session env for this call only. A timeout kills the whole
     * process group (timedOut = true, exitCode 124). Files the command creates are mirrored
     * and listed in an [exulu-artifacts] block appended to stdout, exactly as `bash` does.
     */
    runCommand: (
        command: string,
        options?: { extraEnv?: Record<string, string>; timeoutMs?: number },
    ) => Promise<{
        stdout: string
        stderr: string
        exitCode: number
        timedOut: boolean
        artifacts: Array<{ path: string; relativePath: string; key?: string; url?: string }>
        artifactsOmitted?: number
    }>
    /**
     * skill id -> the skill's actions.yaml as parsed from the bytes downloaded from skill
     * storage for its installed version. Set only by a (re)download, never re-read from the
     * session directory: the agent can edit skills/<name>/actions.yaml (in degraded mode; the
     * sandbox policy denies writes under skills/ otherwise), and that must not
     * change which actions exist or what they read.
     */
    skillActions: ReadonlyMap<string, PinnedSkillActions>
    /** Tears down the sandbox and deletes the session directory. */
    cleanup: () => Promise<void>
}

/**
 * Per-sandbox, mutable: the cached sandbox outlives a turn, and the session's
 * project can change between turns (detach, re-attach, access revoked). The
 * write-back closures read it at call time, so it must not be captured once.
 */
interface ProjectState {
    projectId: string | null
}

interface CachedSandbox {
    handle: SessionSandboxHandle
    /** skill id -> installed version */
    installedSkills: Map<string, number>
    /** skill id -> pinned actions declaration (the same map the handle exposes). */
    skillActions: Map<string, PinnedSkillActions>
    projectState: ProjectState
}

const sandboxCache = new Map<string, CachedSandbox>()

/**
 * Downloads a skill version's files into skills/<name>/ and returns the bytes of its
 * root actions.yaml as fetched from storage (undefined when the version has none).
 */
async function downloadSkill(
    skill: SkillRef,
    skillsDirectory: string,
    config: ExuluConfig,
): Promise<Buffer | undefined> {
    // Skills created via the standard /skills/:skillId/initialize route always
    // get current_version=1. Older / manually-inserted rows may be missing it
    // — fall back to v1 (where the auto-generated SKILL.md lives) and warn.
    const version = skill.current_version ?? 1;
    if (!skill.current_version) {
        console.warn(
            `[SKILLS] Skill "${skill.name}" (id=${skill.id}) has no current_version set — defaulting to v1. ` +
            `Backfill the DB: UPDATE skills SET current_version = 1 WHERE id = '${skill.id}';`,
        );
    }
    const versionPrefix = `skills/${skill.id}/v${version}/`
    const files = await listS3ObjectsByPrefix(versionPrefix, config)
    console.log(
        `[SKILLS] Downloading "${skill.name}" v${version}: ${files.length} S3 object(s) under "${versionPrefix}"`,
    );

    if (files.length === 0) {
        console.warn(
            `[SKILLS] No files found for skill "${skill.name}" at prefix "${versionPrefix}". ` +
            `Check that current_version matches what was uploaded to S3.`,
        );
    }

    // The agent can replace skills/ or skills/<name> with a link; make both real
    // directories again (a link is unlinked, never followed) before writing.
    const sessionDir = dirname(skillsDirectory)
    await ensureRealDirectory(sessionDir, `skills/${skill.name}`)

    let actionsBytes: Buffer | undefined
    for (const file of files) {
        // Extract the path relative to the version prefix, accounting for any S3 general prefix
        const prefixIndex = file.key.indexOf(versionPrefix)
        const relativePath = prefixIndex >= 0
            ? file.key.slice(prefixIndex + versionPrefix.length)
            : file.key

        if (!relativePath) continue // skip directory markers

        // Binary-safe download — skill bundles can ship images, fonts, and
        // other non-text assets alongside the SKILL.md / scripts.
        const bytes = await getS3ObjectBytes(file.key, config)
        // Root of the skill only: a nested actions.yaml declares nothing.
        if (relativePath === ACTIONS_FILE) actionsBytes = Buffer.from(bytes)
        try {
            await writeFileInside(sessionDir, `skills/${skill.name}/${relativePath}`, bytes)
        } catch (err) {
            if (!(err instanceof UnsafeSessionPathError)) throw err
            console.error(`[SKILLS] Skipping skill file ${file.key}: ${err.message}`)
        }
    }
    return actionsBytes
}

/**
 * Downloads a skill and pins its actions declaration from the downloaded bytes. The old pin
 * is dropped first, so a download that fails part-way leaves the skill without actions
 * (fail closed) rather than with the previous version's.
 */
async function installSkill(
    skill: SkillRef,
    skillsDirectory: string,
    config: ExuluConfig,
    skillActions: Map<string, PinnedSkillActions>,
): Promise<void> {
    skillActions.delete(skill.id)
    const actionsBytes = await downloadSkill(skill, skillsDirectory, config)
    skillActions.set(skill.id, {
        skillId: skill.id,
        name: skill.name,
        version: skill.current_version,
        declaration: declarationFromBytes(actionsBytes),
    })
}

/**
 * Remove an installed skill's folder before it is reinstalled. skills/ itself is
 * made a real directory first, so the removal never runs through a link.
 */
async function removeInstalledSkill(skillsDirectory: string, skillName: string): Promise<void> {
    const sessionDir = dirname(skillsDirectory)
    await ensureRealDirectory(sessionDir, 'skills')
    await removeEntryInside(sessionDir, `skills/${skillName}`)
}

/** The writeFile refusal for a path that lands in skills/ (see writeFilesInternal). */
const SKILLS_READ_ONLY_MESSAGE = (path: string) =>
    `writeFile refused: "${path}" is inside the skills/ folder, which is read-only in a session. ` +
    'Write your files to the session directory instead (e.g. "./out/report.md"). ' +
    'A skill changes only when a new version of it is saved (skill_update or the skill editor); ' +
    'the session picks it up on the next turn or a reload of the skills.'

/**
 * A file written inside the sandbox qualifies as a session artifact iff it lives
 * under sessionDir but NOT under sessionDir/skills/. Skill source files are
 * authored elsewhere and should never be mirrored back to the per-session
 * artifact tree. In a project session `project/` is the read-only copy of the
 * project's shared files and is never written back either; without a project
 * the name has no special meaning.
 */
export function isArtifactPath(
    absPath: string,
    sessionDir: string,
    opts: { hasProject?: boolean } = {},
): boolean {
    const resolved = resolve(absPath)
    const rel = relative(sessionDir, resolved)
    if (!rel || rel.startsWith('..')) return false
    if (isActionInputsPath(rel)) return false
    const first = rel.split('/')[0]
    if (opts.hasProject && first === PROJECT_DIR) return false
    return first !== 'skills'
}

/**
 * Upload a file the agent produced in its sandbox. The origin marker is what the
 * file lists use to badge agent-made files; only this path sets it, so user
 * uploads (which go through other uploadFile callers) stay unmarked.
 */
export async function uploadAgentArtifact(
    content: Buffer,
    s3Key: string,
    config: ExuluConfig,
    userId: number | string | undefined,
): Promise<string> {
    return uploadFile(
        content,
        s3Key,
        config,
        { metadata: { [ORIGIN_METADATA_KEY]: 'agent' } },
        // uploadFile's user param is typed as number, but the
        // addUserPrefixToKey helper it delegates to accepts
        // number | string at runtime — pass through as-is.
        userId as unknown as number,
    )
}

function artifactS3Key(sessionId: string, relPath: string): string {
    return `sessions/${sessionId}/${relPath}`
}

/**
 * Resolve an agent-supplied path against the session sandbox root.
 *
 * Agents routinely pass paths in three shapes:
 *   1. Relative:                "skills/Review Contract/SKILL.md"
 *   2. Session-root-prefixed:   "/skills/Review Contract/SKILL.md" (LLMs love the leading slash)
 *   3. Already-absolute:        "/tmp/exulu-sessions/<sid>/skills/Review Contract/SKILL.md"
 *
 * All three should target the same file. Without normalization, shape (2) goes
 * to the host filesystem root and fails. This helper:
 *   - Returns shape (3) untouched.
 *   - Strips the leading slash from shape (2) and resolves it under sessionDir.
 *   - Resolves shape (1) under sessionDir.
 *   - Throws on any path that escapes sessionDir via "..", absolute redirection,
 *     or otherwise — defense in depth on top of the SRT sandbox.
 */
function resolveSessionPath(inputPath: string, sessionDir: string): string {
    const normalized = posix.normalize(inputPath)

    // Already correctly anchored under sessionDir.
    if (normalized === sessionDir || normalized.startsWith(sessionDir + '/')) {
        return normalized
    }

    // Strip a leading slash so absolute-looking paths get re-anchored under
    // sessionDir instead of pointing at the host filesystem root.
    const sessionRelative = normalized.startsWith('/') ? normalized.slice(1) : normalized
    const resolved = posix.resolve(sessionDir, sessionRelative)

    // Reject any path that still escapes sessionDir (e.g. "../../etc/passwd").
    if (resolved !== sessionDir && !resolved.startsWith(sessionDir + '/')) {
        throw new Error(
            `Path "${inputPath}" resolves outside the session directory. ` +
            `Use a path inside "${sessionDir}" (relative paths recommended, e.g. "out/report.md", or "skills/<name>/SKILL.md" to read a skill).`,
        )
    }

    return resolved
}

/**
 * Whether a session file from storage would land in skills/ (real-path judgement:
 * `.`/`..` segments, links and, on a case-insensitive file system, case variants all
 * resolve to the real folder). Logs the key, never the content, when it does.
 */
async function landsInSkills(sessionDir: string, localPath: string, key: string): Promise<boolean> {
    if (!(await landsInside(sessionDir, localPath, 'skills'))) return false
    console.warn(`[SKILLS] Not writing session file ${key} into the session: it lands in skills/, which only a saved skill version fills.`)
    return true
}

async function restoreArtifactsFromS3(
    sessionDir: string,
    sessionId: string,
    userId: number | string,
    config: ExuluConfig,
    opts: { onlyMissing?: boolean; skipProjectDir?: boolean } = {},
): Promise<void> {
    const userPrefix = `user_${userId}/sessions/${sessionId}/`
    let objects: S3FileObject[]
    try {
        objects = await listS3ObjectsByPrefix(userPrefix, config)
    } catch (err) {
        console.error(
            `[SKILLS] Failed to list S3 artifacts for session ${sessionId} (user ${userId}); proceeding with empty session dir.`,
            err,
        )
        return
    }

    if (objects.length === 0) return

    console.log(
        `[SKILLS] Restoring ${objects.length} S3 artifact(s) for session ${sessionId} (user ${userId}) into ${sessionDir}`,
    )

    for (const obj of objects) {
        // listS3ObjectsByPrefix prepends config.fileUploads.s3prefix to the prefix
        // we passed. Find the user_<id>/sessions/<sid>/ segment in the returned
        // key to recover the relative path inside the session dir, regardless of
        // any general prefix in the bucket.
        const idx = obj.key.indexOf(userPrefix)
        const relativePath = idx >= 0 ? obj.key.slice(idx + userPrefix.length) : ''
        if (!relativePath) continue // directory marker or unexpected key shape
        if (isIgnoredArtifactPath(relativePath)) continue // never pull dependency trees back
        // In a project session project/ belongs to the project sync; a session file
        // under that name (written before the session joined a project) would
        // otherwise be pulled in and removed again on every turn.
        if (opts.skipProjectDir && relativePath.split('/')[0] === PROJECT_DIR) continue

        const localPath = join(sessionDir, relativePath)
        // skills/ changes only from a skill's saved version (installSkill), never from a
        // session file: a key there would replace a script a later speaker runs.
        if (await landsInSkills(sessionDir, localPath, obj.key)) continue
        if (opts.onlyMissing) {
            let localSize: number | undefined
            try {
                // lstat: a link the agent planted counts as missing (the write below
                // replaces it) instead of reporting the size of whatever it points at.
                const st = await lstat(localPath)
                localSize = st.isFile() ? st.size : undefined
            } catch {
                localSize = undefined
            }
            if (!needsDownload(localSize, obj.size)) continue
        }
        try {
            // Use binary-safe fetch — session artifacts now include PDFs, .docx
            // and other binary formats (from user uploads as well as agent
            // bash-produced files). Reading as utf-8 would corrupt these.
            const bytes = await getS3ObjectBytes(obj.key, config)
            // Never writeFile into the agent-writable tree: it would follow links.
            await writeFileInside(sessionDir, relativePath, bytes, { notUnder: 'skills' })
        } catch (err) {
            console.error(
                `[SKILLS] Failed to restore artifact ${obj.key} -> ${localPath}; continuing.`,
                err,
            )
        }
    }
}

/**
 * Materialize a single S3 key into the live session sandbox directory. Used
 * by the user-upload flow: after a file lands in S3 via Uppy, we want it
 * available to the agent's readFile/bash on the next turn without waiting
 * for a process restart to trigger a full cold-start restore.
 *
 * The key MUST belong to the calling user's session prefix
 * (`user_<userId>/sessions/<sessionId>/`). Caller (route handler) is
 * responsible for that authorization check before invoking this helper.
 *
 * No-op if the session dir doesn't exist on disk yet — the cold-start
 * restore will pick the file up when the sandbox is next materialized.
 */
export async function downloadKeyIntoSandbox(opts: {
    sessionId: string
    userId: number | string
    fullS3Key: string
    config: ExuluConfig
}): Promise<{ written: boolean; localPath?: string }> {
    const { sessionId, userId, fullS3Key, config } = opts

    const sessionDir = join('/tmp', 'exulu-sessions', sessionId)
    if (!existsSync(sessionDir)) {
        // Sandbox not yet materialized; nothing to do. The cold-start restore
        // in createSessionSandbox handles this case on demand.
        return { written: false }
    }

    const userPrefix = `user_${userId}/sessions/${sessionId}/`
    const idx = fullS3Key.indexOf(userPrefix)
    if (idx < 0) {
        throw new Error(
            `downloadKeyIntoSandbox: key "${fullS3Key}" does not contain expected prefix "${userPrefix}". ` +
            `The caller must verify the key belongs to this user+session before invoking this helper.`,
        )
    }
    const relativePath = fullS3Key.slice(idx + userPrefix.length)
    if (!relativePath) return { written: false } // directory marker
    // Never into skills/ (see restoreArtifactsFromS3).
    if (await landsInSkills(sessionDir, join(sessionDir, relativePath), fullS3Key)) return { written: false }

    const bytes = await getS3ObjectBytes(fullS3Key, config)
    // Refuses ".." in the key suffix and never writes through an agent-planted link.
    const localPath = await writeFileInside(sessionDir, relativePath, bytes, { notUnder: 'skills' })

    return { written: true, localPath }
}

/**
 * Creates a sandboxed environment for a session:
 * 1. Creates a temp directory at /tmp/exulu-sessions/<sessionId>
 * 2. Downloads all files for each enabled skill into <sessionDir>/skills/<skillName>/
 * 3. Initialises the SRT SandboxManager with filesystem access scoped to sessionDir only
 *    and no network access
 *
 * If called again for the same sessionId, the existing sandbox is reused and only
 * skills that are new (or whose version differs from what's already installed) are
 * downloaded into the existing session directory.
 *
 * When `userId` is provided AND file uploads are configured, every file the agent
 * writes outside `<sessionDir>/skills/` is mirrored to S3 under
 * `user_<userId>/sessions/<sessionId>/...`. On a true cold start (no in-memory
 * cache AND no session directory on disk), previously persisted artifacts for
 * the session are restored from S3 into the fresh session directory.
 */
/**
 * Loaded lazily: python-setup resolves the package root via import.meta.url, which
 * must not be evaluated when this module is merely imported (jest runs CJS).
 */
async function resolvePythonVenvPath(): Promise<string | undefined> {
    try {
        const { getPythonVenvPath } = await import('@SRC/utils/python-setup.ts')
        return getPythonVenvPath()
    } catch (err) {
        console.warn('[SKILLS] Could not resolve the Python venv for the session sandbox; skill scripts fall back to the system python.', err)
        return undefined
    }
}

/**
 * Re-installs the given skills into an existing session sandbox regardless of
 * the versions already present — the "reload skills" action after a skill was
 * created or updated in the same conversation. Without a sandbox for the
 * session there is nothing to refresh: the next turn builds one from scratch.
 */
export async function refreshSessionSkills(
    sessionId: string,
    skills: SkillRef[],
    config: ExuluConfig,
): Promise<{ refreshed: number; sandbox: boolean }> {
    const cached = sandboxCache.get(sessionId)
    if (!cached) return { refreshed: 0, sandbox: false }
    const skillsDirectory = join(cached.handle.sessionDir, 'skills')
    let refreshed = 0
    for (const skill of skills) {
        await removeInstalledSkill(skillsDirectory, skill.name)
        await installSkill(skill, skillsDirectory, config, cached.skillActions)
        cached.installedSkills.set(skill.id, skill.current_version)
        refreshed++
    }
    return { refreshed, sandbox: true }
}

export async function createSessionSandbox(
    sessionId: string,
    skills: SkillRef[],
    config: ExuluConfig,
    userId?: number | string,
    /**
     * The agent whose turn is building this sandbox, for the
     * `skill.sandbox.created` audit event's §4 payload (id + name). Optional so
     * callers outside the agent loop are unaffected.
     */
    agent?: { id?: string; name?: string; slug?: string },
    opts: {
        /**
         * The session's project, already checked by the caller (session owner has
         * read access); null/absent = no project. Applied on every call, cache hit
         * included, because it can change between turns.
         */
        projectId?: string | null
    } = {},
): Promise<SessionSandboxHandle> {
    const cached = sandboxCache.get(sessionId)
    const projectId = opts.projectId ?? null

    // After the session restore, so project/ wins over anything else of that name.
    const syncProject = async (dir: string) => {
        try {
            await syncProjectDir({ sessionDir: dir, projectId, config })
        } catch (err) {
            console.error(`[SKILLS] Failed to sync project files into session ${sessionId}; continuing.`, err)
        }
    }

    if (cached) {
        cached.projectState.projectId = projectId
        const skillsDirectory = join(cached.handle.sessionDir, 'skills')

        for (const skill of skills) {
            const installedVersion = cached.installedSkills.get(skill.id)
            if (installedVersion === skill.current_version) continue

            if (installedVersion !== undefined) {
                // Different version installed — remove old files to avoid stale state
                await removeInstalledSkill(skillsDirectory, skill.name)
            }

            await installSkill(skill, skillsDirectory, config, cached.skillActions)
            cached.installedSkills.set(skill.id, skill.current_version)
        }

        // Files uploaded through the side panel (or by an email routine) after the
        // sandbox was created live only in S3 until re-synced; without this the agent's
        // `ls` never sees them although the system prompt promises it will.
        if (userId && config.fileUploads) {
            try {
                await restoreArtifactsFromS3(cached.handle.sessionDir, sessionId, userId, config, {
                    onlyMissing: true,
                    skipProjectDir: projectId !== null,
                })
            } catch (err) {
                console.error(`[SKILLS] Failed to re-sync S3 session files for session ${sessionId}; continuing.`, err)
            }
        }
        await syncProject(cached.handle.sessionDir)
        return cached.handle
    }

    const sessionDir = join('/tmp', 'exulu-sessions', sessionId)

    // Capture BEFORE mkdir so we can distinguish "true cold start" (no dir, no
    // cache) from "process restart" (dir exists on disk from a previous run,
    // but in-memory cache was wiped). In the restart case, local files may
    // contain writes that never reached S3 — treat them as authoritative and
    // do not overwrite them with a stale S3 restore.
    const dirExisted = existsSync(sessionDir)

    await mkdir(sessionDir, { recursive: true })

    const skillsDirectory = join(sessionDir, 'skills')
    // Exists (as a real directory) before the sandbox policy below is first applied,
    // even for a session without skills: the runtime resolves a deny path only when it
    // exists — on macOS an unresolved /tmp/... path would never match the kernel's
    // /private/tmp/... and the deny would silently not apply; on Linux a missing path
    // gets a placeholder mount file created in the session dir on the host.
    await ensureRealDirectory(sessionDir, 'skills')

    const installedSkills = new Map<string, number>()
    const skillActions = new Map<string, PinnedSkillActions>()

    // Download each skill's files from S3 into the session directory
    for (const skill of skills) {
        await installSkill(skill, skillsDirectory, config, skillActions)
        installedSkills.set(skill.id, skill.current_version)
    }

    // Persistence is only available when we have both a user and S3 config.
    const persistenceEnabled = !!(userId && config.fileUploads)
    if (!persistenceEnabled) {
        console.warn(
            `[SKILLS] S3 artifact persistence disabled for session ${sessionId} (userId=${userId ?? 'missing'}, fileUploads=${config.fileUploads ? 'configured' : 'missing'})`,
        )
    }

    // Restore artifacts from S3 only on a true cold start. If the dir already
    // existed, the local files are at least as new as S3 and may contain
    // unsaved-to-S3 writes from a prior process.
    if (userId && config.fileUploads) {
        // Cold start restores everything; a surviving on-disk dir only fetches what changed.
        await restoreArtifactsFromS3(sessionDir, sessionId, userId, config, {
            onlyMissing: dirExisted,
            skipProjectDir: projectId !== null,
        })
    }
    await syncProject(sessionDir)

    const projectState: ProjectState = { projectId }

    // Probe whether bwrap can actually create namespaces on this host. On a
    // failure, either throw (strict mode) or degrade to direct exec.
    const probe = await probeSandboxSupport();
    const useDirectExec = !probe.canSandbox;
    if (useDirectExec) {
        if (process.env.EXULU_REQUIRE_SANDBOX === '1') {
            throw new Error(
                `[SKILLS] Sandbox required (EXULU_REQUIRE_SANDBOX=1) but unavailable.\n\n${SANDBOX_FALLBACK_INSTRUCTIONS}\n\nProbe error: ${probe.reason ?? '(no detail)'}`,
            );
        }
        logDegradedModeOnce(probe.reason);
    }

    // SRT's `SandboxManager.initialize()` is a one-shot singleton (see
    // node_modules/@anthropic-ai/sandbox-runtime/.../sandbox-manager.js:187-191);
    // the first config wins and later calls are no-ops. That's incompatible
    // with the per-session policy we want, so we initialize the singleton
    // ONCE with empty allowRead/allowWrite (a safe, restrictive baseline) and
    // rely on `wrapWithSandbox(cmd, _, customConfig)` to override the policy
    // per call. Every command this session runs passes the session-scoped
    // `sessionSandboxConfig` below, so the kernel only ever sees this
    // session's dir in the allow list — concurrent sessions stay isolated.
    const baselineSandboxConfig: SandboxRuntimeConfig = {
        network: {
            allowedDomains: [], // block all network by default
            deniedDomains: [],
        },
        filesystem: {
            denyRead: ['~'],
            allowRead: [], // no reads allowed without per-call customConfig
            allowWrite: [], // no writes allowed without per-call customConfig
            denyWrite: [],
        },
    }

    if (!useDirectExec) {
        await SandboxManager.initialize(baselineSandboxConfig)
    }

    // Resolve the global node_modules directory so skill-generated scripts
    // can `require()` packages installed via `npm install -g <pkg>` (e.g. the
    // docx skill imports the `docx` package). We need both:
    //   1. Read access to that path inside the sandbox policy, and
    //   2. NODE_PATH set in the bash env so Node's resolver looks there.
    // Resolved once and memoized in system-dependencies.ts; null when npm
    // isn't on PATH (skill scripts that depend on global packages will then
    // fail with a clear MODULE_NOT_FOUND, matching what the user would see
    // outside the sandbox).
    const npmGlobalRoot = await getNpmGlobalRoot()
    // The @exulu/backend Python venv carries the skill runtime deps (python-docx …).
    // Put its bin dir first on PATH so `python3` inside the sandbox resolves to it.
    const pythonVenvPath = await resolvePythonVenvPath()

    // Per-session policy. Passed to every wrapWithSandbox() invocation made
    // from within this closure. customConfig wins over the singleton's
    // baseline, so each session ends up with a kernel policy that only
    // allows its own sessionDir.
    const sessionSandboxConfig: Partial<SandboxRuntimeConfig> = {
        network: {
            allowedDomains: [], // todo
            deniedDomains: [], // todo
        },
        filesystem: {
            // The backend's own dotenv file sits under the process cwd (and
            // /app in the shipped image); a bash command could otherwise
            // `cat` the database password out of it (seen in an ALGI session
            // 2026-10-07). Deny it explicitly — the rest of the tree stays
            // readable for node_modules / skill assets.
            denyRead: ['~', ...backendSecretFiles()],
            allowRead: [
                sessionDir,
                // Allow Node to read globally-installed packages from inside
                // the sandbox. Without this, `require('docx')` fails with
                // EPERM even when NODE_PATH points the resolver here.
                ...(npmGlobalRoot ? [npmGlobalRoot] : []),
                ...(pythonVenvPath ? [pythonVenvPath] : []),
            ],
            allowWrite: [sessionDir],
            // Skill folders are read-only inside the sandbox; only the platform (this
            // process: download, version re-sync, reload, removal) writes them. A script
            // runs with the rights of whoever triggers it — in a shared session another
            // speaker — so nothing run in the sandbox may change what a later run executes.
            // The runtime layers this deny over the session-dir allow:
            //  - macOS (seatbelt): `deny file-write*` + `deny file-write-unlink` on the
            //    subpath come after the allow (later rules win), and unlink of each
            //    ancestor is denied, so a rename of skills/ or a skill's folder fails too.
            //  - Linux (bwrap): `--ro-bind skills skills` after the session-dir `--bind`;
            //    writes get EROFS, renaming the mount point EBUSY, links into it EXDEV.
            // Paths are resolved through symlinks when each command is wrapped, which is
            // why skills/ is created above before the first command.
            // Not enforced in degraded mode (useDirectExec): nothing is. The writeFile
            // tool refuses skills/ paths itself; bash and runCommand cannot be confined.
            denyWrite: [skillsDirectory],
        },
    }

    // Todo proper instructions to use skills

    /* const bashTool = function createBashTool() {
        return tool({
            description: `
            Execute bash commands inside the sandbox.
            Examples (not exhaustive): ls, cat, less, head, tail, grep
            `,
            inputSchema: z.object({
                command: z.string().describe('The bash command to execute'),
                args: z.array(z.string()).describe('Arguments to pass to the command')
            }),
            execute: async ({ command, args }) => {
                // code that executes when the tool is called
                return await SandboxManager.wrapWithSandbox(command)
            }
        });
    } */

    // Load every configured Exulu variable into the sandbox env so skill
    // scripts can reach external services (API keys, etc.) without the user
    // hard-coding credentials. Decryption happens server-side in
    // ExuluVariables.getAll; encrypted blobs never leave the Node process.
    // Failure to load is non-fatal — bash commands still run, they just
    // won't see the variables (an empty map is the same as nothing
    // configured).
    let configuredVariables: Record<string, string> = {}
    let withheldNames: string[] = []
    try {
        const loaded = await getAllExuluVariables()
        configuredVariables = loaded.granted
        withheldNames = loaded.withheldNames
    } catch (err) {
        console.error(
            `[SKILLS] Failed to load configured variables for session ${sessionId}; bash env will not include them.`,
            err,
        )
    }

    // Environment for sandboxed bash invocations. buildSkillEnv is the only
    // place this is composed: base runtime env (platform secrets stripped —
    // both the static inventory and the deployment's own
    // config.litellm.yaml `os.environ/` names) → granted variables → computed
    // overrides (NODE_PATH / venv PATH last, so they always win regardless of
    // what process.env or variables already had).
    const { env: sandboxedExecEnv, strippedSecretNames, grantedNames, skippedNames } =
        buildSkillEnv({
            processEnv: process.env,
            grantedVariables: configuredVariables,
            extraSecretNames: litellmConfigSecretNames(),
            overrides: {
                ...(npmGlobalRoot ? { NODE_PATH: npmGlobalRoot } : {}),
                ...(pythonVenvPath
                    ? { PATH: `${join(pythonVenvPath, 'bin')}:${process.env.PATH ?? ''}`, VIRTUAL_ENV: pythonVenvPath }
                    : {}),
            },
        })

    if (skippedNames.length) {
        console.warn(
            `[SKILLS] Skipped ${skippedNames.length} variable(s) for session ${sessionId}: ${skippedNames.join(", ")} (invalid env name or collides with a runtime key).`,
        )
    }

    // One audit event per sandbox creation, gated by
    // sources.skillSandbox.enabled (off by default — see
    // src/exulu/audit/config.ts). Every name array below is key-derived —
    // grantedNames/skippedNames come from buildSkillEnv, withheldNames from
    // getAllExuluVariables' row.name filter — never a row's value, so no
    // credential value can ride along in this event.
    const auditLogger = getAuditLogger(config)
    if (auditLogger.shouldAuditSkillSandbox()) {
        // An audit sink exception must never deny a user their skill: the
        // sandbox is already built at this point, and the event is a record of
        // it, not a precondition for it.
        try {
            auditLogger.record(
                buildSkillSandboxEvent({
                    sessionID: sessionId,
                    agent,
                    user: userId !== undefined ? { id: userId } : undefined,
                    skills: skills.map((s) => ({ id: s.id, name: s.name, version: s.current_version })),
                    grantedNames,
                    withheldNames,
                    skippedNames,
                    strippedSecretCount: strippedSecretNames.length,
                    degradedSandbox: useDirectExec,
                }),
            )
        } catch (err) {
            console.error(
                `[SKILLS] audit: skill-sandbox emit failed for session ${sessionId}; continuing.`,
                err,
            )
        }
    }

    if (withheldNames.length) {
        console.log(
            `[SKILLS] Session ${sessionId}: ${withheldNames.length} variable(s) not shared with skills: ${withheldNames.join(", ")}.`,
        )
    }

    // Either wrap a command with bwrap/sandbox-exec or return it unchanged when
    // the host can't sandbox. In degraded mode the container itself is the
    // isolation boundary; resolveSessionPath still scopes readFile/writeFile, and
    // writeFilesInternal still refuses skills/. A bash command or a skill action can
    // then still change skills/ (or anything else the backend user may write): that
    // limit is stated in the authoring guide and the docs.
    const wrapIfNeeded = async (command: string): Promise<string> => {
        if (useDirectExec) return command;
        return SandboxManager.wrapWithSandbox(command, undefined, sessionSandboxConfig);
    };

    // wrapWithSandbox only constructs the sandbox-exec invocation string —
    // it does NOT run it. We have to shell out ourselves and capture the
    // real stdout/stderr/exitCode. The third arg passes the per-session
    // policy so the kernel only allows this session's dir, not whatever
    // baseline the singleton was initialized with.
    const runWrapped = async (command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        const wrapped = await wrapIfNeeded(command);
        try {
            const { stdout, stderr } = await execAsync(wrapped, {
                maxBuffer: EXEC_MAX_BUFFER,
                shell: '/bin/bash',
                env: sandboxedExecEnv,
            });
            return { stdout, stderr, exitCode: 0 };
        } catch (error: any) {
            return {
                stdout: error?.stdout ?? "",
                stderr: error?.stderr ?? (typeof error?.message === "string" ? error.message : String(error)),
                exitCode: typeof error?.code === "number" ? error.code : 1,
            };
        }
    };

    const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

    const customSandbox: Sandbox = {
        async executeCommand(command) {
            return await runWrapped(command);
        },
        async readFile(path) {
            // Surface cat's stderr + exit code as a thrown error. Returning
            // empty stdout silently is dangerous — a typo'd path looks
            // indistinguishable from an empty file, and the agent will
            // rationally conclude the file is empty and skip it. Throwing
            // forces the agent to see the real failure (e.g. "No such file
            // or directory") and self-correct.
            const { stdout, stderr, exitCode } = await runWrapped(`cat ${shellQuote(path)}`);
            if (exitCode !== 0) {
                throw new Error(
                    `readFile ${path} failed (exit ${exitCode}): ${stderr.trim() || 'no stderr captured'}`,
                );
            }
            return stdout;
        },
        async writeFiles(files) {
            // Sandbox interface requires Promise<void>. The rich return shape
            // (with presigned URLs) is consumed by the wrapped writeFile tool
            // below, which calls writeFilesInternal directly.
            await writeFilesInternal(files)
        },
    };

    // Single source of truth for "write a batch of files". Does the local
    // write, optionally uploads each artifact to S3, and resolves a presigned
    // URL per uploaded file. Failures in the S3 leg are non-fatal: the local
    // write already succeeded, so we log and return without url/key for that
    // entry rather than failing the whole tool call.
    type WriteResult = {
        /** Absolute path inside the sandbox. */
        path: string
        /** Short-lived presigned URL for the uploaded artifact, when applicable. */
        url?: string
        /** Full S3 key (bucket-prefixed) of the uploaded artifact, when applicable. */
        key?: string
    }

    /**
     * Upload a single artifact to S3 and return its presigned download URL.
     * Returns an empty object when persistence is disabled, when the path is
     * outside the artifact tree (e.g. under skills/), or when the upload /
     * presign step fails (failures are logged and treated as non-fatal so the
     * caller — writeFile, bash, etc. — still succeeds locally).
     *
     * Shared by writeFilesInternal (for explicit writeFile calls) and the
     * bash wrapper (which scans for files the agent created via shell
     * commands like `node create_doc.js`).
     */
    // Callers read this ONCE at the start of a tool call and pass it down: a
    // concurrent detach can flip projectState mid-command, before its sync has
    // removed project/, and a flag re-read in between would upload the project
    // copy to the session as agent files. The reverse (an attach mid-command,
    // whose sync writes project/ while the command runs) is covered by also
    // checking the flag after the command: project/ is skipped if EITHER says so.
    const hasProjectNow = () => projectState.projectId !== null

    async function persistArtifactToS3(
        absPath: string,
        content: Buffer,
        hasProject: boolean,
    ): Promise<{ key?: string; url?: string }> {
        if (!persistenceEnabled || !isArtifactPath(absPath, sessionDir, { hasProject })) {
            return {}
        }
        const rel = relative(sessionDir, resolve(absPath))
        const s3Key = artifactS3Key(sessionId, rel)
        const out: { key?: string; url?: string } = {}
        try {
            const fullKey = await uploadAgentArtifact(content, s3Key, config, userId)
            out.key = fullKey
            // uploadFile returns "<bucket>/<key>" — split to call
            // getPresignedUrl, which expects bucket and key separately.
            const slashIdx = fullKey.indexOf('/')
            if (slashIdx > 0) {
                const bucket = fullKey.slice(0, slashIdx)
                const keyOnly = fullKey.slice(slashIdx + 1)
                try {
                    out.url = await getPresignedUrl(bucket, keyOnly, config)
                } catch (err) {
                    console.error(
                        `[SKILLS] Upload succeeded but presign failed for ${fullKey}; continuing without URL.`,
                        err,
                    )
                }
            }
        } catch (err) {
            console.error(
                `[SKILLS] Failed to upload artifact ${s3Key} for session ${sessionId} (user ${userId}); continuing.`,
                err,
            )
        }
        return out
    }

    async function writeFilesInternal(
        files: Array<{ path: string; content: string | Buffer }>,
        hasProject: boolean = hasProjectNow(),
    ): Promise<WriteResult[]> {
        const results: WriteResult[] = []

        // All paths are checked before any is written, and before anything touches
        // disk: the refusal holds in degraded mode too, where no sandbox policy exists.
        for (const file of files) {
            if (await landsInside(sessionDir, file.path, 'skills')) {
                throw new Error(SKILLS_READ_ONLY_MESSAGE(file.path))
            }
        }

        for (const file of files) {
            // Pipe content via stdin so arbitrary file content (quotes, $, etc.)
            // doesn't need to be escaped into the shell command.
            const wrapped = await wrapIfNeeded(
                `mkdir -p ${shellQuote(dirname(file.path))} && cat > ${shellQuote(file.path)}`,
            )
            await new Promise<void>((resolveSpawn, rejectSpawn) => {
                const child = spawn('/bin/bash', ['-c', wrapped], { env: sandboxedExecEnv })
                let stderr = ''
                child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
                child.on('error', rejectSpawn)
                child.on('exit', (code) => {
                    if (code === 0) resolveSpawn()
                    else rejectSpawn(new Error(`writeFile ${file.path} failed (exit ${code}): ${stderr}`))
                })
                child.stdin.write(file.content)
                child.stdin.end()
            })

            const result: WriteResult = { path: file.path }

            // Mirror artifact writes to S3 + generate a presigned URL so the
            // tool output can surface a viewable link to the user.
            const persisted = await persistArtifactToS3(
                file.path,
                Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content),
                hasProject || hasProjectNow(),
            )
            if (persisted.key) result.key = persisted.key
            if (persisted.url) result.url = persisted.url

            results.push(result)
        }

        return results
    }

    /**
     * Walk the session directory and return a Map of absolute file paths →
     * mtimeMs. Used by the bash wrapper to detect files created or modified
     * by a shell command, so we can mirror them to S3 the same way writeFile
     * does. The skills/ subdir is excluded — those are source-of-truth from
     * S3 and shouldn't round-trip back as artifacts.
     */
    async function snapshotSessionArtifacts(hasProject: boolean): Promise<Map<string, number>> {
        const map = new Map<string, number>()
        const skillsDir = join(sessionDir, 'skills')
        const projectDir = hasProject ? join(sessionDir, PROJECT_DIR) : null
        const walk = async (dir: string): Promise<void> => {
            let entries
            try {
                entries = await readdir(dir, { withFileTypes: true })
            } catch {
                return
            }
            for (const entry of entries) {
                const full = join(dir, entry.name)
                if (full === skillsDir) continue
                if (projectDir !== null && full === projectDir) continue
                if (isIgnoredArtifactPath(relative(sessionDir, full))) continue
                if (entry.isDirectory()) {
                    await walk(full)
                } else if (entry.isFile()) {
                    try {
                        const s = await stat(full)
                        map.set(full, s.mtimeMs)
                    } catch {
                        // File could have disappeared between readdir and stat.
                        // Ignoring is fine — it just won't appear in the diff.
                    }
                }
            }
        }
        await walk(sessionDir)
        return map
    }

    const { tools } = await createBashTool({
        sandbox: customSandbox,
        // The bash-tool defaults to /workspace and prepends `cd /workspace &&`
        // to every command. Point it at our session dir so commands actually
        // have a valid cwd and resolve relative paths against the skill files.
        destination: sessionDir,
    });

    // Replace bash-tool's writeFile tool. Its built-in version discards the
    // sandbox return value and emits a hardcoded { success: true }, which
    // strips the presigned URL we generated. The wrapper re-implements the
    // same shape and surfaces { path, url, key } from writeFilesInternal so
    // the frontend can render a viewable link to the artifact. Uses
    // resolveSessionPath so leading-slash paths from the agent (e.g.
    // "/skills/foo/SKILL.md") get re-anchored under sessionDir instead of
    // pointing at the host root.
    const writeFileTool = tool({
        description:
            'Write content to a file in the sandbox. Creates parent directories if needed. ' +
            'Paths are always resolved against the session sandbox root — both relative paths ' +
            '("report.md", "out/report.md") and leading-slash paths ("/out/report.md") work and reach the same file. ' +
            'The skills/ folder is read-only: a path inside it is refused. A skill changes only when a new version ' +
            'of it is saved (skill_update or the skill editor); write your own files to the session directory. ' +
            'When the path is under the session artifact tree, the file is also uploaded to S3 ' +
            'and a short-lived presigned URL is returned in the tool output.',
        inputSchema: z.object({
            path: z.string().describe('The path where the file should be written. Relative paths and leading-slash paths are both resolved against the session sandbox root.'),
            content: z.string().describe('The content to write to the file'),
        }),
        execute: async ({ path, content }) => {
            const hasProject = hasProjectNow()
            const resolvedPath = resolveSessionPath(path, sessionDir)
            const results = await writeFilesInternal([{ path: resolvedPath, content }], hasProject)
            const result = results[0]
            if (!result) {
                // writeFilesInternal always returns one entry per input file;
                // this branch is unreachable but keeps TS happy without `!`.
                throw new Error(`writeFile ${resolvedPath} produced no result`)
            }
            return {
                success: true,
                path: result.path,
                ...(result.url ? { url: result.url } : {}),
                ...(result.key ? { key: result.key } : {}),
            }
        },
    })

    // Replace bash-tool's readFile tool with one that normalizes paths through
    // resolveSessionPath. bash-tool's default uses posix.resolve(cwd, path)
    // which leaves leading-slash paths anchored at the host filesystem root —
    // the SRT sandbox then denies the read and the agent sees "No such file or
    // directory" even though the file exists under sessionDir.
    const readFileTool = tool({
        description:
            'Read the contents of a file from the sandbox. ' +
            'Paths are always resolved against the session sandbox root — both relative paths ' +
            '("skills/<Skill name>/SKILL.md") and leading-slash paths ("/skills/<Skill name>/SKILL.md") work and reach the same file. ' +
            'Skills live in a folder per skill: "skills/<Skill name>/SKILL.md", never "skills/<Skill name>.md". ' +
            'If the file does not exist, the error message is surfaced verbatim.',
        inputSchema: z.object({
            path: z.string().describe('The path of the file to read. Relative paths and leading-slash paths are both resolved against the session sandbox root.'),
        }),
        execute: async ({ path }) => {
            const resolvedPath = resolveSessionPath(path, sessionDir)
            // Binary documents never go to the model as raw bytes (see
            // binary-file-guard.ts). Returned, not thrown: a throw fails the
            // whole step in a routine, a hint lets the agent self-correct.
            if (isBinaryDocumentPath(resolvedPath)) {
                return { content: '', error: binaryReadHint(path) }
            }
            const content = await customSandbox.readFile(resolvedPath)
            if (looksBinary(content)) {
                return { content: '', error: binaryReadHint(path) }
            }
            return { content }
        },
    })

    // Wrap bash so files created by shell commands (e.g. `node create_doc.js`
    // producing output.docx) get mirrored to S3 the same way explicit
    // writeFile calls do. bash-tool's built-in bash tool just shells out and
    // returns stdout/stderr/exitCode; without this wrapper the file lands in
    // the session dir on disk but never gets persisted or surfaced as a
    // download link, so the agent has no way to share its output with the
    // user. The wrapper:
    //   1. Snapshots file mtimes under sessionDir (excluding skills/) before
    //      the command runs.
    //   2. Calls the original bash tool's execute.
    //   3. Snapshots again, diffs to find new or modified files.
    //   4. Uploads each via persistArtifactToS3 (shared with writeFile).
    //   5. Returns an `artifacts` array on the tool result AND appends an
    //      [exulu-artifacts] block to stdout so the model surfaces the URLs
    //      naturally in its reply.
    // Shared by `bash` and `runCommand`: snapshot, run, snapshot, diff, mirror the changed
    // files to S3, and append the [exulu-artifacts] block to stdout (see the comment above).
    async function runWithArtifactMirroring<R extends { stdout?: string }>(
        execute: () => Promise<R>,
    ): Promise<
        Omit<R, 'stdout'> & {
            stdout: string
            artifacts: Array<{ path: string; relativePath: string; key?: string; url?: string }>
            artifactsOmitted?: number
        }
    > {
        // Fixed for this command: both snapshots and the persist check use it.
        const hasProject = hasProjectNow()
        const before = persistenceEnabled
            ? await snapshotSessionArtifacts(hasProject)
            : null
        const result = await execute()

        // Determine new/modified files since the snapshot. mtimeMs strictly
        // greater than the before-value catches "modified"; absence in
        // `before` catches "new".
        const artifacts: Array<{
            path: string
            relativePath: string
            key?: string
            url?: string
        }> = []
        if (persistenceEnabled && before) {
            // Read once more after the command (see hasProjectNow).
            const skipProject = hasProject || hasProjectNow()
            const after = await snapshotSessionArtifacts(skipProject)
            const changedPaths: string[] = []
            for (const [path, mtime] of after) {
                const beforeMtime = before.get(path)
                if (beforeMtime === undefined || beforeMtime < mtime) {
                    changedPaths.push(path)
                }
            }
            for (const path of changedPaths) {
                try {
                    // Never fsReadFile here: the agent may have swapped the file (or a
                    // parent directory) for a link to something the sandbox denies,
                    // and this read runs with the backend's rights.
                    const content = await readRegularFileInside(sessionDir, path)
                    if (content === null) continue
                    const persisted = await persistArtifactToS3(path, content, skipProject)
                    artifacts.push({
                        path,
                        relativePath: relative(sessionDir, path),
                        key: persisted.key,
                        url: persisted.url,
                    })
                } catch (err) {
                    console.error(
                        `[SKILLS] Failed to mirror bash-produced artifact ${path} to S3; continuing.`,
                        err,
                    )
                }
            }
        }

        // Surface URLs in stdout so the agent sees them and includes them
        // in its reply. We append after bash-tool's truncation pass so the
        // marker block isn't truncated. Only files with a presigned URL
        // appear here; locally-only entries would just confuse the user.
        let stdout = result?.stdout ?? ''
        // Cap the listing: one command can touch thousands of files, and every
        // entry carries a presigned URL. The full set is still mirrored to S3.
        const { kept, omitted } = capArtifacts(artifacts)
        const withUrls = kept.filter((a) => a.url)
        if (withUrls.length > 0) {
            const lines: string[] = []
            for (const a of withUrls) {
                lines.push(`  ${a.relativePath}: ${a.url}`)
            }
            if (omitted > 0) {
                lines.push(`  … ${omitted} more file(s) were created and mirrored but are not listed here.`)
            }
            stdout = appendArtifactsBlock(stdout, lines)
        }

        return {
            ...result,
            stdout,
            artifacts: kept,
            ...(omitted > 0 ? { artifactsOmitted: omitted } : {}),
        }
    }

    const originalBashTool = tools.bash
    const bashTool = tool({
        description: originalBashTool.description ?? '',
        inputSchema: z.object({
            command: z.string().describe('The bash command to execute.'),
        }),
        execute: async (args, opts) => {
            // Defer to bash-tool's bash tool so we keep its truncation, cwd
            // pinning, and any future bash-tool behaviour for free.
            const originalExecute = originalBashTool.execute as
                | ((input: { command: string }, options: any) => Promise<any>)
                | undefined
            if (!originalExecute) {
                throw new Error('bash tool execute is undefined')
            }
            return runWithArtifactMirroring(() => originalExecute(args, opts))
        },
    })

    // Programmatic command runner (skill actions): sandbox-wrapped, per-call extra env,
    // optional timeout. The env is a fresh object per call; sandboxedExecEnv is never mutated.
    const runCommand: SessionSandboxHandle['runCommand'] = (command, options = {}) =>
        runWithArtifactMirroring(async () => {
            // cd inside the wrapped command too (as bash-tool does): the spawn cwd alone
            // cannot be relied on under a real sandbox wrapper. sessionDir is platform-controlled.
            const wrapped = await wrapIfNeeded(`cd ${shellQuote(sessionDir)} && ${command}`)
            const callEnv = { ...sandboxedExecEnv, ...(options.extraEnv ?? {}) }
            return await new Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>((resolvePromise) => {
                // detached: own process group, so a timeout can kill the whole tree.
                const child = spawn('/bin/bash', ['-c', wrapped], { env: callEnv, cwd: sessionDir, detached: true })
                let stdout = ''
                let stderr = ''
                let timedOut = false
                let settled = false
                let timer: NodeJS.Timeout | undefined
                // setEncoding: the stream's decoder carries a multi-byte character split across
                // chunks over to the next one (chunk.toString would turn each half into U+FFFD).
                const append = (cur: string, chunk: string) =>
                    cur.length >= EXEC_MAX_BUFFER ? cur : (cur + chunk).slice(0, EXEC_MAX_BUFFER)
                child.stdout?.setEncoding('utf8')
                child.stderr?.setEncoding('utf8')
                child.stdout?.on('data', (c: string) => { stdout = append(stdout, c) })
                child.stderr?.on('data', (c: string) => { stderr = append(stderr, c) })
                const finish = (exitCode: number) => {
                    if (settled) return
                    settled = true
                    if (timer) clearTimeout(timer)
                    resolvePromise({ stdout, stderr, exitCode: timedOut ? 124 : exitCode, timedOut })
                }
                if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
                    timer = setTimeout(() => {
                        timedOut = true
                        try {
                            if (child.pid) process.kill(-child.pid, 'SIGKILL')
                        } catch {
                            child.kill('SIGKILL')
                        }
                    }, options.timeoutMs)
                }
                child.on('error', (err) => {
                    stderr = `${stderr}${err.message}`
                    finish(1)
                })
                child.on('close', (code, signal) => finish(typeof code === 'number' ? code : signal ? 128 : 1))
            })
        })

    const wrappedTools = { ...tools, bash: bashTool, readFile: readFileTool, writeFile: writeFileTool }

    const handle: SessionSandboxHandle = {
        sessionDir,
        tools: wrappedTools,
        wrapCommand: (command: string) => wrapIfNeeded(command),
        runCommand,
        skillActions,
        cleanup: async () => {
            sandboxCache.delete(sessionId)
            if (!useDirectExec) {
                await SandboxManager.reset()
            }
            await rm(sessionDir, { recursive: true, force: true })
            await clearProjectSyncMarker(sessionDir)
        },
    }

    sandboxCache.set(sessionId, { handle, installedSkills, skillActions, projectState })

    return handle
}
