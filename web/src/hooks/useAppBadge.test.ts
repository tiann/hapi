import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { markSessionSeen } from '@/lib/sessionLastSeen'
import { canUseAppBadging, countUnreadSessions, useAppBadge } from './useAppBadge'

function createSession(id: string, updatedAt: number): SessionSummary {
    return {
        id,
        active: false,
        thinking: false,
        activeAt: updatedAt,
        updatedAt,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
    }
}

function setDisplayMode(standalone: boolean): void {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
        matches: standalone && query === '(display-mode: standalone)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => false),
    }))
}

function setAppBadgeNavigator() {
    const setAppBadge = vi.fn().mockResolvedValue(undefined)
    const clearAppBadge = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { setAppBadge, clearAppBadge } as unknown as Navigator)
    return { setAppBadge, clearAppBadge }
}

describe('useAppBadge', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    afterEach(() => {
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
    })

    it('counts each session with activity newer than its local watermark', () => {
        expect(countUnreadSessions(
            [createSession('session-a', 11), createSession('session-b', 20)],
            { 'session-a': 10, 'session-b': 20 },
        )).toBe(1)
    })

    it('sets the native badge to the number of unread sessions in an installed PWA', async () => {
        setDisplayMode(true)
        const { setAppBadge, clearAppBadge } = setAppBadgeNavigator()
        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({
            'session-a': 10,
            'session-b': 20,
        }))

        renderHook(() => useAppBadge({
            enabled: true,
            scope: 'https://hapi.test',
            sessions: [createSession('session-a', 11), createSession('session-b', 20)],
            isLoading: false,
            hasError: false,
        }))

        await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(1))
        expect(clearAppBadge).not.toHaveBeenCalled()
    })

    it('clears the native badge after the unread session is seen', async () => {
        setDisplayMode(true)
        const { setAppBadge, clearAppBadge } = setAppBadgeNavigator()
        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({ 'session-a': 10 }))

        renderHook(() => useAppBadge({
            enabled: true,
            scope: 'https://hapi.test',
            sessions: [createSession('session-a', 11)],
            isLoading: false,
            hasError: false,
        }))

        await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(1))
        act(() => markSessionSeen('session-a', 11))
        await waitFor(() => expect(clearAppBadge).toHaveBeenCalledTimes(1))
    })

    it('seeds the first session snapshot without showing existing sessions as unread', async () => {
        setDisplayMode(true)
        const { setAppBadge, clearAppBadge } = setAppBadgeNavigator()

        renderHook(() => useAppBadge({
            enabled: true,
            scope: 'https://hapi.test',
            sessions: [createSession('session-a', 11)],
            isLoading: false,
            hasError: false,
        }))

        await waitFor(() => expect(clearAppBadge).toHaveBeenCalledTimes(1))
        expect(setAppBadge).not.toHaveBeenCalled()
    })

    it('clears the badge when the feature is disabled', async () => {
        setDisplayMode(true)
        const { setAppBadge, clearAppBadge } = setAppBadgeNavigator()
        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({ 'session-a': 10 }))

        const { rerender } = renderHook(
            (options: { enabled: boolean }) => useAppBadge({
                enabled: options.enabled,
                scope: 'https://hapi.test',
                sessions: [createSession('session-a', 11)],
                isLoading: false,
                hasError: false,
            }),
            { initialProps: { enabled: true } },
        )

        await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(1))
        rerender({ enabled: false })
        await waitFor(() => expect(clearAppBadge).toHaveBeenCalledTimes(1))
    })

    it('does not repeat the native update when the unread count is unchanged', async () => {
        setDisplayMode(true)
        const { setAppBadge } = setAppBadgeNavigator()
        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({ 'session-a': 10 }))

        const { rerender } = renderHook(
            (sessions: SessionSummary[]) => useAppBadge({
                enabled: true,
                scope: 'https://hapi.test',
                sessions,
                isLoading: false,
                hasError: false,
            }),
            { initialProps: [createSession('session-a', 11)] },
        )

        await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(1))
        rerender([createSession('session-a', 11)])
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(setAppBadge).toHaveBeenCalledTimes(1)
    })

    it('does not use app badges for a normal browser tab', async () => {
        setDisplayMode(false)
        const { setAppBadge, clearAppBadge } = setAppBadgeNavigator()

        renderHook(() => useAppBadge({
            enabled: true,
            scope: 'https://hapi.test',
            sessions: [createSession('session-a', 11)],
            isLoading: false,
            hasError: false,
        }))

        await new Promise(resolve => setTimeout(resolve, 0))
        expect(canUseAppBadging()).toBe(false)
        expect(setAppBadge).not.toHaveBeenCalled()
        expect(clearAppBadge).not.toHaveBeenCalled()
    })
})
