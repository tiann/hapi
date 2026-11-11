import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionList } from '../src/components/SessionList'
import { I18nProvider } from '../src/lib/i18n-context'
import { ToastProvider } from '../src/lib/toast-context'
import { markSessionSeen, markSessionUnread } from '../src/lib/sessionLastSeen'
import type { SessionSummary } from '../src/types/api'
import '../src/index.css'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') ?? 'dark'
localStorage.setItem('hapi-pin-in-progress-sessions', params.has('pinned') ? 'true' : 'false')
const makeSession = (id: string, name: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
    id, active: true, thinking: false, activeAt: Date.now(), updatedAt: Date.now(),
    contentRevision: 0, readState: { readRevision: 0, version: 0, manualUnread: false },
    metadata: { path: '/workspace/hapi', name, flavor: 'codex' },
    pinned: true, metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0,
    todoProgress: null, pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [],
    backgroundTaskCount: 0, futureScheduledMessageCount: 0, nextScheduledAt: null,
    attachedJob: null, attachedJobUpdatedAt: 0, model: null, effort: null, ...patch,
})

const initialSessions = [
    makeSession('running-read', 'Working · all output read', { thinking: true }),
    makeSession('running-unread', 'Working · unread output', { thinking: true, contentRevision: 2 }),
    makeSession('finished-unread', 'Finished · unread output', { contentRevision: 2 }),
    makeSession('finished-read', 'Finished · all output read'),
    makeSession('permission', 'Waiting for permission', {
        thinking: true, contentRevision: 2, pendingRequestsCount: 1, pendingRequestKinds: ['permission'],
        pendingRequests: [{ id: 'permission-request', kind: 'permission', tool: 'Bash', since: Date.now() }],
    }),
    makeSession('background', 'Background work · unread output', { backgroundTaskCount: 1, contentRevision: 2 }),
]

function Fixture() {
    const [sessions, setSessions] = useState(initialSessions)
    window.activityFixture = {
        patch: (id, patch) => setSessions(previous => previous.map(s => s.id === id ? { ...s, ...patch } : s)),
        read: id => markSessionSeen(id, sessions.find(s => s.id === id)!.contentRevision ?? 0),
        unread: id => markSessionUnread(id),
    }
    return <main style={{ maxWidth: 460, margin: '24px auto', padding: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Session activity and unread status</h1>
        <p style={{ color: 'var(--app-hint)', fontSize: 13, marginBottom: 20 }}>Live SessionList component · fixture data</p>
        <SessionList sessions={sessions} onSelect={() => {}} onNewSession={() => {}}
            isLoading={false} renderHeader={false} api={null} />
    </main>
}

declare global {
    interface Window {
        activityFixture: {
            patch: (id: string, patch: Partial<SessionSummary>) => void
            read: (id: string) => void
            unread: (id: string) => void
        }
    }
}

createRoot(document.getElementById('root')!).render(
    <React.StrictMode><QueryClientProvider client={new QueryClient()}>
        <ToastProvider><I18nProvider><Fixture /></I18nProvider></ToastProvider>
    </QueryClientProvider></React.StrictMode>,
)
