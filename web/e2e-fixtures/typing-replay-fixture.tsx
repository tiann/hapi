import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import {
    AssistantRuntimeProvider,
    MessagePrimitive,
    ThreadPrimitive,
    useAuiState,
    type ReasoningGroupProps,
    type ReasoningMessagePartProps,
    type TextMessagePartProps
} from '@assistant-ui/react'
import '../src/index.css'
import type { Session } from '../src/types/api'
import { I18nProvider } from '../src/lib/i18n-context'
import { useHappyRuntime } from '../src/lib/assistant-runtime'
import type { VisibleChatBlock } from '../src/chat/toolGroups'
import { NotifySummaryText } from '../src/components/AssistantChat/messages/NotifySummaryText'
import { Reasoning, ReasoningGroup } from '../src/components/assistant-ui/reasoning'

export const EXISTING_ASSISTANT_TEXT = 'This response was generated before the session was opened again.'
export const EXISTING_REASONING_TEXT = 'This reasoning was generated before the session was opened again.'
export const NEW_ASSISTANT_TEXT = 'This is newly generated output and it must still appear with the typewriter animation enabled.'

declare global {
    interface Window {
        __typingReplayProbe?: {
            firstLayoutText: string
            runningLayoutText?: string
            statusTypes?: string[]
            reasoningFirstLayoutText?: string
            reasoningRunningLayoutText?: string
            reasoningStatusTypes?: string[]
            reasoningGroupStatusTypes?: string[]
            newOutputFirstLayoutText?: string
        }
    }
}

const FIXTURE_SESSION = {
    id: 'typing-replay-fixture',
    active: true,
    thinking: true,
    agentState: null,
    metadata: { path: '/tmp/typing-replay-fixture', host: 'fixture' }
} as unknown as Session

const FIXTURE_BLOCKS: readonly VisibleChatBlock[] = [
    {
        kind: 'user-text',
        id: 'user-1',
        localId: 'user-1',
        createdAt: 1_700_000_000_000,
        invokedAt: 1_700_000_000_000,
        text: 'Show the existing response.'
    },
    {
        kind: 'agent-text',
        id: 'assistant-1',
        localId: 'assistant-1',
        createdAt: 1_700_000_000_001,
        invokedAt: 1_700_000_000_001,
        text: EXISTING_ASSISTANT_TEXT
    }
]

const ACTIVE_HYDRATED_BLOCKS: readonly VisibleChatBlock[] = [
    {
        kind: 'user-text',
        id: 'active-user-1',
        localId: 'active-user-1',
        createdAt: 1_700_000_000_100,
        invokedAt: 1_700_000_000_100,
        text: 'Continue the active response.'
    },
    {
        kind: 'agent-text',
        id: 'active-assistant-1',
        localId: 'active-assistant-1',
        createdAt: 1_700_000_000_101,
        invokedAt: 1_700_000_000_101,
        text: EXISTING_ASSISTANT_TEXT
    }
]

const REASONING_BLOCK: VisibleChatBlock = {
    kind: 'agent-reasoning',
    id: 'reasoning-1',
    localId: 'reasoning-1',
    createdAt: 1_700_000_000_001,
    invokedAt: 1_700_000_000_001,
    text: EXISTING_REASONING_TEXT
}

const OLDER_HISTORY_BLOCKS: readonly VisibleChatBlock[] = [
    {
        kind: 'user-text',
        id: 'older-user-1',
        localId: 'older-user-1',
        createdAt: 1_699_999_999_998,
        invokedAt: 1_699_999_999_998,
        text: 'Show an older response.'
    },
    {
        kind: 'agent-text',
        id: 'older-assistant-1',
        localId: 'older-assistant-1',
        createdAt: 1_699_999_999_999,
        invokedAt: 1_699_999_999_999,
        text: 'This response was generated in an older history page.'
    }
]

const HISTORY_WINDOW_BLOCKS: readonly VisibleChatBlock[] = Array.from(
    { length: 800 },
    (_, index): VisibleChatBlock => {
        const timestamp = 1_699_999_000_000 + index
        if (index % 2 === 0) {
            return {
                kind: 'user-text',
                id: `window-user-${index}`,
                localId: `window-user-${index}`,
                createdAt: timestamp,
                invokedAt: timestamp,
                text: `Older history prompt ${index}.`
            }
        }
        return {
            kind: 'agent-text',
            id: `window-assistant-${index}`,
            localId: `window-assistant-${index}`,
            createdAt: timestamp,
            invokedAt: timestamp,
            text: `Older history response ${index}.`
        }
    }
)

function ProbeText(props: TextMessagePartProps) {
    useLayoutEffect(() => {
        const probe = window.__typingReplayProbe ?? { firstLayoutText: '' }
        probe.statusTypes = [...(probe.statusTypes ?? []), props.status.type]
        if (probe.firstLayoutText === '') {
            probe.firstLayoutText = document.querySelector('[data-testid="assistant-text"]')?.textContent ?? ''
        }
        if (props.status.type === 'running') {
            probe.runningLayoutText = document.querySelector('[data-testid="assistant-text"]')?.textContent ?? ''
        }
        if (props.text === NEW_ASSISTANT_TEXT && props.status.type === 'running') {
            const textNodes = document.querySelectorAll('[data-testid="assistant-text"]')
            probe.newOutputFirstLayoutText = textNodes.item(textNodes.length - 1)?.textContent ?? ''
        }
        window.__typingReplayProbe = probe
    }, [props.status.type])

    return (
        <div data-testid="assistant-text">
            <NotifySummaryText {...props} />
        </div>
    )
}

function FixtureUserMessage() {
    return (
        <MessagePrimitive.Root data-testid="user-message">
            <MessagePrimitive.Content />
        </MessagePrimitive.Root>
    )
}

function ProbeReasoning(props: ReasoningMessagePartProps) {
    useLayoutEffect(() => {
        const probe = window.__typingReplayProbe ?? { firstLayoutText: '' }
        probe.reasoningStatusTypes = [...(probe.reasoningStatusTypes ?? []), props.status.type]
        if (probe.reasoningFirstLayoutText === undefined) {
            probe.reasoningFirstLayoutText = document.querySelector('[data-testid="reasoning-text"]')?.textContent ?? ''
        }
        if (props.status.type === 'running') {
            probe.reasoningRunningLayoutText = document.querySelector('[data-testid="reasoning-text"]')?.textContent ?? ''
        }
        window.__typingReplayProbe = probe
    }, [props.status.type])

    return (
        <div data-testid="reasoning-text">
            <Reasoning {...props} />
        </div>
    )
}

function ProbeReasoningGroup(props: ReasoningGroupProps) {
    const statusType = useAuiState((state) => {
        const part = state.message.parts
            .slice(props.startIndex, props.endIndex + 1)
            .findLast((candidate) => candidate.type === 'reasoning')
        return part?.type === 'reasoning' ? part.status.type : state.message.status.type
    })
    useLayoutEffect(() => {
        const probe = window.__typingReplayProbe ?? { firstLayoutText: '' }
        probe.reasoningGroupStatusTypes = [...(probe.reasoningGroupStatusTypes ?? []), statusType]
        window.__typingReplayProbe = probe
    }, [statusType])

    return <ReasoningGroup {...props} />
}

function FixtureAssistantMessage() {
    return (
        <MessagePrimitive.Root data-testid="assistant-message">
            <MessagePrimitive.Content components={{ Text: ProbeText, Reasoning: ProbeReasoning, ReasoningGroup: ProbeReasoningGroup }} />
        </MessagePrimitive.Root>
    )
}

function FixtureThread() {
    const params = new URLSearchParams(window.location.search)
    const includeReasoning = params.has('reasoning')
    const hasActiveTurn = params.has('active-turn')
    const hydrateBlocks = params.has('hydrate')
    const hydrateAfterStart = params.has('hydrate-after-start')
    const streamNewOutput = params.has('stream-new')
    const emptyThread = params.has('empty-thread')
    const hydrateActiveOutput = params.has('hydrate-active-output')
    const userOnlyThread = params.has('user-only')
    const [sessionId, setSessionId] = useState('typing-replay-fixture')
    const blocks = useMemo(
        () => emptyThread
            ? []
            : hydrateActiveOutput
                ? ACTIVE_HYDRATED_BLOCKS
                : userOnlyThread
                    ? [FIXTURE_BLOCKS[0]!]
                    : includeReasoning ? [FIXTURE_BLOCKS[0]!, REASONING_BLOCK] : FIXTURE_BLOCKS,
        [emptyThread, hydrateActiveOutput, includeReasoning, userOnlyThread]
    )
    const newOutputBlocks = useMemo<readonly VisibleChatBlock[]>(
        () => [
            ...blocks,
            {
                kind: 'user-text',
                id: 'user-2',
                localId: 'user-2',
                createdAt: 1_700_000_000_002,
                invokedAt: 1_700_000_000_002,
                text: 'Generate a new response.'
            },
            {
                kind: 'agent-text',
                id: 'assistant-2',
                localId: 'assistant-2',
                createdAt: hasActiveTurn ? 1_700_000_000_101 : 1_700_000_000_003,
                invokedAt: hasActiveTurn ? 1_700_000_000_101 : 1_700_000_000_003,
                text: NEW_ASSISTANT_TEXT
            }
        ],
        [blocks, hasActiveTurn]
    )
    const [visibleBlocks, setVisibleBlocks] = useState<readonly VisibleChatBlock[]>(
        () => hydrateBlocks || hydrateAfterStart ? [] : blocks
    )
    const [historyVersion, setHistoryVersion] = useState(1)
    const [viewMode, setViewMode] = useState<'tail' | 'history'>(() => (
        params.has('history-window') ? 'history' : 'tail'
    ))
    useEffect(() => {
        if (!hydrateBlocks || hydrateAfterStart) return
        const timer = window.setTimeout(() => setVisibleBlocks(blocks), 50)
        return () => window.clearTimeout(timer)
    }, [blocks, hydrateAfterStart, hydrateBlocks])
    const session = useMemo(
        () => ({
            ...FIXTURE_SESSION,
            id: sessionId,
            activeTurnStartedAt: hasActiveTurn ? 1_700_000_000_100 : null
        } as Session),
        [hasActiveTurn, sessionId]
    )
    const [isRunning, setIsRunning] = useState(() => params.has('running'))
    const runtime = useHappyRuntime({
        session,
        blocks: visibleBlocks,
        messagesVersion: 1,
        historyVersion,
        viewMode,
        isSyncingTail: false,
        isLoadingMore: false,
        isSending: false,
        isRunning,
        onSendMessage: () => {},
        onAbort: async () => {}
    })

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <ThreadPrimitive.Root>
                <ThreadPrimitive.Messages
                    components={{
                        UserMessage: FixtureUserMessage,
                        AssistantMessage: FixtureAssistantMessage
                    }}
                />
                <button
                    type="button"
                    data-testid="start-running"
                    onClick={() => {
                        setIsRunning(true)
                        if (streamNewOutput) {
                            window.setTimeout(() => setVisibleBlocks(newOutputBlocks), 25)
                        }
                        if (hydrateAfterStart) {
                            window.setTimeout(() => setVisibleBlocks(blocks), 50)
                        }
                    }}
                >
                    Start running
                </button>
                {params.has('switch-session') ? (
                    <button
                        type="button"
                        data-testid="switch-session"
                        onClick={() => {
                            setSessionId('typing-replay-running-session')
                            setIsRunning(true)
                        }}
                    >
                        Switch session
                    </button>
                ) : null}
                {params.has('prepend-history') ? (
                    <button
                        type="button"
                        data-testid="prepend-history"
                        onClick={() => setVisibleBlocks((current) => [...OLDER_HISTORY_BLOCKS, ...current])}
                    >
                        Prepend older history
                    </button>
                ) : null}
                {params.has('history-window') ? (
                    <button
                        type="button"
                        data-testid="prepend-history-window"
                        onClick={() => {
                            setVisibleBlocks(HISTORY_WINDOW_BLOCKS)
                            setHistoryVersion((current) => current + 1)
                        }}
                    >
                        Load older history window
                    </button>
                ) : null}
                {params.has('history-after-output') ? (
                    <button
                        type="button"
                        data-testid="history-after-output"
                        onClick={() => setHistoryVersion((current) => current + 1)}
                    >
                        Refresh history
                    </button>
                ) : null}
                {params.has('return-to-tail') ? (
                    <button
                        type="button"
                        data-testid="return-to-tail"
                        onClick={() => {
                            setViewMode('tail')
                            setVisibleBlocks(blocks)
                        }}
                    >
                        Return to tail
                    </button>
                ) : null}
            </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
    )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <I18nProvider>
        <FixtureThread />
    </I18nProvider>
)
