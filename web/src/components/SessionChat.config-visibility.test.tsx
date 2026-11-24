import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionChat } from './SessionChat'

type ComposerProps = {
    onModelChange?: unknown
    onEffortChange?: unknown
    onModelReasoningEffortChange?: unknown
}

const state = vi.hoisted(() => ({ captured: null as ComposerProps | null }))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useNavigate: () => async () => {}
}))

vi.mock('@/components/AssistantChat/HappyComposer', () => ({
    HappyComposer: (props: ComposerProps) => {
        state.captured = props
        return null
    }
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

const ok = (extra: Record<string, unknown> = {}) => ({ success: true, ...extra })

const api = {
    getSessionCodexModels: vi.fn(async () => ok({ models: [] })),
    getMachineCodexModels: vi.fn(async () => ok({ models: [] })),
    getSessionCursorModels: vi.fn(async () => ok({ availableModels: [], currentModelId: null })),
    getMachineAgyModels: vi.fn(async () => ok({ availableModels: [], currentModelId: null })),
    getMachineClaudeModels: vi.fn(async () => ok({ availableModels: [] })),
    getSessionOpencodeModels: vi.fn(async () => ok({ availableModels: [], currentModelId: null })),
    getSessionOpencodeReasoningEffortOptions: vi.fn(async () => ok({ options: [], currentValue: null })),
    getSessionGrokModels: vi.fn(async () => ok({ availableModels: [], currentModelId: null })),
    getSessionGrokReasoningEffortOptions: vi.fn(async () => ok({ options: [], currentValue: null })),
    getSessionCopilotModels: vi.fn(async () => ok({ availableModels: [], currentModelId: null })),
    getSessionCopilotReasoningEffortOptions: vi.fn(async () => ok({ options: [], currentValue: null })),
    getSessionKimiModels: vi.fn(async () => ok({ availableModels: [], currentModelId: null })),
    getSessionKimiReasoningEffortOptions: vi.fn(async () => ok({ options: [], currentValue: null })),
    getSessionDshModels: vi.fn(async () => ok({ availableModels: [], currentModelId: null })),
    getMachineDshModels: vi.fn(async () => ok({ availableModels: [], currentModelId: null })),
    callPiEndpoint: vi.fn(async () => ok({ availableModels: [], currentModelId: null })),
    fetchTranscriptionProviders: vi.fn(async () => [])
} as unknown as ApiClient

function makeSession(flavor: string | null, local: boolean, shared = false): Session {
    return {
        id: 'ses-visibility',
        active: true,
        thinking: false,
        activeTurnStartedAt: null,
        metadata: {
            flavor,
            capabilities: shared ? { concurrentClients: true } : undefined
        },
        agentState: { controlledByUser: local, requests: {}, completedRequests: {} }
    } as unknown as Session
}

function shell(session: Session): ReactNode {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } })
    return (
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
    )
}

afterEach(() => {
    cleanup()
    state.captured = null
})

const FLAVORS = [
    'agy', 'claude', 'codex', 'dsh', 'copilot', 'cursor',
    'gemini', 'grok', 'kimi', 'opencode', 'pi', 'unknown', null
] as const

type Op = 'model' | 'effort' | 'modelReasoningEffort'
const PROP: Record<Op, keyof ComposerProps> = {
    model: 'onModelChange',
    effort: 'onEffortChange',
    modelReasoningEffort: 'onModelReasoningEffortChange'
}

// Visibility on HEAD with an active session and empty catalogs. `true` means
// the composer receives a handler, so the control is offered.
const HEAD_VISIBLE: Record<Op, Record<string, boolean>> = {
    model: {
        agy: true, claude: true, codex: true, dsh: true, copilot: true,
        cursor: false, gemini: true, grok: true, kimi: true, opencode: true,
        pi: true, unknown: true, null: true
    },
    effort: {
        agy: false, claude: true, codex: true, dsh: true, copilot: false,
        cursor: true, gemini: true, grok: false, kimi: false, opencode: true,
        pi: true, unknown: true, null: true
    },
    modelReasoningEffort: {
        agy: false, claude: false, codex: true, dsh: true, copilot: false,
        cursor: false, gemini: false, grok: false, kimi: false, opencode: false,
        pi: false, unknown: false, null: false
    }
}

// Flavors that lose the control while a single local client drives the session.
const HEAD_LOCAL_HIDDEN: Record<Op, ReadonlySet<string>> = {
    model: new Set(['codex', 'cursor', 'grok', 'copilot']),
    effort: new Set(['agy', 'grok', 'copilot', 'kimi']),
    modelReasoningEffort: new Set(['codex', 'opencode', 'dsh'])
}

function isVisible(op: Op): boolean {
    const handler = state.captured?.[PROP[op]]
    return handler !== undefined && handler !== null
}

describe('SessionChat config control visibility', () => {
    for (const op of ['model', 'effort', 'modelReasoningEffort'] as const) {
        it(`pins ${op} visibility for every flavor and local state`, async () => {
            for (const flavor of FLAVORS) {
                const key = String(flavor)
                for (const local of [false, true]) {
                    render(shell(makeSession(flavor, local)))
                    const want = HEAD_VISIBLE[op][key] && !(local && HEAD_LOCAL_HIDDEN[op].has(key))
                    expect(isVisible(op), `${op} flavor=${key} local=${local}`).toBe(want)
                    cleanup()
                    state.captured = null
                }
            }
        })

        it(`keeps ${op} visible for a shared session even when controlledByUser is true`, async () => {
            for (const flavor of FLAVORS) {
                const key = String(flavor)
                render(shell(makeSession(flavor, true, true)))
                expect(isVisible(op), `${op} flavor=${key} shared`).toBe(HEAD_VISIBLE[op][key])
                cleanup()
                state.captured = null
            }
        })
    }
})
