import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '@/api/client'
import type { ApiClient } from '@/api/client'
import { SessionChat } from './SessionChat'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import type { DecryptedMessage, Session } from '@/types/api'

vi.mock('@tanstack/react-router', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useNavigate: () => async () => {}
}))

class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
    ;(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub
}
if (typeof Element.prototype.scrollTo !== 'function') {
    Element.prototype.scrollTo = function scrollTo() {}
}

function makeSession(): Session {
    return {
        id: 'ses-1',
        active: true,
        thinking: false,
        activeTurnStartedAt: null,
        metadata: { flavor: 'claude', path: '/repo', host: 'machine' },
        permissionMode: 'default'
    } as unknown as Session
}

const rows: DecryptedMessage[] = [
    { id: 'u1', seq: 1, localId: 'u1-local', createdAt: 1000, invokedAt: 1000,
        content: { role: 'user', content: { type: 'text', text: 'first question' } } }
]

function shell(api: Record<string, unknown>) {
    api.fetchTranscriptionProviders = vi.fn(async () => [])
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return (
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <ToastProvider>
                    <SessionChat
                        api={api as unknown as ApiClient}
                        session={makeSession()}
                        messages={rows}
                        messagesWarning={null}
                        hasMoreMessages={false}
                        isSyncingTail={false}
                        isCatchingUpFromCache={false}
                        cachedTailFirstFrame={false}
                        isLoadingMoreMessages={false}
                        isSending={false}
                        viewMode="tail"
                        messagesVersion={0}
                        historyVersion={0}
                        tailRevision={0}
                        onBack={() => {}}
                        onRefresh={() => {}}
                        onLoadMore={async () => 'terminal-stop' as never}
                        onCancelLoadMore={() => {}}
                        onSend={async () => false}
                        onViewModeChange={() => {}}
                        onJumpToTail={() => {}}
                    />
                </ToastProvider>
            </I18nProvider>
        </QueryClientProvider>
    )
}

describe('session tasks in the chat', () => {
    afterEach(() => {
        cleanup()
        vi.restoreAllMocks()
    })

    it('offers Repeat and Queue in the clock panel on a hub with the task routes', async () => {
        const api = { listSessionTasks: vi.fn(async () => ({ tasks: [] })) }
        render(shell(api))
        const clock = await screen.findByRole('button', { name: 'Schedule and tasks' })
        await waitFor(() => expect(api.listSessionTasks).toHaveBeenCalled())

        fireEvent.click(clock)
        expect(await screen.findByRole('dialog', { name: 'Schedule send' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Repeat' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Queue' })).toBeTruthy()
    })

    it('keeps the clock panel to scheduled send on a hub without the task routes', async () => {
        const api = {
            listSessionTasks: vi.fn(async () => { throw new ApiError('HTTP 404 Not Found: {"error":"Not Found"}', 404) }),
            createSessionTask: vi.fn(),
        }
        render(shell(api))
        await waitFor(() => expect(api.listSessionTasks).toHaveBeenCalled())
        // Once the hub has answered, the button goes back to naming scheduled send alone.
        const clock = await screen.findByRole('button', { name: 'Schedule send' })

        fireEvent.click(clock)
        expect(await screen.findByRole('dialog', { name: 'Schedule send' })).toBeTruthy()
        expect(screen.getByRole('button', { name: /relative/i })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Repeat' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Queue' })).toBeNull()
        // No task bar, and no error text leaked into the chat.
        expect(screen.queryByText('Tasks')).toBeNull()
        expect(screen.queryByRole('alert')).toBeNull()
    })
})
