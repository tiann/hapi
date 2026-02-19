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
    onTouchCancel: React.TouchEventHandler
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

    const clearTimer = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current)
            timerRef.current = null
        }
    }, [])

    useEffect(() => {
        return () => {
            clearTimer()
        }
    }, [clearTimer])

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

    const onMouseDown = useCallback<React.MouseEventHandler>((e) => {
        if (e.button !== 0) return
        startTimer(e.clientX, e.clientY)
    }, [startTimer])

    const onMouseUp = useCallback<React.MouseEventHandler>(() => {
        handleEnd(!isLongPressRef.current)
    }, [handleEnd])

    const onMouseLeave = useCallback<React.MouseEventHandler>(() => {
        handleEnd(false)
    }, [handleEnd])

    const onTouchStart = useCallback<React.TouchEventHandler>((e) => {
        const touch = e.touches[0]
        startTimer(touch.clientX, touch.clientY)
    }, [startTimer])

    const onTouchEnd = useCallback<React.TouchEventHandler>((e) => {
        e.preventDefault()
        handleEnd(!isLongPressRef.current)
    }, [handleEnd])

    const onTouchCancel = useCallback<React.TouchEventHandler>(() => {
        handleEnd(false)
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
        onTouchCancel,
        onTouchMove,
        onContextMenu,
        onKeyDown
    }
}
