import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { SESSION_MENTION_DRAG_MIME } from '@/lib/sessionMentionDrag'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
})

function session(id: string, name: string, hasConversationContent: boolean): SessionSummary {
    return {
        id,
        active: true,
        thinking: false,
        activeAt: 1,
        updatedAt: 1,
        metadata: { path: '/work/app', name },
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
        hasConversationContent,
    }
}

function renderList(coarsePointer = false) {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
        matches: coarsePointer && query.includes('pointer: coarse'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    }))
    const onSelect = vi.fn()
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
            <ToastProvider>
                <I18nProvider>
                    <SessionList
                        sessions={[
                            session('11111111-2222-4333-8444-555555555555', 'Mentionable', true),
                            session('quiet-session', 'Quiet', false),
                        ]}
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
    return onSelect
}

describe('SessionList session drag', () => {
    it('drags only mentionable desktop rows and cancels the pending long-press', () => {
        const onSelect = renderList()
        const mentionable = screen.getByRole('button', { name: /Mentionable/ })
        const quiet = screen.getByRole('button', { name: /Quiet/ })
        expect(mentionable).toHaveAttribute('draggable', 'true')
        expect(quiet).toHaveAttribute('draggable', 'false')

        const ignored = { effectAllowed: 'all', setData: vi.fn() }
        fireEvent.dragStart(quiet, { dataTransfer: ignored })
        expect(ignored.setData).not.toHaveBeenCalled()

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        fireEvent.mouseDown(mentionable, { button: 0, clientX: 8, clientY: 8 })
        const dataTransfer = { effectAllowed: 'all', setData: vi.fn() }
        fireEvent.dragStart(mentionable, { dataTransfer })
        act(() => {
            vi.advanceTimersByTime(700)
        })

        expect(dataTransfer.effectAllowed).toBe('copy')
        expect(dataTransfer.setData).toHaveBeenCalledWith(
            SESSION_MENTION_DRAG_MIME,
            JSON.stringify({
                id: '11111111-2222-4333-8444-555555555555',
                title: 'Mentionable',
            })
        )
        expect(screen.queryByRole('menu')).toBeNull()
        expect(onSelect).not.toHaveBeenCalled()
    })

    it('opens the action menu when a press is not dragged', () => {
        renderList()
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        fireEvent.mouseDown(screen.getByRole('button', { name: /Mentionable/ }), {
            button: 0,
            clientX: 8,
            clientY: 8,
        })
        act(() => {
            vi.advanceTimersByTime(700)
        })
        expect(screen.getByRole('menu')).toBeInTheDocument()
    })

    it('does not drag session rows on a coarse pointer', () => {
        renderList(true)
        const mentionable = screen.getByRole('button', { name: /Mentionable/ })
        expect(mentionable).toHaveAttribute('draggable', 'false')
        const dataTransfer = { effectAllowed: 'all', setData: vi.fn() }
        fireEvent.dragStart(mentionable, { dataTransfer })
        expect(dataTransfer.setData).not.toHaveBeenCalled()
    })
})
