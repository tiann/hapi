import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode, type SyntheticEvent, type WheelEvent } from 'react'
import { CloseIcon } from '@/components/icons'

const MIN_IMAGE_SCALE = 0.25
const MAX_IMAGE_SCALE = 8
const IMAGE_SCALE_STEP = 0.25
const BACKDROP_CLICK_MAX_MOVEMENT = 4

function clampImageScale(value: number): number {
    return Math.min(MAX_IMAGE_SCALE, Math.max(MIN_IMAGE_SCALE, value))
}

type ImagePoint = { x: number; y: number }

function getPointDistance(a: ImagePoint, b: ImagePoint): number {
    return Math.hypot(a.x - b.x, a.y - b.y)
}

function getPointCenter(a: ImagePoint, b: ImagePoint): ImagePoint {
    return {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2
    }
}

export function ImagePreview(props: {
    src: string
    fileName: string
    label: string
    buttonClassName?: string
    imageClassName?: string
    caption?: ReactNode
}) {
    const [viewerOpen, setViewerOpen] = useState(false)
    const [scale, setScale] = useState(1)
    const [offset, setOffset] = useState({ x: 0, y: 0 })
    const scaleRef = useRef(scale)
    const offsetRef = useRef(offset)
    const activePointersRef = useRef(new Map<number, ImagePoint>())
    const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null)
    const pinchRef = useRef<{ startDistance: number; startScale: number; startCenter: ImagePoint; origin: ImagePoint } | null>(null)
    const backdropPressRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)

    const stopEvent = useCallback((event: SyntheticEvent) => {
        event.stopPropagation()
    }, [])

    const openViewer = useCallback((event: SyntheticEvent) => {
        event.preventDefault()
        event.stopPropagation()
        setViewerOpen(true)
    }, [])

    const updateScale = useCallback((next: number | ((current: number) => number)) => {
        setScale((current) => {
            const value = typeof next === 'function' ? next(current) : next
            scaleRef.current = value
            return value
        })
    }, [])

    const updateOffset = useCallback((next: ImagePoint) => {
        offsetRef.current = next
        setOffset(next)
    }, [])

    const resetView = useCallback(() => {
        updateScale(1)
        updateOffset({ x: 0, y: 0 })
    }, [updateOffset, updateScale])

    const closeViewer = useCallback(() => {
        setViewerOpen(false)
        activePointersRef.current.clear()
        dragRef.current = null
        pinchRef.current = null
        backdropPressRef.current = null
        resetView()
    }, [resetView])

    const zoomBy = useCallback((delta: number) => {
        updateScale((current) => clampImageScale(current + delta))
    }, [updateScale])

    const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
        event.preventDefault()
        const delta = event.deltaY < 0 ? IMAGE_SCALE_STEP : -IMAGE_SCALE_STEP
        zoomBy(delta)
    }, [zoomBy])

    const beginPinch = useCallback(() => {
        const pointers = Array.from(activePointersRef.current.values())
        if (pointers.length < 2) return

        const [first, second] = pointers
        pinchRef.current = {
            startDistance: getPointDistance(first, second),
            startScale: scaleRef.current,
            startCenter: getPointCenter(first, second),
            origin: offsetRef.current
        }
        dragRef.current = null
    }, [])

    const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
        backdropPressRef.current = event.target === event.currentTarget
            ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
            : null

        if (activePointersRef.current.size >= 2) {
            backdropPressRef.current = null
            beginPinch()
            return
        }

        dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: offsetRef.current.x,
            originY: offsetRef.current.y
        }
    }, [beginPinch])

    const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
        if (!activePointersRef.current.has(event.pointerId)) return
        activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })

        if (activePointersRef.current.size >= 2 && pinchRef.current) {
            const pointers = Array.from(activePointersRef.current.values())
            const [first, second] = pointers
            const distance = getPointDistance(first, second)
            const center = getPointCenter(first, second)
            const pinch = pinchRef.current
            const nextScale = pinch.startDistance > 0
                ? clampImageScale(pinch.startScale * (distance / pinch.startDistance))
                : pinch.startScale

            updateScale(nextScale)
            updateOffset({
                x: pinch.origin.x + center.x - pinch.startCenter.x,
                y: pinch.origin.y + center.y - pinch.startCenter.y
            })
            return
        }

        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        updateOffset({
            x: drag.originX + event.clientX - drag.startX,
            y: drag.originY + event.clientY - drag.startY
        })
    }, [updateOffset, updateScale])

    const handlePointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
        const backdropPress = backdropPressRef.current
        const moved = backdropPress
            ? Math.hypot(event.clientX - backdropPress.x, event.clientY - backdropPress.y)
            : Number.POSITIVE_INFINITY
        const shouldCloseFromBackdrop = event.type === 'pointerup'
            && backdropPress?.pointerId === event.pointerId
            && event.target === event.currentTarget
            && activePointersRef.current.size === 1
            && moved <= BACKDROP_CLICK_MAX_MOVEMENT

        activePointersRef.current.delete(event.pointerId)
        if (backdropPress?.pointerId === event.pointerId) {
            backdropPressRef.current = null
        }
        if (dragRef.current?.pointerId === event.pointerId) {
            dragRef.current = null
        }
        pinchRef.current = null

        const remainingPointer = activePointersRef.current.entries().next().value as [number, ImagePoint] | undefined
        if (remainingPointer) {
            dragRef.current = {
                pointerId: remainingPointer[0],
                startX: remainingPointer[1].x,
                startY: remainingPointer[1].y,
                originX: offsetRef.current.x,
                originY: offsetRef.current.y
            }
        }
        if (shouldCloseFromBackdrop) {
            closeViewer()
        }
    }, [closeViewer])

    useEffect(() => {
        if (!viewerOpen) return

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                closeViewer()
            }
            if (event.key === '0') {
                resetView()
            }
            if (event.key === '+' || event.key === '=') {
                zoomBy(IMAGE_SCALE_STEP)
            }
            if (event.key === '-') {
                zoomBy(-IMAGE_SCALE_STEP)
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [closeViewer, resetView, viewerOpen, zoomBy])

    return (
        <>
            <button
                type="button"
                onPointerDown={stopEvent}
                onMouseDown={stopEvent}
                onTouchStart={stopEvent}
                onClick={openViewer}
                className={props.buttonClassName ?? 'group flex min-h-[18rem] w-full items-center justify-center overflow-auto rounded-md border border-[var(--app-border)] bg-[var(--app-code-bg)] p-3 text-left'}
                title="Click to zoom"
            >
                <img
                    src={props.src}
                    alt={props.label}
                    className={props.imageClassName ?? 'max-h-[calc(100vh-14rem)] max-w-full object-contain transition-transform group-hover:scale-[1.01]'}
                    draggable={false}
                />
                {props.caption}
                <span className="sr-only">{props.fileName}</span>
            </button>

            {viewerOpen ? (
                <div
                    className="fixed inset-0 z-50 flex flex-col bg-black/90 text-white"
                    role="dialog"
                    aria-modal="true"
                    aria-label={props.label}
                >
                    <div className="flex items-center gap-2 border-b border-white/10 bg-black/50 px-3 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
                        <div className="min-w-0 flex-1 truncate text-sm font-medium">{props.fileName}</div>
                        <button
                            type="button"
                            onClick={() => zoomBy(-IMAGE_SCALE_STEP)}
                            className="rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/20 disabled:opacity-40"
                            disabled={scale <= MIN_IMAGE_SCALE}
                            title="Zoom out"
                        >
                            −
                        </button>
                        <button
                            type="button"
                            onClick={resetView}
                            className="rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/20"
                            title="Reset zoom"
                        >
                            {Math.round(scale * 100)}%
                        </button>
                        <button
                            type="button"
                            onClick={() => zoomBy(IMAGE_SCALE_STEP)}
                            className="rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/20 disabled:opacity-40"
                            disabled={scale >= MAX_IMAGE_SCALE}
                            title="Zoom in"
                        >
                            +
                        </button>
                        <button
                            type="button"
                            onClick={closeViewer}
                            className="flex h-8 w-8 items-center justify-center rounded bg-white/10 hover:bg-white/20"
                            title="Close"
                        >
                            <CloseIcon className="h-4 w-4" />
                        </button>
                    </div>
                    <div
                        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
                        onWheel={handleWheel}
                        onPointerDown={handlePointerDown}
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerUp}
                        onPointerCancel={handlePointerUp}
                        onDoubleClick={resetView}
                    >
                        <img
                            src={props.src}
                            alt={props.label}
                            draggable={false}
                            className="absolute left-1/2 top-1/2 max-h-[90vh] max-w-[90vw] select-none object-contain"
                            style={{
                                transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})`,
                                transformOrigin: 'center center'
                            }}
                        />
                    </div>
                </div>
            ) : null}
        </>
    )
}
