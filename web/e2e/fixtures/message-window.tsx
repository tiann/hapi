import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/index.css'
import { ApiClient } from '@/api/client'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { useSSE } from '@/hooks/useSSE'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { I18nProvider } from '@/lib/i18n-context'
import {
    clearMessageWindow,
    fetchLatestMessages,
    fetchNewerMessages,
    fetchOlderMessages,
    flushPendingMessages,
    getMessageWindowState,
    revalidateLatestMessagesAfterSseConnect,
    returnToLatestMessages,
    setAtBottom,
    subscribeMessageWindow,
} from '@/lib/message-window-store'
import type { Session, SyncEvent } from '@/types/api'
import type {
    MessageWindowHarnessSnapshot,
    MessageWindowPageRequest,
    MessageWindowScenario,
} from '../harness-types'

type Scenario = MessageWindowScenario
type HarnessSnapshot = MessageWindowHarnessSnapshot

type ServerDiagnostics = {
    pageRequests: MessageWindowPageRequest[]
    emittedCount: number
}

const SESSION_ID = 'message-window-e2e'
const API_BASE_URL = window.location.origin
const TOKEN = 'e2e-token'
const PRESERVE_ON_RECONNECT_KEY = 'hapi-e2e-preserve-message-window-once'
const requestedScenario = new URLSearchParams(window.location.search).get('scenario')
const INITIAL_SCENARIO: Scenario = requestedScenario === 'history'
    || requestedScenario === 'single-row-history'
    || requestedScenario === 'live-cap'
    || requestedScenario === 'ten-thousand'
    ? requestedScenario
    : 'tool-dense'
const preserveServerState = sessionStorage.getItem(PRESERVE_ON_RECONNECT_KEY) === 'true'
sessionStorage.removeItem(PRESERVE_ON_RECONNECT_KEY)
let latestBlockCount = 0
let latestSubscriptionId: string | null = null
let sseReceivedCount = 0
let sseConnectCount = 0
let resolveInitialReady!: () => void
let rejectInitialReady!: (error: unknown) => void
const initialReady = new Promise<void>((resolve, reject) => {
    resolveInitialReady = resolve
    rejectInitialReady = reject
})

const NativeEventSource = window.EventSource
let latestEventSource: EventSource | null = null
class HarnessEventSource extends NativeEventSource {
    constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
        super(url, eventSourceInitDict)
        latestEventSource = this
    }
}
window.EventSource = HarnessEventSource

class ManualIntersectionObserver implements IntersectionObserver {
    readonly root = null
    readonly rootMargin = ''
    readonly thresholds: ReadonlyArray<number> = []
    disconnect() {}
    observe() {}
    takeRecords(): IntersectionObserverEntry[] { return [] }
    unobserve() {}
}

window.IntersectionObserver = ManualIntersectionObserver

const api = new ApiClient(TOKEN, {
    baseUrl: API_BASE_URL,
    getToken: () => TOKEN,
})

const session = {
    id: SESSION_ID,
    namespace: 'e2e',
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: true,
    activeAt: 1,
    metadata: {
        path: '/tmp/hapi-message-window-e2e',
        host: 'playwright',
        flavor: 'codex',
    },
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 1,
    thinking: false,
    thinkingAt: 1,
    backgroundTaskCount: 0,
    model: null,
    modelReasoningEffort: null,
    serviceTier: null,
    effort: null,
    permissionMode: 'default',
    collaborationMode: null,
} as unknown as Session

async function controlRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers)
    if (init?.body !== undefined && !headers.has('content-type')) {
        headers.set('content-type', 'application/json')
    }
    const response = await fetch(`${API_BASE_URL}${path}`, {
        ...init,
        headers,
        cache: 'no-store',
    })
    if (!response.ok) {
        throw new Error(`E2E control request failed: ${response.status} ${await response.text()}`)
    }
    return await response.json() as T
}

async function waitForSseConnection(timeoutMs = 10_000): Promise<void> {
    const deadline = performance.now() + timeoutMs
    while (latestSubscriptionId === null) {
        if (performance.now() >= deadline) {
            throw new Error('Timed out waiting for the real SSE subscription')
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

async function loadScenario(
    scenario: Scenario,
    options: { resetServer?: boolean } = {},
): Promise<void> {
    if (options.resetServer !== false) {
        await controlRequest<{ ok: true }>('/api/__e2e/reset', {
            method: 'POST',
            body: JSON.stringify({ scenario }),
        })
    }
    sseReceivedCount = 0
    latestBlockCount = 0
    clearMessageWindow(SESSION_ID)
    const loaded = await fetchLatestMessages(api, SESSION_ID, { forceReplace: true })
    if (!loaded) {
        throw new Error(`Failed to load ${scenario} through the real ApiClient`)
    }
    for (let frame = 0; frame < 8; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
}

function prepareReconnect(): void {
    sessionStorage.setItem(PRESERVE_ON_RECONNECT_KEY, 'true')
}

function disconnectSse(): void {
    if (!latestEventSource) {
        throw new Error('No active EventSource to disconnect')
    }
    latestEventSource.close()
    latestEventSource.dispatchEvent(new Event('error'))
}

async function reviewAndStream(count: number): Promise<{
    sameVisibleReference: boolean
    sameVisibleOrder: boolean
}> {
    await waitForSseConnection()
    const before = getMessageWindowState(SESSION_ID)
    if (before.atBottom) {
        throw new Error('Review streaming requires a real historical scroll position')
    }
    const visibleReference = before.messages
    const visibleIds = before.messages.map((message) => message.id)
    const streamed = await controlRequest<{ ok: true; emittedCount: number }>('/api/__e2e/stream', {
        method: 'POST',
        body: JSON.stringify({ count }),
    })
    if (streamed.emittedCount < count) {
        throw new Error(`Fixture emitted ${streamed.emittedCount} events, expected ${count}`)
    }

    const deadline = performance.now() + 15_000
    while (true) {
        const current = getMessageWindowState(SESSION_ID)
        if (current.pendingCount === count && sseReceivedCount === count) {
            break
        }
        if (performance.now() >= deadline) {
            throw new Error(
                `Timed out waiting for SSE delivery: pending=${current.pendingCount} received=${sseReceivedCount}`,
            )
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
    }

    const after = getMessageWindowState(SESSION_ID)
    return {
        sameVisibleReference: after.messages === visibleReference,
        sameVisibleOrder: after.messages.length === visibleIds.length
            && after.messages.every((message, index) => message.id === visibleIds[index]),
    }
}

async function streamAtLiveBottom(
    count: number,
    options?: { newTurns?: boolean },
): Promise<void> {
    await waitForSseConnection()
    const before = getMessageWindowState(SESSION_ID)
    if (!before.atBottom || before.hasNewer) {
        throw new Error('Live streaming requires the physical and logical latest position')
    }
    const receivedBefore = sseReceivedCount
    await controlRequest<{ ok: true; emittedCount: number }>('/api/__e2e/stream', {
        method: 'POST',
        body: JSON.stringify({
            count,
            kind: options?.newTurns ? 'user-turns' : 'agent-events',
        }),
    })

    const deadline = performance.now() + 15_000
    while (sseReceivedCount < receivedBefore + count) {
        if (performance.now() >= deadline) {
            throw new Error(
                `Timed out waiting for live SSE delivery: received=${sseReceivedCount - receivedBefore}`,
            )
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

async function returnToLatest(): Promise<void> {
    const loaded = await returnToLatestMessages(api, SESSION_ID)
    if (!loaded) {
        throw new Error('Failed to return to the exact latest logical turn')
    }
}

async function getSnapshot(): Promise<HarnessSnapshot> {
    const diagnostics = await controlRequest<ServerDiagnostics>('/api/__e2e/diagnostics')
    const state = getMessageWindowState(SESSION_ID)
    const seqs = state.messages
        .map((row) => row.seq)
        .filter((seq): seq is number => typeof seq === 'number')
    return {
        rawCount: state.messages.length,
        pendingCount: state.pendingCount,
        blockCount: latestBlockCount,
        firstSeq: seqs.length > 0 ? Math.min(...seqs) : null,
        lastSeq: seqs.length > 0 ? Math.max(...seqs) : null,
        sequences: seqs,
        duplicateCount: seqs.length - new Set(seqs).size,
        gaps: state.gaps,
        hasOlder: state.hasOlder,
        hasNewer: state.hasNewer,
        atBottom: state.atBottom,
        pageRequests: diagnostics.pageRequests,
        sseConnected: latestSubscriptionId !== null,
        sseSubscriptionId: latestSubscriptionId,
        sseEmittedCount: diagnostics.emittedCount,
        sseReceivedCount,
    }
}

function MessageWindowHarness() {
    const state = useSyncExternalStore(
        (listener) => subscribeMessageWindow(SESSION_ID, listener),
        () => getMessageWindowState(SESSION_ID),
    )
    const normalized = useMemo(() => state.messages
        .map((row) => normalizeDecryptedMessage(row))
        .filter((row): row is NonNullable<typeof row> => row !== null), [state.messages])
    const reduced = useMemo(() => reduceChatBlocks(normalized, null), [normalized])
    latestBlockCount = reduced.blocks.length
    const runtime = useHappyRuntime({
        session,
        blocks: reduced.blocks,
        isSending: false,
        onSendMessage: async () => {},
        onAbort: async () => {},
        allowSendWhenInactive: true,
    })
    const onSseEvent = useCallback((event: SyncEvent) => {
        if (event.type === 'message-received' && event.sessionId === SESSION_ID) {
            sseReceivedCount += 1
        }
    }, [])
    const onSseConnect = useCallback(() => {
        sseConnectCount += 1
        if (sseConnectCount > 1) {
            void revalidateLatestMessagesAfterSseConnect(api, SESSION_ID)
        }
    }, [])
    const { subscriptionId } = useSSE({
        enabled: true,
        token: TOKEN,
        baseUrl: API_BASE_URL,
        subscription: { sessionId: SESSION_ID },
        onConnect: onSseConnect,
        onEvent: onSseEvent,
    })

    useEffect(() => {
        latestSubscriptionId = subscriptionId
        return () => {
            if (latestSubscriptionId === subscriptionId) {
                latestSubscriptionId = null
            }
        }
    }, [subscriptionId])

    useEffect(() => {
        void loadScenario(INITIAL_SCENARIO, {
            resetServer: !preserveServerState,
        }).then(resolveInitialReady, rejectInitialReady)
    }, [])

    return (
        <div
            data-testid="message-window-harness"
            style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
        >
            <div
                data-testid="message-window-diagnostics"
                data-raw-count={state.messages.length}
                data-pending-count={state.pendingCount}
                data-block-count={reduced.blocks.length}
                style={{ flex: '0 0 auto', padding: 4, fontFamily: 'monospace', fontSize: 11 }}
            >
                raw={state.messages.length} pending={state.pendingCount} blocks={reduced.blocks.length}
            </div>
            <AssistantRuntimeProvider runtime={runtime}>
                <div style={{ minHeight: 0, flex: '1 1 auto', display: 'flex' }}>
                    <HappyThread
                        api={api}
                        sessionId={SESSION_ID}
                        metadata={session.metadata}
                        disabled={false}
                        onRefresh={() => {}}
                        onFlushPending={() => {
                            if (flushPendingMessages(SESSION_ID)) {
                                void returnToLatest()
                            }
                        }}
                        onAtBottomChange={(atBottom) => setAtBottom(SESSION_ID, atBottom)}
                        isLoadingMessages={state.isLoading}
                        messagesWarning={state.warning}
                        hasMoreMessages={state.hasOlder}
                        hasNewerMessages={state.hasNewer}
                        isLoadingMoreMessages={state.isLoadingOlder}
                        isLoadingNewerMessages={state.isLoadingNewer}
                        onLoadMore={() => fetchOlderMessages(api, SESSION_ID)}
                        onLoadNewer={() => fetchNewerMessages(api, SESSION_ID)}
                        onReturnToLatest={returnToLatest}
                        pendingCount={state.pendingCount}
                        rawMessagesCount={state.messages.length}
                        normalizedMessagesCount={normalized.length}
                        messagesVersion={state.messagesVersion}
                        forceScrollToken={0}
                    />
                </div>
            </AssistantRuntimeProvider>
        </div>
    )
}

window.hapiE2E = {
    snapshot: getSnapshot,
    loadScenario: (scenario) => loadScenario(scenario),
    prepareReconnect,
    disconnectSse,
    reviewAndStream,
    streamAtLiveBottom,
    returnToLatest,
    ready: async () => {
        await initialReady
        await waitForSseConnection()
    },
}

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: false },
    },
})

createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
        <I18nProvider>
            <MessageWindowHarness />
        </I18nProvider>
    </QueryClientProvider>,
)
