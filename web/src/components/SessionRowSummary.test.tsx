import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
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

    it('shows the basic running label in Basic mode', () => {
        renderSummary(false)

        expect(screen.getByText('Running', { exact: true })).toBeInTheDocument()
        expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument()
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

    it('shows an explicit unread dot for the selected session only', () => {
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

        expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument()
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

describe('SessionRowSummary keepalive-idle (tiann/hapi#1820)', () => {
    const idle = (overrides: Partial<SessionSummary> = {}) => makeSummary({
        id: 'idle-row',
        backgroundTaskCount: 0,
        metadata: { path: '/demo/idle', name: 'Idle demo', flavor: 'claude', lifecycleState: 'idle' },
        ...overrides
    })

    it('draws the idle marker in hint colour while nothing is in flight', () => {
        render(
            <I18nProvider>
                <SessionRowSummary session={idle()} showDetailedStatus={false} />
            </I18nProvider>
        )

        expect(screen.getByTestId('session-row-idle')).toHaveTextContent('Idle (keepalive only)')
        expect(screen.getByTitle('Idle demo').className).toContain('text-[var(--app-hint)]')
    })

    it('keeps the idle marker next to the unread dot', () => {
        // A session that went idle after its last activity is both unread and
        // idle; the unread dot must not hide what the agent is (not) doing.
        const session = idle({ id: 'unread-idle', updatedAt: 2_000 })
        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({ [session.id]: 2_000 }))
        const view = render(
            <I18nProvider>
                <SessionRowSummary session={session} showDetailedStatus={true} lastSeenVersion={0} />
            </I18nProvider>
        )
        expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument()

        // The watermark moves behind the session's latest activity: unread.
        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({ [session.id]: 1_999 }))
        view.rerender(
            <I18nProvider>
                <SessionRowSummary session={session} showDetailedStatus={true} lastSeenVersion={1} />
            </I18nProvider>
        )

        expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('New activity')
        expect(screen.getByTestId('session-row-idle')).toHaveTextContent('Idle (keepalive only)')
    })

    it('drops the label only inside the labelled idle bucket, not under a generic pinned heading', () => {
        const view = render(
            <I18nProvider>
                <SessionRowSummary session={idle()} showDetailedStatus={false} inRunningSection />
            </I18nProvider>
        )
        expect(screen.getByTestId('session-row-idle')).toHaveTextContent('Idle (keepalive only)')

        view.rerender(
            <I18nProvider>
                <SessionRowSummary session={idle()} showDetailedStatus={false} inRunningSection inIdleBucket />
            </I18nProvider>
        )
        expect(screen.getByTestId('session-row-idle')).toHaveTextContent('')
        expect(screen.getByTestId('session-row-idle')).toHaveAttribute('title', 'Idle (keepalive only)')
    })

    it('reads as working again once the session is thinking, spinner and contrast alike', () => {
        // The hub keeps the idle mark through ambient thinking churn
        // (tiann/hapi#1553) and bucketRunningSessions files such a row under
        // Working; the row must not spin inside a dimmed, idle-labelled line.
        const { container } = render(
            <I18nProvider>
                <SessionRowSummary session={idle({ thinking: true })} showDetailedStatus={false} />
            </I18nProvider>
        )

        expect(container.querySelector('.animate-spin-slow')).not.toBeNull()
        expect(screen.queryByTestId('session-row-idle')).toBeNull()
        const title = screen.getByTitle('Idle demo')
        expect(title.className).toContain('text-[var(--app-fg)]')
        expect(title.parentElement!.parentElement!.className).not.toContain('opacity-75')
    })
})
