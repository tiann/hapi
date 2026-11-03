import { StrictMode, useState } from 'react'
import ReactDOM from 'react-dom/client'
import {
    AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive,
    type TextMessagePartProps
} from '@assistant-ui/react'
import '../src/index.css'
import type { ApiClient } from '../src/api/client'
import type { Session } from '../src/types/api'
import type { VisibleChatBlock } from '../src/chat/toolGroups'
import { I18nProvider } from '../src/lib/i18n-context'
import { useHappyRuntime } from '../src/lib/assistant-runtime'
import { HappyChatProvider, type HappyChatContextValue } from '../src/components/AssistantChat/context'
import { NotifySummaryText } from '../src/components/AssistantChat/messages/NotifySummaryText'

const FOOTER = 'AGENT_NOTIFY_SUMMARY {"version":1,"status":"done","summary":"Inspection complete","action":"Review the result"}'
const RESPONSE = `The test result has been inspected.\n\n${FOOTER}`
const INITIAL: readonly VisibleChatBlock[] = [
    { kind: 'user-text', id: 'u1', localId: 'u1', createdAt: 1000, invokedAt: 1000, text: 'Inspect the test result.' },
    { kind: 'agent-text', id: 'a1', localId: 'a1', createdAt: 1001, invokedAt: 1001, text: RESPONSE }
]

function TextPart(props: TextMessagePartProps) {
    return (
        <div data-testid="summary-text" data-part-status={props.status.type}>
            <NotifySummaryText {...props} />
        </div>
    )
}

function AssistantMessage() {
    return <MessagePrimitive.Root data-testid="assistant-message" className="my-4 happy-chat-text">
        <MessagePrimitive.Content components={{ Text: TextPart }} />
    </MessagePrimitive.Root>
}

function UserMessage() {
    return <MessagePrimitive.Root className="my-4 rounded-lg bg-[var(--app-subtle-bg)] p-3">
        <MessagePrimitive.Content />
    </MessagePrimitive.Root>
}

function Fixture() {
    const [blocks, setBlocks] = useState(INITIAL)
    const [running, setRunning] = useState(false)
    const [pending, setPending] = useState('')
    const [showSummary, setShowSummary] = useState(true)
    const session = {
        id: 'notify-summary-fixture', active: true, thinking: running,
        // Deliberately retain the previous turn boundary while sending.
        activeTurnStartedAt: 1000, agentState: null,
        metadata: { path: '/fixture', host: 'fixture' }
    } as Session
    const runtime = useHappyRuntime({
        session, blocks, messagesVersion: 1, historyVersion: 1,
        isRunning: running, isSending: false,
        onSendMessage: (text) => { setPending(text); setRunning(true) },
        onAbort: async () => { setRunning(false) }
    })
    const context: HappyChatContextValue = {
        api: {} as ApiClient, sessionId: session.id, metadata: null,
        terminalToolDisplayMode: 'detailed', showSessionSummaryInChat: showSummary,
        disabled: false, onRefresh: () => {}, hasMoreMessages: false,
        isSyncingTail: false, isLoadingMoreMessages: false,
        loadOlderMessagesPreservingScroll: async () => 'terminal-stop'
    }
    const accept = () => setBlocks([
        ...INITIAL,
        { kind: 'user-text', id: 'u2', localId: 'u2', createdAt: 2000, invokedAt: 2000, text: pending }
    ])
    const stream = () => setBlocks([
        ...INITIAL,
        { kind: 'user-text', id: 'u2', localId: 'u2', createdAt: 2000, invokedAt: 2000, text: pending },
        { kind: 'agent-text', id: 'a2', localId: 'a2', createdAt: 2001, invokedAt: 2001,
            text: `New response.\n\n${FOOTER}` }
    ])
    return <HappyChatProvider value={context}><AssistantRuntimeProvider runtime={runtime}>
        <main className="mx-auto max-w-3xl p-5">
            <p className="mb-6 text-xs text-[var(--app-hint)]">Real HAPI runtime and rendering components; synthetic conversation data.</p>
            <ThreadPrimitive.Root>
                <ThreadPrimitive.Messages components={{ AssistantMessage, UserMessage }} />
            </ThreadPrimitive.Root>
            <ComposerPrimitive.Root className="mt-8 flex gap-3">
                <ComposerPrimitive.Input aria-label="Message" className="min-w-0 flex-1 rounded border p-2" />
                <ComposerPrimitive.Send className="rounded border p-2">Send</ComposerPrimitive.Send>
            </ComposerPrimitive.Root>
            <div className="mt-4 flex flex-wrap gap-4 text-sm">
                <button onClick={accept}>Accept queued message</button>
                <button onClick={stream}>Stream new response</button>
                <button onClick={() => setRunning(false)}>Complete response</button>
                <button onClick={() => { setRunning(true); setBlocks(INITIAL.map(block => block.kind === 'agent-text'
                    ? { ...block, text: `${RESPONSE}\nMore output.` } : block)) }}>Continue existing text</button>
                <label><input type="checkbox" checked={showSummary} onChange={event => setShowSummary(event.target.checked)} /> Show summaries</label>
            </div>
        </main>
    </AssistantRuntimeProvider></HappyChatProvider>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<StrictMode><I18nProvider><Fixture /></I18nProvider></StrictMode>)
