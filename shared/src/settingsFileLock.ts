/**
 * Cross-process exclusive lock for settings.json (and similar).
 * Shared by hub and CLI. Uses proper-lockfile (mkdir + mtime lease) so a
 * crash cannot leave an unreclaimable empty sidecar.
 */

import lockfile from 'proper-lockfile'

const LOCK_RETRY_INTERVAL_MS = 100
const MAX_LOCK_ATTEMPTS = 50
const STALE_MS = 30_000
const UPDATE_MS = 10_000

let maxLockAttemptsForTests: number | undefined
let staleMsForTests: number | undefined

/** @internal test-only */
export function setSettingsLockMaxAttemptsForTests(value: number | undefined): void {
    maxLockAttemptsForTests = value
}

/** @internal test-only */
export function setSettingsLockStaleMsForTests(value: number | undefined): void {
    staleMsForTests = value
}

export async function withSettingsFileLock<T>(
    settingsFile: string,
    work: () => Promise<T>
): Promise<T> {
    const retries = maxLockAttemptsForTests ?? MAX_LOCK_ATTEMPTS
    const stale = staleMsForTests ?? STALE_MS
    // Distinct from earlier file-shaped `*.lock` sidecars in this PR so a
    // leftover empty file cannot block mkdir-based acquisition.
    const lockfilePath = `${settingsFile}.hapi.lock`

    const release = await lockfile.lock(settingsFile, {
        realpath: false,
        lockfilePath,
        stale,
        update: Math.min(UPDATE_MS, Math.floor(stale / 2)),
        retries: {
            retries,
            minTimeout: LOCK_RETRY_INTERVAL_MS,
            maxTimeout: LOCK_RETRY_INTERVAL_MS,
        },
    })

    try {
        return await work()
    } finally {
        await release()
    }
}
