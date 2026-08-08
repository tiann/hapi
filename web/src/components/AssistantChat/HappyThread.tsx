import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ThreadPrimitive, useAuiState } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { HappyRuntimeExtras } from '@/lib/assistant-runtime'
import type { Session, SessionMetadataSummary } from '@/types/api'
import type { ConversationOutlineItem } from '@/chat/outline'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { formatMessageTimestampTitle, formatOutlineTimestamp } from '@/chat/presentation'
import {
    HappyChatProvider,
    type OlderHistoryLoadResult
} from '@/components/AssistantChat/context'
import { HappyAssistantMessage } from '@/components/AssistantChat/messages/AssistantMessage'
import { HappyUserMessage } from '@/components/AssistantChat/messages/UserMessage'
import { HappySystemMessage } from '@/components/AssistantChat/messages/SystemMessage'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { useTerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import { useTranslation } from '@/lib/use-translation'
import { CloseIcon } from '@/components/icons'
import { ShareTurnDialog } from '@/components/AssistantChat/ShareTurnDialog'
import { getSessionModelLabel } from '@/lib/sessionModelLabel'
import { getSessionTitle } from '@/lib/sessionTitle'
import { isFastServiceTier } from '@/components/AssistantChat/codexFastMode'
import type { OlderLoadOutcome } from '@/lib/message-window-store'
import { useSessionHeaderMetadata } from '@/hooks/useSessionHeaderMetadata'
import { useMachines } from '@/hooks/queries/useMachines'
import { useMachineLabels } from '@/hooks/useMachineLabels'
import { resolveSessionHeaderMachineLabel } from '@/components/SessionHeader'
import { formatRelativeTime } from '@/lib/relativeTime'
import { formatSessionHeaderTimestamp } from '@/lib/sessionHeaderTimestamp'
import { getShareTurnReasoningLabel, selectShareTurnMetadata } from '@/lib/shareTurnMetadata'
import { useMinuteTick } from '@/hooks/useMinuteTick'

type ScrollAnchor = {
    id: string
    topOffset: number
}

type PendingScrollRestore = {
    runId: number
    anchor: ScrollAnchor | null
    scrollTop: number
    scrollHeight: number
    targetHistoryVersion: number | null
}

type HistoryLoadSource = 'coverage' | 'user' | 'consumer'
type PullToLoadState = 'idle' | 'pulling' | 'ready'

type HistoryLoaderState = {
    runId: number
    phase: 'idle' | 'loading' | 'backoff' | 'awaiting-render'
    source: HistoryLoadSource | null
    failureCount: number
    autoPaused: boolean
}

type ShareTurnState = {
    id: number
    snapshots: ShareTurnSnapshot[]
    sourceContentWidth: number | null
} | null

type ShareTurnSnapshot = {
    html: string
    text: string
    role?: 'user' | 'assistant'
}

export function isNestedScrollEvent(event: Event): boolean {
    const target = event.target
    const element = typeof Element !== 'undefined' && target instanceof Element
        ? target
        : typeof Node !== 'undefined' && target instanceof Node
            ? target.parentElement
            : null
    return element?.closest('[data-hapi-nested-scroll="true"]') != null
}

function findNearestMessageElement(content: HTMLElement, clientY?: number): HTMLElement | null {
    const messages = Array.from(content.querySelectorAll('.happy-thread-messages > [id]'))
        .filter((element): element is HTMLElement => element instanceof HTMLElement)
    if (messages.length === 0) return null
    if (typeof clientY !== 'number' || !Number.isFinite(clientY)) {
        return messages[messages.length - 1] ?? null
    }

    let best: HTMLElement | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const message of messages) {
        const rect = message.getBoundingClientRect()
        const distance = clientY < rect.top
            ? rect.top - clientY
            : clientY > rect.bottom
                ? clientY - rect.bottom
                : 0
        if (distance < bestDistance) {
            best = message
            bestDistance = distance
        }
    }
    return best
}

export function prependMissingUserSnapshot(
    snapshots: ShareTurnSnapshot[],
    fallbackSnapshot?: ShareTurnSnapshot
): ShareTurnSnapshot[] {
    const hasUser = snapshots.some((snapshot) =>
        snapshot.role === 'user' || snapshot.html.includes('data-hapi-message-role="user"')
    )
    if (hasUser || fallbackSnapshot?.role !== 'user' || fallbackSnapshot.text.trim().length === 0) {
        return snapshots
    }
    return [fallbackSnapshot, ...snapshots]
}

const MESSAGE_ANCHOR_SELECTOR = '.happy-thread-messages > [id]'
// Resume tail-following only once the user has actually reached the bottom.
// A wider proximity threshold makes a downward-reading user enter tail mode
// early; the next content/layout update then snaps the viewport to the end.
const AUTO_SCROLL_RESUME_THRESHOLD_PX = 1
const MANUAL_SCROLL_EPSILON_PX = 1
const INITIAL_SCROLL_SETTLE_MS = 1800
const INITIAL_SCROLL_SETTLE_DELAYS_MS = [0, 16, 50, 120, 250, 500, 900, 1400, 1800] as const
const HISTORY_PRELOAD_MARGIN_PX = 200
// Bounded backoff for the same logical history load. A failed page leaves the
// viewport geometry unchanged, so no new scroll/resize signal is guaranteed.
const COVERAGE_FAILURE_RETRY_DELAY_MS = 1000
const MAX_COVERAGE_LOAD_RETRIES = 3
// Show feedback early, but require a deliberate pull before release loads.
const TOP_PULL_FEEDBACK_PX = 16
const TOP_PULL_TRIGGER_PX = 64
// Silence between wheel events that marks the end of one upward gesture.
// Trackpads emit a burst per swipe; one signal is enough to restart a paused
// run after its bounded retry budget is exhausted.
const WHEEL_GESTURE_GAP_MS = 250
const KEYBOARD_SCROLL_INTENT_WINDOW_MS = 750
const POINTER_CANCEL_INTENT_WINDOW_MS = 750
const UPWARD_SCROLL_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])

export function getPullToLoadState(distancePx: number): PullToLoadState {
    if (distancePx >= TOP_PULL_TRIGGER_PX) {
        return 'ready'
    }
    if (distancePx >= TOP_PULL_FEEDBACK_PX) {
        return 'pulling'
    }
    return 'idle'
}

type ScrollIntent = {
    distanceFromBottom: number
    isNearBottom: boolean
    isScrollingUp: boolean
}

type LocateOutlineTargetOptions = {
    targetMessageId: string
    findTarget: (anchorId: string) => HTMLElement | null
    hasMoreMessages: () => boolean
    loadOlderPreservingScroll: () => Promise<boolean>
}

export function getScrollIntent(params: {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
    previousScrollTop: number
    thresholdPx?: number
}): ScrollIntent {
    const thresholdPx = params.thresholdPx ?? AUTO_SCROLL_RESUME_THRESHOLD_PX
    const distanceFromBottom = params.scrollHeight - params.scrollTop - params.clientHeight
    return {
        distanceFromBottom,
        isNearBottom: distanceFromBottom <= thresholdPx,
        isScrollingUp: params.scrollTop < params.previousScrollTop - MANUAL_SCROLL_EPSILON_PX
    }
}

export function shouldCancelInitialScrollSettling(
    intent: ScrollIntent,
    hasExplicitUpwardIntent: boolean
): boolean {
    return hasExplicitUpwardIntent
        && intent.isScrollingUp
        && intent.distanceFromBottom > MANUAL_SCROLL_EPSILON_PX
}

export function captureScrollAnchor(viewport: HTMLElement): ScrollAnchor | null {
    const viewportRect = viewport.getBoundingClientRect()
    const messages = Array.from(viewport.querySelectorAll<HTMLElement>(MESSAGE_ANCHOR_SELECTOR))
    for (const message of messages) {
        const rect = message.getBoundingClientRect()
        if (rect.bottom > viewportRect.top && rect.top < viewportRect.bottom) {
            return {
                id: message.id,
                topOffset: rect.top - viewportRect.top
            }
        }
    }
    return null
}

export function restoreScrollAnchor(viewport: HTMLElement, anchor: ScrollAnchor): boolean {
    const target = document.getElementById(anchor.id)
    if (!target || !viewport.contains(target)) {
        return false
    }
    const viewportRect = viewport.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    viewport.scrollTop += targetRect.top - viewportRect.top - anchor.topOffset
    return true
}

export function hasAppliedHistoryVersion(
    pendingHistoryVersion: number,
    appliedHistoryVersion: number
): boolean {
    return appliedHistoryVersion > pendingHistoryVersion
}

export async function locateOutlineTargetMessage(options: LocateOutlineTargetOptions): Promise<HTMLElement | null> {
    const anchorId = getConversationMessageAnchorId(options.targetMessageId)
    let target = options.findTarget(anchorId)
    while (!target && options.hasMoreMessages()) {
        const loaded = await options.loadOlderPreservingScroll()
        if (!loaded) {
            break
        }
        target = options.findTarget(anchorId)
    }
    return target
}

export function shouldLoadOlderForViewport(params: {
    scrollHeight: number
    clientHeight: number
    viewportTop: number
    sentinelTop: number
    sentinelBottom: number
    preloadMarginPx?: number
}): boolean {
    const preloadMarginPx = params.preloadMarginPx ?? HISTORY_PRELOAD_MARGIN_PX
    if (params.scrollHeight <= params.clientHeight + 1) {
        return true
    }
    return params.sentinelBottom >= params.viewportTop - preloadMarginPx
        && params.sentinelTop <= params.viewportTop + preloadMarginPx
}

export function getHistoryCoverageRetryDelay(deadline: number, now: number): number {
    return Math.max(0, deadline - now) + 16
}

function NewMessagesIndicator(props: { count: number; onClick: () => void }) {
    const { t } = useTranslation()
    if (props.count === 0) {
        return null
    }

    return (
        <button
            onClick={props.onClick}
            className="absolute bottom-20 left-1/2 -translate-x-1/2 bg-[var(--app-button)] text-[var(--app-button-text)] px-3 py-1.5 rounded-full text-sm font-medium shadow-lg animate-bounce-in z-10"
        >
            {t('misc.newMessage', { n: props.count })} &#8595;
        </button>
    )
}

function MessageSkeleton() {
    const { t } = useTranslation()
    const rows = [
        { align: 'end', width: 'w-2/3', height: 'h-10' },
        { align: 'start', width: 'w-3/4', height: 'h-12' },
        { align: 'end', width: 'w-1/2', height: 'h-9' },
        { align: 'start', width: 'w-5/6', height: 'h-14' }
    ]

    return (
        <div role="status" aria-live="polite">
            <span className="sr-only">{t('misc.loadingMessages')}</span>
            <div className="space-y-3 animate-pulse">
                {rows.map((row, index) => (
                    <div key={`skeleton-${index}`} className={row.align === 'end' ? 'flex justify-end' : 'flex justify-start'}>
                        <div className={`${row.height} ${row.width} rounded-xl bg-[var(--app-subtle-bg)]`} />
                    </div>
                ))}
            </div>
        </div>
    )
}

const THREAD_MESSAGE_COMPONENTS = {
    UserMessage: HappyUserMessage,
    AssistantMessage: HappyAssistantMessage,
    SystemMessage: HappySystemMessage
} as const

export function ConversationOutlinePanel(props: {
    items: readonly ConversationOutlineItem[]
    hasMoreMessages: boolean
    isLoadingMoreMessages: boolean
    onLoadMore: () => void
    onSelect: (item: ConversationOutlineItem) => void
    onClose: () => void
}) {
    const { t, locale } = useTranslation()
    const [searchQuery, setSearchQuery] = useState('')
    const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase()
    const filteredItems = useMemo(() => {
        if (normalizedSearchQuery.length === 0) {
            return props.items
        }
        return props.items.filter((item) => (
            item.label.toLocaleLowerCase().includes(normalizedSearchQuery)
        ))
    }, [normalizedSearchQuery, props.items])

    return (
        <aside
            className="absolute inset-y-0 right-0 z-30 flex w-full max-w-[24rem] flex-col bg-[var(--app-bg)] shadow-2xl sm:w-[24rem]"
            aria-label={t('session.outline.title')}
        >
            <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 -left-px w-px bg-[var(--app-border)]" />
            <div className="border-b border-[var(--app-border)] p-3">
                <div className="flex items-center gap-2">
                    <div className="relative min-w-0 flex-1">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--app-hint)]"
                            aria-hidden="true"
                        >
                            <circle cx="11" cy="11" r="8" />
                            <path d="m21 21-4.3-4.3" />
                        </svg>
                        <input
                            type="search"
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            placeholder={t('session.outline.searchPlaceholder')}
                            aria-label={t('session.outline.searchLabel')}
                            className="h-9 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] py-2 pl-9 pr-3 text-sm text-[var(--app-fg)] outline-none placeholder:text-[var(--app-hint)] focus:border-[var(--app-link)] focus:ring-1 focus:ring-[var(--app-link)]"
                        />
                    </div>
                    {props.hasMoreMessages ? (
                        <Button
                            variant="outline"
                            onClick={props.onLoadMore}
                            disabled={props.isLoadingMoreMessages}
                            aria-busy={props.isLoadingMoreMessages}
                            aria-label={props.isLoadingMoreMessages ? t('misc.loading') : t('session.outline.loadOlder')}
                            title={props.isLoadingMoreMessages ? t('misc.loading') : t('session.outline.loadOlder')}
                            className="h-9 w-9 shrink-0 px-0"
                        >
                            {props.isLoadingMoreMessages ? (
                                <Spinner size="sm" label={null} className="text-current" />
                            ) : (
                                <span className="text-base leading-none" aria-hidden="true">↑</span>
                            )}
                        </Button>
                    ) : null}
                    <Button
                        variant="outline"
                        type="button"
                        onClick={props.onClose}
                        aria-label={t('button.close')}
                        title={t('button.close')}
                        className="h-9 w-9 shrink-0 px-0"
                    >
                        <CloseIcon className="h-4 w-4" />
                    </Button>
                </div>
                {normalizedSearchQuery.length > 0 ? (
                    <div className="mt-1.5 text-right text-xs text-[var(--app-hint)]" aria-live="polite">
                        {t('session.outline.searchResults', {
                            matched: filteredItems.length,
                            total: props.items.length
                        })}
                    </div>
                ) : null}
            </div>

            <div className="app-scroll-y min-h-0 flex-1 p-2">
                {props.items.length === 0 ? (
                    <div className="px-2 py-8 text-center text-sm text-[var(--app-hint)]">
                        {t('session.outline.empty')}
                    </div>
                ) : filteredItems.length === 0 ? (
                    <div className="px-2 py-8 text-center text-sm text-[var(--app-hint)]">
                        {t('session.outline.noSearchResults')}
                    </div>
                ) : (
                    <div className="space-y-1">
                        {filteredItems.map((item) => {
                            const createdAt = new Date(item.createdAt)
                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    onClick={() => props.onSelect(item)}
                                    className="group block w-full min-w-0 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                >
                                    <span className="flex min-w-0 items-center gap-2 text-[11px] font-medium tabular-nums text-[var(--app-hint)]">
                                        <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--app-button)]" aria-hidden="true" />
                                        <time
                                            dateTime={createdAt.toISOString()}
                                            title={formatMessageTimestampTitle(createdAt)}
                                            className="truncate"
                                        >
                                            {formatOutlineTimestamp(createdAt, locale)}
                                        </time>
                                    </span>
                                    <span className="mt-0.5 line-clamp-2 pl-4 text-sm leading-snug text-[var(--app-fg)]">
                                        {item.label}
                                    </span>
                                </button>
                            )
                        })}
                    </div>
                )}
            </div>
        </aside>
    )
}

export function HappyThread(props: {
    api: ApiClient
    session: Session
    serviceTier?: string | null
    sessionId: string
    metadata: SessionMetadataSummary | null
    disabled: boolean
    onRefresh: () => void
    onRetryMessage?: (localId: string) => void
    historyActionPending?: boolean
    onForkConversation?: (messageLocalId?: string) => Promise<void>
    onRewindConversation?: (messageLocalId: string) => Promise<void>
    isLatestCompletedBoundary?: (messageId: string) => boolean
    onViewModeChange: (mode: 'tail' | 'history') => void
    isSyncingTail: boolean
    messagesWarning: string | null
    hasMoreMessages: boolean
    isLoadingMoreMessages: boolean
    onLoadMore: (onBeforeApply?: (historyVersion: number) => boolean) => Promise<OlderLoadOutcome>
    onCancelLoadMore: () => void
    unseenCount: number
    rawMessagesCount: number
    normalizedMessagesCount: number
    messagesVersion: number
    historyVersion: number
    forceScrollToken: number
    outlineOpen: boolean
    outlineItems: readonly ConversationOutlineItem[]
    onOutlineOpenChange: (open: boolean) => void
    onOutlineItemClick?: (item: ConversationOutlineItem) => void
}) {
    const { t, locale } = useTranslation()
    const { preferences: headerMetadata } = useSessionHeaderMetadata()
    const { machines } = useMachines(props.api, true)
    const machineLabelsById = useMachineLabels(machines)
    const [shareTurn, setShareTurn] = useState<ShareTurnState>(null)
    const shareDialogOpen = shareTurn !== null
    const shareTitle = shareTurn ? getSessionTitle(props.session) : ''
    const shareRelativeTimeTick = useMinuteTick(headerMetadata.lastActive && shareDialogOpen)
    const shareMetadataItems = useMemo(() => {
        const agentFlavor = props.session.metadata?.flavor ?? null
        const agentLabel = agentFlavor?.trim() || null
        const machineLabel = resolveSessionHeaderMachineLabel(props.session, machineLabelsById)
        const modelLabel = getSessionModelLabel(props.session)
        const reasoningLabel = getShareTurnReasoningLabel(
            agentFlavor,
            props.session.modelReasoningEffort,
            props.session.effort,
            headerMetadata.showLabels
        )
        const lastActiveAt = props.session.activeAt || props.session.updatedAt || props.session.createdAt
        const lastActiveLabel = lastActiveAt > 0 ? formatRelativeTime(lastActiveAt, t) : null
        const createdAtLabel = formatSessionHeaderTimestamp(props.session.createdAt, locale)
        const updatedAtLabel = formatSessionHeaderTimestamp(props.session.updatedAt, locale)
        const worktreeBranch = props.session.metadata?.worktree?.branch?.trim() || null
        const showFastBadge = agentFlavor === 'codex'
            && isFastServiceTier(props.serviceTier ?? props.session.serviceTier)

        return selectShareTurnMetadata(headerMetadata, {
            agent: agentLabel ? { text: agentLabel, flavor: agentFlavor } : undefined,
            machine: machineLabel ? {
                text: `${headerMetadata.showLabels ? `${t('session.item.machine')}: ` : ''}${machineLabel}`,
            } : undefined,
            lastActive: lastActiveLabel ? { text: lastActiveLabel } : undefined,
            model: modelLabel ? {
                text: `${headerMetadata.showLabels ? `${t(modelLabel.key)}: ` : ''}${modelLabel.value}`,
            } : undefined,
            reasoning: reasoningLabel ? { text: reasoningLabel } : undefined,
            fastMode: showFastBadge ? { text: 'fast' } : undefined,
            createdAt: createdAtLabel ? {
                text: `${headerMetadata.showLabels ? `${t('session.header.createdAt')}: ` : ''}${createdAtLabel}`,
            } : undefined,
            updatedAt: updatedAtLabel ? {
                text: `${headerMetadata.showLabels ? `${t('session.header.updatedAt')}: ` : ''}${updatedAtLabel}`,
            } : undefined,
            worktree: worktreeBranch ? {
                text: `${headerMetadata.showLabels ? `${t('session.item.worktree')}: ` : ''}${worktreeBranch}`,
            } : undefined,
        })
    }, [headerMetadata, locale, machineLabelsById, props.serviceTier, props.session, shareDialogOpen, shareRelativeTimeTick, t])
    const { terminalToolDisplayMode } = useTerminalToolDisplayMode()
    const runtimeExtras = useAuiState((s) => s.thread.extras) as HappyRuntimeExtras | undefined
    const appliedMessagesVersion = runtimeExtras?.messagesVersion ?? props.messagesVersion
    const appliedHistoryVersion = runtimeExtras?.historyVersion ?? props.historyVersion
    const viewportRef = useRef<HTMLDivElement | null>(null)
    const contentRef = useRef<HTMLDivElement | null>(null)
    const [pullToLoadState, setPullToLoadState] = useState<PullToLoadState>('idle')
    const pullToLoadStateRef = useRef<PullToLoadState>('idle')
    const shareTurnIdRef = useRef(0)
    const topSentinelRef = useRef<HTMLDivElement | null>(null)
    const pendingScrollRef = useRef<PendingScrollRestore | null>(null)
    const isLoadingMoreRef = useRef(props.isLoadingMoreMessages)
    const hasMoreMessagesRef = useRef(props.hasMoreMessages)
    const isSyncingTailRef = useRef(props.isSyncingTail)
    const onLoadMoreRef = useRef(props.onLoadMore)
    const onCancelLoadMoreRef = useRef(props.onCancelLoadMore)
    const pendingLoadPromiseRef = useRef<Promise<OlderHistoryLoadResult> | null>(null)
    const pendingLoadResolveRef = useRef<((value: OlderHistoryLoadResult) => void) | null>(null)
    const coverageCheckTimerRef = useRef<number | null>(null)
    const failureRetryTimerRef = useRef<number | null>(null)
    const tailScrollInProgressRef = useRef(false)
    const historyLoaderRef = useRef<HistoryLoaderState>({
        runId: 0,
        phase: 'idle',
        source: null,
        failureCount: 0,
        autoPaused: false
    })

    useLayoutEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) return

        const updateScrollbarGutter = () => {
            const supportsStableBothEdges = typeof CSS !== 'undefined'
                && typeof CSS.supports === 'function'
                && CSS.supports('scrollbar-gutter: stable both-edges')
            const gutter = supportsStableBothEdges
                ? Math.max(0, (viewport.offsetWidth - viewport.clientWidth) / 2)
                : 0
            viewport.style.setProperty('--chat-scroll-gutter-inline', `${gutter}px`)
        }

        updateScrollbarGutter()
        if (typeof ResizeObserver === 'undefined') return

        const observer = new ResizeObserver(updateScrollbarGutter)
        observer.observe(viewport)
        return () => observer.disconnect()
    }, [])
    const requestOlderRef = useRef<(source: HistoryLoadSource) => Promise<OlderHistoryLoadResult>>(
        () => Promise.resolve('transient-stop')
    )
    const startHistoryLoadAttemptRef = useRef<(runId: number) => void>(() => {})
    const needsViewportCoverageRef = useRef<() => boolean>(() => false)
    const atBottomRef = useRef(true)
    const onViewModeChangeRef = useRef(props.onViewModeChange)
    const forceScrollTokenRef = useRef(props.forceScrollToken)
    const lastScrollTopRef = useRef(0)
    const sessionIdRef = useRef(props.sessionId)
    const initialScrollSessionRef = useRef<string | null>(null)
    const initialScrollDeadlineRef = useRef(0)
    const initialScrollTimersRef = useRef<number[]>([])

    // Smart scroll state: enabled only while the user is intentionally at the bottom.
    const autoScrollEnabledRef = useRef(true)
    useEffect(() => {
        onViewModeChangeRef.current = props.onViewModeChange
    }, [props.onViewModeChange])
    useEffect(() => {
        hasMoreMessagesRef.current = props.hasMoreMessages
    }, [props.hasMoreMessages])
    useEffect(() => {
        isSyncingTailRef.current = props.isSyncingTail
    }, [props.isSyncingTail])
    useEffect(() => {
        onLoadMoreRef.current = props.onLoadMore
    }, [props.onLoadMore])
    useEffect(() => {
        onCancelLoadMoreRef.current = props.onCancelLoadMore
    }, [props.onCancelLoadMore])

    useEffect(() => {
        sessionIdRef.current = props.sessionId
    }, [props.sessionId])

    const isInitialScrollSettling = useCallback(() => {
        return initialScrollSessionRef.current === sessionIdRef.current && Date.now() < initialScrollDeadlineRef.current
    }, [])

    const clearInitialScrollTimers = useCallback(() => {
        for (const timer of initialScrollTimersRef.current) {
            window.clearTimeout(timer)
        }
        initialScrollTimersRef.current = []
    }, [])

    const clearCoverageCheckTimer = useCallback(() => {
        if (coverageCheckTimerRef.current !== null) {
            window.clearTimeout(coverageCheckTimerRef.current)
            coverageCheckTimerRef.current = null
        }
    }, [])

    const clearFailureRetryTimer = useCallback(() => {
        if (failureRetryTimerRef.current !== null) {
            window.clearTimeout(failureRetryTimerRef.current)
            failureRetryTimerRef.current = null
        }
    }, [])

    const settlePendingLoad = useCallback((result: OlderHistoryLoadResult) => {
        const resolve = pendingLoadResolveRef.current
        pendingLoadResolveRef.current = null
        pendingLoadPromiseRef.current = null
        resolve?.(result)
    }, [])

    const cancelActiveHistoryLoad = useCallback(() => {
        const state = historyLoaderRef.current
        // `awaiting-render` is pre-armed by onBeforeApply and published with an
        // immediate store notification, so browser input cannot observe the
        // old DOM after trimming. Only network/backoff work is cancellable.
        if (
            state.source === 'consumer'
            || (state.phase !== 'loading' && state.phase !== 'backoff')
        ) {
            return
        }
        onCancelLoadMoreRef.current()
        isLoadingMoreRef.current = false
        pendingScrollRef.current = null
        clearCoverageCheckTimer()
        clearFailureRetryTimer()
        historyLoaderRef.current = {
            ...state,
            runId: state.runId + 1,
            phase: 'idle',
            source: null,
            failureCount: 0,
            autoPaused: true
        }
        settlePendingLoad('transient-stop')
    }, [clearCoverageCheckTimer, clearFailureRetryTimer, settlePendingLoad])

    // Track scroll position to toggle autoScroll (stable listener using refs)
    useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) return

        lastScrollTopRef.current = viewport.scrollTop

        const setAutoScrollMode = (enabled: boolean) => {
            if (autoScrollEnabledRef.current === enabled) {
                return
            }
            autoScrollEnabledRef.current = enabled
        }

        const setAtBottomMode = (atBottom: boolean) => {
            if (atBottom === atBottomRef.current) {
                return
            }
            atBottomRef.current = atBottom
            onViewModeChangeRef.current(atBottom ? 'tail' : 'history')
        }

        let pointerResumeActive = false
        let pointerResumeUntil = 0
        let pointerResumeLatched = false
        let keyboardResumeUntil = 0
        let lastWheelAt = 0
        let wheelIntentUntil = 0
        let wheelLatched = false

        const hasExplicitUpwardIntent = (intent: ScrollIntent): boolean => {
            return intent.isScrollingUp && (
                pointerResumeActive
                || pointerResumeUntil >= Date.now()
                || keyboardResumeUntil >= Date.now()
                || wheelIntentUntil >= Date.now()
            )
        }

        const consumeExplicitUpwardIntent = (intent: ScrollIntent): boolean => {
            if (!hasExplicitUpwardIntent(intent)) {
                return false
            }
            if ((pointerResumeActive || pointerResumeUntil >= Date.now()) && !pointerResumeLatched) {
                pointerResumeLatched = true
                return true
            }
            if (keyboardResumeUntil >= Date.now()) {
                keyboardResumeUntil = 0
                return true
            }
            if (wheelIntentUntil >= Date.now() && !wheelLatched) {
                wheelLatched = true
                return true
            }
            return false
        }

        const handleScroll = () => {
            const intent = getScrollIntent({
                scrollTop: viewport.scrollTop,
                scrollHeight: viewport.scrollHeight,
                clientHeight: viewport.clientHeight,
                previousScrollTop: lastScrollTopRef.current
            })
            lastScrollTopRef.current = viewport.scrollTop

            // A slow older-page request must not restore the position from
            // when it started after the user has already scrolled elsewhere.
            // Keep the pending baseline aligned with the latest visible row;
            // the eventual prepend will preserve that row instead.
            const pending = pendingScrollRef.current
            if (pending && historyLoaderRef.current.runId === pending.runId) {
                pending.anchor = captureScrollAnchor(viewport)
                pending.scrollTop = viewport.scrollTop
                pending.scrollHeight = viewport.scrollHeight
            }

            const needsCoverage = needsViewportCoverageRef.current()
            if (!needsCoverage) {
                // Older pages retain the oldest side of the bounded window.
                // Once the user reverses toward newer history, applying this
                // request could evict their new anchor. Invalidate it instead;
                // a later fresh approach can request the page again.
                cancelActiveHistoryLoad()
            }
            // Keep the keyboard/pointer intent armed while the user moves
            // through ordinary history. Consume it only when the viewport
            // actually reaches the preload area.
            const hadExplicitUpwardIntent = hasExplicitUpwardIntent(intent)
            const explicitUpwardIntent = needsCoverage && consumeExplicitUpwardIntent(intent)

            if (isInitialScrollSettling()) {
                if (shouldCancelInitialScrollSettling(intent, hadExplicitUpwardIntent)) {
                    initialScrollDeadlineRef.current = 0
                    clearInitialScrollTimers()
                    setAutoScrollMode(false)
                    setAtBottomMode(false)
                    if (explicitUpwardIntent) {
                        void requestOlderRef.current('user')
                    }
                }
                return
            }

            // Scroll position is the source of truth. The loader controller
            // decides whether this demand may start a request; programmatic
            // scroll events cannot bypass backoff or a paused coverage run.
            if (needsCoverage) {
                void requestOlderRef.current(explicitUpwardIntent ? 'user' : 'coverage')
            }

            if (intent.isScrollingUp && intent.distanceFromBottom > MANUAL_SCROLL_EPSILON_PX) {
                tailScrollInProgressRef.current = false
                setAutoScrollMode(false)
                setAtBottomMode(false)
                return
            }

            if (intent.isNearBottom) {
                tailScrollInProgressRef.current = false
                setAutoScrollMode(true)
                setAtBottomMode(true)
                return
            }

            // An explicit jump-to-tail uses native smooth scrolling. Its
            // intermediate scroll events are still far from the bottom and
            // must not be mistaken for ordinary history browsing. Keep tail
            // mode armed until the animation arrives or the user reverses it.
            if (tailScrollInProgressRef.current) {
                return
            }

            setAutoScrollMode(false)
            setAtBottomMode(false)
        }

        // Gesture fallback: at scrollTop=0 no further scroll events fire. Give
        // touch users progressive feedback, then load only when they release
        // after crossing the threshold.
        let pullStartY: number | null = null

        const updatePullToLoadState = (state: PullToLoadState) => {
            if (pullToLoadStateRef.current === state) {
                return
            }
            pullToLoadStateRef.current = state
            setPullToLoadState(state)
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (isNestedScrollEvent(event)) return
            const target = event.target
            if (
                event.defaultPrevented
                || event.repeat
                || event.altKey
                || event.ctrlKey
                || event.metaKey
                || !UPWARD_SCROLL_KEYS.has(event.key)
                || target instanceof HTMLInputElement
                || target instanceof HTMLTextAreaElement
                || (target instanceof HTMLElement && target.isContentEditable)
            ) {
                return
            }
            keyboardResumeUntil = Date.now() + KEYBOARD_SCROLL_INTENT_WINDOW_MS
            if (needsViewportCoverageRef.current()) {
                keyboardResumeUntil = 0
                void requestOlderRef.current('user')
            }
        }

        const armPointerIntent = () => {
            pointerResumeActive = true
            pointerResumeUntil = 0
            pointerResumeLatched = false
        }

        const handlePointerDown = (event: PointerEvent) => {
            if (isNestedScrollEvent(event) || event.button !== 0) {
                return
            }
            armPointerIntent()
        }

        const isInsideViewport = (clientX: number, clientY: number) => {
            const rect = viewport.getBoundingClientRect()
            return clientX >= rect.left
                && clientX <= rect.right
                && clientY >= rect.top
                && clientY <= rect.bottom
        }

        // Native scrollbar interaction may bypass the viewport's own event
        // listeners. Capture pointer and mouse input at the window boundary,
        // then scope it back to the chat viewport by coordinates.
        const handleWindowPointerDown = (event: PointerEvent) => {
            if (isNestedScrollEvent(event)) return
            if (event.button === 0 && isInsideViewport(event.clientX, event.clientY)) {
                armPointerIntent()
            }
        }

        const handleWindowMouseDown = (event: MouseEvent) => {
            if (isNestedScrollEvent(event)) return
            if (event.button === 0 && isInsideViewport(event.clientX, event.clientY)) {
                armPointerIntent()
            }
        }

        const clearPointerIntent = () => {
            pointerResumeActive = false
            pointerResumeUntil = 0
            pointerResumeLatched = false
        }

        const handlePointerCancel = (event: PointerEvent) => {
            if (isNestedScrollEvent(event)) return
            const hadActivePointer = pointerResumeActive
            pointerResumeActive = false
            if (hadActivePointer && (event.pointerType === 'touch' || event.pointerType === 'pen')) {
                // Native panning cancels the pointer before some mobile browsers
                // dispatch the resulting scroll event. Retain that explicit input
                // briefly so initial bottom-settling cannot reclaim the viewport.
                pointerResumeUntil = Date.now() + POINTER_CANCEL_INTENT_WINDOW_MS
                return
            }
            pointerResumeUntil = 0
            pointerResumeLatched = false
        }

        const handleWheel = (event: WheelEvent) => {
            if (isNestedScrollEvent(event)) return
            if (event.deltaY >= 0) {
                wheelIntentUntil = 0
                return
            }
            // One trigger per gesture: a trackpad swipe is a burst of wheel
            // events. Remember the gesture before the following scroll event
            // so an approach from outside the preload area is also classified
            // as explicit user intent.
            const now = Date.now()
            if (now - lastWheelAt > WHEEL_GESTURE_GAP_MS) {
                wheelLatched = false
            }
            lastWheelAt = now
            wheelIntentUntil = now + WHEEL_GESTURE_GAP_MS
            if (!needsViewportCoverageRef.current() || wheelLatched) {
                return
            }
            wheelLatched = true
            void requestOlderRef.current('user')
        }

        const handleTouchStart = (event: TouchEvent) => {
            if (isNestedScrollEvent(event)) return
            updatePullToLoadState('idle')
            pullStartY = (
                viewport.scrollTop <= 0
                && hasMoreMessagesRef.current
                && !isSyncingTailRef.current
                && !isLoadingMoreRef.current
                && !pendingLoadPromiseRef.current
            )
                ? event.touches[0]?.clientY ?? null
                : null
        }

        const handleTouchMove = (event: TouchEvent) => {
            if (isNestedScrollEvent(event)) return
            if (pullStartY === null) {
                return
            }
            if (viewport.scrollTop > 0) {
                pullStartY = null
                updatePullToLoadState('idle')
                return
            }
            const currentY = event.touches[0]?.clientY
            if (currentY !== undefined) {
                updatePullToLoadState(getPullToLoadState(currentY - pullStartY))
            }
        }

        const handleTouchEnd = (event: TouchEvent) => {
            if (isNestedScrollEvent(event)) return
            const shouldLoad = pullStartY !== null
                && pullToLoadStateRef.current === 'ready'
                && viewport.scrollTop <= 0
            pullStartY = null
            updatePullToLoadState('idle')
            if (shouldLoad) {
                void requestOlderRef.current('user')
            }
        }

        const handleTouchCancel = (event: TouchEvent) => {
            if (isNestedScrollEvent(event)) return
            pullStartY = null
            updatePullToLoadState('idle')
        }

        viewport.addEventListener('scroll', handleScroll, { passive: true })
        viewport.addEventListener('keydown', handleKeyDown)
        viewport.addEventListener('pointerdown', handlePointerDown, { passive: true })
        viewport.addEventListener('wheel', handleWheel, { passive: true })
        viewport.addEventListener('touchstart', handleTouchStart, { passive: true })
        viewport.addEventListener('touchmove', handleTouchMove, { passive: true })
        viewport.addEventListener('touchend', handleTouchEnd, { passive: true })
        viewport.addEventListener('touchcancel', handleTouchCancel, { passive: true })
        window.addEventListener('pointerdown', handleWindowPointerDown, { capture: true, passive: true })
        window.addEventListener('mousedown', handleWindowMouseDown, { capture: true, passive: true })
        window.addEventListener('pointerup', clearPointerIntent, { passive: true })
        window.addEventListener('mouseup', clearPointerIntent, { passive: true })
        window.addEventListener('pointercancel', handlePointerCancel, { passive: true })
        window.addEventListener('blur', clearPointerIntent)
        return () => {
            viewport.removeEventListener('scroll', handleScroll)
            viewport.removeEventListener('keydown', handleKeyDown)
            viewport.removeEventListener('pointerdown', handlePointerDown)
            viewport.removeEventListener('wheel', handleWheel)
            viewport.removeEventListener('touchstart', handleTouchStart)
            viewport.removeEventListener('touchmove', handleTouchMove)
            viewport.removeEventListener('touchend', handleTouchEnd)
            viewport.removeEventListener('touchcancel', handleTouchCancel)
            window.removeEventListener('pointerdown', handleWindowPointerDown, true)
            window.removeEventListener('mousedown', handleWindowMouseDown, true)
            window.removeEventListener('pointerup', clearPointerIntent)
            window.removeEventListener('mouseup', clearPointerIntent)
            window.removeEventListener('pointercancel', handlePointerCancel)
            window.removeEventListener('blur', clearPointerIntent)
        }
    }, []) // Stable: no dependencies, reads from refs

    const scrollToBottomInstant = useCallback(() => {
        const viewport = viewportRef.current
        if (viewport) {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' })
            lastScrollTopRef.current = viewport.scrollTop
        }
    }, [])

    const handleNestedScrollFollowChange = useCallback((followLatest: boolean) => {
        if (!followLatest) {
            clearInitialScrollTimers()
        }
        autoScrollEnabledRef.current = followLatest && atBottomRef.current
    }, [clearInitialScrollTimers])

    // Scroll to bottom handler for the indicator button
    const scrollToBottom = useCallback(() => {
        const viewport = viewportRef.current
        if (viewport) {
            tailScrollInProgressRef.current = true
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
            lastScrollTopRef.current = viewport.scrollTop
        }
        autoScrollEnabledRef.current = true
        if (!atBottomRef.current) {
            atBottomRef.current = true
            onViewModeChangeRef.current('tail')
        }
    }, [])

    // Reset state when session changes
    useLayoutEffect(() => {
        autoScrollEnabledRef.current = true
        tailScrollInProgressRef.current = false
        lastScrollTopRef.current = viewportRef.current?.scrollTop ?? 0
        atBottomRef.current = true
        onViewModeChangeRef.current('tail')
        forceScrollTokenRef.current = props.forceScrollToken
        pendingScrollRef.current = null
        pullToLoadStateRef.current = 'idle'
        setPullToLoadState('idle')
        historyLoaderRef.current = {
            runId: historyLoaderRef.current.runId + 1,
            phase: 'idle',
            source: null,
            failureCount: 0,
            autoPaused: false
        }
        initialScrollSessionRef.current = null
        initialScrollDeadlineRef.current = 0
        clearInitialScrollTimers()
        clearCoverageCheckTimer()
        clearFailureRetryTimer()
        settlePendingLoad('transient-stop')
    }, [
        props.sessionId,
        clearInitialScrollTimers,
        clearCoverageCheckTimer,
        clearFailureRetryTimer,
        settlePendingLoad
    ])

    useLayoutEffect(() => {
        if (
            initialScrollSessionRef.current === props.sessionId
            || props.isSyncingTail
            || props.rawMessagesCount === 0
            || pendingScrollRef.current
        ) {
            return
        }

        initialScrollSessionRef.current = props.sessionId
        autoScrollEnabledRef.current = true
        atBottomRef.current = true
        onViewModeChangeRef.current('tail')
        scrollToBottomInstant()

        initialScrollDeadlineRef.current = Date.now() + INITIAL_SCROLL_SETTLE_MS
        clearInitialScrollTimers()
        initialScrollTimersRef.current = INITIAL_SCROLL_SETTLE_DELAYS_MS.map((delay) => window.setTimeout(() => {
            if (
                initialScrollSessionRef.current !== props.sessionId
                || !autoScrollEnabledRef.current
                || pendingScrollRef.current
            ) {
                return
            }
            scrollToBottomInstant()
        }, delay))
    }, [
        props.sessionId,
        props.isSyncingTail,
        props.rawMessagesCount,
        props.messagesVersion,
        scrollToBottomInstant,
        clearInitialScrollTimers
    ])

    useEffect(() => {
        return () => {
            historyLoaderRef.current.runId += 1
            clearInitialScrollTimers()
            clearCoverageCheckTimer()
            clearFailureRetryTimer()
            settlePendingLoad('transient-stop')
        }
    }, [clearInitialScrollTimers, clearCoverageCheckTimer, clearFailureRetryTimer, settlePendingLoad])

    useEffect(() => {
        if (forceScrollTokenRef.current === props.forceScrollToken) {
            return
        }
        forceScrollTokenRef.current = props.forceScrollToken
        scrollToBottom()
    }, [props.forceScrollToken, scrollToBottom])

    const needsViewportCoverage = useCallback((): boolean => {
        const viewport = viewportRef.current
        const sentinel = topSentinelRef.current
        if (!viewport || !sentinel) {
            return false
        }
        const viewportRect = viewport.getBoundingClientRect()
        const sentinelRect = sentinel.getBoundingClientRect()
        return shouldLoadOlderForViewport({
            scrollHeight: viewport.scrollHeight,
            clientHeight: viewport.clientHeight,
            viewportTop: viewportRect.top,
            sentinelTop: sentinelRect.top,
            sentinelBottom: sentinelRect.bottom
        })
    }, [])
    needsViewportCoverageRef.current = needsViewportCoverage

    const scheduleCoverageAfterSettling = useCallback(() => {
        clearCoverageCheckTimer()
        if (historyLoaderRef.current.autoPaused) {
            return
        }
        const delay = getHistoryCoverageRetryDelay(initialScrollDeadlineRef.current, Date.now())
        coverageCheckTimerRef.current = window.setTimeout(() => {
            coverageCheckTimerRef.current = null
            if (needsViewportCoverage()) {
                void requestOlderRef.current('coverage')
            }
        }, delay)
    }, [clearCoverageCheckTimer, needsViewportCoverage])

    const startHistoryLoadAttempt = useCallback((runId: number): void => {
        const state = historyLoaderRef.current
        if (state.runId !== runId || !pendingLoadPromiseRef.current) {
            return
        }
        const finishStoppedAttempt = (
            current: HistoryLoaderState,
            result: Exclude<OlderHistoryLoadResult, 'loaded'>,
            autoPaused = current.autoPaused
        ) => {
            clearFailureRetryTimer()
            pendingScrollRef.current = null
            historyLoaderRef.current = {
                ...current,
                phase: 'idle',
                source: null,
                failureCount: 0,
                autoPaused
            }
            settlePendingLoad(result)
            if (
                result === 'transient-stop'
                && !isSyncingTailRef.current
                && !isLoadingMoreRef.current
            ) {
                scheduleCoverageAfterSettling()
            }
        }

        if (state.source !== 'consumer' && !needsViewportCoverage()) {
            finishStoppedAttempt(state, 'transient-stop')
            return
        }
        if (isSyncingTailRef.current || isLoadingMoreRef.current) {
            finishStoppedAttempt(state, 'transient-stop')
            return
        }
        if (!hasMoreMessagesRef.current) {
            finishStoppedAttempt(state, 'terminal-stop', true)
            return
        }

        const viewport = viewportRef.current
        if (!viewport) {
            finishStoppedAttempt(state, 'transient-stop')
            return
        }

        clearFailureRetryTimer()
        pendingScrollRef.current = {
            runId,
            anchor: captureScrollAnchor(viewport),
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            targetHistoryVersion: null
        }
        autoScrollEnabledRef.current = false
        historyLoaderRef.current = { ...state, phase: 'loading' }

        void (async () => {
            let outcome: OlderLoadOutcome
            try {
                outcome = await onLoadMoreRef.current((historyVersion) => {
                    const current = historyLoaderRef.current
                    const pending = pendingScrollRef.current
                    if (
                        current.runId !== runId
                        || !pendingLoadPromiseRef.current
                        || !pending
                        || pending.runId !== runId
                    ) {
                        return false
                    }
                    if (current.source !== 'consumer' && !needsViewportCoverage()) {
                        return false
                    }
                    pending.targetHistoryVersion = historyVersion
                    historyLoaderRef.current = { ...current, phase: 'awaiting-render' }
                    return true
                })
            } catch (error) {
                outcome = {
                    kind: 'failed',
                    error: error instanceof Error
                        ? error
                        : new Error('Failed to load older messages')
                }
            }

            const current = historyLoaderRef.current
            if (current.runId !== runId || !pendingLoadPromiseRef.current) {
                return
            }

            if (outcome.kind === 'applied') {
                const pending = pendingScrollRef.current
                if (!pending || pending.runId !== runId) {
                    finishStoppedAttempt(current, 'transient-stop')
                    return
                }
                pending.targetHistoryVersion = outcome.historyVersion
                historyLoaderRef.current = { ...current, phase: 'awaiting-render' }
                return
            }

            pendingScrollRef.current = null
            if (outcome.kind === 'failed') {
                const failureCount = current.failureCount + 1
                console.error('Failed to load older messages:', outcome.error)
                if (failureCount <= MAX_COVERAGE_LOAD_RETRIES) {
                    historyLoaderRef.current = {
                        ...current,
                        phase: 'backoff',
                        failureCount
                    }
                    const delay = COVERAGE_FAILURE_RETRY_DELAY_MS * failureCount
                    failureRetryTimerRef.current = window.setTimeout(() => {
                        failureRetryTimerRef.current = null
                        const retryState = historyLoaderRef.current
                        if (retryState.runId !== runId || retryState.phase !== 'backoff') {
                            return
                        }
                        startHistoryLoadAttemptRef.current(runId)
                    }, delay)
                    return
                }
                finishStoppedAttempt(current, 'terminal-stop', true)
                return
            }

            const terminalStop = outcome.reason === 'epoch-reset'
                || outcome.reason === 'exhausted'
                || outcome.reason === 'unavailable'
            finishStoppedAttempt(
                current,
                terminalStop ? 'terminal-stop' : 'transient-stop',
                terminalStop ? true : current.autoPaused
            )
        })()
    }, [
        clearFailureRetryTimer,
        needsViewportCoverage,
        scheduleCoverageAfterSettling,
        settlePendingLoad
    ])
    startHistoryLoadAttemptRef.current = startHistoryLoadAttempt

    const requestOlder = useCallback((source: HistoryLoadSource): Promise<OlderHistoryLoadResult> => {
        if (pendingLoadPromiseRef.current) {
            return pendingLoadPromiseRef.current
        }

        let state = historyLoaderRef.current
        if (source === 'coverage') {
            if (state.autoPaused) {
                return Promise.resolve('terminal-stop')
            }
            if (isInitialScrollSettling() || !needsViewportCoverage()) {
                return Promise.resolve('transient-stop')
            }
        } else {
            // Explicit consumers must not be swallowed by the initial
            // scroll-to-bottom settling window.
            initialScrollDeadlineRef.current = 0
            clearInitialScrollTimers()
            if (source === 'user' && state.autoPaused) {
                state = { ...state, autoPaused: false }
                historyLoaderRef.current = state
            }
        }

        if (
            state.phase !== 'idle'
            || isSyncingTailRef.current
            || isLoadingMoreRef.current
            || !viewportRef.current
        ) {
            return Promise.resolve('transient-stop')
        }
        if (!hasMoreMessagesRef.current) {
            return Promise.resolve('terminal-stop')
        }

        clearCoverageCheckTimer()
        clearFailureRetryTimer()
        const runId = state.runId + 1
        historyLoaderRef.current = {
            runId,
            phase: 'loading',
            source,
            failureCount: 0,
            autoPaused: source === 'user' ? false : state.autoPaused
        }
        const loadPromise = new Promise<OlderHistoryLoadResult>((resolve) => {
            pendingLoadResolveRef.current = resolve
        })
        pendingLoadPromiseRef.current = loadPromise
        startHistoryLoadAttemptRef.current(runId)
        return loadPromise
    }, [
        clearCoverageCheckTimer,
        clearFailureRetryTimer,
        clearInitialScrollTimers,
        isInitialScrollSettling,
        needsViewportCoverage
    ])
    requestOlderRef.current = requestOlder

    const loadOlderFromConsumer = useCallback((): Promise<OlderHistoryLoadResult> => {
        return requestOlder('consumer')
    }, [requestOlder])

    const loadOlderForOutline = useCallback(async (): Promise<boolean> => {
        return await loadOlderFromConsumer() === 'loaded'
    }, [loadOlderFromConsumer])

    const handleOutlineSelect = useCallback(async (item: ConversationOutlineItem) => {
        const target = await locateOutlineTargetMessage({
            targetMessageId: item.targetMessageId,
            findTarget: (anchorId) => document.getElementById(anchorId),
            hasMoreMessages: () => hasMoreMessagesRef.current,
            loadOlderPreservingScroll: loadOlderForOutline
        })
        if (target) {
            target.scrollIntoView({ block: 'start', behavior: 'smooth' })
            autoScrollEnabledRef.current = false
        }
        props.onOutlineItemClick?.(item)
        props.onOutlineOpenChange(false)
    }, [loadOlderForOutline, props.onOutlineItemClick, props.onOutlineOpenChange])

    useEffect(() => {
        if (
            !props.hasMoreMessages
            || props.isSyncingTail
            || props.isLoadingMoreMessages
        ) {
            clearCoverageCheckTimer()
            return
        }
        if (!needsViewportCoverage()) {
            return
        }
        if (isInitialScrollSettling()) {
            scheduleCoverageAfterSettling()
            return
        }
        void requestOlderRef.current('coverage')
    }, [
        props.hasMoreMessages,
        props.isSyncingTail,
        props.isLoadingMoreMessages,
        props.messagesVersion,
        isInitialScrollSettling,
        needsViewportCoverage,
        scheduleCoverageAfterSettling,
        clearCoverageCheckTimer
    ])

    useEffect(() => {
        const content = contentRef.current
        if (!content || typeof ResizeObserver === 'undefined') {
            return
        }

        const observer = new ResizeObserver(() => {
            // Message DOM can grow after messagesVersion commits (assistant-ui
            // updates its external runtime in an effect, then markdown/tool
            // content may resize). Keep following while the user is at bottom.
            if (
                autoScrollEnabledRef.current
                && atBottomRef.current
                && !pendingScrollRef.current
            ) {
                scrollToBottomInstant()
            }
            // Late content growth can leave the viewport near the top without
            // a scroll event. Submit demand through the same controller; an
            // in-flight load, backoff, or paused run remains exclusive.
            if (!pendingScrollRef.current && needsViewportCoverage()) {
                if (isInitialScrollSettling()) {
                    scheduleCoverageAfterSettling()
                } else {
                    void requestOlderRef.current('coverage')
                }
            }
        })
        observer.observe(content)
        return () => observer.disconnect()
    }, [
        scrollToBottomInstant,
        isInitialScrollSettling,
        needsViewportCoverage,
        scheduleCoverageAfterSettling
    ])

    useLayoutEffect(() => {
        const pending = pendingScrollRef.current
        const viewport = viewportRef.current
        if (!viewport) {
            return
        }
        if (pending) {
            if (
                pending.targetHistoryVersion === null
                || appliedHistoryVersion < pending.targetHistoryVersion
            ) {
                return
            }
            const restoredByAnchor = pending.anchor ? restoreScrollAnchor(viewport, pending.anchor) : false
            if (!restoredByAnchor) {
                const delta = viewport.scrollHeight - pending.scrollHeight
                viewport.scrollTop = pending.scrollTop + delta
            }
            const loaderState = historyLoaderRef.current
            if (loaderState.runId !== pending.runId || loaderState.phase !== 'awaiting-render') {
                pendingScrollRef.current = null
                return
            }
            lastScrollTopRef.current = viewport.scrollTop
            pendingScrollRef.current = null
            clearFailureRetryTimer()
            historyLoaderRef.current = {
                ...loaderState,
                phase: 'idle',
                source: null,
                failureCount: 0,
                // A completed page always consumes automatic demand. The next
                // page requires renewed wheel/touch/keyboard/scrollbar intent;
                // render, resize, and scroll-restoration events cannot chain it.
                autoPaused: true
            }
            settlePendingLoad('loaded')
            return
        }
        if (atBottomRef.current && autoScrollEnabledRef.current) {
            scrollToBottomInstant()
        }
    }, [
        appliedMessagesVersion,
        appliedHistoryVersion,
        scrollToBottomInstant,
        settlePendingLoad,
        clearFailureRetryTimer
    ])

    useEffect(() => {
        isLoadingMoreRef.current = props.isLoadingMoreMessages
    }, [props.isLoadingMoreMessages])

    const showSkeleton = props.isSyncingTail && props.rawMessagesCount === 0
    const handleShareTurn = useCallback((
        messageTarget: HTMLElement | string | null,
        clientY?: number,
        fallbackSnapshot?: ShareTurnSnapshot
    ) => {
        const content = contentRef.current
        if (!content) return
        const messageContainer = content.querySelector<HTMLElement>('.happy-thread-messages')
        const sourceContentWidth = messageContainer?.getBoundingClientRect().width
            ?? content.getBoundingClientRect().width

        let target: HTMLElement | null = typeof messageTarget === 'string'
            ? document.getElementById(messageTarget)
            : messageTarget
        if (!(target instanceof HTMLElement) || !content.contains(target)) {
            target = findNearestMessageElement(content, clientY)
        }
        if (!(target instanceof HTMLElement) || !content.contains(target)) {
            setShareTurn({
                id: ++shareTurnIdRef.current,
                snapshots: fallbackSnapshot ? [fallbackSnapshot] : [],
                sourceContentWidth: sourceContentWidth > 0 ? sourceContentWidth : null,
            })
            return
        }

        let start: Element | null = target
        while (start?.previousElementSibling && start.getAttribute('data-hapi-message-role') !== 'user') {
            start = start.previousElementSibling
        }
        if (!start || start.getAttribute('data-hapi-message-role') !== 'user') {
            start = target
        }

        const snapshots: ShareTurnSnapshot[] = []
        let current: Element | null = start
        while (current instanceof HTMLElement) {
            if (current !== start && current.getAttribute('data-hapi-message-role') === 'user') {
                break
            }
            const role = current.getAttribute('data-hapi-message-role')
            if (role === 'user' || role === 'assistant') {
                snapshots.push({
                    html: current.outerHTML,
                    text: (current.innerText || current.textContent || '').trim()
                })
            }
            current = current.nextElementSibling
        }

        if (snapshots.length === 0 && target instanceof HTMLElement) {
            snapshots.push({
                html: target.outerHTML,
                text: (target.innerText || target.textContent || '').trim()
            })
        }
        if (snapshots.length === 0 && fallbackSnapshot) {
            snapshots.push(fallbackSnapshot)
        }
        const completeSnapshots = prependMissingUserSnapshot(snapshots, fallbackSnapshot)

        setShareTurn({
            id: ++shareTurnIdRef.current,
            snapshots: completeSnapshots,
            sourceContentWidth: sourceContentWidth > 0 ? sourceContentWidth : null,
        })
    }, [props.session])

    return (
        <HappyChatProvider value={{
            api: props.api,
            sessionId: props.sessionId,
            metadata: props.metadata,
            terminalToolDisplayMode,
            disabled: props.disabled,
            onRefresh: props.onRefresh,
            onRetryMessage: props.onRetryMessage,
            historyActionPending: props.historyActionPending,
            onForkConversation: props.onForkConversation,
            onRewindConversation: props.onRewindConversation,
            isLatestCompletedBoundary: props.isLatestCompletedBoundary,
            onShareTurn: handleShareTurn,
            hasMoreMessages: props.hasMoreMessages,
            isSyncingTail: props.isSyncingTail,
            isLoadingMoreMessages: props.isLoadingMoreMessages,
            onNestedScrollFollowChange: handleNestedScrollFollowChange,
            loadOlderMessagesPreservingScroll: loadOlderFromConsumer
        }}>
            <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col relative">
                {!props.isSyncingTail && (
                    props.isLoadingMoreMessages || pullToLoadState !== 'idle'
                ) ? (
                    <div
                        role="status"
                        aria-live="polite"
                        className="pointer-events-none absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/90 px-2.5 py-1 text-xs text-[var(--app-hint)] shadow-sm backdrop-blur"
                    >
                        {props.isLoadingMoreMessages ? (
                            <Spinner size="sm" label={null} className="text-current" />
                        ) : null}
                        <span>
                            {props.isLoadingMoreMessages
                                ? t('misc.loading')
                                : pullToLoadState === 'ready'
                                    ? t('misc.releaseToLoadOlder')
                                    : t('misc.pullToLoadOlder')}
                        </span>
                    </div>
                ) : null}
                <ThreadPrimitive.Viewport
                    asChild
                    autoScroll={false}
                    scrollToBottomOnInitialize={false}
                    scrollToBottomOnRunStart={false}
                    scrollToBottomOnThreadSwitch={false}
                >
                    <div
                        ref={viewportRef}
                        className="app-scroll-y chat-scroll-y min-h-0 flex-1 overflow-x-hidden"
                        tabIndex={0}
                    >
                        <div ref={contentRef} className="chat-scroll-content mx-auto w-full max-w-content min-w-0 p-3">
                            <div ref={topSentinelRef} className="h-px w-full" aria-hidden="true" />
                            {showSkeleton ? (
                                <MessageSkeleton />
                            ) : (
                                <>
                                    {props.messagesWarning ? (
                                        <div className="mb-3 rounded-md bg-amber-500/10 p-2 text-xs">
                                            {props.messagesWarning}
                                        </div>
                                    ) : null}

                                    {import.meta.env.DEV && props.normalizedMessagesCount === 0 && props.rawMessagesCount > 0 ? (
                                        <div className="mb-2 rounded-md bg-amber-500/10 p-2 text-xs">
                                            Message normalization returned 0 items for {props.rawMessagesCount} messages (see `web/src/chat/normalize.ts`).
                                        </div>
                                    ) : null}
                                </>
                            )}
                            <div className="happy-thread-messages flex flex-col gap-3">
                                <ThreadPrimitive.Messages components={THREAD_MESSAGE_COMPONENTS} />
                            </div>
                        </div>
                    </div>
                </ThreadPrimitive.Viewport>
                <NewMessagesIndicator count={props.unseenCount} onClick={scrollToBottom} />
                {props.outlineOpen ? (
                    <>
                        <button
                            type="button"
                            className="absolute inset-0 z-20 bg-black/20"
                            aria-label={t('session.outline.close')}
                            onClick={() => props.onOutlineOpenChange(false)}
                        />
                        <ConversationOutlinePanel
                            items={props.outlineItems}
                            hasMoreMessages={props.hasMoreMessages}
                            isLoadingMoreMessages={props.isLoadingMoreMessages}
                            onLoadMore={() => {
                                void loadOlderFromConsumer()
                            }}
                            onSelect={handleOutlineSelect}
                            onClose={() => props.onOutlineOpenChange(false)}
                        />
                    </>
                ) : null}
                <ShareTurnDialog
                    key={shareTurn?.id ?? 'closed'}
                    isOpen={shareTurn !== null}
                    title={shareTitle}
                    metadataItems={shareMetadataItems}
                    sourceSnapshots={shareTurn?.snapshots ?? []}
                    sourceContentWidth={shareTurn?.sourceContentWidth ?? null}
                    onClose={() => setShareTurn(null)}
                />
            </ThreadPrimitive.Root>
        </HappyChatProvider>
    )
}
