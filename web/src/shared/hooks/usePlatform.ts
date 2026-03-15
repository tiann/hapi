import { useMemo } from 'react'

export type HapticStyle = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'
export type HapticNotification = 'error' | 'success' | 'warning'

export type PlatformHaptic = {
    /** Trigger impact feedback */
    impact: (style: HapticStyle) => void
    /** Trigger notification feedback */
    notification: (type: HapticNotification) => void
    /** Trigger selection changed feedback */
    selection: () => void
}

export type Platform = {
    /** Whether using a touch device (coarse pointer) */
    isTouch: boolean
    /** Haptic feedback (Vibration API on browser) */
    haptic: PlatformHaptic
}

// Vibration patterns for web fallback (in ms)
const vibrationPatterns = {
    light: 10,
    medium: 20,
    heavy: 30,
    rigid: 15,
    soft: 10,
    success: 20,
    warning: [20, 50, 20] as number | number[],
    error: [30, 50, 30] as number | number[],
    selection: 5,
}

function vibrate(pattern: number | number[]) {
    navigator.vibrate?.(pattern)
}

const haptic: PlatformHaptic = {
    impact: (style: HapticStyle) => {
        vibrate(vibrationPatterns[style])
    },
    notification: (type: HapticNotification) => {
        vibrate(vibrationPatterns[type])
    },
    selection: () => {
        vibrate(vibrationPatterns.selection)
    }
}

export function usePlatform(): Platform {
    const isTouch = useMemo(
        () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
        []
    )

    return {
        isTouch,
        haptic
    }
}

// Non-hook version for use outside React components
export function getPlatform(): Platform {
    const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
    return {
        isTouch,
        haptic
    }
}
