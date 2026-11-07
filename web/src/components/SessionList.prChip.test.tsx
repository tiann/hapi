import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

vi.mock('@/hooks/queries/useFeatures', () => ({
    useFeatures: () => ({
        features: {
            githubPrAwareness: { enabled: true, envControlled: false },
            prChipDisplay: undefined
        },
        isLoading: false,
        error: null
    })
}))

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
        updatedAt: 1,
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

describe('SessionList PR chip', () => {
    it('renders an interactive PR chip beside the row button that opens the PR', async () => {
        const onSelect = vi.fn()
        render(
            <QueryClientProvider
                client={new QueryClient({
                    defaultOptions: {
                        queries: { retry: false },
                        mutations: { retry: false }
                    }
                })}
            >
                <ToastProvider>
                    <I18nProvider>
                        <SessionList
                            sessions={[makeSession({
                                id: 'sess-pr',
                                metadata: {
                                    path: '/tmp/demo',
                                    name: 'PR linked session',
                                    externalRefs: [{
                                        kind: 'github_pr',
                                        repo: 'tiann/hapi',
                                        number: 1163,
                                        url: 'https://github.com/tiann/hapi/pull/1163',
                                        role: 'primary',
                                        source: 'user',
                                        linkedAt: 1
                                    }]
                                }
                            })]}
                            // Keeps the directory group's CollapsiblePanel
                            // expanded — a group with no active/pinned/
                            // selected session now starts collapsed
                            // (unmounted children, not just CSS-hidden).
                            selectedSessionId="sess-pr"
                            onSelect={onSelect}
                            onNewSession={vi.fn()}
                            onRefresh={vi.fn()}
                            isLoading={false}
                            renderHeader={false}
                            api={null}
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        const chip = await screen.findByTestId('session-pr-chip')
        expect(chip.tagName).toBe('A')
        expect(chip).toHaveAttribute('href', 'https://github.com/tiann/hapi/pull/1163')
        expect(chip).toHaveTextContent(/#1163/)
        expect(chip.closest('button')).toBeNull()

        fireEvent.click(chip)
        expect(onSelect).not.toHaveBeenCalled()

        // Attention/schedule HoverTooltips use group-focus-visible/session-row;
        // the named group must sit on the focusable row element itself (a
        // `<div role="button">`, not a native `<button>` — ARIA disallows a
        // focusable descendant of a button role, which the sibling PR/issue
        // chips are now rendered as), not its wrapper div.
        const rowButton = screen.getByRole('button', { name: /PR linked session/i })
        expect(rowButton.className.split(/\s+/)).toContain('group/session-row')
        expect(rowButton.parentElement?.className.split(/\s+/)).not.toContain('group/session-row')
    })

    // Review finding: linkPrOpen was absent from overlayOpen, so a session
    // group's CollapsiblePanel released its mount hold and unmounted
    // LinkPrDialog (discarding whatever the operator had typed) the moment
    // the group collapsed while the dialog was still open.
    it('keeps a collapsing row mounted while its Link PR dialog is open', () => {
        render(
            <QueryClientProvider
                client={new QueryClient({
                    defaultOptions: {
                        queries: { retry: false },
                        mutations: { retry: false }
                    }
                })}
            >
                <ToastProvider>
                    <I18nProvider>
                        <SessionList
                            sessions={[makeSession({
                                id: 'session-link-pr',
                                updatedAt: 100,
                                metadata: { path: '/work/link-pr-demo', name: 'Needs a PR link', flavor: 'codex' }
                            })]}
                            selectedSessionId={null}
                            onSelect={vi.fn()}
                            onNewSession={vi.fn()}
                            onRefresh={vi.fn()}
                            isLoading={false}
                            renderHeader={false}
                            api={null}
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        const header = screen.getByTitle('/work/link-pr-demo')
        fireEvent.click(header)
        fireEvent.contextMenu(screen.getByRole('button', { name: /Needs a PR link/ }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Link pull request…' }))
        expect(screen.getByRole('dialog', { name: 'Link pull request' })).toBeInTheDocument()

        fireEvent.click(header)
        const panel = document.querySelector('.collapsible-panel')!
        fireEvent.transitionEnd(panel)
        expect(screen.getByRole('dialog', { name: 'Link pull request' })).toBeInTheDocument()

        fireEvent.keyDown(screen.getByRole('dialog', { name: 'Link pull request' }), { key: 'Escape' })
        expect(screen.queryByRole('dialog', { name: 'Link pull request' })).toBeNull()
        expect(screen.queryByRole('button', { name: /Needs a PR link/ })).toBeNull()
    })
})
