import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ThreadPrimitive } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { HappyAssistantMessage } from '@/components/AssistantChat/messages/AssistantMessage'
import { HappyUserMessage } from '@/components/AssistantChat/messages/UserMessage'
import { HappySystemMessage } from '@/components/AssistantChat/messages/SystemMessage'
import {
    VirtualizedThreadMessages,
    type VirtualizedThreadMessagesHandle,
} from '@/components/AssistantChat/VirtualizedThreadMessages'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'

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

const INITIAL_SCROLL_MIN_FRAMES = 3
const INITIAL_SCROLL_MAX_FRAMES = 12
const ANCHOR_RESTORE_MAX_MS = 4_000
// Virtualized row measurements can commit a few frames after the anchor first
// appears exact, especially on slower renderers. Keep correcting through a
// short stable window so a late measurement cannot move the reading position.
const ANCHOR_RESTORE_STABLE_FRAMES = 8
const HISTORY_SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])
const LATEST_SCROLL_MIN_FRAMES = 3
const LATEST_SCROLL_MAX_FRAMES = 120
const LATEST_SCROLL_MAX_MS = 4_000

export function HappyThread(props: {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    disabled: boolean
    onRefresh: () => void
    onRetryMessage?: (localId: string) => void
    onFlushPending: () => void
    onAtBottomChange: (atBottom: boolean) => void
    isLoadingMessages: boolean
    messagesWarning: string | null
    hasMoreMessages: boolean
    hasNewerMessages: boolean
    isLoadingMoreMessages: boolean
    isLoadingNewerMessages: boolean
    onLoadMore: () => Promise<unknown>
    onLoadNewer: () => Promise<unknown>
    onReturnToLatest: () => Promise<unknown>
    pendingCount: number
    rawMessagesCount: number
    normalizedMessagesCount: number
    messagesVersion: number
    forceScrollToken: number
}) {
    const { t } = useTranslation()
    const viewportRef = useRef<HTMLDivElement | null>(null)
    const virtualizedMessagesRef = useRef<VirtualizedThreadMessagesHandle | null>(null)
    const topSentinelRef = useRef<HTMLDivElement | null>(null)
    const loadLockRef = useRef(false)
    const newerLoadLockRef = useRef(false)
    const returnToLatestLockRef = useRef(false)
    const pendingAnchorRef = useRef<{
        id: string | null
        offset: number
        scrollTop: number
        scrollHeight: number
        direction: 'older' | 'newer'
        restoreDeadlineAt: number | null
    } | null>(null)
    const historyLoadCleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const anchorRestoreFrameRef = useRef<number | null>(null)
    const latestScrollFrameRef = useRef<number | null>(null)
    const latestScrollPendingRef = useRef(false)
    const latestScrollSourceVersionRef = useRef<number | null>(null)
    const messagesVersionRef = useRef(props.messagesVersion)
    const isLoadingMoreRef = useRef(props.isLoadingMoreMessages)
    const isLoadingNewerRef = useRef(props.isLoadingNewerMessages)
    const hasMoreMessagesRef = useRef(props.hasMoreMessages)
    const hasNewerMessagesRef = useRef(props.hasNewerMessages)
    const isLoadingMessagesRef = useRef(props.isLoadingMessages)
    const onLoadMoreRef = useRef(props.onLoadMore)
    const onLoadNewerRef = useRef(props.onLoadNewer)
    const onReturnToLatestRef = useRef(props.onReturnToLatest)
    const handleLoadMoreRef = useRef<() => void>(() => {})
    const atBottomRef = useRef(true)
    const onAtBottomChangeRef = useRef(props.onAtBottomChange)
    const onFlushPendingRef = useRef(props.onFlushPending)
    const forceScrollTokenRef = useRef(props.forceScrollToken)

    // Smart scroll state: autoScroll enabled when user is near bottom
    const [autoScrollEnabled, setAutoScrollEnabled] = useState(true)
    const [initialScrollSettled, setInitialScrollSettled] = useState(false)
    const [isReturningToLatest, setIsReturningToLatest] = useState(false)
    const [anchorTailSpacerPx, setAnchorTailSpacerPx] = useState(0)
    const anchorTailSpacerRef = useRef(0)
    const autoScrollEnabledRef = useRef(autoScrollEnabled)
    const initialScrollDoneRef = useRef(false)
    const initialScrollScheduledRef = useRef(false)

    const updateAnchorTailSpacer = useCallback((nextPx: number) => {
        const bounded = Math.max(0, Math.ceil(nextPx))
        anchorTailSpacerRef.current = bounded
        setAnchorTailSpacerPx((current) => current === bounded ? current : bounded)
    }, [])

    // Keep refs in sync with state
    useEffect(() => {
        autoScrollEnabledRef.current = autoScrollEnabled
    }, [autoScrollEnabled])
    useEffect(() => {
        onAtBottomChangeRef.current = props.onAtBottomChange
    }, [props.onAtBottomChange])
    useEffect(() => {
        onFlushPendingRef.current = props.onFlushPending
    }, [props.onFlushPending])
    useEffect(() => {
        hasMoreMessagesRef.current = props.hasMoreMessages
    }, [props.hasMoreMessages])
    useEffect(() => {
        hasNewerMessagesRef.current = props.hasNewerMessages
        if (!props.hasNewerMessages && anchorTailSpacerRef.current > 0) {
            updateAnchorTailSpacer(0)
        }
        const viewport = viewportRef.current
        if (!viewport) {
            return
        }
        const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
        const isLiveBottom = distanceFromBottom < 120 && !props.hasNewerMessages
        if (isLiveBottom !== atBottomRef.current) {
            atBottomRef.current = isLiveBottom
            onAtBottomChangeRef.current(isLiveBottom)
            if (isLiveBottom) {
                onFlushPendingRef.current()
            }
        }
        if (!isLiveBottom && autoScrollEnabledRef.current) {
            setAutoScrollEnabled(false)
        }
    }, [props.hasNewerMessages, updateAnchorTailSpacer])
    useEffect(() => {
        isLoadingMessagesRef.current = props.isLoadingMessages
    }, [props.isLoadingMessages])
    useEffect(() => {
        onLoadMoreRef.current = props.onLoadMore
    }, [props.onLoadMore])
    useEffect(() => {
        onLoadNewerRef.current = props.onLoadNewer
    }, [props.onLoadNewer])
    useEffect(() => {
        onReturnToLatestRef.current = props.onReturnToLatest
    }, [props.onReturnToLatest])

    // Track scroll position to toggle autoScroll (stable listener using refs)
    useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) return

        const THRESHOLD_PX = 120

        const handleScroll = () => {
            const tailSpacer = anchorTailSpacerRef.current
            if (tailSpacer > 0) {
                const maxWithoutSpacer = viewport.scrollHeight - tailSpacer - viewport.clientHeight
                if (viewport.scrollTop <= maxWithoutSpacer + 0.5) {
                    updateAnchorTailSpacer(0)
                }
            }
            const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
            const isNearBottom = distanceFromBottom < THRESHOLD_PX
            const isLiveBottom = isNearBottom && !hasNewerMessagesRef.current

            if (isLiveBottom) {
                if (!autoScrollEnabledRef.current) setAutoScrollEnabled(true)
            } else if (autoScrollEnabledRef.current) {
                setAutoScrollEnabled(false)
            }

            if (isLiveBottom !== atBottomRef.current) {
                atBottomRef.current = isLiveBottom
                onAtBottomChangeRef.current(isLiveBottom)
                if (isLiveBottom) {
                    onFlushPendingRef.current()
                }
            }
        }

        viewport.addEventListener('scroll', handleScroll, { passive: true })
        return () => viewport.removeEventListener('scroll', handleScroll)
    }, [updateAnchorTailSpacer]) // Stable callback, remaining values come from refs

    // Scroll to bottom handler for the indicator button and explicit positioning events
    const scrollToBottom = useCallback((
        behavior: ScrollBehavior = 'smooth',
        options?: { flushPending?: boolean; assumeLatest?: boolean }
    ) => {
        const viewport = viewportRef.current
        if (viewport) {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior })
        }
        const isLiveBottom = options?.assumeLatest === true || !hasNewerMessagesRef.current
        setAutoScrollEnabled(isLiveBottom)
        if (atBottomRef.current !== isLiveBottom) {
            atBottomRef.current = isLiveBottom
            onAtBottomChangeRef.current(isLiveBottom)
        }
        if (options?.flushPending !== false && isLiveBottom) {
            onFlushPendingRef.current()
        }
    }, [])

    const scheduleLatestScrollSettlement = useCallback(() => {
        if (latestScrollFrameRef.current !== null) {
            cancelAnimationFrame(latestScrollFrameRef.current)
            latestScrollFrameRef.current = null
        }
        const startedAt = performance.now()
        let frameCount = 0
        let stableFrameCount = 0
        let lastScrollHeight = -1

        const settle = () => {
            latestScrollFrameRef.current = null
            const viewport = viewportRef.current
            if (!viewport) {
                return
            }
            frameCount += 1
            const currentScrollHeight = viewport.scrollHeight
            if (Math.abs(currentScrollHeight - lastScrollHeight) <= 0.5) {
                stableFrameCount += 1
            } else {
                stableFrameCount = 0
                lastScrollHeight = currentScrollHeight
            }
            scrollToBottom('auto', { flushPending: false, assumeLatest: true })

            if (
                frameCount >= LATEST_SCROLL_MAX_FRAMES
                || performance.now() - startedAt >= LATEST_SCROLL_MAX_MS
                || (
                    frameCount >= LATEST_SCROLL_MIN_FRAMES
                    && stableFrameCount >= 2
                )
            ) {
                if (
                    latestScrollPendingRef.current
                    && latestScrollSourceVersionRef.current !== null
                    && messagesVersionRef.current !== latestScrollSourceVersionRef.current
                ) {
                    latestScrollPendingRef.current = false
                    latestScrollSourceVersionRef.current = null
                }
                return
            }
            latestScrollFrameRef.current = requestAnimationFrame(settle)
        }

        latestScrollFrameRef.current = requestAnimationFrame(settle)
    }, [scrollToBottom])

    useLayoutEffect(() => {
        messagesVersionRef.current = props.messagesVersion
        if (
            latestScrollPendingRef.current
            && latestScrollSourceVersionRef.current !== null
            && props.messagesVersion !== latestScrollSourceVersionRef.current
        ) {
            scheduleLatestScrollSettlement()
        }
    }, [props.messagesVersion, scheduleLatestScrollSettlement])

    // Reset state before the first layout pass for a newly opened session.
    useLayoutEffect(() => {
        initialScrollDoneRef.current = false
        initialScrollScheduledRef.current = false
        if (latestScrollFrameRef.current !== null) {
            cancelAnimationFrame(latestScrollFrameRef.current)
            latestScrollFrameRef.current = null
        }
        latestScrollPendingRef.current = false
        latestScrollSourceVersionRef.current = null
        messagesVersionRef.current = props.messagesVersion
        setInitialScrollSettled(false)
        updateAnchorTailSpacer(0)
        const isLiveBottom = !hasNewerMessagesRef.current
        setAutoScrollEnabled(isLiveBottom)
        atBottomRef.current = isLiveBottom
        onAtBottomChangeRef.current(isLiveBottom)
        forceScrollTokenRef.current = props.forceScrollToken
    }, [props.sessionId, updateAnchorTailSpacer])

    useLayoutEffect(() => {
        if (initialScrollDoneRef.current || initialScrollScheduledRef.current) {
            return
        }
        if (props.isLoadingMessages || props.rawMessagesCount === 0) {
            return
        }

        initialScrollScheduledRef.current = true
        let frameId: number | null = null
        let frameCount = 0
        let stableFrameCount = 0
        let lastScrollHeight = -1

        const settleInitialScroll = () => {
            initialScrollScheduledRef.current = false
            initialScrollDoneRef.current = true
            setInitialScrollSettled(true)
        }

        const runInitialScrollFrame = () => {
            const viewport = viewportRef.current
            if (!viewport) {
                initialScrollScheduledRef.current = false
                return
            }

            frameCount += 1
            const currentScrollHeight = viewport.scrollHeight
            if (currentScrollHeight === lastScrollHeight) {
                stableFrameCount += 1
            } else {
                stableFrameCount = 0
                lastScrollHeight = currentScrollHeight
            }

            scrollToBottom('auto', { flushPending: frameCount === 1 })

            if (
                frameCount >= INITIAL_SCROLL_MAX_FRAMES
                || (frameCount >= INITIAL_SCROLL_MIN_FRAMES && stableFrameCount >= 2)
            ) {
                settleInitialScroll()
                return
            }

            frameId = requestAnimationFrame(runInitialScrollFrame)
        }

        frameId = requestAnimationFrame(runInitialScrollFrame)

        return () => {
            if (frameId !== null) {
                cancelAnimationFrame(frameId)
            }
            if (!initialScrollDoneRef.current) {
                initialScrollScheduledRef.current = false
            }
        }
    }, [props.isLoadingMessages, props.messagesVersion, props.rawMessagesCount, props.sessionId, scrollToBottom])

    useEffect(() => {
        if (forceScrollTokenRef.current === props.forceScrollToken) {
            return
        }
        forceScrollTokenRef.current = props.forceScrollToken
        scrollToBottom()
    }, [props.forceScrollToken, scrollToBottom])

    const clearHistoryLoadCleanupTimer = useCallback(() => {
        if (historyLoadCleanupTimerRef.current === null) {
            return
        }
        clearTimeout(historyLoadCleanupTimerRef.current)
        historyLoadCleanupTimerRef.current = null
    }, [])

    const releaseHistoryLoad = useCallback((direction?: 'older' | 'newer') => {
        if (anchorRestoreFrameRef.current !== null) {
            cancelAnimationFrame(anchorRestoreFrameRef.current)
            anchorRestoreFrameRef.current = null
        }
        if (!direction || direction === 'older') {
            loadLockRef.current = false
        }
        if (!direction || direction === 'newer') {
            newerLoadLockRef.current = false
        }
        if (!direction || pendingAnchorRef.current?.direction === direction) {
            pendingAnchorRef.current = null
        }
        clearHistoryLoadCleanupTimer()
    }, [clearHistoryLoadCleanupTimer])

    useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) {
            return
        }
        const cancelPendingAnchorRestore = () => {
            const pending = pendingAnchorRef.current
            if (pending) {
                releaseHistoryLoad(pending.direction)
            }
        }
        const cancelPendingAnchorRestoreForKey = (event: KeyboardEvent) => {
            if (HISTORY_SCROLL_KEYS.has(event.key)) {
                cancelPendingAnchorRestore()
            }
        }

        viewport.addEventListener('wheel', cancelPendingAnchorRestore, { passive: true })
        viewport.addEventListener('touchstart', cancelPendingAnchorRestore, { passive: true })
        viewport.addEventListener('pointerdown', cancelPendingAnchorRestore, { passive: true })
        window.addEventListener('keydown', cancelPendingAnchorRestoreForKey)
        return () => {
            viewport.removeEventListener('wheel', cancelPendingAnchorRestore)
            viewport.removeEventListener('touchstart', cancelPendingAnchorRestore)
            viewport.removeEventListener('pointerdown', cancelPendingAnchorRestore)
            window.removeEventListener('keydown', cancelPendingAnchorRestoreForKey)
        }
    }, [releaseHistoryLoad])

    const armHistoryLoadCleanupTimer = useCallback((direction: 'older' | 'newer'): number | null => {
        const pending = pendingAnchorRef.current
        if (!pending || pending.direction !== direction) {
            return null
        }
        if (pending.restoreDeadlineAt === null) {
            pending.restoreDeadlineAt = performance.now() + ANCHOR_RESTORE_MAX_MS
        }
        if (historyLoadCleanupTimerRef.current !== null) {
            return pending.restoreDeadlineAt
        }
        const delayMs = Math.max(0, pending.restoreDeadlineAt - performance.now())
        historyLoadCleanupTimerRef.current = setTimeout(() => {
            releaseHistoryLoad(direction)
        }, delayMs)
        return pending.restoreDeadlineAt
    }, [releaseHistoryLoad])

    const captureVisibleAnchor = useCallback((direction: 'older' | 'newer') => {
        const viewport = viewportRef.current
        if (!viewport) {
            return false
        }
        const viewportRect = viewport.getBoundingClientRect()
        const rows = Array.from(viewport.querySelectorAll<HTMLElement>('[data-hapi-message-id]'))
        let anchor: { id: string; offset: number } | null = null
        for (const row of rows) {
            const id = row.dataset.hapiMessageId
            if (!id) {
                continue
            }
            const rect = row.getBoundingClientRect()
            if (rect.bottom >= viewportRect.top && rect.top <= viewportRect.bottom) {
                anchor = { id, offset: rect.top - viewportRect.top }
                break
            }
        }
        pendingAnchorRef.current = {
            id: anchor?.id ?? null,
            offset: anchor?.offset ?? 0,
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            direction,
            restoreDeadlineAt: null,
        }
        return true
    }, [])

    useEffect(() => () => {
        clearHistoryLoadCleanupTimer()
        if (anchorRestoreFrameRef.current !== null) {
            cancelAnimationFrame(anchorRestoreFrameRef.current)
        }
        if (latestScrollFrameRef.current !== null) {
            cancelAnimationFrame(latestScrollFrameRef.current)
        }
    }, [clearHistoryLoadCleanupTimer])

    const handleLoadMore = useCallback(() => {
        if (
            isLoadingMessagesRef.current
            || !hasMoreMessagesRef.current
            || isLoadingMoreRef.current
            || loadLockRef.current
            || newerLoadLockRef.current
        ) {
            return
        }
        if (!captureVisibleAnchor('older')) {
            return
        }
        loadLockRef.current = true
        let loadPromise: Promise<unknown>
        try {
            loadPromise = onLoadMoreRef.current()
        } catch (error) {
            releaseHistoryLoad('older')
            throw error
        }
        void loadPromise.catch((error) => {
            releaseHistoryLoad('older')
            console.error('Failed to load older messages:', error)
        }).finally(() => {
            if (pendingAnchorRef.current?.direction === 'older') {
                armHistoryLoadCleanupTimer('older')
            }
        })
    }, [armHistoryLoadCleanupTimer, captureVisibleAnchor, releaseHistoryLoad])

    const handleLoadNewer = useCallback(() => {
        if (
            isLoadingMessagesRef.current
            || !hasNewerMessagesRef.current
            || isLoadingNewerRef.current
            || newerLoadLockRef.current
            || loadLockRef.current
        ) {
            return
        }
        if (!captureVisibleAnchor('newer')) {
            return
        }
        newerLoadLockRef.current = true
        let loadPromise: Promise<unknown>
        try {
            loadPromise = onLoadNewerRef.current()
        } catch (error) {
            releaseHistoryLoad('newer')
            throw error
        }
        void loadPromise.catch((error) => {
            releaseHistoryLoad('newer')
            console.error('Failed to load newer messages:', error)
        }).finally(() => {
            if (pendingAnchorRef.current?.direction === 'newer') {
                armHistoryLoadCleanupTimer('newer')
            }
        })
    }, [armHistoryLoadCleanupTimer, captureVisibleAnchor, releaseHistoryLoad])

    const handleReturnToLatest = useCallback(async () => {
        if (returnToLatestLockRef.current) {
            return
        }
        returnToLatestLockRef.current = true
        setIsReturningToLatest(true)
        const sourceMessagesVersion = messagesVersionRef.current
        try {
            const returned = await onReturnToLatestRef.current()
            if (returned === false) {
                return
            }
            latestScrollPendingRef.current = true
            latestScrollSourceVersionRef.current = sourceMessagesVersion
            releaseHistoryLoad()
            updateAnchorTailSpacer(0)
            scrollToBottom('smooth', { flushPending: false, assumeLatest: true })
            scheduleLatestScrollSettlement()
        } catch (error) {
            console.error('Failed to return to latest messages:', error)
        } finally {
            returnToLatestLockRef.current = false
            setIsReturningToLatest(false)
        }
    }, [
        releaseHistoryLoad,
        scheduleLatestScrollSettlement,
        scrollToBottom,
        updateAnchorTailSpacer,
    ])

    useEffect(() => {
        handleLoadMoreRef.current = handleLoadMore
    }, [handleLoadMore])

    useEffect(() => {
        const sentinel = topSentinelRef.current
        const viewport = viewportRef.current
        if (!initialScrollSettled || !sentinel || !viewport || !props.hasMoreMessages || props.isLoadingMessages) {
            return
        }
        if (typeof IntersectionObserver === 'undefined') {
            return
        }

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        handleLoadMoreRef.current()
                    }
                }
            },
            {
                root: viewport,
                rootMargin: '200px 0px 0px 0px'
            }
        )

        observer.observe(sentinel)
        return () => observer.disconnect()
    }, [initialScrollSettled, props.hasMoreMessages, props.isLoadingMessages])

    useLayoutEffect(() => {
        const pending = pendingAnchorRef.current
        const viewport = viewportRef.current
        if (!pending || !viewport) {
            return
        }
        const restoreDeadlineAt = armHistoryLoadCleanupTimer(pending.direction)
        if (restoreDeadlineAt === null) {
            return
        }
        if (anchorRestoreFrameRef.current !== null) {
            cancelAnimationFrame(anchorRestoreFrameRef.current)
            anchorRestoreFrameRef.current = null
        }
        let cancelled = false
        let stableExactFrames = 0
        const restoreExactAnchor = () => {
            if (cancelled) {
                return
            }
            if (pendingAnchorRef.current !== pending || !pending.id) {
                releaseHistoryLoad(pending.direction)
                return
            }
            if (performance.now() >= restoreDeadlineAt) {
                releaseHistoryLoad(pending.direction)
                return
            }
            const result = virtualizedMessagesRef.current?.restoreMessageAnchor(
                pending.id,
                pending.offset,
            )
            if (result?.mounted && result.deviation !== null && result.deviation > 0.5) {
                const maxScrollTop = Math.max(
                    0,
                    viewport.scrollHeight - viewport.clientHeight,
                )
                const requiredScrollTop = viewport.scrollTop + result.deviation
                const shortfall = requiredScrollTop - maxScrollTop
                if (shortfall > 0.5) {
                    updateAnchorTailSpacer(anchorTailSpacerRef.current + shortfall)
                }
            }
            if (result && !result.found) {
                releaseHistoryLoad(pending.direction)
                return
            }
            if (
                result?.mounted
                && result.deviation !== null
                && Math.abs(result.deviation) <= 0.5
            ) {
                stableExactFrames += 1
            } else {
                stableExactFrames = 0
            }
            if (stableExactFrames >= ANCHOR_RESTORE_STABLE_FRAMES) {
                releaseHistoryLoad(pending.direction)
                return
            }
            const frameId = requestAnimationFrame(() => {
                if (anchorRestoreFrameRef.current === frameId) {
                    anchorRestoreFrameRef.current = null
                }
                restoreExactAnchor()
            })
            anchorRestoreFrameRef.current = frameId
        }
        restoreExactAnchor()
        return () => {
            cancelled = true
            if (anchorRestoreFrameRef.current !== null) {
                cancelAnimationFrame(anchorRestoreFrameRef.current)
                anchorRestoreFrameRef.current = null
            }
        }
    }, [armHistoryLoadCleanupTimer, props.messagesVersion, releaseHistoryLoad, updateAnchorTailSpacer])

    useEffect(() => {
        isLoadingMoreRef.current = props.isLoadingMoreMessages
    }, [props.isLoadingMoreMessages])

    useEffect(() => {
        isLoadingNewerRef.current = props.isLoadingNewerMessages
    }, [props.isLoadingNewerMessages])

    const showSkeleton = props.isLoadingMessages && props.rawMessagesCount === 0 && props.pendingCount === 0

    return (
        <HappyChatProvider value={{
            api: props.api,
            sessionId: props.sessionId,
            metadata: props.metadata,
            disabled: props.disabled,
            onRefresh: props.onRefresh,
            onRetryMessage: props.onRetryMessage
        }}>
            <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col relative">
                <ThreadPrimitive.Viewport asChild autoScroll={autoScrollEnabled}>
                    <div ref={viewportRef} className="app-scroll-y min-h-0 flex-1 overflow-x-hidden">
                        <div className="mx-auto w-full max-w-content min-w-0 p-3">
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

                                    {props.hasMoreMessages && !props.isLoadingMessages ? (
                                        <div className="py-1 mb-2">
                                            <div className="mx-auto w-fit">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={handleLoadMore}
                                                    disabled={props.isLoadingMoreMessages || props.isLoadingMessages}
                                                    aria-busy={props.isLoadingMoreMessages}
                                                    className="gap-1.5 text-xs opacity-80 hover:opacity-100"
                                                >
                                                    {props.isLoadingMoreMessages ? (
                                                        <>
                                                            <Spinner size="sm" label={null} className="text-current" />
                                                            {t('misc.loading')}
                                                        </>
                                                    ) : (
                                                        <>
                                                            <span aria-hidden="true">↑</span>
                                                            {t('misc.loadOlder')}
                                                        </>
                                                    )}
                                                </Button>
                                            </div>
                                        </div>
                                    ) : null}

                                    {import.meta.env.DEV && props.normalizedMessagesCount === 0 && props.rawMessagesCount > 0 ? (
                                        <div className="mb-2 rounded-md bg-amber-500/10 p-2 text-xs">
                                            Message normalization returned 0 items for {props.rawMessagesCount} messages (see `web/src/chat/normalize.ts`).
                                        </div>
                                    ) : null}
                                </>
                            )}
                            <VirtualizedThreadMessages
                                ref={virtualizedMessagesRef}
                                viewportRef={viewportRef}
                                components={THREAD_MESSAGE_COMPONENTS}
                            />
                            {props.hasNewerMessages && !props.isLoadingMessages ? (
                                <div className="mt-2 flex flex-wrap justify-center gap-2 py-1">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={handleLoadNewer}
                                        disabled={props.isLoadingNewerMessages || isReturningToLatest}
                                        aria-busy={props.isLoadingNewerMessages}
                                        className="gap-1.5 text-xs opacity-80 hover:opacity-100"
                                    >
                                        {props.isLoadingNewerMessages ? (
                                            <>
                                                <Spinner size="sm" label={null} className="text-current" />
                                                {t('misc.loading')}
                                            </>
                                        ) : (
                                            <>
                                                <span aria-hidden="true">↓</span>
                                                {t('misc.loadNewer')}
                                            </>
                                        )}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => void handleReturnToLatest()}
                                        disabled={isReturningToLatest}
                                        aria-busy={isReturningToLatest}
                                        className="gap-1.5 text-xs opacity-80 hover:opacity-100"
                                    >
                                        <span aria-hidden="true">⇣</span>
                                        {t('misc.returnToLatest')}
                                    </Button>
                                </div>
                            ) : null}
                            {anchorTailSpacerPx > 0 ? (
                                <div
                                    aria-hidden="true"
                                    data-testid="anchor-tail-spacer"
                                    style={{ height: anchorTailSpacerPx }}
                                />
                            ) : null}
                        </div>
                    </div>
                </ThreadPrimitive.Viewport>
                <NewMessagesIndicator count={props.pendingCount} onClick={() => void handleReturnToLatest()} />
            </ThreadPrimitive.Root>
        </HappyChatProvider>
    )
}
