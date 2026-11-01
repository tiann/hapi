import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionSchema } from '@hapi/protocol/schemas'
import { toSessionSummary } from '@hapi/protocol'
import { SessionList } from '../src/components/SessionList'
import { HappyComposer } from '../src/components/AssistantChat/HappyComposer'
import { DragDropZone } from '../src/components/AssistantChat/DragDropZone'
import { useHappyRuntime } from '../src/lib/assistant-runtime'
import { I18nProvider } from '../src/lib/i18n-context'
import { ToastProvider } from '../src/lib/toast-context'
import '../src/index.css'

localStorage.setItem('hapi.fue.v1.rich-composer-mentions', '1')

const current = SessionSchema.parse({
    id: 'current-session', namespace: 'fixture', seq: 1,
    createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
    thinking: false, thinkingAt: 0, agentState: null,
    agentStateVersion: 0, metadataVersion: 0, hasConversationContent: true,
    metadata: { path: '/project', host: 'fixture', name: 'Current session', flavor: 'codex' },
})
const sessions = [
    current,
    { ...current, id: 'peer-session', metadata: { ...current.metadata!, name: 'Peer session' } },
    { ...current, id: 'untitled-session', metadata: { ...current.metadata!, name: undefined, path: '/untitled-project' } },
    { ...current, id: 'empty-session', hasConversationContent: false, metadata: { ...current.metadata!, name: 'Named empty' } },
].map(toSessionSummary)
const disabled = new URLSearchParams(location.search).has('disabled')

function Fixture() {
    const [selected, setSelected] = useState(current.id)
    const [sent, setSent] = useState('')
    const runtime = useHappyRuntime({
        session: current, blocks: [], messagesVersion: 0, historyVersion: 0,
        isSending: false, onSendMessage: setSent, onAbort: async () => {},
    })
    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <div style={{ display: 'flex', height: 600, gap: 24, padding: 24 }}>
                <aside style={{ width: 320, display: 'flex', flexDirection: 'column' }}>
                    <SessionList sessions={sessions} selectedSessionId={selected}
                        onSelect={setSelected} onNewSession={() => {}}
                        isLoading={false} renderHeader={false} api={null} />
                </aside>
                <main style={{ width: 600 }}>
                    <output data-testid="selected-session">{selected}</output>
                    <DragDropZone disabled={disabled}>
                        <HappyComposer sessionId={current.id} disabled={disabled} agentFlavor="codex" />
                    </DragDropZone>
                    <output data-testid="sent-message">{sent}</output>
                </main>
            </div>
        </AssistantRuntimeProvider>
    )
}

createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={new QueryClient()}>
        <ToastProvider><I18nProvider><Fixture /></I18nProvider></ToastProvider>
    </QueryClientProvider>,
)
