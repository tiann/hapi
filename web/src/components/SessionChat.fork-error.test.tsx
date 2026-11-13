import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ApiError } from '@/api/client'
import { SessionChat } from './SessionChat'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, Session } from '@/types/api'
import type { ForkPreviewResponse } from '@hapi/protocol/forkBoundary'

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

function userRow(id: string, seq: number, text: string): DecryptedMessage {
    return { id, seq, localId: `${id}-local`, createdAt: seq * 1000, invokedAt: seq * 1000,
        content: { role: 'user', content: { type: 'text', text } } }
}
function agentRow(id: string, seq: number, text: string): DecryptedMessage {
    return { id, seq, localId: `${id}-local`, createdAt: seq * 1000,
        content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: text } } } }
}

function makeSession(thinking: boolean): Session {
    return {
        id: 'ses-1',
        active: true,
        thinking,
        activeTurnStartedAt: null,
        metadata: {
            capabilities: { conversationHistory: { forkCurrent: true, forkAtMessage: true, forkLatestCompleted: true, forkPreview: true, rewindToMessage: true } },
            conversationHistoryPoints: { 'u1-local': true, 'u2-local': true, 'u3-local': true }
        }
    } as unknown as Session
}

const baseRows: DecryptedMessage[] = [
    userRow('u1', 1, 'first question'),
    agentRow('a1', 2, 'first answer'),
    userRow('u2', 3, 'second question'),
    agentRow('a2', 4, 'second answer')
]

const currentResponse: ForkPreviewResponse = {
    mode: 'current',
    boundary: { v: 1, mode: 'current', epoch: 1, tailSeq: 4 },
    keptTail: baseRows,
    excluded: [],
    counts: { kept: 4, excluded: 0 }
}

describe('fork preview error display in the chat', () => {
    afterEach(() => {
        cleanup()
        vi.restoreAllMocks()
    })

    function shell(forkPreview: ReturnType<typeof vi.fn>, fork: ReturnType<typeof vi.fn>, session: Session, messages: DecryptedMessage[]): ReactNode {
        const api = {
            forkConversation: fork,
            rewindConversation: fork,
            forkPreview,
            fetchTranscriptionProviders: vi.fn(async () => [])
        } as unknown as ApiClient
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        return (
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
    }

    it('shows a retryable error dialog when the preview fetch fails at connect level', async () => {
        const fork = vi.fn(async () => ({ sessionId: 'ses-child' }))
        const forkPreview = vi.fn()
        forkPreview.mockRejectedValueOnce(new TypeError('Failed to fetch'))
        forkPreview.mockResolvedValueOnce(currentResponse)

        render(shell(forkPreview, fork, makeSession(false), baseRows))
        fireEvent.click((await screen.findAllByRole('button', { name: 'Fork' })).at(-1)!)

        // The chat surfaces the failure instead of swallowing it: a single
        // Retry action (dismissed via Esc/backdrop), not the fork dialog.
        const errorDialog = await screen.findByRole('dialog', { name: 'Fork conversation' })
        expect(within(errorDialog).getByText('Failed to fetch')).toBeTruthy()
        expect(within(errorDialog).getByRole('button', { name: 'Retry' })).toBeTruthy()
        expect(within(errorDialog).queryByRole('button', { name: 'Cancel' })).toBeNull()
        expect(screen.queryByTestId('fork-preview-thread')).toBeNull()

        // Retry re-runs the same current-intent request and opens the preview.
        fireEvent.click(within(errorDialog).getByRole('button', { name: 'Retry' }))
        await screen.findByTestId('fork-preview-thread')
        expect(forkPreview).toHaveBeenLastCalledWith('ses-1', 'current', undefined)
        expect(screen.queryByRole('dialog', { name: 'Fork conversation' })).toBeNull()
    })

    it('shows a dismiss-only error dialog when the hub rejects the preview', async () => {
        const fork = vi.fn(async () => ({ sessionId: 'ses-child' }))
        const forkPreview = vi.fn(async () => {
            throw new ApiError('HTTP 409 Conflict: {"error":"Fork current is not supported for this session"}', 409)
        })

        render(shell(forkPreview, fork, makeSession(false), baseRows))
        fireEvent.click((await screen.findAllByRole('button', { name: 'Fork' })).at(-1)!)

        const errorDialog = await screen.findByRole('dialog', { name: 'Fork conversation' })
        // The apiErrorText extraction keeps the hub's own message visible.
        expect(within(errorDialog).getByText(/Fork current is not supported for this session/)).toBeTruthy()
        // Hub rejections keep the plain dismiss affordances (the dialog's
        // close button, not a Retry action).
        expect(within(errorDialog).getByRole('button', { name: 'Close' })).toBeTruthy()
        expect(within(errorDialog).queryByRole('button', { name: 'Retry' })).toBeNull()
    })
})