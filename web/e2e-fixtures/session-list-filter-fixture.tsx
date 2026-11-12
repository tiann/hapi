import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiClient } from '../src/api/client'
import { SessionList } from '../src/components/SessionList'
import { I18nProvider } from '../src/lib/i18n-context'
import { ToastProvider } from '../src/lib/toast-context'
import type { SessionSummary } from '../src/types/api'
import '../src/index.css'

const lang = new URLSearchParams(location.search).get('lang')
if (lang) localStorage.setItem('hapi-lang', lang)
const sessions = [
    ['match', 'HAPI filter integration', 'mint', true, true, 9],
    ['read', 'Reviewed draft', 'mint', true, false, 9],
    ['no-draft', 'Unread without draft', 'mint', true, true, 9],
    ['archived', 'Archived draft', 'mint', false, true, 9],
    ['other-machine', 'Server draft', 'server', true, true, 9],
    ['old', 'Older draft', 'mint', true, true, 1],
].map(([id, name, machineId, active, unread, day]) => ({
    id, active, thinking: false, activeAt: 0,
    createdAt: new Date(2026, 10, Number(day), 9).getTime(),
    updatedAt: new Date(2026, 10, Number(day), 12).getTime(),
    lastUserMessageAt: new Date(2026, 10, Number(day), 12).getTime(),
    contentRevision: 1,
    readState: { readRevision: unread ? 0 : 1, version: 0, manualUnread: false },
    metadata: { path: '/work/hapi', name, machineId, flavor: 'codex', agentSessionId: id },
    metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0, todoProgress: null,
    pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [], backgroundTaskCount: 0,
    futureScheduledMessageCount: 0, nextScheduledAt: null, model: null, effort: null,
})) as SessionSummary[]
const api = {
    getScratchlistSessionIds: async () => sessions.filter(s => s.id !== 'no-draft').map(s => s.id),
} as unknown as ApiClient
function Fixture() {
    const [selected, setSelected] = useState<string | null>(null)
    return <main style={{ width: 'min(440px, 100vw)', height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <SessionList sessions={sessions} selectedSessionId={selected} onSelect={setSelected}
            onNewSession={() => {}} onRefresh={() => {}} isLoading={false} api={api}
            machineLabelsById={{ mint: 'Mint', server: 'Server' }}
            headerActions={<button type="button" aria-label="Settings">⚙</button>} />
    </main>
}
createRoot(document.getElementById('root')!).render(
    <React.StrictMode><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider><I18nProvider><Fixture /></I18nProvider></ToastProvider>
    </QueryClientProvider></React.StrictMode>,
)
