import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionSummary } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { SessionList } from '@/components/SessionList'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import '../src/index.css'

const params = new URLSearchParams(window.location.search)
const crossTab = params.has('crossTab')
const actionSearch = params.get('mode') === 'action-search'
if (params.get('mode') === 'count' || crossTab) {
    window.localStorage.setItem('hapi-session-project-sort-mode', 'count')
} else {
    window.localStorage.removeItem('hapi-session-project-sort-mode')
}
if (actionSearch) {
    window.localStorage.setItem('hapi-session-project-sort-mode', 'count')
    window.localStorage.setItem('hapi-pin-in-progress-sessions', 'all')
    window.localStorage.removeItem('hapi-pin-in-progress-sessions-mode')
} else if (params.get('mode') === 'combined-count') {
    window.localStorage.setItem('hapi-session-project-sort-mode', 'count')
    window.localStorage.setItem('hapi-pin-in-progress-sessions', 'true')
    window.localStorage.setItem('hapi-pin-in-progress-sessions-mode', 'combined')
} else {
    window.localStorage.removeItem('hapi-pin-in-progress-sessions')
    window.localStorage.removeItem('hapi-pin-in-progress-sessions-mode')
}
if (!crossTab) window.localStorage.removeItem('hapi-session-project-order')

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
        createdAt: now - 3 * 60 * 60_000,
        lastUserMessageAt: now - 2 * 60_000,
        metadata: { path: '/projects/hapi', name: 'HAPI task', flavor: 'codex' },
    }),
    makeSession({
        id: 'mine-session',
        active: true,
        updatedAt: now - 30 * 60_000,
        createdAt: now - 4 * 60 * 60_000,
        lastUserMessageAt: now - 30 * 60_000,
        metadata: { path: '/projects/mine', name: 'Mine task', flavor: 'codex' },
    }),
    makeSession({
        id: 'mine-session-2',
        updatedAt: now - 45 * 60_000,
        createdAt: now - 5 * 60 * 60_000,
        lastUserMessageAt: now - 45 * 60_000,
        metadata: { path: '/projects/mine', name: 'Mine follow-up', flavor: 'codex' },
    }),
]

const actionSearchSessions: SessionSummary[] = [
    makeSession({ id: 'strong-title', active: true, thinking: true, updatedAt: now,
        metadata: { path: '/projects/strong', name: 'home', flavor: 'codex' } }),
    makeSession({ id: 'weak-path-1', active: true, thinking: true, updatedAt: now + 1,
        metadata: { path: '/projects/home-weak', name: 'Task one', flavor: 'codex' } }),
    makeSession({ id: 'weak-path-2', active: true, thinking: true, updatedAt: now + 2,
        metadata: { path: '/projects/home-weak', name: 'Task two', flavor: 'codex' } }),
]

const archivedJobSession = makeSession({
    id: 'archived-job', active: false, updatedAt: now,
    metadata: { path: '/projects/archived-job', name: 'Archived running job', flavor: 'codex', lifecycleState: 'archived' },
    attachedJob: { key: 'batch', label: 'Batch', status: 'running', startedAt: now, updatedAt: now, heartbeatAt: now },
})

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
    },
})

const linkPrApi = {
    getFeatures: async () => ({ githubPrAwareness: { enabled: true, source: 'default' }, prChipDisplay: undefined })
} as unknown as ApiClient

const exportApi = {
    getSessionExport: () => new Promise(resolve => {
        window.finishProjectExport = () => resolve({ type: 'warning', count: 1, limit: 0, estimatedBytes: 100 })
    })
} as unknown as ApiClient

declare global {
    interface Window {
        updateProjectSession: (id: string, patch: Partial<SessionSummary>) => void
        showProjectSortProjects: (names: string[]) => void
        finishProjectExport: () => void
    }
}

function ProjectSortFixture() {
    const [currentSessions, setCurrentSessions] = useState<SessionSummary[]>(crossTab ? [] : actionSearch ? actionSearchSessions : params.has('archivedJob') ? [...sessions, archivedJobSession] : sessions)
    window.showProjectSortProjects = (names) => {
        setCurrentSessions(names.map((name, index) => makeSession({
            id: name,
            active: true,
            updatedAt: now + index,
            lastUserMessageAt: now + index,
            metadata: { path: `/projects/${name}`, name: `Session ${name}` },
        })))
    }
    window.updateProjectSession = (id, patch) => {
        setCurrentSessions((previous) => previous.map((session) => session.id === id ? { ...session, ...patch } : session))
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
                renderHeader={actionSearch}
                api={params.has('linkPr') ? linkPrApi : params.has('exportPending') ? exportApi : null}
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
