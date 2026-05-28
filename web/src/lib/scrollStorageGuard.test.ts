import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scrollRestorationCache } from '@tanstack/router-core'
import { installScrollRestorationGuard } from './scrollStorageGuard'

const STORAGE_KEY = 'tsr-scroll-restoration-v1_3'
const RETAIN_COUNT = 50

class QuotaExceededError extends Error {
    constructor() {
        super('quota')
        this.name = 'QuotaExceededError'
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

function makeFullScrollState(count = 100): Record<string, unknown> {
    const fullState: Record<string, unknown> = {}
    for (let i = 0; i < count; i++) {
        fullState[`/route/${i}`] = { window: { scrollX: 0, scrollY: i } }
    }
    return fullState
}

describe('installScrollRestorationGuard', () => {
    let storage: ReturnType<typeof makeMockStorage>
    let uninstall: () => void

    beforeEach(() => {
        storage = makeMockStorage()
        uninstall = installScrollRestorationGuard(storage)
    })

    afterEach(() => {
        uninstall()
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('passes through writes to keys other than the scroll restoration key unchanged on quota error', () => {
        storage._setItem.mockImplementationOnce(() => { throw new QuotaExceededError() })
        expect(() => storage.setItem('other-key', 'value')).toThrow(QuotaExceededError)
    })

    it('recovers from any write failure on the scroll key, not only quota errors', () => {
        class GenericStorageError extends Error {
            constructor() {
                super('storage write failed')
                this.name = 'SecurityError'
            }
        }
        const fullValue = JSON.stringify(makeFullScrollState())

        let call = 0
        storage._setItem.mockImplementation((key: string, value: string) => {
            call += 1
            if (call === 1) {
                throw new GenericStorageError()
            }
            storage._store[key] = value
        })

        storage.setItem(STORAGE_KEY, fullValue)

        expect(storage._setItem).toHaveBeenCalledTimes(2)
        expect(Object.keys(JSON.parse(storage._store[STORAGE_KEY]) as object).length).toBe(RETAIN_COUNT)
    })

    it('handles quota errors that are not instanceof Error (DOMException-shaped)', () => {
        const domExceptionLike = {
            name: 'QuotaExceededError',
            message: "Failed to execute 'setItem' on 'Storage': Setting the value of 'tsr-scroll-restoration-v1_3' exceeded the quota."
        }
        const fullValue = JSON.stringify(makeFullScrollState())

        let call = 0
        storage._setItem.mockImplementation((key: string, value: string) => {
            call += 1
            if (call === 1) {
                throw domExceptionLike
            }
            storage._store[key] = value
        })

        expect(domExceptionLike instanceof Error).toBe(false)
        storage.setItem(STORAGE_KEY, fullValue)

        expect(storage._setItem).toHaveBeenCalledTimes(2)
        expect(Object.keys(JSON.parse(storage._store[STORAGE_KEY]) as object).length).toBe(RETAIN_COUNT)
    })

    it('passes through scroll restoration writes that succeed', () => {
        storage.setItem(STORAGE_KEY, JSON.stringify({ a: 1 }))
        expect(storage._store[STORAGE_KEY]).toBe(JSON.stringify({ a: 1 }))
    })

    it('prunes oldest entries to exactly the retain count and retries on quota error', () => {
        const fullValue = JSON.stringify(makeFullScrollState())

        let call = 0
        storage._setItem.mockImplementation((key: string, value: string) => {
            call += 1
            if (call === 1) {
                throw new QuotaExceededError()
            }
            storage._store[key] = value
        })

        storage.setItem(STORAGE_KEY, fullValue)

        expect(storage._setItem).toHaveBeenCalledTimes(2)
        const stored = JSON.parse(storage._store[STORAGE_KEY]) as Record<string, unknown>
        const storedKeys = Object.keys(stored)
        expect(storedKeys.length).toBe(RETAIN_COUNT)
        expect(storedKeys).toContain('/route/99')
        expect(storedKeys).toContain('/route/50')
        expect(storedKeys).not.toContain('/route/49')
        expect(storedKeys).not.toContain('/route/0')
    })

    it('syncs TanStack in-memory scroll cache after a successful prune on real sessionStorage', () => {
        const realSessionStorage = makeMockStorage()
        vi.stubGlobal('window', { sessionStorage: realSessionStorage })

        const off = installScrollRestorationGuard(realSessionStorage)
        const fullValue = JSON.stringify(makeFullScrollState())

        let call = 0
        realSessionStorage._setItem.mockImplementation((key: string, value: string) => {
            call += 1
            if (call === 1) {
                throw new QuotaExceededError()
            }
            realSessionStorage._store[key] = value
        })

        realSessionStorage.setItem(STORAGE_KEY, fullValue)

        let inMemoryKeyCount = 0
        scrollRestorationCache!.set((state) => {
            inMemoryKeyCount = Object.keys(state).length
            return state
        })
        expect(inMemoryKeyCount).toBe(RETAIN_COUNT)

        off()
    })

    it('keeps sessionStorage guard active while syncing in-memory scroll cache', () => {
        const realSessionStorage = makeMockStorage()
        vi.stubGlobal('window', { sessionStorage: realSessionStorage })

        const off = installScrollRestorationGuard(realSessionStorage)
        const wrappedSetItem = realSessionStorage.setItem
        const fullValue = JSON.stringify(makeFullScrollState())

        let call = 0
        let setItemDuringCacheSync: Storage['setItem'] | undefined
        realSessionStorage._setItem.mockImplementation((key: string, value: string) => {
            call += 1
            if (call === 1) {
                throw new QuotaExceededError()
            }
            realSessionStorage._store[key] = value
            if (call === 2) {
                setItemDuringCacheSync = realSessionStorage.setItem
            }
        })

        realSessionStorage.setItem(STORAGE_KEY, fullValue)

        expect(setItemDuringCacheSync).toBe(wrappedSetItem)

        off()
    })

    it('recovers concurrent scroll cache writes during guard sync without uncaught throws', () => {
        const realSessionStorage = makeMockStorage()
        vi.stubGlobal('window', { sessionStorage: realSessionStorage })

        const off = installScrollRestorationGuard(realSessionStorage)
        const fullValue = JSON.stringify(makeFullScrollState())

        let call = 0
        realSessionStorage._setItem.mockImplementation((key: string, value: string) => {
            call += 1
            if (call === 1) {
                throw new QuotaExceededError()
            }
            if (call === 2) {
                expect(() => scrollRestorationCache!.set(() => ({
                    '/concurrent': { window: { scrollX: 0, scrollY: 1 } },
                }))).not.toThrow()
            }
            realSessionStorage._store[key] = value
        })

        expect(() => realSessionStorage.setItem(STORAGE_KEY, fullValue)).not.toThrow()

        off()
    })

    it('removes the key entirely if the value is not valid JSON', () => {
        storage._setItem.mockImplementationOnce(() => { throw new QuotaExceededError() })
        storage.setItem(STORAGE_KEY, 'not json {')
        expect(storage.removeItem).toHaveBeenCalledWith(STORAGE_KEY)
    })

    it('removes the key entirely if the retried write also throws', () => {
        storage._setItem.mockImplementation(() => { throw new QuotaExceededError() })

        storage.setItem(STORAGE_KEY, JSON.stringify(makeFullScrollState()))

        expect(storage.removeItem).toHaveBeenCalledWith(STORAGE_KEY)
    })

    it('does not reset TanStack scroll cache when guarding mock storage', () => {
        const cacheSetBefore = scrollRestorationCache!.set
        storage._setItem.mockImplementationOnce(() => { throw new QuotaExceededError() })
        storage.setItem(STORAGE_KEY, 'not json {')

        expect(storage.removeItem).toHaveBeenCalledWith(STORAGE_KEY)
        expect(scrollRestorationCache!.set).toBe(cacheSetBefore)
    })

    it('resets TanStack in-memory scroll cache when hard reset uses real sessionStorage', () => {
        const realSessionStorage = makeMockStorage()
        vi.stubGlobal('window', { sessionStorage: realSessionStorage })

        const off = installScrollRestorationGuard(realSessionStorage)
        realSessionStorage._setItem.mockImplementation(() => { throw new QuotaExceededError() })

        realSessionStorage.setItem(STORAGE_KEY, JSON.stringify({ stale: { window: { scrollX: 0, scrollY: 1 } } }))

        expect(realSessionStorage.removeItem).toHaveBeenCalledWith(STORAGE_KEY)

        let inMemoryKeys: string[] = []
        scrollRestorationCache!.set((state) => {
            inMemoryKeys = Object.keys(state)
            return state
        })
        expect(inMemoryKeys).toEqual([])

        off()
    })

    it('does not recurse when nested recovery fallback write also fails on real sessionStorage', () => {
        const realSessionStorage = makeMockStorage()
        vi.stubGlobal('window', { sessionStorage: realSessionStorage })

        const off = installScrollRestorationGuard(realSessionStorage)
        realSessionStorage._setItem.mockImplementation((key: string) => {
            if (key === STORAGE_KEY) {
                throw new QuotaExceededError()
            }
        })

        expect(() => realSessionStorage.setItem(STORAGE_KEY, JSON.stringify(makeFullScrollState()))).not.toThrow()
        expect(realSessionStorage._setItem.mock.calls.length).toBeLessThan(20)

        off()
    })

    it('is idempotent — installing twice does not double-wrap', () => {
        const wrapped1 = storage.setItem
        const noop = installScrollRestorationGuard(storage)
        const wrapped2 = storage.setItem
        expect(wrapped2).toBe(wrapped1)
        noop()
    })

    it('uninstall restores the original setItem', () => {
        const fresh = makeMockStorage()
        const original = fresh.setItem
        const off = installScrollRestorationGuard(fresh)
        expect(fresh.setItem).not.toBe(original)
        off()
        expect(fresh.setItem).toBe(original)
    })
})
