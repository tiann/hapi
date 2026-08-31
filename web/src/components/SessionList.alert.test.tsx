import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

const playSpy = vi.fn(() => true)
vi.mock('@/lib/blockedAlertSound', () => ({
    playBlockedAlertSound: () => playSpy(),
    BLOCKED_SOUND_THROTTLE_MS: 4000,
    resetBlockedAlertSoundThrottle: () => {},
}))

beforeEach(() => {
    playSpy.mockClear()
    localStorage.removeItem('hapi-blocked-alert-mode')
})

afterEach(() => {
    cleanup()
    localStorage.removeItem('hapi-blocked-alert-mode')
})

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: Date.now(),
        metadata: { path: '/home/ubuntu', name: overrides.id, flavor: 'claude' },
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
        attachedJob: null,
        attachedJobUpdatedAt: 0,
        model: null,
        effort: null,
        ...overrides
    }
}

function blocked(id: string): SessionSummary {
    return makeSession({ id, lastNotify: { status: 'blocked', at: Date.now(), note: 'stuck' } })
}

const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
})

function tree(sessions: SessionSummary[]): ReactNode {
    return (
        <QueryClientProvider client={queryClient}>
            <ToastProvider>
                <I18nProvider>
                    <SessionList
                        sessions={sessions}
                        selectedSessionId={null}
                        onSelect={vi.fn()}
                        onNewSession={vi.fn()}
                        onRefresh={vi.fn()}
                        isLoading={false}
                        api={null}
                    />
                </I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
}

function pill(): HTMLElement {
    return screen.getByTestId('blocked-jump-pill')
}

describe('blocked arrival alert (#1717)', () => {
    it('does not alert for a backlog that was already there on first paint', () => {
        // Opening the app to 5 pre-existing blockers must not buzz.
        render(tree([blocked('a'), blocked('b')]))

        expect(pill().className).not.toContain('animate-blocked-alert')
        expect(playSpy).not.toHaveBeenCalled()
    })

    it('pulses when a new session becomes blocked', () => {
        const { rerender } = render(tree([blocked('a')]))
        expect(pill().className).not.toContain('animate-blocked-alert')

        rerender(tree([blocked('a'), blocked('b')]))

        expect(pill().className).toContain('animate-blocked-alert')
    })

    it('alerts on a swap that leaves the count unchanged', () => {
        // One resolved, another arrived. A count-based check nets to zero and
        // would silently skip the alert on the new blocker.
        const { rerender } = render(tree([blocked('a')]))
        rerender(tree([blocked('b')]))

        expect(pill().className).toContain('animate-blocked-alert')
    })

    it('stops pulsing after the alert window', () => {
        vi.useFakeTimers()
        try {
            const { rerender } = render(tree([blocked('a')]))
            rerender(tree([blocked('a'), blocked('b')]))
            expect(pill().className).toContain('animate-blocked-alert')

            act(() => { vi.advanceTimersByTime(9000) })

            expect(pill().className).not.toContain('animate-blocked-alert')
        } finally {
            vi.useRealTimers()
        }
    })

    it('does not pulse when a blocker is only resolved', () => {
        const { rerender } = render(tree([blocked('a'), blocked('b')]))
        rerender(tree([blocked('a')]))

        expect(pill().className).not.toContain('animate-blocked-alert')
    })

    it('stops pulsing even when the blocked list keeps churning', () => {
        // The id list changes constantly at fleet scale. An effect that owned
        // the timer would cancel its own pending clear on every churn and leave
        // the counter pulsing forever.
        vi.useFakeTimers()
        try {
            const { rerender } = render(tree([blocked('a')]))
            rerender(tree([blocked('a'), blocked('b')]))
            expect(pill().className).toContain('animate-blocked-alert')

            for (let i = 0; i < 6; i += 1) {
                act(() => { vi.advanceTimersByTime(500) })
                // Churn that is not an arrival: b resolves, b returns, etc.
                rerender(tree(i % 2 === 0 ? [blocked('a')] : [blocked('a'), blocked('b')]))
            }
            act(() => { vi.advanceTimersByTime(20000) })

            expect(pill().className).not.toContain('animate-blocked-alert')
        } finally {
            vi.useRealTimers()
        }
    })

    it('does not treat the first loaded payload as a wave of new blockers', () => {
        // The router mounts with sessions={[]} while /sessions is in flight, so
        // seeding the baseline on the literal first render would buzz on every
        // cold page load for a backlog that was already there.
        localStorage.setItem('hapi-blocked-alert-mode', 'sound')
        const { rerender } = render(tree([]))
        rerender(tree([blocked('a'), blocked('b'), blocked('c')]))

        expect(playSpy).not.toHaveBeenCalled()
        expect(screen.queryByTestId('blocked-jump-pill')?.className ?? '')
            .not.toContain('animate-blocked-alert')
    })

    it('stays silent in count-only mode', () => {
        localStorage.setItem('hapi-blocked-alert-mode', 'count')
        const { rerender } = render(tree([blocked('a')]))
        rerender(tree([blocked('a'), blocked('b')]))

        expect(pill().className).not.toContain('animate-blocked-alert')
        expect(playSpy).not.toHaveBeenCalled()
    })

    it('plays the tone only in sound mode', () => {
        const { rerender } = render(tree([blocked('a')]))
        rerender(tree([blocked('a'), blocked('b')]))
        expect(playSpy).not.toHaveBeenCalled()
        cleanup()

        localStorage.setItem('hapi-blocked-alert-mode', 'sound')
        const second = render(tree([blocked('a')]))
        second.rerender(tree([blocked('a'), blocked('b')]))

        expect(playSpy).toHaveBeenCalledTimes(1)
    })
})
