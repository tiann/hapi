import type React from 'react'
import { useCallback, useEffect, useRef } from 'react'

type UseLongPressOptions = {
    onLongPress: (point: { x: number; y: number }) => void
    onClick?: () => void
    threshold?: number
    disabled?: boolean
    /**
     * 'legacy' preserves the original list-row contract: touch and keyboard
     * activations are emitted by the hook, while mouse activation uses the
     * browser's native click target. 'touch-only-native-click' is for an
     * existing native button: only touch may long-press, while click/keyboard
     * accessibility remain browser-native.
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
// already sent its action when the browser produces the following native click,
// so consume exactly that one click without changing later mouse/keyboard
// behavior.
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
    const globalEndListenersRef = useRef<Array<{
        type: 'mouseup' | 'touchend' | 'touchcancel'
        listener: EventListener
    }>>([])
    // Used only by the native-button mode. A long touch has already sent its
    // action when the browser produces the following native click, so consume
    // exactly that one click without changing later mouse/keyboard behavior.
    const suppressNextNativeClickRef = useRef(false)
    const nativeClickSuppressionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    // Timestamp of the most recent touch interaction. Touch browsers emit
    // compatibility mouse events (mousedown/mouseup/click) after a tap for any
    // touch the page did not preventDefault. Since we bind BOTH touch and
    // mouse handlers, those ghost mouse events would fire onClick a second
    // time — on a persistent list (tablet sidebar) the second click lands on
    // whatever row slid under the finger, navigating to the wrong session.
    const lastTouchAtRef = useRef(0)

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

    const startTimer = useCallback((
        clientX: number,
        clientY: number,
        input: 'mouse' | 'touch',
    ) => {
        if (disabled || !longPressEnabled) return

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
        // The pressed element can move under a stationary pointer (for
        // example when a live session list re-sorts), so it may never receive
        // the end event itself. Always cancel the timer from the window too.
        for (const type of endTypes) {
            const listener = () => clearTimer()
            globalEndListenersRef.current.push({ type, listener })
            window.addEventListener(type, listener, { once: true })
        }
    }, [disabled, longPressEnabled, clearTimer, onLongPress, threshold])

    const handleTouchEnd = useCallback((shouldTriggerClick: boolean) => {
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
        startTimer(e.clientX, e.clientY, 'mouse')
    }, [startTimer, isGhostMouseEvent])

    const onMouseUp = useCallback<React.MouseEventHandler>((e) => {
        if (e.button !== 0) return
        if (isGhostMouseEvent()) return
        // Do not synthesize a click from this row's mouseup. If rows swap
        // between press and release, native click targeting must decide
        // whether the original button was actually activated.
        clearTimer()
    }, [clearTimer, isGhostMouseEvent])

    const onMouseLeave = useCallback<React.MouseEventHandler>(() => {
        if (isGhostMouseEvent()) return
        clearTimer()
    }, [clearTimer, isGhostMouseEvent])

    const onTouchStart = useCallback<React.TouchEventHandler>((e) => {
        lastTouchAtRef.current = Date.now()
        const touch = e.touches[0]
        startTimer(touch.clientX, touch.clientY, 'touch')
    }, [startTimer])

    const onTouchEnd = useCallback<React.TouchEventHandler>((e) => {
        lastTouchAtRef.current = Date.now()
        // Prevent the browser's compatibility mouse/click sequence from
        // firing on the row that ends up under the finger after navigation or
        // reordering. The hook emits the normal touch tap itself.
        e.preventDefault()
        handleTouchEnd(!isLongPressRef.current)
    }, [handleTouchEnd])

    const onTouchMove = useCallback<React.TouchEventHandler>(() => {
        touchMoved.current = true
        clearTimer()
    }, [clearTimer])

    const onTouchCancel = useCallback<React.TouchEventHandler>(() => {
        lastTouchAtRef.current = Date.now()
        clearTimer()
        isLongPressRef.current = false
        touchMoved.current = false
        clearNativeClickSuppression()
    }, [clearTimer, clearNativeClickSuppression])

    const handleClick = useCallback<React.MouseEventHandler>((e) => {
        if (isGhostMouseEvent()) {
            e.preventDefault()
            return
        }
        if (isLongPressRef.current || touchMoved.current) {
            e.preventDefault()
            isLongPressRef.current = false
            touchMoved.current = false
            return
        }
        isLongPressRef.current = false
        touchMoved.current = false
        onClick?.()
    }, [isGhostMouseEvent, onClick])

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

    const onNativeTouchStart = useCallback<React.TouchEventHandler>((e) => {
        const touch = e.touches[0]
        if (!touch) return
        // A new physical touch starts a new native click sequence. If a prior
        // long touch did not yield a browser click at all, do not suppress this
        // later genuine activation.
        clearNativeClickSuppression()
        startTimer(touch.clientX, touch.clientY, 'touch')
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
        onClick: handleClick,
        onContextMenu,
        onKeyDown
    }
}
