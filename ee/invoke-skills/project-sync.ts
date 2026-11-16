import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { listS3ObjectsByPrefix, getS3ObjectBytes } from '@SRC/uppy/index.ts'
import { PROJECT_DIR, projectFilePrefix } from '@SRC/exulu/project-files.ts'
import { hasProjectAccess } from '@SRC/exulu/project-access.ts'
import type { ExuluConfig } from '@SRC/exulu/app/index.ts'

type Entry = { name: string; size: number }

/**
 * What has to change in `<sessionDir>/project/` so it mirrors the project folder:
 * new and size-changed files are downloaded, local files the project no longer
 * has are removed. Same rule as the session restore (`needsDownload`): size only.
 */
export function planProjectSync(remote: Entry[], local: Entry[]): { download: string[]; remove: string[] } {
    const localSizes = new Map(local.map((e) => [e.name, e.size]))
    const remoteNames = new Set(remote.map((e) => e.name))
    return {
        download: remote.filter((e) => localSizes.get(e.name) !== e.size).map((e) => e.name),
        remove: local.filter((e) => !remoteNames.has(e.name)).map((e) => e.name),
    }
}

/**
 * Records which project the session's `project/` folder was last synced from. It
 * lives OUTSIDE the session directory (the sandbox may only write inside it), and
 * it is what lets a session without a project tell "a project folder we created,
 * to be removed after a detach" from "a folder the agent named project/ itself".
 */
export function projectSyncMarkerPath(sessionDir: string): string {
    return join(dirname(sessionDir), '.project-sync', basename(sessionDir))
}

async function readMarker(sessionDir: string): Promise<string | null> {
    try {
        return (await readFile(projectSyncMarkerPath(sessionDir), 'utf8')).trim() || null
    } catch {
        return null
    }
}

/** Removes the marker; part of a sandbox's cleanup. */
export async function clearProjectSyncMarker(sessionDir: string): Promise<void> {
    await rm(projectSyncMarkerPath(sessionDir), { force: true })
}

const isFlatName = (name: string) => !!name && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..'

/**
 * Backend-only helper directories, siblings of the session dirs under
 * /tmp/exulu-sessions (same filesystem, so rename never crosses devices). The
 * sandbox policy only allows writes inside `sessionDir`, and the leading dot
 * keeps the names apart from session ids (uuids).
 */
const helperPath = (sessionDir: string, kind: '.project-staging' | '.project-trash') =>
    join(dirname(sessionDir), kind, `${basename(sessionDir)}-${randomBytes(8).toString('hex')}`)

const errCode = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code

/**
 * Move `<sessionDir>/project` (whatever it is: directory, file or link) out of
 * the agent's reach. rename acts on the entry itself and never follows a link.
 * Returns the trash path, or null when there was nothing to move.
 */
async function moveAway(dir: string, sessionDir: string): Promise<string | null> {
    const trash = helperPath(sessionDir, '.project-trash')
    await mkdir(dirname(trash), { recursive: true })
    try {
        await rename(dir, trash)
        return trash
    } catch (err) {
        if (errCode(err) === 'ENOENT') return null
        throw err
    }
}

/** Trash and staging live outside every session dir, so a recursive rm there is ours alone. */
async function discard(path: string | null): Promise<void> {
    if (!path) return
    await rm(path, { recursive: true, force: true }).catch((err) => {
        console.error(`[SKILLS] Failed to remove ${path}; continuing.`, err)
    })
}

/**
 * Mirror the project's shared files into `<sessionDir>/project/` (read-only by
 * convention: the sandbox never writes this folder back). With `projectId: null`
 * a folder that an earlier sync created is removed; a folder of that name the
 * agent made in a session that never had a project is left alone. Failures are
 * logged and never thrown at the caller — one bad object must not end a turn.
 *
 * The agent can swap `project` (or anything in it) for a link at any moment, and
 * this runs as the backend user, so it NEVER operates under the agent-writable
 * path: the old folder is renamed away, the new one is built in a private staging
 * directory and renamed into place. The only operations on `<sessionDir>/project`
 * are those two renames.
 */
export async function syncProjectDir(args: {
    sessionDir: string
    projectId: string | null
    config: ExuluConfig
}): Promise<void> {
    const { sessionDir, projectId, config } = args
    const dir = join(sessionDir, PROJECT_DIR)
    const previous = await readMarker(sessionDir)

    if (!projectId) {
        if (previous !== null) {
            await discard(await moveAway(dir, sessionDir))
            await clearProjectSyncMarker(sessionDir)
        }
        return
    }

    if (!config.fileUploads) {
        console.warn(`[SKILLS] File uploads are not configured; project files are not synced into ${sessionDir}.`)
        return
    }

    const { projectPrefix } = projectFilePrefix(projectId)
    const remote = new Map<string, { size: number; key: string }>()
    try {
        for (const obj of await listS3ObjectsByPrefix(projectPrefix, config)) {
            // listS3ObjectsByPrefix prepends the general s3prefix; recover the name
            // the same way restoreArtifactsFromS3 does.
            const idx = obj.key.indexOf(projectPrefix)
            const name = idx >= 0 ? obj.key.slice(idx + projectPrefix.length) : ''
            if (!isFlatName(name)) continue
            remote.set(name, { size: obj.size, key: obj.key })
        }
    } catch (err) {
        // Keep the local copy as it is: a transient S3 error must not empty the folder.
        console.error(`[SKILLS] Failed to list project files for project ${projectId}; keeping the local copy.`, err)
        return
    }

    await mkdir(dirname(projectSyncMarkerPath(sessionDir)), { recursive: true })
    // Written before anything moves, so a crash halfway still lets a later detach clean up.
    await writeFile(projectSyncMarkerPath(sessionDir), projectId)

    const trashes: Array<string | null> = []
    const staging = helperPath(sessionDir, '.project-staging')
    let installed = false
    try {
        const old = await moveAway(dir, sessionDir)
        trashes.push(old)
        await mkdir(dirname(staging), { recursive: true })
        await mkdir(staging) // fresh, private: nothing else knows this path

        // Reuse unchanged files of the same project. Only regular files are taken
        // (lstat, no link is followed); another project's files never are.
        const local: Array<{ name: string; size: number }> = []
        const oldStat = old && previous === projectId ? await lstat(old).catch(() => null) : null
        if (old && oldStat?.isDirectory()) {
            for (const name of await readdir(old)) {
                const st = await lstat(join(old, name)).catch(() => null)
                if (!st?.isFile() || remote.get(name)?.size !== st.size) continue
                await rename(join(old, name), join(staging, name))
                // A process still inside the old folder could have swapped the entry
                // between lstat and rename; anything that is not a regular file goes back.
                const moved = await lstat(join(staging, name)).catch(() => null)
                if (!moved?.isFile()) {
                    await rename(join(staging, name), join(old, `.rejected-${randomBytes(4).toString('hex')}`)).catch(() => {})
                    continue
                }
                local.push({ name, size: moved.size })
            }
        }

        const plan = planProjectSync(
            [...remote].map(([name, r]) => ({ name, size: r.size })),
            local,
        )
        // Sequential on purpose: a project holds up to 200 files and a turn must not
        // fan out that many parallel S3 reads.
        for (const name of plan.download) {
            try {
                const bytes = await getS3ObjectBytes(remote.get(name)!.key, config)
                await writeFile(join(staging, name), bytes, { flag: 'wx' })
            } catch (err) {
                console.error(`[SKILLS] Failed to sync project file ${name} (project ${projectId}); continuing.`, err)
            }
        }

        // Swap in. The agent may have planted something at project/ meanwhile:
        // move that away too and retry once, then give up for this turn.
        for (let attempt = 0; attempt < 2 && !installed; attempt++) {
            try {
                await rename(staging, dir)
                installed = true
            } catch (err) {
                const code = errCode(err)
                if (attempt === 0 && (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOTDIR' || code === 'EISDIR')) {
                    trashes.push(await moveAway(dir, sessionDir))
                    continue
                }
                console.error(`[SKILLS] Could not install the project folder for session ${sessionDir}; skipping this turn.`, err)
                break
            }
        }
    } catch (err) {
        console.error(`[SKILLS] Project sync failed for project ${projectId}; continuing.`, err)
    } finally {
        if (!installed) await discard(staging)
        for (const t of trashes) await discard(t)
    }
}

type ProjectRow = { id: string; created_by?: number | string | null; rights_mode?: string | null }
type OwnerLike = Parameters<typeof hasProjectAccess>[0]['user']

/**
 * The project id the session's sandbox may show: only when the session OWNER can
 * read the project (one sandbox per session, so it follows the owner, not the
 * speaker). A missing project, a missing owner, no access or any error → null;
 * resolving must never break the chat turn.
 */
export async function resolveSandboxProjectId(
    args: { projectId?: string | null; ownerId?: number | string | null; owner?: OwnerLike },
    deps: {
        getProject: (id: string) => Promise<ProjectRow | undefined | null>
        getRbac: (project: ProjectRow) => Promise<{ type: string; users?: any[]; roles?: any[] }>
        getUser: (id: number | string) => Promise<OwnerLike | undefined | null>
    },
): Promise<string | null> {
    const { projectId, ownerId } = args
    if (!projectId || ownerId == null) return null
    try {
        const project = await deps.getProject(projectId)
        if (!project) return null
        const owner = args.owner && String(args.owner.id) === String(ownerId) ? args.owner : await deps.getUser(ownerId)
        if (!owner) return null
        const rbac = await deps.getRbac(project)
        const allowed = hasProjectAccess({ project, rbac, user: owner, want: 'read' })
        return allowed ? String(project.id) : null
    } catch (err) {
        console.error(`[SKILLS] Failed to resolve project ${projectId} for the session sandbox; continuing without project files.`, err)
        return null
    }
}
