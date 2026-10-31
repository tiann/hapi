import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { markCodexSessionsImported } from '@/lib/codexImportedSessions'
import { SessionRowSummary } from './SessionRowSummary'

afterEach(() => cleanup())

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id: 'background-demo',
        active: true,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: { path: '/demo/status', name: 'Background demo', flavor: 'claude' },
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 2,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...overrides
    }
}

function renderSummary(showDetailedStatus: boolean) {
    return render(
        <I18nProvider>
            <SessionRowSummary
                session={makeSummary()}
                showDetailedStatus={showDetailedStatus}
            />
        </I18nProvider>
    )
}

describe('SessionRowSummary background status', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('draws the background spinner with the thinking spinner markup, only in blue', () => {
        const background = renderSummary(false).container.querySelector('svg.animate-spin-slow')
        cleanup()
        const thinking = render(
            <I18nProvider>
                <SessionRowSummary session={makeSummary({ thinking: true, backgroundTaskCount: 0 })} />
            </I18nProvider>
        ).container.querySelector('svg.animate-spin-slow')

        expect(screen.queryByText('Running', { exact: true })).not.toBeInTheDocument()
        expect(background?.outerHTML.replace('text-blue-400', 'text-[var(--app-badge-success-text)]'))
            .toBe(thinking?.outerHTML)
    })

    it('shows a detailed background dot with the task-count tooltip in Extended mode', () => {
        renderSummary(true)

        expect(screen.queryByText('Running', { exact: true })).not.toBeInTheDocument()
        const tooltip = screen.getByRole('tooltip', { hidden: true })
        expect(tooltip).toHaveTextContent('Background tasks running')
        expect(tooltip).toHaveTextContent('2 tasks running')
    })

    it('refreshes unread attention when the local watermark version changes', () => {
        const session = makeSummary({
            active: false,
            backgroundTaskCount: 0,
            updatedAt: 2_000,
        })
        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({ [session.id]: 2_000 }))
        const view = render(
            <I18nProvider>
                <SessionRowSummary
                    session={session}
                    showDetailedStatus={true}
                    lastSeenVersion={0}
                />
            </I18nProvider>
        )

        expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument()

        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({ [session.id]: 1_999 }))
        view.rerender(
            <I18nProvider>
                <SessionRowSummary
                    session={session}
                    showDetailedStatus={true}
                    lastSeenVersion={1}
                />
            </I18nProvider>
        )

        expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('New activity')
    })

    it('keeps an explicit unread dot across newer activity', () => {
        const session = makeSummary({
            id: 'selected-unread',
            active: false,
            backgroundTaskCount: 0,
            updatedAt: 2_000,
        })
        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({ [session.id]: 2_000 }))
        localStorage.setItem('hapi.sessionManualUnread.v1', JSON.stringify({ [session.id]: 2_000 }))

        const view = render(
            <I18nProvider>
                <SessionRowSummary
                    session={session}
                    selected={true}
                    showDetailedStatus={true}
                    lastSeenVersion={0}
                />
            </I18nProvider>
        )

        expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('New activity')

        view.rerender(
            <I18nProvider>
                <SessionRowSummary
                    session={{ ...session, updatedAt: 2_001 }}
                    selected={true}
                    showDetailedStatus={true}
                    lastSeenVersion={1}
                />
            </I18nProvider>
        )

        expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('New activity')
    })

    it('shows an explicit unread dot before the thinking spinner', () => {
        const session = makeSummary({
            id: 'selected-thinking-unread',
            thinking: true,
            updatedAt: 2_000,
        })
        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({ [session.id]: 2_000 }))
        localStorage.setItem('hapi.sessionManualUnread.v1', JSON.stringify({ [session.id]: 2_000 }))

        render(
            <I18nProvider>
                <SessionRowSummary
                    session={session}
                    selected={true}
                    showDetailedStatus={true}
                    lastSeenVersion={0}
                />
            </I18nProvider>
        )

        expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('New activity')
    })
})

describe('SessionRowSummary time label', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('advances the relative time without a parent render', () => {
        vi.useFakeTimers()
        vi.setSystemTime(1_800_000_000_000)
        render(
            <I18nProvider>
                <SessionRowSummary session={makeSummary({ updatedAt: 1_800_000_000_000, backgroundTaskCount: 0 })} />
            </I18nProvider>
        )
        expect(screen.getByText('just now')).toBeInTheDocument()

        act(() => { vi.advanceTimersByTime(2 * 60_000) })
        expect(screen.getByText('2m ago')).toBeInTheDocument()
    })

    it('shows a Codex import marker set after the first render', () => {
        render(
            <I18nProvider>
                <SessionRowSummary session={makeSummary({
                    updatedAt: Date.now() - 3 * 60 * 60_000,
                    backgroundTaskCount: 0,
                    metadata: { path: '/demo', name: 'Imported', flavor: 'codex', agentSessionId: 'codex-thread' },
                })} />
            </I18nProvider>
        )
        expect(screen.queryByText('just imported from Codex')).toBeNull()

        act(() => { markCodexSessionsImported(['codex-thread']) })
        expect(screen.getByText('just imported from Codex')).toBeInTheDocument()
    })
})
