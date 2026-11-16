import { constants } from 'node:fs'
import { open, readlink, realpath } from 'node:fs/promises'
import { dirname, sep } from 'node:path'

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
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (err) {
        return skip(errCode(err) === 'ELOOP' ? 'it is a symbolic link' : `open failed (${errCode(err) ?? 'unknown'})`)
    }
    try {
        const st = await handle.stat()
        if (!st.isFile()) return skip('it is not a regular file')
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
        return await handle.readFile()
    } finally {
        await handle.close().catch(() => {})
    }
}
