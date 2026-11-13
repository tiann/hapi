import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'
import type { ForkPreviewResponse } from '@hapi/protocol/forkBoundary'

afterEach(cleanup)

function session(): SessionSummary {
    return {
        id: 'session-1',
        active: true,
        thinking: false,
        activeAt: 1,
        updatedAt: 1,
        metadata: {
            path: '/work/app',
            name: 'Forkable session',
            flavor: 'codex',
            conversationHistory: { forkCurrent: true, forkAtMessage: true }
        },
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
        model: null,
        effort: null,
        attachedJob: null,
        attachedJobUpdatedAt: 0,
    }
}

function renderList(api: ApiClient) {
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
                        api={api}
                    />
                </I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
}

function openRowMenu() {
    const row = screen.getByRole('button', { name: /Forkable session/ })
    fireEvent.mouseDown(row, { button: 2, clientX: 10, clientY: 10 })
    fireEvent.mouseUp(row, { button: 2, clientX: 10, clientY: 10 })
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
}

describe('SessionList fork preview error dialog', () => {
    it('offers a retry for a connect-level preview failure from the list', async () => {
        const preview: ForkPreviewResponse = {
            mode: 'current',
            boundary: { v: 1, mode: 'current', epoch: 1, tailSeq: 0 },
            keptTail: [],
            excluded: [],
            counts: { kept: 0, excluded: 0 }
        }
        const forkPreview = vi.fn()
        forkPreview.mockRejectedValueOnce(new TypeError('Failed to fetch'))
        forkPreview.mockResolvedValueOnce(preview)
        const api = {
            forkPreview,
            forkConversation: vi.fn(async () => ({ sessionId: 'ses-child' })),
            rewindConversation: vi.fn(async () => ({ success: true as const }))
        } as unknown as ApiClient

        renderList(api)
        openRowMenu()
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Fork session' }))

        // The list mirrors the chat's error dialog: a connect-level failure
        // is retryable, with a single Retry action and no duplicate Cancel.
        const errorDialog = await screen.findByRole('dialog', { name: 'Fork session' })
        expect(within(errorDialog).getByText('Failed to fetch')).toBeTruthy()
        expect(within(errorDialog).getByRole('button', { name: 'Retry' })).toBeTruthy()
        expect(within(errorDialog).queryByRole('button', { name: 'Cancel' })).toBeNull()

        // Retry re-runs the same request and opens the preview dialog.
        fireEvent.click(within(errorDialog).getByRole('button', { name: 'Retry' }))
        await screen.findByRole('dialog', { name: 'Start a new session from here' })
        expect(forkPreview).toHaveBeenCalledTimes(2)
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Fork session' })).toBeNull())
    })

    it('keeps the hub-rejection dialog dismiss-only in the list', async () => {
        const forkPreview = vi.fn(async () => {
            throw new ApiError('HTTP 409 Conflict: {"error":"Fork current is not supported for this session"}', 409,
                undefined, '{"error":"Fork current is not supported for this session"}')
        })
        const api = {
            forkPreview,
            forkConversation: vi.fn(async () => ({ sessionId: 'ses-child' })),
            rewindConversation: vi.fn(async () => ({ success: true as const }))
        } as unknown as ApiClient

        renderList(api)
        openRowMenu()
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Fork session' }))

        const errorDialog = await screen.findByRole('dialog', { name: 'Fork session' })
        expect(within(errorDialog).getByText(/Fork current is not supported for this session/)).toBeTruthy()
        expect(within(errorDialog).getByRole('button', { name: 'Dismiss' })).toBeTruthy()
        expect(within(errorDialog).queryByRole('button', { name: 'Retry' })).toBeNull()
    })
})