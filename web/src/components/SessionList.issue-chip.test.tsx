import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
        updatedAt: 0,
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
        ...overrides
    }
}

function renderWithProviders(children: ReactNode) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    return render(
        <QueryClientProvider client={queryClient}>
            <ToastProvider>
                <I18nProvider>{children}</I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
}

// Regression for hapi#238 Codex review, three passes: (1) IssueRefChip used
// to render inside the row's own native <button>, so clicking it also
// selected the session and the link was unreachable via keyboard/touch; (2)
// switching to `role="button"` fixed the keyboard trap but WAI-ARIA still
// forbids a focusable descendant of a button role, so the chip is now a true
// DOM sibling of the row's role="button" div, not nested inside it — which
// also means it never needs to stop event propagation to avoid
// double-activating the row, since it's no longer inside the element
// useLongPress binds its handlers to.
//
// `selectedSessionId` is set to the fixture's own id in every test below —
// a directory group with no active/pinned/selected session now starts
// genuinely collapsed (CollapsiblePanel unmounts its children, not just a
// CSS `data-open` toggle on always-present DOM), so an inactive, unselected
// fixture session would otherwise never reach the DOM at all.
describe('SessionList issue-ref chip isolation', () => {
    it('renders as a DOM sibling of the row, not a descendant of its role="button"', () => {
        const session = makeSession({
            id: 'session-1',
            updatedAt: Date.now(),
            metadata: {
                path: '/home/ubuntu',
                name: 'Fix the thing',
                flavor: 'codex',
                externalRefs: [
                    { kind: 'github_issue', url: 'https://github.com/heavygee/hapi/issues/235', repo: 'heavygee/hapi', number: 235, linkedAt: 1 }
                ]
            }
        })

        renderWithProviders(
            <SessionList
                sessions={[session]}
                selectedSessionId="session-1"
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
            />
        )

        const chip = screen.getByTestId('issue-ref-chip')
        const row = screen.getByText('Fix the thing').closest('[role="button"]')
        expect(row).not.toBeNull()
        expect(row?.contains(chip)).toBe(false)
    })

    it('does not select the session when the issue chip is clicked', () => {
        const onSelect = vi.fn()
        const session = makeSession({
            id: 'session-1',
            updatedAt: Date.now(),
            metadata: {
                path: '/home/ubuntu',
                name: 'Fix the thing',
                flavor: 'codex',
                externalRefs: [
                    { kind: 'github_issue', url: 'https://github.com/heavygee/hapi/issues/235', repo: 'heavygee/hapi', number: 235, linkedAt: 1 }
                ]
            }
        })

        renderWithProviders(
            <SessionList
                sessions={[session]}
                selectedSessionId="session-1"
                onSelect={onSelect}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
            />
        )

        const chip = screen.getByTestId('issue-ref-chip')
        expect(chip.tagName).toBe('A')
        expect(chip).toHaveAttribute('href', 'https://github.com/heavygee/hapi/issues/235')

        fireEvent.mouseDown(chip, { button: 0 })
        fireEvent.mouseUp(chip)
        fireEvent.click(chip)

        expect(onSelect).not.toHaveBeenCalled()
    })

    it('still selects the session when the row itself is clicked', () => {
        const onSelect = vi.fn()
        const session = makeSession({
            id: 'session-1',
            updatedAt: Date.now(),
            metadata: {
                path: '/home/ubuntu',
                name: 'Fix the thing',
                flavor: 'codex',
                externalRefs: [
                    { kind: 'github_issue', url: 'https://github.com/heavygee/hapi/issues/235', repo: 'heavygee/hapi', number: 235, linkedAt: 1 }
                ]
            }
        })

        renderWithProviders(
            <SessionList
                sessions={[session]}
                selectedSessionId="session-1"
                onSelect={onSelect}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
            />
        )

        // useLongPress now sources mouse activation from the browser's own
        // native 'click' event, not mousedown/mouseup timing (tiann/hapi
        // rewrite) — mousedown+mouseup alone only arms/clears the long-press
        // timer; a real browser's compatibility click still follows, same as
        // this hook's own tests mirror.
        const title = screen.getByText('Fix the thing')
        fireEvent.mouseDown(title, { button: 0 })
        fireEvent.mouseUp(title)
        fireEvent.click(title)
        expect(onSelect).toHaveBeenCalledWith('session-1')
    })
})
