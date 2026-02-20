import { useCallback, useEffect, useRef, useState } from 'react'

const SIDEBAR_KEY = 'hapi:sidebar-width'
export const SIDEBAR_MIN = 320
export const SIDEBAR_MAX = 720
export const SIDEBAR_DEFAULT = 420

export function useSidebarResize() {
    const [width, setWidth] = useState(() => {
        const stored = localStorage.getItem(SIDEBAR_KEY)
        const parsed = stored ? Number(stored) : NaN
        return Number.isFinite(parsed) ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, parsed)) : SIDEBAR_DEFAULT
    })
    const isResizing = useRef(false)

    useEffect(() => {
        localStorage.setItem(SIDEBAR_KEY, String(width))
    }, [width])

    const handleResizeStart = useCallback((e: React.PointerEvent) => {
        e.preventDefault()
        isResizing.current = true
        const startX = e.clientX
        const startWidth = width

        const onMove = (ev: PointerEvent) => {
            const delta = ev.clientX - startX
            const next = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startWidth + delta))
            setWidth(next)
        }
        const onUp = () => {
            isResizing.current = false
            document.removeEventListener('pointermove', onMove)
            document.removeEventListener('pointerup', onUp)
            document.body.style.cursor = ''
            document.body.style.userSelect = ''
        }
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        document.addEventListener('pointermove', onMove)
        document.addEventListener('pointerup', onUp)
    }, [width])

    return { width, handleResizeStart, isResizing }
}
