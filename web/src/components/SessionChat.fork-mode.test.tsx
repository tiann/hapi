import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { SessionChat } from './SessionChat'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import type { ApiClient } from '@/api/client'
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

function userMessage(id: string, seq: number, text: string): DecryptedMessage {
    return { id, seq, localId: `${id}-local`, createdAt: seq * 1000, invokedAt: seq * 1000,
        content: { role: 'user', content: { type: 'text', text } } }
}
function agentTurn(id: string, seq: number, text: string): DecryptedMessage {
    return { id, seq, localId: `${id}-local`, createdAt: seq * 1000,
        content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: text } } } }
}

function makeSession(thinking: boolean): Session {
    return {
        id: 'ses-1',
        active: true,
        thinking,
        activeTurnStartedAt: null,
        metadata: { capabilities: { conversationHistory: { forkCurrent: true, forkLatestCompleted: true } } }
    } as unknown as Session
}

const baseMessages: DecryptedMessage[] = [
    userMessage('u1', 1, 'first question'),
    agentTurn('a1', 2, 'first answer'),
    userMessage('u2', 3, 'second question'),
    agentTurn('a2', 4, 'second answer')
]

describe('fork preview mode while the dialog stays open', () => {
    afterEach(() => {
        cleanup()
        vi.restoreAllMocks()
    })

    it('switches the open current-tail preview to the last-completed cut when the source starts running', async () => {
        const fork = vi.fn(async () => ({ sessionId: 'ses-child' }))
        const api = {
            forkConversation: fork,
            fetchTranscriptionProviders: vi.fn(async () => [])
        } as unknown as ApiClient
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const shell = (session: Session, messages: DecryptedMessage[]): ReactNode => (
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <ToastProvider>
                    <SessionChat
                        api={api}
                        session={session}
                        messages={messages}
                        messagesWarning={null}
                        hasMoreMessages={false}
                        isSyncingTail={false}
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

        const view = render(shell(makeSession(false), baseMessages))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Fork' })).toBeTruthy())
        fireEvent.click(screen.getByRole('button', { name: 'Fork' }))
        const preview = await screen.findByTestId('fork-preview-thread')

        // Idle source: the plain current-tail preview keeps the whole transcript.
        const kept = preview.firstElementChild as HTMLElement
        expect(within(kept).getByText('first answer')).toBeTruthy()
        expect(within(kept).getByText('second answer')).toBeTruthy()
        expect(screen.queryByTestId('fork-preview-boundary-message')).toBeNull()

        // A turn starts while the dialog is open: the same live fork decision
        // must now fork through the last completed turn, so the preview cuts
        // before the in-progress turn instead of showing it as copied.
        view.rerender(shell(makeSession(true), [
            ...baseMessages,
            userMessage('u3', 5, 'third question')
        ]))

        const boundary = await screen.findByTestId('fork-preview-boundary-message', {}, { timeout: 2000 })
        expect(within(boundary).getByText('third question')).toBeTruthy()
        const keptAfter = (screen.getByTestId('fork-preview-thread').firstElementChild) as HTMLElement
        expect(within(keptAfter).queryByText('third question')).toBeNull()
        expect(within(keptAfter).getByText('second answer')).toBeTruthy()
        expect(screen.getByText('Copies up to the last completed turn · The reply still running in the source is not included · The original session is unchanged')).toBeTruthy()
    })
})