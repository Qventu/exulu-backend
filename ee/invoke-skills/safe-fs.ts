import { constants } from 'node:fs'
import { lstat, mkdir, open, readlink, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { discardEntry } from './project-sync'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { MAX_ADOPT_UPLOAD_BYTES } from '@SRC/exulu/session-file-adopt'

/**
 * Filesystem access by the BACKEND (not the sandboxed agent) inside a session
 * directory. The agent can write anything under `sessionDir` — symlinks included,
 * possibly from a process that outlives its command — while the backend runs with
 * more rights than the sandbox. Every backend read or write there must therefore
 * refuse to follow a link out of the session directory: a followed link would let
 * the agent read files the sandbox denies (uploaded as "artifacts") or make the
 * backend overwrite files outside the session.
 *
 * Node has no openat/renameat, so a link swapped in between a check and the
 * operation remains a (narrow) race; on Linux the read path closes it by checking
 * the opened descriptor's real location via /proc.
 */

export class UnsafeSessionPathError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'UnsafeSessionPathError'
    }
}

const errCode = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code

const isInside = (root: string, path: string) => path === root || path.startsWith(root + sep)

/**
 * Read `path` (absolute, under `sessionDir`) only when it is a regular file whose
 * directory really lies inside the session directory. Returns null — and logs —
 * for a symlink, anything that is not a regular file, or a path that resolves
 * outside; never throws for those, so one planted link cannot fail a whole tool call.
 */
export async function readRegularFileInside(sessionDir: string, path: string): Promise<Buffer | null> {
    const skip = (why: string) => {
        console.warn(`[SKILLS] Not reading ${path} back from the sandbox: ${why}.`)
        return null
    }
    let root: string
    let parent: string
    try {
        root = await realpath(sessionDir)
        parent = await realpath(dirname(path))
    } catch {
        return skip('path does not resolve')
    }
    if (!isInside(root, parent)) return skip('it resolves outside the session directory')

    let handle
    try {
        // O_NOFOLLOW: a final component that is a link fails with ELOOP instead of being followed.
        // O_NONBLOCK: a FIFO the agent planted would otherwise block this open (and a
        // libuv threadpool thread with it) until a writer appears; with it the open
        // returns at once and the isFile() check below skips the entry.
        // O_NOCTTY: opening a terminal device must never make it our controlling tty.
        handle = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY,
        )
    } catch (err) {
        return skip(errCode(err) === 'ELOOP' ? 'it is a symbolic link' : `open failed (${errCode(err) ?? 'unknown'})`)
    }
    try {
        const st = await handle.stat()
        if (!st.isFile()) return skip('it is not a regular file')
        // Same ceiling as an upload: a sparse `truncate -s 2G` costs the agent no
        // disk but would make the backend read and upload gigabytes.
        if (st.size > MAX_ADOPT_UPLOAD_BYTES) {
            return skip(`it is larger than the ${MAX_ADOPT_UPLOAD_BYTES / (1024 * 1024)}MB upload limit (${st.size} bytes)`)
        }
        // A parent directory swapped for a link after the realpath check above would
        // have steered the open elsewhere. Where the descriptor's real path is
        // available (Linux), check that instead of trusting the earlier check.
        const fdPath = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => null)
        if (fdPath !== null) {
            if (!isInside(root, fdPath)) return skip('it resolves outside the session directory')
        } else {
            const again = await realpath(dirname(path)).catch(() => null)
            if (again === null || !isInside(root, again)) return skip('it resolves outside the session directory')
        }
        // Bounded read: the file may still grow after the fstat above.
        const chunks: Buffer[] = []
        let total = 0
        for (;;) {
            const chunk = Buffer.allocUnsafe(1024 * 1024)
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
            if (bytesRead === 0) break
            total += bytesRead
            if (total > MAX_ADOPT_UPLOAD_BYTES) return skip('it grew past the upload limit while being read')
            chunks.push(chunk.subarray(0, bytesRead))
        }
        return Buffer.concat(chunks, total)
    } finally {
        await handle.close().catch(() => {})
    }
}

/** Splits a session-relative path, refusing absolute paths, `..` and empty input. */
function safeSegments(relativePath: string): string[] {
    if (!relativePath || isAbsolute(relativePath) || relativePath.includes('\\')) {
        throw new UnsafeSessionPathError(`Refusing path "${relativePath}": not a plain relative path.`)
    }
    const segments = relativePath.split('/').filter((s) => s !== '' && s !== '.')
    if (segments.length === 0 || segments.includes('..')) {
        throw new UnsafeSessionPathError(`Refusing path "${relativePath}": it contains a ".." segment or no file name.`)
    }
    return segments
}

/**
 * Create `<sessionDir>/<segments...>` one component at a time. Any existing
 * component that is not a real directory (a link, a file) is refused; the final
 * parent's real path must still lie inside the session directory afterwards.
 */
async function ensureDirInside(sessionDir: string, segments: string[]): Promise<string> {
    const root = await realpath(sessionDir)
    let current = sessionDir
    for (const segment of segments) {
        current = join(current, segment)
        let st = await lstat(current).catch((err) => (errCode(err) === 'ENOENT' ? null : Promise.reject(err)))
        if (!st) {
            try {
                await mkdir(current)
            } catch (err) {
                if (errCode(err) !== 'EEXIST') throw err
            }
            st = await lstat(current)
        }
        if (!st.isDirectory()) {
            throw new UnsafeSessionPathError(`Refusing to write under ${current}: it is not a real directory.`)
        }
    }
    const real = await realpath(current)
    if (!isInside(root, real)) {
        throw new UnsafeSessionPathError(`Refusing to write under ${current}: it resolves outside the session directory.`)
    }
    return current
}

/**
 * Write `bytes` to `<sessionDir>/<relativePath>` without following links. Parents
 * are created component by component (see ensureDirInside). The bytes go to an
 * exclusive temp file in the same directory which is then renamed over the
 * destination: rename replaces a link planted at the destination instead of
 * writing through it. Returns the absolute destination path.
 */
export async function writeFileInside(sessionDir: string, relativePath: string, bytes: Buffer | string): Promise<string> {
    const segments = safeSegments(relativePath)
    const name = segments[segments.length - 1]!
    const parent = await ensureDirInside(sessionDir, segments.slice(0, -1))
    const destination = join(parent, name)
    const temp = join(parent, `.exulu-write-${randomBytes(8).toString('hex')}`)
    // 'wx' = O_CREAT | O_EXCL: never opens an existing entry (link or not).
    await writeFile(temp, bytes, { flag: 'wx' })
    try {
        await rename(temp, destination)
    } catch (err) {
        await unlink(temp).catch(() => {})
        throw err
    }
    return destination
}

/**
 * Make `<sessionDir>/<relativeDir>` (one level, e.g. "skills") a real directory:
 * an existing link or file there is unlinked itself (never followed) and a real
 * directory created in its place.
 */
export async function ensureRealDirectory(sessionDir: string, relativeDir: string): Promise<string> {
    const segments = safeSegments(relativeDir)
    let current = sessionDir
    for (const segment of segments) {
        current = join(current, segment)
        const st = await lstat(current).catch(() => null)
        if (st && !st.isDirectory()) {
            console.warn(`[SKILLS] ${current} is not a real directory; replacing it.`)
            await unlink(current)
        }
    }
    return ensureDirInside(sessionDir, segments)
}

/**
 * Remove `<sessionDir>/<relativePath>` when it is a real directory inside the
 * session directory; a link or file there is unlinked itself. The recursive
 * removal only runs after the parent's real path was checked, so it never walks
 * through a symlinked parent.
 */
export async function removeEntryInside(sessionDir: string, relativePath: string): Promise<void> {
    const segments = safeSegments(relativePath)
    const target = join(sessionDir, ...segments)
    const root = await realpath(sessionDir)
    const parentReal = await realpath(dirname(target)).catch(() => null)
    if (parentReal === null) return // parent missing: nothing to remove
    if (!isInside(root, parentReal)) {
        throw new UnsafeSessionPathError(`Refusing to remove ${target}: its parent resolves outside the session directory.`)
    }
    const st = await lstat(target).catch(() => null)
    if (!st) return
    if (!st.isDirectory()) {
        await unlink(target)
        return
    }
    // Same as the project folder (project-sync.ts): rename the directory out of
    // the session (rename acts on the entry, never through it), then delete the
    // moved copy with an fd-based rm that a process still inside cannot steer.
    await discardEntry(target, sessionDir)
}
