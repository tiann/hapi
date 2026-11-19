import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { BLOCKED_NOTIFY_STALE_MS } from '@hapi/protocol'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

afterEach(() => {
    cleanup()
    localStorage.removeItem('hapi-session-preview-limit')
    localStorage.removeItem('hapi-pin-in-progress-sessions')
    localStorage.removeItem('hapi-session-list-status')
    localStorage.removeItem('hapi-session-list-machine-filter')
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
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

    it('narrows to blocked work through the combined filter menu (#1996)', () => {
        renderList([blocked('stuck-one'), blocked('stuck-two'), makeSession({ id: 'fine-one' })])

        // 'fine-one' is an inactive, unpinned session, so its directory group
        // starts collapsed — expand it to see the row before narrowing.
        fireEvent.click(screen.getByTitle('/home/ubuntu'))
        expect(screen.getByText('fine-one')).toBeTruthy()

        fireEvent.click(screen.getByRole('button', { name: 'Sort and filter' }))
        const checkbox = screen.getByRole('menuitemcheckbox', { name: 'Blocked only' })
        expect(checkbox.getAttribute('aria-checked')).toBe('false')
        fireEvent.click(checkbox)

        expect(screen.queryByText('fine-one')).toBeNull()
        expect(screen.getAllByTestId('session-blocked-chip')).toHaveLength(2)
    })

    it('expands a collapsed Blocked section when Blocked only is turned on (#1996)', () => {
        renderList([blocked('stuck-one')])

        const header = screen.getByTitle('Blocked')
        expect(header.getAttribute('aria-expanded')).toBe('true')
        fireEvent.click(header)
        expect(header.getAttribute('aria-expanded')).toBe('false')

        fireEvent.click(screen.getByRole('button', { name: 'Sort and filter' }))
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Blocked only' }))

        expect(screen.getByTitle('Blocked').getAttribute('aria-expanded')).toBe('true')
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

    it('offers Mark unblocked only on blocked rows, and demands a reason', async () => {
        renderList([blocked('stuck-one')])

        const row = document.querySelector('[data-session-id="stuck-one"]') as HTMLElement
        fireEvent.contextMenu(row)

        const item = await screen.findByTestId('session-action-mark-unblocked')
        fireEvent.click(item)

        const dialog = await screen.findByTestId('unblock-reason-dialog')
        expect(dialog).toBeTruthy()

        // Empty reason must be refused — a silent dismissal is the whole thing
        // this dialog exists to prevent.
        fireEvent.click(screen.getByTestId('unblock-confirm'))
        expect(await screen.findByRole('alert')).toBeTruthy()
        expect(screen.getByTestId('unblock-reason-dialog')).toBeTruthy()
    })

    it('keeps an open dismissal draft when the row leaves the Blocked section', async () => {
        // A reply from another client clears the blocker, so the next session
        // update moves the row out of Blocked. The row used to own the dialog,
        // so React unmounted it and discarded the reason the operator was
        // part-way through typing. The dialog lives in SessionList now, which
        // outlives any row movement.
        const { rerender } = renderList([blocked('stuck-one'), makeSession({ id: 'fine-one' })])

        const row = document.querySelector('[data-session-id="stuck-one"]') as HTMLElement
        fireEvent.contextMenu(row)
        fireEvent.click(await screen.findByTestId('session-action-mark-unblocked'))
        fireEvent.change(screen.getByRole('textbox'), {
            target: { value: 'half-typed rationale' }
        })

        // The blocker clears underneath the operator.
        rerender(wrapList([makeSession({ id: 'stuck-one' }), makeSession({ id: 'fine-one' })]))

        expect(screen.queryByTestId('blocked-section')).toBeNull()
        expect(screen.getByTestId('unblock-reason-dialog')).toBeTruthy()
        expect((screen.getByRole('textbox') as HTMLTextAreaElement).value)
            .toBe('half-typed rationale')
    })

    it('returns focus to the row when the dismissal dialog closes', async () => {
        // The selector looked for a button INSIDE the element carrying
        // `data-session-id` — but that element is the row button itself, so it
        // matched nothing and focus fell to the document body.
        renderList([blocked('stuck-one'), makeSession({ id: 'fine-one' })])

        const row = document.querySelector('[data-session-id="stuck-one"]') as HTMLElement
        fireEvent.contextMenu(row)
        fireEvent.click(await screen.findByTestId('session-action-mark-unblocked'))
        expect(screen.getByTestId('unblock-reason-dialog')).toBeTruthy()

        fireEvent.keyDown(screen.getByTestId('unblock-reason-dialog'), { key: 'Escape' })

        expect(screen.queryByTestId('unblock-reason-dialog')).toBeNull()
        expect(document.activeElement).toBe(row)
    })

    it('still has somewhere to put focus when the last blocker is dismissed', async () => {
        // The jump pill was the fallback, but dismissing the LAST blocker
        // unmounts it — so with the row gone too, focus had nowhere to go but
        // the document body. The header row is always mounted.
        const { rerender } = renderList([blocked('stuck-one')])

        const row = document.querySelector('[data-session-id="stuck-one"]') as HTMLElement
        fireEvent.contextMenu(row)
        fireEvent.click(await screen.findByTestId('session-action-mark-unblocked'))

        // The blocker clears and the row drops out of the list entirely.
        rerender(wrapList([]))
        fireEvent.keyDown(screen.getByTestId('unblock-reason-dialog'), { key: 'Escape' })

        expect(screen.queryByTestId('blocked-jump-pill')).toBeNull()
        expect(document.activeElement).not.toBe(document.body)
        expect(document.activeElement).toBe(screen.getByTestId('session-list-header-row'))
    })

    it('goes muted when the blocker crosses the stale deadline with no prop change', async () => {
        // Age is computed at render, and a memoized row on an open list has no
        // update scheduled when its blocker passes 24h — so an abandoned row
        // kept its loud styling until something unrelated re-rendered it. The
        // row schedules its own render at the deadline now. Session props are
        // deliberately untouched throughout: only the clock moves.
        vi.useFakeTimers()
        try {
            const at = Date.now()
            renderList([blocked('stuck-one', { lastNotify: { status: 'blocked', at, note: 'needs a key' } })])

            const row = () => document.querySelector('[data-session-id="stuck-one"]')
            expect(row()?.getAttribute('data-session-blocked')).toBe('active')

            await act(async () => {
                vi.advanceTimersByTime(BLOCKED_NOTIFY_STALE_MS + 1_000)
            })

            expect(row()?.getAttribute('data-session-blocked')).toBe('stale')
        } finally {
            vi.useRealTimers()
        }
    })

    it('does not offer Mark unblocked on an unblocked row', async () => {
        renderList([makeSession({ id: 'fine-one' })])

        // Inactive, unpinned session: its directory group starts collapsed.
        fireEvent.click(screen.getByTitle('/home/ubuntu'))

        const row = document.querySelector('[data-session-id="fine-one"]') as HTMLElement
        fireEvent.contextMenu(row)

        expect(screen.queryByTestId('session-action-mark-unblocked')).toBeNull()
    })

    it('hides a row whose blocker the operator already acknowledged', () => {
        renderList([
            makeSession({
                id: 'acked-one',
                lastNotify: { status: 'blocked', at: Date.now() - 1000, note: 'old' },
                blockedAck: { at: Date.now(), reason: 'handled outside HAPI' }
            })
        ])

        expect(screen.queryByTestId('blocked-section')).toBeNull()
        expect(screen.queryByTestId('blocked-jump-pill')).toBeNull()
    })

    it('counts a disconnected blocked agent even with "active sessions only" on', () => {
        // The count is meant to be fleet-wide. A blocked agent whose CLI
        // dropped is precisely the one worth surfacing, and it is not active.
        localStorage.setItem('hapi-show-active-sessions-only', 'true')
        try {
            renderList([blocked('stuck-offline'), makeSession({ id: 'live-one', active: true })])
            expect(within(screen.getByTestId('blocked-jump-pill')).getByText('1')).toBeTruthy()
        } finally {
            localStorage.removeItem('hapi-show-active-sessions-only')
        }
    })

    it('renders no controls and no section when nothing is blocked', () => {
        renderList([makeSession({ id: 'fine-one' }), makeSession({ id: 'fine-two' })])

        expect(screen.queryByTestId('blocked-jump-pill')).toBeNull()
        expect(screen.queryByTestId('blocked-toolbar-controls')).toBeNull()
        expect(screen.queryByTestId('blocked-section')).toBeNull()
    })

    it('drops blocked chrome once the agent starts a new turn', () => {
        renderList([blocked('stuck-one', { active: true, thinking: true })])

        expect(screen.queryByTestId('blocked-section')).toBeNull()
        expect(screen.queryByTestId('blocked-jump-pill')).toBeNull()
    })

    it('keeps the blocked counter and lens reachable while the search is expanded', () => {
        // The actions row unmounts while the search field is expanded, and it
        // carries the blocked controls. An operator typing a query that hides
        // the blocked rows therefore lost both the off-screen cue and the jump
        // control until they left the field — and an arrival pulse could expire
        // unseen in the meantime. The lens toggle matters just as much: with
        // the lens on and the control gone, there was no way to turn it off.
        renderList([blocked('stuck-one'), makeSession({ id: 'fine-one' })])

        expect(screen.getByTestId('blocked-toolbar-controls')).toBeTruthy()
        expect(screen.queryByTestId('blocked-search-controls')).toBeNull()

        fireEvent.click(within(screen.getByTestId('session-list-search')).getAllByRole('button')[0]!)

        // The toolbar row is gone, as designed — but the controls are not.
        expect(screen.queryByTestId('blocked-toolbar-controls')).toBeNull()
        const compact = screen.getByTestId('blocked-search-controls')
        expect(within(compact).getByTestId('blocked-jump-pill')).toBeTruthy()
        expect(within(compact).getByTestId('blocked-lens-toggle')).toBeTruthy()
    })

    it('collapses the expanded search once focus leaves the blocked controls too', () => {
        // The controls are siblings of the search container, so once that
        // container stopped collapsing on focus moving INTO them, nothing
        // noticed focus leaving them again: tabbing search -> controls -> list
        // left the bar expanded and the normal toolbar hidden with focus
        // already gone from both.
        Element.prototype.scrollIntoView = vi.fn()
        renderList([blocked('stuck-one'), makeSession({ id: 'fine-one' })])

        fireEvent.click(within(screen.getByTestId('session-list-search')).getAllByRole('button')[0]!)
        const compact = screen.getByTestId('blocked-search-controls')
        const pill = within(compact).getByTestId('blocked-jump-pill')

        // Focus crosses into the controls: still expanded, as it must be for
        // the click to land at all.
        fireEvent.blur(screen.getByTestId('session-list-search'), { relatedTarget: pill })
        expect(screen.getByTestId('blocked-search-controls')).toBeTruthy()

        // Then on past them, into the list.
        const row = document.querySelector('[data-session-id="stuck-one"]')!
        fireEvent.blur(compact, { relatedTarget: row })

        expect(screen.queryByTestId('blocked-search-controls')).toBeNull()
        expect(screen.getByTestId('blocked-toolbar-controls')).toBeTruthy()
    })

    it('orders the Blocked section by the configured list order', () => {
        // The section sorted by `updatedAt`, which is neither the operator's
        // configured order nor the search ranking. The default comparator
        // orders by last USER message, so agent output must not reorder the
        // section — and a row touched recently by the agent must not jump
        // above one the operator spoke to more recently.
        const now = Date.now()
        renderList([
            blocked('agent-chatty', {
                updatedAt: now,
                createdAt: now - 100_000,
                lastUserMessageAt: now - 90_000
            }),
            blocked('operator-recent', {
                updatedAt: now - 50_000,
                createdAt: now - 100_000,
                lastUserMessageAt: now - 10_000
            })
        ])

        const order = Array.from(
            screen.getByTestId('blocked-section').querySelectorAll('[data-session-id]')
        ).map((row) => row.getAttribute('data-session-id'))

        expect(order).toEqual(['operator-recent', 'agent-chatty'])
    })

    it('does not collapse the expanded search when focus moves to the blocked controls', () => {
        // The controls sit beside the search container, not inside it, so
        // moving focus onto them read as focus leaving: the bar collapsed and
        // unmounted the button BEFORE the click dispatched, swallowing it.
        // Tabbing across from the field lost the control the same way.
        Element.prototype.scrollIntoView = vi.fn()
        renderList([blocked('stuck-one'), makeSession({ id: 'fine-one' })])

        fireEvent.click(within(screen.getByTestId('session-list-search')).getAllByRole('button')[0]!)
        const compact = screen.getByTestId('blocked-search-controls')
        const pill = within(compact).getByTestId('blocked-jump-pill')

        // The blur that happens as focus crosses from the field to the pill.
        fireEvent.blur(screen.getByTestId('session-list-search'), { relatedTarget: pill })

        // Still mounted, so the click that follows the blur actually lands.
        expect(screen.getByTestId('blocked-search-controls')).toBeTruthy()
        fireEvent.click(pill)
        expect(screen.getByTestId('blocked-search-controls')).toBeTruthy()
    })

    it('still collapses the expanded search when focus leaves it entirely', () => {
        // Positive control: the escape hatch must be scoped to those controls,
        // not a blanket "never collapse".
        renderList([blocked('stuck-one'), makeSession({ id: 'fine-one' })])

        fireEvent.click(within(screen.getByTestId('session-list-search')).getAllByRole('button')[0]!)
        expect(screen.getByTestId('blocked-search-controls')).toBeTruthy()

        fireEvent.blur(screen.getByTestId('session-list-search'), { relatedTarget: document.body })

        expect(screen.queryByTestId('blocked-search-controls')).toBeNull()
    })

    it('does not let the selected session escape the machine filter', () => {
        // The machine filter had no selected-session exception before the
        // blocked jump, and must not gain one: with a machine-A session open,
        // switching the list to machine B left A's row on screen. Only an
        // in-flight jump may cross machines, and only while it holds its
        // exemption — so the exception keys off `revealBlockedSessionId`, not
        // `filterExemptId`, which falls back to the selected session.
        localStorage.setItem('hapi-session-list-machine-filter', 'machine-b')
        const onA = makeSession({
            id: 'on-machine-a',
            active: true,
            metadata: { path: '/a', name: 'on-machine-a', flavor: 'claude', machineId: 'machine-a' }
        })
        const onB = makeSession({
            id: 'on-machine-b',
            active: true,
            metadata: { path: '/b', name: 'on-machine-b', flavor: 'claude', machineId: 'machine-b' }
        })
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
        render(wrap(
            <SessionList
                sessions={[onA, onB]}
                selectedSessionId="on-machine-a"
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                api={null}
            />
        ))

        // The machine-B row proves the filter is active and the list rendered.
        expect(document.querySelector('[data-session-id="on-machine-b"]')).not.toBeNull()
        expect(document.querySelector('[data-session-id="on-machine-a"]')).toBeNull()
    })

    it('reveals a jump target that the operator\'s saved status filter hides', () => {
        // The pill refuses to rewrite persisted preferences, so an exemption is
        // the only thing that can bring this row on screen. "Archived" hides
        // every active session, and an agent parked on a permission prompt is
        // active by definition — so the row the pill is counting is one the
        // list will not render until the jump exempts it.
        // jsdom has no layout, so it ships no `scrollIntoView` at all.
        Element.prototype.scrollIntoView = vi.fn()
        localStorage.setItem('hapi-session-list-status', 'archived')
        renderList([pending('stuck-one'), makeSession({ id: 'old-one' })])

        expect(document.querySelector('[data-session-id="stuck-one"]')).toBeNull()

        fireEvent.click(screen.getByTestId('blocked-jump-pill'))

        // Regression: the exemption was released on the very next render,
        // before the scroll effect could use it, so the row was filtered
        // straight back out and clicking the pill did nothing at all.
        expect(document.querySelector('[data-session-id="stuck-one"]')).not.toBeNull()
    })
})
