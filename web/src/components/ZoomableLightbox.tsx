import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode, type WheelEvent } from 'react'
import { CloseIcon } from '@/components/icons'

const MIN_SCALE = 0.25
const MAX_SCALE = 8
const SCALE_STEP = 0.25
const BACKDROP_CLICK_MAX_MOVEMENT = 4

type Point = { x: number; y: number }

function clampScale(value: number): number {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

function getPointDistance(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y)
}

function getPointCenter(a: Point, b: Point): Point {
    return {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
    }
}

export type ZoomableLightboxProps = {
    open: boolean
    onClose: () => void
    title?: string
    ariaLabel: string
    children: ReactNode
}

export function ZoomableLightbox(props: ZoomableLightboxProps) {
    const { open, onClose, title, ariaLabel, children } = props
    const [scale, setScale] = useState(1)
    const [offset, setOffset] = useState({ x: 0, y: 0 })
    const scaleRef = useRef(scale)
    const offsetRef = useRef(offset)
    const activePointersRef = useRef(new Map<number, Point>())
    const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null)
    const pinchRef = useRef<{ startDistance: number; startScale: number; startCenter: Point; origin: Point } | null>(null)
    const backdropPressRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)

    const updateScale = useCallback((next: number | ((current: number) => number)) => {
        setScale((current) => {
            const value = typeof next === 'function' ? next(current) : next
            scaleRef.current = value
            return value
        })
    }, [])

    const updateOffset = useCallback((next: Point) => {
        offsetRef.current = next
        setOffset(next)
    }, [])

    const resetView = useCallback(() => {
        updateScale(1)
        updateOffset({ x: 0, y: 0 })
    }, [updateOffset, updateScale])

    const closeViewer = useCallback(() => {
        onClose()
        activePointersRef.current.clear()
        dragRef.current = null
        pinchRef.current = null
        backdropPressRef.current = null
        resetView()
    }, [onClose, resetView])

    const zoomBy = useCallback((delta: number) => {
        updateScale((current) => clampScale(current + delta))
    }, [updateScale])

    const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
        event.preventDefault()
        const delta = event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP
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
            origin: offsetRef.current,
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
            originY: offsetRef.current.y,
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
                ? clampScale(pinch.startScale * (distance / pinch.startDistance))
                : pinch.startScale

            updateScale(nextScale)
            updateOffset({
                x: pinch.origin.x + center.x - pinch.startCenter.x,
                y: pinch.origin.y + center.y - pinch.startCenter.y,
            })
            return
        }

        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        updateOffset({
            x: drag.originX + event.clientX - drag.startX,
            y: drag.originY + event.clientY - drag.startY,
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

        const remainingPointer = activePointersRef.current.entries().next().value as [number, Point] | undefined
        if (remainingPointer) {
            dragRef.current = {
                pointerId: remainingPointer[0],
                startX: remainingPointer[1].x,
                startY: remainingPointer[1].y,
                originX: offsetRef.current.x,
                originY: offsetRef.current.y,
            }
        }
        if (shouldCloseFromBackdrop) {
            closeViewer()
        }
    }, [closeViewer])

    useEffect(() => {
        if (!open) return

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                closeViewer()
            }
            if (event.key === '0') {
                resetView()
            }
            if (event.key === '+' || event.key === '=') {
                zoomBy(SCALE_STEP)
            }
            if (event.key === '-') {
                zoomBy(-SCALE_STEP)
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [closeViewer, open, resetView, zoomBy])

    if (!open) return null

    return (
        <div
            className="fixed inset-0 z-50 flex flex-col bg-black/90 text-white"
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
        >
            <div className="flex items-center gap-2 border-b border-white/10 bg-black/50 px-3 py-2">
                <div className="min-w-0 flex-1 truncate text-sm font-medium">{title ?? ariaLabel}</div>
                <button
                    type="button"
                    onClick={() => zoomBy(-SCALE_STEP)}
                    className="rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/20 disabled:opacity-40"
                    disabled={scale <= MIN_SCALE}
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
                    onClick={() => zoomBy(SCALE_STEP)}
                    className="rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/20 disabled:opacity-40"
                    disabled={scale >= MAX_SCALE}
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
                <div
                    className="absolute left-1/2 top-1/2 max-h-[90vh] max-w-[90vw] select-none"
                    style={{
                        transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})`,
                        transformOrigin: 'center center',
                    }}
                >
                    {children}
                </div>
            </div>
        </div>
    )
}
