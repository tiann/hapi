import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
    Navigate,
    createRootRoute,
    createRoute,
    createRouter,
    useNavigate,
    useParams,
} from '@tanstack/react-router'
import { App } from '@/App'
import { SessionChat } from '@/components/SessionChat'
import { SessionList } from '@/components/SessionList'
import { MachineList } from '@/components/MachineList'
import { SpawnSession } from '@/components/SpawnSession'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useMessages } from '@/hooks/queries/useMessages'
import { useMachines } from '@/hooks/queries/useMachines'
import { useSession } from '@/hooks/queries/useSession'
import { useSessions } from '@/hooks/queries/useSessions'
import { useSendMessage } from '@/hooks/mutations/useSendMessage'
import { queryKeys } from '@/lib/query-keys'
import FilesPage from '@/routes/sessions/files'
import FilePage from '@/routes/sessions/file'

function SessionsPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const { sessions, isLoading, error, refetch } = useSessions(api)

    const handleRefresh = useCallback(() => {
        void refetch()
    }, [refetch])

    return (
        <div className="flex-1 overflow-y-auto p-4 pt-[calc(1rem+env(safe-area-inset-top))] space-y-4">
            {error ? <div className="text-sm text-red-600">{error}</div> : null}
            <SessionList
                sessions={sessions}
                onSelect={(sessionId) => navigate({
                    to: '/sessions/$sessionId',
                    params: { sessionId },
                })}
                onNewSession={() => navigate({ to: '/machines' })}
                onRefresh={handleRefresh}
                isLoading={isLoading}
            />
        </div>
    )
}

function SessionPage() {
    const { api } = useAppContext()
    const goBack = useAppGoBack()
    const { sessionId } = useParams({ from: '/sessions/$sessionId' })
    const {
        session,
        refetch: refetchSession,
    } = useSession(api, sessionId)
    const {
        messages,
        warning: messagesWarning,
        isLoading: messagesLoading,
        isLoadingMore: messagesLoadingMore,
        hasMore: messagesHasMore,
        loadMore: loadMoreMessages,
        refetch: refetchMessages,
    } = useMessages(api, sessionId)
    const {
        sendMessage,
        retryMessage,
        isSending,
    } = useSendMessage(api, sessionId)

    const refreshSelectedSession = useCallback(() => {
        void refetchSession()
        void refetchMessages()
    }, [refetchMessages, refetchSession])

    if (!session) {
        return (
            <div className="p-4 text-sm text-[var(--app-hint)]">
                Loading session…
            </div>
        )
    }

    return (
        <SessionChat
            api={api}
            session={session}
            messages={messages}
            messagesWarning={messagesWarning}
            hasMoreMessages={messagesHasMore}
            isLoadingMessages={messagesLoading}
            isLoadingMoreMessages={messagesLoadingMore}
            isSending={isSending}
            onBack={goBack}
            onRefresh={refreshSelectedSession}
            onLoadMore={() => {
                void loadMoreMessages()
            }}
            onSend={sendMessage}
            onRetryMessage={retryMessage}
        />
    )
}

function MachinesPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const { machines, error: machinesError } = useMachines(api, true)

    return (
        <div className="flex-1 overflow-y-auto">
            <div className="flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-bg)] p-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
                <div className="flex-1 font-semibold">Machines</div>
            </div>

            {machinesError ? (
                <div className="p-3 text-sm text-red-600">
                    {machinesError}
                </div>
            ) : null}

            <MachineList
                machines={machines}
                onSelect={(machineId) => navigate({
                    to: '/machines/$machineId/spawn',
                    params: { machineId },
                })}
            />
        </div>
    )
}

function SpawnPage() {
    const { api } = useAppContext()
    const { machineId } = useParams({ from: '/machines/$machineId/spawn' })
    const { machines } = useMachines(api, true)
    const navigate = useNavigate()
    const queryClient = useQueryClient()

    const machineForSpawn = machines.find((machine) => machine.id === machineId) ?? null

    const handleCancel = useCallback(() => {
        navigate({ to: '/machines' })
    }, [navigate])

    const handleSuccess = useCallback((sessionId: string) => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId },
        })
    }, [navigate, queryClient])

    return (
        <div className="flex-1 overflow-y-auto">
            <div className="flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-bg)] p-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
                <div className="flex-1 font-semibold">Create Session</div>
            </div>

            <SpawnSession
                api={api}
                machineId={machineId}
                machine={machineForSpawn}
                onCancel={handleCancel}
                onSuccess={handleSuccess}
            />
        </div>
    )
}

const rootRoute = createRootRoute({
    component: App,
})

const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <Navigate to="/sessions" replace />,
})

const sessionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions',
    component: SessionsPage,
})

const sessionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions/$sessionId',
    component: SessionPage,
})

const sessionFilesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions/$sessionId/files',
    component: FilesPage,
})

const sessionFileRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions/$sessionId/file',
    validateSearch: (search: Record<string, unknown>) => ({
        path: typeof search.path === 'string' ? search.path : '',
        staged: search.staged === true || search.staged === 'true'
            ? true
            : search.staged === false || search.staged === 'false'
                ? false
                : undefined
    }),
    component: FilePage,
})

const machinesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/machines',
    component: MachinesPage,
})

const spawnRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/machines/$machineId/spawn',
    component: SpawnPage,
})

export const routeTree = rootRoute.addChildren([
    indexRoute,
    sessionsRoute,
    sessionRoute,
    sessionFilesRoute,
    sessionFileRoute,
    machinesRoute,
    spawnRoute,
])

type RouterHistory = Parameters<typeof createRouter>[0]['history']

export function createAppRouter(history?: RouterHistory) {
    return createRouter({
        routeTree,
        history,
        scrollRestoration: true,
    })
}

export type AppRouter = ReturnType<typeof createAppRouter>

declare module '@tanstack/react-router' {
    interface Register {
        router: AppRouter
    }
}
