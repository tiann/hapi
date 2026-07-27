import type React from 'react'
import { useCallback, useRef } from 'react'

type UseLongPressOptions = {
    onLongPress: (point: { x: number; y: number }) => void
    onClick?: () => void
    threshold?: number
    disabled?: boolean
}

// How long after a touch interaction to keep ignoring synthesized mouse
// events. Android's compatibility mouse events fire ~300ms after touchend;
// 700ms covers that with margin without affecting genuine later mouse input.
const GHOST_MOUSE_WINDOW_MS = 700

type UseLongPressHandlers = {
    onMouseDown: React.MouseEventHandler
    onMouseUp: React.MouseEventHandler
    onMouseLeave: React.MouseEventHandler
    onTouchStart: React.TouchEventHandler
    onTouchEnd: React.TouchEventHandler
    onTouchMove: React.TouchEventHandler
    onContextMenu: React.MouseEventHandler
    onKeyDown: React.KeyboardEventHandler
}

export function useLongPress(options: UseLongPressOptions): UseLongPressHandlers {
    const { onLongPress, onClick, threshold = 500, disabled = false } = options

    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const isLongPressRef = useRef(false)
    const touchMoved = useRef(false)
    const pressPointRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
    // Timestamp of the most recent touch interaction. Touch browsers emit
    // compatibility mouse events (mousedown/mouseup/click) after a tap for any
    // touch the page did not preventDefault. Since we bind BOTH touch and
    // mouse handlers, those "ghost" mouse events would fire onClick a second
    // time — on a persistent list (tablet sidebar) the second click lands on
    // whatever row slid under the finger, navigating to the wrong session.
    const lastTouchAtRef = useRef(0)

    const clearTimer = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current)
            timerRef.current = null
        }
    }, [])

    const startTimer = useCallback((clientX: number, clientY: number) => {
        if (disabled) return

        clearTimer()
        isLongPressRef.current = false
        touchMoved.current = false
        pressPointRef.current = { x: clientX, y: clientY }

        timerRef.current = setTimeout(() => {
            isLongPressRef.current = true
            onLongPress(pressPointRef.current)
        }, threshold)
    }, [disabled, clearTimer, onLongPress, threshold])

    const handleEnd = useCallback((shouldTriggerClick: boolean) => {
        clearTimer()

        if (shouldTriggerClick && !isLongPressRef.current && !touchMoved.current && onClick) {
            onClick()
        }

        isLongPressRef.current = false
        touchMoved.current = false
    }, [clearTimer, onClick])

    // True when a mouse event is actually a touch-synthesized compatibility
    // event firing right after a tap; such events must not re-trigger onClick.
    const isGhostMouseEvent = useCallback(
        () => Date.now() - lastTouchAtRef.current < GHOST_MOUSE_WINDOW_MS,
        []
    )

    const onMouseDown = useCallback<React.MouseEventHandler>((e) => {
        if (e.button !== 0) return
        if (isGhostMouseEvent()) return
        startTimer(e.clientX, e.clientY)
    }, [startTimer, isGhostMouseEvent])

    const onMouseUp = useCallback<React.MouseEventHandler>(() => {
        if (isGhostMouseEvent()) return
        handleEnd(!isLongPressRef.current)
    }, [handleEnd, isGhostMouseEvent])

    const onMouseLeave = useCallback<React.MouseEventHandler>(() => {
        if (isGhostMouseEvent()) return
        handleEnd(false)
    }, [handleEnd, isGhostMouseEvent])

    const onTouchStart = useCallback<React.TouchEventHandler>((e) => {
        lastTouchAtRef.current = Date.now()
        const touch = e.touches[0]
        startTimer(touch.clientX, touch.clientY)
    }, [startTimer])

    const onTouchEnd = useCallback<React.TouchEventHandler>((e) => {
        lastTouchAtRef.current = Date.now()
        // Prevent the browser's compatibility mouse/click sequence from firing
        // on the row that ends up under the finger after navigation/reordering.
        e.preventDefault()
        handleEnd(!isLongPressRef.current)
    }, [handleEnd])

    const onTouchMove = useCallback<React.TouchEventHandler>(() => {
        touchMoved.current = true
        clearTimer()
    }, [clearTimer])

    const onContextMenu = useCallback<React.MouseEventHandler>((e) => {
        if (!disabled) {
            e.preventDefault()
            clearTimer()
            isLongPressRef.current = true
            onLongPress({ x: e.clientX, y: e.clientY })
        }
    }, [disabled, clearTimer, onLongPress])

    const onKeyDown = useCallback<React.KeyboardEventHandler>((e) => {
        if (disabled) return
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onClick?.()
        }
    }, [disabled, onClick])

    return {
        onMouseDown,
        onMouseUp,
        onMouseLeave,
        onTouchStart,
        onTouchEnd,
        onTouchMove,
        onContextMenu,
        onKeyDown
    }
}
