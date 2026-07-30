import { useMemo, useRef } from 'react'
import ReactDOM from 'react-dom/client'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
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

// Drives the real message-window store + chat pipeline + HappyThread against a
// fake paginated message API, so e2e tests can exercise older-history loading
// without a hub. `window.__probe.requests` records every API call for
// assertions (e.g. "exactly one older page per top-approach").

const SESSION_ID = 'history-load-fixture'
const TOTAL_MESSAGES = 1200
const BASE_AT = 1_700_000_000_000

type Probe = {
    requests: { direction: string; beforeSeq: number | null; limit: number | undefined; at: number }[]
}

declare global {
    interface Window {
        __probe: Probe
    }
}

window.__probe = { requests: [] }

const allMessages: DecryptedMessage[] = Array.from({ length: TOTAL_MESSAGES }, (_, index) => {
    const seq = index + 1
    return {
        id: `m-${seq}`,
        seq,
        localId: null,
        content: {
            role: 'user',
            content: { type: 'text', text: `Fixture message ${seq}` }
        },
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
        // Small async delay to mimic latency.
        await new Promise((resolve) => setTimeout(resolve, 50))

        if (direction === 'before') {
            const cursorAt = query.beforeAt ?? Number.POSITIVE_INFINITY
            const cursorSeq = query.beforeSeq ?? Number.POSITIVE_INFINITY
            const older = allMessages.filter((message) => {
                const position = positionOf(message)
                return position.at < cursorAt || (position.at === cursorAt && position.seq < cursorSeq)
            })
            const pageMessages = older.slice(-limit)
            const oldest = pageMessages[0] ?? null
            return {
                messages: pageMessages,
                page: pageFrom(pageMessages, {
                    direction: 'before',
                    limit,
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
        return {
            messages: pageMessages,
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
        unseenCount,
        messagesVersion,
        historyVersion,
        loadMore,
        setViewMode
    } = useMessages(fakeApi, SESSION_ID)

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
                    unseenCount={unseenCount}
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

ReactDOM.createRoot(document.getElementById('root')!).render(
    <I18nProvider>
        <FixtureThread />
    </I18nProvider>
)
