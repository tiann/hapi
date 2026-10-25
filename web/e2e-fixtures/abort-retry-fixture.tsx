import { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../src/index.css'
import { ApiClient } from '../src/api/client'
import type { Session } from '../src/types/api'
import { I18nProvider } from '../src/lib/i18n-context'
import { useHappyRuntime } from '../src/lib/assistant-runtime'
import { useSessionActions } from '../src/hooks/mutations/useSessionActions'
import { HappyComposer } from '../src/components/AssistantChat/HappyComposer'

// Real composer, assistant-ui runtime, mutation hook, and HTTP client. Only
// this synthetic session's abort endpoint is intercepted by the browser test.
const api = new ApiClient('abort-retry-fixture')
const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })

function Harness() {
    const [running, setRunning] = useState(true)
    const session = { id: 'abort-retry-fixture', active: true, thinking: running } as Session
    const { abortSession, abortError, clearAbortError } = useSessionActions(api, session.id, 'codex')
    const runtime = useHappyRuntime({
        session,
        blocks: [],
        messagesVersion: 0,
        historyVersion: 0,
        isSending: false,
        isRunning: running,
        onSendMessage: () => {},
        onAbort: async () => {
            try {
                await abortSession()
            } catch {
                // Same error ownership as SessionChat: mutation -> composer.
            }
        },
    })
    return (
        <main style={{ maxWidth: 680, margin: '24px auto', padding: 12 }}>
            <p>Keep the agent running while the stop request fails.</p>
            <button onClick={() => setRunning(false)}>Receive turn completion</button>
            <button onClick={() => setRunning(true)}>Receive next turn</button>
            <AssistantRuntimeProvider runtime={runtime}>
                <HappyComposer
                    sessionId={session.id}
                    active
                    thinking={running}
                    abortError={abortError}
                    onClearAbortError={clearAbortError}
                    agentFlavor="codex"
                />
            </AssistantRuntimeProvider>
        </main>
    )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
        <I18nProvider><Harness /></I18nProvider>
    </QueryClientProvider>,
)
