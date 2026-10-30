import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionList } from '../src/components/SessionList'
import { I18nProvider } from '../src/lib/i18n-context'
import { ToastProvider } from '../src/lib/toast-context'
import type { SessionSummary } from '../src/types/api'
import '../src/index.css'

localStorage.setItem('hapi-pin-in-progress-sessions', 'true')
const initialSessions: SessionSummary[] = Array.from({ length: 40 }, (_, index) => ({
    id: `session-${index}`, active: false, thinking: false, activeAt: 0,
    updatedAt: 1000 - index, metadataVersion: 0, agentStateVersion: 0,
    todosUpdatedAt: 0, todoProgress: null, pendingRequestsCount: 0,
    pendingRequestKinds: [], pendingRequests: [], backgroundTaskCount: 0,
    futureScheduledMessageCount: 0, nextScheduledAt: null, model: null, effort: null,
    pinned: !new URLSearchParams(location.search).has('collapsed'),
    metadata: { path: `/project-${index}`, name: `Session ${index}`, flavor: 'codex' },
}))

if (new URLSearchParams(location.search).has('mixed')) {
    initialSessions.push({ ...initialSessions[0], id: 'companion', pinned: false })
}

declare global {
    interface Window {
        updateSession: (id: string, patch: Partial<SessionSummary>) => void
    }
}

function Fixture() {
    const [sessions, setSessions] = useState(initialSessions)
    window.updateSession = (id, patch) => setSessions(previous => previous.map(session =>
        session.id === id ? { ...session, ...patch } : session))
    return <div style={{ width: 360, height: 600, display: 'flex', flexDirection: 'column' }}>
        <SessionList sessions={sessions} onSelect={() => {}} onNewSession={() => {}}
            isLoading={false} renderHeader={false} api={null} />
    </div>
}

createRoot(document.getElementById('root')!).render(
    <React.StrictMode><QueryClientProvider client={new QueryClient()}>
        <ToastProvider><I18nProvider><Fixture /></I18nProvider></ToastProvider>
    </QueryClientProvider></React.StrictMode>,
)
