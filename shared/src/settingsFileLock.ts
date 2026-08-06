/**
 * Cross-process exclusive lock for settings.json (and similar).
 * Matches the CLI `updateSettings` lock algorithm so hub and CLI serialize
 * writers against the same `<file>.lock` sidecar.
 */

import { open, unlink, stat } from 'node:fs/promises'

const LOCK_RETRY_INTERVAL_MS = 100
const MAX_LOCK_ATTEMPTS = 50
const STALE_LOCK_TIMEOUT_MS = 10_000

export async function withSettingsFileLock<T>(
    settingsFile: string,
    work: () => Promise<T>
): Promise<T> {
    const lockFile = `${settingsFile}.lock`
    let fileHandle: Awaited<ReturnType<typeof open>> | undefined
    let attempts = 0

    while (attempts < MAX_LOCK_ATTEMPTS) {
        try {
            // 'wx' = create exclusively, fail if exists (cross-platform compatible)
            fileHandle = await open(lockFile, 'wx')
            break
        } catch (err: unknown) {
            const code = err && typeof err === 'object' && 'code' in err
                ? String((err as { code?: unknown }).code)
                : undefined
            if (code === 'EEXIST') {
                attempts++
                await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS))
                try {
                    const stats = await stat(lockFile)
                    if (Date.now() - stats.mtimeMs > STALE_LOCK_TIMEOUT_MS) {
                        await unlink(lockFile).catch(() => {})
                    }
                } catch {
                    // ignore stale-check failures
                }
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
        await fileHandle.close()
        await unlink(lockFile).catch(() => {})
    }
}
