import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applySessionReadStates, configureSessionReadSync, disconnectSessionReadSync, getSessionLastSeenAt, getSessionManualUnreadAt } from '@/lib/sessionLastSeen'
import { useSelectedSessionSeen } from './useSelectedSessionSeen'

function setVisibilityState(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: state,
    })
}

beforeEach(() => {
    window.localStorage.clear()
})

afterEach(() => {
    disconnectSessionReadSync()
    setVisibilityState('visible')
})

describe('useSelectedSessionSeen', () => {
    it('waits for Hub read state before marking a visible selected session seen', () => {
        configureSessionReadSync('hub', () => {})
        renderHook(() => useSelectedSessionSeen('session-a', 300))
        expect(getSessionLastSeenAt('session-a')).toBe(0)
        act(() => applySessionReadStates([{ sessionId: 'session-a', lastSeenAt: 200, manualUnreadAt: null, version: 1 }]))
        expect(getSessionLastSeenAt('session-a')).toBe(300)
        act(() => applySessionReadStates([{ sessionId: 'session-a', lastSeenAt: 299, manualUnreadAt: 300, version: 3 }]))
        expect(getSessionManualUnreadAt('session-a')).toBe(300)
    })
    it('does not mark hidden selected-session updates as seen', () => {
        setVisibilityState('hidden')
        const { rerender } = renderHook(
            ({ updatedAt }) => useSelectedSessionSeen('session-a', updatedAt),
            { initialProps: { updatedAt: 100 } },
        )

        rerender({ updatedAt: 200 })

        expect(getSessionLastSeenAt('session-a')).toBe(0)
    })

    it('marks the latest selected-session update when visibility resumes', () => {
        setVisibilityState('hidden')
        const { rerender } = renderHook(
            ({ updatedAt }) => useSelectedSessionSeen('session-a', updatedAt),
            { initialProps: { updatedAt: 100 } },
        )

        rerender({ updatedAt: 200 })
        setVisibilityState('visible')
        act(() => document.dispatchEvent(new Event('visibilitychange')))

        expect(getSessionLastSeenAt('session-a')).toBe(200)
    })

    it('marks selected-session updates immediately while visible', () => {
        setVisibilityState('visible')
        renderHook(() => useSelectedSessionSeen('session-a', 300))

        expect(getSessionLastSeenAt('session-a')).toBe(300)
    })
})
