import {
    SandboxManager,
    type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { listS3ObjectsByPrefix, getS3ObjectContent } from '@SRC/uppy/index.ts'
import type { ExuluConfig } from '@SRC/exulu/app/index.ts'

import { tool } from 'ai'
import { z } from 'zod'

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
    /** Wraps a shell command string so it runs inside the sandbox. */
    wrapCommand: (command: string) => Promise<string>
    /** Tears down the sandbox and deletes the session directory. */
    cleanup: () => Promise<void>
}

/**
 * Creates a sandboxed environment for a session:
 * 1. Creates a temp directory at /tmp/exulu-sessions/<sessionId>
 * 2. Downloads all files for each enabled skill into <sessionDir>/skills/<skillName>/
 * 3. Initialises the SRT SandboxManager with filesystem access scoped to sessionDir only
 *    and no network access
 */
export async function createSkillSandbox(
    sessionId: string,
    skills: SkillRef[],
    config: ExuluConfig,
): Promise<SkillSandboxHandle> {
    const sessionDir = join('/tmp', 'exulu-sessions', sessionId)

    await mkdir(sessionDir, { recursive: true })

    const skillsDirectory = join(sessionDir, 'skills')

    // Download each skill's files from S3 into the session directory
    for (const skill of skills) {
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

    return {
        sessionDir,
        wrapCommand: (command: string) => SandboxManager.wrapWithSandbox(command),
        cleanup: async () => {
            await SandboxManager.reset()
            await rm(sessionDir, { recursive: true, force: true })
        },
    }
}
