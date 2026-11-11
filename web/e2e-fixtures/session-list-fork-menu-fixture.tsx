import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiClient } from '../src/api/client'
import { SessionList } from '../src/components/SessionList'
import { I18nProvider } from '../src/lib/i18n-context'
import { ToastProvider } from '../src/lib/toast-context'
import type { SessionSummary } from '../src/types/api'
import '../src/index.css'

const requestedLocale = new URLSearchParams(location.search).get('lang')
if (requestedLocale) localStorage.setItem('hapi-lang', requestedLocale)

const base = {
    active: true,
    thinking: false,
    activeAt: 0,
    updatedAt: Date.now(),
    metadataVersion: 0,
    agentStateVersion: 0,
    todosUpdatedAt: 0,
    todoProgress: null,
    pendingRequestsCount: 0,
    pendingRequestKinds: [],
    pendingRequests: [],
    backgroundTaskCount: 0,
    futureScheduledMessageCount: 0,
    nextScheduledAt: null,
    model: null,
    effort: null,
} satisfies Omit<SessionSummary, 'id' | 'metadata'>

const initialSessions: SessionSummary[] = [
    {
        ...base,
        id: 'forkable-source',
        metadata: {
            path: '/work/forkable',
            name: '可分叉会话',
            flavor: 'codex',
            conversationHistory: { forkCurrent: true, forkAtMessage: true },
        },
    },
    {
        ...base,
        id: 'running-source',
        thinking: true,
        updatedAt: base.updatedAt - 1,
        metadata: {
            path: '/work/running',
            name: '运行中会话',
            flavor: 'codex',
            conversationHistory: { forkCurrent: true },
        },
    },
    {
        ...base,
        id: 'archived-source',
        active: false,
        updatedAt: base.updatedAt - 2,
        metadata: {
            path: '/work/archived',
            machineId: 'machine-1',
            name: '已归档会话',
            flavor: 'codex',
            lifecycleState: 'archived',
            agentSessionId: 'native-archived',
        },
    },
]

function Fixture() {
    const [selected, setSelected] = useState<string | null>(null)
    const api = {
        forkConversation: async (sessionId: string) => {
            document.body.dataset.forkSource = sessionId
            return { sessionId: 'fork-child' }
        },
    } as unknown as ApiClient
    return <main style={{ width: 'min(420px, 100vw)', minHeight: 760, padding: 16 }}>
        <div data-testid="selected-session">{selected ?? 'none'}</div>
        <SessionList sessions={initialSessions} selectedSessionId={selected} onSelect={setSelected}
            onNewSession={() => {}} onRefresh={() => {}} isLoading={false} renderHeader={false} api={api} />
    </main>
}

createRoot(document.getElementById('root')!).render(
    <React.StrictMode><QueryClientProvider client={new QueryClient()}>
        <ToastProvider><I18nProvider><Fixture /></I18nProvider></ToastProvider>
    </QueryClientProvider></React.StrictMode>,
)
