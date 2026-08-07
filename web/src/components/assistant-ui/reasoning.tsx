import { useState, useCallback, useEffect, useLayoutEffect, useRef, type FC, type KeyboardEvent, type PropsWithChildren, type UIEvent } from 'react'
import { useMessage } from '@assistant-ui/react'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import { cn } from '@/lib/utils'
import { useReasoningCollapse } from '@/hooks/useReasoningCollapse'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import {
    MARKDOWN_CLASSNAME,
    MARKDOWN_COMPONENTS_BY_LANGUAGE,
    MARKDOWN_PLUGINS,
    MARKDOWN_REHYPE_PLUGINS,
    defaultComponents,
    denyOnlyTransform,
    UriConfirmProvider,
} from '@/components/assistant-ui/markdown-text'

function ChevronIcon(props: { className?: string; open?: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn(
                'transition-transform duration-200',
                props.open ? 'rotate-90' : '',
                props.className
            )}
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function ShimmerDot() {
    return (
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
    )
}

export const Reasoning: FC = () => {
    return (
        <UriConfirmProvider>
            <MarkdownTextPrimitive
                remarkPlugins={MARKDOWN_PLUGINS}
                rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                components={defaultComponents}
                componentsByLanguage={MARKDOWN_COMPONENTS_BY_LANGUAGE}
                urlTransform={denyOnlyTransform}
                className={cn(MARKDOWN_CLASSNAME, 'aui-reasoning-content text-[13.5px] text-[var(--app-hint)]')}
            />
        </UriConfirmProvider>
    )
}

export const ReasoningGroup: FC<PropsWithChildren> = ({ children }) => {
    const [isOpen, setIsOpen] = useState(false)
    const scrollRef = useRef<HTMLDivElement | null>(null)
    const followLatestRef = useRef(true)
    const pointerActiveRef = useRef(false)
    const pointerCleanupRef = useRef<(() => void) | null>(null)
    const followSyncFrameRef = useRef<number | null>(null)

    const message = useMessage()
    const isStreaming = message.status?.type === 'running'
        && message.content.length > 0
        && message.content[message.content.length - 1]?.type === 'reasoning'
    const { reasoningCollapsed } = useReasoningCollapse()
    const chatContext = useOptionalHappyChatContext()

    useEffect(() => {
        if (!isStreaming) return
        const nextOpen = !reasoningCollapsed
        if (nextOpen) {
            followLatestRef.current = true
        }
        setIsOpen(nextOpen)
    }, [isStreaming, reasoningCollapsed])

    useEffect(() => {
        if (isOpen || followLatestRef.current) return
        followLatestRef.current = true
        chatContext?.onNestedScrollFollowChange?.(true)
    }, [isOpen, chatContext])

    useLayoutEffect(() => {
        const scroll = scrollRef.current
        if (!scroll || !isOpen || !isStreaming || !followLatestRef.current) return
        scroll.scrollTop = scroll.scrollHeight
    })

    const handleToggle = () => {
        const nextOpen = !isOpen
        if (nextOpen && isStreaming) {
            followLatestRef.current = true
        }
        setIsOpen(nextOpen)
    }

    const syncNestedFollow = useCallback(() => {
        const scroll = scrollRef.current
        if (!scroll) return
        const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 8
        const followLatest = atBottom && !pointerActiveRef.current
        followLatestRef.current = followLatest
        chatContext?.onNestedScrollFollowChange?.(followLatest)
    }, [chatContext])

    const handleScroll = (_event: UIEvent<HTMLDivElement>) => {
        syncNestedFollow()
    }

    const claimNestedScroll = () => {
        chatContext?.onNestedScrollFollowChange?.(false)
    }

    const scheduleNestedFollowSync = () => {
        if (followSyncFrameRef.current !== null) {
            window.cancelAnimationFrame(followSyncFrameRef.current)
        }
        followSyncFrameRef.current = window.requestAnimationFrame(() => {
            followSyncFrameRef.current = null
            syncNestedFollow()
        })
    }

    const claimNestedPointerScroll = () => {
        pointerActiveRef.current = true
        followLatestRef.current = false
        claimNestedScroll()
        pointerCleanupRef.current?.()

        const finish = () => {
            pointerCleanupRef.current?.()
            pointerActiveRef.current = false
            syncNestedFollow()
        }
        const cleanup = () => {
            window.removeEventListener('pointerup', finish)
            window.removeEventListener('pointercancel', finish)
            pointerCleanupRef.current = null
        }
        pointerCleanupRef.current = cleanup
        window.addEventListener('pointerup', finish, { once: true })
        window.addEventListener('pointercancel', finish, { once: true })
    }

    const claimNestedWheelScroll = () => {
        claimNestedScroll()
        scheduleNestedFollowSync()
    }

    const claimNestedKeyboardScroll = (event: KeyboardEvent<HTMLDivElement>) => {
        if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return
        claimNestedScroll()
        scheduleNestedFollowSync()
    }

    useEffect(() => () => {
        pointerCleanupRef.current?.()
        if (followSyncFrameRef.current !== null) {
            window.cancelAnimationFrame(followSyncFrameRef.current)
        }
    }, [])

    return (
        <div data-hapi-share-exclude="true" className="aui-reasoning-group my-3 overflow-hidden rounded-2xl bg-[var(--app-reasoning-bg)]">
            <button
                type="button"
                onClick={handleToggle}
                className={cn(
                    'flex w-full items-center gap-1.5 px-3.5 py-2.5 text-left text-xs font-medium',
                    'text-[var(--app-hint)] hover:text-[var(--app-fg)]',
                    'transition-colors cursor-pointer select-none'
                )}
            >
                <ChevronIcon open={isOpen} />
                <span>Reasoning</span>
                {isStreaming && (
                    <span className="ml-1 flex items-center gap-1 text-[var(--app-hint)]">
                        <ShimmerDot />
                    </span>
                )}
            </button>

            <div
                className={cn(
                    'overflow-hidden transition-all duration-200 ease-in-out',
                    isOpen ? 'max-h-[5000px] opacity-100' : 'max-h-0 opacity-0'
                )}
            >
                <div
                    ref={scrollRef}
                    data-hapi-nested-scroll="true"
                    tabIndex={isOpen ? 0 : -1}
                    onScroll={handleScroll}
                    onPointerDown={claimNestedPointerScroll}
                    onWheel={claimNestedWheelScroll}
                    onKeyDown={claimNestedKeyboardScroll}
                    className="aui-reasoning-scroll max-h-[60vh] overflow-y-auto overscroll-y-contain border-t border-[var(--app-divider)] px-3.5 py-3"
                >
                    {children}
                </div>
            </div>
        </div>
    )
}
