import type React from 'react'
import { useCallback, useEffect, useRef } from 'react'

type UseLongPressOptions = {
    onLongPress: (point: { x: number; y: number }) => void
    onClick?: () => void
    threshold?: number
    disabled?: boolean
}

type UseLongPressHandlers = {
    onMouseDown: React.MouseEventHandler
    onMouseUp: React.MouseEventHandler
    onMouseLeave: React.MouseEventHandler
    onTouchStart: React.TouchEventHandler
    onTouchEnd: React.TouchEventHandler
    onTouchMove: React.TouchEventHandler
    onTouchCancel: React.TouchEventHandler
    onClick: React.MouseEventHandler
    onContextMenu: React.MouseEventHandler
    onKeyDown: React.KeyboardEventHandler
}

export function useLongPress(options: UseLongPressOptions): UseLongPressHandlers {
    const { onLongPress, onClick, threshold = 500, disabled = false } = options

    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const isLongPressRef = useRef(false)
    const touchMoved = useRef(false)
    const pressPointRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
    const globalEndListenersRef = useRef<Array<{
        type: 'mouseup' | 'touchend' | 'touchcancel'
        listener: EventListener
    }>>([])

    const clearTimer = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current)
            timerRef.current = null
        }
        for (const { type, listener } of globalEndListenersRef.current) {
            window.removeEventListener(type, listener)
        }
        globalEndListenersRef.current = []
    }, [])

    useEffect(() => clearTimer, [clearTimer])

    const startTimer = useCallback((clientX: number, clientY: number, input: 'mouse' | 'touch') => {
        if (disabled) return

        clearTimer()
        isLongPressRef.current = false
        touchMoved.current = false
        pressPointRef.current = { x: clientX, y: clientY }

        timerRef.current = setTimeout(() => {
            isLongPressRef.current = true
            onLongPress(pressPointRef.current)
        }, threshold)

        const endTypes = input === 'mouse'
            ? ['mouseup'] as const
            : ['touchend', 'touchcancel'] as const
        // The pressed element can move under a stationary pointer (for example
        // when a live session list re-sorts), so it may never receive the end
        // event itself. Always cancel the timer from the window as well.
        for (const type of endTypes) {
            const listener = () => clearTimer()
            globalEndListenersRef.current.push({ type, listener })
            window.addEventListener(type, listener, { once: true })
        }
    }, [disabled, clearTimer, onLongPress, threshold])

    const handleEnd = useCallback(() => {
        clearTimer()
    }, [clearTimer])

    const onMouseDown = useCallback<React.MouseEventHandler>((e) => {
        if (e.button !== 0) return
        startTimer(e.clientX, e.clientY, 'mouse')
    }, [startTimer])

    const onMouseUp = useCallback<React.MouseEventHandler>(() => {
        handleEnd()
    }, [handleEnd])

    const onMouseLeave = useCallback<React.MouseEventHandler>(() => {
        handleEnd()
    }, [handleEnd])

    const onTouchStart = useCallback<React.TouchEventHandler>((e) => {
        const touch = e.touches[0]
        startTimer(touch.clientX, touch.clientY, 'touch')
    }, [startTimer])

    const onTouchEnd = useCallback<React.TouchEventHandler>((e) => {
        if (isLongPressRef.current) {
            e.preventDefault()
        }
        handleEnd()
    }, [handleEnd])

    const onTouchMove = useCallback<React.TouchEventHandler>(() => {
        touchMoved.current = true
        clearTimer()
    }, [clearTimer])

    const onTouchCancel = useCallback<React.TouchEventHandler>(() => {
        touchMoved.current = true
        clearTimer()
    }, [clearTimer])

    const handleClick = useCallback<React.MouseEventHandler>((e) => {
        if (isLongPressRef.current || touchMoved.current) {
            e.preventDefault()
            isLongPressRef.current = false
            touchMoved.current = false
            return
        }
        // Use the browser's click target instead of treating any mouseup as a
        // click. If sibling rows swap between press and release, native click
        // targeting will not activate the row that merely moved underneath.
        onClick?.()
    }, [onClick])

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
        onTouchCancel,
        onClick: handleClick,
        onContextMenu,
        onKeyDown
    }
}
