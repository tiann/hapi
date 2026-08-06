/**
 * Cross-process exclusive lock for settings.json (and similar).
 * Shared by hub and CLI.
 *
 * Acquisition: sync `openSync('wx')` + full owner write; on write failure the
 * sidecar is removed so we never leave an unreadable wedged lock.
 * Stale reclaim: rename the sidecar to a unique break path (atomic), re-verify
 * the expected dead owner, then unlink the break path — never `unlink` the live
 * lock path while contenders race.
 * Release: unlink only when the sidecar still contains our owner token.
 */

import { randomUUID } from 'node:crypto'
import {
    closeSync,
    openSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeSync,
} from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'

const LOCK_RETRY_INTERVAL_MS = 100
const MAX_LOCK_ATTEMPTS = 50

type LockOwner = {
    pid: number
    token: string
}

let maxLockAttemptsForTests: number | undefined
let writeOwnerForTests: ((fd: number, payload: string) => void) | undefined

/** @internal test-only: shorten acquire retries for fail-closed empty-lock coverage */
export function setSettingsLockMaxAttemptsForTests(value: number | undefined): void {
    maxLockAttemptsForTests = value
}

/** @internal test-only: inject owner-publication failures */
export function setSettingsLockWriteOwnerForTests(
    writer: ((fd: number, payload: string) => void) | undefined
): void {
    writeOwnerForTests = writer
}

function isPidAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false
    try {
        process.kill(pid, 0)
        return true
    } catch (err) {
        // EPERM means the process exists but we cannot signal it — still alive.
        return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
}

function readLockOwnerSync(lockFile: string): LockOwner | null {
    try {
        const raw = readFileSync(lockFile, 'utf8')
        const parsed = JSON.parse(raw) as Partial<LockOwner>
        if (typeof parsed.pid === 'number' && typeof parsed.token === 'string' && parsed.token) {
            return { pid: parsed.pid, token: parsed.token }
        }
        return null
    } catch {
        return null
    }
}

function publishOwner(fd: number, ownerPayload: string): void {
    if (writeOwnerForTests) {
        writeOwnerForTests(fd, ownerPayload)
        return
    }
    const payload = Buffer.from(ownerPayload)
    let offset = 0
    while (offset < payload.length) {
        const written = writeSync(fd, payload, offset, payload.length - offset)
        if (written === 0) throw new Error('Failed to publish settings lock owner')
        offset += written
    }
}

/**
 * Atomically move a dead owner's lock aside, verify it is still the expected
 * owner, then delete the break path. Contenders that lose the rename simply
 * retry — they never unlink another writer's live lock path.
 */
function tryReclaimDeadOwner(lockFile: string, expected: LockOwner): boolean {
    const breakPath = `${lockFile}.break.${randomUUID()}`
    try {
        renameSync(lockFile, breakPath)
    } catch {
        return false
    }
    try {
        const moved = readLockOwnerSync(breakPath)
        if (
            moved
            && moved.pid === expected.pid
            && moved.token === expected.token
            && !isPidAlive(moved.pid)
        ) {
            unlinkSync(breakPath)
            return true
        }
        // Unexpected content (or PID revived) — leave the break path for ops,
        // do not put a dubious owner back on the live lock path.
        return false
    } catch {
        try {
            unlinkSync(breakPath)
        } catch {
            // ignore
        }
        return false
    }
}

export async function withSettingsFileLock<T>(
    settingsFile: string,
    work: () => Promise<T>
): Promise<T> {
    const lockFile = `${settingsFile}.lock`
    const owner: LockOwner = { pid: process.pid, token: randomUUID() }
    const ownerPayload = JSON.stringify(owner)
    const maxAttempts = maxLockAttemptsForTests ?? MAX_LOCK_ATTEMPTS
    let acquired = false
    let attempts = 0

    while (attempts < maxAttempts) {
        try {
            const fd = openSync(lockFile, 'wx', 0o600)
            try {
                publishOwner(fd, ownerPayload)
                acquired = true
            } catch (error) {
                try {
                    unlinkSync(lockFile)
                } catch {
                    // ignore cleanup failure
                }
                throw error
            } finally {
                closeSync(fd)
            }
            break
        } catch (err: unknown) {
            if (acquired) throw err
            const code = err && typeof err === 'object' && 'code' in err
                ? String((err as { code?: unknown }).code)
                : undefined
            if (code === 'EEXIST') {
                attempts++
                // Sync read + reclaim: an await here lets every contender observe the
                // same dead owner and race the exclusive create after one rename wins.
                const existing = readLockOwnerSync(lockFile)
                if (existing && !isPidAlive(existing.pid)) {
                    tryReclaimDeadOwner(lockFile, existing)
                    continue
                }
                await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS))
            } else {
                throw err
            }
        }
    }

    if (!acquired) {
        throw new Error(
            `Failed to acquire settings lock after ${(maxAttempts * LOCK_RETRY_INTERVAL_MS) / 1000} seconds`
        )
    }

    try {
        return await work()
    } finally {
        const current = await readFile(lockFile, 'utf8').catch(() => null)
        if (current === ownerPayload) {
            await unlink(lockFile).catch(() => {})
        }
    }
}
