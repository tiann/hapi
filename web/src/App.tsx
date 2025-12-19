import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getTelegramWebApp, isTelegramApp } from '@/hooks/useTelegram'
import { initializeTheme } from '@/hooks/useTheme'
import { useAuth } from '@/hooks/useAuth'
import { useAuthSource } from '@/hooks/useAuthSource'
import { useSSE } from '@/hooks/useSSE'
import { queryKeys } from '@/lib/query-keys'
import { useMessages } from '@/hooks/queries/useMessages'
import { useMachines } from '@/hooks/queries/useMachines'
import { useSession } from '@/hooks/queries/useSession'
import { useSessions } from '@/hooks/queries/useSessions'
import { useSendMessage } from '@/hooks/mutations/useSendMessage'
import { SessionList } from '@/components/SessionList'
import { SessionChat } from '@/components/SessionChat'
import { MachineList } from '@/components/MachineList'
import { SpawnSession } from '@/components/SpawnSession'
import { LoginPrompt } from '@/components/LoginPrompt'
import { InstallPrompt } from '@/components/InstallPrompt'
import { OfflineBanner } from '@/components/OfflineBanner'

type Screen =
    | { type: 'sessions' }
    | { type: 'session'; sessionId: string }
    | { type: 'machines' }
    | { type: 'spawn'; machineId: string }

function getStartParam(): string | null {
    const query = new URLSearchParams(window.location.search)
    const fromQuery = query.get('startapp') || query.get('tgWebAppStartParam')
    if (fromQuery) return fromQuery

    return getTelegramWebApp()?.initDataUnsafe?.start_param ?? null
}

function getDeepLinkedSessionId(): string | null {
    const startParam = getStartParam()
    if (startParam?.startsWith('session_')) {
        return startParam.slice('session_'.length)
    }
    return null
}

export function App() {
    const { authSource, isLoading: isAuthSourceLoading, setAccessToken } = useAuthSource()
    const { token, api, isLoading: isAuthLoading, error: authError } = useAuth(authSource)

    const [screen, setScreen] = useState<Screen>(() => {
        const deepLinkedSessionId = getDeepLinkedSessionId()
        if (deepLinkedSessionId) {
            return { type: 'session', sessionId: deepLinkedSessionId }
        }
        return { type: 'sessions' }
    })

    // Navigate and sync browser history (browser only, not Telegram)
    const navigateTo = useCallback((newScreen: Screen) => {
        setScreen(newScreen)
        if (!isTelegramApp()) {
            history.pushState({ screen: newScreen }, '')
        }
    }, [])

    useEffect(() => {
        const tg = getTelegramWebApp()
        tg?.ready()
        tg?.expand()
        initializeTheme()
    }, [])

    useEffect(() => {
        const preventDefault = (event: Event) => {
            event.preventDefault()
        }

        const onWheel = (event: WheelEvent) => {
            if (event.ctrlKey) {
                event.preventDefault()
            }
        }

        const onKeyDown = (event: KeyboardEvent) => {
            const modifier = event.ctrlKey || event.metaKey
            if (!modifier) return
            if (event.key === '+' || event.key === '-' || event.key === '=' || event.key === '0') {
                event.preventDefault()
            }
        }

        document.addEventListener('gesturestart', preventDefault as EventListener, { passive: false })
        document.addEventListener('gesturechange', preventDefault as EventListener, { passive: false })
        document.addEventListener('gestureend', preventDefault as EventListener, { passive: false })

        window.addEventListener('wheel', onWheel, { passive: false })
        window.addEventListener('keydown', onKeyDown)

        return () => {
            document.removeEventListener('gesturestart', preventDefault as EventListener)
            document.removeEventListener('gesturechange', preventDefault as EventListener)
            document.removeEventListener('gestureend', preventDefault as EventListener)

            window.removeEventListener('wheel', onWheel)
            window.removeEventListener('keydown', onKeyDown)
        }
    }, [])

    // Handle browser back button (browser only, not Telegram)
    useEffect(() => {
        if (isTelegramApp()) return

        const handlePopState = (event: PopStateEvent) => {
            if (event.state?.screen) {
                setScreen(event.state.screen)
            } else {
                setScreen({ type: 'sessions' })
            }
        }

        window.addEventListener('popstate', handlePopState)
        history.replaceState({ screen }, '')

        return () => window.removeEventListener('popstate', handlePopState)
    }, [])

    const goBack = useCallback(() => {
        // Browser: use native back (triggers popstate)
        if (!isTelegramApp()) {
            history.back()
            return
        }
        // Telegram: update state directly
        setScreen((prev) => {
            if (prev.type === 'session') return { type: 'sessions' }
            if (prev.type === 'machines') return { type: 'sessions' }
            if (prev.type === 'spawn') return { type: 'machines' }
            return prev
        })
    }, [])

    useEffect(() => {
        const tg = getTelegramWebApp()
        const backButton = tg?.BackButton
        if (!backButton) return

        if (screen.type === 'sessions') {
            backButton.offClick(goBack)
            backButton.hide()
            return
        }

        backButton.show()
        backButton.onClick(goBack)
        return () => {
            backButton.offClick(goBack)
            backButton.hide()
        }
    }, [goBack, screen.type])
    const queryClient = useQueryClient()
    const selectedSessionId = screen.type === 'session' ? screen.sessionId : null
    const machinesEnabled = screen.type === 'machines' || screen.type === 'spawn'

    const {
        sessions,
        isLoading: sessionsLoading,
        error: sessionsError,
        refetch: refetchSessions,
    } = useSessions(api)
    const {
        session: selectedSession,
        refetch: refetchSession,
    } = useSession(api, selectedSessionId)
    const {
        messages,
        warning: messagesWarning,
        isLoading: messagesLoading,
        isLoadingMore: messagesLoadingMore,
        hasMore: messagesHasMore,
        loadMore: loadMoreMessages,
        refetch: refetchMessages,
    } = useMessages(api, selectedSessionId)
    const {
        machines,
        error: machinesError,
    } = useMachines(api, machinesEnabled)
    const {
        sendMessage,
        retryMessage,
        isSending,
    } = useSendMessage(api, selectedSessionId)

    const refreshSessions = useCallback(() => {
        void refetchSessions()
    }, [refetchSessions])

    const refreshSelectedSession = useCallback(() => {
        if (!selectedSessionId) return
        void refetchSession()
        void refetchMessages()
    }, [selectedSessionId, refetchMessages, refetchSession])

    const handleSseConnect = useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        if (selectedSessionId) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.session(selectedSessionId) })
            void queryClient.invalidateQueries({ queryKey: queryKeys.messages(selectedSessionId) })
        }
    }, [queryClient, selectedSessionId])

    const handleSseEvent = useCallback(() => {}, [])

    const eventSubscription = useMemo(() => {
        if (screen.type === 'session') {
            return { sessionId: screen.sessionId }
        }
        if (screen.type === 'spawn') {
            return { machineId: screen.machineId }
        }
        return { all: true }
    }, [screen])

    useSSE({
        enabled: Boolean(api && token),
        token: token ?? '',
        subscription: eventSubscription,
        onConnect: handleSseConnect,
        onEvent: handleSseEvent,
    })

    // Loading auth source
    if (isAuthSourceLoading) {
        return (
            <div className="p-4">
                <div className="text-sm text-[var(--app-hint)]">Loading…</div>
            </div>
        )
    }

    // No auth source (browser environment, not logged in)
    if (!authSource) {
        return <LoginPrompt onLogin={setAccessToken} />
    }

    // Authenticating
    if (isAuthLoading) {
        return (
            <div className="p-4">
                <div className="text-sm text-[var(--app-hint)]">Authorizing…</div>
            </div>
        )
    }

    // Auth error
    if (authError || !token || !api) {
        // If using access token and auth failed, show login again
        if (authSource.type === 'accessToken') {
            return (
                <LoginPrompt
                    onLogin={setAccessToken}
                    error={authError ?? 'Authentication failed'}
                />
            )
        }

        // Telegram auth failed
        return (
            <div className="p-4 space-y-3">
                <div className="text-base font-semibold">Hapi</div>
                <div className="text-sm text-red-600">
                    {authError ?? 'Not authorized'}
                </div>
                <div className="text-xs text-[var(--app-hint)]">
                    Open this page from Telegram using the bot's "Open App" button (not "Open in browser").
                </div>
            </div>
        )
    }

    const machineForSpawn = screen.type === 'spawn'
        ? machines.find(m => m.id === screen.machineId) ?? null
        : null

    return (
        <>
            <OfflineBanner />
            <div className="h-full flex flex-col">
                {screen.type === 'sessions' ? (
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {sessionsError ? <div className="text-sm text-red-600">{sessionsError}</div> : null}
                    <SessionList
                        sessions={sessions}
                        onSelect={(sessionId) => navigateTo({ type: 'session', sessionId })}
                        onNewSession={() => navigateTo({ type: 'machines' })}
                        onRefresh={refreshSessions}
                        isLoading={sessionsLoading}
                    />
                </div>
            ) : screen.type === 'session' ? (
                selectedSession ? (
                    <SessionChat
                        api={api}
                        session={selectedSession}
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
                ) : (
                    <div className="p-4 text-sm text-[var(--app-hint)]">Loading session…</div>
                )
            ) : screen.type === 'machines' ? (
                <div className="flex-1 overflow-y-auto">
                    <div className="flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-bg)] p-3">
                        <div className="flex-1 font-semibold">Machines</div>
                    </div>

                    {machinesError ? (
                        <div className="p-3 text-sm text-red-600">
                            {machinesError}
                        </div>
                    ) : null}

                    <MachineList
                        machines={machines}
                        onSelect={(machineId) => navigateTo({ type: 'spawn', machineId })}
                    />
                </div>
            ) : (
                <div className="flex-1 overflow-y-auto">
                    <div className="flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-bg)] p-3">
                        <div className="flex-1 font-semibold">Create Session</div>
                    </div>

                    <SpawnSession
                        api={api}
                        machineId={screen.machineId}
                        machine={machineForSpawn}
                        onCancel={goBack}
                        onSuccess={(sessionId) => {
                            refreshSessions()
                            navigateTo({ type: 'session', sessionId })
                        }}
                    />
                </div>
            )}
            </div>
            <InstallPrompt />
        </>
    )
}
