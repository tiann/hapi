import type React from 'react'
import { useCallback, useEffect, useRef } from 'react'

type UseLongPressOptions = {
    onLongPress: (point: { x: number; y: number }) => void
    onClick?: () => void
    threshold?: number
    disabled?: boolean
    /**
     * `legacy` preserves the original list-row contract: this hook emits
     * clicks itself from mouse/touch/key handlers. `touch-only-native-click`
     * is for an existing native button: only touch may long-press, while
     * click/keyboard accessibility remain browser-native.
     */
    interaction?: 'legacy' | 'touch-only-native-click'
    /** Disable just the long-press gesture while retaining the normal click. */
    longPressEnabled?: boolean
}

// How long after a touch interaction to keep ignoring synthesized mouse
// events. Android's compatibility mouse events fire ~300ms after touchend;
// 700ms covers that with margin without affecting genuine later mouse input.
const GHOST_MOUSE_WINDOW_MS = 700
// Native buttons retain their platform click behavior. A touch long-press has
// already performed its action, so only the compatibility click emitted just
// after that touch should be discarded. Keep this in the same bounded window
// as touch compatibility mouse events; a missing compatibility click must not
// poison a later mouse, keyboard, or assistive activation.
const NATIVE_CLICK_SUPPRESSION_WINDOW_MS = GHOST_MOUSE_WINDOW_MS

type UseLongPressHandlers = {
    onMouseDown: React.MouseEventHandler
    onMouseUp: React.MouseEventHandler
    onMouseLeave: React.MouseEventHandler
    onTouchStart: React.TouchEventHandler
    onTouchEnd: React.TouchEventHandler
    onTouchMove: React.TouchEventHandler
    onTouchCancel: React.TouchEventHandler
    onContextMenu: React.MouseEventHandler
    onKeyDown: React.KeyboardEventHandler
    onClick?: React.MouseEventHandler
}

export function useLongPress(options: UseLongPressOptions): UseLongPressHandlers {
    const {
        onLongPress,
        onClick,
        threshold = 500,
        disabled = false,
        interaction = 'legacy',
        longPressEnabled = true,
    } = options

    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const isLongPressRef = useRef(false)
    const touchMoved = useRef(false)
    const pressPointRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
    // Used only by the native-button mode. A long touch has already sent its
    // action when the browser produces the following native click, so consume
    // exactly that one click without changing later mouse/keyboard behavior.
    const suppressNextNativeClickRef = useRef(false)
    const nativeClickSuppressionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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

    const clearNativeClickSuppression = useCallback(() => {
        suppressNextNativeClickRef.current = false
        if (nativeClickSuppressionTimerRef.current) {
            clearTimeout(nativeClickSuppressionTimerRef.current)
            nativeClickSuppressionTimerRef.current = null
        }
    }, [])

    const armNativeClickSuppression = useCallback(() => {
        clearNativeClickSuppression()
        suppressNextNativeClickRef.current = true
        nativeClickSuppressionTimerRef.current = setTimeout(() => {
            suppressNextNativeClickRef.current = false
            nativeClickSuppressionTimerRef.current = null
        }, NATIVE_CLICK_SUPPRESSION_WINDOW_MS)
    }, [clearNativeClickSuppression])

    useEffect(() => () => {
        clearTimer()
        clearNativeClickSuppression()
    }, [clearTimer, clearNativeClickSuppression])

    const startTimer = useCallback((clientX: number, clientY: number) => {
        if (disabled || !longPressEnabled) return

        clearTimer()
        isLongPressRef.current = false
        touchMoved.current = false
        pressPointRef.current = { x: clientX, y: clientY }

        timerRef.current = setTimeout(() => {
            isLongPressRef.current = true
            onLongPress(pressPointRef.current)
        }, threshold)
    }, [disabled, longPressEnabled, clearTimer, onLongPress, threshold])

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

    const onTouchCancel = useCallback<React.TouchEventHandler>(() => {
        clearTimer()
        isLongPressRef.current = false
        touchMoved.current = false
        clearNativeClickSuppression()
    }, [clearTimer, clearNativeClickSuppression])

    const onNativeTouchStart = useCallback<React.TouchEventHandler>((e) => {
        const touch = e.touches[0]
        if (!touch) return
        // A new physical touch starts a new native click sequence. If a prior
        // long touch did not yield a browser click at all, do not suppress this
        // later genuine activation.
        clearNativeClickSuppression()
        startTimer(touch.clientX, touch.clientY)
    }, [clearNativeClickSuppression, startTimer])

    const onNativeTouchEnd = useCallback<React.TouchEventHandler>(() => {
        clearTimer()
        if (isLongPressRef.current) {
            armNativeClickSuppression()
        }
        isLongPressRef.current = false
        touchMoved.current = false
    }, [armNativeClickSuppression, clearTimer])

    const onNativeTouchMove = useCallback<React.TouchEventHandler>(() => {
        touchMoved.current = true
        clearTimer()
    }, [clearTimer])

    const onNativeContextMenu = useCallback<React.MouseEventHandler>((e) => {
        // A touch long-press may produce a context menu before or after
        // touchend. Suppress only that generated menu; desktop right-click
        // stays completely native and never becomes a queue gesture.
        if (isLongPressRef.current || suppressNextNativeClickRef.current) {
            e.preventDefault()
        }
    }, [])

    const onNativeClick = useCallback<React.MouseEventHandler>((e) => {
        if (disabled) return
        // Browser-generated keyboard and assistive-technology activation uses
        // detail === 0. It is not the touch compatibility click and must retain
        // native button semantics even while a stale touch window is pending.
        if (suppressNextNativeClickRef.current && e.detail !== 0) {
            clearNativeClickSuppression()
            e.preventDefault()
            e.stopPropagation()
            return
        }
        onClick?.()
    }, [clearNativeClickSuppression, disabled, onClick])

    if (interaction === 'touch-only-native-click') {

        return {
            // Existing button semantics own desktop mouse and keyboard clicks.
            onMouseDown: () => {},
            onMouseUp: () => {},
            onMouseLeave: () => {},
            onTouchStart: onNativeTouchStart,
            onTouchEnd: onNativeTouchEnd,
            onTouchMove: onNativeTouchMove,
            onTouchCancel,
            onContextMenu: onNativeContextMenu,
            onKeyDown: () => {},
            onClick: onNativeClick,
        }
    }

    return {
        onMouseDown,
        onMouseUp,
        onMouseLeave,
        onTouchStart,
        onTouchEnd,
        onTouchMove,
        onTouchCancel,
        onContextMenu,
        onKeyDown
    }
}
