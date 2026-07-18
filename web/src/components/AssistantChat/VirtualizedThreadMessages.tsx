import {
    forwardRef,
    useCallback,
    useImperativeHandle,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ComponentProps,
    type ComponentType,
    type RefObject,
} from 'react'
import { ThreadPrimitive, useAssistantState } from '@assistant-ui/react'
import { useVirtualizer } from '@tanstack/react-virtual'

type ThreadMessageComponents = ComponentProps<typeof ThreadPrimitive.Messages>['components']
const VIRTUALIZE_MESSAGE_THRESHOLD = 200

function getMessageComponent(
    components: ThreadMessageComponents,
    role: 'user' | 'assistant' | 'system',
    isEditing: boolean,
): ComponentType | null {
    const fallback = components.Message

    if (role === 'user') {
        return isEditing
            ? components.UserEditComposer ?? components.EditComposer ?? components.UserMessage ?? fallback ?? null
            : components.UserMessage ?? fallback ?? null
    }
    if (role === 'assistant') {
        return isEditing
            ? components.AssistantEditComposer ?? components.EditComposer ?? components.AssistantMessage ?? fallback ?? null
            : components.AssistantMessage ?? fallback ?? null
    }
    if (isEditing) {
        return components.SystemEditComposer ?? components.EditComposer ?? components.SystemMessage ?? fallback ?? null
    }
    return components.SystemMessage ?? null
}

export type MessageAnchorRestoreResult = {
    found: boolean
    mounted: boolean
    deviation: number | null
}

export type VirtualizedThreadMessagesHandle = {
    restoreMessageAnchor: (messageId: string, viewportOffset: number) => MessageAnchorRestoreResult
}

type VirtualizedThreadMessagesProps = {
    viewportRef: RefObject<HTMLDivElement | null>
    components: ThreadMessageComponents
}

export const VirtualizedThreadMessages = forwardRef<
    VirtualizedThreadMessagesHandle,
    VirtualizedThreadMessagesProps
>(function VirtualizedThreadMessages(props, ref) {
    const threadMessages = useAssistantState(({ thread }) => thread.messages)
    const messageIds = useMemo(
        () => threadMessages.map((message) => message.id),
        [threadMessages],
    )
    const listRef = useRef<HTMLDivElement | null>(null)
    const lastViewportElementRef = useRef<HTMLDivElement | null>(null)
    const [scrollMargin, setScrollMargin] = useState(0)
    const shouldVirtualize = messageIds.length > VIRTUALIZE_MESSAGE_THRESHOLD
    const getScrollElement = useCallback(() => {
        const viewport = props.viewportRef.current
        if (viewport) {
            lastViewportElementRef.current = viewport
        }
        return viewport ?? lastViewportElementRef.current
    }, [props.viewportRef])
    const staticMessageComponents = useMemo<ThreadMessageComponents>(() => {
        const StaticMessageRow = () => {
            const messageId = useAssistantState(({ message }) => message.id)
            const index = useAssistantState(({ message }) => message.index)
            const role = useAssistantState(({ message }) => message.role)
            const isEditing = useAssistantState(({ message }) => message.composer.isEditing)
            const Component = getMessageComponent(props.components, role, isEditing)
            return (
                <div
                    data-index={index}
                    data-testid="virtual-thread-row"
                    data-hapi-message-id={messageId}
                    className="w-full pb-3"
                >
                    {Component ? <Component /> : null}
                </div>
            )
        }
        // assistant-ui intentionally does not fall back from a non-editing
        // system role to components.Message. Register the same row wrapper for
        // SystemMessage so event/system rows remain present on the native side
        // of the 200/201 virtualization threshold.
        return { Message: StaticMessageRow, SystemMessage: StaticMessageRow }
    }, [props.components])

    const measureScrollMargin = useCallback(() => {
        const viewport = props.viewportRef.current
        const list = listRef.current
        if (!viewport || !list) {
            return
        }
        const viewportRect = viewport.getBoundingClientRect()
        const listRect = list.getBoundingClientRect()
        const next = Math.max(0, viewport.scrollTop + listRect.top - viewportRect.top)
        setScrollMargin((current) => Math.abs(current - next) < 0.5 ? current : next)
    }, [props.viewportRef])

    useLayoutEffect(() => {
        measureScrollMargin()
    })

    useLayoutEffect(() => {
        const viewport = props.viewportRef.current
        if (!viewport) {
            return
        }
        const resizeObserver = typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver(measureScrollMargin)
        resizeObserver?.observe(viewport)
        window.addEventListener('resize', measureScrollMargin)
        return () => {
            resizeObserver?.disconnect()
            window.removeEventListener('resize', measureScrollMargin)
        }
    }, [measureScrollMargin, props.viewportRef])

    const virtualizer = useVirtualizer({
        enabled: shouldVirtualize,
        count: messageIds.length,
        getScrollElement,
        getItemKey: (index) => messageIds[index] ?? index,
        estimateSize: () => 72,
        overscan: 12,
        scrollMargin,
        initialRect: {
            width: props.viewportRef.current?.clientWidth || 0,
            height: props.viewportRef.current?.clientHeight || 800,
        },
    })
    const virtualItems = virtualizer.getVirtualItems()

    useImperativeHandle(ref, () => ({
        restoreMessageAnchor(messageId, viewportOffset) {
            const index = messageIds.indexOf(messageId)
            if (index < 0) {
                return { found: false, mounted: false, deviation: null }
            }

            const viewport = props.viewportRef.current
            if (!viewport || (shouldVirtualize && virtualizer.scrollElement === null)) {
                return { found: true, mounted: false, deviation: null }
            }

            const mountedRow = Array.from(
                viewport.querySelectorAll<HTMLElement>('[data-hapi-message-id]'),
            ).find((row) => row.dataset.hapiMessageId === messageId)
            if (mountedRow) {
                const deviation = mountedRow.getBoundingClientRect().top
                    - viewport.getBoundingClientRect().top
                    - viewportOffset
                if (Math.abs(deviation) > 0.5) {
                    if (shouldVirtualize) {
                        virtualizer.scrollToOffset(viewport.scrollTop + deviation, {
                            align: 'start',
                            behavior: 'auto',
                        })
                    } else {
                        viewport.scrollTo({
                            top: viewport.scrollTop + deviation,
                            behavior: 'auto',
                        })
                    }
                }
                return { found: true, mounted: true, deviation }
            }

            const measurement = virtualizer.measurementsCache[index]
            if (!measurement) {
                return { found: true, mounted: false, deviation: null }
            }
            virtualizer.scrollToOffset(measurement.start - viewportOffset, {
                align: 'start',
                behavior: 'auto',
            })
            return { found: true, mounted: false, deviation: null }
        },
    }), [messageIds, props.viewportRef, shouldVirtualize, virtualizer])

    if (!shouldVirtualize) {
        return (
            <div ref={listRef} className="happy-thread-messages w-full">
                <ThreadPrimitive.Messages components={staticMessageComponents} />
            </div>
        )
    }

    return (
        <div
            ref={listRef}
            className="happy-thread-messages relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
        >
            {virtualItems.map((virtualItem) => (
                <div
                    key={virtualItem.key}
                    ref={virtualizer.measureElement}
                    data-index={virtualItem.index}
                    data-testid="virtual-thread-row"
                    data-hapi-message-id={messageIds[virtualItem.index]}
                    className="absolute left-0 top-0 w-full pb-3"
                    style={{
                        transform: `translateY(${virtualItem.start - scrollMargin}px)`,
                    }}
                >
                    <ThreadPrimitive.MessageByIndex
                        index={virtualItem.index}
                        components={props.components}
                    />
                </div>
            ))}
        </div>
    )
})
