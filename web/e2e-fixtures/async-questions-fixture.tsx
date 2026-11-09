// Isolated manual preview; all requests are fake and no hub is contacted.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import { AsyncQuestionsPanel } from '../src/components/AssistantChat/AsyncQuestionsPanel'
import { ToolCard } from '../src/components/ToolCard/ToolCard'
import type { ApiClient } from '../src/api/client'
import type { AgentState } from '../src/types/api'
import type { ToolCallBlock } from '../src/chat/types'

function Preview() {
    const [requests, setRequests] = useState<AgentState['requests']>({
        style: { tool: 'request_user_input', createdAt: Date.now() - 2_000, arguments: { isBlocking: false, questions: [{
            id: 'style', question: 'Which visual style do you prefer?', isOther: true,
            options: [{ label: 'Warm and natural' }, { label: 'Cool and minimal' }]
        }] } },
        details: { tool: 'request_user_input', createdAt: Date.now() - 1_000, arguments: { isBlocking: false, questions: [{
            id: 'details', question: 'Any other details you would like to add?', options: []
        }] } }
    })
    const [completed, setCompleted] = useState<AgentState['completedRequests']>({})
    const [lastAction, setLastAction] = useState('The agent is still working while these optional questions wait.')
    const complete = (id: string, status: 'resolved' | 'canceled') => {
        const request = requests?.[id]
        if (!request) return
        setCompleted((current) => ({ ...current, [id]: { ...request, status, completedAt: Date.now() } }))
        setRequests((current) => Object.fromEntries(Object.entries(current ?? {}).filter(([key]) => key !== id)))
        setLastAction(`${status}: ${id}`)
    }
    const api = {
        approvePermission: async (_session: string, id: string) => complete(id, 'resolved'),
        denyPermission: async (_session: string, id: string) => complete(id, 'canceled')
    } as unknown as ApiClient
    const blocks: ToolCallBlock[] = Object.entries({ ...completed, ...requests })
        .sort(([, a], [, b]) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
        .map(([id, request]) => ({
            kind: 'tool-call', id, localId: null, createdAt: request.createdAt ?? 0, children: [],
            tool: {
                id, name: request.tool, input: request.arguments, state: requests?.[id] ? 'pending' : 'completed',
                createdAt: request.createdAt ?? 0, startedAt: null, completedAt: completed?.[id]?.completedAt ?? null,
                execStartedAt: null, execCompletedAt: null, description: null,
                permission: { id, status: completed?.[id]?.status ?? 'pending' }
            }
        }))
    return <div className="flex h-dvh flex-col bg-[var(--app-bg)] text-[var(--app-fg)]">
        <header className="border-b border-[var(--app-border)] p-4 font-semibold">HAPI · Optional questions preview</header>
        <main className="mx-auto w-full max-w-content min-h-0 flex-1 overflow-y-auto p-4">
            <p className="rounded-xl bg-[var(--app-subtle-bg)] p-3">Please prepare the project. You can keep working while I choose the details.</p>
            <p className="mt-6">I have started the work. Your outstanding questions are available above the message box, even after a long conversation.</p>
            <p className="mt-6 text-sm text-[var(--app-hint)]">{lastAction}</p>
            <div className="mt-6 space-y-3" aria-label="Transcript questions">
                {blocks.map((block) => <ToolCard key={block.id} api={api} sessionId="preview" metadata={null} terminalToolDisplayMode="compact" block={block} disabled={false} onDone={() => {}} />)}
            </div>
        </main>
        <div className="px-3"><AsyncQuestionsPanel api={api} sessionId="preview" requests={requests} disabled={false} onRefresh={() => {}} /></div>
        <div className="mx-auto mb-4 w-full max-w-content px-3"><textarea aria-label="Message" placeholder="Send a message…" className="w-full rounded-xl border border-[var(--app-border)] p-3" /></div>
    </div>
}
createRoot(document.getElementById('root')!).render(<I18nProvider><Preview /></I18nProvider>)
