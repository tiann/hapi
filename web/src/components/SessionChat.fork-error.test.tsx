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

const latestCompletedResponse: ForkPreviewResponse = {
    mode: 'latestCompleted',
    boundary: { v: 1, mode: 'latestCompleted', epoch: 1, tailSeq: 4 },
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

        // While the preview request is in flight the per-message history
        // affordances lock, so another message's Fork/Rewind cannot supersede
        // the request behind the user's back.
        expect(screen.queryByRole('button', { name: 'Fork' })).toBeNull()

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

    it('replaces a stale preview with the error dialog when the refresh fails', async () => {
        const fork = vi.fn(async () => ({ sessionId: 'ses-child' }))
        const forkPreview = vi.fn()
        forkPreview.mockResolvedValueOnce(currentResponse)
        forkPreview.mockRejectedValueOnce(new ApiError('HTTP 409 Conflict: {"error":"Session is busy"}', 409, undefined, '{"error":"Session is busy"}'))

        const view = render(shell(forkPreview, fork, makeSession(false), baseRows))
        fireEvent.click((await screen.findAllByRole('button', { name: 'Fork' })).at(-1)!)
        await screen.findByTestId('fork-preview-thread')

        // A thinking edge while the dialog is open re-asks the hub; when that
        // refresh fails, the error dialog must replace the outdated preview
        // instead of hiding behind it.
        view.rerender(shell(forkPreview, fork, makeSession(true), baseRows))
        const errorDialog = await screen.findByRole('dialog', { name: 'Fork conversation' })
        expect(within(errorDialog).getByText(/Session is busy/)).toBeTruthy()
        expect(screen.queryByTestId('fork-preview-thread')).toBeNull()
    })

    it('re-asks the hub when the source starts running while the first preview is loading', async () => {
        const fork = vi.fn(async () => ({ sessionId: 'ses-child' }))
        let resolveFirst!: (value: ForkPreviewResponse) => void
        const forkPreview = vi.fn()
        forkPreview.mockImplementationOnce(() => new Promise<ForkPreviewResponse>(resolve => { resolveFirst = resolve }))
        forkPreview.mockResolvedValueOnce(latestCompletedResponse)

        const view = render(shell(forkPreview, fork, makeSession(false), baseRows))
        fireEvent.click((await screen.findAllByRole('button', { name: 'Fork' })).at(-1)!)

        // The turn starts while the request is in flight: the edge must
        // re-issue the preview request instead of being consumed before the
        // stale answer lands.
        view.rerender(shell(forkPreview, fork, makeSession(true), baseRows))
        await waitFor(() => expect(forkPreview).toHaveBeenCalledTimes(2))
        resolveFirst(currentResponse)

        // The stale first answer is discarded; the refreshed latestCompleted
        // boundary is what the dialog shows.
        await screen.findByTestId('fork-preview-thread')
        expect(screen.getByText(/Copies up to the last completed turn/)).toBeTruthy()
    })

    it('locks the legacy confirm while the fork RPC is in flight', async () => {
        const fork = vi.fn()
        let resolveFork!: (value: { sessionId: string }) => void
        fork.mockImplementation(() => new Promise<{ sessionId: string }>(resolve => { resolveFork = resolve }))
        const forkPreview = vi.fn(async () => { throw new ApiError('HTTP 404 Not Found', 404) })

        render(shell(forkPreview, fork, makeSession(false), baseRows))
        fireEvent.click((await screen.findAllByRole('button', { name: 'Fork' })).at(-1)!)
        const legacyDialog = await screen.findByRole('dialog', { name: 'Fork conversation' })
        fireEvent.click(within(legacyDialog).getByRole('button', { name: 'Fork' }))

        // The legacy confirm runs the fork RPC with no preview round-trip:
        // the dialog must show the confirming label and lock both buttons
        // while it is pending, or a double click submits the fork twice.
        const confirming = await within(legacyDialog).findByRole('button', { name: 'Forking…' })
        expect(confirming).toBeDisabled()
        expect(within(legacyDialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()

        resolveFork({ sessionId: 'ses-child' })
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Fork conversation' })).toBeNull())
    })

    it('titles the rewind preview error dialog as a rewind', async () => {
        const fork = vi.fn(async () => ({ sessionId: 'ses-child' }))
        const forkPreview = vi.fn(async () => { throw new TypeError('Failed to fetch') })

        render(shell(forkPreview, fork, makeSession(false), baseRows))
        fireEvent.click((await screen.findAllByRole('button', { name: 'Rewind' })).at(-1)!)

        // The failure came from an openRewind request; the dialog must not
        // introduce itself as a fork.
        const errorDialog = await screen.findByRole('dialog', { name: 'Rewind conversation' })
        expect(within(errorDialog).getByRole('button', { name: 'Retry' })).toBeTruthy()
        expect(screen.queryByRole('dialog', { name: 'Fork conversation' })).toBeNull()
    })
})