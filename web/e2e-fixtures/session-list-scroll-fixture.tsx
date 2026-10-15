import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionList } from '../src/components/SessionList'
import { I18nProvider } from '../src/lib/i18n-context'
import { ToastProvider } from '../src/lib/toast-context'
import type { SessionSummary } from '../src/types/api'
import '../src/index.css'

localStorage.setItem('hapi-pin-in-progress-sessions', 'true')

// Opt-in machine scope: only `?machines` splits the sessions across two
// machines, so the specs that predate the machine filter keep their layout.
const fixtureParams = new URLSearchParams(location.search)
const machineIds = fixtureParams.has('machines')
    ? ['alpha', 'beta']
    : null
const machineFilter = fixtureParams.get('machine')
if (machineFilter) {
    localStorage.setItem('hapi-session-list-machine-filter', machineFilter)
} else {
    localStorage.removeItem('hapi-session-list-machine-filter')
}

const initialSessions: SessionSummary[] = Array.from({ length: 40 }, (_, index) => ({
    id: `session-${index}`, active: false, thinking: false, activeAt: 0,
    updatedAt: 1000 - index, metadataVersion: 0, agentStateVersion: 0,
    todosUpdatedAt: 0, todoProgress: null, pendingRequestsCount: 0,
    pendingRequestKinds: [], pendingRequests: [], backgroundTaskCount: 0,
    futureScheduledMessageCount: 0, nextScheduledAt: null, model: null, effort: null,
    pinned: !fixtureParams.has('collapsed'),
    metadata: {
        // `?sharedpaths` makes the two machines share directory names, the case
        // where an off-machine group header could read as a duplicate.
        path: fixtureParams.has('sharedpaths')
            ? `/project-${Math.floor(index / 2)}`
            : `/project-${index}`,
        name: `Session ${index}`, flavor: 'codex',
        ...(machineIds ? { machineId: machineIds[index % machineIds.length] } : {}),
    },
}))

if (fixtureParams.has('mixed')) {
    initialSessions.push({ ...initialSessions[0], id: 'companion', pinned: false })
}

declare global {
    interface Window {
        updateSession: (id: string, patch: Partial<SessionSummary>) => void
        /** Stands in for deep links and programmatic navigation. */
        selectSession: (id: string | null) => void
        /** Stands in for a session arriving after the sessions query refetches. */
        addSession: (id: string) => void
    }
}

const initialSelectedSessionId = fixtureParams.get('selected')

function Fixture() {
    const [sessions, setSessions] = useState(initialSessions)
    const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
        initialSelectedSessionId
    )
    window.updateSession = (id, patch) => setSessions(previous => previous.map(session =>
        session.id === id ? { ...session, ...patch } : session))
    window.selectSession = setSelectedSessionId
    window.addSession = (id) => setSessions(previous => previous.some(s => s.id === id)
        ? previous
        : [...previous, {
            ...initialSessions[0],
            id,
            updatedAt: 0,
            metadata: { ...initialSessions[0].metadata, path: '/project-late', name: id },
        }])
    return <div style={{ width: 360, height: 600, display: 'flex', flexDirection: 'column' }}>
        <SessionList sessions={sessions} selectedSessionId={selectedSessionId}
            onSelect={setSelectedSessionId} onNewSession={() => {}}
            isLoading={false} renderHeader={false} api={null} />
    </div>
}

createRoot(document.getElementById('root')!).render(
    <React.StrictMode><QueryClientProvider client={new QueryClient()}>
        <ToastProvider><I18nProvider><Fixture /></I18nProvider></ToastProvider>
    </QueryClientProvider></React.StrictMode>,
)
