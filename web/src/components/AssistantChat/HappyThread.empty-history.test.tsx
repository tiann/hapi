import { act, cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { HappyThread } from './HappyThread'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'

vi.mock('@/hooks/queries/useMachines', () => ({ useMachines: () => ({ machines: [] }) }))

afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe('empty transcript history coverage', () => {
    it.each([true, false])('loads hidden pages until content appears or history ends (visible=%s)', async (visible) => {
        vi.useFakeTimers()
        vi.stubGlobal('ResizeObserver', class { observe() { } disconnect() { } })
        const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => { } })
        const onLoadMore = vi.fn()
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        function Harness() {
            const [page, setPage] = useState(0)
            const messages: ThreadMessageLike[] = page >= 3 && visible
                ? [{ id: 'main-prompt', createdAt: new Date(1700000000000), role: 'user', metadata: { custom: { kind: 'user' } }, content: [{ type: 'text', text: 'Visible parent conversation' }] }]
                : []
            const runtime = useExternalStoreRuntime({
                messages,
                convertMessage: (message) => message,
                extras: { messagesVersion: page + 1, historyVersion: page },
                onNew: async () => { }
            })
            return <AssistantRuntimeProvider runtime={runtime}>
                <HappyThread
                    api={{ getHubSettings: async () => ({ sessionSummaryContract: false, sessionSummaryInChat: false }) } as ApiClient}
                    session={{ id: 'hidden-history', metadata: null } as Session}
                    sessionId="hidden-history" metadata={null} disabled={false}
                    onRefresh={vi.fn()} onViewModeChange={vi.fn()} isSyncingTail={false}
                    messagesWarning={null} hasMoreMessages={visible || page < 3} isLoadingMoreMessages={false}
                    onLoadMore={async (beforeApply) => {
                        onLoadMore()
                        const next = page + 1
                        if (beforeApply && !beforeApply(next)) return { kind: 'stopped', reason: 'invalidated' }
                        setPage(next)
                        return { kind: 'applied', historyVersion: next, hasMore: visible || next < 3, addedRenderableCount: 200 }
                    }}
                    onCancelLoadMore={vi.fn()} unseenCount={0} rawMessagesCount={20 + page * 200}
                    normalizedMessagesCount={20 + page * 200} messagesVersion={page + 1}
                    historyVersion={page} forceScrollToken={0} outlineOpen={false} outlineItems={[]}
                    onOutlineOpenChange={vi.fn()}
                />
            </AssistantRuntimeProvider>
        }
        try {
            const result = render(<QueryClientProvider client={queryClient}><I18nProvider><Harness /></I18nProvider></QueryClientProvider>)
            for (let i = 0; i < 8; i++) {
                await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
            }
            const transcript = result.container.querySelector('.happy-thread-messages')!
            expect(transcript).not.toBeNull()
            if (visible) expect(transcript.textContent).toContain('Visible parent conversation')
            else expect(transcript.childElementCount).toBe(0)
            expect(onLoadMore).toHaveBeenCalledTimes(3)
        } finally {
            if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo)
            else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
        }
    })
})
