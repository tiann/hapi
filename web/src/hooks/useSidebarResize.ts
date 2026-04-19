import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'hapi-sidebar-width'
const MIN_WIDTH = 280
const MAX_WIDTH = 600
const DEFAULT_WIDTH = 420

function clamp(value: number): number {
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value))
}

function loadWidth(): number {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
        const parsed = Number(stored)
        if (Number.isFinite(parsed)) return clamp(parsed)
    }
    return DEFAULT_WIDTH
}

export function useSidebarResize() {
    const [width, setWidth] = useState(loadWidth)
    const [isDragging, setIsDragging] = useState(false)
    const startXRef = useRef(0)
    const startWidthRef = useRef(0)
    const activePointerIdRef = useRef<number | null>(null)

    const onPointerDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault()
        activePointerIdRef.current = e.pointerId
        startXRef.current = e.clientX
        startWidthRef.current = width
        setIsDragging(true)
    }, [width])

    // Global listeners ensure pointerup is always captured even if cursor leaves the handle
    useEffect(() => {
        if (!isDragging) return

        const onMove = (e: PointerEvent) => {
            if (e.pointerId !== activePointerIdRef.current) return
            const delta = e.clientX - startXRef.current
            setWidth(clamp(startWidthRef.current + delta))
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
            localStorage.setItem(STORAGE_KEY, String(width))
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
