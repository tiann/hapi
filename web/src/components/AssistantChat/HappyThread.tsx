import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ThreadPrimitive } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { HappyAssistantMessage } from '@/components/AssistantChat/messages/AssistantMessage'
import { HappyUserMessage } from '@/components/AssistantChat/messages/UserMessage'
import { HappySystemMessage } from '@/components/AssistantChat/messages/SystemMessage'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'

function NewMessagesIndicator(props: { count: number; onClick: () => void }) {
    if (props.count === 0) {
        return null
    }

    return (
        <button
            onClick={props.onClick}
            className="absolute bottom-20 left-1/2 -translate-x-1/2 bg-[var(--app-button)] text-[var(--app-button-text)] px-3 py-1.5 rounded-full text-sm font-medium shadow-lg animate-bounce-in z-10"
        >
            {props.count} new message{props.count > 1 ? 's' : ''} &#8595;
        </button>
    )
}

function MessageSkeleton() {
    const rows = [
        { align: 'end', width: 'w-2/3', height: 'h-10' },
        { align: 'start', width: 'w-3/4', height: 'h-12' },
        { align: 'end', width: 'w-1/2', height: 'h-9' },
        { align: 'start', width: 'w-5/6', height: 'h-14' }
    ]

    return (
        <div role="status" aria-live="polite">
            <span className="sr-only">Loading messages…</span>
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

export function HappyThread(props: {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    disabled: boolean
    onRefresh: () => void
    onRetryMessage?: (localId: string) => void
    isLoadingMessages: boolean
    messagesWarning: string | null
    hasMoreMessages: boolean
    isLoadingMoreMessages: boolean
    onLoadMore: () => Promise<unknown>
    rawMessagesCount: number
    normalizedMessagesCount: number
    renderedMessagesCount: number
}) {
    const viewportRef = useRef<HTMLDivElement | null>(null)
    const topSentinelRef = useRef<HTMLDivElement | null>(null)
    const loadLockRef = useRef(false)
    const pendingScrollRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null)
    const prevLoadingMoreRef = useRef(false)
    const loadStartedRef = useRef(false)
    const isLoadingMoreRef = useRef(props.isLoadingMoreMessages)

    // Smart scroll state: autoScroll enabled when user is near bottom
    const [autoScrollEnabled, setAutoScrollEnabled] = useState(true)
    const [newMessageCount, setNewMessageCount] = useState(0)
    const prevRenderedCountRef = useRef(props.renderedMessagesCount)
    const autoScrollEnabledRef = useRef(autoScrollEnabled)
    const newMessageCountRef = useRef(newMessageCount)
    const hasBootstrappedRef = useRef(false)

    // Keep refs in sync with state
    useEffect(() => {
        autoScrollEnabledRef.current = autoScrollEnabled
    }, [autoScrollEnabled])
    useEffect(() => {
        newMessageCountRef.current = newMessageCount
    }, [newMessageCount])

    // Track scroll position to toggle autoScroll (stable listener using refs)
    useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) return

        const THRESHOLD_PX = 120

        const handleScroll = () => {
            const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
            const isNearBottom = distanceFromBottom < THRESHOLD_PX

            if (isNearBottom) {
                if (!autoScrollEnabledRef.current) setAutoScrollEnabled(true)
                if (newMessageCountRef.current > 0) setNewMessageCount(0)
            } else {
                if (autoScrollEnabledRef.current) setAutoScrollEnabled(false)
            }
        }

        viewport.addEventListener('scroll', handleScroll, { passive: true })
        return () => viewport.removeEventListener('scroll', handleScroll)
    }, []) // Stable: no dependencies, reads from refs

    // Track new messages when autoScroll is disabled
    const wasLoadingMoreRef = useRef(props.isLoadingMoreMessages)
    useEffect(() => {
        const prevCount = prevRenderedCountRef.current
        const currentCount = props.renderedMessagesCount
        const wasLoadingMore = wasLoadingMoreRef.current
        wasLoadingMoreRef.current = props.isLoadingMoreMessages

        if (props.isLoadingMessages) {
            prevRenderedCountRef.current = currentCount
            return
        }

        if (!hasBootstrappedRef.current) {
            hasBootstrappedRef.current = true
            prevRenderedCountRef.current = currentCount
            return
        }

        prevRenderedCountRef.current = currentCount

        // Skip during loading states
        if (props.isLoadingMoreMessages) {
            return
        }

        // Skip if load-more just finished (older messages, not new ones)
        if (wasLoadingMore) {
            return
        }

        const newCount = currentCount - prevCount
        if (newCount > 0 && !autoScrollEnabled) {
            setNewMessageCount((prev) => prev + newCount)
        }
    }, [props.renderedMessagesCount, props.isLoadingMoreMessages, props.isLoadingMessages, autoScrollEnabled])

    // Scroll to bottom handler for the indicator button
    const scrollToBottom = useCallback(() => {
        const viewport = viewportRef.current
        if (viewport) {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
        }
        setAutoScrollEnabled(true)
        setNewMessageCount(0)
    }, [])

    // Reset state when session changes
    useEffect(() => {
        setAutoScrollEnabled(true)
        setNewMessageCount(0)
        prevRenderedCountRef.current = 0
        hasBootstrappedRef.current = false
    }, [props.sessionId])

    const handleLoadMore = useCallback(() => {
        if (props.isLoadingMessages || !props.hasMoreMessages || props.isLoadingMoreMessages || loadLockRef.current) {
            return
        }
        const viewport = viewportRef.current
        if (!viewport) {
            return
        }
        pendingScrollRef.current = {
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight
        }
        loadLockRef.current = true
        loadStartedRef.current = false
        let loadPromise: Promise<unknown>
        try {
            loadPromise = props.onLoadMore()
        } catch (error) {
            pendingScrollRef.current = null
            loadLockRef.current = false
            throw error
        }
        void loadPromise.catch((error) => {
            pendingScrollRef.current = null
            loadLockRef.current = false
            console.error('Failed to load older messages:', error)
        }).finally(() => {
            if (!loadStartedRef.current && !isLoadingMoreRef.current && pendingScrollRef.current) {
                pendingScrollRef.current = null
                loadLockRef.current = false
            }
        })
    }, [props.hasMoreMessages, props.isLoadingMoreMessages, props.isLoadingMessages, props.onLoadMore])

    useEffect(() => {
        const sentinel = topSentinelRef.current
        const viewport = viewportRef.current
        if (!sentinel || !viewport || !props.hasMoreMessages || props.isLoadingMessages) {
            return
        }
        if (typeof IntersectionObserver === 'undefined') {
            return
        }

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        handleLoadMore()
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
    }, [handleLoadMore, props.hasMoreMessages, props.isLoadingMessages])

    useLayoutEffect(() => {
        const pending = pendingScrollRef.current
        const viewport = viewportRef.current
        if (!pending || !viewport) {
            return
        }
        const delta = viewport.scrollHeight - pending.scrollHeight
        viewport.scrollTop = pending.scrollTop + delta
        pendingScrollRef.current = null
        loadLockRef.current = false
    }, [props.rawMessagesCount])

    useEffect(() => {
        isLoadingMoreRef.current = props.isLoadingMoreMessages
        if (props.isLoadingMoreMessages) {
            loadStartedRef.current = true
        }
        if (prevLoadingMoreRef.current && !props.isLoadingMoreMessages && pendingScrollRef.current) {
            pendingScrollRef.current = null
            loadLockRef.current = false
        }
        prevLoadingMoreRef.current = props.isLoadingMoreMessages
    }, [props.isLoadingMoreMessages])

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
                    <div ref={viewportRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
                        <div className="mx-auto w-full max-w-content min-w-0 p-3">
                            <div ref={topSentinelRef} className="h-px w-full" aria-hidden="true" />
                            {props.isLoadingMessages ? (
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
                                                            Loading…
                                                        </>
                                                    ) : (
                                                        <>
                                                            <span aria-hidden="true">↑</span>
                                                            Load older
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
                            <div className="flex flex-col gap-3">
                                <ThreadPrimitive.Messages components={THREAD_MESSAGE_COMPONENTS} />
                            </div>
                        </div>
                    </div>
                </ThreadPrimitive.Viewport>
                <NewMessagesIndicator count={newMessageCount} onClick={scrollToBottom} />
            </ThreadPrimitive.Root>
        </HappyChatProvider>
    )
}
