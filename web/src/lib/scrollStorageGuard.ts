import { storageKey } from '@tanstack/router-core'

const STORAGE_KEY = storageKey

const TARGET_ENTRIES_AFTER_PRUNE = 50

const GUARD_MARKER = '__hapiScrollRestorationGuard'

interface GuardedStorage extends Storage {
    [GUARD_MARKER]?: true
}

function hardResetScrollRestorationPersistedState(storage: Storage): void {
    try {
        storage.removeItem(STORAGE_KEY)
    } catch {
        // ignore
    }
}

/**
 * Wrap `sessionStorage.setItem` so writes to the scroll restoration cache
 * survive quota exhaustion. The default throws synchronously during a React
 * commit, blocking the UI (see tiann/hapi#611). We prune oldest entries and
 * retry once; if still failing, we drop the key so navigation can continue.
 *
 * Upstream >=1.145.6 also wraps setItem with try-catch, so this guard is an
 * additional safety net that proactively keeps the cache small.
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
            if (key !== STORAGE_KEY) {
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
            hardResetScrollRestorationPersistedState(storage)
            return
        }
        try {
            originalSetItem.call(storage, key, trimmed)
        } catch {
            hardResetScrollRestorationPersistedState(storage)
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
