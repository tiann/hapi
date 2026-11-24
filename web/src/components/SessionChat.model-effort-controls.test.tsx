import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionChat } from './SessionChat'

vi.mock('@tanstack/react-router', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useNavigate: () => async () => {}
}))

// SessionChat hands these straight to HappyComposer, whose toolbar hides the
// value buttons when their callbacks are absent. Capture the props so the test
// asserts the wiring without the composer's catalog-dependent labels.
const captured = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }))
vi.mock('@/components/AssistantChat/HappyComposer', () => ({
    HappyComposer: (props: Record<string, unknown>) => {
        captured.props = props
        return null
    }
}))

vi.mock('@/hooks/queries/useClaudeModels', () => ({
    useClaudeModels: () => ({ availableModels: [] })
}))
vi.mock('@/hooks/queries/useKimiModelsForSession', () => ({
    useKimiModelsForSession: () => ({ availableModels: [] })
}))
vi.mock('@/hooks/queries/useKimiReasoningEffortOptions', () => ({
    useKimiReasoningEffortOptions: () => []
}))
vi.mock('@/hooks/queries/useOpencodeModels', () => ({
    useOpencodeModels: () => ({ availableModels: [], currentModelId: null, isLoading: false, error: null })
}))
vi.mock('@/hooks/queries/useOpencodeReasoningEffortOptions', () => ({
    useOpencodeReasoningEffortOptions: () => ({ options: [], currentValue: null, isLoading: false, error: null })
}))
vi.mock('@/hooks/queries/usePiModels', () => ({
    usePiModels: () => ({
        availableModels: [{ provider: 'test', modelId: 'pi-model', name: 'Pi Model' }],
        currentModelId: 'pi-model',
        isLoading: false,
        error: null
    })
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

function makeSession(opts: { flavor: string; controlledByUser?: boolean; shared?: boolean }): Session {
    return {
        id: 'ses-mc',
        active: true,
        thinking: false,
        activeTurnStartedAt: null,
        metadata: {
            path: '/tmp/project',
            host: 'localhost',
            flavor: opts.flavor,
            ...(opts.shared ? { capabilities: { concurrentClients: true } } : {})
        },
        agentState: {
            controlledByUser: opts.controlledByUser ?? false,
            requests: {},
            completedRequests: {}
        }
    } as unknown as Session
}

function renderChat(session: Session): void {
    const api = {
        forkConversation: vi.fn(),
        rewindConversation: vi.fn(),
        forkPreview: vi.fn(),
        fetchTranscriptionProviders: vi.fn(async () => [])
    } as unknown as ApiClient
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const node = (
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <ToastProvider>
                    <SessionChat
                        api={api}
                        session={session}
                        messages={[]}
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
    ) as ReactNode
    render(node)
}

function capturedProps(): { onModelChange?: unknown; onEffortChange?: unknown; onModelReasoningEffortChange?: unknown; piModels?: unknown } {
    return (captured.props ?? {}) as {
        onModelChange?: unknown
        onEffortChange?: unknown
        onModelReasoningEffortChange?: unknown
        piModels?: unknown
    }
}

describe('SessionChat locally driven model and effort controls', () => {
    afterEach(() => {
        cleanup()
        captured.props = null
    })

    it('hides the model and effort controls for a locally driven Claude session', () => {
        renderChat(makeSession({ flavor: 'claude', controlledByUser: true }))
        const props = capturedProps()
        expect(props.onModelChange).toBeUndefined()
        expect(props.onEffortChange).toBeUndefined()
    })

    it('hides the model control for a locally driven Kimi session', () => {
        renderChat(makeSession({ flavor: 'kimi', controlledByUser: true }))
        expect(capturedProps().onModelChange).toBeUndefined()
    })

    it('hides the model control for a locally driven OpenCode session', () => {
        renderChat(makeSession({ flavor: 'opencode', controlledByUser: true }))
        expect(capturedProps().onModelChange).toBeUndefined()
    })

    it('still shows the model and effort controls when the session is not locally driven', () => {
        renderChat(makeSession({ flavor: 'claude', controlledByUser: false }))
        const props = capturedProps()
        expect(props.onModelChange).toBeTypeOf('function')
        expect(props.onEffortChange).toBeTypeOf('function')
    })

    it('still shows the model and effort controls when concurrent clients are enabled', () => {
        renderChat(makeSession({ flavor: 'claude', controlledByUser: true, shared: true }))
        const props = capturedProps()
        expect(props.onModelChange).toBeTypeOf('function')
        expect(props.onEffortChange).toBeTypeOf('function')
    })

    it('still shows the Pi model control for a locally driven session', () => {
        renderChat(makeSession({ flavor: 'pi', controlledByUser: true }))
        const props = capturedProps()
        expect(props.onModelChange).toBeTypeOf('function')
        expect(props.piModels).toBeDefined()
    })
})
