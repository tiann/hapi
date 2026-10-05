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
                            selectedSessionId={null}
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
    })
})
