import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { markCodexSessionsImported } from '@/lib/codexImportedSessions'
import { followSessionTail, markSessionSeen, markSessionUnread } from '@/lib/sessionLastSeen'
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

    it('keeps presence independent of the title-side activity spinner', () => {
        const background = renderSummary(false).container
        const backgroundBadge = background.querySelector('[data-testid="session-presence"]')
        expect(backgroundBadge).toHaveClass('bg-blue-400', 'animate-pulse')
        expect(background.querySelector('svg.animate-spin-slow')).toHaveClass('text-[var(--app-hint)]')
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

    it('never puts a tooltip panel inside the faded subtree', () => {
        // The residency fade must stay on the title text and off any container.
        // HoverTooltip renders its panel inline as `absolute z-30` rather than
        // through a portal, and any `opacity < 1` ancestor forms a stacking
        // context — which would both wash the panel out and trap its z-index, so
        // a later row could paint over a downward-opening schedule panel. Current
        // code is correct; this pins the invariant, because the natural refactor
        // (hoist the fade onto the grid so the whole row dims) reintroduces it
        // silently and only on inactive rows that also have scheduled messages.
        const { container } = render(
            <I18nProvider>
                <SessionRowSummary
                    session={makeSummary({
                        active: false,
                        backgroundTaskCount: 0,
                        futureScheduledMessageCount: 2,
                        nextScheduledAt: 1_000_000,
                    })}
                    showDetailedStatus={true}
                />
            </I18nProvider>
        )

        const faded = Array.from(container.querySelectorAll('.opacity-50'))
        expect(faded.length).toBeGreaterThan(0)
        const tooltip = container.querySelector('[role="tooltip"]')
        expect(tooltip).not.toBeNull()
        for (const node of faded) {
            expect(node.contains(tooltip)).toBe(false)
        }
    })

    it('dims disconnected rows and gives them a stopped badge instead of nothing', () => {
        const { container } = render(
            <I18nProvider>
                <SessionRowSummary session={makeSummary({ active: false, backgroundTaskCount: 0 })} />
            </I18nProvider>
        )
        // Two scales of the same fact: the badge names the state on inspection,
        // the row fade makes it legible while scanning a long list.
        const faded = container.querySelector('.opacity-50')
        expect(faded).not.toBeNull()
        const badge = container.querySelector('[data-testid="session-presence"]')
        expect(badge).toHaveAttribute('data-presence', 'stopped')
        expect(badge).not.toHaveClass('animate-pulse')
        expect(badge?.querySelector('svg')).not.toBeNull()
        // The mark must not be dimmed along with the title line.
        expect(faded!.contains(badge)).toBe(false)
    })

    it('keeps resident rows at full strength', () => {
        const { container } = render(
            <I18nProvider>
                <SessionRowSummary session={makeSummary({ active: true, backgroundTaskCount: 0 })} />
            </I18nProvider>
        )
        expect(container.querySelector('.opacity-50')).toBeNull()
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

    it('combines manual unread and running activity in one blue spinner', () => {
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

        expectRunningUnread()
        const dots = container.querySelectorAll('.rounded-full')
        expect(dots).toHaveLength(1)
        expect(container.querySelector('[data-testid="session-unread"]')).toBeNull()
        expect(screen.getByTestId('session-activity').querySelector('svg')).toHaveClass('text-blue-500')
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

        expectRunningUnread()
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

    it('fades the row but keeps a pulsing working badge and job meter after the agent stops', () => {
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
                            remaining: 3_600,
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

        // A job outliving its agent is the case where the two signals must say
        // different things at once: nothing holds this session in memory, and
        // the work is still running.
        const badge = container.querySelector('[data-testid="session-presence"]')
        expect(badge).toHaveAttribute('data-presence', 'working')
        expect(badge).toHaveClass('animate-pulse')

        const faded = container.querySelector('.opacity-50')
        expect(faded).not.toBeNull()
        // The job's own affordances stay outside the faded subtree.
        const jobLabel = screen.getByText('beets import')
        expect(faded!.contains(jobLabel)).toBe(false)
        expect(screen.getByTestId('attached-job-progress-bar')).toBeInTheDocument()
        expect(faded!.contains(badge)).toBe(false)
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

    it('keeps job progress and the stale marker out of the truncating label', () => {
        vi.setSystemTime(1_000_000 + 20 * 60_000)
        render(
            <I18nProvider>
                <SessionRowSummary
                    session={makeSummary({
                        backgroundTaskCount: 0,
                        attachedJob: {
                            key: 'reencode',
                            label: 'Re-encode every portfolio film at the higher quality setting',
                            status: 'running',
                            done: 6,
                            total: 39,
                            unit: 'films',
                            heartbeatAt: 1_000_000,
                            startedAt: 1_000_000 - 60_000,
                            updatedAt: 1_000_000,
                        },
                        attachedJobUpdatedAt: 1,
                    })}
                />
            </I18nProvider>
        )

        // A long label shrinks first; the changing status has its own span so it
        // is not the part an ellipsis removes.
        const label = screen.getByText('Re-encode every portfolio film at the higher quality setting')
        expect(label).toHaveClass('truncate')
        const status = screen.getByTestId('attached-job-status')
        expect(label.contains(status)).toBe(false)
        expect(status).toHaveTextContent(/^· stale · 15% · 6\/39 films · 21m · no heartbeat · 20m$/)
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

describe('SessionRowSummary combined activity and unread indicator', () => {
    beforeEach(() => localStorage.clear())

    it.each([false, true])('shows grey running, blue running-unread, then foreground unread in detailed=%s', (showDetailedStatus) => {
        let session = makeSummary({ backgroundTaskCount: 0, thinking: true, contentRevision: 0 })
        const row = () => <I18nProvider><SessionRowSummary session={session} showDetailedStatus={showDetailedStatus} lastSeenVersion={session.contentRevision} /></I18nProvider>
        const view = render(row())
        expect(screen.getByTestId('session-activity').querySelector('svg')).toHaveClass('animate-spin-slow', 'text-[var(--app-hint)]')
        expect(screen.queryByTestId('session-unread')).toBeNull()

        session = { ...session, contentRevision: 2 }
        view.rerender(row())
        expect(screen.getByTestId('session-activity').querySelector('svg')).toHaveClass('text-blue-500')
        expect(screen.queryByTestId('session-unread')).toBeNull()
        expectRunningUnread()

        session = { ...session, thinking: false }
        view.rerender(row())
        expect(screen.queryByTestId('session-activity')).toBeNull()
        expect(screen.getByTestId('session-unread')).toHaveClass('bg-[var(--app-fg)]')
        expectUnread()

        markSessionSeen(session.id, 2)
        view.rerender(row())
        expect(screen.queryByTestId('session-unread')).toBeNull()
        expect(screen.queryByTestId('session-activity')).toBeNull()
    })

    it('returns to a grey spinner when running content is read, and keeps manual unread blue', () => {
        const session = makeSummary({ thinking: true, contentRevision: 2, backgroundTaskCount: 0 })
        const row = (version: number) => <I18nProvider><SessionRowSummary session={session} lastSeenVersion={version} /></I18nProvider>
        const view = render(row(0))
        expect(screen.getByTestId('session-activity').querySelector('svg')).toHaveClass('text-blue-500')
        markSessionSeen(session.id, 2)
        view.rerender(row(1))
        expect(screen.getByTestId('session-activity').querySelector('svg')).toHaveClass('text-[var(--app-hint)]')
        markSessionUnread(session.id)
        view.rerender(row(2))
        expect(screen.getByTestId('session-activity').querySelector('svg')).toHaveClass('text-blue-500')
    })

    it.each(['permission', 'input'] as const)('keeps the spinner and %s symbol without a misleading completed dot', (kind) => {
        render(<I18nProvider><SessionRowSummary session={makeSummary({
            thinking: true, backgroundTaskCount: 0, contentRevision: 2,
            pendingRequestsCount: 1, pendingRequestKinds: [kind],
            pendingRequests: [{ id: 'request', kind, tool: 'Question', since: 0 }],
        })} /></I18nProvider>)
        expect(screen.queryByTestId('session-unread')).toBeNull()
        expect(screen.getByTestId('session-activity').querySelector('svg')).toHaveClass('text-blue-500')
        expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('Question')
        expectRunningUnread()
    })

    it('ignores expired thinking and background flags when disconnected', () => {
        render(<I18nProvider><SessionRowSummary session={makeSummary({ active: false, thinking: true, contentRevision: 2 })} /></I18nProvider>)
        expect(screen.queryByTestId('session-activity')).toBeNull()
        expect(screen.getByTestId('session-unread')).toHaveClass('bg-[var(--app-fg)]')
    })

    it('keeps a followed transcript grey until unseen output really needs attention', () => {
        const session = makeSummary({ thinking: true, contentRevision: 2, backgroundTaskCount: 0 })
        const release = followSessionTail(session.id)
        const row = (version: number) => <I18nProvider><SessionRowSummary session={session} lastSeenVersion={version} /></I18nProvider>
        const view = render(row(0))
        try {
            expect(screen.getByTestId('session-activity').querySelector('svg')).toHaveClass('text-[var(--app-hint)]')
        } finally {
            release()
        }
        view.rerender(row(1))
        expect(screen.getByTestId('session-activity').querySelector('svg')).toHaveClass('text-blue-500')
    })

    it('responds to cross-device read state without changing running status', () => {
        let session = makeSummary({ thinking: true, contentRevision: 2, backgroundTaskCount: 0 })
        const row = () => <I18nProvider><SessionRowSummary session={session} /></I18nProvider>
        const view = render(row())
        expect(screen.getByTestId('session-activity').querySelector('svg')).toHaveClass('text-blue-500')
        session = { ...session, readState: { readRevision: 2, version: 1, manualUnread: false } }
        view.rerender(row())
        expect(screen.getByTestId('session-activity').querySelector('svg')).toHaveClass('text-[var(--app-hint)]')
    })

    it('keeps outliving jobs spinning at full contrast after disconnect', () => {
        const session = makeSummary({ active: false, contentRevision: 2, attachedJob: {
            key: 'import', label: 'Import', status: 'running', heartbeatAt: Date.now(),
            startedAt: Date.now(), updatedAt: Date.now(),
        } })
        const { container } = render(<I18nProvider><SessionRowSummary session={session} /></I18nProvider>)
        const spinner = screen.getByTestId('session-activity')
        expect(spinner.querySelector('svg')).toHaveClass('text-blue-500')
        expect(container.querySelector('.opacity-50')!.contains(spinner)).toBe(false)
        expect(screen.queryByTestId('session-unread')).toBeNull()
    })
})

function expectUnread() {
    expect(screen.getByText('New activity')).toHaveClass('sr-only')
    expect(screen.getByText(/demo|Background/, { selector: '[title]' })).toHaveClass('font-semibold')
}

// While work runs, the blue spinner carries unread; the at-rest bold title
// would make a working session look finished.
function expectRunningUnread() {
    expect(screen.getByText('New activity')).toHaveClass('sr-only')
    expect(screen.getByText(/demo|Background/, { selector: '[title]' })).toHaveClass('font-normal')
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
        expect(screen.getByText('just now')).toHaveClass('translate-y-[0.5px]')

        act(() => { vi.advanceTimersByTime(2 * 60_000) })
        expect(screen.getByText('2m ago')).toBeInTheDocument()
    })

    it('accents the time for unread output only once work stops', () => {
        vi.useFakeTimers()
        vi.setSystemTime(1_800_000_000_000)
        let session = makeSummary({ updatedAt: 1_800_000_000_000, contentRevision: 2, thinking: true, backgroundTaskCount: 0 })
        const row = () => <I18nProvider><SessionRowSummary session={session} /></I18nProvider>
        const view = render(row())
        expect(screen.getByText('just now')).toHaveClass('text-[var(--app-hint)]')
        expect(screen.getByText('just now')).not.toHaveClass('font-semibold')

        session = { ...session, thinking: false }
        view.rerender(row())
        expect(screen.getByText('just now')).toHaveClass('font-semibold', 'text-[var(--app-link)]')
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
        // Upstream #2402 renamed this label to "Approval required".
        expect(screen.getByLabelText('Approval required')).toBeTruthy()
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
