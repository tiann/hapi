import { describe, expect, it, beforeEach, vi } from 'vitest'
import { getSessionLastSeenAt, markSessionSeen } from './sessionLastSeen'

describe('sessionLastSeen', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('stores the latest seen timestamp for a session', () => {
        markSessionSeen('session-a', 1000)
        markSessionSeen('session-a', 2500)
        expect(getSessionLastSeenAt('session-a')).toBe(2500)
    })

    it('does not move the watermark backwards', () => {
        markSessionSeen('session-a', 5000)
        markSessionSeen('session-a', 2000)
        expect(getSessionLastSeenAt('session-a')).toBe(5000)
    })

    it('ignores localStorage write failures', () => {
        const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('quota exceeded')
        })

        expect(() => markSessionSeen('session-a', 1000)).not.toThrow()

        setItem.mockRestore()
    })

    it('returns zero when localStorage getter throws', () => {
        const localStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            get() {
                throw new Error('storage denied')
            },
        })

        expect(getSessionLastSeenAt('session-a')).toBe(0)
        expect(() => markSessionSeen('session-a', 1000)).not.toThrow()

        if (localStorageDescriptor) {
            Object.defineProperty(window, 'localStorage', localStorageDescriptor)
        }
    })
})
