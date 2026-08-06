/**
 * Cross-process exclusive lock for settings.json (and similar).
 * Shared by hub and CLI. Breaks only locks whose recorded PID is dead;
 * release deletes the sidecar only when it still contains our owner token.
 *
 * Never reclaim an unreadable/empty sidecar on sight — `wx` makes the path
 * visible before the owner JSON is published, and unlinking that window lets
 * two writers into the critical section (fixed `.tmp` collisions / lost fields).
 */

import { randomUUID } from 'node:crypto'
import { closeSync, openSync, writeSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'

const LOCK_RETRY_INTERVAL_MS = 100
const MAX_LOCK_ATTEMPTS = 50

type LockOwner = {
    pid: number
    token: string
}

let maxLockAttemptsForTests: number | undefined

/** @internal test-only: shorten acquire retries for fail-closed empty-lock coverage */
export function setSettingsLockMaxAttemptsForTests(value: number | undefined): void {
    maxLockAttemptsForTests = value
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

async function readLockOwner(lockFile: string): Promise<LockOwner | null> {
    try {
        const raw = await readFile(lockFile, 'utf8')
        const parsed = JSON.parse(raw) as Partial<LockOwner>
        if (typeof parsed.pid === 'number' && typeof parsed.token === 'string' && parsed.token) {
            return { pid: parsed.pid, token: parsed.token }
        }
        return null
    } catch {
        return null
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
            // Sync exclusive create + write so we publish the owner before yielding
            // back to the event loop (async open→write left a reclaimable empty window).
            const fd = openSync(lockFile, 'wx', 0o600)
            try {
                writeSync(fd, ownerPayload)
            } finally {
                closeSync(fd)
            }
            acquired = true
            break
        } catch (err: unknown) {
            const code = err && typeof err === 'object' && 'code' in err
                ? String((err as { code?: unknown }).code)
                : undefined
            if (code === 'EEXIST') {
                attempts++
                const existing = await readLockOwner(lockFile)
                // Only reclaim a parsed owner whose PID is confirmed dead.
                // null may mean the winning writer has not published its payload yet.
                if (existing && !isPidAlive(existing.pid)) {
                    await unlink(lockFile).catch(() => {})
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
