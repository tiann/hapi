import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { setChatShortcuts } from '@/hooks/useChatShortcuts'
import { DEFAULT_CHAT_SHORTCUTS } from '@/lib/chatShortcuts'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import type { Session } from '@/types/api'
import { SessionChat } from './SessionChat'

const cachedTailFirstFrameProps = { cachedTailFirstFrame: false }

vi.mock('@tanstack/react-router', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useNavigate: () => async () => {},
}))

if (typeof Element.prototype.scrollTo !== 'function') {
    Element.prototype.scrollTo = function scrollTo() {}
}

afterEach(() => {
    cleanup()
    setChatShortcuts(DEFAULT_CHAT_SHORTCUTS)
    vi.unstubAllGlobals()
})

it('cycles DSH reasoning effort from the value applied to the session', async () => {
    vi.stubGlobal('ResizeObserver', class {
        observe() {}
        unobserve() {}
        disconnect() {}
    })
    setChatShortcuts({ ...DEFAULT_CHAT_SHORTCUTS, effort: 'alt+e' })
    const setModelReasoningEffort = vi.fn<(id: string, effort: string | null) => Promise<void>>().mockResolvedValue(undefined)
    const api = {
        setModelReasoningEffort,
        getSessionDshModels: vi.fn(async () => ({ success: true, availableModels: [], currentModelId: null })),
        fetchTranscriptionProviders: vi.fn(async () => []),
    } as unknown as ApiClient
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    function DshChat() {
        const [effort, setEffort] = useState<string | null>('off')
        const session = {
            id: 'dsh-session', active: true, thinking: false, modelReasoningEffort: effort,
            metadata: { flavor: 'dsh', path: '/work', host: 'test' },
        } as Session
        return <SessionChat
            {...cachedTailFirstFrameProps}
            api={api}
            session={session}
            messages={[]}
            messagesWarning={null}
            hasMoreMessages={false}
            isSyncingTail={false}
            isCatchingUpFromCache={false}
            isLoadingMoreMessages={false}
            isSending={false}
            viewMode="tail"
            messagesVersion={0}
            historyVersion={0}
            tailRevision={0}
            onBack={() => {}}
            onRefresh={() => {
                const applied = setModelReasoningEffort.mock.lastCall
                if (applied) setEffort(applied[1])
            }}
            onLoadMore={async () => ({ kind: 'stopped', reason: 'unavailable' } as const)}
            onCancelLoadMore={() => {}}
            onSend={async () => false}
            onViewModeChange={() => {}}
            onJumpToTail={() => {}}
        />
    }

    render(
        <QueryClientProvider client={client}>
            <I18nProvider><ToastProvider><DshChat /></ToastProvider></I18nProvider>
        </QueryClientProvider>,
    )
    for (const [index, effort] of ['low', 'high', 'max', null, 'off'].entries()) {
        await act(async () => {
            fireEvent.keyDown(document.body, { key: 'e', altKey: true })
        })
        expect(setModelReasoningEffort).toHaveBeenNthCalledWith(index + 1, 'dsh-session', effort)
    }
})
