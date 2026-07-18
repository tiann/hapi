import { Suspense, lazy, useCallback, useMemo, type ComponentType } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
    Navigate,
    Outlet,
    createRootRoute,
    createRoute,
    createRouter,
    useLocation,
    useMatchRoute,
    useNavigate,
    useParams,
} from '@tanstack/react-router'
import { App } from '@/App'
import { SessionList } from '@/components/SessionList'
import { LoadingState } from '@/components/LoadingState'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { isTelegramApp } from '@/hooks/useTelegram'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { getResolveSendTargetSessionFailureToast, useResolveSendTargetSession, describeResolveSendTargetSession } from '@/hooks/useResolveSendTargetSession'
import { useMessages } from '@/hooks/queries/useMessages'
import { useMachines } from '@/hooks/queries/useMachines'
import { useSession } from '@/hooks/queries/useSession'
import { useSessions } from '@/hooks/queries/useSessions'
import { useSlashCommands } from '@/hooks/queries/useSlashCommands'
import { useSkills } from '@/hooks/queries/useSkills'
import { useMentions } from '@/hooks/queries/useMentions'
import { useSendMessage } from '@/hooks/mutations/useSendMessage'
import { queryKeys } from '@/lib/query-keys'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { fetchLatestMessages, seedMessageWindowFromSession } from '@/lib/message-window-store'
import { clearDraftsAfterSend } from '@/lib/clearDraftsAfterSend'
import type { Machine } from '@/types/api'

const LazySessionChat = lazy(() => import('@/components/SessionChat').then((mod) => ({ default: mod.SessionChat })))
const LazyNewSession = lazy(() => import('@/components/NewSession').then((mod) => ({ default: mod.NewSession })))
const LazyFilesPage = lazy(() => import('@/routes/sessions/files'))
const LazyFilePage = lazy(() => import('@/routes/sessions/file'))
const LazyTerminalPage = lazy(() => import('@/routes/sessions/terminal'))
const LazySettingsPage = lazy(() => import('@/routes/settings'))

function RouteLoadingState() {
    return (
        <div className="flex h-full items-center justify-center p-4">
            <LoadingState label="Loading…" className="text-sm" />
        </div>
    )
}

function withRouteSuspense(Component: ComponentType) {
    return function SuspendedRoute() {
        return (
            <Suspense fallback={<RouteLoadingState />}>
                <Component />
            </Suspense>
        )
    }
}

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

function SettingsIcon(props: { className?: string }) {
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
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
    )
}

function getMachineTitle(machine: Machine): string {
    if (machine.metadata?.displayName) return machine.metadata.displayName
    if (machine.metadata?.host) return machine.metadata.host
    return machine.id.slice(0, 8)
}

function SessionsPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const pathname = useLocation({ select: location => location.pathname })
    const matchRoute = useMatchRoute()
    const { t } = useTranslation()
    const { sessions, isLoading, error, refetch } = useSessions(api)
    const { machines } = useMachines(api, true)

    const handleRefresh = useCallback(() => {
        void refetch()
    }, [refetch])

    const projectCount = useMemo(() => new Set(sessions.map(s =>
        s.metadata?.worktree?.basePath ?? s.metadata?.path ?? 'Other'
    )).size, [sessions])
    const machineLabelsById = useMemo(() => {
        const labels: Record<string, string> = {}
        for (const machine of machines) {
            labels[machine.id] = getMachineTitle(machine)
        }
        return labels
    }, [machines])
    const sessionMatch = matchRoute({ to: '/sessions/$sessionId', fuzzy: true })
    const selectedSessionId = sessionMatch && sessionMatch.sessionId !== 'new' ? sessionMatch.sessionId : null
    const isSessionsIndex = pathname === '/sessions' || pathname === '/sessions/'
    const sidebar = useSidebarResize()

    return (
        <div className="flex h-full min-h-0">
            <div
                className={`${isSessionsIndex ? 'flex' : 'hidden lg:flex'} w-full shrink-0 flex-col bg-[var(--app-bg)]`}
                style={{ '--sidebar-w': `${sidebar.width}px` } as React.CSSProperties}
            >
                <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                    <div className="mx-auto w-full max-w-content flex items-center justify-between px-3 py-2">
                        <div className="text-xs text-[var(--app-hint)]">
                            {t('sessions.count', { n: sessions.length, m: projectCount })}
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => navigate({ to: '/settings' })}
                                className="p-1.5 rounded-full text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                title={t('settings.title')}
                            >
                                <SettingsIcon className="h-5 w-5" />
                            </button>
                            <button
                                type="button"
                                onClick={() => navigate({ to: '/sessions/new' })}
                                className="session-list-new-button p-1.5 rounded-full text-[var(--app-link)] transition-colors"
                                title={t('sessions.new')}
                            >
                                <PlusIcon className="h-5 w-5" />
                            </button>
                        </div>
                    </div>
                </div>

                <div className="app-scroll-y flex-1 min-h-0 desktop-scrollbar-left">
                    {error ? (
                        <div className="mx-auto w-full max-w-content px-3 py-2">
                            <div className="text-sm text-red-600">{error}</div>
                        </div>
                    ) : null}
                    <SessionList
                        sessions={sessions}
                        selectedSessionId={selectedSessionId}
                        onSelect={(sessionId) => navigate({
                            to: '/sessions/$sessionId',
                            params: { sessionId },
                        })}
                        onNewSession={() => navigate({ to: '/sessions/new' })}
                        onRefresh={handleRefresh}
                        isLoading={isLoading}
                        renderHeader={false}
                        api={api}
                        machineLabelsById={machineLabelsById}
                    />
                </div>
            </div>

            {/* Resize handle - desktop only */}
            <div
                className="sidebar-resize-handle hidden lg:block shrink-0"
                data-dragging={sidebar.isDragging || undefined}
                onPointerDown={sidebar.onPointerDown}
                onPointerMove={sidebar.onPointerMove}
                onPointerUp={sidebar.onPointerUp}
            />

            <div className={`${isSessionsIndex ? 'hidden lg:flex' : 'flex'} min-w-0 flex-1 flex-col bg-[var(--app-bg)]`}>
                <div className="flex-1 min-h-0">
                    <Outlet />
                </div>
            </div>
        </div>
    )
}

function SessionsIndexPage() {
    return null
}

function SessionPage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const goBack = useAppGoBack()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const { addToast } = useToast()
    const { sessionId } = useParams({ from: '/sessions/$sessionId' })
    const {
        session,
        refetch: refetchSession,
    } = useSession(api, sessionId)
    const {
        messages,
        warning: messagesWarning,
        isLoading: messagesLoading,
        isLoadingOlder: messagesLoadingOlder,
        isLoadingNewer: messagesLoadingNewer,
        hasOlder: messagesHasOlder,
        hasNewer: messagesHasNewer,
        loadOlder: loadOlderMessages,
        loadNewer: loadNewerMessages,
        returnToLatest: returnToLatestMessages,
        refetch: refetchMessages,
        pendingCount,
        messagesVersion,
        flushPending,
        setAtBottom,
    } = useMessages(api, sessionId)
    const { action: sendTargetResolutionAction } = describeResolveSendTargetSession(session, messages)
    const { resolve: resolveSendTargetSession } = useResolveSendTargetSession(api, session, messages)
    const {
        sendMessage,
        retryMessage,
        isSending,
    } = useSendMessage(api, sessionId, {
        onSuccess: (sentSessionId) => {
            clearDraftsAfterSend(sentSessionId, sessionId)
        },
        resolveSessionId: async (currentSessionId) => {
            try {
                return await resolveSendTargetSession(currentSessionId)
            } catch (error) {
                if (sendTargetResolutionAction !== 'none') {
                    const toast = getResolveSendTargetSessionFailureToast(sendTargetResolutionAction, error)
                    addToast({
                        title: toast.title,
                        body: toast.body,
                        sessionId: currentSessionId,
                        url: ''
                    })
                }
                throw error
            }
        },
        onSessionResolved: (resolvedSessionId) => {
            if (api && session && resolvedSessionId !== session.id) {
                seedMessageWindowFromSession(session.id, resolvedSessionId)
                queryClient.setQueryData(queryKeys.session(resolvedSessionId), {
                    session: { ...session, id: resolvedSessionId, active: true }
                })
            }
            navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: resolvedSessionId },
                replace: true
            })
            void (async () => {
                if (!api) {
                    return
                }
                try {
                    await Promise.all([
                        queryClient.prefetchQuery({
                            queryKey: queryKeys.session(resolvedSessionId),
                            queryFn: () => api.getSession(resolvedSessionId),
                        }),
                        fetchLatestMessages(api, resolvedSessionId),
                    ])
                } catch {
                }
            })()
        },
        onBlocked: (reason) => {
            if (reason === 'no-api') {
                addToast({
                    title: t('send.blocked.title'),
                    body: t('send.blocked.noConnection'),
                    sessionId: sessionId ?? '',
                    url: ''
                })
            }
            // 'no-session' and 'pending' don't need toast - either invalid state or expected behavior
        }
    })

    // Get agent type from session metadata for slash commands
    const agentType = session?.metadata?.flavor ?? 'claude'
    const {
        commands: slashCommands,
        ensureCommands: ensureSlashCommands,
        getSuggestions: getSlashSuggestions,
        suggestionsVersion: slashSuggestionsVersion,
    } = useSlashCommands(api, sessionId, agentType, { enabled: false })
    const {
        getSuggestions: getSkillSuggestions,
        suggestionsVersion: skillSuggestionsVersion,
    } = useSkills(api, sessionId, { enabled: false })
    const {
        getSuggestions: getMentionSuggestions,
        suggestionsVersion: mentionSuggestionsVersion,
    } = useMentions(api, sessionId, { enabled: false })

    const autocompleteSuggestionsVersion = `${agentType}:${mentionSuggestionsVersion}:${skillSuggestionsVersion}:${slashSuggestionsVersion}`

    const getAutocompleteSuggestions = useCallback(async (query: string) => {
        if (query.startsWith('@')) {
            return await getMentionSuggestions(query)
        }
        if (query.startsWith('$')) {
            return await getSkillSuggestions(query)
        }
        return await getSlashSuggestions(query)
    }, [getMentionSuggestions, getSkillSuggestions, getSlashSuggestions])

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
        <Suspense fallback={<RouteLoadingState />}>
            <LazySessionChat
                api={api}
                session={session}
                messages={messages}
                messagesWarning={messagesWarning}
                hasMoreMessages={messagesHasOlder}
                hasNewerMessages={messagesHasNewer}
                isLoadingMessages={messagesLoading}
                isLoadingMoreMessages={messagesLoadingOlder}
                isLoadingNewerMessages={messagesLoadingNewer}
                isSending={isSending}
                pendingCount={pendingCount}
                messagesVersion={messagesVersion}
                onBack={goBack}
                onRefresh={refreshSelectedSession}
                onLoadMore={loadOlderMessages}
                onLoadNewer={loadNewerMessages}
                onReturnToLatest={returnToLatestMessages}
                onSend={sendMessage}
                onFlushPending={flushPending}
                onAtBottomChange={setAtBottom}
                onRetryMessage={retryMessage}
                autocompleteSuggestions={getAutocompleteSuggestions}
                autocompleteSuggestionsVersion={autocompleteSuggestionsVersion}
                availableSlashCommands={slashCommands}
                resolveAvailableSlashCommands={ensureSlashCommands}
            />
        </Suspense>
    )
}

function SessionDetailRoute() {
    const pathname = useLocation({ select: location => location.pathname })
    const { sessionId } = useParams({ from: '/sessions/$sessionId' })
    const basePath = `/sessions/${sessionId}`
    const isChat = pathname === basePath || pathname === `${basePath}/`

    return isChat ? <SessionPage /> : <Outlet />
}

function NewSessionPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const goBack = useAppGoBack()
    const queryClient = useQueryClient()
    const {
        machines,
        knownMachinesCount,
        offlineMachinesCount,
        serverTimeOffsetMs,
        isLoading: machinesLoading,
        error: machinesError
    } = useMachines(api, true)
    const { t } = useTranslation()

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
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-bg)] p-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
                {!isTelegramApp() && (
                    <button
                        type="button"
                        onClick={goBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                )}
                <div className="flex-1 font-semibold">{t('newSession.title')}</div>
            </div>

            <div
                className="app-scroll-y flex-1 min-h-0"
                style={{ paddingBottom: 'calc(var(--app-floating-bottom-offset, 0px) + env(safe-area-inset-bottom))' }}
            >
                {machinesError ? (
                    <div className="p-3 text-sm text-red-600">
                        {machinesError}
                    </div>
                ) : null}

                <Suspense fallback={<RouteLoadingState />}>
                    <LazyNewSession
                        api={api}
                        machines={machines}
                        knownMachinesCount={knownMachinesCount}
                        offlineMachinesCount={offlineMachinesCount}
                        serverTimeOffsetMs={serverTimeOffsetMs}
                        isLoading={machinesLoading}
                        onCancel={handleCancel}
                        onSuccess={handleSuccess}
                    />
                </Suspense>
            </div>
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

const sessionsIndexRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: '/',
    component: SessionsIndexPage,
})

const sessionDetailRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: '$sessionId',
    component: SessionDetailRoute,
})

const sessionFilesRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'files',
    validateSearch: (search: Record<string, unknown>): { tab?: 'changes' | 'directories' } => {
        const tabValue = typeof search.tab === 'string' ? search.tab : undefined
        const tab = tabValue === 'directories'
            ? 'directories'
            : tabValue === 'changes'
                ? 'changes'
                : undefined

        return tab ? { tab } : {}
    },
    component: withRouteSuspense(LazyFilesPage),
})

const sessionTerminalRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'terminal',
    component: withRouteSuspense(LazyTerminalPage),
})

type SessionFileSearch = {
    path: string
    staged?: boolean
    tab?: 'changes' | 'directories'
}

const sessionFileRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'file',
    validateSearch: (search: Record<string, unknown>): SessionFileSearch => {
        const path = typeof search.path === 'string' ? search.path : ''
        const staged = search.staged === true || search.staged === 'true'
            ? true
            : search.staged === false || search.staged === 'false'
                ? false
                : undefined

        const tabValue = typeof search.tab === 'string' ? search.tab : undefined
        const tab = tabValue === 'directories'
            ? 'directories'
            : tabValue === 'changes'
                ? 'changes'
                : undefined

        const result: SessionFileSearch = { path }
        if (staged !== undefined) {
            result.staged = staged
        }
        if (tab !== undefined) {
            result.tab = tab
        }
        return result
    },
    component: withRouteSuspense(LazyFilePage),
})

const newSessionRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: 'new',
    component: NewSessionPage,
})

const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: withRouteSuspense(LazySettingsPage),
})

export const routeTree = rootRoute.addChildren([
    indexRoute,
    sessionsRoute.addChildren([
        sessionsIndexRoute,
        newSessionRoute,
        sessionDetailRoute.addChildren([
            sessionTerminalRoute,
            sessionFilesRoute,
            sessionFileRoute,
        ]),
    ]),
    settingsRoute,
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
