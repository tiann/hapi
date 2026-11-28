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

function makeSession(permissionMode: Session['permissionMode'] = 'default'): Session {
    return {
        id: 'ses-1',
        active: true,
        thinking: false,
        activeTurnStartedAt: null,
        metadata: { flavor: 'claude', path: '/repo', host: 'machine' },
        permissionMode
    } as unknown as Session
}

const rows: DecryptedMessage[] = [
    { id: 'u1', seq: 1, localId: 'u1-local', createdAt: 1000, invokedAt: 1000,
        content: { role: 'user', content: { type: 'text', text: 'first question' } } }
]

function shell(api: Record<string, unknown>, permissionMode: Session['permissionMode'] = 'default') {
    api.fetchTranscriptionProviders = vi.fn(async () => [])
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return (
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <ToastProvider>
                    <SessionChat
                        api={api as unknown as ApiClient}
                        session={makeSession(permissionMode)}
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

    it('offers History in the clock panel, where the runs of finished or deleted tasks live, and asks for them only once it is opened', async () => {
        // The bar is gone with the last task; what the tasks did stays reachable from the clock button alone.
        const api = {
            listSessionTasks: vi.fn(async () => ({ tasks: [] })),
            listSessionTaskRuns: vi.fn(async () => ({
                runs: [{ id: 'r1', sessionId: 'ses-1', taskId: 't1', taskKind: 'repeat', runNumber: 1, outcome: 'sent', scheduledFor: 1000, recordedAt: 1000, takenAt: 2000, detail: null, preview: 'check progress' }]
            }))
        }
        render(shell(api))
        const clock = await screen.findByRole('button', { name: 'Schedule and tasks' })
        await waitFor(() => expect(api.listSessionTasks).toHaveBeenCalled())
        expect(screen.queryByText('Tasks')).toBeNull()

        fireEvent.click(clock)
        const toggle = await screen.findByRole('button', { name: 'History' })
        expect(api.listSessionTaskRuns).not.toHaveBeenCalled()
        expect(screen.queryByRole('button', { name: 'History' })).toHaveAttribute('aria-pressed', 'false')

        fireEvent.click(toggle)
        const history = await screen.findByRole('list', { name: 'History' })
        expect(api.listSessionTaskRuns).toHaveBeenCalledWith('ses-1', 50)
        expect(history.textContent).toContain('check progress')
        expect(history.textContent).toContain('Taken by the agent')
        expect(screen.queryByText('Tasks')).toBeNull()
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

    it('says in the Repeat and Queue forms that a task runs with the session\'s stored permission mode, when that mode does not ask first', async () => {
        const api = { listSessionTasks: vi.fn(async () => ({ tasks: [] })) }
        render(shell(api, 'bypassPermissions'))
        fireEvent.click(await screen.findByRole('button', { name: 'Schedule and tasks' }))
        const hint = "Runs with this session's permission mode (Yolo), which acts without asking first."
        fireEvent.click(await screen.findByRole('button', { name: 'Repeat' }))
        expect(await screen.findByText(hint)).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Queue' }))
        expect(await screen.findByText(hint)).toBeTruthy()
    })

    it('says nothing about permissions in the task forms of a session that asks before it acts', async () => {
        const api = { listSessionTasks: vi.fn(async () => ({ tasks: [] })) }
        render(shell(api, 'acceptEdits'))
        fireEvent.click(await screen.findByRole('button', { name: 'Schedule and tasks' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Repeat' }))
        expect(await screen.findByRole('dialog', { name: 'Repeat' })).toBeTruthy()
        expect(screen.queryByText(/permission mode/)).toBeNull()
    })
})
