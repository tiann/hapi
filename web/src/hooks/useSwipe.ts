import type React from 'react'
import { useCallback, useRef, useState } from 'react'

type UseSwipeOptions = {
    onSwipeLeft?: () => void
    onSwipeRight?: () => void
    threshold?: number
    enabled?: boolean
}

type UseSwipeHandlers = {
    onTouchStart: React.TouchEventHandler
    onTouchMove: React.TouchEventHandler
    onTouchEnd: React.TouchEventHandler
}

type UseSwipeReturn = {
    handlers: UseSwipeHandlers
    offset: number
    isRevealed: boolean
    reset: () => void
}

export function useSwipe(options: UseSwipeOptions = {}): UseSwipeReturn {
    const { onSwipeLeft, onSwipeRight, threshold = 80, enabled = true } = options

    const [offset, setOffset] = useState(0)
    const [isRevealed, setIsRevealed] = useState(false)

    const startXRef = useRef(0)
    const startYRef = useRef(0)
    const currentOffsetRef = useRef(0)
    const isSwipingRef = useRef(false)
    const directionLockedRef = useRef<'horizontal' | 'vertical' | null>(null)

    const reset = useCallback(() => {
        setOffset(0)
        setIsRevealed(false)
        currentOffsetRef.current = 0
    }, [])

    const onTouchStart = useCallback<React.TouchEventHandler>((e) => {
        if (!enabled) return

        const touch = e.touches[0]
        startXRef.current = touch.clientX
        startYRef.current = touch.clientY
        isSwipingRef.current = true
        directionLockedRef.current = null

        // If already revealed, start from that position
        if (isRevealed) {
            currentOffsetRef.current = -threshold
        }
    }, [enabled, isRevealed, threshold])

    const onTouchMove = useCallback<React.TouchEventHandler>((e) => {
        if (!enabled || !isSwipingRef.current) return

        const touch = e.touches[0]
        const deltaX = touch.clientX - startXRef.current
        const deltaY = touch.clientY - startYRef.current

        // Determine direction lock on first significant movement
        if (directionLockedRef.current === null) {
            const absX = Math.abs(deltaX)
            const absY = Math.abs(deltaY)

            if (absX > 10 || absY > 10) {
                // Lock direction based on which axis has more movement
                directionLockedRef.current = absX > absY ? 'horizontal' : 'vertical'
            }
        }

        // Only process horizontal swipes
        if (directionLockedRef.current !== 'horizontal') return

        // Prevent vertical scrolling while swiping horizontally
        e.preventDefault()

        let newOffset: number
        if (isRevealed) {
            // If already revealed, allow swiping back (right) or further left
            newOffset = -threshold + deltaX
        } else {
            newOffset = deltaX
        }

        // Clamp offset: can't swipe right past 0, limit left swipe
        const maxLeftSwipe = -(threshold + 20) // Allow slight overswipe
        newOffset = Math.max(maxLeftSwipe, Math.min(0, newOffset))

        currentOffsetRef.current = newOffset
        setOffset(newOffset)
    }, [enabled, isRevealed, threshold])

    const onTouchEnd = useCallback<React.TouchEventHandler>(() => {
        if (!enabled || !isSwipingRef.current) return

        isSwipingRef.current = false

        const finalOffset = currentOffsetRef.current

        // Determine if we should snap to revealed or closed
        if (finalOffset < -threshold / 2) {
            // Snap to revealed
            setOffset(-threshold)
            setIsRevealed(true)
            currentOffsetRef.current = -threshold
            onSwipeLeft?.()
        } else {
            // Snap back to closed
            setOffset(0)
            setIsRevealed(false)
            currentOffsetRef.current = 0
            onSwipeRight?.()
        }

        directionLockedRef.current = null
    }, [enabled, threshold, onSwipeLeft, onSwipeRight])

    return {
        handlers: {
            onTouchStart,
            onTouchMove,
            onTouchEnd
        },
        offset,
        isRevealed,
        reset
    }
}
