import {
    SandboxManager,
    type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime'
import { mkdir, rm, writeFile, readFile as fsReadFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, resolve, relative, posix } from 'node:path'
import { exec, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { listS3ObjectsByPrefix, getS3ObjectBytes, uploadFile, getPresignedUrl, type S3FileObject } from '@SRC/uppy/index.ts'
import { getNpmGlobalRoot } from '@SRC/exulu/system-dependencies.ts'
import type { ExuluConfig } from '@SRC/exulu/app/index.ts'
import { createBashTool, type Sandbox } from "bash-tool";
import { tool, type Tool } from "ai";
import { z } from "zod";
import { type Variable } from "@EXULU_TYPES/models/variable";
import CryptoJS from "crypto-js";
import { postgresClient } from "@SRC/postgres/client";

/**
 * Load every variable from the database with its decrypted value. Returns
 * a name → value map suitable for spreading into a child-process env.
 *
 * Used by the skill sandbox to expose configured secrets to bash commands
 * (API keys, etc.) so skills can call external services without hard-coding
 * credentials. Decryption runs server-side; nothing encrypted leaves the
 * Node process.
 *
 * Variables whose name starts with `_` or contains `=` are skipped — those
 * shapes corrupt POSIX env parsing or shadow shell internals.
 */
const getAllExuluVariables = async (): Promise<Record<string, string>> => {
    const { db } = await postgresClient();
    const rows: Variable[] = await db.from("variables").select("*");
    const out: Record<string, string> = {};
    for (const row of rows) {
        if (!row?.name) continue;
        if (row.name.startsWith("_")) continue;
        if (row.name.includes("=")) continue;
        let value = row.value;
        if (row.encrypted) {
            try {
                const bytes = CryptoJS.AES.decrypt(value, process.env.NEXTAUTH_SECRET);
                value = bytes.toString(CryptoJS.enc.Utf8);
            } catch (err) {
                console.error(
                    `[VARIABLES] Failed to decrypt variable "${row.name}"; skipping.`,
                    err,
                );
                continue;
            }
        }
        if (typeof value !== "string") continue;
        out[row.name] = value;
    }
    return out;
}

const execAsync = promisify(exec);
// Sandbox commands can be very long (long deny lists) — bump default buffer.
const EXEC_MAX_BUFFER = 32 * 1024 * 1024;

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
    /** Tears down the sandbox and deletes the session directory. */
    cleanup: () => Promise<void>
}

interface CachedSandbox {
    handle: SessionSandboxHandle
    /** skill id -> installed version */
    installedSkills: Map<string, number>
}

const sandboxCache = new Map<string, CachedSandbox>()

async function downloadSkill(
    skill: SkillRef,
    skillsDirectory: string,
    config: ExuluConfig,
): Promise<void> {
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

    for (const file of files) {
        // Extract the path relative to the version prefix, accounting for any S3 general prefix
        const prefixIndex = file.key.indexOf(versionPrefix)
        const relativePath = prefixIndex >= 0
            ? file.key.slice(prefixIndex + versionPrefix.length)
            : file.key

        if (!relativePath) continue // skip directory markers

        const localPath = join(skillsDirectory, skill.name, relativePath)
        await mkdir(dirname(localPath), { recursive: true })

        // Binary-safe download — skill bundles can ship images, fonts, and
        // other non-text assets alongside the SKILL.md / scripts.
        const bytes = await getS3ObjectBytes(file.key, config)
        await writeFile(localPath, bytes)
    }
}

/**
 * A file written inside the sandbox qualifies as a session artifact iff it lives
 * under sessionDir but NOT under sessionDir/skills/. Skill source files are
 * authored elsewhere and should never be mirrored back to the per-session
 * artifact tree.
 */
function isArtifactPath(absPath: string, sessionDir: string): boolean {
    const resolved = resolve(absPath)
    const rel = relative(sessionDir, resolved)
    if (!rel || rel.startsWith('..')) return false
    const first = rel.split('/')[0]
    return first !== 'skills'
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
            `Use a path inside "${sessionDir}" (relative paths recommended, e.g. "skills/<name>/SKILL.md").`,
        )
    }

    return resolved
}

async function restoreArtifactsFromS3(
    sessionDir: string,
    sessionId: string,
    userId: number | string,
    config: ExuluConfig,
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

        const localPath = join(sessionDir, relativePath)
        try {
            // Use binary-safe fetch — session artifacts now include PDFs, .docx
            // and other binary formats (from user uploads as well as agent
            // bash-produced files). Reading as utf-8 would corrupt these.
            const bytes = await getS3ObjectBytes(obj.key, config)
            await mkdir(dirname(localPath), { recursive: true })
            await writeFile(localPath, bytes)
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

    const localPath = join(sessionDir, relativePath)

    const bytes = await getS3ObjectBytes(fullS3Key, config)
    await mkdir(dirname(localPath), { recursive: true })
    await writeFile(localPath, bytes)

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
export async function createSessionSandbox(
    sessionId: string,
    skills: SkillRef[],
    config: ExuluConfig,
    userId?: number | string,
): Promise<SessionSandboxHandle> {
    const cached = sandboxCache.get(sessionId)

    if (cached) {
        const skillsDirectory = join(cached.handle.sessionDir, 'skills')

        for (const skill of skills) {
            const installedVersion = cached.installedSkills.get(skill.id)
            if (installedVersion === skill.current_version) continue

            if (installedVersion !== undefined) {
                // Different version installed — remove old files to avoid stale state
                await rm(join(skillsDirectory, skill.name), { recursive: true, force: true })
            }

            await downloadSkill(skill, skillsDirectory, config)
            cached.installedSkills.set(skill.id, skill.current_version)
        }

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

    const installedSkills = new Map<string, number>()

    // Download each skill's files from S3 into the session directory
    for (const skill of skills) {
        await downloadSkill(skill, skillsDirectory, config)
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
    if (userId && config.fileUploads && !dirExisted) {
        await restoreArtifactsFromS3(sessionDir, sessionId, userId, config)
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

    await SandboxManager.initialize(baselineSandboxConfig)

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
            denyRead: ['~'],
            allowRead: [
                sessionDir,
                // Allow Node to read globally-installed packages from inside
                // the sandbox. Without this, `require('docx')` fails with
                // EPERM even when NODE_PATH points the resolver here.
                ...(npmGlobalRoot ? [npmGlobalRoot] : []),
            ],
            allowWrite: [sessionDir],
            denyWrite: [],
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
    try {
        configuredVariables = await getAllExuluVariables()
    } catch (err) {
        console.error(
            `[SKILLS] Failed to load configured variables for session ${sessionId}; bash env will not include them.`,
            err,
        )
    }

    // Environment for sandboxed bash invocations.
    //   - Spread order matters: later spreads win.
    //   - configuredVariables go first so process.env (PATH, HOME, etc.)
    //     overrides them. If a variable accidentally collides with a system
    //     env name, the system value stays authoritative.
    //   - NODE_PATH is set last so it's always our resolved global root,
    //     regardless of what process.env or variables already had.
    const sandboxedExecEnv: NodeJS.ProcessEnv = {
        ...configuredVariables,
        ...process.env,
        ...(npmGlobalRoot ? { NODE_PATH: npmGlobalRoot } : {}),
    }

    // wrapWithSandbox only constructs the sandbox-exec invocation string —
    // it does NOT run it. We have to shell out ourselves and capture the
    // real stdout/stderr/exitCode. The third arg passes the per-session
    // policy so the kernel only allows this session's dir, not whatever
    // baseline the singleton was initialized with.
    const runWrapped = async (command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        const wrapped = await SandboxManager.wrapWithSandbox(command, undefined, sessionSandboxConfig);
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
    async function persistArtifactToS3(
        absPath: string,
        content: Buffer,
    ): Promise<{ key?: string; url?: string }> {
        if (!persistenceEnabled || !isArtifactPath(absPath, sessionDir)) {
            return {}
        }
        const rel = relative(sessionDir, resolve(absPath))
        const s3Key = artifactS3Key(sessionId, rel)
        const out: { key?: string; url?: string } = {}
        try {
            const fullKey = await uploadFile(
                content,
                s3Key,
                config,
                {},
                // uploadFile's user param is typed as number, but the
                // addUserPrefixToKey helper it delegates to accepts
                // number | string at runtime — pass through as-is.
                userId as unknown as number,
            )
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
    ): Promise<WriteResult[]> {
        const results: WriteResult[] = []

        for (const file of files) {
            // Pipe content via stdin so arbitrary file content (quotes, $, etc.)
            // doesn't need to be escaped into the shell command.
            const wrapped = await SandboxManager.wrapWithSandbox(
                `mkdir -p ${shellQuote(dirname(file.path))} && cat > ${shellQuote(file.path)}`,
                undefined,
                sessionSandboxConfig,
            )
            await new Promise<void>((resolveSpawn, rejectSpawn) => {
                const child = spawn('/bin/bash', ['-c', wrapped])
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
    async function snapshotSessionArtifacts(): Promise<Map<string, number>> {
        const map = new Map<string, number>()
        const skillsDir = join(sessionDir, 'skills')
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
            '("skills/foo.md") and leading-slash paths ("/skills/foo.md") work and reach the same file. ' +
            'When the path is under the session artifact tree, the file is also uploaded to S3 ' +
            'and a short-lived presigned URL is returned in the tool output.',
        inputSchema: z.object({
            path: z.string().describe('The path where the file should be written. Relative paths and leading-slash paths are both resolved against the session sandbox root.'),
            content: z.string().describe('The content to write to the file'),
        }),
        execute: async ({ path, content }) => {
            const resolvedPath = resolveSessionPath(path, sessionDir)
            const results = await writeFilesInternal([{ path: resolvedPath, content }])
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
            '("skills/foo.md") and leading-slash paths ("/skills/foo.md") work and reach the same file. ' +
            'If the file does not exist, the error message is surfaced verbatim.',
        inputSchema: z.object({
            path: z.string().describe('The path of the file to read. Relative paths and leading-slash paths are both resolved against the session sandbox root.'),
        }),
        execute: async ({ path }) => {
            const resolvedPath = resolveSessionPath(path, sessionDir)
            const content = await customSandbox.readFile(resolvedPath)
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
    const originalBashTool = tools.bash
    const bashTool = tool({
        description: originalBashTool.description ?? '',
        inputSchema: z.object({
            command: z.string().describe('The bash command to execute.'),
        }),
        execute: async (args, opts) => {
            const before = persistenceEnabled
                ? await snapshotSessionArtifacts()
                : null
            // Defer to bash-tool's bash tool so we keep its truncation, cwd
            // pinning, and any future bash-tool behaviour for free.
            const originalExecute = originalBashTool.execute as
                | ((input: { command: string }, options: any) => Promise<any>)
                | undefined
            if (!originalExecute) {
                throw new Error('bash tool execute is undefined')
            }
            const result = await originalExecute(args, opts)

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
                const after = await snapshotSessionArtifacts()
                const changedPaths: string[] = []
                for (const [path, mtime] of after) {
                    const beforeMtime = before.get(path)
                    if (beforeMtime === undefined || beforeMtime < mtime) {
                        changedPaths.push(path)
                    }
                }
                for (const path of changedPaths) {
                    try {
                        const content = await fsReadFile(path)
                        const persisted = await persistArtifactToS3(path, content)
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
            const withUrls = artifacts.filter((a) => a.url)
            if (withUrls.length > 0) {
                const lines = ['', '[exulu-artifacts]']
                for (const a of withUrls) {
                    lines.push(`  ${a.relativePath}: ${a.url}`)
                }
                stdout = `${stdout}\n${lines.join('\n')}`
            }

            return {
                ...result,
                stdout,
                artifacts,
            }
        },
    })

    const wrappedTools = { ...tools, bash: bashTool, readFile: readFileTool, writeFile: writeFileTool }

    const handle: SessionSandboxHandle = {
        sessionDir,
        tools: wrappedTools,
        wrapCommand: (command: string) =>
            SandboxManager.wrapWithSandbox(command, undefined, sessionSandboxConfig),
        cleanup: async () => {
            sandboxCache.delete(sessionId)
            await SandboxManager.reset()
            await rm(sessionDir, { recursive: true, force: true })
        },
    }

    sandboxCache.set(sessionId, { handle, installedSkills })

    return handle
}
