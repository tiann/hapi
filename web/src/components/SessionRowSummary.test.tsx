import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { markCodexSessionsImported } from '@/lib/codexImportedSessions'
import { markSessionSeen, markSessionUnread } from '@/lib/sessionLastSeen'
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
        attachedJob: null,
        attachedJobUpdatedAt: 0,
        model: null,
        effort: null,
        contentRevision: overrides.updatedAt ?? 0,
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

    it('marks running and background work on the presence badge, without spinners', () => {
        const background = renderSummary(false).container
        const backgroundBadge = background.querySelector('[data-testid="session-presence"]')
        expect(backgroundBadge).toHaveClass('bg-blue-400', 'animate-pulse')
        expect(background.querySelector('svg.animate-spin-slow')).toBeNull()
        cleanup()

        const thinking = render(
            <I18nProvider>
                <SessionRowSummary session={makeSummary({ thinking: true, backgroundTaskCount: 0 })} />
            </I18nProvider>
        ).container
        expect(thinking.querySelector('[data-testid="session-presence"]'))
            .toHaveClass('bg-[var(--app-badge-success-text)]', 'animate-pulse')
        expect(thinking.querySelector('[data-testid="session-presence"]')).toHaveAttribute('data-presence', 'working')
        expect(screen.queryByText('Running', { exact: true })).not.toBeInTheDocument()
        cleanup()

        const idle = render(
            <I18nProvider>
                <SessionRowSummary session={makeSummary({ backgroundTaskCount: 0 })} />
            </I18nProvider>
        ).container
        const idleBadge = idle.querySelector('[data-testid="session-presence"]')
        expect(idleBadge).toHaveAttribute('data-presence', 'waiting')
        expect(idleBadge).not.toHaveClass('animate-pulse')
        expect(idleBadge).toHaveClass('border-2', 'border-[var(--app-badge-success-text)]')
        expect(idleBadge).not.toHaveClass('bg-[var(--app-badge-success-text)]')
    })

    it('does not dim disconnected rows and gives them a stopped badge instead of nothing', () => {
        const { container } = render(
            <I18nProvider>
                <SessionRowSummary session={makeSummary({ active: false, backgroundTaskCount: 0 })} />
            </I18nProvider>
        )
        expect(container.querySelector('.opacity-50')).toBeNull()
        const badge = container.querySelector('[data-testid="session-presence"]')
        expect(badge).toHaveAttribute('data-presence', 'stopped')
        expect(badge).not.toHaveClass('animate-pulse')
        expect(badge?.querySelector('svg')).not.toBeNull()
    })

    it('shows a detailed background tooltip on the agent icon in Extended mode', () => {
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
        markSessionSeen(session.id, 2_000)
        const view = render(
            <I18nProvider>
                <SessionRowSummary
                    session={session}
                    showDetailedStatus={true}
                    lastSeenVersion={0}
                />
            </I18nProvider>
        )

        expect(screen.queryByText('New activity')).not.toBeInTheDocument()
        expect(screen.getByText('Background demo')).toHaveClass('font-normal')

        markSessionUnread(session.id)
        view.rerender(
            <I18nProvider>
                <SessionRowSummary
                    session={session}
                    showDetailedStatus={true}
                    lastSeenVersion={1}
                />
            </I18nProvider>
        )

        expectUnread()
    })

    it('keeps an explicit unread mark across newer activity', () => {
        const session = makeSummary({
            id: 'selected-unread',
            active: false,
            backgroundTaskCount: 0,
            updatedAt: 2_000,
        })
        markSessionSeen(session.id, 2_000)
        markSessionUnread(session.id)

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

        expectUnread()

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

        expectUnread()
    })

    it('shows the unread dot separately from the pulsing presence badge', () => {
        const session = makeSummary({
            id: 'selected-thinking-unread',
            thinking: true,
            updatedAt: 2_000,
        })
        markSessionSeen(session.id, 2_000)
        markSessionUnread(session.id)

        const { container } = render(
            <I18nProvider>
                <SessionRowSummary
                    session={session}
                    selected={true}
                    showDetailedStatus={true}
                    lastSeenVersion={0}
                />
            </I18nProvider>
        )

        expectUnread()
        const dots = container.querySelectorAll('.rounded-full')
        expect(dots).toHaveLength(2)
        expect(container.querySelector('[data-testid="session-unread"]')).toBeInTheDocument()
        expect(container.querySelector('[data-testid="session-presence"]')).toHaveClass('animate-pulse')
    })

    it('shows unseen output from a running session', () => {
        const session = makeSummary({ id: 'running-unread', backgroundTaskCount: 1, updatedAt: 2_000 })
        markSessionSeen(session.id, 1_000)

        const { container } = render(
            <I18nProvider>
                <SessionRowSummary session={session} showDetailedStatus={true} lastSeenVersion={0} />
            </I18nProvider>
        )

        expectUnread()
        expect(container.querySelector('[data-testid="session-presence"]')).toHaveClass('bg-blue-400', 'animate-pulse')
    })

    it('shows and clears the unread dot in standard session rows', () => {
        const session = makeSummary({ id: 'standard-unread', backgroundTaskCount: 0, contentRevision: 5 })
        const view = render(<I18nProvider><SessionRowSummary session={session} showDetailedStatus={false} lastSeenVersion={0} /></I18nProvider>)
        expect(screen.getByTestId('session-unread')).toBeInTheDocument()
        markSessionSeen(session.id, 5)
        view.rerender(<I18nProvider><SessionRowSummary session={session} showDetailedStatus={false} lastSeenVersion={1} /></I18nProvider>)
        expect(screen.queryByTestId('session-unread')).toBeNull()
    })

    it('shows pending requests as an amber symbol, not a dot', () => {
        const { container } = render(
            <I18nProvider>
                <SessionRowSummary
                    session={makeSummary({
                        backgroundTaskCount: 0,
                        pendingRequestsCount: 1,
                        pendingRequestKinds: ['permission'],
                        pendingRequests: [{ id: 'r1', kind: 'permission', tool: 'Bash', since: 0 }],
                    })}
                    showDetailedStatus={true}
                />
            </I18nProvider>
        )

        expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('Bash')
        expect(container.querySelector('.text-\\[var\\(--app-badge-warning-text\\)\\] svg')).not.toBeNull()
        expect(container.querySelectorAll('.rounded-full')).toHaveLength(1)
    })

    it('marks a content-search snippet whose source message was truncated', () => {
        render(
            <I18nProvider>
                <SessionRowSummary
                    session={makeSummary()}
                    contentSnippet="…tail phrase…"
                    contentSearchTruncated={true}
                />
            </I18nProvider>
        )

        expect(screen.getByLabelText('This message was truncated for search; some content may be missing.'))
            .toBeInTheDocument()
    })
})

describe('SessionRowSummary attached job progress', () => {
    beforeEach(() => {
        localStorage.clear()
        vi.useFakeTimers()
        vi.setSystemTime(1_000_000)
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('keeps a pulsing working badge for a running attached job after the agent stops', () => {
        const { container } = render(
            <I18nProvider>
                <SessionRowSummary
                    session={makeSummary({
                        active: false,
                        backgroundTaskCount: 0,
                        attachedJob: {
                            key: 'import',
                            label: 'beets import',
                            status: 'running',
                            heartbeatAt: 1_000_000,
                            startedAt: 1_000_000 - 60_000,
                            updatedAt: 1_000_000,
                        },
                        attachedJobUpdatedAt: 1,
                    })}
                />
            </I18nProvider>
        )

        const badge = container.querySelector('[data-testid="session-presence"]')
        expect(badge).toHaveAttribute('data-presence', 'working')
        expect(badge).toHaveClass('animate-pulse')
    })

    it('renders a subtle indeterminate striped bar (no %) when fraction is unknown', () => {
        const { container } = render(
            <I18nProvider>
                <SessionRowSummary
                    session={makeSummary({
                        backgroundTaskCount: 0,
                        attachedJob: {
                            key: 'countdown',
                            label: 'dogfood countdown',
                            status: 'running',
                            remaining: 172_800,
                            unit: 's',
                            heartbeatAt: 1_000_000,
                            startedAt: 1_000_000 - 60_000,
                            updatedAt: 1_000_000,
                        },
                        attachedJobUpdatedAt: 1,
                    })}
                />
            </I18nProvider>
        )

        expect(screen.getByText(/172800 s left/)).toBeInTheDocument()
        const bar = screen.getByTestId('attached-job-progress-bar')
        expect(bar).toHaveAttribute('data-progress', 'indeterminate')
        expect(bar).toHaveAttribute('role', 'progressbar')
        expect(bar).not.toHaveAttribute('aria-valuenow')
        // Soft drifting stripes on a track — not spinner-only, not empty, not fake inline %, not loud chunk marquee.
        expect(bar.querySelector('.animate-attached-job-indeterminate')).not.toBeNull()
        expect(bar.querySelector('.animate-attached-job-marquee')).toBeNull()
        expect(container.querySelector('[class*="w-1/3"]')).toBeNull()
        expect(container.querySelector('[style*="width"]')).toBeNull()
    })

    it('renders label-only unknown jobs with striped indeterminate bar + running · elapsed (shape B)', () => {
        render(
            <I18nProvider>
                <SessionRowSummary
                    session={makeSummary({
                        backgroundTaskCount: 0,
                        attachedJob: {
                            key: 'beets',
                            label: 'beets import',
                            status: 'running',
                            detail: 'phase: match',
                            heartbeatAt: 1_000_000,
                            startedAt: 1_000_000 - 120_000,
                            updatedAt: 1_000_000,
                        },
                        attachedJobUpdatedAt: 1,
                    })}
                />
            </I18nProvider>
        )

        expect(screen.getByText(/running · 2m/)).toBeInTheDocument()
        const bar = screen.getByTestId('attached-job-progress-bar')
        expect(bar).toHaveAttribute('data-progress', 'indeterminate')
        expect(bar.querySelector('.animate-attached-job-indeterminate')).not.toBeNull()
        expect(bar).not.toHaveAttribute('aria-valuenow')
    })

    it('renders a real fill only when total yields a fraction', () => {
        const { container } = render(
            <I18nProvider>
                <SessionRowSummary
                    session={makeSummary({
                        backgroundTaskCount: 0,
                        attachedJob: {
                            key: 'countdown',
                            label: 'dogfood countdown',
                            status: 'running',
                            remaining: 86_400,
                            total: 172_800,
                            unit: 's',
                            heartbeatAt: 1_000_000,
                            startedAt: 1_000_000 - 60_000,
                            updatedAt: 1_000_000,
                        },
                        attachedJobUpdatedAt: 1,
                    })}
                />
            </I18nProvider>
        )

        const bar = screen.getByTestId('attached-job-progress-bar')
        expect(bar).toHaveAttribute('data-progress', 'determinate')
        expect(bar).toHaveAttribute('aria-valuenow', '50')
        const fill = container.querySelector('[style*="width"]') as HTMLElement | null
        expect(fill).not.toBeNull()
        expect(fill!.style.width).toBe('50%')
        expect(bar.querySelector('.animate-attached-job-indeterminate')).toBeNull()
    })
})

function expectUnread() {
    expect(screen.getByText('New activity')).toHaveClass('sr-only')
    expect(screen.getByText(/demo|Background/, { selector: '[title]' })).toHaveClass('font-semibold')
}

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
