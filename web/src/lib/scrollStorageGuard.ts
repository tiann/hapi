/**
 * Key TanStack Router uses for its scroll restoration cache in sessionStorage.
 * Defined in `@tanstack/router-core/src/scroll-restoration.ts` (not part of
 * the package's public API — update this constant if the library bumps the
 * suffix on `tsr-scroll-restoration-v1_*`).
 */
import { functionalUpdate, scrollRestorationCache } from '@tanstack/router-core'

type ScrollCacheUpdater = NonNullable<Parameters<NonNullable<typeof scrollRestorationCache>['set']>[0]>
type ScrollCacheState = Record<string, unknown>

const STORAGE_KEY = 'tsr-scroll-restoration-v1_3'

const TARGET_ENTRIES_AFTER_PRUNE = 50

const GUARD_MARKER = '__hapiScrollRestorationGuard'

interface GuardedStorage extends Storage {
    [GUARD_MARKER]?: true
}

function readScrollCacheState(storage: Storage): ScrollCacheState {
    try {
        const raw = storage.getItem(STORAGE_KEY)
        return raw ? JSON.parse(raw) as ScrollCacheState : {}
    } catch {
        return {}
    }
}

function patchScrollRestorationCacheSet(
    storage: Storage,
): () => void {
    if (!scrollRestorationCache) {
        return () => {}
    }
    const originalCacheSet = scrollRestorationCache.set.bind(scrollRestorationCache)
    let cacheState = readScrollCacheState(storage)

    scrollRestorationCache.set = (updater: ScrollCacheUpdater): void => {
        cacheState = (functionalUpdate(updater, cacheState as never) ?? cacheState) as ScrollCacheState
        // Always persist through the guarded sessionStorage.setItem — never unwrap
        // native setItem (see tiann/hapi#716).
        storage.setItem(STORAGE_KEY, JSON.stringify(cacheState))
    }

    return () => {
        scrollRestorationCache!.set = originalCacheSet
    }
}

function hardResetScrollRestorationPersistedState(
    storage: Storage,
    originalSetItem: Storage['setItem'],
    isRealSessionStorage: boolean,
    recoveryDepth: { current: number },
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
    if (recoveryDepth.current > 0) {
        try {
            originalSetItem.call(storage, STORAGE_KEY, '{}')
        } catch {
            // nested recovery already in progress
        }
        return
    }
    recoveryDepth.current += 1
    try {
        scrollRestorationCache?.set(() => ({}))
    } catch {
        try {
            originalSetItem.call(storage, STORAGE_KEY, '{}')
        } catch {
            // last resort: session may be full or private-mode broken
        }
    } finally {
        recoveryDepth.current -= 1
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
    const recoveryDepth = { current: 0 }
    const unpatchScrollCache = isRealSessionStorage ? patchScrollRestorationCacheSet(storage) : () => {}

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
        let prunedState: ScrollCacheState
        try {
            const parsed = JSON.parse(value) as ScrollCacheState
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
            hardResetScrollRestorationPersistedState(storage, originalSetItem, isRealSessionStorage, recoveryDepth)
            return
        }
        try {
            originalSetItem.call(storage, key, trimmed)
            if (isRealSessionStorage) {
                scrollRestorationCache?.set((() => prunedState) as ScrollCacheUpdater)
            }
        } catch {
            hardResetScrollRestorationPersistedState(storage, originalSetItem, isRealSessionStorage, recoveryDepth)
        }
    }
    storage.setItem = wrappedSetItem
    guarded[GUARD_MARKER] = true
    return () => {
        unpatchScrollCache()
        if (storage.setItem === wrappedSetItem) {
            storage.setItem = originalSetItem
            delete guarded[GUARD_MARKER]
        }
    }
}
