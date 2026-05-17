/**
 * Key TanStack Router uses for its scroll restoration cache in sessionStorage.
 * Defined in `@tanstack/router-core/src/scroll-restoration.ts` (not part of
 * the package's public API — update this constant if the library bumps the
 * suffix on `tsr-scroll-restoration-v1_*`).
 */
const STORAGE_KEY = 'tsr-scroll-restoration-v1_3'

const TARGET_ENTRIES_AFTER_PRUNE = 50

const GUARD_MARKER = '__hapiScrollRestorationGuard'

interface GuardedStorage extends Storage {
    [GUARD_MARKER]?: true
}

/**
 * Wrap `sessionStorage.setItem` so writes to the scroll restoration cache
 * survive quota exhaustion. The default behavior throws synchronously during
 * a React commit, blocking the UI (see tiann/hapi#611). We prune the oldest
 * entries (by JSON property insertion order — i.e. visited-first dropped,
 * recently-visited kept) and retry once; if the value is not valid JSON or
 * the retry still fails, we drop the key entirely so navigation can continue.
 *
 * Idempotent — calling more than once on the same storage is a no-op.
 *
 * Returns an `uninstall` thunk that restores the original `setItem`. Intended
 * for tests; production code calls this once at boot and never uninstalls.
 */
export function installScrollRestorationGuard(
    storage: Storage = typeof window !== 'undefined' ? window.sessionStorage : undefined as unknown as Storage,
): () => void {
    if (!storage) {
        return () => {}
    }
    const guarded = storage as GuardedStorage
    if (guarded[GUARD_MARKER]) {
        return () => {}
    }
    const originalSetItem = storage.setItem
    const wrappedSetItem = (key: string, value: string): void => {
        try {
            originalSetItem.call(storage, key, value)
            return
        } catch (err) {
            if (key !== STORAGE_KEY || !isQuotaError(err)) {
                throw err
            }
        }
        let trimmed: string
        try {
            const parsed = JSON.parse(value) as Record<string, unknown>
            const keys = Object.keys(parsed)
            const keepKeys = keys.length > TARGET_ENTRIES_AFTER_PRUNE
                ? keys.slice(-TARGET_ENTRIES_AFTER_PRUNE)
                : keys
            const next: Record<string, unknown> = {}
            for (const k of keepKeys) {
                next[k] = parsed[k]
            }
            trimmed = JSON.stringify(next)
        } catch {
            storage.removeItem(STORAGE_KEY)
            return
        }
        try {
            originalSetItem.call(storage, key, trimmed)
        } catch {
            storage.removeItem(STORAGE_KEY)
        }
    }
    storage.setItem = wrappedSetItem
    guarded[GUARD_MARKER] = true
    return () => {
        if (storage.setItem === wrappedSetItem) {
            storage.setItem = originalSetItem
            delete guarded[GUARD_MARKER]
        }
    }
}

function isQuotaError(err: unknown): boolean {
    return (
        err instanceof Error &&
        (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
    )
}
