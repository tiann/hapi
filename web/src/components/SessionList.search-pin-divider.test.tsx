import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

const SEARCH_LABEL = 'Search sessions (title, path, Agent, machine name, ID, and more)'
const SEARCH_PLACEHOLDER = 'Search title/path/Agent/machine/ID…'
const PROJECT_PATH = '/work/proj'

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
        attachedJob: null,
        attachedJobUpdatedAt: 0,
        ...overrides,
    }
}

/**
 * tiann #1842 repro: relevance sort interleaved pinned↔ordinary and the
 * renderer drew a divider on every transition (two dividers in one group).
 */
function tiannPinDividerSessions(): SessionSummary[] {
    return [
        makeSession({
            id: 'home-pinned',
            pinned: true,
            updatedAt: 400,
            metadata: { path: PROJECT_PATH, name: 'Home pinned', flavor: 'codex' },
        }),
        makeSession({
            id: 'home-ordinary',
            updatedAt: 300,
            metadata: { path: PROJECT_PATH, name: 'Home ordinary', flavor: 'codex' },
        }),
        makeSession({
            id: 'homelab-pinned',
            pinned: true,
            updatedAt: 200,
            metadata: { path: PROJECT_PATH, name: 'homelab pinned', flavor: 'codex' },
        }),
        makeSession({
            id: 'homelab-ordinary',
            updatedAt: 100,
            metadata: { path: PROJECT_PATH, name: 'homelab ordinary', flavor: 'codex' },
        }),
    ]
}

function renderList(sessions: SessionSummary[]) {
    return render(
        <QueryClientProvider
            client={new QueryClient({
                defaultOptions: {
                    queries: { retry: false },
                    mutations: { retry: false },
                },
            })}
        >
            <ToastProvider>
                <I18nProvider>
                    <SessionList
                        sessions={sessions}
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
}

describe('SessionList search pin dividers', () => {
    it('renders at most one pin divider in a group under relevance sort (tiann #1842)', () => {
        renderList(tiannPinDividerSessions())

        fireEvent.click(screen.getByRole('button', { name: SEARCH_LABEL }))
        fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), {
            target: { value: 'home' },
        })

        // All four titles match; group stays open under search filtering.
        expect(screen.getByRole('button', { name: /Home pinned/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Home ordinary/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /homelab pinned/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /homelab ordinary/ })).toBeInTheDocument()

        const projectHeader = screen.getByTitle(PROJECT_PATH)
        const projectRoot = projectHeader.parentElement
        expect(projectRoot).toBeTruthy()
        const dividers = within(projectRoot as HTMLElement).getAllByTestId('session-pin-divider')
        expect(dividers).toHaveLength(1)
    })
})
