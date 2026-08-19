import { useMemo, useRef } from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
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
import { getMessageWindowState } from '../src/lib/message-window-store'
import { useHappyRuntime } from '../src/lib/assistant-runtime'
import { queryClient } from '../src/lib/query-client'
import { HappyThread } from '../src/components/AssistantChat/HappyThread'
import { StatusBar } from '../src/components/AssistantChat/StatusBar'
import type { ChatBlock } from '../src/chat/types'

// Drives the real message-window store + chat pipeline + HappyThread plus a
// real composer-shell layout (thread + StatusBar in normal flow below it)
// against a fake paginated message API. Lets e2e tests drive the
// jump-to-conversation-start / jump-to-prompt navigation and observe what
// happens to the composer shell and its StatusBar while the smooth scroll
// animation runs (issue #1587).

const SESSION_ID = 'jump-navigation-fixture'
const TURNS = 600 // 600 user + 600 assistant messages + 1 trailing usage event
const BASE_AT = 1_700_000_000_000

type JumpProbe = {
    requests: { direction: string; beforeSeq: number | null }[]
    // rAF-sampled composer shell rects collected while a jump animation runs
    composerSamples: { top: number; left: number; width: number; height: number }[]
    statusSamples: (string | null)[]
    statusText: () => string | null
    composerRect: () => { top: number; left: number; width: number; height: number } | null
    windowState: () => { viewMode: string; messageCount: number; oldestSeq: number | null; newestSeq: number | null; scrollTop: number }
    startSampling: () => void
    stopSampling: () => void
    refetch: () => Promise<void>
    samplingTimer: number | null
}

function messageSeq(message: DecryptedMessage): number {
    return message.seq ?? 0
}

declare global {
    interface Window {
        __jumpProbe: JumpProbe
    }
}

const allMessages: DecryptedMessage[] = []
for (let turn = 1; turn <= TURNS; turn += 1) {
    const base = (turn - 1) * 2
    allMessages.push({
        id: `m-user-${turn}`,
        seq: base + 1,
        localId: null,
        content: {
            role: 'user',
            content: { type: 'text', text: `Fixture user message ${turn}` }
        },
        createdAt: BASE_AT + base + 1,
        invokedAt: BASE_AT + base + 1
    } as DecryptedMessage)
    allMessages.push({
        id: `m-agent-${turn}`,
        seq: base + 2,
        localId: null,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: `Fixture assistant reply ${turn}` }]
                    }
                }
            }
        },
        createdAt: BASE_AT + base + 2,
        invokedAt: BASE_AT + base + 2
    } as DecryptedMessage)
}
// Trailing token-count event carrying the live context stats, exactly like the
// real CLI pipeline emits on the tail (the StatusBar's 45% · 12.3k / 27k).
allMessages.push({
    id: 'm-usage-tail',
    seq: TURNS * 2 + 1,
    localId: null,
    content: {
        role: 'agent',
        content: {
            type: 'codex',
            data: {
                type: 'token_count',
                info: {
                    last: {
                        inputTokens: 3000,
                        outputTokens: 200,
                        cachedInputTokens: 9000,
                        contextTokens: 12300
                    },
                    modelContextWindow: 27000
                }
            }
        }
    },
    createdAt: BASE_AT + TURNS * 2 + 1,
    invokedAt: BASE_AT + TURNS * 2 + 1
} as DecryptedMessage)

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
        window.__jumpProbe.requests.push({ direction, beforeSeq: query.beforeSeq ?? null })
        await new Promise((resolve) => setTimeout(resolve, direction === 'before' ? 80 : 50))

        if (direction === 'after') {
            // A tail refresh queued during navigation lands after the jump;
            // the real API returns only genuinely newer rows, never a reset.
            const cursorAt = query.afterAt ?? Number.NEGATIVE_INFINITY
            const cursorSeq = query.afterSeq ?? Number.NEGATIVE_INFINITY
            const newer = allMessages.filter((message) => {
                const position = positionOf(message)
                return position.at > cursorAt || (position.at === cursorAt && position.seq > cursorSeq)
            })
            const pageMessages = newer.slice(0, limit)
            const newest = pageMessages.at(-1) ?? null
            return {
                messages: pageMessages,
                page: pageFrom(pageMessages, {
                    direction: 'after',
                    limit,
                    hasMore: newer.length > pageMessages.length,
                    nextAfterSeq: newest?.seq ?? null,
                    nextAfterAt: newest ? positionOf(newest).at : null,
                    nextBeforeSeq: null,
                    nextBeforeAt: null,
                    snapshotHeadSeq: null,
                    snapshotHeadAt: null
                })
            }
        }

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

        return {
            messages: allMessages.slice(-limit),
            page: pageFrom(allMessages.slice(-limit), {
                direction: 'latest',
                limit,
                reset: true,
                hasMore: allMessages.length > limit
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

window.__jumpProbe = {
    requests: [],
    composerSamples: [],
    statusSamples: [],
    statusText: () => {
        const trigger = document.querySelector('[aria-label="Context details"]')
        return trigger ? (trigger as HTMLElement).innerText : null
    },
    composerRect: () => {
        const shell = document.querySelector('[data-testid="composer-shell"]')
        if (!shell) return null
        const rect = shell.getBoundingClientRect()
        return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
    },
    windowState: () => {
        const state = getMessageWindowState(SESSION_ID)
        const viewport = document.querySelector('.app-scroll-y')
        const seqs = state.messages.map(messageSeq)
        return {
            viewMode: state.viewMode,
            messageCount: state.messages.length,
            oldestSeq: seqs.length ? Math.min(...seqs) : null,
            newestSeq: seqs.length ? Math.max(...seqs) : null,
            gapPresent: state.messages.some((message) => message.id.startsWith('__transcript-gap__')),
            scrollTop: viewport ? Math.round(viewport.scrollTop) : 0
        }
    },
    startSampling: () => {
        window.__jumpProbe.composerSamples = []
        window.__jumpProbe.statusSamples = []
        // Low-frequency sampling: getBoundingClientRect forces a layout flush,
        // and a per-frame flush starves the render passes on slow runners.
        const sample = () => {
            const rect = window.__jumpProbe.composerRect()
            if (rect) window.__jumpProbe.composerSamples.push(rect)
            window.__jumpProbe.statusSamples.push(window.__jumpProbe.statusText())
            window.__jumpProbe.samplingTimer = window.setTimeout(sample, 200)
        }
        window.__jumpProbe.samplingTimer = window.setTimeout(sample, 200)
    },
    stopSampling: () => {
        if (window.__jumpProbe.samplingTimer !== null) {
            window.clearTimeout(window.__jumpProbe.samplingTimer)
            window.__jumpProbe.samplingTimer = null
        }
    },
    samplingTimer: null
}

function FixtureChat() {
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

    window.__jumpProbe.refetch = refetch

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
                <div className="flex min-h-0 flex-1 flex-col">
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
                {/* Real composer shell classes (non-expanded desktop) + real StatusBar,
                    fed from the same latestUsage reduction the app uses. */}
                <div className="bg-[var(--app-bg)] px-3 pt-2" data-testid="composer-shell">
                    <StatusBar
                        active
                        thinking={false}
                        agentState={null}
                        backgroundTaskCount={0}
                        contextSize={reduced.latestUsage?.contextSize}
                        contextCacheRead={reduced.latestUsage?.cacheRead}
                        contextWindow={reduced.latestUsage?.contextWindow ?? 27000}
                        contextModel={reduced.latestUsage?.model}
                        agentFlavor="codex"
                    />
                    <div className="h-10" />
                </div>
            </div>
        </AssistantRuntimeProvider>
    )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
        <I18nProvider>
            <FixtureChat />
        </I18nProvider>
    </QueryClientProvider>
)
