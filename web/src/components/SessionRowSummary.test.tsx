import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionRowSummary } from './SessionRowSummary'

afterEach(() => cleanup())

function renderWithI18n(children: ReactNode) {
    return render(<I18nProvider>{children}</I18nProvider>)
}

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

describe('SessionRowSummary model-error + attention', () => {
    it('shows model-error and permission attention together', () => {
        const summary = makeSummary({
            id: 's-both',
            backgroundTaskCount: 0,
            pendingRequestsCount: 1,
            pendingRequestKinds: ['permission'],
            pendingRequests: [{ id: 'r1', kind: 'permission', tool: 'Bash', since: 0 }],
            metadata: {
                path: '/tmp/proj',
                lastModelError: {
                    eventId: 'evt-row-1',
                    kind: 'model_not_found',
                    transient: false,
                    rawSnippet: 'Unknown model',
                    atTs: 1,
                    priorAssistantClaimsDone: false,
                },
            },
        })

        renderWithI18n(
            <SessionRowSummary
                session={summary}
                showDetailedStatus
                selected={false}
                nestedTooltips={false}
            />
        )

        expect(screen.getByLabelText(/Model error/i)).toBeTruthy()
        expect(screen.getByLabelText('Permission required')).toBeTruthy()
    })

    it('keeps the model-error pulse while thinking (auto-bridge in flight)', () => {
        const summary = makeSummary({
            id: 's-bridge',
            thinking: true,
            backgroundTaskCount: 0,
            metadata: {
                path: '/tmp/proj',
                lastModelError: {
                    eventId: 'evt-row-bridge',
                    kind: 'rate_limited',
                    transient: true,
                    rawSnippet: 'rate limited',
                    atTs: 1,
                    priorAssistantClaimsDone: false,
                },
            },
        })

        renderWithI18n(
            <SessionRowSummary
                session={summary}
                showDetailedStatus
                selected={false}
                nestedTooltips={false}
            />
        )

        expect(screen.getByLabelText(/Model error/i)).toBeTruthy()
    })

    it('hides the model-error pulse after a successful bridge even if still thinking', () => {
        const summary = makeSummary({
            id: 's-recovered',
            thinking: true,
            backgroundTaskCount: 0,
            metadata: {
                path: '/tmp/proj',
                lastModelError: {
                    eventId: 'evt-row-ok',
                    kind: 'rate_limited',
                    transient: true,
                    rawSnippet: 'rate limited',
                    atTs: 1,
                    priorAssistantClaimsDone: false,
                    bridgedForEventId: 'evt-row-ok',
                },
            },
        })

        renderWithI18n(
            <SessionRowSummary
                session={summary}
                showDetailedStatus
                selected={false}
                nestedTooltips={false}
            />
        )

        expect(screen.queryByLabelText(/Model error/i)).toBeNull()
    })
})
