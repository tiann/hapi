import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionSummary } from '@/types/api'
import { SessionList } from '@/components/SessionList'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import '../src/index.css'

if (new URLSearchParams(window.location.search).get('mode') === 'detailed') {
    window.localStorage.setItem('hapi-pin-in-progress-sessions-mode', 'detailed')
}

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
        id: 'session-working',
        active: true,
        thinking: true,
        updatedAt: now - 3 * 60_000,
        metadata: { path: '/work/hapi', name: 'Working task', flavor: 'codex' },
    }),
    makeSession({
        id: 'session-pending',
        active: true,
        pendingRequestsCount: 1,
        updatedAt: now - 4 * 60_000,
        metadata: { path: '/work/hapi', name: 'Pending task', flavor: 'codex' },
    }),
    makeSession({
        id: 'session-quiet',
        active: true,
        updatedAt: now - 5 * 60_000,
        metadata: { path: '/work/hapi', name: 'Quiet task', flavor: 'codex' },
    }),
    ...Array.from({ length: 3 }, (_, index) => makeSession({
        id: `session-archived-${index + 1}`,
        updatedAt: now - (10 + index) * 60_000,
        metadata: { path: '/work/hapi', name: `Archived task ${index + 1}`, flavor: 'codex' },
    })),
]

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
    },
})

createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
        <ToastProvider>
            <I18nProvider>
                <div className="h-screen w-full bg-[var(--app-bg)] text-[var(--app-fg)]">
                    <SessionList
                        sessions={sessions}
                        selectedSessionId={null}
                        onSelect={() => {}}
                        onNewSession={() => {}}
                        onRefresh={async () => {}}
                        isLoading={false}
                        renderHeader={false}
                        api={null}
                    />
                </div>
            </I18nProvider>
        </ToastProvider>
    </QueryClientProvider>,
)
