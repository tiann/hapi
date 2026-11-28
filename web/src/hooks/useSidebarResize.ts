import { useCallback, useEffect, useRef, useState } from 'react'

export type SidebarResizeOptions = {
    storageKey: string
    minWidth: number
    maxWidth: number
    defaultWidth: number
    /**
     * Which side of the resize handle the panel sits on. `left` (default) is the
     * sessions sidebar: the panel is the handle's previous sibling and dragging
     * right widens it. `right` is a trailing panel: the panel is the handle's
     * next sibling and dragging left widens it.
     */
    side?: 'left' | 'right'
}

const SESSION_SIDEBAR_OPTIONS: SidebarResizeOptions = {
    storageKey: 'hapi-sidebar-width',
    minWidth: 280,
    maxWidth: 600,
    defaultWidth: 420,
}

function clamp(value: number, options: SidebarResizeOptions): number {
    return Math.min(options.maxWidth, Math.max(options.minWidth, value))
}

function loadWidth(options: SidebarResizeOptions): number {
    const stored = localStorage.getItem(options.storageKey)
    if (stored) {
        const parsed = Number(stored)
        if (Number.isFinite(parsed)) return clamp(parsed, options)
    }
    return options.defaultWidth
}

export function useSidebarResize(options: SidebarResizeOptions = SESSION_SIDEBAR_OPTIONS) {
    const optionsRef = useRef(options)
    optionsRef.current = options
    const [width, setWidth] = useState(() => loadWidth(options))
    const [isDragging, setIsDragging] = useState(false)
    const startXRef = useRef(0)
    const startWidthRef = useRef(0)
    const activePointerIdRef = useRef<number | null>(null)

    const onPointerDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault()
        // The sidebar (the handle's previous sibling) can render narrower than the
        // stored width when the viewport cap in index.css kicks in on a compact
        // split. Seed the drag from the actual rendered width so there's no dead
        // zone before the sidebar responds. Falls back to the stored width when the
        // element or its measured width is unavailable (e.g. non-DOM test env).
        const sidebarEl = (optionsRef.current.side === 'right'
            ? e.currentTarget.nextElementSibling
            : e.currentTarget.previousElementSibling) as HTMLElement | null
        const renderedWidth = sidebarEl?.getBoundingClientRect().width
        activePointerIdRef.current = e.pointerId
        startXRef.current = e.clientX
        startWidthRef.current = renderedWidth || width
        setIsDragging(true)
    }, [width])

    // Global listeners ensure pointerup is always captured even if cursor leaves the handle
    useEffect(() => {
        if (!isDragging) return

        const onMove = (e: PointerEvent) => {
            if (e.pointerId !== activePointerIdRef.current) return
            const options = optionsRef.current
            const rawDelta = e.clientX - startXRef.current
            const delta = options.side === 'right' ? -rawDelta : rawDelta
            setWidth(clamp(startWidthRef.current + delta, options))
        }

        const onUp = (e: PointerEvent) => {
            if (e.pointerId !== activePointerIdRef.current) return
            activePointerIdRef.current = null
            setIsDragging(false)
        }

        document.addEventListener('pointermove', onMove)
        document.addEventListener('pointerup', onUp)
        document.addEventListener('pointercancel', onUp)

        return () => {
            document.removeEventListener('pointermove', onMove)
            document.removeEventListener('pointerup', onUp)
            document.removeEventListener('pointercancel', onUp)
        }
    }, [isDragging])

    // Persist width to localStorage when drag ends
    useEffect(() => {
        if (!isDragging) {
            localStorage.setItem(optionsRef.current.storageKey, String(width))
        }
    }, [isDragging, width])

    // Prevent text selection while dragging
    useEffect(() => {
        if (isDragging) {
            document.body.style.userSelect = 'none'
            document.body.style.cursor = 'col-resize'
        } else {
            document.body.style.userSelect = ''
            document.body.style.cursor = ''
        }
        return () => {
            document.body.style.userSelect = ''
            document.body.style.cursor = ''
        }
    }, [isDragging])

    return { width, isDragging, onPointerDown }
}
