import {
    SandboxManager,
    type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { listS3ObjectsByPrefix, getS3ObjectContent } from '@SRC/uppy/index.ts'
import type { ExuluConfig } from '@SRC/exulu/app/index.ts'
import { createBashTool, type BashToolkit, type Sandbox } from "bash-tool";
import type { Tool } from "ai";

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
    const versionPrefix = `skills/${skill.id}/v${skill.current_version}/`
    const files = await listS3ObjectsByPrefix(versionPrefix, config)

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
 * Creates a sandboxed environment for a session:
 * 1. Creates a temp directory at /tmp/exulu-sessions/<sessionId>
 * 2. Downloads all files for each enabled skill into <sessionDir>/skills/<skillName>/
 * 3. Initialises the SRT SandboxManager with filesystem access scoped to sessionDir only
 *    and no network access
 *
 * If called again for the same sessionId, the existing sandbox is reused and only
 * skills that are new (or whose version differs from what's already installed) are
 * downloaded into the existing session directory.
 */
export async function createSkillSandbox(
    sessionId: string,
    skills: SkillRef[],
    config: ExuluConfig,
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

    await mkdir(sessionDir, { recursive: true })

    const skillsDirectory = join(sessionDir, 'skills')

    const installedSkills = new Map<string, number>()

    // Download each skill's files from S3 into the session directory
    for (const skill of skills) {
        await downloadSkill(skill, skillsDirectory, config)
        installedSkills.set(skill.id, skill.current_version)
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

    const customSandbox: Sandbox = {
        async executeCommand(command) {
            // Your implementation here
            try {
                const result = await SandboxManager.wrapWithSandbox(command);
                return {
                    stdout: result,
                    stderr: "",
                    exitCode: 0,
                };
            } catch (error) {
                return {
                    stdout: "",
                    stderr: typeof error === "string" ? error : JSON.stringify(error),
                    exitCode: 1,
                };
            }
        },
        async readFile(path) {
            // Your implementation here
            return await SandboxManager.wrapWithSandbox("cat " + path);
        },
        async writeFiles(files) {
            // Your implementation here - files is Array<{path, content}>
            await SandboxManager.wrapWithSandbox("echo " + files.map((file) => file.content).join(" ") + " > " + files.map((file) => file.path).join(" "));
        },
    };
    const { tools } = await createBashTool({ sandbox: customSandbox });

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
