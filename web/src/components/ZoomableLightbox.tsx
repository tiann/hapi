import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode, type WheelEvent } from 'react'
import { CloseIcon } from '@/components/icons'

const MIN_SCALE = 0.25
const MAX_SCALE = 8
const SCALE_STEP = 0.25
const BACKDROP_CLICK_MAX_MOVEMENT = 4
/** Edge margin when fitting to the device screen (not the inner panel only). */
const SCREEN_FIT_PADDING_PX = 12

function getScreenFitSize(): { width: number; height: number } {
    const viewport = window.visualViewport
    if (viewport) {
        return { width: viewport.width, height: viewport.height }
    }
    return { width: window.innerWidth, height: window.innerHeight }
}

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

function measureSvgIntrinsicSize(svg: SVGSVGElement): { width: number; height: number } | null {
    const box = svg.getBoundingClientRect()
    if (box.width > 0 && box.height > 0) {
        return { width: box.width, height: box.height }
    }

    const viewBox = svg.viewBox?.baseVal
    if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
        return { width: viewBox.width, height: viewBox.height }
    }

    const widthAttr = Number.parseFloat(svg.getAttribute('width') ?? '')
    const heightAttr = Number.parseFloat(svg.getAttribute('height') ?? '')
    if (widthAttr > 0 && heightAttr > 0) {
        return { width: widthAttr, height: heightAttr }
    }

    return null
}

function measureContentSize(content: HTMLElement): { width: number; height: number } | null {
    const svg = content.querySelector('svg')
    if (svg) {
        const intrinsic = measureSvgIntrinsicSize(svg)
        if (intrinsic) return intrinsic
    }

    const rect = content.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
        return { width: rect.width, height: rect.height }
    }

    return null
}

export type ZoomableLightboxProps = {
    open: boolean
    onClose: () => void
    title?: string
    ariaLabel: string
    children: ReactNode
    /** When set, re-fit viewport when this value changes (e.g. after async SVG load). */
    fitContentKey?: string | number | null
    /** Compute initial scale to fill the device screen (default true). */
    fitOnOpen?: boolean
}

export function ZoomableLightbox(props: ZoomableLightboxProps) {
    const { open, onClose, title, ariaLabel, children, fitContentKey = null, fitOnOpen = true } = props
    const [scale, setScale] = useState(1)
    const [offset, setOffset] = useState({ x: 0, y: 0 })
    const scaleRef = useRef(scale)
    const offsetRef = useRef(offset)
    const baseScaleRef = useRef(1)
    const viewportRef = useRef<HTMLDivElement>(null)
    const contentRef = useRef<HTMLDivElement>(null)
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

    const applyFitScale = useCallback(() => {
        if (!fitOnOpen) {
            baseScaleRef.current = 1
            updateScale(1)
            updateOffset({ x: 0, y: 0 })
            return
        }

        const content = contentRef.current
        if (!content) return

        const contentSize = measureContentSize(content)
        if (!contentSize) return

        const screen = getScreenFitSize()
        const pad = SCREEN_FIT_PADDING_PX * 2
        const fitWidth = (screen.width - pad) / contentSize.width
        const fitHeight = (screen.height - pad) / contentSize.height
        const fitScale = clampScale(Math.min(fitWidth, fitHeight))

        baseScaleRef.current = fitScale
        updateScale(fitScale)
        updateOffset({ x: 0, y: 0 })
    }, [fitOnOpen, updateOffset, updateScale])

    const resetView = useCallback(() => {
        updateScale(baseScaleRef.current)
        updateOffset({ x: 0, y: 0 })
    }, [updateOffset, updateScale])

    const closeViewer = useCallback(() => {
        onClose()
        activePointersRef.current.clear()
        dragRef.current = null
        pinchRef.current = null
        backdropPressRef.current = null
        baseScaleRef.current = 1
        updateScale(1)
        updateOffset({ x: 0, y: 0 })
    }, [onClose, updateOffset, updateScale])

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

    useLayoutEffect(() => {
        if (!open) return

        let frame = 0
        let attempt = 0
        const maxAttempts = 16

        const scheduleFit = () => {
            frame = requestAnimationFrame(() => {
                const content = contentRef.current
                const hadSize = content ? measureContentSize(content) : null
                applyFitScale()
                attempt += 1
                if (!hadSize && attempt < maxAttempts) {
                    scheduleFit()
                }
            })
        }

        scheduleFit()
        const retry = window.setTimeout(scheduleFit, 50)
        const lateRetry = window.setTimeout(scheduleFit, 200)

        return () => {
            cancelAnimationFrame(frame)
            window.clearTimeout(retry)
            window.clearTimeout(lateRetry)
        }
    }, [open, fitContentKey, applyFitScale])

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

    const baseScale = baseScaleRef.current
    const zoomLabel = baseScale > 0
        ? `${Math.round((scale / baseScale) * 100)}%`
        : `${Math.round(scale * 100)}%`

    return (
        <div
            className="fixed inset-0 z-50 h-[100dvh] w-full bg-black text-white"
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
        >
            <div
                ref={viewportRef}
                className="absolute inset-0 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
                onWheel={handleWheel}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onDoubleClick={resetView}
            >
                <div
                    ref={contentRef}
                    className="absolute left-1/2 top-1/2 select-none"
                    style={{
                        transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})`,
                        transformOrigin: 'center center',
                    }}
                >
                    {children}
                </div>
            </div>
            <div
                className="pointer-events-none absolute inset-x-0 top-0 z-10 pt-[env(safe-area-inset-top,0px)]"
                onPointerDown={(event) => event.stopPropagation()}
            >
                <div className="pointer-events-auto flex items-center gap-2 border-b border-white/10 bg-black/70 px-3 py-2 backdrop-blur-sm">
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
                        title="Fit to screen"
                    >
                        {zoomLabel}
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
            </div>
        </div>
    )
}
