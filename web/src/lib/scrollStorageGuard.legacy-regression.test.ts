/**
 * Positive regression: legacy #707 unwrap bypasses the guard on quota failures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'tsr-scroll-restoration-v1_3'

class QuotaExceededError extends Error {
    constructor() {
        super('quota')
        this.name = 'QuotaExceededError'
    }
}

function legacyWriteScrollRestorationCache(
    storage: Storage,
    originalSetItem: Storage['setItem'],
    scrollCacheSet: (updater: (state: Record<string, unknown>) => Record<string, unknown>) => void,
): void {
    const guardedSetItem = storage.setItem
    storage.setItem = originalSetItem
    try {
        scrollCacheSet(() => ({}))
    } finally {
        storage.setItem = guardedSetItem
    }
}

function makeMockStorage(): Storage & { _store: Record<string, string>; _setItem: ReturnType<typeof vi.fn> } {
    const store: Record<string, string> = {}
    const setItem = vi.fn((key: string, value: string) => { store[key] = value })
    const storage = {
        setItem,
        getItem: (key: string) => store[key] ?? null,
        removeItem: vi.fn((key: string) => { delete store[key] }),
        clear: vi.fn(() => { for (const k of Object.keys(store)) delete store[k] }),
        key: () => null,
        length: 0,
    } as unknown as Storage & { _store: Record<string, string>; _setItem: ReturnType<typeof vi.fn> }
    storage._store = store
    storage._setItem = setItem
    return storage
}

describe('legacy #707 unwrap race (positive repro)', () => {
    let storage: ReturnType<typeof makeMockStorage>
    let guardedSetItem: Storage['setItem']
    let originalSetItem: Storage['setItem']

    beforeEach(() => {
        storage = makeMockStorage()
        originalSetItem = storage._setItem
        guardedSetItem = vi.fn((key: string, value: string) => {
            try {
                originalSetItem.call(storage, key, value)
            } catch (err) {
                if (key === STORAGE_KEY) {
                    return
                }
                throw err
            }
        }) as Storage['setItem']
        storage.setItem = guardedSetItem
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('legacy unwrap throws QuotaExceededError through native setItem (positive repro)', () => {
        originalSetItem.mockImplementation((key: string) => {
            if (key === STORAGE_KEY) {
                throw new QuotaExceededError()
            }
        })

        const tanStackPersist = (updater: (state: Record<string, unknown>) => Record<string, unknown>) => {
            const next = updater({ stale: { window: { scrollX: 0, scrollY: 1 } } })
            storage.setItem(STORAGE_KEY, JSON.stringify(next))
        }

        expect(() => legacyWriteScrollRestorationCache(storage, originalSetItem, tanStackPersist)).toThrow(QuotaExceededError)
        expect(guardedSetItem).not.toHaveBeenCalled()
    })

    it('fixed pattern routes cache persist through guarded setItem and survives quota', () => {
        originalSetItem.mockImplementation((key: string) => {
            if (key === STORAGE_KEY) {
                throw new QuotaExceededError()
            }
        })

        const tanStackPersist = (updater: (state: Record<string, unknown>) => Record<string, unknown>) => {
            const next = updater({ stale: { window: { scrollX: 0, scrollY: 1 } } })
            storage.setItem(STORAGE_KEY, JSON.stringify(next))
        }

        expect(() => tanStackPersist(() => ({}))).not.toThrow()
        expect(guardedSetItem).toHaveBeenCalled()
    })
})
