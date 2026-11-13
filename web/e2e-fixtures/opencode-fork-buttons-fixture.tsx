import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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
import { findLatestCompletedBoundaryId, useHappyRuntime } from '../src/lib/assistant-runtime'
import { resolveAssistantForkPoints } from '../src/lib/assistant-fork-points'
import { HappyThread } from '../src/components/AssistantChat/HappyThread'
import { resolveLatestCompletedBoundaryIdForView } from '../src/components/SessionChat'
import type { ChatBlock, NormalizedMessage } from '../src/chat/types'

// OpenCode-flavor historical fork affordance: 3 completed user turns served
// through the real message-window store + chat pipeline into the real
// HappyThread. Every user message carries a localId that is present in
// metadata.conversationHistoryPoints, so every non-latest user card must
// render the historical Fork button — not just the last message.
const SESSION_ID = 'opencode-fork-buttons-fixture'
const BASE_AT = 1_700_000_000_000
// Enough turns that the thread overflows the 900px e2e viewport, so the
// spec can scroll away from the bottom into `history` view mode.
const TURNS = 12

declare global {
    interface Window {
        __probe: {
            boundaryId: string | null
            viewMode: string
            userCount: number
            forkCountPerUser: number[]
            forkCalls: (string | undefined)[]
        }
    }
}

window.__probe = { boundaryId: null, viewMode: 'tail', userCount: 0, forkCountPerUser: [], forkCalls: [] }

function wireUser(turn: number, seq: number): DecryptedMessage {
    const at = BASE_AT + turn * 10_000
    return {
        id: `u-msg-${turn}`,
        seq,
        localId: `u-local-${turn}`,
        content: {
            role: 'user',
            content: { type: 'text', text: `Fixture user message ${turn}` },
            meta: { sentFrom: 'webapp' },
        },
        createdAt: at,
        invokedAt: at,
    } as unknown as DecryptedMessage
}

function wireAgentReply(turn: number, seq: number): DecryptedMessage {
    const at = BASE_AT + turn * 10_000
    return {
        id: `a-msg-${turn}`,
        seq,
        localId: null,
        content: {
            role: 'agent',
            content: { type: 'codex', data: new URLSearchParams(window.location.search).has('reasoning')
                ? { type: 'reasoning', message: `Fixture reasoning reply ${turn}`, id: `native-${turn}` }
                : { type: 'message', message: `Fixture assistant reply ${turn}`, id: `native-${turn}` } },
            meta: { sentFrom: 'cli' },
        },
        createdAt: at + 1_000,
        invokedAt: at + 1_000,
    } as unknown as DecryptedMessage
}

const allMessages: DecryptedMessage[] = Array.from({ length: TURNS }, (_, index) => index + 1).flatMap((turn) => {
    const seqBase = turn * 2 - 1
    return [wireUser(turn, seqBase), wireAgentReply(turn, seqBase + 1)]
})

const historyPoints = Object.fromEntries(
    Array.from({ length: TURNS }, (_, index) => [`u-local-${index + 1}`, true]),
)
if (new URLSearchParams(window.location.search).has('missingPoint')) {
    delete historyPoints['u-local-4']
}

const fakeApi = {
    getMachines: async () => ({ machines: [] }),
    getHubSettings: async () => ({}),
    getMessages: async (): Promise<MessagesResponse> => {
        await new Promise((resolve) => setTimeout(resolve, 25))
        const newest = allMessages[allMessages.length - 1]!
        return {
            messages: allMessages,
            page: {
                direction: 'latest',
                limit: 200,
                epoch: 1,
                reset: true,
                nextBeforeSeq: allMessages[0]!.seq ?? null,
                nextBeforeAt: null,
                nextAfterSeq: null,
                nextAfterAt: null,
                snapshotHeadSeq: newest.seq ?? null,
                snapshotHeadAt: newest.invokedAt ?? newest.createdAt,
                hasMore: false,
            },
        }
    },
} as unknown as ApiClient

const fakeMetadata = {
    path: '/tmp/fork-fixture',
    host: 'fixture',
    flavor: 'opencode',
    capabilities: {
        conversationHistory: { forkCurrent: true, forkAtMessage: true },
    },
    conversationHistoryPoints: historyPoints,
} as unknown as Session['metadata']

const fakeSession = {
    id: SESSION_ID,
    active: true,
    thinking: false,
    activeTurnStartedAt: null,
    agentState: null,
    metadata: fakeMetadata,
} as unknown as Session

const noop = () => {}
const noopAsync = async () => {}

const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
})

function FixtureThread() {
    const {
        messages,
        warning,
        isSyncingTail,
        isLoadingMore,
        hasMore,
        messagesVersion,
        historyVersion,
        tailRevision,
        viewMode,
        loadMore,
        cancelLoadMore,
        setViewMode,
    } = useMessages(fakeApi, SESSION_ID)

    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())

    const normalizedMessages = useMemo(() => {
        const normalized: NormalizedMessage[] = []
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
        [reduced.blocks],
    )
    blocksByIdRef.current = reconciled.byId
    const visibleBlocks = useMemo(
        () => buildVisibleChatBlocks(reconciled.blocks, { hasMoreMessages: hasMore }),
        [reconciled.blocks, hasMore],
    )

    // Same boundary resolution as SessionChat: computed from the tail window,
    // remembered while reading history so loading older pages cannot move it.
    const currentTailBoundaryId = useMemo(() => {
        if (viewMode !== 'tail') return null
        return findLatestCompletedBoundaryId(
            visibleBlocks,
            fakeSession.thinking,
            fakeSession.activeTurnStartedAt ?? null,
        )
    }, [viewMode, visibleBlocks])
    const [rememberedTailBoundary, setRememberedTailBoundary] = useState<{
        id: string | null
        tailRevision: number
    } | null>(null)
    useEffect(() => {
        if (viewMode !== 'tail') return
        setRememberedTailBoundary((previous) => (
            previous?.id === currentTailBoundaryId && previous.tailRevision === tailRevision
                ? previous
                : { id: currentTailBoundaryId, tailRevision }
        ))
    }, [currentTailBoundaryId, tailRevision, viewMode])
    const latestCompletedBoundaryId = resolveLatestCompletedBoundaryIdForView(
        viewMode,
        currentTailBoundaryId,
        rememberedTailBoundary,
        tailRevision,
    )
    const isLatestCompletedBoundary = useCallback(
        (messageId: string) => latestCompletedBoundaryId === messageId,
        [latestCompletedBoundaryId],
    )
    const assistantForkPoints = useMemo(
        () => resolveAssistantForkPoints(visibleBlocks, historyPoints as Record<string, true>),
        [visibleBlocks]
    )

    const runtime = useHappyRuntime({
        session: fakeSession,
        blocks: visibleBlocks,
        messagesVersion,
        historyVersion,
        viewMode,
        isSending: false,
        onSendMessage: noop,
        onAbort: noopAsync,
    })

    useEffect(() => {
        window.__probe.boundaryId = latestCompletedBoundaryId
        window.__probe.viewMode = viewMode
        window.__probe.userCount = document.querySelectorAll('[data-hapi-message-role="user"]').length
        window.__probe.forkCountPerUser = Array.from(
            document.querySelectorAll('[data-hapi-message-role="user"]'),
        ).map((card) => card.querySelectorAll('[data-testid="message-fork"]').length)
    })

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <div className="flex h-screen min-h-0 flex-col">
                <HappyThread
                    api={fakeApi}
                    session={fakeSession}
                    sessionId={SESSION_ID}
                    metadata={fakeMetadata as never}
                    disabled={false}
                    onRefresh={noop}
                    onForkConversation={async (localId) => { window.__probe.forkCalls.push(localId) }}
                    isLatestCompletedBoundary={isLatestCompletedBoundary}
                    assistantForkPoints={assistantForkPoints}
                    onViewModeChange={setViewMode}
                    isSyncingTail={isSyncingTail}
                    messagesWarning={warning}
                    hasMoreMessages={hasMore}
                    isLoadingMoreMessages={isLoadingMore}
                    onLoadMore={loadMore}
                    onCancelLoadMore={cancelLoadMore}
                    unseenCount={0}
                    rawMessagesCount={messages.length}
                    normalizedMessagesCount={normalizedMessages.length}
                    messagesVersion={messagesVersion}
                    historyVersion={historyVersion}
                    forceScrollToken={0}
                    outlineOpen={false}
                    outlineItems={[]}
                    onOutlineOpenChange={noop}
                />
            </div>
        </AssistantRuntimeProvider>
    )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
        <I18nProvider>
            <FixtureThread />
        </I18nProvider>
    </QueryClientProvider>,
)
