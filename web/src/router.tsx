import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
    useSearch,
} from '@tanstack/react-router'
import { getScrollRestorationKey } from '@/lib/scrollRestorationKey'
import { App } from '@/App'
import { SessionChat } from '@/components/SessionChat'
import { SessionList } from '@/components/SessionList'
import { NewSession } from '@/components/NewSession'
import { WorkspaceBrowser } from '@/components/WorkspaceBrowser'
import { LoadingState } from '@/components/LoadingState'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { isTelegramApp } from '@/hooks/useTelegram'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { useMessages } from '@/hooks/queries/useMessages'
import { useMachines } from '@/hooks/queries/useMachines'
import { useMachineLabels } from '@/hooks/useMachineLabels'
import { useSession } from '@/hooks/queries/useSession'
import { useCursorChatStoreStatus } from '@/hooks/queries/useCursorChatStoreStatus'
import { useSessions } from '@/hooks/queries/useSessions'
import { useSlashCommands } from '@/hooks/queries/useSlashCommands'
import { useSkills } from '@/hooks/queries/useSkills'
import { getSessionTitle } from '@/lib/sessionTitle'
import { buildSessionReferenceText, matchSessionsForMention } from '@/lib/sessionReference'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { useSendMessage, type SendErrorInfo } from '@/hooks/mutations/useSendMessage'
import type { ComposerSendError } from '@/components/AssistantChat/HappyComposer'
import { ApiError } from '@/api/client'
import type { MessageDeliveryMode } from '@hapi/protocol'
import { queryKeys } from '@/lib/query-keys'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { seedMessageWindowFromSession, syncTailMessages } from '@/lib/message-window-store'
import { clearDraftsAfterSend } from '@/lib/clearDraftsAfterSend'
import { inactiveSessionCanResume } from '@/lib/sessionResume'
import { initializeSessionLastSeen, markSessionSeen } from '@/lib/sessionLastSeen'
import { useSessionBrowserTitle } from '@/hooks/useSessionBrowserTitle'
import { clearCodexImportedSession } from '@/lib/codexImportedSessions'
import { getSupersedingSessionId, shouldFollowSupersedingSession } from '@/routes/sessions/followSupersedingSession'
import { migrateSuppressedSendError } from '@/lib/suppressed-send-error'
import FilesPage from '@/routes/sessions/files'
import FilePage from '@/routes/sessions/file'
import TerminalPage from '@/routes/sessions/terminal'
import SettingsLayout from '@/routes/settings/layout'
import SettingsHubPage from '@/routes/settings'
import SettingsGeneralPage from '@/routes/settings/general'
import SettingsDisplayPage from '@/routes/settings/display'
import SettingsChatPage from '@/routes/settings/chat'
import SettingsVoicePage from '@/routes/settings/voice'
import SettingsVoiceVoicesPage from '@/routes/settings/voice-voices'
import SettingsVoiceAdvancedPage from '@/routes/settings/voice-advanced'
import SettingsMachinesPage from '@/routes/settings/machines'
import SettingsAboutPage from '@/routes/settings/about'
import SettingsStoragePage from '@/routes/settings/storage'
import SettingsUsagePage from '@/routes/settings/usage'
import SharePage from '@/routes/share'
import { setSharePendingTransfer } from '@/lib/sharePendingState'
import { deleteShareTransfer } from '@/lib/shareTransfer'


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

function FolderOpenIcon(props: { className?: string }) {
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
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
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

function SessionsPage() {
    const { api, baseUrl } = useAppContext()
    const navigate = useNavigate()
    const pathname = useLocation({ select: location => location.pathname })
    const matchRoute = useMatchRoute()
    const { t } = useTranslation()
    const { addToast } = useToast()
    const { sessions, isLoading, error, refetch } = useSessions(api)
    const [initializedHub, setInitializedHub] = useState<string | null>(null)
    const { machines } = useMachines(api, true)
    const handleRefresh = useCallback(() => {
        return (async () => {
            try {
                await refetch()
            } catch (error) {
                addToast({
                    title: t('sessions.refresh.failed.title'),
                    body: error instanceof Error ? error.message : t('dialog.error.default'),
                    sessionId: '',
                    url: ''
                })
            }
        })()
    }, [addToast, refetch, t])

    const machineLabelsById = useMachineLabels(machines)
    const machinesById = useMemo(() => {
        const byId: Record<string, typeof machines[number]> = {}
        for (const machine of machines) {
            byId[machine.id] = machine
        }
        return byId
    }, [machines])
    // Workspace browsing is opt-in per runner (`--workspace-root`); only show
    // browse affordances when at least one machine reported roots.
    const canBrowse = useMemo(
        () => machines.some(m => (m.metadata?.workspaceRoots?.length ?? 0) > 0),
        [machines]
    )
    const sessionMatch = matchRoute({ to: '/sessions/$sessionId', fuzzy: true })
    const selectedSessionId = sessionMatch && sessionMatch.sessionId !== 'new' ? sessionMatch.sessionId : null
    const selectedSession = useMemo(
        () => selectedSessionId ? sessions.find((session) => session.id === selectedSessionId) ?? null : null,
        [selectedSessionId, sessions]
    )
    useEffect(() => {
        if (isLoading || error) {
            return
        }
        initializeSessionLastSeen(baseUrl, sessions)
        setInitializedHub(baseUrl)
    }, [baseUrl, error, isLoading, sessions])
    useEffect(() => {
        if (!selectedSessionId || !selectedSession) {
            return
        }
        markSessionSeen(selectedSessionId, selectedSession.updatedAt)
    }, [selectedSessionId, selectedSession?.updatedAt])
    const isSessionsIndex = pathname === '/sessions' || pathname === '/sessions/'
    const sidebar = useSidebarResize()
    const handleNewSessionInDirectory = useCallback((args: { machineId: string | null; directory: string }) => {
        navigate({
            to: '/sessions/new',
            search: args.machineId
                ? { directory: args.directory, machineId: args.machineId }
                : { directory: args.directory }
        })
    }, [navigate])

    return (
        <>
            <div className="flex h-full min-h-0">
            <div
                className={`${isSessionsIndex ? 'flex' : 'hidden split:flex'} w-full shrink-0 flex-col bg-[var(--app-bg)]`}
                style={{ '--sidebar-w': `${sidebar.width}px` } as React.CSSProperties}
            >
                <div className="flex min-h-0 flex-1 flex-col pt-[env(safe-area-inset-top)]">
                    {error ? (
                        <div className="mx-auto w-full max-w-content px-3 py-2">
                            <div className="text-sm text-red-600">{error}</div>
                        </div>
                    ) : null}
                    <SessionList
                        key={initializedHub === baseUrl ? 'last-seen-ready' : 'last-seen-pending'}
                        sessions={sessions}
                        selectedSessionId={selectedSessionId}
                        onSelect={(sessionId) => navigate({
                            to: '/sessions/$sessionId',
                            params: { sessionId },
                        })}
                        onNewSession={() => navigate({ to: '/sessions/new' })}
                        onNewSessionInDirectory={handleNewSessionInDirectory}
                        onBrowse={canBrowse ? () => navigate({ to: '/browse' }) : undefined}
                        onRefresh={handleRefresh}
                        isLoading={isLoading}
                        renderHeader={false}
                        headerActions={(
                            <div className="flex items-center gap-2">
                                {canBrowse && (
                                    <button
                                        type="button"
                                        onClick={() => navigate({ to: '/browse' })}
                                        className="p-1.5 rounded-full text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                        title={t('browse.nav')}
                                    >
                                        <FolderOpenIcon className="h-5 w-5" />
                                    </button>
                                )}
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
                                    className="session-list-new-button flex h-9 w-9 items-center justify-center rounded-full text-[var(--app-link)] transition-colors"
                                    title={t('sessions.new')}
                                >
                                    <PlusIcon className="h-5 w-5" />
                                </button>
                            </div>
                        )}
                        api={api}
                        machineLabelsById={machineLabelsById}
                        machinesById={machinesById}
                    />
                </div>
            </div>

            {/* Resize handle - desktop only */}
            <div
                className="sidebar-resize-handle hidden split:block shrink-0"
                data-dragging={sidebar.isDragging || undefined}
                onPointerDown={sidebar.onPointerDown}
            />

            <div className={`${isSessionsIndex ? 'hidden split:flex' : 'flex'} min-w-0 flex-1 flex-col bg-[var(--app-bg)]`}>
                <div className="flex-1 min-h-0">
                    <Outlet />
                </div>
            </div>
            </div>
        </>
    )
}

function SessionsIndexPage() {
    return null
}

/**
 * Classify a thrown send error into a {message, code} pair the composer can
 * render.  `code` lets the consumer attach a recovery affordance (Reopen on
 * `session_inactive`) without re-inspecting the raw error.
 *
 * `request<T>` in the api client throws `ApiError` for !res.ok with `status`
 * and `code` parsed from the JSON body.  Older / non-JSON failures arrive as
 * plain `Error`; we surface those by their message verbatim, falling back to
 * a localized default when nothing usable is present (e.g. an aborted fetch
 * that resolved with no message).
 */
function classifySendError(
    error: unknown,
    t: (key: string) => string,
): { message: string; code: string | null } {
    if (error instanceof ApiError && error.status === 409 && error.code === 'session_inactive') {
        return { message: t('chat.sendError.sessionInactive'), code: 'session_inactive' }
    }
    if (error instanceof Error && error.message) {
        return { message: error.message, code: null }
    }
    return { message: t('chat.sendError.fallback'), code: null }
}

function SessionPage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const goBack = useAppGoBack()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const { addToast } = useToast()
    const { sessionId } = useParams({ from: '/sessions/$sessionId' })
    const { outline } = useSearch({ from: '/sessions/$sessionId' })
    const {
        session,
        error: sessionError,
        refetch: refetchSession,
    } = useSession(api, sessionId)
    const {
        status: cursorChatStoreStatus,
        isApplicable: cursorChatStoreApplicable,
        error: cursorChatStoreError,
    } = useCursorChatStoreStatus({ api, session })
    const {
        messages,
        warning: messagesWarning,
        isSyncingTail: messagesSyncingTail,
        isLoadingMore: messagesLoadingMore,
        hasMore: messagesHasMore,
        loadMore: loadMoreMessages,
        cancelLoadMore: cancelLoadMoreMessages,
        refetch: refetchMessages,
        viewMode: messagesViewMode,
        messagesVersion,
        historyVersion,
        setViewMode,
    } = useMessages(api, sessionId)

    // Tracks the most recent send the hub rejected (4xx/5xx/network), keyed
    // by the session the failed POST actually targeted (post-resolveSessionId).
    // assistant-ui clears the composer eagerly when a send is invoked, so to
    // retain the typed text on error we keep it here and hand it back to the
    // composer for restore + visual error affordance.  Keying by sessionId
    // covers the inactive-session resume race: useSendMessage can resolve
    // the target id, kick off async navigation to it, and then have the POST
    // fail before navigation completes.  Without keying, we'd restore the
    // text into the OLD session's composer and the next render would clear
    // it.  The bumped `id` still lets the composer dedupe restorations of
    // identical text.
    //
    // We persist the classifier `code` (not the bound action) so the
    // composer-visible action stays reactive to `reopeningSessionId` state
    // changes -- the action is built fresh on each render from {raw error
    // record} x {current reopen state}.  See classifySendError + the
    // Reopen affordance below.
    type RawSendError = {
        id: number
        text: string
        message: string
        code: string | null
        scheduledAt: number | null
        deliveryMode: MessageDeliveryMode
        mutationStarted: boolean
        restoreSuppressed: boolean
    }
    const [sendErrors, setSendErrors] = useState<Record<string, RawSendError>>({})
    const [reopeningSessionId, setReopeningSessionId] = useState<string | null>(null)
    const sendErrorIdRef = useRef(0)
    const clearSendError = useCallback(() => {
        setSendErrors((prev) => {
            if (!(sessionId in prev)) return prev
            const next = { ...prev }
            delete next[sessionId]
            return next
        })
    }, [sessionId])

    const suppressSendErrorRestore = useCallback((id: number) => {
        setSendErrors((prev) => {
            const current = prev[sessionId]
            if (!current || current.id !== id || current.restoreSuppressed) return prev
            return {
                ...prev,
                [sessionId]: { ...current, restoreSuppressed: true }
            }
        })
    }, [sessionId])

    // Reopen recovery (#918): one-click affordance attached to the inline
    // composer error when the rejected send was inactive-session.  Mirrors
    // SessionList's Reopen UX -- POST /sessions/:id/reopen via
    // api.reopenSession -- so the operator's mental model is consistent
    // across surfaces.  We do NOT auto-replay the send: per #917 the reopen
    // path has known fragility, so the operator re-clicks Send on the
    // restored composer text once Reopen lands.
    const reopenFromErrorAffordance = useCallback((errorSessionId: string) => {
        if (!api) return
        setReopeningSessionId((prev) => prev ?? errorSessionId)
        void (async () => {
            try {
                const result = await api.reopenSession(errorSessionId)
                // Clear the inline error -- the operator now has a live
                // session to retry against.
                setSendErrors((prev) => {
                    if (!(errorSessionId in prev)) return prev
                    const next = { ...prev }
                    delete next[errorSessionId]
                    return next
                })
                await queryClient.invalidateQueries({ queryKey: queryKeys.session(result.sessionId) })
                await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
                if (result.sessionId && result.sessionId !== errorSessionId) {
                    navigate({
                        to: '/sessions/$sessionId',
                        params: { sessionId: result.sessionId },
                        replace: true
                    })
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : t('dialog.error.default')
                addToast({
                    title: t('resume.failed.title'),
                    body: message,
                    sessionId: errorSessionId,
                    url: ''
                })
            } finally {
                setReopeningSessionId(null)
            }
        })()
    }, [api, queryClient, navigate, addToast, t])

    const cursorReopenDisabledReason = cursorChatStoreApplicable && cursorChatStoreStatus?.onDisk !== true
        ? cursorChatStoreError
            ? t('session.action.reopenCursorCheckFailed')
            : cursorChatStoreStatus?.onDisk === false
                ? t('session.action.reopenCursorMissing')
                : t('session.action.reopenCursorChecking')
        : undefined
    const canOfferInactiveReopen = session
        ? inactiveSessionCanResume(session, messages.length, cursorChatStoreStatus?.onDisk)
        : false
    const rawSendError = sendErrors[sessionId] ?? null
    const sendError: ComposerSendError | null = rawSendError
        ? {
            id: rawSendError.id,
            text: rawSendError.text,
            message: rawSendError.message,
            scheduledAt: rawSendError.scheduledAt,
            deliveryMode: rawSendError.deliveryMode,
            mutationStarted: rawSendError.mutationStarted,
            restoreSuppressed: rawSendError.restoreSuppressed,
            action: rawSendError.code === 'session_inactive' && canOfferInactiveReopen
                ? {
                    label: t('chat.sendError.sessionInactive.action'),
                    onClick: () => reopenFromErrorAffordance(sessionId),
                    pending: reopeningSessionId === sessionId
                }
                : null
        }
        : null

    const {
        sendMessage,
        retryMessage,
        isSending,
    } = useSendMessage(api, sessionId, {
        isSessionThinking: session?.thinking ?? false,
        onSuccess: (sentSessionId) => {
            clearDraftsAfterSend(sentSessionId, sessionId)
            // 中文注释：一旦用户已经在 Hapi 内继续这个 Codex 会话，就清除"刚从 Codex 导入"的标记。
            clearCodexImportedSession(session?.metadata?.codexSessionId)
            // A successful send supersedes any previously-rendered error
            // for that session.  Other sessions' errors stay put.
            setSendErrors((prev) => {
                if (!(sentSessionId in prev)) return prev
                const next = { ...prev }
                delete next[sentSessionId]
                return next
            })
        },
        onError: (info: SendErrorInfo) => {
            sendErrorIdRef.current += 1
            const { message, code } = classifySendError(info.error, t)
            setSendErrors((prev) => ({
                ...prev,
                [info.sessionId]: {
                    id: sendErrorIdRef.current,
                    text: info.text,
                    message,
                    code,
                    scheduledAt: info.scheduledAt,
                    deliveryMode: info.deliveryMode,
                    mutationStarted: info.mutationStarted,
                    restoreSuppressed: false,
                }
            }))
        },
        resolveSessionId: async (currentSessionId) => {
            if (!api || !session || session.active) {
                return currentSessionId
            }
            if (!inactiveSessionCanResume(session, messages.length, cursorChatStoreStatus?.onDisk)) {
                // #918: surface as a session_inactive ApiError so the
                // onError consumer's classifier renders the Reopen
                // affordance.  `status: 409` mirrors the hub guard for
                // structural parity; no HTTP call was made.
                throw new ApiError(
                    t('chat.sendError.sessionInactive'),
                    409,
                    'session_inactive',
                )
            }
            try {
                return await api.resumeSession(currentSessionId, { permissionMode: session.permissionMode ?? undefined })
            } catch (error) {
                const message = error instanceof Error ? error.message : t('dialog.error.default')
                addToast({
                    title: t('resume.failed.title'),
                    body: message,
                    sessionId: currentSessionId,
                    url: ''
                })
                // Rebrand as a session_inactive ApiError so the inline
                // affordance offers Reopen (a separate code path from the
                // failed Resume) and the operator has a recovery click.
                throw new ApiError(
                    t('chat.sendError.sessionInactive'),
                    409,
                    'session_inactive',
                )
            }
        },
        onSessionResolved: (resolvedSessionId) => {
            // A direct retry retains its old alert with restoreSuppressed=true.
            // Move it to the target session before navigation so the mutation's
            // onSuccess/onError can clear or replace the same record.
            setSendErrors((previous) => migrateSuppressedSendError(
                previous,
                sessionId,
                resolvedSessionId,
            ))
            void (async () => {
                if (api) {
                    if (session) {
                        if (resolvedSessionId !== session.id) {
                            seedMessageWindowFromSession(session.id, resolvedSessionId)
                        }
                        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
                    }
                    try {
                        await Promise.all([
                            queryClient.prefetchQuery({
                                queryKey: queryKeys.session(resolvedSessionId),
                                queryFn: () => api.getSession(resolvedSessionId),
                            }),
                            syncTailMessages(api, resolvedSessionId),
                        ])
                    } catch {
                    }
                    if (session) {
                        // 中文注释：恢复接口成功后，REST/SSE 可能仍有短暂竞态；最后再乐观置为在线，
                        // 避免刚 prefetch 到旧 inactive 快照导致状态栏继续显示离线。
                        queryClient.setQueryData(queryKeys.session(resolvedSessionId), (previous: { session?: typeof session } | undefined) => ({
                            session: { ...(previous?.session ?? session), id: resolvedSessionId, active: true }
                        }))
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
            // 'no-session' and 'pending' don't need toast - either invalid state or expected behavior
        }
    })

    // Get agent type from session metadata for slash commands
    const agentType = session?.metadata?.flavor ?? 'claude'
    const {
        commands: slashCommands,
        getSuggestions: getSlashSuggestions,
    } = useSlashCommands(api, sessionId, agentType)
    const {
        getSuggestions: getSkillSuggestions,
    } = useSkills(api, sessionId)
    // Same list + search matcher as sidebar / share picker (tiann/hapi#1213).
    const { sessions: allSessions } = useSessions(api)
    const { machines: mentionMachines } = useMachines(api, true)
    const mentionMachineLabelsById = useMachineLabels(mentionMachines)
    // Same fallbacks as share picker / SessionList search.
    const resolveMentionMachineLabel = useCallback((machineId: string | null) => {
        if (machineId && mentionMachineLabelsById[machineId]) {
            return mentionMachineLabelsById[machineId]
        }
        if (machineId) {
            return machineId.slice(0, 8)
        }
        return t('machine.unknown')
    }, [mentionMachineLabelsById, t])

    const getAutocompleteSuggestions = useCallback(async (query: string) => {
        if (query.startsWith('@')) {
            const search = query.slice(1)
            // v1: plain-text expansion (same grammar as Copy reference) — #1213.
            // v2: segmented rich composer with inline session tokens — #1215.
            // Match via sessionMatchesQuery (share/sidebar); label/insert via getSessionTitle.
            const sessionHits = matchSessionsForMention(allSessions, search, {
                excludeId: sessionId,
                limit: 20,
                resolveMachineLabel: resolveMentionMachineLabel,
            }).map((s) => {
                const title = getSessionTitle(s)
                const mentionText = buildSessionReferenceText(title, s.id)
                const idPrefix = s.id.slice(0, 8)
                return {
                    key: `session:${s.id}`,
                    text: mentionText,
                    label: `@${title || idPrefix}`,
                    description: s.active
                        ? `Session · ${idPrefix} · active`
                        : `Session · ${idPrefix}`,
                    // Rich composer atom; textarea path still inserts `text` prose.
                    sessionMention: { id: s.id, title: title || idPrefix },
                }
            })

            const fileHits: Suggestion[] = []
            if ((agentType === 'codex' || agentType === 'copilot') && api && sessionId) {
                const response = await api.searchSessionFiles(sessionId, search, 50)
                if (response.success && response.files) {
                    for (const file of response.files) {
                        // Codex App Server expects @"path"; Copilot CLI uses @path (relative preferred).
                        const mentionText = agentType === 'copilot'
                            ? `@${file.fullPath}`
                            : `@"${file.fullPath.replace(/(["\\])/g, '\\$1')}"`
                        fileHits.push({
                            key: mentionText,
                            text: mentionText,
                            label: `@${file.fileName}`,
                            description: file.filePath || file.fullPath,
                        })
                    }
                }
            }

            return [...sessionHits, ...fileHits]
        }
        if (query.startsWith('$')) {
            return await getSkillSuggestions(query)
        }
        return await getSlashSuggestions(query)
    }, [
        agentType,
        api,
        sessionId,
        allSessions,
        resolveMentionMachineLabel,
        getSkillSuggestions,
        getSlashSuggestions,
    ])

    const refreshSelectedSession = useCallback(() => {
        void refetchSession()
        void refetchMessages()
    }, [refetchMessages, refetchSession])

    const handleInitialOutlineConsumed = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId },
            replace: true,
        })
    }, [navigate, sessionId])

    if (!session) {
        if (sessionError) {
            return (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
                    <div className="text-sm font-medium text-[var(--app-fg)]">Session unavailable</div>
                    <div className="max-w-md text-xs text-[var(--app-hint)]">{sessionError}</div>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => navigate({ to: '/sessions', replace: true })}
                            className="rounded-md border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
                        >
                            Back to sessions
                        </button>
                        <button
                            type="button"
                            onClick={() => { void refetchSession() }}
                            className="rounded-md bg-[var(--app-button)] px-3 py-1.5 text-sm text-[var(--app-button-text)]"
                        >
                            Retry
                        </button>
                    </div>
                </div>
            )
        }
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
            cursorChatOnDisk={cursorChatStoreStatus?.onDisk}
            reopenDisabledReason={cursorReopenDisabledReason}
            messages={messages}
            messagesWarning={messagesWarning}
            hasMoreMessages={messagesHasMore}
            isSyncingTail={messagesSyncingTail}
            isLoadingMoreMessages={messagesLoadingMore}
            isSending={isSending}
            viewMode={messagesViewMode}
            messagesVersion={messagesVersion}
            historyVersion={historyVersion}
            onBack={goBack}
            onRefresh={refreshSelectedSession}
            onLoadMore={loadMoreMessages}
            onCancelLoadMore={cancelLoadMoreMessages}
            onSend={sendMessage}
            onViewModeChange={setViewMode}
            onRetryMessage={retryMessage}
            autocompleteSuggestions={getAutocompleteSuggestions}
            availableSlashCommands={slashCommands}
            sendError={sendError}
            onClearSendError={clearSendError}
            onSuppressSendErrorRestore={suppressSendErrorRestore}
            initialOutlineOpen={outline}
            onInitialOutlineConsumed={handleInitialOutlineConsumed}
            onAbortRestore={(text) => {
                sendErrorIdRef.current += 1
                setSendErrors((prev) => ({
                    ...prev,
                    [sessionId]: {
                        id: sendErrorIdRef.current,
                        text,
                        message: t('chat.sendError.aborted'),
                        code: 'abort',
                        scheduledAt: null,
                        deliveryMode: 'queue',
                        mutationStarted: true,
                        restoreSuppressed: false
                    }
                }))
            }}
        />
    )
}

function SessionDetailRoute() {
    const { api } = useAppContext()
    const pathname = useLocation({ select: location => location.pathname })
    const { sessionId } = useParams({ from: '/sessions/$sessionId' })
    const navigate = useNavigate()
    const { session, notFound: sessionNotFound } = useSession(api, sessionId)
    useSessionBrowserTitle(session)
    const basePath = `/sessions/${sessionId}`
    const isChat = pathname === basePath || pathname === `${basePath}/`
    const supersedingSessionId = getSupersedingSessionId(sessionId, session?.metadata)
    const observedSessionRef = useRef<{
        sessionId: string
        supersedingSessionId: string | null
    } | null>(null)

    useEffect(() => {
        if (!session) {
            return
        }
        const shouldFollow = shouldFollowSupersedingSession(
            observedSessionRef.current,
            sessionId,
            session.metadata
        )
        observedSessionRef.current = { sessionId, supersedingSessionId }
        if (!shouldFollow || !supersedingSessionId) return
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId: supersedingSessionId },
            replace: true
        })
    }, [navigate, session, sessionId, supersedingSessionId])

    useEffect(() => {
        if (!sessionNotFound) {
            return
        }
        navigate({ to: '/sessions', replace: true })
    }, [navigate, sessionNotFound, sessionId])

    if (sessionNotFound) {
        return (
            <div className="flex-1 flex items-center justify-center p-4">
                <LoadingState label="Session not found. Returning to sessions…" className="text-sm" />
            </div>
        )
    }

    return isChat ? <SessionPage /> : <Outlet />
}

function NewSessionPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const goBack = useAppGoBack()
    const queryClient = useQueryClient()
    const { machines, isLoading: machinesLoading, error: machinesError } = useMachines(api, true)
    const { t } = useTranslation()
    const { directory: initialDirectory, machineId: initialMachineId, shareTransferId } = newSessionRoute.useSearch()

    const handleCancel = useCallback(() => {
        if (shareTransferId) {
            void deleteShareTransfer(shareTransferId)
        }
        navigate({ to: '/sessions' })
    }, [navigate, shareTransferId])

    const handleSuccess = useCallback((sessionId: string) => {
        if (shareTransferId) {
            setSharePendingTransfer(shareTransferId)
        }
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
    }, [navigate, queryClient, shareTransferId])

    const handleChooseFolder = useCallback((args: { machineId: string | null; directory: string }) => {
        // Forward the currently-selected machine so /browse opens scoped to
        // it rather than falling back to `hapi:lastMachineId`, which can
        // disagree if the user changed machines without yet creating a
        // session. Preserve shareTransferId so a share-target spawn that
        // detours through /browse still seeds the composer after success.
        const search: { machineId?: string; shareTransferId?: string } = {}
        if (args.machineId) search.machineId = args.machineId
        if (shareTransferId) search.shareTransferId = shareTransferId
        navigate({ to: '/browse', search })
    }, [navigate, shareTransferId])

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

                <NewSession
                    api={api}
                    machines={machines}
                    isLoading={machinesLoading}
                    onCancel={handleCancel}
                    onSuccess={handleSuccess}
                    onChooseFolder={handleChooseFolder}
                    initialDirectory={initialDirectory}
                    initialMachineId={initialMachineId}
                />
            </div>
        </div>
    )
}

function BrowsePage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const goBack = useAppGoBack()
    const { machines, isLoading: machinesLoading } = useMachines(api, true)
    const { t } = useTranslation()
    const { machineId: initialMachineId, shareTransferId } = browseRoute.useSearch()

    const handleStartSession = useCallback((machineId: string, directory: string) => {
        navigate({
            to: '/sessions/new',
            search: shareTransferId
                ? { directory, machineId, shareTransferId }
                : { directory, machineId }
        })
    }, [navigate, shareTransferId])

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
                <div className="flex-1 font-semibold">{t('browse.title')}</div>
            </div>

            <div className="flex-1 min-h-0">
                <WorkspaceBrowser
                    api={api}
                    machines={machines}
                    machinesLoading={machinesLoading}
                    onStartSession={handleStartSession}
                    initialMachineId={initialMachineId}
                />
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
    validateSearch: (search: Record<string, unknown>): { outline?: boolean } => {
        const outline = search.outline === true || search.outline === 'true'
        return outline ? { outline: true } : {}
    },
    component: SessionDetailRoute,
})

const sessionFilesRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'files',
    validateSearch: (search: Record<string, unknown>): { tab?: 'changes' | 'directories'; query?: string } => {
        const tabValue = typeof search.tab === 'string' ? search.tab : undefined
        const tab = tabValue === 'directories'
            ? 'directories'
            : tabValue === 'changes'
                ? 'changes'
                : undefined
        const query = typeof search.query === 'string' && search.query.length > 0
            ? search.query
            : undefined

        return {
            ...(tab ? { tab } : {}),
            ...(query ? { query } : {}),
        }
    },
    component: FilesPage,
})

const sessionTerminalRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'terminal',
    component: TerminalPage,
})

type SessionFileSearch = {
    path: string
    staged?: boolean
    tab?: 'changes' | 'directories'
    query?: string
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
        const query = typeof search.query === 'string' && search.query.length > 0
            ? search.query
            : undefined

        const result: SessionFileSearch = { path }
        if (staged !== undefined) {
            result.staged = staged
        }
        if (tab !== undefined) {
            result.tab = tab
        }
        if (query !== undefined) {
            result.query = query
        }
        return result
    },
    component: FilePage,
})

type NewSessionSearch = {
    directory?: string
    machineId?: string
    shareTransferId?: string
}

const newSessionRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: 'new',
    validateSearch: (search: Record<string, unknown>): NewSessionSearch => {
        const result: NewSessionSearch = {}
        if (typeof search.directory === 'string' && search.directory) {
            result.directory = search.directory
        }
        if (typeof search.machineId === 'string' && search.machineId) {
            result.machineId = search.machineId
        }
        if (typeof search.shareTransferId === 'string' && search.shareTransferId) {
            result.shareTransferId = search.shareTransferId
        }
        return result
    },
    component: NewSessionPage,
})

const browseRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/browse',
    validateSearch: (search: Record<string, unknown>): { machineId?: string; shareTransferId?: string } => {
        const result: { machineId?: string; shareTransferId?: string } = {}
        if (typeof search.machineId === 'string' && search.machineId) {
            result.machineId = search.machineId
        }
        if (typeof search.shareTransferId === 'string' && search.shareTransferId) {
            result.shareTransferId = search.shareTransferId
        }
        return result
    },
    component: BrowsePage,
})

const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: SettingsLayout,
})

const settingsIndexRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: '/',
    component: SettingsHubPage,
})

const settingsGeneralRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'general',
    component: SettingsGeneralPage,
})

const settingsDisplayRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'display',
    component: SettingsDisplayPage,
})

const settingsChatRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'chat',
    component: SettingsChatPage,
})

const settingsVoiceRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'voice',
    component: SettingsVoicePage,
})

const settingsVoiceVoicesRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'voice/voices',
    component: SettingsVoiceVoicesPage,
})

const settingsVoiceAdvancedRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'voice/advanced',
    component: SettingsVoiceAdvancedPage,
})

const settingsMachinesRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'machines',
    component: SettingsMachinesPage,
})

const settingsAboutRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'about',
    component: SettingsAboutPage,
})

const settingsStorageRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'storage',
    component: SettingsStoragePage,
})

const settingsUsageRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'usage',
    component: SettingsUsagePage,
})

// Web Share Target landing route. Service worker (`web/src/sw.ts`)
// intercepts the manifest's `POST /share` and 303-redirects here with an
// IDB transfer id. `error=ingest` is set when the SW failed to write IDB.
const shareRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/share',
    validateSearch: (search: Record<string, unknown>): { id?: string; error?: string } => {
        const result: { id?: string; error?: string } = {}
        if (typeof search.id === 'string' && search.id) {
            result.id = search.id
        }
        if (typeof search.error === 'string' && search.error) {
            result.error = search.error
        }
        return result
    },
    component: SharePage,
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
    browseRoute,
    settingsRoute.addChildren([
        settingsIndexRoute,
        settingsGeneralRoute,
        settingsDisplayRoute,
        settingsChatRoute,
        settingsVoiceRoute,
        settingsVoiceVoicesRoute,
        settingsVoiceAdvancedRoute,
        settingsMachinesRoute,
        settingsStorageRoute,
        settingsUsageRoute,
        settingsAboutRoute,
    ]),
    shareRoute,
])

type RouterHistory = Parameters<typeof createRouter>[0]['history']

export function createAppRouter(history?: RouterHistory) {
    return createRouter({
        routeTree,
        history,
        scrollRestoration: true,
        getScrollRestorationKey,
    })
}

export type AppRouter = ReturnType<typeof createAppRouter>

declare module '@tanstack/react-router' {
    interface Register {
        router: AppRouter
    }
}
