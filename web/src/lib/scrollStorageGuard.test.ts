import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { storageKey as STORAGE_KEY } from '@tanstack/router-core'

import { installScrollRestorationGuard } from './scrollStorageGuard'

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

describe('installScrollRestorationGuard', () => {
    let storage: ReturnType<typeof makeMockStorage>
    let uninstall: () => void

    beforeEach(() => {
        storage = makeMockStorage()
        uninstall = installScrollRestorationGuard(storage)
    })

    afterEach(() => {
        uninstall()
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
        const fullState: Record<string, unknown> = {}
        for (let i = 0; i < 100; i++) {
            fullState[`/route/${i}`] = { window: { scrollX: 0, scrollY: i } }
        }
        const fullValue = JSON.stringify(fullState)

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
        const fullState: Record<string, unknown> = {}
        for (let i = 0; i < 100; i++) {
            fullState[`/route/${i}`] = { window: { scrollX: 0, scrollY: i } }
        }
        const fullValue = JSON.stringify(fullState)

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
        const fullState: Record<string, unknown> = {}
        for (let i = 0; i < 100; i++) {
            fullState[`/route/${i}`] = { window: { scrollX: 0, scrollY: i } }
        }
        const fullValue = JSON.stringify(fullState)

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
        expect(storedKeys).toContain('/route/99') // newest kept
        expect(storedKeys).toContain('/route/50') // boundary kept
        expect(storedKeys).not.toContain('/route/49') // boundary dropped
        expect(storedKeys).not.toContain('/route/0') // oldest dropped
    })

    it('removes the key entirely if the value is not valid JSON', () => {
        storage._setItem.mockImplementationOnce(() => { throw new QuotaExceededError() })
        storage.setItem(STORAGE_KEY, 'not json {')
        expect(storage.removeItem).toHaveBeenCalledWith(STORAGE_KEY)
    })

    it('removes the key entirely if the retried write also throws', () => {
        const fullState: Record<string, unknown> = {}
        for (let i = 0; i < 100; i++) {
            fullState[`/route/${i}`] = { window: { scrollX: 0, scrollY: i } }
        }
        storage._setItem.mockImplementation(() => { throw new QuotaExceededError() })

        storage.setItem(STORAGE_KEY, JSON.stringify(fullState))

        expect(storage.removeItem).toHaveBeenCalledWith(STORAGE_KEY)
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
