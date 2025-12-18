import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getTelegramWebApp, isTelegramApp } from '@/hooks/useTelegram'
import { initializeTheme } from '@/hooks/useTheme'
import { useAuth } from '@/hooks/useAuth'
import { useAuthSource } from '@/hooks/useAuthSource'
import { usePlatform } from '@/hooks/usePlatform'
import { useSocket } from '@/hooks/useSocket'
import type { DecryptedMessage, Machine, Session, SessionSummary, SyncEvent } from '@/types/api'
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

function makeClientSideId(prefix: string): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return `${prefix}-${crypto.randomUUID()}`
    }
    return `${prefix}-${Date.now()}-${Math.random()}`
}

function isUserMessage(msg: DecryptedMessage): boolean {
    const content = msg.content
    if (content && typeof content === 'object' && 'role' in content) {
        return (content as { role: string }).role === 'user'
    }
    return false
}

function compareMessages(a: DecryptedMessage, b: DecryptedMessage): number {
    const aSeq = typeof a.seq === 'number' ? a.seq : null
    const bSeq = typeof b.seq === 'number' ? b.seq : null
    if (aSeq !== null && bSeq !== null && aSeq !== bSeq) {
        return aSeq - bSeq
    }
    if (a.createdAt !== b.createdAt) {
        return a.createdAt - b.createdAt
    }
    return a.id.localeCompare(b.id)
}

function mergeMessages(existing: DecryptedMessage[], incoming: DecryptedMessage[]): DecryptedMessage[] {
    if (existing.length === 0) {
        return [...incoming].sort(compareMessages)
    }
    if (incoming.length === 0) {
        return [...existing].sort(compareMessages)
    }

    const byId = new Map<string, DecryptedMessage>()
    for (const msg of existing) {
        byId.set(msg.id, msg)
    }
    for (const msg of incoming) {
        byId.set(msg.id, msg)
    }

    let merged = Array.from(byId.values())

    const incomingLocalIds = new Set<string>()
    for (const msg of incoming) {
        if (msg.localId) {
            incomingLocalIds.add(msg.localId)
        }
    }

    // If we received a stored message with a localId, drop any optimistic bubble with the same localId.
    if (incomingLocalIds.size > 0) {
        merged = merged.filter((msg) => {
            if (!msg.localId || !incomingLocalIds.has(msg.localId)) {
                return true
            }
            return !msg.status
        })
    }

    // Fallback: if an optimistic message was marked as sent but we didn't get a localId echo,
    // drop it when a server user message appears close in time.
    const optimisticMessages = merged.filter((m) => m.localId && m.status)
    const nonOptimisticMessages = merged.filter((m) => !m.localId || !m.status)
    const result: DecryptedMessage[] = [...nonOptimisticMessages]

    for (const optimistic of optimisticMessages) {
        if (optimistic.status === 'sent') {
            const hasServerUserMessage = nonOptimisticMessages.some((m) =>
                !m.status &&
                isUserMessage(m) &&
                Math.abs(m.createdAt - optimistic.createdAt) < 10_000
            )
            if (hasServerUserMessage) {
                continue
            }
        }
        result.push(optimistic)
    }

    result.sort(compareMessages)
    return result
}

export function App() {
    const { authSource, isLoading: isAuthSourceLoading, setAccessToken } = useAuthSource()
    const { token, api, isLoading: isAuthLoading, error: authError, user } = useAuth(authSource)
    const { haptic } = usePlatform()

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

    const [sessions, setSessions] = useState<SessionSummary[]>([])
    const [sessionsLoading, setSessionsLoading] = useState<boolean>(false)
    const [sessionsError, setSessionsError] = useState<string | null>(null)

    const selectedSessionId = screen.type === 'session' ? screen.sessionId : null
    const [selectedSession, setSelectedSession] = useState<Session | null>(null)

    const [messages, setMessages] = useState<DecryptedMessage[]>([])
    const [messagesLoading, setMessagesLoading] = useState<boolean>(false)
    const [messagesLoadingMore, setMessagesLoadingMore] = useState<boolean>(false)
    const [messagesHasMore, setMessagesHasMore] = useState<boolean>(false)
    const [messagesNextBeforeSeq, setMessagesNextBeforeSeq] = useState<number | null>(null)
    const [messagesWarning, setMessagesWarning] = useState<string | null>(null)

    const [machines, setMachines] = useState<Machine[]>([])
    const [machinesLoading, setMachinesLoading] = useState<boolean>(false)
    const [machinesError, setMachinesError] = useState<string | null>(null)

    const [isSending, setIsSending] = useState<boolean>(false)
    const syncInFlightRef = useRef<boolean>(false)

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


    const loadSessions = useCallback(async () => {
        if (!api) return
        setSessionsLoading(true)
        setSessionsError(null)
        try {
            const res = await api.getSessions()
            setSessions(res.sessions)
        } catch (e) {
            setSessionsError(e instanceof Error ? e.message : 'Failed to load sessions')
        } finally {
            setSessionsLoading(false)
        }
    }, [api])

    const loadSession = useCallback(async (sessionId: string) => {
        if (!api) return
        const res = await api.getSession(sessionId)
        setSelectedSession(res.session)
    }, [api])

    const loadMessages = useCallback(async (
        sessionId: string,
        options: { beforeSeq?: number | null; appendOlder?: boolean } = {}
    ) => {
        if (!api) return

        if (options.appendOlder) {
            setMessagesLoadingMore(true)
        } else {
            setMessagesLoading(true)
        }

        try {
            const res = await api.getMessages(sessionId, {
                limit: 50,
                beforeSeq: options.beforeSeq ?? null
            })

            setMessages((prev) => mergeMessages(prev, res.messages))
            setMessagesHasMore(res.page.hasMore)
            setMessagesNextBeforeSeq(res.page.nextBeforeSeq)
            setMessagesWarning(null)
        } catch (e) {
            setMessagesWarning(e instanceof Error ? e.message : 'Failed to load messages')
        } finally {
            setMessagesLoading(false)
            setMessagesLoadingMore(false)
        }
    }, [api])

    const syncSessionAndMessages = useCallback(async (sessionId: string) => {
        if (!api) return
        if (messagesLoading || messagesLoadingMore) return
        if (syncInFlightRef.current) return
        syncInFlightRef.current = true

        try {
            const [sessionRes, messagesRes] = await Promise.all([
                api.getSession(sessionId).catch(() => null),
                api.getMessages(sessionId, { limit: 50 }).catch(() => null)
            ])

            if (sessionRes) {
                setSelectedSession(sessionRes.session)
            }

            if (messagesRes) {
                setMessages((prev) => mergeMessages(prev, messagesRes.messages))
                setMessagesHasMore(messagesRes.page.hasMore)
                setMessagesNextBeforeSeq(messagesRes.page.nextBeforeSeq)
            }
        } finally {
            syncInFlightRef.current = false
        }
    }, [api, messagesLoading, messagesLoadingMore])

    const retryMessage = useCallback((localId: string) => {
        const message = messages.find(m => m.localId === localId)
        if (!message?.originalText || !api || !selectedSessionId) return

        const text = message.originalText

        // Update status to sending
        setMessages((prev) =>
            prev.map(m => m.localId === localId
                ? { ...m, status: 'sending' as const }
                : m
            )
        )

        api.sendMessage(selectedSessionId, text, localId)
            .then(() => {
                haptic.notification('success')
                setMessages((prev) =>
                    prev.map(m => m.localId === localId
                        ? { ...m, status: 'sent' as const }
                        : m
                    )
                )
            })
            .catch(() => {
                haptic.notification('error')
                setMessages((prev) =>
                    prev.map(m => m.localId === localId
                        ? { ...m, status: 'failed' as const }
                        : m
                    )
                )
            })
    }, [messages, api, selectedSessionId])

    const loadMachines = useCallback(async () => {
        if (!api) return
        setMachinesLoading(true)
        setMachinesError(null)
        try {
            const res = await api.getMachines()
            setMachines(res.machines)
        } catch (e) {
            setMachinesError(e instanceof Error ? e.message : 'Failed to load machines')
        } finally {
            setMachinesLoading(false)
        }
    }, [api])

    useEffect(() => {
        if (!api) return
        loadSessions()
    }, [api, loadSessions])

    useEffect(() => {
        if (!api || !selectedSessionId) {
            setSelectedSession(null)
            setMessages([])
            setMessagesHasMore(false)
            setMessagesNextBeforeSeq(null)
            setMessagesWarning(null)
            return
        }
        setSelectedSession(null)
        setMessages([])
        setMessagesHasMore(false)
        setMessagesNextBeforeSeq(null)
        setMessagesWarning(null)

        loadSession(selectedSessionId)
        loadMessages(selectedSessionId)
    }, [api, selectedSessionId, loadSession, loadMessages])

    useEffect(() => {
        if (!api) return
        if (screen.type === 'machines' || screen.type === 'spawn') {
            loadMachines()
        }
    }, [api, loadMachines, screen.type])

    const socketSubscription = useMemo(() => {
        if (screen.type === 'session') {
            return { sessionId: screen.sessionId }
        }
        if (screen.type === 'spawn') {
            return { machineId: screen.machineId }
        }
        return { all: true }
    }, [screen])

    useSocket({
        enabled: Boolean(api && token),
        token: token ?? '',
        subscription: socketSubscription,
        onConnect: () => {
            if (selectedSessionId) {
                syncSessionAndMessages(selectedSessionId)
            }
        },
        onEvent: (event: SyncEvent) => {
            if (event.type === 'session-added' || event.type === 'session-updated' || event.type === 'session-removed') {
                loadSessions()
                if (selectedSessionId && 'sessionId' in event && event.sessionId === selectedSessionId) {
                    loadSession(selectedSessionId)
                }
            }
            if (event.type === 'message-received' && selectedSessionId && event.sessionId === selectedSessionId) {
                setMessages((prev) => mergeMessages(prev, [event.message]))
            }
            if (event.type === 'machine-updated' && (screen.type === 'machines' || screen.type === 'spawn')) {
                loadMachines()
            }
        }
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
                        onRefresh={loadSessions}
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
                        onRefresh={() => {
                            loadSession(screen.sessionId)
                            loadMessages(screen.sessionId)
                        }}
                        onLoadMore={() => {
                            if (messagesNextBeforeSeq === null) return
                            loadMessages(screen.sessionId, { beforeSeq: messagesNextBeforeSeq, appendOlder: true })
                        }}
                        onSend={(text) => {
                            if (isSending) return

                            // Create optimistic message
                            const localId = makeClientSideId('local')
                            const optimisticMessage: DecryptedMessage = {
                                id: localId,
                                seq: null,
                                localId: localId,
                                content: { role: 'user', content: text },
                                createdAt: Date.now(),
                                status: 'sending',
                                originalText: text
                            }

                            // Immediately show message
                            setMessages((prev) => mergeMessages(prev, [optimisticMessage]))
                            setIsSending(true)

                            api.sendMessage(screen.sessionId, text, localId)
                                .then(() => {
                                    haptic.notification('success')
                                    // Update status to sent
                                    setMessages((prev) =>
                                        prev.map(m => m.localId === localId
                                            ? { ...m, status: 'sent' as const }
                                            : m
                                        )
                                    )
                                })
                                .catch(() => {
                                    haptic.notification('error')
                                    // Update status to failed
                                    setMessages((prev) =>
                                        prev.map(m => m.localId === localId
                                            ? { ...m, status: 'failed' as const }
                                            : m
                                        )
                                    )
                                })
                                .finally(() => {
                                    setIsSending(false)
                                })
                        }}
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
                            loadSessions()
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
