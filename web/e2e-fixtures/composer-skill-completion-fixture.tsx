import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { ApiClient } from '../src/api/client'
import { HappyComposer } from '../src/components/AssistantChat/HappyComposer'
import { useSkills } from '../src/hooks/queries/useSkills'
import { useHappyRuntime } from '../src/lib/assistant-runtime'
import { I18nProvider } from '../src/lib/i18n-context'
import type { Session } from '../src/types/api'
import '../src/index.css'

const api = new ApiClient('fixture')
const client = new QueryClient()
const session = { id: 'fixture', active: true, thinking: false } as Session

function Fixture() {
    const runtime = useHappyRuntime({ session, blocks: [], messagesVersion: 0, historyVersion: 0,
        isSending: false, isRunning: false, onSendMessage: () => {}, onAbort: async () => {} })
    const { getSuggestions } = useSkills(api, 'fixture')
    return <AssistantRuntimeProvider runtime={runtime}>
        <main className="mx-auto max-w-3xl pt-80">
            <HappyComposer agentFlavor="codex" active autocompleteSuggestions={getSuggestions} />
        </main>
    </AssistantRuntimeProvider>
}

createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={client}><I18nProvider><Fixture /></I18nProvider></QueryClientProvider>
)
