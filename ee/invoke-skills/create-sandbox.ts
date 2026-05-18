import {
    SandboxManager,
    type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, resolve, relative, posix } from 'node:path'
import { exec, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { listS3ObjectsByPrefix, getS3ObjectContent, uploadFile, getPresignedUrl, type S3FileObject } from '@SRC/uppy/index.ts'
import type { ExuluConfig } from '@SRC/exulu/app/index.ts'
import { createBashTool, type Sandbox } from "bash-tool";
import { tool, type Tool } from "ai";
import { z } from "zod";

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

export interface SkillSandboxHandle {
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
    handle: SkillSandboxHandle
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

        const content = await getS3ObjectContent(file.key, config)
        await writeFile(localPath, content, 'utf-8')
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
            const content = await getS3ObjectContent(obj.key, config)
            await mkdir(dirname(localPath), { recursive: true })
            await writeFile(localPath, content, 'utf-8')
        } catch (err) {
            console.error(
                `[SKILLS] Failed to restore artifact ${obj.key} -> ${localPath}; continuing.`,
                err,
            )
        }
    }
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
export async function createSkillSandbox(
    sessionId: string,
    skills: SkillRef[],
    config: ExuluConfig,
    userId?: number | string,
): Promise<SkillSandboxHandle> {
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

    const sandboxConfig: SandboxRuntimeConfig = {
        network: {
            allowedDomains: [], // todo
            deniedDomains: [], // todo
        },
        filesystem: {
            // Deny reads to home directory but re-allow only the session folder.
            // System paths (/usr, /lib, etc.) remain readable for process execution.
            denyRead: ['~'],
            allowRead: [sessionDir],
            // Write access is scoped exclusively to the session folder.
            allowWrite: [sessionDir],
            denyWrite: [],
        },
    }

    await SandboxManager.initialize(sandboxConfig)

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

    // wrapWithSandbox only constructs the sandbox-exec invocation string —
    // it does NOT run it. We have to shell out ourselves and capture the
    // real stdout/stderr/exitCode.
    const runWrapped = async (command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        const wrapped = await SandboxManager.wrapWithSandbox(command);
        try {
            const { stdout, stderr } = await execAsync(wrapped, {
                maxBuffer: EXEC_MAX_BUFFER,
                shell: '/bin/bash',
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

    async function writeFilesInternal(
        files: Array<{ path: string; content: string | Buffer }>,
    ): Promise<WriteResult[]> {
        const results: WriteResult[] = []

        for (const file of files) {
            // Pipe content via stdin so arbitrary file content (quotes, $, etc.)
            // doesn't need to be escaped into the shell command.
            const wrapped = await SandboxManager.wrapWithSandbox(
                `mkdir -p ${shellQuote(dirname(file.path))} && cat > ${shellQuote(file.path)}`,
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
            // tool output can surface a viewable link to the user. Skill source
            // files (under sessionDir/skills/) are excluded.
            if (persistenceEnabled && isArtifactPath(file.path, sessionDir)) {
                const rel = relative(sessionDir, resolve(file.path))
                const s3Key = artifactS3Key(sessionId, rel)
                try {
                    const fullKey = await uploadFile(
                        Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content),
                        s3Key,
                        config,
                        {},
                        // uploadFile's user param is typed as number, but the
                        // addUserPrefixToKey helper it delegates to accepts
                        // number | string at runtime — pass through as-is.
                        userId as unknown as number,
                    )
                    result.key = fullKey
                    // uploadFile returns "<bucket>/<key>" — split to call
                    // getPresignedUrl, which expects bucket and key separately.
                    const slashIdx = fullKey.indexOf('/')
                    if (slashIdx > 0) {
                        const bucket = fullKey.slice(0, slashIdx)
                        const keyOnly = fullKey.slice(slashIdx + 1)
                        try {
                            result.url = await getPresignedUrl(bucket, keyOnly, config)
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
            }

            results.push(result)
        }

        return results
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
    // same shape (path/content schema, posix.resolve against the session dir)
    // and surfaces { path, url, key } from writeFilesInternal so the frontend
    // can render a viewable link to the artifact.
    const writeFileTool = tool({
        description:
            'Write content to a file in the sandbox. Creates parent directories if needed. ' +
            'When the path is under the session artifact tree, the file is also uploaded to S3 ' +
            'and a short-lived presigned URL is returned in the tool output.',
        inputSchema: z.object({
            path: z.string().describe('The path where the file should be written'),
            content: z.string().describe('The content to write to the file'),
        }),
        execute: async ({ path, content }) => {
            const resolvedPath = posix.resolve(sessionDir, path)
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

    const wrappedTools = { ...tools, writeFile: writeFileTool }

    const handle: SkillSandboxHandle = {
        sessionDir,
        tools: wrappedTools,
        wrapCommand: (command: string) => SandboxManager.wrapWithSandbox(command),
        cleanup: async () => {
            sandboxCache.delete(sessionId)
            await SandboxManager.reset()
            await rm(sessionDir, { recursive: true, force: true })
        },
    }

    sandboxCache.set(sessionId, { handle, installedSkills })

    return handle
}
