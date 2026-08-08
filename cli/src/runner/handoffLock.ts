import type { FileHandle } from 'node:fs/promises'
import { acquireRunnerLock, releaseRunnerLock } from '@/persistence'
import { logger } from '@/ui/logger'

/**
 * Failed-handoff lock reclaim budget.
 *
 * `acquireRunnerLock` sleeps `attempt * delayIncrementMs` between attempts, so
 * `(60, 500)` is ~14m45s of backoff - longer than the hub's upgrade RPC
 * timeout. Keep this under the 30s handoff wait + a small grace so a stuck
 * child cannot strand the UI while the parent sits unlocked.
 *
 * Max backoff = 500 * (1+…+10) = 27_500 ms for 11 attempts.
 */
export const FAILED_HANDOFF_LOCK_MAX_ATTEMPTS = 11
export const FAILED_HANDOFF_LOCK_DELAY_INCREMENT_MS = 500

/** Total sleep when every attempt fails (delays fire before the final attempt). */
export function failedHandoffLockMaxBackoffMs(
    maxAttempts: number = FAILED_HANDOFF_LOCK_MAX_ATTEMPTS,
    delayIncrementMs: number = FAILED_HANDOFF_LOCK_DELAY_INCREMENT_MS,
): number {
    let total = 0
    for (let attempt = 1; attempt < maxAttempts; attempt++) {
        total += attempt * delayIncrementMs
    }
    return total
}

/**
 * Hooks so RPC-driven self-upgrade can release/reacquire the runner lock the
 * same way mtime handoff does in run.ts — child cannot write runner.state.json
 * until the parent releases the lock.
 */
type HandoffLockHooks = {
    release: () => Promise<void>
    reacquire: () => Promise<boolean>
}

let hooks: HandoffLockHooks | null = null

export function registerRunnerHandoffLockHooks(next: HandoffLockHooks | null): void {
    hooks = next
}

export function createRunnerHandoffLockHooks(getHandle: () => FileHandle | null, setHandle: (handle: FileHandle | null) => void): HandoffLockHooks {
    return {
        release: async () => {
            const handle = getHandle()
            if (!handle) {
                return
            }
            await releaseRunnerLock(handle)
            setHandle(null)
        },
        reacquire: async () => {
            const reacquired = await acquireRunnerLock(
                FAILED_HANDOFF_LOCK_MAX_ATTEMPTS,
                FAILED_HANDOFF_LOCK_DELAY_INCREMENT_MS,
            )
            if (!reacquired) {
                return false
            }
            setHandle(reacquired)
            return true
        },
    }
}

export async function releaseRunnerLockForHandoff(): Promise<void> {
    if (!hooks) {
        logger.debug('[RUNNER HANDOFF] No lock hooks registered; child may block on lock')
        return
    }
    await hooks.release()
}

export async function reacquireRunnerLockAfterFailedHandoff(): Promise<boolean> {
    if (!hooks) {
        return false
    }
    return await hooks.reacquire()
}
