import {
    SandboxManager,
    type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { exec, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { listS3ObjectsByPrefix, getS3ObjectContent, uploadFile, type S3FileObject } from '@SRC/uppy/index.ts'
import type { ExuluConfig } from '@SRC/exulu/app/index.ts'
import { createBashTool, type BashToolkit, type Sandbox } from "bash-tool";
import type { Tool } from "ai";

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
    tools: BashToolkit['tools']
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
            const { stdout } = await runWrapped(`cat ${shellQuote(path)}`);
            return stdout;
        },
        async writeFiles(files) {
            // Pipe content via stdin so arbitrary file content (quotes, $, etc.)
            // doesn't need to be escaped into the shell command.
            for (const file of files) {
                const wrapped = await SandboxManager.wrapWithSandbox(
                    `mkdir -p ${shellQuote(dirname(file.path))} && cat > ${shellQuote(file.path)}`,
                );
                await new Promise<void>((resolve, reject) => {
                    const child = spawn('/bin/bash', ['-c', wrapped]);
                    let stderr = '';
                    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
                    child.on('error', reject);
                    child.on('exit', (code) => {
                        if (code === 0) resolve();
                        else reject(new Error(`writeFile ${file.path} failed (exit ${code}): ${stderr}`));
                    });
                    child.stdin.write(file.content);
                    child.stdin.end();
                });

                // Mirror artifact writes to S3 for cross-session restore. Skill
                // source files (under sessionDir/skills/) are excluded. Upload
                // failures are non-fatal: the local write already succeeded, so
                // we log and continue rather than poison the agent's tool call.
                if (persistenceEnabled && isArtifactPath(file.path, sessionDir)) {
                    const rel = relative(sessionDir, resolve(file.path))
                    const key = artifactS3Key(sessionId, rel)
                    try {
                        await uploadFile(
                            Buffer.from(file.content),
                            key,
                            config,
                            {},
                            // uploadFile's user param is typed as number, but
                            // addUserPrefixToKey it delegates to accepts
                            // number | string at runtime — pass through as-is.
                            userId as unknown as number,
                        )
                    } catch (err) {
                        console.error(
                            `[SKILLS] Failed to upload artifact ${key} for session ${sessionId} (user ${userId}); continuing.`,
                            err,
                        )
                    }
                }
            }
        },
    };
    const { tools } = await createBashTool({
        sandbox: customSandbox,
        // The bash-tool defaults to /workspace and prepends `cd /workspace &&`
        // to every command. Point it at our session dir so commands actually
        // have a valid cwd and resolve relative paths against the skill files.
        destination: sessionDir,
    });

    const handle: SkillSandboxHandle = {
        sessionDir,
        tools,
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
