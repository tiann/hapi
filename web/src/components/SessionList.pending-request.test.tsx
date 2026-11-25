import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

afterEach(cleanup)

function session(): SessionSummary {
    return {
        id: 'session-1',
        active: true,
        thinking: true,
        activeAt: 1,
        updatedAt: 1,
        metadata: { path: '/work/app', name: 'Pending question' },
        metadataVersion: 0,
        agentStateVersion: 1,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 1,
        pendingRequestKinds: ['input'],
        pendingRequests: [{ id: 'request-1', kind: 'input', tool: 'request_user_input', since: 1 }],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        attachedJob: null,
        attachedJobUpdatedAt: 0,
    }
}

type SelectHandler = (sessionId: string, targetMessageId?: string, targetMessageQuery?: string, pendingRequestId?: string) => void

function renderList(onSelect: SelectHandler, selectedSessionId: string | null = null) {
    return render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
            <ToastProvider>
                <I18nProvider>
                    <SessionList
                        sessions={[session()]}
                        selectedSessionId={selectedSessionId}
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
}

describe('SessionList pending request navigation', () => {
    it('routes an icon click to the request instead of the ordinary session target', () => {
        const onSelect = vi.fn<SelectHandler>()
        const { container } = renderList(onSelect)
        const icon = container.querySelector('[data-session-pending-request-id="request-1"]')
        expect(icon).not.toBeNull()
        fireEvent.pointerDown(icon!, { button: 0 })
        fireEvent.click(icon!)
        expect(onSelect).toHaveBeenCalledExactlyOnceWith('session-1', undefined, undefined, 'request-1')
    })

    it('routes Enter from an already selected session to its pending request', () => {
        const onSelect = vi.fn<SelectHandler>()
        renderList(onSelect, 'session-1')
        fireEvent.keyDown(screen.getByRole('button', { name: /Pending question/ }), { key: 'Enter' })
        expect(onSelect).toHaveBeenCalledExactlyOnceWith('session-1', undefined, undefined, 'request-1')
    })
    it('keeps ordinary row activation as a plain session open', () => {
        const onSelect = vi.fn<SelectHandler>()
        renderList(onSelect)
        fireEvent.click(screen.getByRole('button', { name: /Pending question/ }))
        expect(onSelect).toHaveBeenCalledOnce()
        expect(onSelect.mock.calls[0]?.[3]).toBeUndefined()
    })
})