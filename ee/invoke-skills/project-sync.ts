import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
const HELPER_KINDS = ['.project-staging', '.project-trash'] as const
type HelperKind = (typeof HELPER_KINDS)[number]
const helperRoot = (sessionDir: string, kind: HelperKind) => join(dirname(sessionDir), kind)
const helperPath = (sessionDir: string, kind: HelperKind) =>
    join(helperRoot(sessionDir, kind), `${basename(sessionDir)}-${randomBytes(8).toString('hex')}`)

const execFileAsync = promisify(execFile)

/**
 * Recursively remove a trash or staging directory. Node's fs.rm walks by path
 * (lstat, then readdir/rmdir by name), so a process the agent left running inside
 * the moved-away folder could swap a subdirectory for a link mid-walk and steer it
 * outside. coreutils/BSD `rm` descends by file descriptor (openat/unlinkat, links
 * never followed), so it is spawned directly, without a shell. Only paths strictly
 * inside one of the two helper roots are accepted, never anything under a session
 * dir. Failures are logged: a leftover trash dir is harmless and swept later.
 */
export async function removeTreeSafely(path: string, sessionDir: string): Promise<boolean> {
    const target = resolve(path)
    const inside = HELPER_KINDS.some((kind) => {
        const root = resolve(helperRoot(sessionDir, kind))
        return target.startsWith(root + sep) && !target.slice(root.length + 1).includes(sep)
    })
    if (!inside) {
        console.error(`[SKILLS] Refusing to remove ${path}: not a project staging or trash directory.`)
        return false
    }
    try {
        await execFileAsync('rm', ['-rf', '--', target])
        return true
    } catch (err) {
        console.error(`[SKILLS] Failed to remove ${target}; leaving it for a later sweep.`, err)
        return false
    }
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Remove this session's helper dirs a crash or failed rm left behind more than a day ago. */
async function sweepStaleHelpers(sessionDir: string): Promise<void> {
    const prefix = `${basename(sessionDir)}-`
    for (const kind of HELPER_KINDS) {
        const root = helperRoot(sessionDir, kind)
        let names: string[]
        try {
            names = await readdir(root)
        } catch {
            continue
        }
        for (const name of names) {
            if (!name.startsWith(prefix)) continue
            const st = await lstat(join(root, name)).catch(() => null)
            if (st && Date.now() - st.mtimeMs > DAY_MS) await removeTreeSafely(join(root, name), sessionDir)
        }
    }
}

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

async function discard(path: string | null, sessionDir: string): Promise<void> {
    if (path) await removeTreeSafely(path, sessionDir)
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
            await discard(await moveAway(dir, sessionDir), sessionDir)
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

    await sweepStaleHelpers(sessionDir)

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
        if (!installed) await discard(staging, sessionDir)
        for (const t of trashes) await discard(t, sessionDir)
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
