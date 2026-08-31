import { useMemo, useRef } from 'react'
import ReactDOM from 'react-dom/client'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../src/index.css'
import type { ApiClient } from '../src/api/client'
import type { DecryptedMessage, MessagesResponse, Session } from '../src/types/api'
import { I18nProvider } from '../src/lib/i18n-context'
import { useMessages } from '../src/hooks/queries/useMessages'
import { normalizeDecryptedMessage } from '../src/chat/normalize'
import { reduceChatBlocks } from '../src/chat/reducer'
import { reconcileChatBlocks } from '../src/chat/reconcile'
import { buildVisibleChatBlocks } from '../src/chat/toolGroups'
import { isQueuedForInvocation } from '../src/lib/messages'
import { useHappyRuntime } from '../src/lib/assistant-runtime'
import { HappyThread } from '../src/components/AssistantChat/HappyThread'
import type { ChatBlock } from '../src/chat/types'
import { getMessageWindowState } from '../src/lib/message-window-store'

// Drives the real message-window store + chat pipeline + HappyThread against a
// fake paginated message API, so e2e tests can exercise older-history loading
// without a hub. `window.__probe.requests` records every API call for
// assertions (e.g. "exactly one older page per top-approach").

const SESSION_ID = 'history-load-fixture'
const TOTAL_MESSAGES = 1200
const BASE_AT = 1_700_000_000_000

type Probe = {
    requests: { direction: string; beforeSeq: number | null; limit: number | undefined; at: number }[]
    refetch: () => Promise<void>
    windowState: () => { messageCount: number; oldestSeq: number | null; newestSeq: number | null }
}

declare global {
    interface Window {
        __probe: Probe
    }
}

window.__probe = {
    requests: [],
    refetch: async () => {},
    windowState: () => {
        const state = getMessageWindowState(SESSION_ID)
        return {
            messageCount: state.messages.length,
            oldestSeq: state.oldestSeq,
            newestSeq: state.newestSeq
        }
    }
}

// Test knobs via query params:
// - ?shortPages=1  — `before` pages return 2 messages regardless of limit, so
//   one page is shorter than the preload margin and cannot push the top
//   sentinel out of the observed box (no intersection transition).
// - ?failBefore=N  — the first N `before` requests reject, mimicking a
//   transient network failure while the sentinel stays covered.
// - ?filteredOlder=1 — every row older than the initial tail page is an
//   agent meta row that normalizeDecryptedMessage filters out, so a loaded
//   page renders zero height and the sentinel cannot move.
// - ?epochBump=1 — `before` responses carry a newer epoch than the tail, so
//   every older-page request hits the store's deliberate epoch-mismatch stop
//   (reset + tail resync, typed terminal stop).
// - ?slowBefore=1 — delay older-page responses long enough for a normal tail
//   synchronization to invalidate an in-flight request.
const fixtureParams = new URLSearchParams(window.location.search)
const shortPages = fixtureParams.has('shortPages')
const failBeforeCount = Number(fixtureParams.get('failBefore') ?? '0')
const filteredOlder = fixtureParams.has('filteredOlder')
const epochBump = fixtureParams.has('epochBump')
const slowBefore = fixtureParams.has('slowBefore')
let beforeAttempts = 0

const allMessages: DecryptedMessage[] = Array.from({ length: TOTAL_MESSAGES }, (_, index) => {
    const seq = index + 1
    const filtered = filteredOlder && seq <= TOTAL_MESSAGES - 200
    return {
        id: `m-${seq}`,
        seq,
        localId: null,
        content: filtered
            ? { role: 'agent', content: { type: 'output', data: { isMeta: true } } }
            : { role: 'user', content: { type: 'text', text: `Fixture message ${seq}` } },
        createdAt: BASE_AT + seq,
        invokedAt: BASE_AT + seq
    } as DecryptedMessage
})

function positionOf(message: DecryptedMessage): { at: number; seq: number } {
    return { at: message.invokedAt ?? message.createdAt, seq: message.seq ?? 0 }
}

function pageFrom(messages: DecryptedMessage[], overrides: Partial<MessagesResponse['page']>): MessagesResponse['page'] {
    const oldest = messages[0] ?? null
    const newest = messages[messages.length - 1] ?? null
    return {
        direction: 'latest',
        limit: 200,
        epoch: 1,
        reset: false,
        nextBeforeSeq: oldest?.seq ?? null,
        nextBeforeAt: oldest ? positionOf(oldest).at : null,
        nextAfterSeq: newest?.seq ?? null,
        nextAfterAt: newest ? positionOf(newest).at : null,
        snapshotHeadSeq: newest?.seq ?? null,
        snapshotHeadAt: newest ? positionOf(newest).at : null,
        hasMore: false,
        ...overrides
    }
}

const fakeApi = {
    getMessages: async (_sessionId: string, query: {
        limit?: number
        beforeAt?: number | null
        beforeSeq?: number | null
        afterAt?: number | null
        afterSeq?: number | null
    }): Promise<MessagesResponse> => {
        const limit = query.limit ?? 200
        let direction = 'latest'
        if (query.beforeSeq != null || query.beforeAt != null) direction = 'before'
        else if (query.afterSeq != null || query.afterAt != null) direction = 'after'
        window.__probe.requests.push({
            direction,
            beforeSeq: query.beforeSeq ?? null,
            limit: query.limit,
            at: Date.now()
        })
        // Small async delay to mimic latency. Some tests deliberately keep an
        // older request in flight while a normal tail synchronization runs.
        await new Promise((resolve) => setTimeout(
            resolve,
            direction === 'before' && slowBefore ? 500 : 50
        ))

        if (direction === 'before') {
            beforeAttempts += 1
            if (beforeAttempts <= failBeforeCount) {
                throw new Error('fixture: forced before-page failure')
            }
            const cursorAt = query.beforeAt ?? Number.POSITIVE_INFINITY
            const cursorSeq = query.beforeSeq ?? Number.POSITIVE_INFINITY
            const older = allMessages.filter((message) => {
                const position = positionOf(message)
                return position.at < cursorAt || (position.at === cursorAt && position.seq < cursorSeq)
            })
            const pageMessages = shortPages ? older.slice(-2) : older.slice(-limit)
            const oldest = pageMessages[0] ?? null
            return {
                messages: pageMessages,
                page: pageFrom(pageMessages, {
                    direction: 'before',
                    limit,
                    epoch: epochBump ? 2 : 1,
                    hasMore: older.length > pageMessages.length,
                    nextBeforeSeq: oldest?.seq ?? null,
                    nextBeforeAt: oldest ? positionOf(oldest).at : null,
                    nextAfterSeq: null,
                    nextAfterAt: null,
                    snapshotHeadSeq: null,
                    snapshotHeadAt: null
                })
            }
        }

        const pageMessages = allMessages.slice(-limit)
        // After an epoch bump the "rewritten" tail renders taller rows, so
        // the reset changes content height — this is what re-fires the
        // ResizeObserver coverage re-check in the epoch-reset scenario.
        const rewritten = epochBump && beforeAttempts > 0
        return {
            messages: rewritten
                ? pageMessages.map((message) => ({
                    ...message,
                    content: {
                        role: 'user',
                        content: { type: 'text', text: `Fixture message ${message.seq} ${'x'.repeat(400)}` }
                    }
                }) as DecryptedMessage)
                : pageMessages,
            page: pageFrom(pageMessages, {
                direction: 'latest',
                limit,
                reset: true,
                hasMore: allMessages.length > pageMessages.length
            })
        }
    }
} as unknown as ApiClient

const fakeSession = {
    id: SESSION_ID,
    active: true,
    thinking: false,
    agentState: null,
    metadata: { path: '/tmp/fixture', host: 'fixture' }
} as unknown as Session

const noopSend = () => {}
const noopAbort = async () => {}

function FixtureThread() {
    const {
        messages,
        warning,
        isSyncingTail,
        isLoadingMore,
        hasMore,
        messagesVersion,
        historyVersion,
        loadMore,
        cancelLoadMore,
        refetch,
        setViewMode
    } = useMessages(fakeApi, SESSION_ID)

    window.__probe.refetch = refetch

    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())

    const normalizedMessages = useMemo(() => {
        const normalized = []
        for (const message of messages) {
            if (isQueuedForInvocation(message)) continue
            const next = normalizeDecryptedMessage(message)
            if (next) normalized.push(next)
        }
        return normalized
    }, [messages])

    const reduced = useMemo(() => reduceChatBlocks(normalizedMessages, null, {}), [normalizedMessages])
    const reconciled = useMemo(
        () => reconcileChatBlocks(reduced.blocks, blocksByIdRef.current),
        [reduced.blocks]
    )
    blocksByIdRef.current = reconciled.byId
    const visibleBlocks = useMemo(
        () => buildVisibleChatBlocks(reconciled.blocks, { hasMoreMessages: hasMore }),
        [reconciled.blocks, hasMore]
    )

    const runtime = useHappyRuntime({
        session: fakeSession,
        blocks: visibleBlocks,
        messagesVersion,
        historyVersion,
        isSending: false,
        onSendMessage: noopSend,
        onAbort: noopAbort
    })

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <div className="flex h-screen min-h-0 flex-col">
                <HappyThread
                    api={fakeApi}
                    session={fakeSession}
                    sessionId={SESSION_ID}
                    metadata={null}
                    disabled={false}
                    onRefresh={() => {}}
                    onViewModeChange={setViewMode}
                    isSyncingTail={isSyncingTail}
                    messagesWarning={warning}
                    hasMoreMessages={hasMore}
                    isLoadingMoreMessages={isLoadingMore}
                    onLoadMore={loadMore}
                    onCancelLoadMore={cancelLoadMore}
                    // This fixture drives HappyThread directly, bypassing the
                    // SessionChat block reduction that computes the real count.
                    unseenCount={0}
                    rawMessagesCount={messages.length}
                    normalizedMessagesCount={normalizedMessages.length}
                    messagesVersion={messagesVersion}
                    historyVersion={historyVersion}
                    forceScrollToken={0}
                    outlineOpen={false}
                    outlineItems={[]}
                    onOutlineOpenChange={() => {}}
                />
            </div>
        </AssistantRuntimeProvider>
    )
}

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: false }
    }
})

ReactDOM.createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
        <I18nProvider>
            <FixtureThread />
        </I18nProvider>
    </QueryClientProvider>
)
