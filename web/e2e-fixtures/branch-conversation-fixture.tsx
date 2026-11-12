import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../src/index.css'
import { ApiClient } from '../src/api/client'
import { BranchConversationDialog } from '../src/components/BranchConversationDialog'
import { I18nProvider } from '../src/lib/i18n-context'

const api = new ApiClient('fixture-token')
const queryClient = new QueryClient()
function Fixture() {
    const [sessionId, setSessionId] = useState<string | null>(null)
    return sessionId ? <output data-testid="child-session">{sessionId}</output> : <BranchConversationDialog
        api={api} machineId="machine" sourceAgent="claude" messageLocalId="user-turn-two"
        onClose={() => {}}
        onSubmit={async options => {
            const result = await api.branchConversation('source', options)
            setSessionId(result.sessionId)
        }}
    />
}
createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}><I18nProvider><Fixture /></I18nProvider></QueryClientProvider>
)
