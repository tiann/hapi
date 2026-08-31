import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import { ToastProvider } from '../src/lib/toast-context'
import { SessionList } from '../src/components/SessionList'
import type { SessionSummary } from '../src/types/api'

const sessions: SessionSummary[] = Array.from({ length: 40 }, (_, index) => ({
    id: `session-list-scroll-${index}`,
    active: true,
    thinking: false,
    activeAt: 1_700_000_000_000 - index,
    updatedAt: 1_700_000_000_000 - index,
    metadata: {
        path: '/work/hapi',
        name: `Fixture session ${index + 1}`,
        machineId: 'fixture-machine',
        agentSessionId: `thread-${index}`
    },
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
    effort: null
}))

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false }
    }
})

ReactDOM.createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
        <ToastProvider>
            <I18nProvider>
                <div className="flex h-screen min-h-0 flex-col">
                    <SessionList
                        sessions={sessions}
                        selectedSessionId={null}
                        onSelect={() => {}}
                        onNewSession={() => {}}
                        onRefresh={() => {}}
                        isLoading={false}
                        renderHeader={false}
                        api={null}
                        machineLabelsById={{ 'fixture-machine': 'Fixture machine' }}
                    />
                </div>
            </I18nProvider>
        </ToastProvider>
    </QueryClientProvider>
)
