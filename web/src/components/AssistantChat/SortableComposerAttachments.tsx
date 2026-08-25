import { ComposerPrimitive } from '@assistant-ui/react'
import type { Attachment } from '@assistant-ui/react'
import {
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import { type AttachmentDropPosition } from '@/lib/attachmentOrder'
import { AttachmentItem, type AttachmentDragHandleProps } from './AttachmentItem'

const DRAG_START_DISTANCE_PX = 6

type DragState = {
    id: string
    pointerId: number
    startX: number
    startY: number
    started: boolean
}

type SortableComposerAttachmentProps = {
    attachment: Attachment
    index: number
    isDragging: boolean
    disabled: boolean
    onPointerDown: (event: ReactPointerEvent<Element>, id: string, surface: boolean) => void
    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, id: string) => void
    onContextMenu: (event: ReactMouseEvent<Element>, id: string) => void
    onClick: (event: ReactMouseEvent<Element>, id: string) => void
}

type AttachmentDropTarget = {
    id: string
    position: AttachmentDropPosition
}

function findAttachmentDropTarget(clientX: number, clientY: number): AttachmentDropTarget | null {
    if (typeof document.elementsFromPoint !== 'function') return null

    for (const element of document.elementsFromPoint(clientX, clientY)) {
        const target = element.closest<HTMLElement>('[data-hapi-composer-attachment-id]')
        const id = target?.dataset.hapiComposerAttachmentId
        if (id && target) {
            const rect = target.getBoundingClientRect()
            const position = clientX >= rect.left + rect.width / 2 ? 'after' : 'before'
            return { id, position }
        }
    }
    return null
}

function SortableComposerAttachment(props: SortableComposerAttachmentProps) {
    const {
        attachment,
        index,
        isDragging,
        disabled,
        onPointerDown,
        onKeyDown,
        onContextMenu,
        onClick,
    } = props
    const handlePointerDown = useCallback(
        (event: ReactPointerEvent<HTMLButtonElement>) => onPointerDown(event, attachment.id, false),
        [attachment.id, onPointerDown],
    )
    const handleSurfacePointerDown = useCallback(
        (event: ReactPointerEvent<HTMLElement>) => onPointerDown(event, attachment.id, true),
        [attachment.id, onPointerDown],
    )
    const handleKeyDown = useCallback(
        (event: ReactKeyboardEvent<HTMLButtonElement>) => onKeyDown(event, attachment.id),
        [attachment.id, onKeyDown],
    )
    const handleContextMenu = useCallback(
        (event: ReactMouseEvent<HTMLElement>) => onContextMenu(event, attachment.id),
        [attachment.id, onContextMenu],
    )
    const handleClick = useCallback(
        (event: ReactMouseEvent<HTMLElement>) => onClick(event, attachment.id),
        [attachment.id, onClick],
    )
    const dragHandleProps = useMemo<AttachmentDragHandleProps | undefined>(
        () => disabled
            ? undefined
            : {
                onPointerDown: handlePointerDown,
                onKeyDown: handleKeyDown,
                ariaLabel: `Reorder attachment ${attachment.name}`,
                title: 'Drag to reorder attachment',
                onSurfacePointerDown: handleSurfacePointerDown,
                onSurfaceContextMenu: handleContextMenu,
                onSurfaceClick: handleClick,
            },
        [attachment.name, disabled, handleKeyDown, handlePointerDown],
    )
    const AttachmentWithHandle = useCallback(
        () => <AttachmentItem dragHandleProps={dragHandleProps} />,
        [dragHandleProps],
    )

    return (
        <div
            data-hapi-composer-attachment-id={attachment.id}
            data-hapi-composer-attachment-dragging={isDragging || undefined}
            className={isDragging ? 'opacity-60' : undefined}
        >
            <ComposerPrimitive.AttachmentByIndex
                index={index}
                components={{ Attachment: AttachmentWithHandle }}
            />
        </div>
    )
}

export function SortableComposerAttachments(props: {
    attachments: readonly Attachment[]
    orderedAttachmentIds: readonly string[]
    disabled?: boolean
    onReorder: (activeId: string, targetId: string, position: AttachmentDropPosition) => void
}) {
    const { attachments, orderedAttachmentIds, onReorder, disabled = false } = props
    const [draggingId, setDraggingId] = useState<string | null>(null)
    const dragRef = useRef<DragState | null>(null)
    const suppressClickIdRef = useRef<string | null>(null)

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            const drag = dragRef.current
            if (!drag || drag.pointerId !== event.pointerId) return

            if (!drag.started) {
                const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY)
                if (distance < DRAG_START_DISTANCE_PX) return
                drag.started = true
                event.preventDefault()
                setDraggingId(drag.id)
            }

            const target = findAttachmentDropTarget(event.clientX, event.clientY)
            if (target && target.id !== drag.id) {
                onReorder(drag.id, target.id, target.position)
            }
        }

        const finishDrag = (event: PointerEvent) => {
            const drag = dragRef.current
            if (!drag || drag.pointerId !== event.pointerId) return
            if (drag.started) {
                suppressClickIdRef.current = drag.id
            }
            dragRef.current = null
            setDraggingId(null)
        }

        document.addEventListener('pointermove', handlePointerMove)
        document.addEventListener('pointerup', finishDrag)
        document.addEventListener('pointercancel', finishDrag)
        return () => {
            document.removeEventListener('pointermove', handlePointerMove)
            document.removeEventListener('pointerup', finishDrag)
            document.removeEventListener('pointercancel', finishDrag)
        }
    }, [onReorder])

    const handlePointerDown = useCallback(
        (event: ReactPointerEvent<Element>, id: string, surface: boolean) => {
            if (disabled || event.button !== 0) return
            if (!surface) {
                event.preventDefault()
                event.stopPropagation()
            }
            if (typeof event.currentTarget.setPointerCapture === 'function') {
                event.currentTarget.setPointerCapture(event.pointerId)
            }
            dragRef.current = {
                id,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                started: false,
            }
        },
        [disabled],
    )

    const handleContextMenu = useCallback(
        (event: ReactMouseEvent<Element>, id: string) => {
            if (dragRef.current?.id !== id && suppressClickIdRef.current !== id) return
            event.preventDefault()
            event.stopPropagation()
        },
        [],
    )

    const handleClick = useCallback(
        (event: ReactMouseEvent<Element>, id: string) => {
            if (suppressClickIdRef.current !== id) return
            event.preventDefault()
            event.stopPropagation()
            suppressClickIdRef.current = null
        },
        [],
    )

    const handleKeyDown = useCallback(
        (event: ReactKeyboardEvent<HTMLButtonElement>, id: string) => {
            if (disabled) return

            const currentIndex = orderedAttachmentIds.indexOf(id)
            if (currentIndex < 0) return

            let targetIndex: number | null = null
            let targetPosition: AttachmentDropPosition = 'before'
            if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                targetIndex = currentIndex - 1
            } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                targetIndex = currentIndex + 1
                targetPosition = 'after'
            } else if (event.key === 'Home') {
                targetIndex = 0
            } else if (event.key === 'End') {
                targetIndex = orderedAttachmentIds.length - 1
                targetPosition = 'after'
            }

            if (
                targetIndex === null
                || targetIndex < 0
                || targetIndex >= orderedAttachmentIds.length
                || targetIndex === currentIndex
            ) {
                return
            }

            event.preventDefault()
            onReorder(id, orderedAttachmentIds[targetIndex]!, targetPosition)
        },
        [disabled, onReorder, orderedAttachmentIds],
    )

    const attachmentById = useMemo(
        () => new Map(attachments.map((attachment) => [attachment.id, attachment])),
        [attachments],
    )

    return (
        <>
            {orderedAttachmentIds.map((id) => {
                const attachment = attachmentById.get(id)
                if (!attachment) return null
                const index = attachments.findIndex((item) => item.id === id)
                if (index < 0) return null
                return (
                    <SortableComposerAttachment
                        key={id}
                        attachment={attachment}
                        index={index}
                        isDragging={draggingId === id}
                        disabled={disabled}
                        onPointerDown={handlePointerDown}
                        onKeyDown={handleKeyDown}
                        onContextMenu={handleContextMenu}
                        onClick={handleClick}
                    />
                )
            })}
        </>
    )
}
