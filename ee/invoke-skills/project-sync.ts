import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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
 * Mirror the project's shared files into `<sessionDir>/project/` (read-only by
 * convention: the sandbox never writes this folder back). With `projectId: null`
 * a folder that an earlier sync created is removed; a folder of that name the
 * agent made in a session that never had a project is left alone. Failures are
 * logged and never thrown at the caller — one bad object must not end a turn.
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
            await rm(dir, { recursive: true, force: true })
            await clearProjectSyncMarker(sessionDir)
        }
        return
    }

    if (!config.fileUploads) {
        console.warn(`[SKILLS] File uploads are not configured; project files are not synced into ${sessionDir}.`)
        return
    }

    // Another project's files under the same names must not survive a re-attach.
    if (previous !== null && previous !== projectId) {
        await rm(dir, { recursive: true, force: true })
    }

    const { projectPrefix } = projectFilePrefix(projectId)
    let remote: Entry[]
    const keys = new Map<string, string>()
    try {
        const objects = await listS3ObjectsByPrefix(projectPrefix, config)
        remote = []
        for (const obj of objects) {
            // listS3ObjectsByPrefix prepends the general s3prefix; recover the name
            // the same way restoreArtifactsFromS3 does.
            const idx = obj.key.indexOf(projectPrefix)
            const name = idx >= 0 ? obj.key.slice(idx + projectPrefix.length) : ''
            if (!isFlatName(name)) continue
            remote.push({ name, size: obj.size })
            keys.set(name, obj.key)
        }
    } catch (err) {
        // Keep the local copy as it is: a transient S3 error must not empty the folder.
        console.error(`[SKILLS] Failed to list project files for project ${projectId}; keeping the local copy.`, err)
        return
    }

    // The agent controls everything inside the session dir and may have replaced
    // project/ with a symlink (to /app, /, another session …) or a file. Everything
    // below runs as the backend process user, so it must never follow that link:
    // drop the link itself (rm on a link removes the link, not its target).
    const existing = await lstat(dir).catch(() => null)
    if (existing && !existing.isDirectory()) await rm(dir, { force: true })
    await mkdir(dir, { recursive: true })
    await mkdir(dirname(projectSyncMarkerPath(sessionDir)), { recursive: true })
    // Written before the downloads, so a crash halfway still lets a later detach clean up.
    await writeFile(projectSyncMarkerPath(sessionDir), projectId)

    const local: Entry[] = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isFile()) {
            try {
                local.push({ name: entry.name, size: (await stat(join(dir, entry.name))).size })
            } catch {
                // vanished between readdir and stat
            }
        } else {
            // Directories (or links) the agent made here are not project files; the
            // folder is flat, so anything else goes.
            await rm(join(dir, entry.name), { recursive: true, force: true })
        }
    }

    const plan = planProjectSync(remote, local)
    for (const name of plan.remove) {
        await rm(join(dir, name), { recursive: true, force: true })
    }
    // Sequential on purpose: a project holds up to 200 files and a turn must not
    // fan out that many parallel S3 reads.
    for (const name of plan.download) {
        try {
            const bytes = await getS3ObjectBytes(keys.get(name)!, config)
            // A link planted at project/<name> after the scan must not be written
            // through: write a fresh file exclusively ('wx' fails on any existing
            // entry, links included) and rename it over the name, which replaces
            // the link itself.
            const tmp = join(dir, `.sync-${randomBytes(6).toString('hex')}.tmp`)
            try {
                await writeFile(tmp, bytes, { flag: 'wx' })
                await rename(tmp, join(dir, name))
            } catch (err) {
                await rm(tmp, { force: true }).catch(() => {})
                throw err
            }
        } catch (err) {
            console.error(`[SKILLS] Failed to sync project file ${name} (project ${projectId}); continuing.`, err)
            // A stale local copy of a changed file is worse than none.
            await rm(join(dir, name), { force: true }).catch(() => {})
        }
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
