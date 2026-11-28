import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')

function session(): SessionSummary {
    return {
        id: 'session-1',
        active: true,
        thinking: false,
        activeAt: 1,
        updatedAt: 1,
        metadata: { path: '/work/app', name: 'Copy path session' },
        metadataVersion: 0,
        agentStateVersion: 1,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        activeTaskCount: 0,
        nextTaskRunAt: null,
        model: null,
        effort: null,
        attachedJob: null,
        attachedJobUpdatedAt: 0,
    }
}

function renderList() {
    return render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
            <ToastProvider>
                <I18nProvider>
                    <SessionList
                        sessions={[session()]}
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

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    if (originalExecCommand) {
        Object.defineProperty(document, 'execCommand', originalExecCommand)
    } else {
        delete (document as { execCommand?: unknown }).execCommand
    }
})

describe('SessionList copy path in the project group header', () => {
    it('uses the legacy fallback without collapsing the group', async () => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
        const execCommand = vi.fn(() => true)
        Object.defineProperty(document, 'execCommand', {
            configurable: true,
            writable: true,
            value: execCommand,
        })

        renderList()
        const header = screen.getByTitle('/work/app')
        expect(header).toHaveAttribute('aria-expanded', 'true')

        fireEvent.click(screen.getByRole('button', { name: 'Copy: /work/app' }))

        await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'))
        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Copied!' })).toBeTruthy()
        })
        expect(header).toHaveAttribute('aria-expanded', 'true')
    })
})
