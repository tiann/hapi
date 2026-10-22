import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionSummary } from '@/types/api'
import { SessionList } from '@/components/SessionList'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import '../src/index.css'

const params = new URLSearchParams(window.location.search)
if (params.get('mode') === 'count') {
    window.localStorage.setItem('hapi-session-project-sort-mode', 'count')
} else {
    window.localStorage.removeItem('hapi-session-project-sort-mode')
}
if (params.get('mode') === 'combined-count') {
    window.localStorage.setItem('hapi-session-project-sort-mode', 'count')
    window.localStorage.setItem('hapi-pin-in-progress-sessions', 'true')
    window.localStorage.setItem('hapi-pin-in-progress-sessions-mode', 'combined')
} else {
    window.localStorage.removeItem('hapi-pin-in-progress-sessions')
    window.localStorage.removeItem('hapi-pin-in-progress-sessions-mode')
}
window.localStorage.removeItem('hapi-session-project-order')

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
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
        ...overrides,
    }
}

const now = Date.now()
const sessions: SessionSummary[] = [
    makeSession({
        id: 'hapi-session',
        active: true,
        updatedAt: now - 2 * 60_000,
        metadata: { path: '/projects/hapi', name: 'HAPI task', flavor: 'codex' },
    }),
    makeSession({
        id: 'mine-session',
        active: true,
        updatedAt: now - 30 * 60_000,
        metadata: { path: '/projects/mine', name: 'Mine task', flavor: 'codex' },
    }),
    makeSession({
        id: 'mine-session-2',
        updatedAt: now - 45 * 60_000,
        metadata: { path: '/projects/mine', name: 'Mine follow-up', flavor: 'codex' },
    }),
]

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
    },
})

declare global {
    interface Window {
        updateProjectSession: (id: string, updatedAt: number) => void
    }
}

function ProjectSortFixture() {
    const [currentSessions, setCurrentSessions] = useState(sessions)
    window.updateProjectSession = (id, updatedAt) => {
        setCurrentSessions((previous) => previous.map((session) => session.id === id ? { ...session, updatedAt } : session))
    }

    return (
        <div className="h-screen w-full bg-[var(--app-bg)] text-[var(--app-fg)]">
            <SessionList
                sessions={currentSessions}
                selectedSessionId={null}
                onSelect={() => {}}
                onNewSession={() => {}}
                onRefresh={async () => {}}
                isLoading={false}
                renderHeader={false}
                api={null}
            />
        </div>
    )
}

createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
        <ToastProvider>
            <I18nProvider>
                <ProjectSortFixture />
            </I18nProvider>
        </ToastProvider>
    </QueryClientProvider>,
)
