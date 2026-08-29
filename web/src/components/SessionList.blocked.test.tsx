import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

afterEach(() => {
    cleanup()
    localStorage.removeItem('hapi-session-preview-limit')
    localStorage.removeItem('hapi-pin-in-progress-sessions')
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

function blocked(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
    return makeSession({
        id,
        lastNotify: { status: 'blocked', at: Date.now(), note: 'needs a decision' },
        ...overrides
    })
}

function pending(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
    return makeSession({
        id,
        active: true,
        pendingRequestsCount: 1,
        pendingRequestKinds: ['permission'],
        pendingRequests: [{ id: `${id}-r1`, kind: 'permission', tool: 'Bash', since: Date.now() }],
        ...overrides
    })
}

function renderList(sessions: SessionSummary[]) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    const wrap = (children: ReactNode) => (
        <QueryClientProvider client={queryClient}>
            <ToastProvider>
                <I18nProvider>{children}</I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
    return render(wrapList(sessions, wrap))
}

let lastWrap: ((children: ReactNode) => ReactNode) | null = null

function wrapList(
    sessions: SessionSummary[],
    wrap?: (children: ReactNode) => ReactNode
): ReactNode {
    if (wrap) lastWrap = wrap
    const apply = wrap ?? lastWrap
    if (!apply) throw new Error('renderList must run first')
    return apply(
        <SessionList
            sessions={sessions}
            selectedSessionId={null}
            onSelect={vi.fn()}
            onNewSession={vi.fn()}
            onRefresh={vi.fn()}
            isLoading={false}
            api={null}
        />
    )
}

describe('SessionList blocked chrome (#1717)', () => {
    it('floats blocked sessions into their own section with a rail and a chip', () => {
        renderList([blocked('stuck-one'), makeSession({ id: 'fine-one' })])

        const section = screen.getByTestId('blocked-section')
        expect(section.querySelector('[role="button"]')?.getAttribute('title')).toBe('Blocked')
        expect(within(section).getAllByTestId('session-blocked-chip')).toHaveLength(1)

        const row = document.querySelector('[data-session-id="stuck-one"]')
        expect(row?.getAttribute('data-session-blocked')).toBe('active')
        expect(row?.className).toContain('border-[var(--app-badge-warning-text)]')
    })

    it('does not leave a blocked-but-connected session duplicated in the in-progress pin', () => {
        // The pre-#1717 failure mode: a blocked agent whose CLI is still
        // connected sat silently in the quiet pinned in-progress bucket. The
        // pin has to be on (`all` activity) or the duplication path is never
        // exercised.
        localStorage.setItem('hapi-pin-in-progress-sessions', 'all')
        renderList([
            blocked('stuck-one', { active: true }),
            makeSession({ id: 'busy-one', active: true, thinking: true })
        ])

        // The unblocked working session still populates In progress, proving
        // the section renders and the blocked row was excluded from it rather
        // than the whole section being absent.
        expect(screen.getByTitle('In progress')).toBeTruthy()
        expect(screen.getAllByTestId('session-blocked-chip')).toHaveLength(1)
        expect(document.querySelectorAll('[data-session-id="stuck-one"]')).toHaveLength(1)
        expect(document.querySelectorAll('[data-session-id="busy-one"]')).toHaveLength(1)
    })

    it('counts all blocked work in the header pill', () => {
        renderList([blocked('stuck-one'), blocked('stuck-two'), makeSession({ id: 'fine-one' })])

        const pill = screen.getByTestId('blocked-jump-pill')
        expect(within(pill).getByText('2')).toBeTruthy()
    })

    it('narrows to blocked work through a real toggle button', () => {
        renderList([blocked('stuck-one'), blocked('stuck-two'), makeSession({ id: 'fine-one' })])

        // 'fine-one' is an inactive, unpinned session, so its directory group
        // starts collapsed — expand it to see the row before narrowing.
        fireEvent.click(screen.getByTitle('/home/ubuntu'))

        const toggle = screen.getByTestId('blocked-lens-toggle')
        expect(toggle.getAttribute('aria-pressed')).toBe('false')
        expect(screen.getByText('fine-one')).toBeTruthy()

        // A native button, so keyboard and assistive activation reach the lens
        // that `aria-pressed` advertises.
        fireEvent.click(toggle)

        expect(screen.getByTestId('blocked-lens-toggle').getAttribute('aria-pressed')).toBe('true')
        expect(screen.queryByText('fine-one')).toBeNull()
        expect(screen.getAllByTestId('session-blocked-chip')).toHaveLength(2)
    })

    it('counts a session awaiting a permission prompt as blocked', () => {
        // Operator's rule: pending means the agent cannot proceed without them,
        // so it shares the count, the section and the row treatment.
        renderList([pending('awaiting-one'), makeSession({ id: 'fine-one' })])

        const section = screen.getByTestId('blocked-section')
        expect(within(section).getByText('Permission')).toBeTruthy()
        expect(within(screen.getByTestId('blocked-jump-pill')).getByText('1')).toBeTruthy()
        expect(document.querySelector('[data-session-id="awaiting-one"]')?.getAttribute('data-session-blocked'))
            .toBe('active')
    })

    it('counts self-reported and prompt-parked agents in one number', () => {
        renderList([blocked('stuck-one'), pending('awaiting-one'), makeSession({ id: 'fine-one' })])

        expect(within(screen.getByTestId('blocked-jump-pill')).getByText('2')).toBeTruthy()
        expect(screen.getAllByTestId('session-blocked-chip')).toHaveLength(2)
    })

    it('does not strand a pending session in both Blocked and the pending bucket', () => {
        localStorage.setItem('hapi-pin-in-progress-sessions', 'true')
        renderList([pending('awaiting-one')])

        expect(document.querySelectorAll('[data-session-id="awaiting-one"]')).toHaveLength(1)
    })

    it('drops the blocked flag once the prompt is answered', () => {
        const { rerender } = renderList([pending('awaiting-one')])
        expect(screen.getByTestId('blocked-section')).toBeTruthy()

        // No hub round-trip: pending is live state, so clearing the request
        // clears the chrome on the next render.
        rerender(wrapList([makeSession({ id: 'awaiting-one', active: true })]))

        expect(screen.queryByTestId('blocked-section')).toBeNull()
        expect(screen.queryByTestId('blocked-jump-pill')).toBeNull()
    })

    it('renders no controls and no section when nothing is blocked', () => {
        renderList([makeSession({ id: 'fine-one' }), makeSession({ id: 'fine-two' })])

        expect(screen.queryByTestId('blocked-jump-pill')).toBeNull()
        expect(screen.queryByTestId('blocked-lens-toggle')).toBeNull()
        expect(screen.queryByTestId('blocked-section')).toBeNull()
    })

    it('drops blocked chrome once the agent starts a new turn', () => {
        renderList([blocked('stuck-one', { active: true, thinking: true })])

        expect(screen.queryByTestId('blocked-section')).toBeNull()
        expect(screen.queryByTestId('blocked-jump-pill')).toBeNull()
    })
})
