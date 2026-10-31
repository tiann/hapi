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
    useRouter,
    useSearch,
} from '@tanstack/react-router'
import { getScrollRestorationKey } from '@/lib/scrollRestorationKey'
import {
    getSessionListSelectionNavigation,
    isSessionSidebarHidden,
    PRESERVE_SESSION_SIDEBAR_SCROLL,
    shouldShowSessionSidebar,
} from '@/lib/sessionNavigation'
import { App } from '@/App'
import { SessionChat } from '@/components/SessionChat'
import { SessionList } from '@/components/SessionList'
import { SessionsModeSwitch, type SessionsMode } from '@/components/SessionsModeSwitch'
import { BoardList } from '@/components/BoardList'
import { BoardItemDetail } from '@/components/BoardItemDetail'
import { resolveBoardItemDirectory } from '@/lib/resolveBoardItemDirectory'
import { buildBoardItemSpawnMessage } from '@/lib/boardItemSpawnMessage'
import { clearBoardSpawnBriefing, peekBoardSpawnBriefing, stashBoardSpawnBriefing } from '@/lib/boardSpawnBriefing'
import { deliverWithActivationRetry } from '@/lib/deliverWithActivationRetry'
import { isBoardItemDetailNavigation, isHistoryPopNavigation, shouldExitBoardsModeForNavigation } from '@/lib/sessionsBoardsModeSync'
import { consumeExplicitSessionNavigationIntent } from '@/lib/explicitSessionNavigationIntent'
import { isAbandoningSpawnFlow } from '@/lib/spawnFlowAbandonment'
import { parseIssueUrl } from '@hapi/protocol/schemas'
import { findBoardItemForIssue, findSessionLinkedToIssue, getLinkedGithubIssue, type BoardItemMatch } from '@/lib/externalRefs'
import { useLinkedIssueBoardItems } from '@/hooks/queries/useLinkedIssueBoardItems'
import { IssueBoardLinkContext, useIssueBoardLink } from '@/lib/issueBoardLinkContext'
import type { ExternalRef } from '@hapi/protocol/types'
import type { BoardItem } from '@/types/api'
import { SidebarShowButton } from '@/components/SidebarToggle'
import { NewSession } from '@/components/NewSession'
import { WorkspaceBrowser } from '@/components/WorkspaceBrowser'
import { LoadingState } from '@/components/LoadingState'
import { useAppContext } from '@/lib/app-context'
import { isOwnerNamespace } from '@/lib/namespace'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { isTelegramApp } from '@/hooks/useTelegram'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { useSplitViewport } from '@/hooks/useSplitViewport'
import { useMessages } from '@/hooks/queries/useMessages'
import { useMachines } from '@/hooks/queries/useMachines'
import { useMachineLabels } from '@/hooks/useMachineLabels'
import { useBoards } from '@/hooks/queries/useBoards'
import { useBoardItems } from '@/hooks/queries/useBoardItems'
import { useBoardAssignableUsers } from '@/hooks/queries/useBoardAssignableUsers'
import { useBoardItemComments } from '@/hooks/queries/useBoardItemComments'
import { useIssueTemplates } from '@/hooks/queries/useIssueTemplates'
import { useBoardSelection } from '@/hooks/useBoardSelection'
import { useBoardActions } from '@/hooks/mutations/useBoardActions'
import { useBoardItemActions } from '@/hooks/mutations/useBoardItemActions'
import { getApiErrorMessage } from '@/lib/apiErrorMessage'
import { useSession } from '@/hooks/queries/useSession'
import { useCursorChatStoreStatus } from '@/hooks/queries/useCursorChatStoreStatus'
import { useSessions } from '@/hooks/queries/useSessions'
import { useSlashCommands } from '@/hooks/queries/useSlashCommands'
import { useSkills } from '@/hooks/queries/useSkills'
import { getSessionTitle } from '@/lib/sessionTitle'
import { buildSessionReferenceText, matchSessionsForMention } from '@/lib/sessionReference'
import { createDeferredSuggestions } from '@/lib/deferredSuggestions'
import type { Suggestion, SuggestionRequestContext } from '@/hooks/useActiveSuggestions'
import { useSendMessage, type SendErrorInfo } from '@/hooks/mutations/useSendMessage'
import type { ComposerSendError } from '@/components/AssistantChat/HappyComposer'
import { ApiError } from '@/api/client'
import type { MessageDeliveryMode } from '@hapi/protocol'
import { queryKeys } from '@/lib/query-keys'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { seedMessageWindowFromSession, syncTailMessages } from '@/lib/message-window-store'
import { clearDraftsAfterSend } from '@/lib/clearDraftsAfterSend'
import { transferComposerDraftThenNavigate } from '@/lib/composer-draft-transfer'
import { getDraftAttachments } from '@/lib/composer-attachment-drafts'
import { refreshSessionDetailPreservingActive } from '@/lib/session-detail-optimistic'
import { inactiveSessionCanResume, resolveCursorReopenGate } from '@/lib/sessionResume'
import { isOnSessionPage, resolveVoiceSession } from '@/lib/dictationSend'
import { initializeSessionLastSeen } from '@/lib/sessionLastSeen'
import { useSelectedSessionSeen } from '@/hooks/useSelectedSessionSeen'
import { useSessionBrowserTitle } from '@/hooks/useSessionBrowserTitle'
import { clearCodexImportedSession } from '@/lib/codexImportedSessions'
import { getSupersedingSessionId, prepareFollowSupersedingSession, shouldFollowSupersedingSession } from '@/routes/sessions/followSupersedingSession'
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
import { retargetSharePendingTransfer, setSharePendingTransfer } from '@/lib/sharePendingState'
import { deleteShareTransfer, parseShareSearch } from '@/lib/shareTransfer'


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
    const { api, baseUrl, token, titleSuggestionAvailable = false } = useAppContext()
    const navigate = useNavigate()
    const router = useRouter()
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
    const isSessionsIndex = pathname === '/sessions' || pathname === '/sessions/'
    const sidebarSearch = useLocation({ select: location => location.search })
    const [isSidebarVisible, setIsSidebarVisible] = useState(
        () => shouldShowSessionSidebar(pathname, sidebarSearch)
    )
    useEffect(() => {
        if (isSessionsIndex) {
            setIsSidebarVisible(true)
        } else if (!shouldShowSessionSidebar(pathname, sidebarSearch)) {
            setIsSidebarVisible(false)
        }
    }, [isSessionsIndex, pathname, sidebarSearch])
    const sidebarHidden = !isSidebarVisible
    const shouldShowSidebar = isSessionsIndex || isSidebarVisible
    useEffect(() => {
        // Child routes and in-session actions can navigate without carrying
        // the parent session search state. Keep the chat-focused URL explicit
        // while this layout remains hidden so reloads do not restore the rail.
        if (isSessionsIndex || !sidebarHidden) return
        const { pathname: currentPathname, search, hash, state } = router.history.location
        const searchParams = new URLSearchParams(search)
        if (searchParams.get('sidebar') === 'hidden') return
        searchParams.set('sidebar', 'hidden')
        router.history.replace(
            `${currentPathname}?${searchParams.toString()}${hash}`,
            state,
        )
    }, [isSessionsIndex, pathname, router, sidebarHidden, sidebarSearch])
    const sidebar = useSidebarResize()
    const isSplitViewport = useSplitViewport()
    const [sessionsMode, setSessionsMode] = useState<SessionsMode>('sessions')
    // Every /api/todo-boards route 403s outside the owner namespace — hide
    // the switch itself rather than let a non-owner select it and land on a
    // permanent error (same pattern as the owner-only Settings categories).
    const isOwner = isOwnerNamespace(token)
    // Defensive: hiding the switch (below) only stops a non-owner from
    // ever *entering* To-Do mode. If the effective namespace changes away
    // from owner while already in it (a token refresh mid-session, say),
    // there would otherwise be no way back — every /api/todo-boards call
    // 403s and the switch that could flip back to Sessions mode is gone.
    useEffect(() => {
        if (!isOwner && sessionsMode === 'boards') {
            setSessionsMode('sessions')
        }
    }, [isOwner, sessionsMode])
    const {
        boards,
        isLoading: boardsLoading,
        isRefetching: boardsRefetching,
        error: boardsError,
        refetch: refetchBoards,
    } = useBoards(api, sessionsMode === 'boards')
    const { selectedBoardId, setSelectedBoardId } = useBoardSelection()
    const effectiveBoardId = useMemo(() => {
        if (selectedBoardId && boards.some(board => board.id === selectedBoardId)) {
            return selectedBoardId
        }
        return boards[0]?.id ?? null
    }, [selectedBoardId, boards])
    const {
        items: boardItems,
        statusOrder: boardStatusOrder,
        isLoading: boardItemsLoading,
        isRefetching: boardItemsRefetching,
        error: boardItemsError,
        refetch: refetchBoardItems,
    } = useBoardItems(api, sessionsMode === 'boards' ? effectiveBoardId : null)
    const { addBoard, removeBoard, createBoardItem } = useBoardActions(api)
    const {
        closeItem: closeBoardItem,
        reopenItem: reopenBoardItem,
        commentOnItem: commentOnBoardItem,
        setItemStatus: setBoardItemStatus,
        setItemAssignees: setBoardItemAssignees,
        closingUrls: closingBoardItemUrls,
        reopeningUrls: reopeningBoardItemUrls,
        commentingUrls: commentingOnBoardItemUrls,
        settingStatusUrls: settingBoardItemStatusUrls,
        settingAssigneesUrls: settingBoardItemAssigneesUrls,
    } = useBoardItemActions(api, effectiveBoardId)
    // `boardItem` is real router search-param state, not plain component
    // state (operator decision, Codex review, hapi#238) — selecting a board
    // item pushes a genuine, poppable history entry, so device/browser Back
    // returns to the board list instead of leaving Boards mode or the app
    // entirely. Masked to null outside Boards mode or against a board that
    // doesn't currently have that item (same self-correcting pattern
    // `selectedBoardItem` below already uses) rather than explicitly
    // resetting the URL on every mode/board switch — a stale `boardItem`
    // left over from a previous mode/board is simply never looked at again,
    // and any *real* navigation elsewhere (spawn, toast click, browser
    // back/forward) naturally lands on a URL that never included it in the
    // first place, so there's nothing to explicitly clean up either.
    const { boardItem: boardItemIdFromUrl } = useSearch({ from: '/sessions' })
    const selectedBoardItemId = sessionsMode === 'boards' ? (boardItemIdFromUrl ?? null) : null
    // Tags the onBeforeNavigate subscriber's very next event as "mine" so it
    // can unconditionally skip the exit-Boards check below, regardless of
    // push-vs-pop (Codex review, hapi#238): selecting/switching an item is
    // always a fresh push, but the detail pane's own Back button also routes
    // through here and must stay exempt without relying on history-index
    // comparisons at all — it's explicitly this component's own action, not
    // a browser/device Back and not an external "go to this session" link.
    const isOwnBoardItemNavigationRef = useRef(false)
    // Tracks the highest `__TSR_index` seen by the onBeforeNavigate
    // subscriber below, so it can tell a genuine Back/Forward (replaying an
    // already-stamped index) from a fresh push (always a new, higher index)
    // — see isHistoryPopNavigation's doc comment for why that distinction
    // matters here. Seeded from the router's *current* location at mount
    // (Codex review, hapi#238), not a hardcoded 0: a page loaded or reloaded
    // mid-session already has a real, possibly nonzero index, and a
    // subsequent genuine Back landing below that index must still be
    // recognized as a pop — a 0 baseline would misread any such Back as a
    // fresh push (0 is never "<=" a nonzero destination index) and exit
    // Boards mode instead of returning to the board list.
    const maxHistoryIndexRef = useRef(router.state.location.state.__TSR_index)
    const setSelectedBoardItemId = useCallback((id: string | null) => {
        isOwnBoardItemNavigationRef.current = true
        navigate({
            to: '.',
            search: (prev: Record<string, unknown>) => {
                if (!id) {
                    const { boardItem: _unused, ...rest } = prev
                    return rest
                }
                return { ...prev, boardItem: id }
            },
        })
    }, [navigate])
    const selectedBoardItem = useMemo(
        () => (selectedBoardItemId ? boardItems.find(item => item.id === selectedBoardItemId) ?? null : null),
        [selectedBoardItemId, boardItems]
    )
    // Gates the assignable-users fetch (design-consult review, hapi#238) —
    // only runs while the picker popover is actually open, not eagerly on
    // every render. Reset on item switch since BoardItemDetail remounts
    // (key={selectedBoardItem.id}) with its own popover starting closed —
    // without this, a picker left open on item A would keep this true while
    // viewing item B, firing a fetch for B nobody asked to see yet.
    const [assigneePickerOpen, setAssigneePickerOpen] = useState(false)
    const [assignableUsersSearch, setAssignableUsersSearch] = useState('')
    useEffect(() => {
        setAssigneePickerOpen(false)
        setAssignableUsersSearch('')
    }, [selectedBoardItemId])
    const {
        users: boardItemAssignableUsers,
        isLoading: boardItemAssignableUsersLoading,
        error: boardItemAssignableUsersError,
    } = useBoardAssignableUsers(api, effectiveBoardId, selectedBoardItem?.url ?? null, assigneePickerOpen, assignableUsersSearch)
    const {
        comments: boardItemComments,
        isLoading: boardItemCommentsLoading,
        isRefetching: boardItemCommentsRefetching,
        error: boardItemCommentsError,
        refetch: refetchBoardItemComments,
    } = useBoardItemComments(api, effectiveBoardId, selectedBoardItem?.url ?? null)
    // "New card" dialog state — same boundary as the assignee picker above:
    // BoardList stays presentational, this component owns the live
    // useIssueTemplates query keyed by dialog-open + repo-selection state it
    // tracks itself (hapi#238).
    const [newCardDialogOpen, setNewCardDialogOpen] = useState(false)
    const [newCardRepo, setNewCardRepo] = useState<string | null>(null)
    useEffect(() => {
        if (!newCardDialogOpen) setNewCardRepo(null)
    }, [newCardDialogOpen])
    const {
        templates: newCardTemplates,
        blankAllowed: newCardBlankAllowed,
        githubNewIssueUrl: newCardGithubNewIssueUrl,
        isLoading: newCardTemplatesLoading,
        error: newCardTemplatesError,
    } = useIssueTemplates(api, effectiveBoardId, newCardRepo, newCardDialogOpen)
    // Hidden behind the board list while in Boards mode with an item
    // selected (mobile *and* desktop, since BoardItemDetail then occupies the
    // right-pane slot) — marking it "seen" there would silently clear unread
    // state for messages the user never actually looked at. But Boards mode
    // with *no* item selected falls through to <Outlet/> in that same slot,
    // which still renders the previously-routed session chat underneath — on
    // the desktop split layout that pane stays visible regardless of mode
    // (only the single-pane mobile layout actually hides it), so seen
    // tracking must keep running there too, or messages visibly on screen
    // stay marked unread until the operator switches back to Sessions mode
    // (hapi#238 Codex review, two rounds: the first review caught over-eager
    // seen-tracking while the chat was genuinely hidden behind Boards mode;
    // this one caught the desktop-split case where it's hidden on mobile only).
    const isBoardChatVisibleInSplitView = sessionsMode === 'boards' && selectedBoardItem === null && isSplitViewport
    useSelectedSessionSeen(
        sessionsMode === 'sessions' || isBoardChatVisibleInSplitView ? selectedSessionId : null,
        selectedSession?.updatedAt
    )
    const linkedBoardSession = useMemo(
        () => findSessionLinkedToIssue(sessions, selectedBoardItem?.url ?? null),
        [sessions, selectedBoardItem]
    )
    const handleOpenLinkedBoardSession = useCallback((sessionId: string) => {
        // Explicit, not left to the onBeforeNavigate subscriber's
        // isBoardItemDetailNavigation exemption (Codex review, hapi#238):
        // if the linked session IS the one Boards is already overlaying,
        // this navigate() call is same-pathname with boardItem only on the
        // origin — structurally identical to closing the item detail via
        // Back, which that exemption deliberately keeps in Boards mode. But
        // "Open session" is a genuinely different, explicit action that must
        // always surface the chat, so it sets sessionsMode itself rather
        // than relying on navigation-shape inference to get it right.
        setSessionsMode('sessions')
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, setSessionsMode])
    // Reverse of linkedBoardSession/handleOpenLinkedBoardSession above — a
    // session's own linked-issue chip had no way to say "this issue is
    // tracked on a board," let alone jump there (operator follow-up to
    // hapi#238, via Fekko). Enabled only when at least one visible session
    // actually has a linked issue to resolve — most installs never link an
    // issue to a session at all, so this avoids fetching every configured
    // board's items on every Sessions-mode page load for nothing.
    const hasAnyLinkedIssueSession = useMemo(
        () => sessions.some(session => getLinkedGithubIssue(session.metadata) !== null),
        [sessions]
    )
    const linkedIssueBoardItems = useLinkedIssueBoardItems(api, hasAnyLinkedIssueSession)
    const getBoardMatchForIssue = useCallback(
        (ref: ExternalRef): BoardItemMatch | null => findBoardItemForIssue(linkedIssueBoardItems, ref.url),
        [linkedIssueBoardItems]
    )
    const handleOpenIssueBoardItem = useCallback((match: BoardItemMatch) => {
        // Explicit setSessionsMode + navigate, same reasoning as
        // handleOpenLinkedBoardSession's own comment above — this must
        // always surface Boards mode regardless of what the
        // onBeforeNavigate subscriber would otherwise infer.
        setSessionsMode('boards')
        setSelectedBoardId(match.boardId)
        isOwnBoardItemNavigationRef.current = true
        navigate({ to: '/sessions', search: { boardItem: match.itemId } })
    }, [navigate, setSessionsMode, setSelectedBoardId])
    // Handed down via IssueBoardLinkContext to whatever `<Outlet/>` renders
    // below (SessionPage -> SessionChat -> SessionHeader) — see that
    // module's doc comment for why this is a Context and not props.
    const issueBoardLinkContextValue = useMemo(
        () => ({ getBoardMatchForIssue, onOpenBoardItem: handleOpenIssueBoardItem }),
        [getBoardMatchForIssue, handleOpenIssueBoardItem]
    )
    // Item detail reuses the session-detail right-pane slot, so it needs the
    // same mobile show/hide signal `isSessionsIndex` drives for sessions —
    // but it's local state, not a route, so it has to opt in explicitly here
    // rather than coming from `pathname` for free. Branching on `sessionsMode`
    // (not `!isSessionsIndex || selectedBoardItem !== null`) matters: mode
    // switching never touches the URL, so a session route can still be live
    // underneath while the operator is in To-Do mode — without this branch,
    // switching to To-Do mode with no item selected yet would leave the
    // previous session's chat showing in the right pane on mobile instead of
    // the to-do list, since `isSessionsIndex` alone has no idea a mode
    // switch happened.
    const hasRightPaneContent = sessionsMode === 'boards' ? selectedBoardItem !== null : !isSessionsIndex
    // See shouldExitBoardsModeForNavigation's doc comment for why this reacts
    // to the navigation event itself rather than comparing selected-session
    // ids before/after. Flipping sessionsMode alone is enough here —
    // selectedBoardItemId is derived as null outside Boards mode regardless
    // of whatever boardItem value is still sitting in the URL, and the
    // navigation already in flight either carries no boardItem search param
    // forward at all (dropping it for free) or, for a genuine browser
    // back/forward, lands on exactly the history entry that didn't have it.
    // isBoardItemDetailNavigation exempts the remaining case: selecting,
    // switching, or closing (via the detail pane's own Back button, or
    // genuine browser/device Back) a board item's detail view while Boards
    // overlays an existing session route calls navigate() to a pathname
    // that's unchanged — exactly what this hook otherwise treats as
    // session-targeting (Codex review, hapi#238, second finding on this
    // path: the first pass only fixed one-segment routes, this one covers
    // the boardItem-search case the router-search fix itself introduced).
    //
    // That exemption alone is too broad (Codex review, hapi#238, third
    // finding): a toast or in-chat session link (ToastContainer,
    // SessionPathAnchor in markdown-text.tsx) targeting the *same* session
    // Boards is already overlaying with an item selected is event-shape-
    // identical to closing that item via Back — same pathname, `boardItem`
    // only on the origin — but it's a fresh push with a genuinely different
    // intent ("show me this session") and must still exit Boards mode. Two
    // extra signals narrow this down to exactly the cases that should stay
    // exempt: `isOwnBoardItemNavigationRef` tags this component's own
    // open/switch/close calls unconditionally (set in setSelectedBoardItemId
    // just before it navigates), and `isHistoryPopNavigation` recognizes a
    // genuine browser/device Back or Forward by its history index replaying
    // one already seen, rather than pushing a fresh one — which a toast or
    // markdown link's plain navigate() call never does.
    useEffect(() => {
        return router.subscribe('onBeforeNavigate', (event) => {
            const toIndex = event.toLocation.state.__TSR_index
            const isPop = isHistoryPopNavigation(toIndex, maxHistoryIndexRef.current)
            maxHistoryIndexRef.current = Math.max(maxHistoryIndexRef.current, toIndex)

            const isOwnBoardItemNavigation = isOwnBoardItemNavigationRef.current
            isOwnBoardItemNavigationRef.current = false
            if (isOwnBoardItemNavigation) return

            // Explicit signal wins over the pop/boardItem-search heuristic —
            // see explicitSessionNavigationIntent.ts's doc comment for why
            // the heuristic alone is unsound here (TanStack Router reuses
            // history indices after a Back + fresh push).
            const hasExplicitSessionIntent = consumeExplicitSessionNavigationIntent()
            if (!hasExplicitSessionIntent
                && isPop
                && isBoardItemDetailNavigation(event.pathChanged, event.fromLocation?.search ?? {}, event.toLocation.search)) {
                return
            }
            if (shouldExitBoardsModeForNavigation(event.toLocation.pathname, sessionsMode)) {
                setSessionsMode('sessions')
            }
        })
    }, [router, sessionsMode])
    const onlineMachineIds = useMemo(() => new Set(machines.map(m => m.id)), [machines])
    const handleSpawnFromBoardItem = useCallback((item: BoardItem) => {
        const resolved = resolveBoardItemDirectory(item.repo, sessions, onlineMachineIds)
        // Only attempt the auto-link for a real GitHub issue URL — board
        // items can also be pull requests or draft issues, and parseIssueUrl
        // only recognizes `/issues/<n>`. Linking a PR URL always 400s on the
        // hub, so skip it rather than spawn with a guaranteed failure toast
        // (hapi#238 Codex review; PR-kind refs are out of scope for now, see
        // ExternalRefSchema's doc comment in shared/src/schemas.ts).
        const linkIssueUrl = item.url && parseIssueUrl(item.url) ? item.url : undefined
        const briefingId = stashBoardSpawnBriefing({
            message: buildBoardItemSpawnMessage(item),
            linkIssueUrl,
            title: item.title
        })
        // `/sessions/new` is a sibling route under the same `/sessions`
        // parent, so SessionsPage never remounts — without switching back to
        // Sessions mode, `hasRightPaneContent` would keep gating on
        // `selectedBoardItem` and the right pane would keep rendering the
        // stale BoardItemDetail instead of <Outlet/> picking up the
        // new-session form; the URL would change but the screen wouldn't.
        // The navigate() call below already omits `boardItem` from its own
        // search object, so the item selection is dropped for free — no
        // separate clear needed.
        setSessionsMode('sessions')
        navigate({
            to: '/sessions/new',
            search: {
                ...(resolved ? { directory: resolved.directory } : {}),
                ...(resolved ? { machineId: resolved.machineId } : {}),
                briefingId,
            },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, sessions, onlineMachineIds, setSessionsMode])
    const handleSelectSession = useCallback((sessionId: string) => {
        navigate(getSessionListSelectionNavigation(
            sessionId,
            isSessionSidebarHidden(sidebarSearch) ? { sidebar: 'hidden' } : undefined,
        ))
    }, [navigate, sidebarSearch])
    const handleNewSessionInDirectory = useCallback((args: { machineId: string | null; directory: string }) => {
        navigate({
            to: '/sessions/new',
            search: args.machineId
                ? { directory: args.directory, machineId: args.machineId }
                : { directory: args.directory },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate])
    const showSidebar = useCallback(() => {
        if (!sidebarHidden) return
        setIsSidebarVisible(true)
        const { pathname: currentPathname, search, hash, state } = router.history.location
        const searchParams = new URLSearchParams(search)
        searchParams.delete('sidebar')
        const nextSearch = searchParams.toString()
        const nextHref = `${currentPathname}${nextSearch ? `?${nextSearch}` : ''}${hash}`
        router.history.replace(nextHref, state)
    }, [router, setIsSidebarVisible, sidebarHidden])

    return (
        <IssueBoardLinkContext.Provider value={issueBoardLinkContextValue}>
            <div className="flex h-full min-h-0">
            <div
                // min-w-0: without it, shrink-0 toolbar icons inflate the flex
                // item's min-content past --sidebar-w and the shed never sees a
                // tight budget (#2039 desktop overflow past the split).
                className={`${shouldShowSidebar ? (hasRightPaneContent ? 'hidden split:flex' : 'flex') : 'hidden'} min-w-0 w-full shrink-0 flex-col bg-[var(--app-bg)]`}
                style={{ '--sidebar-w': `${sidebar.width}px` } as React.CSSProperties}
            >
                <div className="flex min-h-0 flex-1 flex-col pt-[env(safe-area-inset-top)]">
                    {isOwner ? (
                        <div className="mx-auto w-full max-w-content shrink-0">
                            <SessionsModeSwitch mode={sessionsMode} onChange={setSessionsMode} />
                        </div>
                    ) : null}
                    {error && sessionsMode === 'sessions' ? (
                        <div className="mx-auto w-full max-w-content px-3 py-2">
                            <div className="text-sm text-red-600">{error}</div>
                        </div>
                    ) : null}
                    {sessionsMode === 'boards' ? (
                        <BoardList
                            boards={boards}
                            selectedBoardId={effectiveBoardId}
                            onSelectBoard={setSelectedBoardId}
                            onAddBoard={addBoard}
                            onRemoveBoard={removeBoard}
                            items={boardItems}
                            statusOrder={boardStatusOrder}
                            isLoading={boardsLoading || boardItemsLoading}
                            error={boardsError ?? boardItemsError}
                            selectedItemId={selectedBoardItemId}
                            onSelectItem={(item) => setSelectedBoardItemId(item.id)}
                            onRefresh={() => {
                                // The boards list must also be refetched, not
                                // just items — otherwise this button does
                                // nothing when an initial /todo-boards
                                // failure left no board loaded (Codex
                                // review). But `enabled: false` only gates
                                // *automatic* fetching, not a manually called
                                // `refetch()` — TanStack Query still runs the
                                // queryFn on a disabled query's refetch(),
                                // which throws "API unavailable" with no
                                // board id, replacing a valid empty-boards
                                // state with a false failure (Codex review,
                                // second pass). Only refetch items when a
                                // board actually exists to refetch.
                                void refetchBoards()
                                if (effectiveBoardId) {
                                    void refetchBoardItems()
                                }
                            }}
                            isRefreshing={boardsRefetching || boardItemsRefetching}
                            sessions={sessions}
                            onOpenSession={handleOpenLinkedBoardSession}
                            newCardDialogOpen={newCardDialogOpen}
                            onOpenNewCard={() => setNewCardDialogOpen(true)}
                            onCloseNewCard={() => setNewCardDialogOpen(false)}
                            issueTemplates={newCardTemplates}
                            issueTemplatesBlankAllowed={newCardBlankAllowed}
                            issueTemplatesGithubNewIssueUrl={newCardGithubNewIssueUrl}
                            isLoadingIssueTemplates={newCardTemplatesLoading}
                            issueTemplatesError={newCardTemplatesError}
                            onNewCardRepoChange={setNewCardRepo}
                            onCreateCard={(payload) => createBoardItem(effectiveBoardId ?? '', payload)}
                        />
                    ) : (
                    <SessionList
                        key={initializedHub === baseUrl ? 'last-seen-ready' : 'last-seen-pending'}
                        sessions={sessions}
                        selectedSessionId={selectedSessionId}
                        onSelect={handleSelectSession}
                        onNewSession={() => navigate({
                            to: '/sessions/new',
                            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
                        })}
                        onNewSessionInDirectory={handleNewSessionInDirectory}
                        onBrowse={canBrowse ? () => navigate({ to: '/browse' }) : undefined}
                        onRefresh={handleRefresh}
                        isLoading={isLoading}
                        // Keep ranks: new 4, unread lens 5, settings 6,
                        // mark-all 7, browse 8. Higher sheds into More first (#2039).
                        renderHeader
                        toolbarExtras={[
                            ...(canBrowse ? [{
                                id: 'browse',
                                keep: 8,
                                node: (
                                    <button
                                        type="button"
                                        onClick={() => navigate({ to: '/browse' })}
                                        className="p-1.5 rounded-full text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                        title={t('browse.nav')}
                                    >
                                        <FolderOpenIcon className="h-5 w-5" />
                                    </button>
                                )
                            }] : []),
                            {
                                id: 'settings',
                                keep: 6,
                                node: (
                                    <button
                                        type="button"
                                        onClick={() => navigate({ to: '/settings' })}
                                        className="p-1.5 rounded-full text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                        title={t('settings.title')}
                                    >
                                        <SettingsIcon className="h-5 w-5" />
                                    </button>
                                )
                            }
                        ]}
                        api={api}
                        titleSuggestionAvailable={titleSuggestionAvailable}
                        machineLabelsById={machineLabelsById}
                        machinesById={machinesById}
                        getBoardMatchForIssue={getBoardMatchForIssue}
                        onOpenBoardItem={handleOpenIssueBoardItem}
                    />
                    )}
                </div>
            </div>

            {shouldShowSidebar ? (
                <div
                    className="sidebar-resize-handle hidden split:block shrink-0"
                    data-dragging={sidebar.isDragging || undefined}
                    onPointerDown={sidebar.onPointerDown}
                />
            ) : null}

            <div className={`${hasRightPaneContent ? 'flex' : 'hidden split:flex'} relative min-w-0 flex-1 flex-col bg-[var(--app-bg)]`}>
                {!shouldShowSidebar ? (
                    <SidebarShowButton
                        showLabel={t('session.sidebar.show')}
                        onShow={showSidebar}
                    />
                ) : null}
                <div className="flex-1 min-h-0">
                    {selectedBoardItem ? (
                        <BoardItemDetail
                            // Remount on item switch — local state (comment draft, the
                            // close-confirm dialog's open flag) must not bleed from the
                            // previously-selected item onto the newly-selected one.
                            key={selectedBoardItem.id}
                            item={selectedBoardItem}
                            statusOrder={boardStatusOrder}
                            onBack={() => setSelectedBoardItemId(null)}
                            onSpawn={() => handleSpawnFromBoardItem(selectedBoardItem)}
                            linkedSessionId={linkedBoardSession?.id ?? null}
                            onOpenLinkedSession={handleOpenLinkedBoardSession}
                            onRefresh={() => {
                                void refetchBoardItems()
                                refetchBoardItemComments()
                            }}
                            isRefreshing={boardItemsRefetching || boardItemCommentsRefetching}
                            onClose={() => closeBoardItem(selectedBoardItem)}
                            onReopen={() => {
                                reopenBoardItem(selectedBoardItem).catch((err) => addToast({
                                    title: t('boards.detail.reopenFailed'),
                                    body: getApiErrorMessage(err, t('dialog.error.default')),
                                    sessionId: '',
                                    url: ''
                                }))
                            }}
                            onComment={(body) => {
                                return commentOnBoardItem(selectedBoardItem, body).catch((err) => {
                                    addToast({
                                        title: t('boards.detail.commentFailed'),
                                        body: getApiErrorMessage(err, t('dialog.error.default')),
                                        sessionId: '',
                                        url: ''
                                    })
                                    throw err
                                })
                            }}
                            comments={boardItemComments}
                            isLoadingComments={boardItemCommentsLoading}
                            commentsError={boardItemCommentsError}
                            onSetStatus={(status) => {
                                setBoardItemStatus(selectedBoardItem, status).catch((err) => addToast({
                                    title: t('boards.detail.statusChangeFailed'),
                                    body: getApiErrorMessage(err, t('dialog.error.default')),
                                    sessionId: '',
                                    url: ''
                                }))
                            }}
                            assignableUsers={boardItemAssignableUsers}
                            isLoadingAssignableUsers={boardItemAssignableUsersLoading}
                            assignableUsersError={boardItemAssignableUsersError}
                            onAssigneePickerOpenChange={setAssigneePickerOpen}
                            onAssignableUsersSearchChange={setAssignableUsersSearch}
                            onSetAssignees={(addLogins, removeLogins) => {
                                setBoardItemAssignees(selectedBoardItem, addLogins, removeLogins).catch((err) => addToast({
                                    title: t('boards.detail.assigneesChangeFailed'),
                                    body: getApiErrorMessage(err, t('dialog.error.default')),
                                    sessionId: '',
                                    url: ''
                                }))
                            }}
                            isClosing={selectedBoardItem.url !== null && closingBoardItemUrls.has(selectedBoardItem.url)}
                            isReopening={selectedBoardItem.url !== null && reopeningBoardItemUrls.has(selectedBoardItem.url)}
                            isCommenting={selectedBoardItem.url !== null && commentingOnBoardItemUrls.has(selectedBoardItem.url)}
                            isSettingStatus={selectedBoardItem.url !== null && settingBoardItemStatusUrls.has(selectedBoardItem.url)}
                            isSettingAssignees={selectedBoardItem.url !== null && settingBoardItemAssigneesUrls.has(selectedBoardItem.url)}
                        />
                    ) : (
                        <Outlet />
                    )}
                </div>
            </div>
            </div>
        </IssueBoardLinkContext.Provider>
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
    const { api, titleSuggestionAvailable = false } = useAppContext()
    const { t } = useTranslation()
    const issueBoardLink = useIssueBoardLink()
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
        isLoading: cursorChatStoreLoading,
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
        tailRevision,
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
                    retargetSharePendingTransfer(errorSessionId, result.sessionId)
                    await transferComposerDraftThenNavigate(
                        errorSessionId,
                        result.sessionId,
                        () => navigate({
                            to: '/sessions/$sessionId',
                            params: { sessionId: result.sessionId },
                            replace: true,
                            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
                        }),
                    )
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

    const cursorReopenGate = resolveCursorReopenGate({
        applicable: cursorChatStoreApplicable,
        onDisk: cursorChatStoreStatus?.onDisk,
        error: cursorChatStoreError,
        isLoading: cursorChatStoreLoading,
    })
    const cursorReopenDisabledReason = cursorReopenGate.disabledReason === 'missing'
        ? t('session.action.reopenCursorMissing')
        : cursorReopenGate.disabledReason === 'checking'
            ? t('session.action.reopenCursorChecking')
            : undefined
    const cursorReopenUnverifiedHint = cursorReopenGate.probeUnverified
        ? t('session.action.reopenCursorUnverified')
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

    const resolvedSessionRef = useRef<{ source: string; target: Promise<string> } | null>(null)
    // Clear when the session id or active flag changes so a same-id resume
    // that later archives again cannot reuse a stale in-flight/cached resume.
    useEffect(() => {
        resolvedSessionRef.current = null
    }, [session?.id, session?.active])
    const resolveSessionId = useCallback(async (currentSessionId: string) => {
        if (!api || !session || session.active) {
            return { sessionId: currentSessionId, resumed: false }
        }
        const cached = resolvedSessionRef.current
        if (cached?.source === currentSessionId) {
            return { sessionId: await cached.target, resumed: true }
        }
        if (!inactiveSessionCanResume(session, messages.length, cursorChatStoreStatus?.onDisk)) {
            throw new ApiError(
                t('chat.sendError.sessionInactive'),
                409,
                'session_inactive',
            )
        }
        try {
            const target = api.resumeSession(currentSessionId, { permissionMode: session.permissionMode ?? undefined })
            resolvedSessionRef.current = { source: currentSessionId, target }
            return { sessionId: await target, resumed: true }
        } catch (error) {
            if (resolvedSessionRef.current?.source === currentSessionId) {
                resolvedSessionRef.current = null
            }
            const message = error instanceof Error ? error.message : t('dialog.error.default')
            addToast({
                title: t('resume.failed.title'),
                body: message,
                sessionId: currentSessionId,
                url: ''
            })
            throw new ApiError(
                t('chat.sendError.sessionInactive'),
                409,
                'session_inactive',
            )
        }
    }, [api, session, messages.length, cursorChatStoreStatus?.onDisk, t, addToast])

    const handleSessionResolved = useCallback((resolvedSessionId: string) => {
        if (session) {
            if (resolvedSessionId !== session.id) {
                retargetSharePendingTransfer(session.id, resolvedSessionId)
                seedMessageWindowFromSession(session.id, resolvedSessionId)
            }
            queryClient.setQueryData(queryKeys.session(resolvedSessionId), (previous: { session?: typeof session } | undefined) => ({
                session: { ...(previous?.session ?? session), id: resolvedSessionId, active: true }
            }))
            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        }
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId: resolvedSessionId },
            replace: true,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
        if (api) {
            void refreshSessionDetailPreservingActive(
                queryClient,
                resolvedSessionId,
                () => api.getSession(resolvedSessionId),
            )
            void syncTailMessages(api, resolvedSessionId).catch(() => {})
        }
    }, [api, navigate, queryClient, session])

    const resolveVoiceSessionId = useCallback(async (currentSessionId: string) => {
        if (!api) throw new Error('API unavailable')
        return resolveVoiceSession(api, currentSessionId)
    }, [api])

    // Voice dictation direct-sends finish asynchronously after transcription
    // and may complete long after the operator navigated away (stopAndSend is
    // designed to survive unmount, #1435). Only navigate to the resumed
    // session when the operator is still on the source session's page;
    // otherwise the completed background send would yank them away from where
    // they moved. The router instance is stable and its state is read live at
    // callback time — a render-time pathname would be stale once the source
    // SessionPage unmounts.
    const router = useRouter()
    const handleVoiceSessionResolved = useCallback((resolvedSessionId: string) => {
        if (!isOnSessionPage(router.state.location.pathname, sessionId)) return
        handleSessionResolved(resolvedSessionId)
    }, [handleSessionResolved, router, sessionId])

    const {
        sendMessage,
        retryMessage,
        isSending,
        sendSettlement,
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
        resolveSessionId,
        onSessionResolved: async (resolvedSessionId, context) => {
            if (!sessionId) return undefined
            setSendErrors((prev) => migrateSuppressedSendError(prev, sessionId, resolvedSessionId))
            await transferComposerDraftThenNavigate(
                sessionId,
                resolvedSessionId,
                () => handleSessionResolved(resolvedSessionId),
                [],
                // assistant-ui clears composer text without awaiting this path;
                // keep the submitted snapshot so deferred hydration still has it.
                { textOverride: context.text },
            )
            // Cross-session resume: visible metadata may still carry source-scoped
            // upload paths, and inactive remounts hide stored files entirely.
            // Always defer so the active target can hydrate/re-upload before POST.
            const stored = await getDraftAttachments(resolvedSessionId)
            if ((context.attachments?.length ?? 0) > 0 || stored.length > 0) {
                return { deferUntilDraftHydrated: true }
            }
            return undefined
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
    // Mention pool is stricter than sidebar (#1506): titled sessions only; match via sessionMatchesQuery.
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

    const fileSuggestions = useMemo(() => createDeferredSuggestions(), [api, sessionId, agentType])

    const getAutocompleteSuggestions = useCallback(async (query: string, context: SuggestionRequestContext) => {
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

            if ((agentType === 'codex' || agentType === 'copilot') && api && sessionId) {
                return fileSuggestions(JSON.stringify([sessionId, agentType, search]), sessionHits, async () => {
                    const response = await api.searchSessionFiles(sessionId, search, 50, context.signal)
                    if (!response.success) throw new Error(response.error ?? 'File search failed')
                    const fileHits: Suggestion[] = []
                    if (response.files) {
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
                    return fileHits
                }, context)
            }
            return sessionHits
        }
        if (query.startsWith('$')) {
            return await getSkillSuggestions(query)
        }
        return await getSlashSuggestions(query)
    }, [
        agentType,
        fileSuggestions,
        api,
        sessionId,
        allSessions,
        resolveMentionMachineLabel,
        getSkillSuggestions,
        getSlashSuggestions,
    ])

    const refreshSelectedSession = useCallback(async () => {
        await Promise.all([
            refetchSession(),
            refetchMessages(),
        ])
    }, [refetchMessages, refetchSession])

    const handleInitialOutlineConsumed = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId },
            replace: true,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
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

    const linkedIssueBoardMatch = (() => {
        if (!issueBoardLink) return null
        const linkedIssue = getLinkedGithubIssue(session.metadata)
        return linkedIssue ? issueBoardLink.getBoardMatchForIssue(linkedIssue) : null
    })()

    return (
        <SessionChat
            api={api}
            titleSuggestionAvailable={titleSuggestionAvailable}
            session={session}
            cursorChatOnDisk={cursorChatStoreStatus?.onDisk}
            reopenDisabledReason={cursorReopenDisabledReason}
            reopenHint={cursorReopenUnverifiedHint}
            messages={messages}
            messagesWarning={messagesWarning}
            hasMoreMessages={messagesHasMore}
            isSyncingTail={messagesSyncingTail}
            isLoadingMoreMessages={messagesLoadingMore}
            isSending={isSending}
            sendSettlement={sendSettlement}
            viewMode={messagesViewMode}
            messagesVersion={messagesVersion}
            historyVersion={historyVersion}
            tailRevision={tailRevision}
            onBack={goBack}
            onRefresh={refreshSelectedSession}
            onLoadMore={loadMoreMessages}
            onCancelLoadMore={cancelLoadMoreMessages}
            onSend={sendMessage}
            linkedIssueBoardMatch={linkedIssueBoardMatch}
            onOpenBoardItem={issueBoardLink?.onOpenBoardItem}
            resolveSessionIdForUpload={async (id) => (await resolveSessionId(id)).sessionId}
            onUploadSessionResolved={handleSessionResolved}
            resolveSessionIdForVoice={resolveVoiceSessionId}
            onVoiceSessionResolved={handleVoiceSessionResolved}
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
        prepareFollowSupersedingSession(sessionId, supersedingSessionId)
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId: supersedingSessionId },
            replace: true,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, session, sessionId, supersedingSessionId])

    useEffect(() => {
        if (!sessionNotFound) {
            return
        }
        navigate({
            to: '/sessions',
            replace: true,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
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
    const router = useRouter()
    const queryClient = useQueryClient()
    const { machines, isLoading: machinesLoading, error: machinesError } = useMachines(api, true)
    const { t } = useTranslation()
    const { addToast } = useToast()
    const { directory: initialDirectory, machineId: initialMachineId, shareTransferId, briefingId } = newSessionRoute.useSearch()
    // Peek, not take — `handleChooseFolder` can round-trip through /browse
    // and back to this same route with the same briefingId before the
    // session is created, remounting this component each time.
    const briefing = useMemo(() => briefingId ? peekBoardSpawnBriefing(briefingId) : null, [briefingId])

    // Set synchronously (before the success navigate) so the generic
    // abandonment cleanup below skips the success path — `handleSuccess`
    // handles shareTransferId/briefingId itself, and differently: it marks
    // the share transfer as *completed into this session* (setSharePendingTransfer),
    // not deleted, so the receiving flow can still look it up. Deleting it
    // out from under that on the same navigate() call would break it.
    const spawnedRef = useRef(false)

    // Abandoning the spawn flow — by any means — must clean up the stash, or
    // a to-do item's briefing (private board content; the whole reason this
    // travels via sessionStorage instead of the URL) sits there indefinitely
    // and a later browser Forward can resurrect it in the composer (hapi#238
    // Codex review, two passes: the first only covered the explicit Cancel/
    // header-Back buttons, missing browser/device back-driven abandonment
    // entirely, since neither button's onClick runs for that). Subscribing
    // to the router's own navigation event covers every abandonment path
    // uniformly — explicit buttons, a toast/link click elsewhere, and
    // browser-history navigation alike — the same mechanism already proven
    // for exiting To-Do mode on any session-targeting navigation. `/browse`
    // is excluded: `handleChooseFolder`'s round-trip through it and back is
    // a deliberate continuation of this same spawn, not an abandonment.
    useEffect(() => {
        return router.subscribe('onBeforeNavigate', (event) => {
            if (spawnedRef.current) return
            const toSearch = event.toLocation.search as { briefingId?: unknown; shareTransferId?: unknown }
            if (!isAbandoningSpawnFlow('/sessions/new', event.toLocation.pathname, { briefingId, shareTransferId }, toSearch)) return
            if (shareTransferId) void deleteShareTransfer(shareTransferId)
            if (briefingId) clearBoardSpawnBriefing(briefingId)
        })
    }, [router, shareTransferId, briefingId])

    const handleCancel = useCallback(() => {
        navigate({
            to: '/sessions',
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate])

    // The header Back button calls the generic goBack (browser-history-aware,
    // not a hardcoded /sessions navigate) rather than handleCancel.
    const handleHeaderBack = useCallback(() => {
        goBack()
    }, [goBack])

    // Fires only for a genuine fresh spawn (NewSession's `onSessionCreated`,
    // its plain-create success path) — NOT the other three success paths
    // NewSession shares the same /sessions/new route with (Codex duplicate-
    // merge redirect, Codex-import resume, Pi-import reopen). Those are
    // unrelated operator actions reachable from the same page a board-spawn
    // navigated to; delivering the board's briefing to whatever session they
    // produce would send the wrong content to the wrong session, and the
    // duplicate-merge redirect target specifically can still be momentarily
    // inactive, which 400s on the messages route's requireActive guard
    // (Codex review, hapi#238).
    const handleBoardSpawnDelivery = useCallback((sessionId: string) => {
        if (briefing?.title && api) {
            // Without this the session keeps whatever default name it got at
            // creation — which for a board spawn is the generic briefing
            // instruction text, not the actual work (operator feedback,
            // 2026-10-27: "ensure that the title ... matches the purpose of
            // the work"). The agent can still rename it again later via its
            // own change_title tool; this just gives it a meaningful name
            // from the moment it's created instead of leaving that to chance.
            api.renameSession(sessionId, briefing.title).catch(() => {
                // Cosmetic only — the session is fully usable with its
                // default name, so this fails silently rather than adding a
                // third toast on top of the message/issue-link ones below.
            })
        }
        if (briefing?.message && api) {
            // Deliver as a real incoming message — same mechanism
            // spawn_peer/hapi-ping-peer use — instead of seeding the
            // composer draft for the operator to send themselves (operator
            // feedback, 2026-10-13: a left-unsent draft "defeats the point").
            // Fire-and-forget: a failed delivery shouldn't block the spawn
            // flow the operator is already mid-navigation through — the
            // session still exists and is usable, just without its briefing.
            // Retries through a brief session_inactive window (review
            // finding): the spawned CLI's socket can connect and send
            // session-alive slightly after the hub acks the spawn webhook,
            // so an immediate send can 409 even though the session is about
            // to be active within a second or two.
            deliverWithActivationRetry(() => api.sendMessage(sessionId, briefing.message)).catch(() => {
                addToast({
                    title: t('boards.detail.spawnMessageFailed'),
                    body: t('boards.detail.spawnMessageFailedBody'),
                    sessionId,
                    url: ''
                })
            })
        }
        const linkIssueUrl = briefing?.linkIssueUrl
        if (linkIssueUrl && api) {
            // Fire-and-forget: a failed link shouldn't block the spawn flow the
            // operator is already mid-navigation through. The session still
            // exists and is usable without its issue chip.
            api.linkIssue(sessionId, linkIssueUrl).catch(() => {
                addToast({
                    title: t('boards.detail.linkIssueFailed'),
                    body: t('boards.detail.linkIssueFailedBody', { url: linkIssueUrl }),
                    sessionId,
                    url: ''
                })
            })
        }
    }, [briefing, api, addToast, t])

    const handleSuccess = useCallback((sessionId: string) => {
        spawnedRef.current = true
        if (shareTransferId) {
            setSharePendingTransfer(shareTransferId, sessionId)
        }
        if (briefingId) {
            clearBoardSpawnBriefing(briefingId)
        }
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        // Replace current page with /sessions to clear spawn flow from history
        navigate({
            to: '/sessions',
            replace: true,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
        // Then navigate to new session
        requestAnimationFrame(() => {
            navigate({
                to: '/sessions/$sessionId',
                params: { sessionId },
                ...PRESERVE_SESSION_SIDEBAR_SCROLL,
            })
        })
    }, [navigate, queryClient, shareTransferId, briefing, briefingId, api, addToast, t])

    const handleChooseFolder = useCallback((args: { machineId: string | null; directory: string }) => {
        // Forward the currently-selected machine so /browse opens scoped to
        // it rather than falling back to `hapi:lastMachineId`, which can
        // disagree if the user changed machines without yet creating a
        // session. Preserve shareTransferId/briefingId so a share-target or
        // to-do spawn that detours through /browse still seeds the composer
        // (and auto-links its issue) after success.
        const search: { machineId?: string; shareTransferId?: string; briefingId?: string } = {}
        if (args.machineId) search.machineId = args.machineId
        if (shareTransferId) search.shareTransferId = shareTransferId
        if (briefingId) search.briefingId = briefingId
        navigate({ to: '/browse', search })
    }, [navigate, shareTransferId, briefingId])

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-bg)] p-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
                {!isTelegramApp() && (
                    <button
                        type="button"
                        onClick={handleHeaderBack}
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
                    onSessionCreated={handleBoardSpawnDelivery}
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
    const router = useRouter()
    const { machines, isLoading: machinesLoading } = useMachines(api, true)
    const { t } = useTranslation()
    const { machineId: initialMachineId, shareTransferId, briefingId } = browseRoute.useSearch()

    // Mirrors NewSessionPage's own cleanup — a to-do spawn's "Choose folder"
    // detour carries the same briefing/share-transfer into this route's own
    // search params, and abandoning from HERE (a toast click, browser back,
    // anything other than completing the round trip back to `/sessions/new`)
    // needs the same cleanup `/sessions/new` has, or the stash is orphaned
    // just as easily from this leg of the flow (Codex review).
    useEffect(() => {
        return router.subscribe('onBeforeNavigate', (event) => {
            const toSearch = event.toLocation.search as { briefingId?: unknown; shareTransferId?: unknown }
            if (!isAbandoningSpawnFlow('/browse', event.toLocation.pathname, { briefingId, shareTransferId }, toSearch)) return
            if (shareTransferId) void deleteShareTransfer(shareTransferId)
            if (briefingId) clearBoardSpawnBriefing(briefingId)
        })
    }, [router, shareTransferId, briefingId])

    const handleStartSession = useCallback((machineId: string, directory: string) => {
        navigate({
            to: '/sessions/new',
            search: {
                directory,
                machineId,
                ...(shareTransferId ? { shareTransferId } : {}),
                ...(briefingId ? { briefingId } : {}),
            }
        })
    }, [navigate, shareTransferId, briefingId])

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
    // `boardItem` lives on this parent route (not a leaf route) so it
    // survives regardless of which `/sessions/*` child is actually matched —
    // Boards mode renders over whatever route was active before it was
    // toggled on, not a route of its own (operator decision: represent
    // board-item selection in router history, not component state, so
    // browser/device Back returns to the board list instead of leaving
    // Boards mode or the app entirely — Codex review, hapi#238).
    validateSearch: (search: Record<string, unknown>): { boardItem?: string } => {
        return typeof search.boardItem === 'string' ? { boardItem: search.boardItem } : {}
    },
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
    validateSearch: (search: Record<string, unknown>): { outline?: boolean; sidebar?: 'hidden' } => {
        const outline = search.outline === true || search.outline === 'true'
        const sidebar = search.sidebar === 'hidden' ? 'hidden' : undefined
        return {
            ...(outline ? { outline: true } : {}),
            ...(sidebar ? { sidebar } : {}),
        }
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
    origin?: 'chat'
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
        const origin = search.origin === 'chat' ? 'chat' : undefined

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
        if (origin !== undefined) {
            result.origin = origin
        }
        return result
    },
    component: FilePage,
})

type NewSessionSearch = {
    directory?: string
    machineId?: string
    shareTransferId?: string
    // Opaque id into sessionStorage (see lib/boardSpawnBriefing.ts) — the
    // actual briefing text/issue URL never goes in the URL itself (hapi#238
    // Codex review: that leaked private board content into browser history
    // and access logs).
    briefingId?: string
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
        if (typeof search.briefingId === 'string' && search.briefingId) {
            result.briefingId = search.briefingId
        }
        return result
    },
    component: NewSessionPage,
})

const browseRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/browse',
    validateSearch: (search: Record<string, unknown>): { machineId?: string; shareTransferId?: string; briefingId?: string } => {
        const result: { machineId?: string; shareTransferId?: string; briefingId?: string } = {}
        if (typeof search.machineId === 'string' && search.machineId) {
            result.machineId = search.machineId
        }
        if (typeof search.shareTransferId === 'string' && search.shareTransferId) {
            result.shareTransferId = search.shareTransferId
        }
        if (typeof search.briefingId === 'string' && search.briefingId) {
            result.briefingId = search.briefingId
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
// Native / deep-link clients open `/share#url=&text=&title=` (fragment, not
// query) so shared content is never part of the HTTP request line.
const shareRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/share',
    validateSearch: (search: Record<string, unknown>) => parseShareSearch(search),
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
