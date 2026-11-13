// Isolated preview with fake requests; no hub or runner is involved.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../src/index.css'
import type { ApiClient } from '../src/api/client'
import type { AgentState, SessionSummary } from '../src/types/api'
import type { ToolCallBlock } from '../src/chat/types'
import { I18nProvider } from '../src/lib/i18n-context'
import { ToastProvider } from '../src/lib/toast-context'
import { StatusBar } from '../src/components/AssistantChat/StatusBar'
import { SessionList } from '../src/components/SessionList'
import { ToolCard } from '../src/components/ToolCard/ToolCard'

const createdAt = Date.now() - 10_000
const requests: NonNullable<AgentState['requests']> = {
    question: {
        tool: 'request_user_input',
        createdAt,
        arguments: {
            isBlocking: true,
            questions: [{
                id: 'style',
                question: 'Which implementation approach should I use?',
                options: [
                    { label: 'Keep one focused PR' },
                    { label: 'Split the work into two PRs' },
                ],
            }],
        },
    },
    approval: {
        tool: 'Bash',
        createdAt: createdAt + 1_000,
        arguments: { command: 'git status --short' },
    },
}

const session: SessionSummary = {
    id: 'pending-preview',
    active: true,
    thinking: true,
    activeAt: Date.now(),
    updatedAt: Date.now(),
    metadata: { path: '/work/hapi', name: 'Pending request navigation' },
    metadataVersion: 1,
    agentStateVersion: 1,
    todosUpdatedAt: 0,
    todoProgress: null,
    pendingRequestsCount: 2,
    pendingRequestKinds: ['permission', 'input'],
    pendingRequests: [
        { id: 'question', kind: 'input', tool: 'request_user_input', since: createdAt },
        { id: 'approval', kind: 'permission', tool: 'Bash', since: createdAt + 1_000 },
    ],
    backgroundTaskCount: 0,
    futureScheduledMessageCount: 0,
    nextScheduledAt: null,
    model: 'gpt-5.6',
    effort: null,
    attachedJob: null,
    attachedJobUpdatedAt: 0,
}

function makeBlock(id: keyof typeof requests, label: string): ToolCallBlock {
    const request = requests[id]!
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: request.createdAt ?? createdAt,
        children: [],
        tool: {
            id,
            name: request.tool,
            input: request.arguments,
            state: 'pending',
            createdAt: request.createdAt ?? createdAt,
            startedAt: null,
            completedAt: null,
            execStartedAt: null,
            execCompletedAt: null,
            description: label,
            permission: { id, status: 'pending' },
        },
    }
}

const blocks = [
    makeBlock('question', 'Question awaiting an answer'),
    makeBlock('approval', 'Permission approval'),
]

function Preview() {
    const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null)
    const [lastAction, setLastAction] = useState('Choose a pending request to locate its card.')
    const api = {
        approvePermission: async () => {},
        denyPermission: async () => {},
    } as unknown as ApiClient

    const selectRequest = (requestId: string) => {
        setSelectedRequestId(requestId)
        setLastAction(`Located request: ${requestId}`)
    }

    useEffect(() => {
        if (!selectedRequestId) return
        const timer = window.setTimeout(() => {
            const target = document.querySelector<HTMLElement>(`[data-request-card="${selectedRequestId}"]`)
            if (!target) return
            target.scrollIntoView({ block: 'center' })
            target.focus({ preventScroll: true })
        }, 0)
        return () => window.clearTimeout(timer)
    }, [selectedRequestId])

    return (
        <div className="grid h-dvh grid-cols-[20rem_minmax(0,1fr)] bg-[var(--app-bg)] text-[var(--app-fg)] max-sm:grid-cols-1">
            <aside className="min-h-0 overflow-y-auto border-r border-[var(--app-border)] max-sm:hidden">
                <div className="border-b border-[var(--app-border)] p-4 font-semibold">Sessions</div>
                <SessionList
                    sessions={[session]}
                    selectedSessionId={session.id}
                    onSelect={(_sessionId, _messageId, _query, pendingRequestId) => {
                        if (pendingRequestId) selectRequest(pendingRequestId)
                    }}
                    onNewSession={() => {}}
                    onRefresh={() => {}}
                    isLoading={false}
                    renderHeader={false}
                    api={null}
                />
            </aside>
            <main className="flex min-h-0 flex-col">
                <header className="border-b border-[var(--app-border)] p-4">
                    <div className="font-semibold">Pending request navigation</div>
                    <div id="last-action" className="mt-1 text-xs text-[var(--app-hint)]">{lastAction}</div>
                </header>
                <section className="min-h-0 flex-1 overflow-y-auto p-4">
                    <div className="space-y-3">
                        {Array.from({ length: 10 }, (_, index) => (
                            <p key={index} className="rounded-lg border border-[var(--app-border)] p-3 text-sm text-[var(--app-hint)]">
                                Conversation context {index + 1}
                            </p>
                        ))}
                    </div>
                    <div className="mt-8 space-y-5" aria-label="Pending cards">
                        {blocks.map((block) => (
                            <div
                                key={block.id}
                                data-request-card={block.id}
                                data-selected={selectedRequestId === block.id || undefined}
                                tabIndex={-1}
                                className={`rounded-xl p-1 outline-none ${selectedRequestId === block.id
                                    ? 'ring-2 ring-[#FF9500] bg-[#FF9500]/10'
                                    : ''}`}
                            >
                                <ToolCard
                                    api={api}
                                    sessionId={session.id}
                                    metadata={null}
                                    terminalToolDisplayMode="compact"
                                    block={block}
                                    disabled={false}
                                    onDone={() => {}}
                                />
                            </div>
                        ))}
                    </div>
                </section>
                <div className="border-t border-[var(--app-border)] px-3 pt-2">
                    <StatusBar
                        active
                        thinking
                        agentState={{ requests }}
                        onPendingRequestClick={selectRequest}
                    />
                </div>
            </main>
        </div>
    )
}

createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
            <I18nProvider><Preview /></I18nProvider>
        </ToastProvider>
    </QueryClientProvider>
)