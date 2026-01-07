import { useCallback, useMemo, useState } from 'react'
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
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { NotificationSettings, NotificationSettingsButton } from '@/components/NotificationSettings'
import { NewSession } from '@/components/NewSession'
import { LoadingState } from '@/components/LoadingState'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { isTelegramApp } from '@/hooks/useTelegram'
import { useMessages } from '@/hooks/queries/useMessages'
import { useMachines } from '@/hooks/queries/useMachines'
import { useSession } from '@/hooks/queries/useSession'
import { useSessions } from '@/hooks/queries/useSessions'
import { useSlashCommands } from '@/hooks/queries/useSlashCommands'
import { useSendMessage } from '@/hooks/mutations/useSendMessage'
import { queryKeys } from '@/lib/query-keys'
import FilesPage from '@/routes/sessions/files'
import FilePage from '@/routes/sessions/file'
import TerminalPage from '@/routes/sessions/terminal'

function BackIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function PlusIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}

function TrashIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
    )
}

function SessionsPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const { sessions, isLoading, error, refetch } = useSessions(api)
    const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
    const [bulkDeletePending, setBulkDeletePending] = useState(false)
    const [notificationSettingsOpen, setNotificationSettingsOpen] = useState(false)

    const handleRefresh = useCallback(() => {
        void refetch()
    }, [refetch])

    const projectCount = new Set(sessions.map(s => s.metadata?.path ?? 'Other')).size

    const inactiveSessions = useMemo(
        () => sessions.filter(s => !s.active),
        [sessions]
    )

    const handleBulkDelete = async () => {
        if (!api || inactiveSessions.length === 0) return
        setBulkDeletePending(true)
        try {
            for (const session of inactiveSessions) {
                await api.deleteSession(session.id)
            }
            void refetch()
        } finally {
            setBulkDeletePending(false)
            setBulkDeleteOpen(false)
        }
    }

    return (
        <div className="flex h-full flex-col">
            <div className="bg-[var(--app-bg)]">
                <div className="mx-auto w-full max-w-content flex items-center justify-between px-3 py-2">
                    <div className="text-xs text-[var(--app-hint)]">
                        {sessions.length} sessions in {projectCount} projects
                    </div>
                    <div className="flex items-center gap-1">
                        <NotificationSettingsButton onClick={() => setNotificationSettingsOpen(true)} />
                        {inactiveSessions.length > 0 && (
                            <button
                                type="button"
                                onClick={() => setBulkDeleteOpen(true)}
                                className="session-list-new-button p-1.5 rounded-full text-[var(--app-badge-error-text)] transition-colors"
                                title={`Clear ${inactiveSessions.length} inactive session${inactiveSessions.length === 1 ? '' : 's'}`}
                            >
                                <TrashIcon className="h-5 w-5" />
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => navigate({ to: '/sessions/new' })}
                            className="session-list-new-button p-1.5 rounded-full text-[var(--app-link)] transition-colors"
                            title="New Session"
                        >
                            <PlusIcon className="h-5 w-5" />
                        </button>
                    </div>
                </div>
            </div>
            <div className="flex-1 overflow-y-auto">
                {error ? (
                    <div className="mx-auto w-full max-w-content px-3 py-2">
                        <div className="text-sm text-red-600">{error}</div>
                    </div>
                ) : null}
                <SessionList
                    sessions={sessions}
                    onSelect={(sessionId) => navigate({
                        to: '/sessions/$sessionId',
                        params: { sessionId },
                    })}
                    onNewSession={() => navigate({ to: '/sessions/new' })}
                    onRefresh={handleRefresh}
                    isLoading={isLoading}
                    renderHeader={false}
                    api={api}
                />
            </div>

            <ConfirmDialog
                isOpen={bulkDeleteOpen}
                onClose={() => setBulkDeleteOpen(false)}
                title="Clear Inactive Sessions"
                description={`Delete ${inactiveSessions.length} inactive session${inactiveSessions.length === 1 ? '' : 's'}? This action cannot be undone.`}
                confirmLabel="Delete All"
                confirmingLabel="Deleting..."
                onConfirm={handleBulkDelete}
                isPending={bulkDeletePending}
                destructive
            />
            <NotificationSettings
                isOpen={notificationSettingsOpen}
                onClose={() => setNotificationSettingsOpen(false)}
                api={api}
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

    // Get agent type from session metadata for slash commands
    const agentType = session?.metadata?.flavor ?? 'claude'
    const {
        getSuggestions: getSlashSuggestions,
    } = useSlashCommands(api, sessionId, agentType)

    const refreshSelectedSession = useCallback(() => {
        void refetchSession()
        void refetchMessages()
    }, [refetchMessages, refetchSession])

    if (!session) {
        return (
            <div className="flex-1 flex items-center justify-center p-4">
                <LoadingState label="Loading session…" className="text-sm" />
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
            onLoadMore={loadMoreMessages}
            onSend={sendMessage}
            onRetryMessage={retryMessage}
            autocompleteSuggestions={getSlashSuggestions}
        />
    )
}

function NewSessionPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const goBack = useAppGoBack()
    const queryClient = useQueryClient()
    const { machines, isLoading: machinesLoading, error: machinesError } = useMachines(api, true)

    const handleCancel = useCallback(() => {
        navigate({ to: '/sessions' })
    }, [navigate])

    const handleSuccess = useCallback((sessionId: string) => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        // Replace current page with /sessions to clear spawn flow from history
        navigate({ to: '/sessions', replace: true })
        // Then navigate to new session
        requestAnimationFrame(() => {
            navigate({
                to: '/sessions/$sessionId',
                params: { sessionId },
            })
        })
    }, [navigate, queryClient])

    return (
        <div className="flex-1 overflow-y-auto">
            <div className="flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-bg)] p-3">
                {!isTelegramApp() && (
                    <button
                        type="button"
                        onClick={goBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                )}
                <div className="flex-1 font-semibold">Create Session</div>
            </div>

            {machinesError ? (
                <div className="p-3 text-sm text-red-600">
                    {machinesError}
                </div>
            ) : null}

            <NewSession
                api={api}
                machines={machines}
                isLoading={machinesLoading}
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

const sessionTerminalRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions/$sessionId/terminal',
    component: TerminalPage,
})

type SessionFileSearch = {
    path: string
    staged?: boolean
}

const sessionFileRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions/$sessionId/file',
    validateSearch: (search: Record<string, unknown>): SessionFileSearch => {
        const path = typeof search.path === 'string' ? search.path : ''
        const staged = search.staged === true || search.staged === 'true'
            ? true
            : search.staged === false || search.staged === 'false'
                ? false
                : undefined

        return staged === undefined ? { path } : { path, staged }
    },
    component: FilePage,
})

const newSessionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions/new',
    component: NewSessionPage,
})

export const routeTree = rootRoute.addChildren([
    indexRoute,
    sessionsRoute,
    sessionRoute,
    sessionTerminalRoute,
    sessionFilesRoute,
    sessionFileRoute,
    newSessionRoute,
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
