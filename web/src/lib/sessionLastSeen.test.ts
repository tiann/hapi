import { createElement } from 'react'
import { act, render } from '@testing-library/react'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
    getSessionLastSeenAt,
    getSessionLastSeenSnapshot,
    getSessionManualUnreadAt,
    initializeSessionLastSeen,
    markSessionUnread,
    markSessionSeen,
    useSessionLastSeenVersion,
} from './sessionLastSeen'

function SessionLastSeenVersionProbe() {
    const version = useSessionLastSeenVersion()
    return createElement('output', { 'data-testid': 'last-seen-version' }, version)
}

describe('sessionLastSeen', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('stores the latest seen timestamp for a session', () => {
        markSessionSeen('session-a', 1000)
        markSessionSeen('session-a', 2500)
        expect(getSessionLastSeenAt('session-a')).toBe(2500)
    })

    it('snapshots the store once for bulk unread filtering', () => {
        markSessionSeen('session-a', 1000)
        markSessionSeen('session-b', 2500)
        expect(getSessionLastSeenSnapshot()).toEqual({
            'session-a': 1000,
            'session-b': 2500,
        })
    })

    it('does not move the watermark backwards', () => {
        markSessionSeen('session-a', 5000)
        markSessionSeen('session-a', 2000)
        expect(getSessionLastSeenAt('session-a')).toBe(5000)
    })

    it('moves the watermark behind the current activity when marking unread', () => {
        markSessionSeen('session-a', 5000)

        markSessionUnread('session-a', 5000)

        expect(getSessionLastSeenAt('session-a')).toBe(4999)
        expect(getSessionManualUnreadAt('session-a')).toBe(5000)
    })

    it('does not change an already-unread watermark when marking unread', () => {
        markSessionSeen('session-a', 1000)

        markSessionUnread('session-a', 5000)

        expect(getSessionLastSeenAt('session-a')).toBe(1000)
        expect(getSessionManualUnreadAt('session-a')).toBe(5000)
    })

    it('clears the explicit unread marker when the session is seen', () => {
        markSessionUnread('session-a', 5000)
        expect(getSessionManualUnreadAt('session-a')).toBe(5000)

        markSessionSeen('session-a', 5000)

        expect(getSessionManualUnreadAt('session-a')).toBeNull()
    })

    it('preserves an explicit unread marker when a stale seen timestamp arrives', () => {
        markSessionUnread('session-a', 5000)

        markSessionSeen('session-a', 4000)

        expect(getSessionLastSeenAt('session-a')).toBe(4999)
        expect(getSessionManualUnreadAt('session-a')).toBe(5000)
    })

    it('notifies same-tab consumers when the watermark changes', () => {
        const view = render(createElement(SessionLastSeenVersionProbe))
        const initialVersion = Number(view.getByTestId('last-seen-version').textContent)

        act(() => {
            markSessionUnread('session-a', 5000)
        })

        expect(view.getByTestId('last-seen-version')).toHaveTextContent(String(initialVersion + 1))
    })

    it('notifies consumers when either read-state key changes in another tab', () => {
        const view = render(createElement(SessionLastSeenVersionProbe))
        const initialVersion = Number(view.getByTestId('last-seen-version').textContent)

        act(() => {
            window.dispatchEvent(new StorageEvent('storage', { key: 'hapi.sessionLastSeen.v1' }))
        })
        expect(view.getByTestId('last-seen-version')).toHaveTextContent(String(initialVersion + 1))

        act(() => {
            window.dispatchEvent(new StorageEvent('storage', { key: 'hapi.sessionManualUnread.v1' }))
        })
        expect(view.getByTestId('last-seen-version')).toHaveTextContent(String(initialVersion + 2))
    })

    it('uses the first session list as the unread baseline', () => {
        initializeSessionLastSeen('hub-a', [
            { id: 'session-a', updatedAt: 1000 },
            { id: 'session-b', updatedAt: 2500 },
        ])

        expect(getSessionLastSeenAt('session-a')).toBe(1000)
        expect(getSessionLastSeenAt('session-b')).toBe(2500)
    })

    it('preserves existing watermarks while completing a legacy partial baseline', () => {
        markSessionSeen('session-a', 1000)

        initializeSessionLastSeen('hub-a', [
            { id: 'session-a', updatedAt: 2500 },
            { id: 'session-b', updatedAt: 2500 },
        ])

        expect(getSessionLastSeenAt('session-a')).toBe(1000)
        expect(getSessionLastSeenAt('session-b')).toBe(2500)

        initializeSessionLastSeen('hub-a', [{ id: 'session-c', updatedAt: 3000 }])
        expect(getSessionLastSeenAt('session-c')).toBe(0)
    })

    it('initializes each hub independently', () => {
        initializeSessionLastSeen('hub-a', [{ id: 'session-a', updatedAt: 1000 }])
        initializeSessionLastSeen('hub-b', [{ id: 'session-b', updatedAt: 2000 }])

        expect(getSessionLastSeenAt('session-b')).toBe(2000)
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
