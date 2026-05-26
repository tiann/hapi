/**
 * Key TanStack Router uses for its scroll restoration cache in sessionStorage.
 * Defined in `@tanstack/router-core/src/scroll-restoration.ts` (not part of
 * the package's public API — update this constant if the library bumps the
 * suffix on `tsr-scroll-restoration-v1_*`).
 */
import { scrollRestorationCache } from '@tanstack/router-core'

type ScrollCacheUpdater = NonNullable<Parameters<NonNullable<typeof scrollRestorationCache>['set']>[0]>

const STORAGE_KEY = 'tsr-scroll-restoration-v1_3'

const TARGET_ENTRIES_AFTER_PRUNE = 50

const GUARD_MARKER = '__hapiScrollRestorationGuard'

interface GuardedStorage extends Storage {
    [GUARD_MARKER]?: true
}

function writeScrollRestorationCache(
    storage: Storage,
    originalSetItem: Storage['setItem'],
    updater: ScrollCacheUpdater,
): void {
    const guardedSetItem = storage.setItem
    storage.setItem = originalSetItem
    try {
        scrollRestorationCache?.set(updater)
    } finally {
        storage.setItem = guardedSetItem
    }
}

function hardResetScrollRestorationPersistedState(
    storage: Storage,
    originalSetItem: Storage['setItem'],
    isRealSessionStorage: boolean
): void {
    try {
        storage.removeItem(STORAGE_KEY)
    } catch {
        // ignore
    }
    if (!isRealSessionStorage) {
        return
    }
    // TanStack keeps the full scroll map in memory even when setItem fails.
    // Pruning only the JSON string leaves RAM oversized — the next scroll
    // write throws again. Clear the library cache so persisted size matches.
    try {
        writeScrollRestorationCache(storage, originalSetItem, () => ({}))
    } catch {
        try {
            originalSetItem.call(storage, STORAGE_KEY, '{}')
        } catch {
            // last resort: session may be full or private-mode broken
        }
    }
}

/**
 * Wrap `sessionStorage.setItem` so writes to the scroll restoration cache
 * survive quota exhaustion. The default behavior throws synchronously during
 * a React commit, blocking the UI (see tiann/hapi#611). We prune the oldest
 * entries (by JSON property insertion order — i.e. visited-first dropped,
 * recently-visited kept) and retry once; if the value is not valid JSON or
 * the retry still fails, we drop the key and reset TanStack's in-memory cache
 * so navigation can continue.
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
    const isRealSessionStorage = typeof window !== 'undefined' && storage === window.sessionStorage

    const wrappedSetItem = (key: string, value: string): void => {
        try {
            originalSetItem.call(storage, key, value)
            return
        } catch (err) {
            if (key !== STORAGE_KEY) {
                throw err
            }
        }

        let trimmed: string
        let prunedState: Record<string, unknown>
        try {
            const parsed = JSON.parse(value) as Record<string, unknown>
            const keys = Object.keys(parsed)
            const keepKeys = keys.length > TARGET_ENTRIES_AFTER_PRUNE
                ? keys.slice(-TARGET_ENTRIES_AFTER_PRUNE)
                : keys
            prunedState = {}
            for (const k of keepKeys) {
                prunedState[k] = parsed[k]
            }
            trimmed = JSON.stringify(prunedState)
        } catch {
            hardResetScrollRestorationPersistedState(storage, originalSetItem, isRealSessionStorage)
            return
        }
        try {
            originalSetItem.call(storage, key, trimmed)
            if (isRealSessionStorage) {
                writeScrollRestorationCache(storage, originalSetItem, (() => prunedState) as ScrollCacheUpdater)
            }
        } catch {
            hardResetScrollRestorationPersistedState(storage, originalSetItem, isRealSessionStorage)
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
