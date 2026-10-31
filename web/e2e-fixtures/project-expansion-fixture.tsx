import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionList } from '../src/components/SessionList'
import { getProjectGroupCollapseStorageKey } from '../src/hooks/useProjectGroupCollapse'
import { I18nProvider } from '../src/lib/i18n-context'
import { ToastProvider } from '../src/lib/toast-context'
import type { SessionSummary } from '../src/types/api'
import '../src/index.css'

const params = new URLSearchParams(location.search)
const token = `header.${btoa(JSON.stringify({ uid: 1, ns: params.get('namespace') ?? 'default' }))}.signature`
const storageKey = getProjectGroupCollapseStorageKey(params.get('hub') ?? 'https://hub.test', token)
const machineId = params.get('machine') ?? 'machine-a'
const archived: SessionSummary = {
    id: 'archived', active: false, thinking: false, activeAt: 0, updatedAt: 100,
    metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0, todoProgress: null,
    pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [], backgroundTaskCount: 0,
    futureScheduledMessageCount: 0, nextScheduledAt: null, model: null, effort: null,
    metadata: { path: '/work/project', machineId, name: 'Archived task', flavor: 'codex' },
}
const initialSessions = [
    archived,
    { ...archived, id: 'running', active: true, thinking: true,
        metadata: { ...archived.metadata!, name: 'Running task' } },
    { ...archived, id: 'other', metadata: { ...archived.metadata!, path: '/work/other', name: 'Other task' } },
]
localStorage.setItem('hapi-pin-in-progress-sessions', 'true')
const queryClient = new QueryClient()

function Fixture() {
    const [selected, setSelected] = useState<string | null>(null)
    const [mounted, setMounted] = useState(true)
    const [sessions, setSessions] = useState(initialSessions)
    return <>
        <button onClick={() => setMounted(value => !value)}>Toggle list</button>
        <button onClick={() => setSelected('archived')}>Reveal archived</button>
        <button onClick={() => setSelected(null)}>Clear selection</button>
        <button onClick={() => setSessions(value => value.map(s => ({ ...s, updatedAt: s.updatedAt + 1 })))}>Live update</button>
        <button onClick={() => setSessions(value => value.length ? [] : initialSessions)}>Toggle data</button>
        <div style={{ width: 'min(360px, 100%)', height: 600, display: 'flex', flexDirection: 'column' }}>
            {mounted && <SessionList sessions={sessions} selectedSessionId={selected}
                collapseStorageKey={storageKey} onSelect={setSelected} onNewSession={() => {}}
                onRefresh={() => {}} isLoading={false} renderHeader={false} api={null} />}
        </div>
    </>
}

createRoot(document.getElementById('root')!).render(
    <React.StrictMode><QueryClientProvider client={queryClient}>
        <ToastProvider><I18nProvider><Fixture /></I18nProvider></ToastProvider>
    </QueryClientProvider></React.StrictMode>,
)
