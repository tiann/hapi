import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

afterEach(() => cleanup())

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
        attachedJob: null,
        attachedJobUpdatedAt: 0,
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

// Regression: SessionListScrollAnchor.tsx queries by the
// `data-session-scroll-anchor` attribute, then checks `classList.contains
// ('session-list-item')` on that SAME element to decide whether a row (vs. a
// group header, which never carries the class) still counts as a scroll
// anchor while partially scrolled off the viewport top. Splitting the class
// and the attribute across the row's outer/inner wrapper divs (hapi#238
// ARIA restructuring) silently made every session row behave like a group
// header for anchor purposes. Both must stay on the same element.
describe('SessionList scroll-anchor DOM invariant', () => {
    it('keeps session-list-item and data-session-scroll-anchor on the same element for a session row', () => {
        const session = makeSession({ id: 'session-1', updatedAt: Date.now(), metadata: { path: '/x', name: 'Fix the thing', flavor: 'codex' } })
        renderWithProviders(
            <SessionList
                sessions={[session]}
                // Keeps the directory group's CollapsiblePanel expanded —
                // a group with no active/pinned/selected session now starts
                // collapsed (unmounted children, not just CSS-hidden).
                selectedSessionId="session-1"
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
            />
        )
        const row = screen.getByText('Fix the thing').closest('[data-session-scroll-anchor]')
        expect(row).not.toBeNull()
        expect(row).toHaveClass('session-list-item')
    })

    // Regression: index.css's tooltip-overflow-release rule used to read
    // `.session-list-item:focus-visible` — valid only if the SAME element
    // carries both the class and the focus, which stopped being true the
    // moment hapi#238 moved the row's actual focusable element to an inner
    // div while `session-list-item` stayed on the outer wrapper (same split
    // as the invariant above, different consequence: a dead CSS rule instead
    // of a scroll-anchor misclassification). `:has(:focus-visible)` is the
    // fix — it only needs a focus-visible *descendant*, not an exact-element
    // match. Exercised via querySelector against the live DOM rather than
    // computed-style assertions: jsdom doesn't apply an external stylesheet's
    // cascade, so this tests the selector's structural correctness — does it
    // find the right element once real keyboard focus lands — not anything
    // stylesheet-loading-dependent (review finding, tiann/hapi#2147).
    it('matches the focused row via :has(:focus-visible), not :focus-visible on the wrapper itself', () => {
        const session = makeSession({ id: 'session-1', updatedAt: Date.now(), metadata: { path: '/x', name: 'Fix the thing', flavor: 'codex' } })
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
        const row = screen.getByText('Fix the thing').closest('.session-list-item')!
        const focusTarget = row.querySelector<HTMLElement>('[role="button"]')!
        focusTarget.focus()
        expect(document.activeElement).toBe(focusTarget)

        expect(row.matches(':has(:focus-visible)')).toBe(true)
        expect(row.matches(':focus-visible')).toBe(false)
    })
})
