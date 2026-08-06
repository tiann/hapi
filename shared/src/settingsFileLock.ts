/**
 * Cross-process exclusive lock for settings.json (and similar).
 * Shared by hub and CLI.
 *
 * Acquisition publishes a fully-written candidate then `linkSync`s it onto the
 * fixed lock path, so a crash cannot leave an empty/partial live sidecar.
 * Stale reclaim: only under a fixed exclusive `${lock}.reap` sidecar, after
 * re-validating pid+token, unlink the dead owner.
 * Release: unlink only when the sidecar still contains our owner token.
 */

import { randomUUID } from 'node:crypto'
import {
    closeSync,
    linkSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
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
let reclaimGateForTests: (() => Promise<void>) | undefined
let publishHookForTests: ((lockFile: string, ownerPayload: string) => void) | undefined

/** @internal test-only: shorten acquire retries for fail-closed empty-lock coverage */
export function setSettingsLockMaxAttemptsForTests(value: number | undefined): void {
    maxLockAttemptsForTests = value
}

/** @internal test-only: pause after reading a dead owner, before reclaim */
export function setSettingsLockReclaimGateForTests(
    gate: (() => Promise<void>) | undefined
): void {
    reclaimGateForTests = gate
}

/** @internal test-only: replace atomic publish (e.g. simulate crash after candidate write) */
export function setSettingsLockPublishForTests(
    publish: ((lockFile: string, ownerPayload: string) => void) | undefined
): void {
    publishHookForTests = publish
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

/**
 * Publish a complete owner document, then atomically attach it to the fixed
 * lock path. A crash leaves at most an orphan `.candidate` file — never an
 * empty live sidecar that wedges every future writer.
 */
function publishLockAtomically(lockFile: string, ownerPayload: string): void {
    if (publishHookForTests) {
        publishHookForTests(lockFile, ownerPayload)
        return
    }
    const candidate = `${lockFile}.${randomUUID()}.candidate`
    writeFileSync(candidate, ownerPayload, { flag: 'wx', mode: 0o600 })
    try {
        linkSync(candidate, lockFile)
    } finally {
        try {
            unlinkSync(candidate)
        } catch {
            // ignore — orphan candidates do not block acquisition
        }
    }
}

/**
 * Reclaim a dead owner under a fixed exclusive reaper sidecar so only one
 * contender can unlink the live lock path. Re-validates pid+token while holding
 * the reaper before unlinking.
 */
function tryReclaimDeadOwner(lockFile: string, expected: LockOwner): boolean {
    const reapLock = `${lockFile}.reap`
    let reapFd: number | undefined
    try {
        reapFd = openSync(reapLock, 'wx', 0o600)
        writeSync(reapFd, JSON.stringify({ pid: process.pid, token: randomUUID() }))
    } catch (err: unknown) {
        const code = err && typeof err === 'object' && 'code' in err
            ? String((err as { code?: unknown }).code)
            : undefined
        if (reapFd !== undefined) {
            try {
                closeSync(reapFd)
            } catch {
                // ignore
            }
            try {
                unlinkSync(reapLock)
            } catch {
                // ignore
            }
        }
        if (code === 'EEXIST') return false
        throw err
    }
    try {
        closeSync(reapFd)
    } catch {
        // ignore
    }

    try {
        const current = readLockOwnerSync(lockFile)
        if (
            !current
            || current.pid !== expected.pid
            || current.token !== expected.token
            || isPidAlive(current.pid)
        ) {
            return false
        }
        unlinkSync(lockFile)
        return true
    } catch {
        return false
    } finally {
        try {
            unlinkSync(reapLock)
        } catch {
            // ignore
        }
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
            publishLockAtomically(lockFile, ownerPayload)
            acquired = true
            break
        } catch (err: unknown) {
            const code = err && typeof err === 'object' && 'code' in err
                ? String((err as { code?: unknown }).code)
                : undefined
            if (code === 'EEXIST') {
                attempts++
                // Sync read: an await here lets every contender observe the same
                // dead owner across a yield and race the exclusive create.
                const existing = readLockOwnerSync(lockFile)
                if (existing && !isPidAlive(existing.pid)) {
                    if (reclaimGateForTests) await reclaimGateForTests()
                    const reclaimed = tryReclaimDeadOwner(lockFile, existing)
                    if (!reclaimed) {
                        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS))
                    }
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
