import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getTelegramWebApp } from '@/hooks/useTelegram'
import { initializeTheme } from '@/hooks/useTheme'
import { useAuth } from '@/hooks/useAuth'
import { useSocket } from '@/hooks/useSocket'
import type { DecryptedMessage, Machine, Session, SessionSummary, SyncEvent } from '@/types/api'
import { SessionList } from '@/components/SessionList'
import { SessionChat } from '@/components/SessionChat'
import { MachineList } from '@/components/MachineList'
import { SpawnSession } from '@/components/SpawnSession'

function getInitData(): string | null {
    const tg = getTelegramWebApp()
    if (tg?.initData) {
        return tg.initData
    }

    const query = new URLSearchParams(window.location.search)
    const tgWebAppData = query.get('tgWebAppData')
    if (tgWebAppData) {
        return tgWebAppData
    }

    const fromQuery = new URLSearchParams(window.location.search).get('initData')
    return fromQuery || null
}

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

function mergeRecentMessages(existing: DecryptedMessage[], recent: DecryptedMessage[]): DecryptedMessage[] {
    if (existing.length === 0) return recent
    if (recent.length === 0) return existing

    // Separate optimistic messages (those with localId and status)
    const optimisticMessages = existing.filter(m => m.localId && m.status)
    const nonOptimisticExisting = existing.filter(m => !m.localId || !m.status)

    const anchorId = recent[0]?.id
    let merged: DecryptedMessage[]

    if (anchorId) {
        const matchIndex = nonOptimisticExisting.findIndex((m) => m.id === anchorId)
        if (matchIndex >= 0) {
            merged = [...nonOptimisticExisting.slice(0, matchIndex), ...recent]
        } else {
            const anchorTime = recent[0]?.createdAt
            if (typeof anchorTime === 'number') {
                const timeMatchIndex = nonOptimisticExisting.findIndex((m) => m.createdAt >= anchorTime)
                if (timeMatchIndex >= 0) {
                    merged = [...nonOptimisticExisting.slice(0, timeMatchIndex), ...recent]
                } else {
                    merged = dedupeAndSort([...nonOptimisticExisting, ...recent])
                }
            } else {
                merged = dedupeAndSort([...nonOptimisticExisting, ...recent])
            }
        }
    } else {
        merged = dedupeAndSort([...nonOptimisticExisting, ...recent])
    }

    // Re-add optimistic messages that are still sending or failed
    // (sent messages will be replaced by server messages)
    for (const opt of optimisticMessages) {
        if (opt.status === 'sent') {
            // Check if server USER message with similar time exists
            const hasServerUserMessage = merged.some(m =>
                !m.localId &&
                isUserMessage(m) &&
                Math.abs(m.createdAt - opt.createdAt) < 10000
            )
            if (hasServerUserMessage) continue
        }
        // Keep sending and failed messages
        if (!merged.some(m => m.id === opt.id)) {
            merged.push(opt)
        }
    }

    merged.sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
        return a.id.localeCompare(b.id)
    })

    return merged
}

function dedupeAndSort(messages: DecryptedMessage[]): DecryptedMessage[] {
    const seen = new Set<string>()
    const result: DecryptedMessage[] = []
    for (const msg of messages) {
        if (seen.has(msg.id)) continue
        seen.add(msg.id)
        result.push(msg)
    }
    return result
}

export function App() {
    const [initData, setInitData] = useState<string | null>(() => getInitData())
    const { token, api, isLoading: isAuthLoading, error: authError, user } = useAuth(initData)

    const [screen, setScreen] = useState<Screen>(() => {
        const deepLinkedSessionId = getDeepLinkedSessionId()
        if (deepLinkedSessionId) {
            return { type: 'session', sessionId: deepLinkedSessionId }
        }
        return { type: 'sessions' }
    })

    const [sessions, setSessions] = useState<SessionSummary[]>([])
    const [sessionsLoading, setSessionsLoading] = useState<boolean>(false)
    const [sessionsError, setSessionsError] = useState<string | null>(null)

    const selectedSessionId = screen.type === 'session' ? screen.sessionId : null
    const [selectedSession, setSelectedSession] = useState<Session | null>(null)

    const [messages, setMessages] = useState<DecryptedMessage[]>([])
    const [messagesLoading, setMessagesLoading] = useState<boolean>(false)
    const [messagesLoadingMore, setMessagesLoadingMore] = useState<boolean>(false)
    const [messagesHasMore, setMessagesHasMore] = useState<boolean>(false)
    const [messagesNextBefore, setMessagesNextBefore] = useState<number | null>(null)
    const [messagesWarning, setMessagesWarning] = useState<string | null>(null)

    const [machines, setMachines] = useState<Machine[]>([])
    const [machinesLoading, setMachinesLoading] = useState<boolean>(false)
    const [machinesError, setMachinesError] = useState<string | null>(null)

    const [isSending, setIsSending] = useState<boolean>(false)
    const silentSyncInFlightRef = useRef<boolean>(false)

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

    const goBack = useCallback(() => {
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

    useEffect(() => {
        if (initData) {
            return
        }

        let attempts = 0
        const interval = setInterval(() => {
            attempts += 1
            const next = getInitData()
            if (next) {
                setInitData(next)
                clearInterval(interval)
            } else if (attempts >= 20) {
                clearInterval(interval)
            }
        }, 250)

        return () => {
            clearInterval(interval)
        }
    }, [initData])

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

    const loadMessages = useCallback(async (sessionId: string, options: { before?: number; appendOlder?: boolean; refresh?: boolean }) => {
        if (!api) return

        if (options.appendOlder) {
            setMessagesLoadingMore(true)
        } else {
            setMessagesLoading(true)
        }

        try {
            const res = await api.getMessages(sessionId, {
                limit: 50,
                before: options.before,
                refresh: options.refresh
            })

            if (options.appendOlder) {
                setMessages((prev) => [...res.messages, ...prev])
            } else {
                setMessages(res.messages)
            }
            setMessagesHasMore(res.page.hasMore)
            setMessagesNextBefore(res.page.nextBefore)
            if (res.warning) {
                const status = res.warning.status ?? 'error'
                setMessagesWarning(`Happy Bot returned ${status} while fetching message history. Showing cached/live messages.`)
            } else {
                setMessagesWarning(null)
            }
        } catch (e) {
            setMessagesWarning(e instanceof Error ? e.message : 'Failed to load messages')
        } finally {
            setMessagesLoading(false)
            setMessagesLoadingMore(false)
        }
    }, [api])

    const silentSyncSessionAndMessages = useCallback(async (sessionId: string) => {
        if (!api) return
        if (messagesLoading || messagesLoadingMore) return
        if (silentSyncInFlightRef.current) return
        silentSyncInFlightRef.current = true

        try {
            const [sessionRes, messagesRes] = await Promise.all([
                api.getSession(sessionId).catch(() => null),
                api.getMessages(sessionId, { limit: 50 }).catch(() => null)
            ])

            if (sessionRes) {
                setSelectedSession(sessionRes.session)
            }

            if (messagesRes) {
                setMessages((prev) => mergeRecentMessages(prev, messagesRes.messages))
            }
        } finally {
            silentSyncInFlightRef.current = false
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

        api.sendMessage(selectedSessionId, text)
            .then(() => {
                getTelegramWebApp()?.HapticFeedback?.notificationOccurred('success')
                setMessages((prev) =>
                    prev.map(m => m.localId === localId
                        ? { ...m, status: 'sent' as const }
                        : m
                    )
                )
            })
            .catch(() => {
                getTelegramWebApp()?.HapticFeedback?.notificationOccurred('error')
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
            setMessagesNextBefore(null)
            setMessagesWarning(null)
            return
        }
        setSelectedSession(null)
        setMessages([])
        setMessagesHasMore(false)
        setMessagesNextBefore(null)
        setMessagesWarning(null)

        loadSession(selectedSessionId)
        loadMessages(selectedSessionId, { refresh: true })
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
        onEvent: (event: SyncEvent) => {
            if (event.type === 'session-added' || event.type === 'session-updated' || event.type === 'session-removed') {
                loadSessions()
                if (selectedSessionId && 'sessionId' in event && event.sessionId === selectedSessionId) {
                    loadSession(selectedSessionId)
                }
            }
            if (event.type === 'message-received' && selectedSessionId && event.sessionId === selectedSessionId) {
                silentSyncSessionAndMessages(selectedSessionId)
            }
            if (event.type === 'machine-updated' && (screen.type === 'machines' || screen.type === 'spawn')) {
                loadMachines()
            }
        }
    })

    useEffect(() => {
        if (!api) return
        if (screen.type !== 'session') return
        if (!selectedSessionId) return

        silentSyncSessionAndMessages(selectedSessionId)
        const interval = setInterval(() => {
            silentSyncSessionAndMessages(selectedSessionId)
        }, 3_000)

        return () => {
            clearInterval(interval)
        }
    }, [api, screen.type, selectedSessionId, silentSyncSessionAndMessages])

    if (isAuthLoading) {
        return (
            <div className="p-4">
                <div className="text-sm text-[var(--app-hint)]">Authorizing…</div>
            </div>
        )
    }

    if (authError || !token || !api) {
        return (
            <div className="p-4 space-y-3">
                <div className="text-base font-semibold">Happy Mini App</div>
                <div className="text-sm text-red-600">
                    {authError ?? 'Not authorized'}
                </div>
                <div className="text-xs text-[var(--app-hint)]">
                    Open this page from Telegram using the bot’s “Open App” button (not “Open in browser”).
                </div>
            </div>
        )
    }

    const machineForSpawn = screen.type === 'spawn'
        ? machines.find(m => m.id === screen.machineId) ?? null
        : null

    return (
        <div className="h-full flex flex-col">
            {screen.type === 'sessions' ? (
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {sessionsError ? <div className="text-sm text-red-600">{sessionsError}</div> : null}
                    <SessionList
                        sessions={sessions}
                        onSelect={(sessionId) => setScreen({ type: 'session', sessionId })}
                        onNewSession={() => setScreen({ type: 'machines' })}
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
                            loadMessages(screen.sessionId, { refresh: true })
                        }}
                        onLoadMore={() => {
                            if (!messagesNextBefore) return
                            loadMessages(screen.sessionId, { before: messagesNextBefore, appendOlder: true })
                        }}
                        onSend={(text) => {
                            if (isSending) return

                            // Create optimistic message
                            const localId = makeClientSideId('local')
                            const optimisticMessage: DecryptedMessage = {
                                id: localId,
                                localId: localId,
                                content: { role: 'user', content: text },
                                createdAt: Date.now(),
                                status: 'sending',
                                originalText: text
                            }

                            // Immediately show message
                            setMessages((prev) => [...prev, optimisticMessage])
                            setIsSending(true)

                            api.sendMessage(screen.sessionId, text)
                                .then(() => {
                                    getTelegramWebApp()?.HapticFeedback?.notificationOccurred('success')
                                    // Update status to sent
                                    setMessages((prev) =>
                                        prev.map(m => m.localId === localId
                                            ? { ...m, status: 'sent' as const }
                                            : m
                                        )
                                    )
                                })
                                .catch(() => {
                                    getTelegramWebApp()?.HapticFeedback?.notificationOccurred('error')
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
                        onSelect={(machineId) => setScreen({ type: 'spawn', machineId })}
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
                            setScreen({ type: 'session', sessionId })
                        }}
                    />
                </div>
            )}
        </div>
    )
}
