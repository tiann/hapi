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

const latestResponse: ForkPreviewResponse = {
    mode: 'latestCompleted',
    boundary: { v: 1, mode: 'latestCompleted', epoch: 1, tailSeq: 5 },
    keptTail: baseRows,
    excluded: [userRow('u3', 5, 'third question')],
    counts: { kept: 4, excluded: 1 }
}

describe('fork preview fed by the hub while the dialog stays open', () => {
    afterEach(() => {
        cleanup()
        vi.restoreAllMocks()
    })

    function shell(forkPreview: ReturnType<typeof vi.fn>, fork: ReturnType<typeof vi.fn>, session: Session, messages: DecryptedMessage[], rewind?: ReturnType<typeof vi.fn>): ReactNode {
        const api = {
            forkConversation: fork,
            rewindConversation: rewind ?? fork,
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

    it('re-answers the preview from the hub when the source starts running, and confirms with the token', async () => {
        const fork = vi.fn(async () => ({ sessionId: 'ses-child' }))
        const forkPreview = vi.fn()
        forkPreview.mockResolvedValueOnce(currentResponse)
        forkPreview.mockResolvedValueOnce(latestResponse)

        const view = render(shell(forkPreview, fork, makeSession(false), baseRows))
        await waitFor(() => expect(screen.getAllByRole('button', { name: 'Fork' }).length).toBeGreaterThan(0))
        fireEvent.click(screen.getAllByRole('button', { name: 'Fork' }).at(-1)!)

        const preview = await screen.findByTestId('fork-preview-thread')
        expect(within(preview).getByText('first answer')).toBeTruthy()
        expect(within(preview).getByText('second answer')).toBeTruthy()
        expect(screen.queryByTestId('fork-preview-boundary-message')).toBeNull()
        expect(forkPreview).toHaveBeenCalledWith('ses-1', 'current', undefined)

        // A turn starts while the dialog is open: the flow re-asks the hub,
        // which now answers with the latest-completed cut.
        view.rerender(shell(forkPreview, fork, makeSession(true), [
            ...baseRows,
            userRow('u3', 5, 'third question')
        ]))

        await waitFor(() => expect(forkPreview).toHaveBeenCalledTimes(2))
        const boundary = await screen.findByTestId('fork-preview-boundary-message')
        expect(within(boundary).getByText('third question')).toBeTruthy()
        const keptAfter = (screen.getByTestId('fork-preview-thread').firstElementChild ?? null) as HTMLElement | null
        expect(keptAfter).toBeTruthy()
        expect(within(keptAfter!).queryByText('third question')).toBeNull()
        expect(within(keptAfter!).getByText('second answer')).toBeTruthy()
        expect(screen.getByText('Copies up to the last completed turn · The reply still running in the source is not included · The original session is unchanged')).toBeTruthy()

        fireEvent.click(screen.getByTestId('fork-preview-confirm'))
        await waitFor(() => expect(fork).toHaveBeenCalledWith('ses-1', undefined, true, latestResponse.boundary))
    })

    it('leaves a confirm in flight alone when the source starts running mid-confirm', async () => {
        let resolveFork: (value: { sessionId: string }) => void = () => {}
        const fork = vi.fn(() => new Promise<{ sessionId: string }>((resolve) => { resolveFork = resolve }))
        const forkPreview = vi.fn(async () => currentResponse)

        const view = render(shell(forkPreview, fork, makeSession(false), baseRows))
        await waitFor(() => expect(screen.getAllByRole('button', { name: 'Fork' }).length).toBeGreaterThan(0))
        fireEvent.click(screen.getAllByRole('button', { name: 'Fork' }).at(-1)!)
        await screen.findByTestId('fork-preview-thread')
        expect(forkPreview).toHaveBeenCalledTimes(1)

        fireEvent.click(screen.getByTestId('fork-preview-confirm'))
        await waitFor(() => expect(fork).toHaveBeenCalled())

        // A turn starts while the confirm RPC is in flight: the confirm is
        // left alone, and no background re-preview fires behind it.
        view.rerender(shell(forkPreview, fork, makeSession(true), baseRows))
        resolveFork({ sessionId: 'ses-child' })
        await waitFor(() => expect(screen.queryByTestId('fork-preview-thread')).toBeNull())
        expect(forkPreview).toHaveBeenCalledTimes(1)
    })

    it('refreshes the preview in place and asks for re-confirmation on boundary_moved', async () => {
        const fork = vi.fn(async () => { throw new ApiError('HTTP 409 Conflict: {"error":"New conversation rows appeared since the preview","code":"boundary_moved"}', 409, 'boundary_moved', '{"error":"New conversation rows appeared since the preview","code":"boundary_moved"}') })
        const forkPreview = vi.fn(async () => currentResponse)

        render(shell(forkPreview, fork, makeSession(false), baseRows))
        fireEvent.click((await screen.findAllByRole('button', { name: 'Fork' })).at(-1)!)
        await screen.findByTestId('fork-preview-thread')
        fireEvent.click(screen.getByTestId('fork-preview-confirm'))

        // The hub refused the confirm as boundary_moved: the flow refreshes
        // the preview, keeps the dialog open, and demands a re-confirm.
        await waitFor(() => expect(screen.getByTestId('fork-preview-stale')).toBeTruthy())
        expect(screen.getByTestId('fork-preview-thread')).toBeTruthy()
        expect(forkPreview).toHaveBeenCalledTimes(2)
        expect(fork).toHaveBeenCalledTimes(1)
    })

    it('disables Confirm while a second re-preview runs behind a finished refresh', async () => {
        const deferreds: Array<(value: ForkPreviewResponse) => void> = []
        const fork = vi.fn(async () => { throw new ApiError('HTTP 409 Conflict: {"error":"New conversation rows appeared since the preview","code":"boundary_moved"}', 409, 'boundary_moved', '{"error":"New conversation rows appeared since the preview","code":"boundary_moved"}') })
        const forkPreview = vi.fn()
            .mockResolvedValueOnce(currentResponse)
            .mockImplementationOnce(() => new Promise<ForkPreviewResponse>((resolve) => { deferreds.push(resolve) }))
            .mockImplementationOnce(() => new Promise<ForkPreviewResponse>((resolve) => { deferreds.push(resolve) }))

        const view = render(shell(forkPreview, fork, makeSession(false), baseRows))
        fireEvent.click((await screen.findAllByRole('button', { name: 'Fork' })).at(-1)!)
        await screen.findByTestId('fork-preview-thread')
        fireEvent.click(screen.getByTestId('fork-preview-confirm'))

        // boundary_moved: the first refresh starts (still inside the confirm's
        // pending window), and a thinking edge fires a second re-preview.
        await waitFor(() => expect(forkPreview).toHaveBeenCalledTimes(2))
        view.rerender(shell(forkPreview, fork, makeSession(true), baseRows))
        await waitFor(() => expect(forkPreview).toHaveBeenCalledTimes(3))

        // The confirm's await ends with the first refresh: pending resets even
        // though the second re-preview is still replacing the mounted stale
        // view. Confirm must wait for the fresh boundary instead of re-sending
        // the stale token.
        deferreds[0]!(currentResponse)
        await waitFor(() => expect(screen.getByTestId('fork-preview-stale')).toBeTruthy())
        expect((screen.getByTestId('fork-preview-confirm') as HTMLButtonElement).disabled).toBeTruthy()

        deferreds[1]!(currentResponse)
        await waitFor(() => expect((screen.getByTestId('fork-preview-confirm') as HTMLButtonElement).disabled).toBeFalsy())
    })

    it('requests a message intent when forking at a historical boundary', async () => {
        const fork = vi.fn(async () => ({ sessionId: 'ses-child' }))
        const messageResponse: ForkPreviewResponse = {
            mode: 'message',
            boundary: { v: 1, mode: 'message', messageLocalId: 'u1-local', epoch: 1, tailSeq: 4 },
            keptTail: [],
            excluded: [userRow('u1', 1, 'first question')],
            counts: { kept: 0, excluded: 1 }
        }
        const forkPreview = vi.fn(async () => messageResponse)

        render(shell(forkPreview, fork, makeSession(false), baseRows))
        const forkButtons = await screen.findAllByRole('button', { name: 'Fork' })
        // An older boundary card forks at its message, not the current tail.
        fireEvent.click(forkButtons[0])
        await screen.findByTestId('fork-preview-thread')
        expect(forkPreview).toHaveBeenCalledWith('ses-1', 'message', 'u1-local')
        expect(screen.getByTestId('fork-preview-boundary-message')).toBeTruthy()
    })

    it('previews a rewind as the deleted region and confirms with the token', async () => {
        const rewindResponse: ForkPreviewResponse = {
            mode: 'rewind',
            boundary: { v: 1, mode: 'rewind', messageLocalId: 'u2-local', epoch: 1, tailSeq: 4 },
            keptTail: [userRow('u1', 1, 'first question'), agentRow('a1', 2, 'first answer')],
            excluded: [userRow('u2', 3, 'second question'), agentRow('a2', 4, 'second answer')],
            counts: { kept: 2, excluded: 2 }
        }
        const forkPreview = vi.fn(async () => rewindResponse)
        const fork = vi.fn(async () => ({ success: true as const }))

        render(shell(forkPreview, fork, makeSession(false), baseRows))
        const rewindButtons = await screen.findAllByRole('button', { name: 'Rewind' })
        fireEvent.click(rewindButtons.at(-1)!)

        expect(await screen.findByTestId('fork-preview-excluded')).toBeTruthy()
        expect(forkPreview).toHaveBeenCalledWith('ses-1', 'rewind', 'u2-local')
        expect(screen.getByRole('heading', { name: 'Rewind the conversation to here' })).toBeTruthy()
        expect(screen.getByTestId('fork-preview-boundary-message')).toBeTruthy()

        fireEvent.click(screen.getByTestId('fork-preview-confirm'))
        await waitFor(() => expect(fork).toHaveBeenCalledWith('ses-1', 'u2-local', rewindResponse.boundary))
        await waitFor(() => expect(screen.queryByTestId('fork-preview-thread')).toBeNull())
    })

    it('offers the fork fallback when the runner can only fork at the rewind boundary', async () => {
        const fork = vi.fn(async () => {
            throw new ApiError('HTTP 409 Conflict: {"code":"ambiguous_native_boundary_fork_safe"}', 409,
                'ambiguous_native_boundary_fork_safe', '{"code":"ambiguous_native_boundary_fork_safe"}')
        })
        const rewindResponse: ForkPreviewResponse = {
            mode: 'rewind',
            boundary: { v: 1, mode: 'rewind', messageLocalId: 'u2-local', epoch: 1, tailSeq: 4 },
            keptTail: [userRow('u1', 1, 'first question')],
            excluded: [userRow('u2', 3, 'second question'), agentRow('a2', 4, 'second answer')],
            counts: { kept: 1, excluded: 2 }
        }
        const forkPreview = vi.fn()
        forkPreview.mockResolvedValueOnce(rewindResponse)
        forkPreview.mockResolvedValueOnce(currentResponse)

        render(shell(forkPreview, fork, makeSession(false), baseRows))
        const rewindButtons = await screen.findAllByRole('button', { name: 'Rewind' })
        fireEvent.click(rewindButtons.at(-1)!)
        await screen.findByTestId('fork-preview-excluded')
        fireEvent.click(screen.getByTestId('fork-preview-confirm'))

        // The runner can only fork here: the rewind preview closes and the
        // fork-at-boundary preview opens for the same message.
        const fallbackDialog = await screen.findByRole('dialog', { name: 'Rewind unavailable' })
        fireEvent.click(within(fallbackDialog).getByRole('button', { name: 'Fork here' }))
        await waitFor(() => expect(screen.getByTestId('fork-preview-thread')).toBeTruthy())
        expect(forkPreview).toHaveBeenLastCalledWith('ses-1', 'message', 'u2-local')
    })

    it('offers the fork fallback when the legacy rewind reports a fork-safe ambiguous boundary', async () => {
        // Old hub: every preview 404s, so the rewind runs through the legacy
        // confirm dialog instead of the preview token.
        const forkPreview = vi.fn(async () => { throw new ApiError('HTTP 404 Not Found', 404) })
        const rewind = vi.fn(async () => {
            throw new ApiError('HTTP 409 Conflict: {"code":"ambiguous_native_boundary_fork_safe"}', 409,
                'ambiguous_native_boundary_fork_safe', '{"code":"ambiguous_native_boundary_fork_safe"}')
        })
        const fork = vi.fn(async () => ({ sessionId: 'ses-child' }))

        render(shell(forkPreview, fork, makeSession(false), baseRows, rewind))
        const rewindButtons = await screen.findAllByRole('button', { name: 'Rewind' })
        fireEvent.click(rewindButtons.at(-1)!)

        const legacyDialog = await screen.findByRole('dialog', { name: 'Rewind conversation' })
        fireEvent.click(within(legacyDialog).getByRole('button', { name: 'Rewind' }))

        // The runner can only fork here: the legacy rewind must offer the
        // same fork fallback the preview confirm offers.
        const fallbackDialog = await screen.findByRole('dialog', { name: 'Rewind unavailable' })
        fireEvent.click(within(fallbackDialog).getByRole('button', { name: 'Fork here' }))
        await waitFor(() => expect(forkPreview).toHaveBeenLastCalledWith('ses-1', 'message', 'u2-local'))
    })

})
