import type React from 'react'
import { useCallback, useEffect, useRef } from 'react'

type UseVerticalDragOptions = {
    onDragStart?: () => void
    onDrag: (deltaY: number) => void
    onDragEnd: (totalDeltaY: number, velocity: number) => void
    disabled?: boolean
    threshold?: number // min drag before activating (default: 10px)
}

type UseVerticalDragHandlers = {
    onMouseDown: React.MouseEventHandler
    onTouchStart: React.TouchEventHandler
    onTouchMove: React.TouchEventHandler
    onTouchEnd: React.TouchEventHandler
}

export function useVerticalDrag(options: UseVerticalDragOptions): UseVerticalDragHandlers {
    const { onDragStart, onDrag, onDragEnd, disabled = false, threshold = 10 } = options

    const isDraggingRef = useRef(false)
    const hasPassedThresholdRef = useRef(false)
    const startYRef = useRef(0)
    const lastYRef = useRef(0)
    const lastTimeRef = useRef(0)
    const velocityRef = useRef(0)

    // Store callbacks in refs to avoid effect dependencies
    const onDragStartRef = useRef(onDragStart)
    const onDragRef = useRef(onDrag)
    const onDragEndRef = useRef(onDragEnd)

    useEffect(() => {
        onDragStartRef.current = onDragStart
        onDragRef.current = onDrag
        onDragEndRef.current = onDragEnd
    }, [onDragStart, onDrag, onDragEnd])

    const updateDrag = useCallback((clientY: number) => {
        if (!isDraggingRef.current) return

        const totalDelta = clientY - startYRef.current
        const instantDelta = clientY - lastYRef.current
        const now = Date.now()
        const timeDelta = now - lastTimeRef.current

        // Calculate velocity (pixels per millisecond)
        if (timeDelta > 0) {
            velocityRef.current = instantDelta / timeDelta
        }

        lastYRef.current = clientY
        lastTimeRef.current = now

        // Check if we've passed the threshold
        if (!hasPassedThresholdRef.current) {
            if (Math.abs(totalDelta) >= threshold) {
                hasPassedThresholdRef.current = true
                onDragStartRef.current?.()
            } else {
                return
            }
        }

        onDragRef.current(totalDelta)
    }, [threshold])

    const endDrag = useCallback(() => {
        if (!isDraggingRef.current) return

        const totalDelta = lastYRef.current - startYRef.current
        const wasActive = hasPassedThresholdRef.current

        isDraggingRef.current = false
        hasPassedThresholdRef.current = false

        if (wasActive) {
            onDragEndRef.current(totalDelta, velocityRef.current)
        }
    }, [])

    // Global mouse event handlers for desktop dragging
    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isDraggingRef.current) return
            updateDrag(e.clientY)
        }

        const handleMouseUp = () => {
            if (!isDraggingRef.current) return
            endDrag()
        }

        window.addEventListener('mousemove', handleMouseMove)
        window.addEventListener('mouseup', handleMouseUp)

        return () => {
            window.removeEventListener('mousemove', handleMouseMove)
            window.removeEventListener('mouseup', handleMouseUp)
        }
    }, [updateDrag, endDrag])

    const onMouseDown = useCallback<React.MouseEventHandler>((e) => {
        if (disabled || e.button !== 0) return
        e.preventDefault()

        isDraggingRef.current = true
        hasPassedThresholdRef.current = false
        startYRef.current = e.clientY
        lastYRef.current = e.clientY
        lastTimeRef.current = Date.now()
        velocityRef.current = 0
    }, [disabled])

    const onTouchStart = useCallback<React.TouchEventHandler>((e) => {
        if (disabled) return
        const touch = e.touches[0]

        isDraggingRef.current = true
        hasPassedThresholdRef.current = false
        startYRef.current = touch.clientY
        lastYRef.current = touch.clientY
        lastTimeRef.current = Date.now()
        velocityRef.current = 0
    }, [disabled])

    const onTouchMove = useCallback<React.TouchEventHandler>((e) => {
        const touch = e.touches[0]
        updateDrag(touch.clientY)
    }, [updateDrag])

    const onTouchEnd = useCallback<React.TouchEventHandler>(() => {
        endDrag()
    }, [endDrag])

    return {
        onMouseDown,
        onTouchStart,
        onTouchMove,
        onTouchEnd
    }
}
