import type React from 'react'
import { useCallback, useRef } from 'react'

type UseLongPressOptions = {
    onLongPress: () => void
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
    onContextMenu: React.MouseEventHandler
    onKeyDown: React.KeyboardEventHandler
}

export function useLongPress(options: UseLongPressOptions): UseLongPressHandlers {
    const { onLongPress, onClick, threshold = 500, disabled = false } = options

    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const isLongPressRef = useRef(false)
    const touchMoved = useRef(false)

    const clearTimer = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current)
            timerRef.current = null
        }
    }, [])

    const startTimer = useCallback(() => {
        if (disabled) return

        clearTimer()
        isLongPressRef.current = false
        touchMoved.current = false

        timerRef.current = setTimeout(() => {
            isLongPressRef.current = true
            onLongPress()
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
        startTimer()
    }, [startTimer])

    const onMouseUp = useCallback<React.MouseEventHandler>(() => {
        handleEnd(!isLongPressRef.current)
    }, [handleEnd])

    const onMouseLeave = useCallback<React.MouseEventHandler>(() => {
        handleEnd(false)
    }, [handleEnd])

    const onTouchStart = useCallback<React.TouchEventHandler>(() => {
        startTimer()
    }, [startTimer])

    const onTouchEnd = useCallback<React.TouchEventHandler>((e) => {
        if (isLongPressRef.current) {
            e.preventDefault()
        }
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
            onLongPress()
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
