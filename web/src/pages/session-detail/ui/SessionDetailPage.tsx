import { useCallback } from 'react'
import { Outlet, useLocation, useNavigate, useParams } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { SessionHeader } from '@/entities/session'
import { SessionChat } from '@/components/SessionChat'
import { LoadingState } from '@/components/LoadingState'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useMessages, useSendMessage } from '@/entities/message'
import { useGitStatusFiles } from '@/entities/git'
import { useSession } from '@/entities/session'
import { useSlashCommands } from '@/hooks/queries/useSlashCommands'
import { useSkills } from '@/hooks/queries/useSkills'
import { queryKeys } from '@/lib/query-keys'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { fetchLatestMessages, seedMessageWindowFromSession } from '@/lib/message-window-store'

export function SessionChatView() {
    const { api } = useAppContext()
    const { t } = useTranslation()
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
        isLoadingMore: messagesLoadingMore,
        hasMore: messagesHasMore,
        loadMore: loadMoreMessages,
        refetch: refetchMessages,
        pendingCount,
        messagesVersion,
        flushPending,
        setAtBottom,
    } = useMessages(api, sessionId)
    const {
        sendMessage,
        retryMessage,
        isSending,
    } = useSendMessage(api, sessionId, {
        resolveSessionId: async (currentSessionId) => {
            if (!api || !session || session.active) {
                return currentSessionId
            }
            try {
                return await api.resumeSession(currentSessionId)
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Resume failed'
                addToast({
                    title: 'Resume failed',
                    body: message,
                    sessionId: currentSessionId,
                    url: ''
                })
                throw error
            }
        },
        onSessionResolved: (resolvedSessionId) => {
            void (async () => {
                if (api) {
                    if (session && resolvedSessionId !== session.id) {
                        seedMessageWindowFromSession(session.id, resolvedSessionId)
                        queryClient.setQueryData(queryKeys.session(resolvedSessionId), {
                            session: { ...session, id: resolvedSessionId, active: true }
                        })
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
                }
                navigate({
                    to: '/sessions/$sessionId',
                    params: { sessionId: resolvedSessionId },
                    replace: true
                })
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
        }
    })

    const agentType = session?.metadata?.flavor ?? 'claude'
    const {
        getSuggestions: getSlashSuggestions,
        refetchCommands,
        isFetchingCommands: isFetchingSlashCommands,
    } = useSlashCommands(api, sessionId, agentType)
    const {
        getSuggestions: getSkillSuggestions,
    } = useSkills(api, sessionId)

    const getAutocompleteSuggestions = useCallback(async (query: string) => {
        if (query.startsWith('$')) {
            return await getSkillSuggestions(query)
        }
        return await getSlashSuggestions(query)
    }, [getSkillSuggestions, getSlashSuggestions])

    const handleSlashEntry = useCallback(() => {
        void refetchCommands()
    }, [refetchCommands])

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
            pendingCount={pendingCount}
            messagesVersion={messagesVersion}
            onRefresh={refreshSelectedSession}
            onLoadMore={loadMoreMessages}
            onSend={sendMessage}
            onFlushPending={flushPending}
            onAtBottomChange={setAtBottom}
            onRetryMessage={retryMessage}
            autocompleteSuggestions={getAutocompleteSuggestions}
            onSlashEntry={handleSlashEntry}
            isFetchingSlashCommands={isFetchingSlashCommands}
        />
    )
}

export function SessionDetailPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const pathname = useLocation({ select: location => location.pathname })
    const goBack = useAppGoBack()
    const { sessionId } = useParams({ from: '/sessions/$sessionId' })
    const { session } = useSession(api, sessionId)

    const basePath = `/sessions/${sessionId}`
    const currentView = pathname === basePath || pathname === `${basePath}/`
        ? 'chat'
        : pathname.startsWith(`${basePath}/terminal`)
            ? 'terminal'
            : 'files'

    const hasPath = Boolean(session?.metadata?.path)
    const {
        status: gitStatus,
        error: gitError,
        isLoading: gitLoading,
        refetch: refetchGitStatus,
    } = useGitStatusFiles(hasPath ? api : null, hasPath ? sessionId : null)

    const handleSelectView = useCallback((view: 'chat' | 'terminal' | 'files') => {
        if (view === 'chat') {
            navigate({ to: '/sessions/$sessionId', params: { sessionId } })
            return
        }
        if (view === 'terminal') {
            navigate({ to: '/sessions/$sessionId/terminal', params: { sessionId } })
            return
        }
        navigate({ to: '/sessions/$sessionId/files', params: { sessionId } })
    }, [navigate, sessionId])

    const handleSessionDeleted = useCallback(() => {
        navigate({ to: '/sessions' })
    }, [navigate])

    if (!session) {
        return (
            <div className="flex-1 flex items-center justify-center p-4">
                <LoadingState label="Loading session…" className="text-sm" />
            </div>
        )
    }

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <SessionHeader
                session={session}
                onBack={goBack}
                api={api}
                onSessionDeleted={handleSessionDeleted}
                gitSummary={gitStatus}
                gitLoading={gitLoading}
                gitError={Boolean(gitError)}
                currentView={currentView}
                onSelectView={handleSelectView}
            />
            <div className="min-h-0 flex-1 overflow-hidden">
                {currentView === 'chat' ? <SessionChatView /> : <Outlet />}
            </div>
        </div>
    )
}
