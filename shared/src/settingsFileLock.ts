/**
 * Cross-process exclusive lock for settings.json (and similar).
 * Shared by hub and CLI. Breaks only locks whose recorded PID is dead
 * (or legacy/unparseable sidecars with no owner); release deletes the
 * sidecar only when it still contains our owner token.
 */

import { randomUUID } from 'node:crypto'
import { open, readFile, unlink } from 'node:fs/promises'

const LOCK_RETRY_INTERVAL_MS = 100
const MAX_LOCK_ATTEMPTS = 50

type LockOwner = {
    pid: number
    token: string
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
    let fileHandle: Awaited<ReturnType<typeof open>> | undefined
    let attempts = 0

    while (attempts < MAX_LOCK_ATTEMPTS) {
        try {
            // 'wx' = create exclusively, fail if exists (cross-platform compatible)
            fileHandle = await open(lockFile, 'wx', 0o600)
            await fileHandle.writeFile(ownerPayload, 'utf8')
            break
        } catch (err: unknown) {
            const code = err && typeof err === 'object' && 'code' in err
                ? String((err as { code?: unknown }).code)
                : undefined
            if (code === 'EEXIST') {
                attempts++
                const existing = await readLockOwner(lockFile)
                // Reclaim dead holders and legacy empty/unparseable locks (pre-owner format).
                // Never reclaim solely by file age — a live holder may be paused across suspend.
                if (!existing || !isPidAlive(existing.pid)) {
                    await unlink(lockFile).catch(() => {})
                    continue
                }
                await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS))
            } else {
                throw err
            }
        }
    }

    if (!fileHandle) {
        throw new Error(
            `Failed to acquire settings lock after ${(MAX_LOCK_ATTEMPTS * LOCK_RETRY_INTERVAL_MS) / 1000} seconds`
        )
    }

    try {
        return await work()
    } finally {
        await fileHandle.close().catch(() => {})
        const current = await readFile(lockFile, 'utf8').catch(() => null)
        if (current === ownerPayload) {
            await unlink(lockFile).catch(() => {})
        }
    }
}
